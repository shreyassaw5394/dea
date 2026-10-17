/**
 * py-spy adapter: profile_cpu (record → folded stacks → flamegraph), dump_stacks
 * (thread stacks + lock-wait detection), snapshot_memory contribution (dump --locals).
 */
import { readFileSync } from "node:fs";
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

const STDLIB_FILE = /(^|\/)(threading|queue|socket|selectors|ssl|asyncio\/[a-z_]+|concurrent\/futures\/[a-z_]+|subprocess|time|multiprocessing\/[a-z_]+)\.py$/;

export type WaitKind = "lock" | "join" | "sleep" | "io" | "native" | "idle_loop";

export interface LockWait {
  thread: string;
  state: string;
  kind: WaitKind;
  /** Where (top frame) the thread is blocked. */
  waiting_in: string;
  /** First application frame (outside the stdlib) — where in the app it waits. */
  at: string;
  /** Source text of the blocking line when readable on this host. */
  source?: string;
  lock_repr?: string;
}

/** Read one source line (1-based) if the file is readable locally; capped. Not pure, but safe. */
export function sourceLine(file: string, line: number, reader: (f: string) => string | undefined = defaultReader): string | undefined {
  if (!file || !/\.py$/.test(file) || line < 1) return undefined;
  const text = reader(file);
  if (!text) return undefined;
  return text.split("\n")[line - 1]?.trim().slice(0, 160);
}

const srcCache = new Map<string, string | undefined>();
function defaultReader(f: string): string | undefined {
  if (srcCache.has(f)) return srcCache.get(f);
  let v: string | undefined;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    v = readFileSync(f, "utf8");
  } catch {
    v = undefined;
  }
  srcCache.set(f, v);
  return v;
}

