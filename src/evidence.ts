/**
 * Evidence helpers: artifact writer, excerpt/pointer helpers, and a small
 * builder that makes it hard to produce a finding without evidence.
 */
import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Artifact, ArtifactKind, Evidence, EvidenceKind, Finding, Severity, Confidence, Target, ToolResult, Session } from "./contracts.js";
import { assertToolResult } from "./contracts.js";
import { capPayload, redactDeep, LIMITS, fileSize } from "./safety.js";

export class ResultBuilder {
  private evidence: Evidence[] = [];
  private findings: Finding[] = [];
  private artifacts: Artifact[] = [];
  readonly limitations: string[] = [];
  readonly suggested: string[] = [];
  private started = Date.now();
  private startedAt = new Date().toISOString();
  private error?: string;

  constructor(
    readonly tool: string,
    readonly session: Pick<Session, "id" | "dir"> | null,
    readonly target: Target,
  ) {}

  get artifactDir(): string {
    if (!this.session) throw new Error("no session");
    return join(this.session.dir, "artifacts");
  }

  /** Path for a new artifact file inside the session. */
  artifactPath(name: string): string {
    const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "");
    return join(this.artifactDir, `${stamp}-${this.tool}-${safe}`);
  }

  /** Write a text/JSON artifact and register it. Returns the path. */
  async writeArtifact(name: string, content: string | Buffer, kind: ArtifactKind, description?: string): Promise<string> {
    const path = this.artifactPath(name);
    await writeFile(path, content);
    this.artifacts.push({ path, kind, bytes: Buffer.byteLength(content), description });
    return path;
  }

  /** Register an artifact that was already written by a subprocess. */
  async addArtifact(path: string, kind: ArtifactKind, opts: { truncated?: boolean; description?: string } = {}): Promise<Artifact> {
    const a: Artifact = { path, kind, bytes: await fileSize(path), truncated: opts.truncated, description: opts.description };
    this.artifacts.push(a);
    return a;
  }

  /** Add evidence; returns its id for use in findings. */
  evidenceOf(kind: EvidenceKind, summary: string, data: unknown, opts: { artifact?: string; lines?: [number, number] } = {}): string {
    const id = `e${this.evidence.length + 1}`;
    this.evidence.push({ id, kind, summary, data, artifact: opts.artifact, lines: opts.lines });
    return id;
  }

  /** Add a finding. Throws if no evidence ids are given — by design. */
  finding(severity: Severity, summary: string, evidenceIds: string[], confidence: Confidence = "observed", detail?: string): string {
    if (evidenceIds.length === 0) throw new Error(`refusing to add finding without evidence: ${summary}`);
    const known = new Set(this.evidence.map((e) => e.id));
    for (const id of evidenceIds) if (!known.has(id)) throw new Error(`finding cites unknown evidence id ${id}`);
    const id = `f${this.findings.length + 1}`;
    this.findings.push({ id, severity, summary, evidence_ids: evidenceIds, confidence, detail });
    return id;
  }

  get findingCount(): number {
    return this.findings.length;
  }

  get evidenceCount(): number {
    return this.evidence.length;
  }

  limitation(msg: string): this {
    if (!this.limitations.includes(msg)) this.limitations.push(msg);
    return this;
  }

  next(...tools: string[]): this {
    for (const t of tools) if (!this.suggested.includes(t)) this.suggested.push(t);
    return this;
  }

  fail(message: string): this {
    this.error = message;
    return this;
  }

  /** Finalize: redact, cap, validate. */
  build(ok = this.error === undefined): ToolResult {
    const raw: ToolResult = {
      ok,
      tool: this.tool,
      session_id: this.session?.id ?? "",
      target: this.target,
      duration_ms: Date.now() - this.started,
      findings: this.findings,
      evidence: redactDeep(this.evidence),
      limitations: this.limitations.map((l) => l),
      suggested_next: this.suggested,
      artifacts: this.artifacts,
      error: this.error,
      started_at: this.startedAt,
    };
    const capped = capPayload(raw);
    return assertToolResult(capped);
  }
}

/** Build a failed result quickly (e.g. tool missing). */
export function failedResult(tool: string, session: Pick<Session, "id" | "dir"> | null, target: Target, error: string, limitations: string[] = [], suggested: string[] = []): ToolResult {
  const b = new ResultBuilder(tool, session, target);
  for (const l of limitations) b.limitation(l);
  b.next(...suggested);
  return b.fail(error).build();
}

/** Read an excerpt of lines [from, to] (1-based inclusive) from a text artifact, capped. */
export async function excerpt(path: string, from: number, to: number): Promise<string> {
  const text = await readFile(path, "utf8");
  const lines = text.split("\n");
  const end = Math.min(to, from + LIMITS.MAX_EXCERPT_LINES - 1, lines.length);
  return lines.slice(Math.max(0, from - 1), end).join("\n");
}

/** Find line numbers (1-based) in `text` matching `re`; returns [first, last] or undefined. */
export function lineRange(text: string, re: RegExp): [number, number] | undefined {
  const lines = text.split("\n");
  let first = -1;
  let last = -1;
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i]!)) {
      if (first < 0) first = i + 1;
      last = i + 1;
    }
  }
  return first > 0 ? [first, last] : undefined;
}

export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function pct(part: number, total: number): string {
  if (!total) return "0%";
  return `${((100 * part) / total).toFixed(1)}%`;
}
