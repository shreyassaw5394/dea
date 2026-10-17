/**
 * py-spy adapter: profile_cpu (record → folded stacks → flamegraph), dump_stacks
 * (thread stacks + lock-wait detection), snapshot_memory contribution (dump --locals).
 */
import type { Adapter, AdapterContext } from "./types.js";
import type { ToolResult } from "../contracts.js";
import { ResultBuilder } from "../evidence.js";
import { runCapped, clampDuration, looksLikePermissionError, rootRequiredLimitation, LIMITS } from "../safety.js";
import { aggregateFrames, hottestStacks, parseFolded, renderFlamegraph, IDLE_FRAME } from "../stacks.js";
import { platform } from "../session.js";

// ---------------------------------------------------------------------------
// Parsing `py-spy dump`
// ---------------------------------------------------------------------------

export interface PyThread {
  id: string;
  state: string; // active | idle
  name: string;
  frames: Array<{ func: string; file: string; line: number; locals?: Record<string, string> }>;
  os_tid?: string;
}

export interface PyDump {
  pid?: number;
  command?: string;
  python?: string;
  threads: PyThread[];
}

/** Parse `py-spy dump [--locals]` text. Pure. */
export function parsePySpyDump(raw: string): PyDump {
  const out: PyDump = { threads: [] };
  let cur: PyThread | null = null;
  let localsTarget: Record<string, string> | null = null;
  for (const line of raw.split("\n")) {
    let m = /^Process (\d+): (.*)$/.exec(line);
    if (m) {
      out.pid = Number(m[1]);
      out.command = m[2]!.trim();
      continue;
    }
    m = /^Python v([\d.]+)/.exec(line);
    if (m) {
      out.python = m[1];
      continue;
    }
    m = /^Thread (0x[0-9A-Fa-f]+|\d+) \((\w+)\)(?:: "(.*)")?(?:.*?\(os thread (\S+)\))?/.exec(line);
    if (m) {
      cur = { id: m[1]!, state: m[2]!, name: m[3] ?? "", frames: [], os_tid: m[4] };
      out.threads.push(cur);
      localsTarget = null;
      continue;
    }
    if (!cur) continue;
    m = /^\s{4}(\S.*?) \((.+?):(\d+)\)\s*$/.exec(line);
    if (m) {
      cur.frames.push({ func: m[1]!, file: m[2]!, line: Number(m[3]) });
      localsTarget = null;
      continue;
    }
    if (/^\s{8}(Arguments|Locals):/.test(line)) {
      const f = cur.frames[cur.frames.length - 1];
      if (f) {
        f.locals ??= {};
        localsTarget = f.locals;
      }
      continue;
    }
    m = /^\s{12}(\w+): (.*)$/.exec(line);
    if (m && localsTarget) localsTarget[m[1]!] = m[2]!.slice(0, 200);
  }
  return out;
}

const LOCK_FRAME = /\b(acquire|_acquire_restore|wait|_wait_for_tstate_lock|__enter__|lock|Lock|RLock|Condition|Semaphore|Event\.wait|join|get|put|recv|recv_into|readinto|_read_ready|select|poll|epoll)\b/;
const LOCK_FILE = /threading\.py|queue\.py|socket\.py|selectors\.py|ssl\.py/;

export interface LockWait {
  thread: string;
  state: string;
  waiting_in: string;
  at: string;
  lock_repr?: string;
}

/** Threads that are blocked in a lock/wait primitive. Pure. */
export function findLockWaits(dump: PyDump): LockWait[] {
  const out: LockWait[] = [];
  for (const t of dump.threads) {
    const top = t.frames[0];
    if (!top) continue;
    if (LOCK_FRAME.test(top.func) && (LOCK_FILE.test(top.file) || /lock|wait|acquire/i.test(top.func))) {
      // The first user frame below the stdlib tells where in the app it waits.
      const user = t.frames.find((f) => !LOCK_FILE.test(f.file) && !/<frozen|importlib/.test(f.file));
      const lockRepr = Object.entries(top.locals ?? {}).find(([k]) => /self|lock|cond|mutex/i.test(k))?.[1];
      out.push({ thread: t.name || t.id, state: t.state, waiting_in: `${top.func} (${top.file.split("/").pop()}:${top.line})`, at: user ? `${user.func} (${user.file.split("/").pop()}:${user.line})` : "?", lock_repr: lockRepr });
    }
  }
  return out;
}