const LOCK_SRC = /\bwith\b[^:]*(lock|mutex|sem|cond|rlock|lk\b)|\.acquire\(|\.__enter__\(|lock\(|Lock\(\)\.acquire/i;
const JOIN_SRC = /\.join\(|\.result\(|\.wait\(|\.get\(|wait_for|as_completed|\.gather\(/;
const SLEEP_SRC = /\bsleep\(/;
const IO_SRC = /\.(recv|recv_into|recvfrom|read|readline|readinto|accept|connect|send|sendall|write)\(|requests\.|urlopen|httpx\.|\.execute\(|\.fetch(one|all|many)\(|\.commit\(|select\.select|\.poll\(/;

/**
 * Classify what each thread is blocked in. py-spy shows a thread blocked in a
 * C-level call (lock acquire, sleep, socket read) with the *Python caller* as the
 * top frame, so we look at the top frame's function, file and — when readable —
 * its source line. Pure given a reader.
 */
export function findLockWaits(dump: PyDump, reader?: (f: string) => string | undefined, cwd?: string): LockWait[] {
  const out: LockWait[] = [];
  const resolve = (f: string) => (cwd && !f.startsWith("/") ? `${cwd.replace(/\/$/, "")}/${f}` : f);
  for (const t of dump.threads) {
    const top = t.frames[0];
    if (!top) continue;
    const user = t.frames.find((f) => !STDLIB_FILE.test(f.file) && !/<frozen|importlib|site-packages\/(werkzeug|flask|gunicorn|uvicorn|django)/.test(f.file)) ?? top;
    const base = {
      thread: t.name || t.id,
      state: t.state,
      waiting_in: `${top.func} (${top.file.split("/").pop()}:${top.line})`,
      at: `${user.func} (${user.file.split("/").pop()}:${user.line})`,
      lock_repr: Object.entries(top.locals ?? {}).find(([k]) => /lock|cond|mutex|sem/i.test(k))?.[1],
    };
    const inStdlib = STDLIB_FILE.test(top.file);
    let kind: WaitKind | undefined;
    if (inStdlib) {
      if (/_wait_for_tstate_lock|^join$/.test(top.func)) kind = "join";
      else if (/acquire|__enter__|^wait$|_acquire_restore|^get$|^put$/.test(top.func) && /threading|queue/.test(top.file)) kind = /^(get|put)$/.test(top.func) ? "join" : "lock";
      else if (/sleep/.test(top.func)) kind = "sleep";
      else if (/select|poll|recv|read|accept|connect|send|^wait$/.test(top.func)) kind = "io";
      else if (/asyncio|run_forever|_run_once|serve_forever/.test(top.file + top.func)) kind = "idle_loop";
    }
    if (!kind && t.state !== "active") {
      // Blocked in a C call from user code: read the line to see what it does.
      const src = sourceLine(resolve(top.file), top.line, reader);
      if (src) {
        if (LOCK_SRC.test(src)) kind = "lock";
        else if (SLEEP_SRC.test(src)) kind = "sleep";
        else if (JOIN_SRC.test(src)) kind = "join";
        else if (IO_SRC.test(src)) kind = "io";
        else kind = "native";
        out.push({ ...base, kind, source: src });
        continue;
      }
      if (!inStdlib) kind = "native";
    }
    if (kind) out.push({ ...base, kind });
  }
  return out;
}

/** Working directory of a pid (to resolve relative source paths py-spy reports). */
export async function targetCwd(pid: number): Promise<string | undefined> {
  if (platform() === "linux") {
    try {
      const { readlink } = await import("node:fs/promises");
      return await readlink(`/proc/${pid}/cwd`);
    } catch {
      return undefined;
    }
  }
  const r = await runCapped("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"], { timeoutMs: 5000 });
  return r.stdout.split("\n").find((l) => l.startsWith("n"))?.slice(1);
}

/** Group lock waits by lock repr (when --locals gave us one). Pure. */
export function sameLockGroups(waits: LockWait[]): Array<{ lock: string; threads: string[] }> {
  const by = new Map<string, string[]>();
  for (const w of waits) {
    if (!w.lock_repr || w.kind !== "lock") continue;
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
  const cwd = target.pid ? await targetCwd(target.pid) : undefined;
  const waits = findLockWaits(dump, undefined, cwd);
  const locks = waits.filter((w) => w.kind === "lock");
  const joins = waits.filter((w) => w.kind === "join");
  const io = waits.filter((w) => w.kind === "io");
  const sleeps = waits.filter((w) => w.kind === "sleep");
  const natives = waits.filter((w) => w.kind === "native");
  const loops = waits.filter((w) => w.kind === "idle_loop");
  const fmt = (w: LockWait) => `${w.thread} at ${w.at}${w.source ? ` [${w.source}]` : ""}`;
  if (waits.length) {
    const waitEv = b.evidenceOf(
      "lock_wait",
      `${waits.length} blocked thread(s): ${locks.length} on locks, ${joins.length} joining/waiting, ${io.length} in I/O, ${sleeps.length} sleeping, ${natives.length} in other native calls, ${loops.length} idle event loops`,
      waits.map((w) => ({ thread: w.thread, kind: w.kind, at: w.at, waiting_in: w.waiting_in, source: w.source, lock_repr: w.lock_repr })),
      { artifact: art },
    );
    const groups = sameLockGroups(waits);
    if (groups.length) b.finding("high", `${groups[0]!.threads.length} threads wait on the same lock ${groups[0]!.lock}: ${groups[0]!.threads.join(", ")}`, [waitEv], "observed");
    if (locks.length >= 2 && active.length === 0) {
      b.finding(
        "high",
        `likely deadlock: ${locks.length} thread(s) blocked acquiring locks and no thread is running — ${locks.slice(0, 6).map(fmt).join("; ")}`,
        [waitEv, summaryEv],
        "inferred",
        `${joins.length ? `${joins.length} thread(s) are joined on them (${joins.slice(0, 3).map((w) => w.thread).join(", ")}). ` : ""}Re-run dump_stacks: identical positions confirm a deadlock. Handoff: attach a step debugger (e.g. mcp-debugger) at ${locks[0]!.at} to inspect lock owners.`,
      );
    } else if (locks.length) {
      b.finding("warn", `${locks.length} thread(s) blocked acquiring a lock: ${locks.slice(0, 6).map(fmt).join("; ")}`, [waitEv], "observed");
    }
    if (joins.length >= 3 && !locks.length) b.finding("warn", `${joins.length} thread(s) waiting on other threads/queues: ${joins.slice(0, 4).map(fmt).join("; ")}`, [waitEv], "observed");
    if (io.length) b.finding(io.length >= 3 ? "warn" : "info", `${io.length} thread(s) blocked in I/O: ${io.slice(0, 4).map(fmt).join("; ")}`, [waitEv], "observed", "inspect_sockets shows which remote they talk to.");
    if (sleeps.length) b.finding("info", `${sleeps.length} thread(s) in sleep(): ${sleeps.slice(0, 3).map(fmt).join("; ")}`, [waitEv], "observed");
    if (natives.length) b.finding("info", `${natives.length} thread(s) blocked in native calls from user code: ${natives.slice(0, 3).map(fmt).join("; ")}`, [waitEv], "observed");
  }
  if (b.findingCount === 0 && active.length === 0) b.finding("info", "all threads idle — the process is not stuck in Python code; if the caller hangs, look at the network path (inspect_sockets)", [summaryEv], "inferred");
  if (active.length) {
    const t = active[0]!;
    const f = t.frames[0];
    if (f) b.finding("info", `active thread ${t.name || t.id} is executing ${f.func} (${f.file.split("/").pop()}:${f.line})`, [summaryEv]);
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
  return summarizeProfile(b, folded, duration, "py-spy", 100);
}

/**
 * Shared by py-spy/perf/sample: folded stacks → evidence + findings + svg.
 * `sampleHz` is the profiler's rate so we can turn work samples into "% of wall time"
 * (perf only samples on-CPU time, so its idle share is ~0 by construction).
 */
export async function summarizeProfile(b: ResultBuilder, folded: string, duration: number, profiler: string, sampleHz?: number): Promise<ToolResult> {
  const stacks = parseFolded(folded);
  if (!stacks.length) {
    b.limitation(`${profiler} produced no samples in ${duration}s (process idle, or sampling blocked)`);
    const ev = b.evidenceOf("metric", "0 samples", { name: "samples", value: 0 });
    b.finding("info", `no CPU samples in ${duration}s — the process is idle or sleeping, not CPU-bound`, [ev], "inferred");
    b.next("dump_stacks", "trace_syscalls", "inspect_sockets");
    return b.build();
  }
  const { frames, totalSamples } = aggregateFrames(stacks, 15);
  // Idle/wait leaves vs work leaves. Multi-threaded targets have many permanently idle threads, so we
  // rank hot frames among WORK samples, not all samples.
  const workStacks = stacks.filter((s) => !IDLE_FRAME.test(s.frames[s.frames.length - 1]!));
  const workSamples = workStacks.reduce((n, s) => n + s.count, 0);
  const idlePct = Math.round((100 * (totalSamples - workSamples)) / totalSamples);
  const { frames: workFrames } = aggregateFrames(workStacks, 15);
  const hot = hottestStacks(workStacks.length ? workStacks : stacks, 5);
  const svg = renderFlamegraph(stacks, { title: `${profiler} ${duration}s pid ${b.target.pid}` });
  const svgPath = await b.writeArtifact("flamegraph.svg", svg, "flamegraph_svg", "flame graph (all threads, idle included)");
  // Busy share of wall time: for a single-threaded runtime this is "how busy was the main thread".
  const busyWall = sampleHz ? Math.min(100, Math.round((100 * workSamples) / (sampleHz * duration))) : undefined;
  const framesEv = b.evidenceOf(
    "frame_hot",
    workFrames.length
      ? `top self among ${workSamples} work samples: ${workFrames
          .slice(0, 5)
          .map((f) => `${shortFrame(f.frame)} ${f.self_pct}%`)
          .join(", ")}`
      : `no work frames; all ${totalSamples} samples idle`,
    (workFrames.length ? workFrames : frames).map((f) => ({ frame: f.frame, self: f.self, total: f.total, self_pct: f.self_pct, total_pct: f.total_pct })),
    { artifact: svgPath },
  );
  const stacksEv = b.evidenceOf("stack", `hottest work stack (${hot[0]?.pct}% of work): ${hot[0]?.stack.slice(-4).map(shortFrame).join(" ← ")}`, hot, { artifact: svgPath });
  const metricEv = b.evidenceOf(
    "metric",
    `${totalSamples} samples over ${duration}s: ${workSamples} work, ${idlePct}% idle/wait${busyWall !== undefined ? `; ≈${busyWall}% of wall time CPU-busy (${sampleHz} Hz)` : ""}`,
    { name: "samples", value: totalSamples, work_samples: workSamples, idle_pct: idlePct, busy_wall_pct: busyWall, duration_s: duration, sample_hz: sampleHz },
  );

  const topWork = workFrames[0];
  if (topWork && topWork.self_pct >= 20) {
    b.finding(busyWall === undefined || busyWall >= 25 ? "high" : "warn", `${shortFrame(topWork.frame)} accounts for ${topWork.self_pct}% of CPU work (${topWork.total_pct}% inclusive)${busyWall !== undefined ? `; the process was CPU-busy ≈${busyWall}% of the time` : ""}`, [framesEv, stacksEv, metricEv], "observed", `Hot path: ${hot[0]?.stack.slice(-6).map(shortFrame).join(" ← ")}. Handoff: attach a step debugger (e.g. mcp-debugger) at ${topWork.frame}.`);
  } else if (topWork && topWork.self_pct >= 8) {
    b.finding("warn", `${shortFrame(topWork.frame)} is the top CPU frame at ${topWork.self_pct}% of work`, [framesEv, stacksEv], "observed");
  }
  if (busyWall !== undefined && busyWall < 15) {
    b.finding("info", `process CPU-busy only ≈${busyWall}% of wall time — mostly waiting, not CPU-bound`, [metricEv], "inferred", "Look at trace_syscalls (what is it waiting on?) and inspect_sockets (whom?).");
  } else if (busyWall === undefined && idlePct >= 90 && !topWork) {
    b.finding("info", `~${idlePct}% of samples are in idle/wait frames — the process is mostly waiting, not CPU-bound`, [metricEv], "inferred");
  }
  if (b.findingCount === 0) b.finding("info", `CPU spread thin: top work frame ${shortFrame((workFrames[0] ?? frames[0])!.frame)} at ${(workFrames[0] ?? frames[0])!.self_pct}%`, [framesEv]);
  b.limitation(`sampled ${duration}s only (${profiler}${sampleHz ? ` @ ${sampleHz} Hz` : ""}); idle frames across all threads are excluded from the hot-frame ranking`);
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
