/**
 * Safety guards. Build this before adapters, use it from every adapter.
 *
 * - Read-only by default. v0 tools only observe.
 * - Hard caps: wall clock ≤ 60 s per tool (tcpdump ≤ 30 s), raw output ≤ 50 MB
 *   on disk then the child is killed, payload returned to the agent ≤ 16 KB.
 * - Never auto-sudo. Report the exact command the user could run instead.
 * - Scoping: adapters only touch the attached pid tree / container.
 * - Secrets: redact obvious tokens in excerpts; raw artifacts stay untouched.
 */
import { execa, type Options as ExecaOptions, type ResultPromise } from "execa";
import { createWriteStream, type WriteStream } from "node:fs";
import { stat } from "node:fs/promises";

export const LIMITS = {
  MAX_TOOL_WALL_MS: 60_000,
  MAX_CAPTURE_WALL_MS: 30_000,
  MAX_RAW_BYTES: 50 * 1024 * 1024,
  MAX_PAYLOAD_BYTES: 16 * 1024,
  MAX_EXCERPT_LINES: 40,
  /** Grace between SIGTERM and SIGKILL. */
  KILL_GRACE_MS: 2_000,
  /** Extra slack on top of the requested duration before we SIGTERM the child. */
  DURATION_SLACK_MS: 5_000,
} as const;

/** Tools that MUST have consent: true to run. The SKILL tells agents to ask the user. */
export const CONSENT_REQUIRED: ReadonlySet<string> = new Set(["capture_traffic"]);

/** Tools that are side-effect-free observation. Everything in v0. */
export const READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  "readiness",
  "attach",
  "detach",
  "list_processes",
  "trace_syscalls",
  "profile_cpu",
  "dump_stacks",
  "inspect_sockets",
  "inspect_files",
  "capture_traffic",
  "snapshot_memory",
  "diff_runs",
  "container_info",
  "report",
]);

export class ConsentRequiredError extends Error {
  constructor(tool: string) {
    super(`${tool} requires consent: true. Ask the user before passing it — the output may contain secrets or affect the target.`);
    this.name = "ConsentRequiredError";
  }
}

export function requireConsent(tool: string, args: { consent?: boolean }): void {
  if (CONSENT_REQUIRED.has(tool) && args.consent !== true) throw new ConsentRequiredError(tool);
}

/** Clamp a requested duration to the per-tool cap. Returns seconds. */
export function clampDuration(seconds: number | undefined, fallback: number, maxMs: number = LIMITS.MAX_TOOL_WALL_MS): number {
  const max = Math.floor(maxMs / 1000);
  const v = seconds ?? fallback;
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(Math.floor(v), max);
}

/** Validate a pid argument strictly so it can never become shell text. */
export function assertPid(pid: unknown): number {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0 || pid > 4_194_304) {
    throw new Error(`invalid pid: ${String(pid)}`);
  }
  return pid;
}

/** Container names / ids / pod names: conservative charset. */
export function assertSafeIdentifier(s: string, what = "identifier"): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,253}$/.test(s)) throw new Error(`unsafe ${what}: ${JSON.stringify(s)}`);
  return s;
}

/** BPF filter fragments the user may add. Refuse shell-ish or capture-widening content. */
export function assertSafeBpfFragment(s: string): string {
  if (s.length > 200) throw new Error("filter too long");
  if (!/^[A-Za-z0-9 .:_\-()&|!=<>\[\]]+$/.test(s)) throw new Error(`unsafe filter: ${JSON.stringify(s)}`);
  return s;
}

// ---------------------------------------------------------------------------
// Running subprocesses with caps
// ---------------------------------------------------------------------------

export interface CappedRunOptions {
  /** Kill after this many ms (SIGTERM, then SIGKILL after KILL_GRACE_MS). */
  timeoutMs: number;
  /** If set, stream stdout to this file and cap it at MAX_RAW_BYTES. */
  stdoutFile?: string;
  /** If set, stream stderr to this file too (same cap pool). */
  stderrFile?: string;
  /** Capture stdout/stderr into memory (capped at MAX_RAW_BYTES). Default true unless *File is set. */
  captureInMemory?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Children are tracked for cleanup on exit/detach. */
  track?: (child: ResultPromise) => void;
  input?: string;
}