/** Group lock waits by lock repr (when --locals gave us one) to spot threads blocked on the same lock. Pure. */
export function sameLockGroups(waits: LockWait[]): Array<{ lock: string; threads: string[] }> {
  const by = new Map<string, string[]>();
  for (const w of waits) {
    if (!w.lock_repr) continue;
    const k = w.lock_repr.replace(/\s+/g, " ");
    by.set(k, [...(by.get(k) ?? []), w.thread]);
  }
  return [...by].filter(([, t]) => t.length > 1).map(([lock, threads]) => ({ lock, threads }));
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

function needsSudoNote(b: ResultBuilder, stderr: string, cmd: string): boolean {
  if (looksLikePermissionError(stderr) || /Operation not permitted|ptrace|task_for_pid|Permission denied/i.test(stderr)) {
    b.limitation(rootRequiredLimitation("py-spy", cmd));
    if (platform() === "darwin") b.limitation("macOS: py-spy needs sudo (or the target must be a child of this process). SIP blocks task_for_pid otherwise.");
    if (platform() === "linux") b.limitation("Linux: set kernel.yama.ptrace_scope=0 or run with CAP_SYS_PTRACE; inside Docker add --cap-add SYS_PTRACE");
    return true;
  }
  return false;
}

async function dumpStacks(ctx: AdapterContext, withLocals: boolean, tool = "dump_stacks"): Promise<ToolResult> {
  const { session, target } = ctx;
  const b = new ResultBuilder(tool, session, target);
  if (!target.pid) return b.fail("no pid").build();
  const args = ["dump", "--pid", String(target.pid), "--nonblocking"];
  if (withLocals) args.push("--locals");
  const cmd = `py-spy ${args.join(" ")}`;
  const r = await runCapped("py-spy", args, { timeoutMs: 30_000 });
  const raw = r.stdout + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : "");
  const art = await b.writeArtifact("pyspy-dump.txt", raw, "raw_text", cmd);
  if (r.exitCode !== 0) {
    if (!needsSudoNote(b, r.stderr, cmd)) b.limitation(`py-spy exited ${r.exitCode}: ${r.stderr.trim().slice(0, 300)}`);
    return b.fail("py-spy dump failed").build();
  }
  const dump = parsePySpyDump(r.stdout);
  const active = dump.threads.filter((t) => t.state === "active");
  const summaryEv = b.evidenceOf(
    "stack_summary",
    `${dump.threads.length} thread(s): ${active.length} active, ${dump.threads.length - active.length} idle; python ${dump.python ?? "?"}`,
    dump.threads.map((t) => ({ thread: t.name || t.id, state: t.state, top: t.frames[0] ? `${t.frames[0].func} (${t.frames[0].file.split("/").pop()}:${t.frames[0].line})` : "?" , depth: t.frames.length })),
    { artifact: art },
  );
  for (const t of dump.threads.slice(0, 12)) {
    b.evidenceOf(
      "stack",
      `${t.name || t.id} [${t.state}]: ${t.frames
        .slice(0, 4)
        .map((f) => `${f.func}@${f.file.split("/").pop()}:${f.line}`)
        .join(" ← ")}`,
      { thread: t.name || t.id, state: t.state, frames: t.frames.slice(0, 15).map((f) => ({ func: f.func, file: f.file, line: f.line, ...(f.locals ? { locals: f.locals } : {}) })) },
      { artifact: art },
    );
  }
  const waits = findLockWaits(dump);
  if (waits.length) {
    const waitEv = b.evidenceOf("lock_wait", `${waits.length} thread(s) blocked in lock/wait primitives: ${waits.map((w) => `${w.thread}@${w.at}`).join(", ")}`, waits, { artifact: art });
    const groups = sameLockGroups(waits);
    const lockWaits = waits.filter((w) => /acquire|lock|_wait_for_tstate_lock|__enter__/i.test(w.waiting_in));
    const nonIdle = dump.threads.filter((t) => !/MainThread/.test(t.name) || true);
    if (groups.length) {
      b.finding("high", `${groups[0]!.threads.length} threads wait on the same lock ${groups[0]!.lock}: ${groups[0]!.threads.join(", ")}`, [waitEv], "observed");
    }
    if (lockWaits.length >= 2 && lockWaits.length >= Math.max(2, Math.floor(nonIdle.length * 0.5))) {
      b.finding(
        "high",
        `likely deadlock: ${lockWaits.length} threads are all blocked acquiring locks (${lockWaits.map((w) => `${w.thread} at ${w.at}`).join("; ")}) and no thread is running application code`,
        [waitEv, summaryEv],
        "inferred",
        "Re-run dump_stacks in a few seconds: if the same threads sit at the same lines, it is a deadlock. Attach a step debugger (e.g. mcp-debugger) at the acquire sites to see lock owners.",
      );
    } else if (lockWaits.length) {
      b.finding("warn", `${lockWaits.length} thread(s) blocked acquiring a lock: ${lockWaits.map((w) => `${w.thread} at ${w.at}`).join("; ")}`, [waitEv], "observed");
    }
    const io = waits.filter((w) => /recv|read|select|poll|epoll/.test(w.waiting_in));
    if (io.length) b.finding("info", `${io.length} thread(s) waiting on I/O: ${io.map((w) => `${w.thread} in ${w.waiting_in}`).join("; ")}`, [waitEv]);
  }
  if (!waits.length && active.length === 0) b.finding("info", "all threads idle — the process is not stuck in Python code; if the caller hangs, look at the network path (inspect_sockets)", [summaryEv], "inferred");
  if (active.length) {
    const t = active[0]!;
    const f = t.frames[0];
    if (f && !waits.some((w) => w.thread === (t.name || t.id))) b.finding("info", `active thread ${t.name || t.id} is executing ${f.func} (${f.file.split("/").pop()}:${f.line})`, [summaryEv]);
  }
  b.limitation("instant snapshot (nonblocking); take two dumps to distinguish a hang from a slow step");
  b.next("inspect_sockets", "trace_syscalls", "profile_cpu");
  return b.build();
}

