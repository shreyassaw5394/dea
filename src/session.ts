/**
 * Session lifecycle: create under ~/.dea/sessions/<id>/, persist metadata,
 * save every ToolResult as a run, clean up children on detach.
 */
import { mkdir, readFile, writeFile, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { Session, type Target, type ToolResult } from "./contracts.js";
import { killTrackedChildren } from "./safety.js";

export function deaHome(): string {
  return process.env.DEA_HOME ?? join(homedir(), ".dea");
}

export function sessionsDir(): string {
  return join(deaHome(), "sessions");
}

export function newSessionId(): string {
  const d = new Date();
  const stamp = d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "").replace("T", "-");
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export function platform(): "linux" | "darwin" | "win32" {
  const p = process.platform;
  return p === "linux" || p === "darwin" || p === "win32" ? p : "linux";
}

export async function createSession(target: Target): Promise<Session> {
  const id = newSessionId();
  const dir = join(sessionsDir(), id);
  await mkdir(join(dir, "runs"), { recursive: true });
  await mkdir(join(dir, "artifacts"), { recursive: true });
  const session: Session = {
    id,
    state: "attached",
    target,
    created_at: new Date().toISOString(),
    dir,
    platform: platform(),
    runs: [],
  };
  await saveSession(session);
  return session;
}

export async function saveSession(session: Session): Promise<void> {
  await writeFile(join(session.dir, "session.json"), JSON.stringify(session, null, 2));
}

export async function loadSession(id: string): Promise<Session> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) throw new Error(`invalid session id: ${JSON.stringify(id)}`);
  const file = join(sessionsDir(), id, "session.json");
  if (!existsSync(file)) throw new Error(`session not found: ${id}. Call attach first, or list sessions with \`dea sessions list\`.`);
  const raw = JSON.parse(await readFile(file, "utf8"));
  return Session.parse(raw);
}

export async function requireAttached(id: string): Promise<Session> {
  const s = await loadSession(id);
  if (s.state !== "attached") throw new Error(`session ${id} is detached; attach again to run tools`);
  return s;
}

/** Persist a ToolResult into the session and assign it a run id. Returns the result with run_id set. */
export async function recordRun(session: Session, result: ToolResult): Promise<ToolResult> {
  const n = session.runs.length + 1;
  const run_id = `${result.tool}#${n}`;
  const file = join(session.dir, "runs", `${String(n).padStart(3, "0")}-${result.tool}.json`);
  const withId: ToolResult = { ...result, run_id };
  await writeFile(file, JSON.stringify(withId, null, 2));
  session.runs.push({
    run_id,
    tool: result.tool,
    ok: result.ok,
    started_at: result.started_at ?? new Date().toISOString(),
    duration_ms: result.duration_ms,
    file,
  });
  await saveSession(session);
  return withId;
}

/** Load a prior run by run id ("profile_cpu#2"), by ordinal ("2"), or by tool name (latest of that tool). */
export async function loadRun(session: Session, ref: string): Promise<ToolResult> {
  let entry = session.runs.find((r) => r.run_id === ref);
  if (!entry && /^\d+$/.test(ref)) entry = session.runs[Number(ref) - 1];
  if (!entry) entry = [...session.runs].reverse().find((r) => r.tool === ref);
  if (!entry) {
    throw new Error(`run "${ref}" not found in session ${session.id}. Known runs: ${session.runs.map((r) => r.run_id).join(", ") || "(none)"}`);
  }
  return JSON.parse(await readFile(entry.file, "utf8")) as ToolResult;
}

export async function detachSession(session: Session): Promise<Session> {
  killTrackedChildren();
  session.state = "detached";
  session.detached_at = new Date().toISOString();
  await saveSession(session);
  return session;
}

export interface SessionSummary {
  id: string;
  state: string;
  target: string;
  created_at: string;
  runs: number;
  bytes: number;
}

export async function listSessions(): Promise<SessionSummary[]> {
  const dir = sessionsDir();
  if (!existsSync(dir)) return [];
  const ids = (await readdir(dir)).filter((d) => !d.startsWith("."));
  const out: SessionSummary[] = [];
  for (const id of ids) {
    try {
      const s = await loadSession(id);
      out.push({
        id,
        state: s.state,
        target: `${s.target.kind}:${s.target.id}${s.target.comm ? ` (${s.target.comm})` : ""}`,
        created_at: s.created_at,
        runs: s.runs.length,
        bytes: await dirSize(s.dir),
      });
    } catch {
      /* skip corrupt */
    }
  }
  return out.sort((a, b) => a.created_at.localeCompare(b.created_at));
}

async function dirSize(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) total += await dirSize(p);
    else total += (await stat(p)).size;
  }
  return total;
}

/** Remove detached sessions older than `olderThanDays` (default 7). Returns removed ids. */
export async function pruneSessions(opts: { olderThanDays?: number; all?: boolean } = {}): Promise<string[]> {
  const days = opts.olderThanDays ?? 7;
  const cutoff = Date.now() - days * 86_400_000;
  const removed: string[] = [];
  for (const s of await listSessions()) {
    const old = new Date(s.created_at).getTime() < cutoff;
    if (opts.all || (s.state === "detached" && old)) {
      await rm(join(sessionsDir(), s.id), { recursive: true, force: true });
      removed.push(s.id);
    }
  }
  return removed;
}