export interface CappedRunResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  /** True if we killed it because of the time cap. */
  timedOut: boolean;
  /** True if we killed it because the output cap was hit. */
  outputCapped: boolean;
  bytesWritten: number;
  durationMs: number;
  command: string;
}

const children = new Set<ResultPromise>();
let exitHooked = false;

function hookExit(): void {
  if (exitHooked) return;
  exitHooked = true;
  const killAll = () => {
    for (const c of children) {
      try {
        c.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
  };
  process.once("exit", killAll);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.once(sig, () => {
      killAll();
      process.exit(130);
    });
  }
}

/** Kill every tracked child (used by detach and on server shutdown). */
export function killTrackedChildren(): number {
  let n = 0;
  for (const c of children) {
    try {
      c.kill("SIGTERM");
      n++;
    } catch {
      /* ignore */
    }
  }
  children.clear();
  return n;
}

/**
 * Run a command with time and output caps. Never goes through a shell —
 * `file` and `args` are passed verbatim to execa.
 */
export async function runCapped(file: string, args: readonly string[], opts: CappedRunOptions): Promise<CappedRunResult> {
  hookExit();
  const started = Date.now();
  const timeoutMs = Math.min(opts.timeoutMs, LIMITS.MAX_TOOL_WALL_MS + LIMITS.DURATION_SLACK_MS);
  const useFiles = Boolean(opts.stdoutFile || opts.stderrFile);
  const captureInMemory = opts.captureInMemory ?? !useFiles;

  const execaOpts: ExecaOptions = {
    reject: false,
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    forceKillAfterDelay: LIMITS.KILL_GRACE_MS,
    cwd: opts.cwd,
    env: opts.env,
    input: opts.input,
    stdin: opts.input === undefined ? "ignore" : "pipe",
    buffer: false,
    stdout: "pipe",
    stderr: "pipe",
    all: false,
    stripFinalNewline: false,
  };

  const child = execa(file, args as string[], execaOpts);
  children.add(child);
  opts.track?.(child);

  let bytes = 0;
  let outputCapped = false;
  const outChunks: Buffer[] = [];
  const errChunks: Buffer[] = [];
  const streams: WriteStream[] = [];
  const outFile = opts.stdoutFile ? createWriteStream(opts.stdoutFile) : null;
  const errFile = opts.stderrFile ? createWriteStream(opts.stderrFile) : null;
  if (outFile) streams.push(outFile);
  if (errFile) streams.push(errFile);

  const onChunk = (chunk: Buffer, memory: Buffer[], file: WriteStream | null) => {
    bytes += chunk.length;
    if (bytes > LIMITS.MAX_RAW_BYTES) {
      if (!outputCapped) {
        outputCapped = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (file) file.write(chunk);
    if (captureInMemory) memory.push(chunk);
  };

  child.stdout?.on("data", (c: Buffer) => onChunk(c, outChunks, outFile));
  child.stderr?.on("data", (c: Buffer) => onChunk(c, errChunks, errFile));

  const result = await child;
  children.delete(child);
  await Promise.all(
    streams.map(
      (s) =>
        new Promise<void>((res) => {
          s.end(() => res());
        }),
    ),
  );

  return {
    exitCode: typeof result.exitCode === "number" ? result.exitCode : null,
    signal: result.signal ?? null,
    stdout: Buffer.concat(outChunks).toString("utf8"),
    stderr: Buffer.concat(errChunks).toString("utf8"),
    timedOut: Boolean(result.timedOut),
    outputCapped,
    bytesWritten: bytes,
    durationMs: Date.now() - started,
    command: [file, ...args].join(" "),
  };
}

export async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Privilege helpers
// ---------------------------------------------------------------------------

export function isRoot(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
}

/** Message for a tool that needs root we do not have. Never runs sudo itself. */
export function rootRequiredLimitation(tool: string, command: string): string {
  return `${tool} needs elevated privileges and DEA never escalates on its own. Run it yourself and point DEA at the output, or re-run with: sudo ${command}`;
}

/** Detect "permission denied"-class failures from tool stderr. */
export function looksLikePermissionError(stderr: string): boolean {
  return /operation not permitted|permission denied|ptrace.*(denied|not permitted)|EPERM|must be (run as )?root|you don't have permission|not permitted to attach|lacks permission|requires? (super ?user|root)/i.test(
    stderr,
  );
}

// ---------------------------------------------------------------------------
// Redaction — applied to everything returned to the agent, never to raw artifacts
// ---------------------------------------------------------------------------

const REDACTIONS: Array<[RegExp, string]> = [
  [/(authorization\s*[:=]\s*)?bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]"],
  [/AKIA[0-9A-Z]{16}/g, "AKIA[REDACTED]"],
  [/(aws_secret_access_key|aws_session_token)\s*[=:]\s*\S+/gi, "$1=[REDACTED]"],
  [/(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key)(\s*[=:]\s*)(["']?)[^\s"'&;,]{4,}\3/gi, "$1$2$3[REDACTED]$3"],
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, "[REDACTED_JWT]"],
  [/(sk|pk|rk)_(live|test)_[A-Za-z0-9]{10,}/g, "$1_$2_[REDACTED]"],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, "gh*_[REDACTED]"],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, "xox*-[REDACTED]"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]"],
  [/(https?:\/\/)([^\s:@/]+):([^\s@/]+)@/gi, "$1$2:[REDACTED]@"],
];

export function redact(text: string): string {
  let out = text;
  for (const [re, rep] of REDACTIONS) out = out.replace(re, rep);
  return out;
}

/** Deep-redact strings inside an arbitrary JSON-like value. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") return redact(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactDeep(v);
    return out as T;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Payload cap
// ---------------------------------------------------------------------------

/**
 * Enforce the 16 KB payload cap on a ToolResult-like object by progressively
 * trimming evidence data (largest first: halve arrays, then collapse objects
 * and strings to pointers), then dropping uncited evidence. Evidence cited by
 * a finding is never dropped. Adds a limitation noting the trim. Pure.
 */
export function capPayload<T extends { evidence: Array<{ id?: string; data: unknown; summary: string }>; findings?: Array<{ evidence_ids: string[] }>; limitations: string[] }>(result: T, max = LIMITS.MAX_PAYLOAD_BYTES): T {
  const size = (o: unknown) => Buffer.byteLength(JSON.stringify(o), "utf8");
  if (size(result) <= max) return result;

  const r = structuredClone(result);
  let trimmed = false;
  const cited = new Set((r.findings ?? []).flatMap((f) => f.evidence_ids));
  for (let pass = 0; pass < 40 && size(r) > max; pass++) {
    const byLen = r.evidence.map((e, i) => ({ i, n: size(e.data) })).sort((a, b) => b.n - a.n);
    const top = byLen[0];
    if (!top || top.n < 64) break;
    const e = r.evidence[top.i]!;
    if (Array.isArray(e.data) && e.data.length > 5) e.data = e.data.slice(0, Math.max(5, Math.floor(e.data.length / 2)));
    else if (Array.isArray(e.data)) e.data = { _trimmed: true, kept: e.data.length, note: "see artifact" };
    else if (typeof e.data === "string") e.data = e.data.slice(0, Math.max(64, Math.floor(e.data.length / 2))) + "…";
    else if (e.data && typeof e.data === "object") e.data = { _trimmed: true, keys: Object.keys(e.data as object).slice(0, 20) };
    else break;
    trimmed = true;
  }
  if (size(r) > max) {
    const keep = r.evidence.filter((e, i) => i < 10 || (e.id && cited.has(e.id)));
    if (keep.length < r.evidence.length) {
      r.evidence = keep;
      trimmed = true;
    }
  }
  if (trimmed) r.limitations.push(`payload trimmed to fit the ${Math.floor(max / 1024)} KB cap; full data is in the artifacts`);
  return r;
}