async function profileCpu(ctx: AdapterContext, args: { duration_s?: number }): Promise<ToolResult> {
  const { session, target } = ctx;
  const b = new ResultBuilder("profile_cpu", session, target);
  if (!target.pid) return b.fail("no pid").build();
  const duration = clampDuration(args.duration_s, 15);
  const rawPath = b.artifactPath("pyspy-folded.txt");
  const cmdArgs = ["record", "--pid", String(target.pid), "--duration", String(duration), "--format", "raw", "--output", rawPath, "--nonblocking", "--subprocesses"];
  const r = await runCapped("py-spy", cmdArgs, { timeoutMs: duration * 1000 + LIMITS.DURATION_SLACK_MS + 5000 });
  if (r.exitCode !== 0) {
    await b.writeArtifact("pyspy-stderr.txt", r.stderr, "raw_text");
    if (!needsSudoNote(b, r.stderr, `py-spy ${cmdArgs.join(" ")}`)) b.limitation(`py-spy exited ${r.exitCode}: ${r.stderr.trim().slice(0, 300)}`);
    return b.fail("py-spy record failed").build();
  }
  const { readFile } = await import("node:fs/promises");
  const folded = await readFile(rawPath, "utf8").catch(() => "");
  await b.addArtifact(rawPath, "folded_stacks", { description: `py-spy record ${duration}s, folded stacks` });
  return summarizeProfile(b, folded, duration, "py-spy");
}

/** Shared by py-spy/perf/sample: folded stacks → evidence + findings + svg. */
export async function summarizeProfile(b: ResultBuilder, folded: string, duration: number, profiler: string): Promise<ToolResult> {
  const stacks = parseFolded(folded);
  if (!stacks.length) {
    b.limitation(`${profiler} produced no samples in ${duration}s (process idle, or sampling blocked)`);
    const ev = b.evidenceOf("metric", "0 samples", { name: "samples", value: 0 });
    b.finding("info", `no CPU samples in ${duration}s — the process is idle or sleeping, not CPU-bound`, [ev], "inferred");
    b.next("dump_stacks", "trace_syscalls", "inspect_sockets");
    return b.build();
  }
  const { frames, totalSamples } = aggregateFrames(stacks, 15);
  const hot = hottestStacks(stacks, 5);
  const svg = renderFlamegraph(stacks, { title: `${profiler} ${duration}s pid ${b.target.pid}` });
  const svgPath = await b.writeArtifact("flamegraph.svg", svg, "flamegraph_svg", "flame graph");
  const foldedArtifact = b.artifactPath("");
  const framesEv = b.evidenceOf(
    "frame_hot",
    `top self: ${frames
      .slice(0, 5)
      .map((f) => `${shortFrame(f.frame)} ${f.self_pct}%`)
      .join(", ")} (${totalSamples} samples over ${duration}s)`,
    frames.map((f) => ({ frame: f.frame, self: f.self, total: f.total, self_pct: f.self_pct, total_pct: f.total_pct })),
    { artifact: svgPath },
  );
  const stacksEv = b.evidenceOf("stack", `hottest stack (${hot[0]?.pct}%): ${hot[0]?.stack.slice(-4).map(shortFrame).join(" ← ")}`, hot, { artifact: svgPath });
  const idle = frames.filter((f) => IDLE_FRAME.test(f.frame)).reduce((s, f) => s + f.self, 0);
  const idlePct = Math.round((100 * idle) / totalSamples);
  const metricEv = b.evidenceOf("metric", `${totalSamples} samples, ~${idlePct}% in idle/wait frames`, { name: "samples", value: totalSamples, idle_pct: idlePct, duration_s: duration });

  const topWork = frames.find((f) => !IDLE_FRAME.test(f.frame));
  if (idlePct >= 70) {
    b.finding("info", `~${idlePct}% of samples are in idle/wait frames — the process is mostly waiting, not CPU-bound`, [metricEv, framesEv], "inferred", "Look at trace_syscalls (what is it waiting on?) and inspect_sockets (whom?).");
  }
  if (topWork && topWork.self_pct >= 20) {
    b.finding("high", `${shortFrame(topWork.frame)} accounts for ${topWork.self_pct}% of self time (${topWork.total_pct}% inclusive)`, [framesEv, stacksEv], "observed", `Hot path: ${hot[0]?.stack.slice(-6).map(shortFrame).join(" ← ")}. Handoff: attach a step debugger (e.g. mcp-debugger) at ${topWork.frame}.`);
  } else if (topWork && topWork.self_pct >= 8) {
    b.finding("warn", `${shortFrame(topWork.frame)} is the top CPU frame at ${topWork.self_pct}% self`, [framesEv, stacksEv], "observed");
  }
  if (b.findingCount === 0) b.finding("info", `CPU spread thin: top frame ${shortFrame(frames[0]!.frame)} at ${frames[0]!.self_pct}% self`, [framesEv]);
  void foldedArtifact;
  b.limitation(`sampled ${duration}s only; ${profiler} sampling`);
  b.next("trace_syscalls", "dump_stacks", "inspect_sockets");
  return b.build();
}

function shortFrame(f: string): string {
  // "func (path/to/file.py:12)" → "func (file.py:12)"; "lib.so`sym" → keep; perf "sym+0x1 (dso)" → "sym (dso)"
  return f.replace(/\(([^)]*\/)?([^/)]+)\)/, "($2)").replace(/\+0x[0-9a-f]+/, "").slice(0, 80);
}

export const pyspyAdapter: Adapter = {
  name: "py-spy",
  tools: ["profile_cpu", "dump_stacks", "snapshot_memory"],
  platforms: ["linux", "darwin"],
  requires: ["py-spy"],
  runtimes: ["python"],
  install: { linux: "pip install py-spy   (or: cargo install py-spy)", darwin: "pip install py-spy   (or: brew install py-spy)" },
  priority: 20,
  check(base, env) {
    if (env.platform === "darwin" && !env.isRoot) base.notes.push("macOS: attaching to processes you did not spawn requires sudo");
    if (env.platform === "linux" && env.ptraceScope !== null && env.ptraceScope >= 1 && !env.isRoot) base.notes.push(`ptrace_scope=${env.ptraceScope}: can only attach to child processes without root`);
    return base;
  },
  async run(tool, args, ctx) {
    if (tool === "dump_stacks") return dumpStacks(ctx, false);
    if (tool === "profile_cpu") return profileCpu(ctx, args as { duration_s?: number });
    if (tool === "snapshot_memory") {
      // py-spy contributes a stack+locals dump; psmem adapter adds RSS series. Dispatcher takes the first ok result,
      // so we merge both here.
      const { snapshotMemoryGeneric } = await import("./psmem.js");
      const base = await snapshotMemoryGeneric(ctx, args as { window_s?: number });
      const dump = await dumpStacks(ctx, true, "snapshot_memory");
      return mergeResults(base, dump, ["instant stack+locals via py-spy; Python has no retained-size heap view without tracemalloc — enable tracemalloc in the app for allocation-site attribution"]);
    }
    throw new Error(`py-spy adapter cannot run ${tool}`);
  },
};

/** Merge evidence/findings/artifacts of `extra` into `base`, re-numbering ids. Pure. */
export function mergeResults(base: ToolResult, extra: ToolResult, limitations: string[] = []): ToolResult {
  const offsetE = base.evidence.length;
  const offsetF = base.findings.length;
  const idMap = new Map<string, string>();
  const evidence = [...base.evidence];
  for (const e of extra.evidence) {
    const id = `e${evidence.length + 1}`;
    idMap.set(e.id, id);
    evidence.push({ ...e, id });
  }
  const findings = [...base.findings];
  for (const f of extra.findings) {
    findings.push({ ...f, id: `f${findings.length + 1}`, evidence_ids: f.evidence_ids.map((x) => idMap.get(x) ?? x) });
  }
  void offsetE;
  void offsetF;
  return {
    ...base,
    ok: base.ok || extra.ok,
    findings,
    evidence,
    limitations: [...new Set([...base.limitations, ...extra.limitations, ...limitations])],
    suggested_next: [...new Set([...base.suggested_next, ...extra.suggested_next])],
    artifacts: [...base.artifacts, ...extra.artifacts],
    duration_ms: base.duration_ms + extra.duration_ms,
    error: base.ok || extra.ok ? undefined : base.error ?? extra.error,
  };
}
