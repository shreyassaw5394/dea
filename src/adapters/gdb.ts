/**
 * gdb adapter (Linux): dump_stacks for native/Node/Go/Java targets.
 *   gdb -p PID -batch -ex "thread apply all bt" -ex detach
 */
import type { Adapter, AdapterContext } from "./types.js";
import type { ToolResult } from "../contracts.js";
import { ResultBuilder } from "../evidence.js";
import { runCapped, looksLikePermissionError, rootRequiredLimitation } from "../safety.js";

export interface NativeThread {
  index: number;
  tid?: number;
  name?: string;
  frames: Array<{ n: number; func: string; loc?: string; addr?: string }>;
}

/** Parse `thread apply all bt` output (gdb). Pure. */
export function parseGdbBacktrace(raw: string): NativeThread[] {
  const threads: NativeThread[] = [];
  let cur: NativeThread | null = null;
  for (const line of raw.split("\n")) {
    let m = /^Thread (\d+) \(Thread 0x[0-9a-f]+ \(LWP (\d+)\)(?: "([^"]*)")?\):?/.exec(line) ?? /^Thread (\d+) \((?:process )?(\d+)(?: "([^"]*)")?\):?/.exec(line);
    if (m) {
      cur = { index: Number(m[1]), tid: Number(m[2]), name: m[3], frames: [] };
      threads.push(cur);
      continue;
    }
    m = /^#(\d+)\s+(?:(0x[0-9a-f]+) in )?(\S+?)\s*\((?:[^)]*)\)(?: at (\S+))?(?: from (\S+))?/.exec(line);
    if (m && cur) {
      cur.frames.push({ n: Number(m[1]), func: m[3]!, loc: m[4] ?? m[5], addr: m[2] });
      continue;
    }
    // Continuation lines of long frames are ignored.
  }
  return threads;
}

/** Mutex-style acquisition: contention, potentially a deadlock. */
const LOCK_FUNCS = /^(__GI_)?(pthread_mutex_lock|__lll_lock_wait|__lll_lock_wait_private|pthread_rwlock_(rd|wr)lock|uv_mutex_lock|__lll_lock|_?_pthread_mutex_firstfit_lock_slow|__psynch_mutexwait|__ulock_wait)$|absl::Mutex::Lock|std::mutex::lock|SpinLock|ObjectMonitor::enter|futex_wait_queue|__futex_abstimed_wait_(common|cancelable)/;
/** Condition / semaphore / event waits: idle worker threads, not contention. */
const IDLE_FUNCS = /pthread_cond_wait|pthread_cond_timedwait|__psynch_cvwait|uv_cond_wait|sem_wait|uv_sem_wait|semaphore_wait_trap|Monitor::wait|epoll_wait|epoll_pwait|^(__GI_)?p?poll$|^select$|^pselect6$|kevent|io_uring_enter|uv__io_poll|^pause$|sigwait|sigtimedwait|^wait4$|^waitid$|mach_msg|__workq_kernreturn|_dispatch_(worker|event_loop)|GCDAsync|^swapper$|__semwait_signal/;
/** Blocking I/O or sleeps: waiting on a peer or a timer. */
const IO_FUNCS = /^(__GI_)?(read|recv|recvfrom|recvmsg|accept|accept4|connect|nanosleep|clock_nanosleep|__clock_nanosleep|__select|__recvfrom|__read_nocancel|__connect|__accept)$|__libc_read|__libc_recv|SSL_read|usleep|^sleep$/;

export interface NativeLockWait {
  thread: string;
  waiting_in: string;
  at: string;
  kind: "lock" | "io" | "idle";
}

/** Classify threads by what they are blocked in. Pure. */
export function classifyNativeThreads(threads: NativeThread[]): { lock: NativeLockWait[]; io: NativeLockWait[]; idle: NativeLockWait[]; running: NativeThread[] } {
  const lock: NativeLockWait[] = [];
  const io: NativeLockWait[] = [];
  const idle: NativeLockWait[] = [];
  const running: NativeThread[] = [];
  const isSys = (f: string) => LOCK_FUNCS.test(f) || IDLE_FUNCS.test(f) || IO_FUNCS.test(f) || /^(__|_IO_|std::|uv_|uv__|start_thread|thread_start|_pthread_start|clone|clone3|\?\?|_dispatch|libsystem)/.test(f);
  for (const t of threads) {
    const top = t.frames.slice(0, 4);
    const lockF = top.find((f) => LOCK_FUNCS.test(f.func));
    const idleF = top.find((f) => IDLE_FUNCS.test(f.func));
    const ioF = top.find((f) => IO_FUNCS.test(f.func));
    const user = t.frames.find((f) => !isSys(f.func));
    const at = user ? `${user.func}${user.loc ? ` (${user.loc.split("/").pop()})` : ""}` : (t.frames.find((f) => !LOCK_FUNCS.test(f.func) && !IDLE_FUNCS.test(f.func) && !IO_FUNCS.test(f.func))?.func ?? "?");
    const label = `${t.name ? `${t.name} ` : ""}#${t.index}${t.tid ? ` (tid ${t.tid})` : ""}`;
    if (lockF) lock.push({ thread: label, waiting_in: lockF.func, at, kind: "lock" });
    else if (idleF) idle.push({ thread: label, waiting_in: idleF.func, at, kind: "idle" });
    else if (ioF) io.push({ thread: label, waiting_in: ioF.func, at, kind: "io" });
    else running.push(t);
  }
  return { lock, io, idle, running };
}

export async function summarizeNativeStacks(b: ResultBuilder, threads: NativeThread[], artifact: string, debugger_: string): Promise<ToolResult> {
  if (!threads.length) {
    b.limitation(`${debugger_} produced no thread backtraces (no symbols? target exited?)`);
    return b.fail(`${debugger_}: no stacks parsed`).build();
  }
  const { lock, io, idle, running } = classifyNativeThreads(threads);
  const summaryEv = b.evidenceOf(
    "stack_summary",
    `${threads.length} thread(s): ${running.length} running/other, ${lock.length} in locks, ${io.length} in blocking I/O, ${idle.length} idle (cond/event waits)`,
    threads.map((t) => ({ thread: `${t.name ?? ""}#${t.index}`, tid: t.tid, top: t.frames[0]?.func ?? "?", depth: t.frames.length })),
    { artifact },
  );
  for (const t of threads.slice(0, 12)) {
    b.evidenceOf("stack", `${t.name ? `${t.name} ` : ""}#${t.index}: ${t.frames.slice(0, 5).map((f) => f.func).join(" ← ")}`, { thread: `${t.name ?? ""}#${t.index}`, frames: t.frames.slice(0, 20).map((f) => `${f.func}${f.loc ? ` (${f.loc.split("/").pop()})` : ""}`) }, { artifact });
  }
  const noSymbols = threads.flatMap((t) => t.frames).filter((f) => f.func === "??").length;
  if (noSymbols > 0) b.limitation(`${noSymbols} frame(s) have no symbols (stripped binaries); install debug symbols for better names`);
  if (lock.length) {
    const lockEv = b.evidenceOf("lock_wait", `${lock.length} thread(s) blocked on locks: ${lock.map((l) => `${l.thread} in ${l.waiting_in} at ${l.at}`).join("; ")}`, lock, { artifact });
    if (lock.length >= 2 && running.length === 0) b.finding("high", `likely deadlock: ${lock.length} threads blocked in lock acquisition and none running (${lock.map((l) => `${l.thread}@${l.at}`).join(", ")})`, [lockEv, summaryEv], "inferred", "Take a second dump_stacks; identical positions confirm it. Handoff: step debugger at the lock sites.");
    else b.finding("warn", `${lock.length} thread(s) waiting on locks: ${lock.map((l) => `${l.thread} at ${l.at}`).join("; ")}`, [lockEv], "observed");
  }
  if (io.length) {
    const ioEv = b.evidenceOf("lock_wait", `${io.length} thread(s) in blocking I/O/sleep: ${io.slice(0, 5).map((l) => `${l.thread} in ${l.waiting_in} at ${l.at}`).join("; ")}`, io, { artifact });
    const mainBlocked = io.find((l) => /#1\b/.test(l.thread));
    if (mainBlocked) b.finding("warn", `main thread is blocked in ${mainBlocked.waiting_in} at ${mainBlocked.at} — waiting on a peer, a file or a timer`, [ioEv], "observed", "inspect_sockets shows which remote; trace_syscalls shows how long each wait takes.");
    else b.finding("info", `${io.length} thread(s) blocked in I/O: ${io.slice(0, 3).map((l) => `${l.thread} in ${l.waiting_in}`).join("; ")}`, [ioEv]);
  }
  if (idle.length) {
    const idleEv = b.evidenceOf("stack_summary", `${idle.length} idle thread(s) in ${[...new Set(idle.map((i) => i.waiting_in))].join(", ")}`, idle.slice(0, 20), { artifact });
    if (!lock.length && !io.length && running.length === 0) b.finding("info", `all ${threads.length} threads are idle in event/condition waits (${[...new Set(idle.map((i) => i.waiting_in))].slice(0, 4).join(", ")}) — not stuck in user code; if callers hang, the work is pending elsewhere (inspect_sockets, trace_syscalls)`, [idleEv, summaryEv], "inferred");
  }
  if (running.length) {
    const t = running[0]!;
    b.finding("info", `thread ${t.name ?? ""}#${t.index} is executing ${t.frames[0]?.func ?? "?"}${t.frames[1] ? ` ← ${t.frames[1].func}` : ""}`, [summaryEv]);
  }
  b.limitation("instant snapshot; the target was paused for the duration of the dump (typically <1 s)");
  b.next("inspect_sockets", "trace_syscalls", "profile_cpu");
  const interesting = lock[0]?.at ?? io.find((l) => /#1\b/.test(l.thread))?.at;
  if (interesting && interesting !== "?") b.next(`REA: decompile ${interesting.replace(/\s*\(.*$/, "")} statically to see what it locks/reads (npx rea-agents) — https://github.com/morluto/rea`);
  return b.build();
}

async function dumpStacks(ctx: AdapterContext): Promise<ToolResult> {
  const { session, target } = ctx;
  const b = new ResultBuilder("dump_stacks", session, target);
  if (!target.pid) return b.fail("no pid").build();
  const args = ["-p", String(target.pid), "-batch", "-q", "-nx", "-ex", "set pagination off", "-ex", "thread apply all bt 25", "-ex", "detach", "-ex", "quit"];
  const r = await runCapped("gdb", args, { timeoutMs: 45_000 });
  const raw = r.stdout + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : "");
  const art = await b.writeArtifact("gdb-bt.txt", raw, "raw_text", `gdb ${args.join(" ")}`);
  if (looksLikePermissionError(r.stderr) || /ptrace: Operation not permitted/.test(raw)) {
    b.limitation(rootRequiredLimitation("dump_stacks", `gdb ${args.join(" ")}`));
    b.limitation("Linux: kernel.yama.ptrace_scope ≥ 1 blocks attaching to non-child processes");
    return b.fail("gdb could not attach (permission denied)").build();
  }
  const threads = parseGdbBacktrace(r.stdout);
  if (target.runtime === "node") b.limitation("native stacks only; JS frames show as v8 internals. For JS-level stacks use Node's inspector (--inspect) or `node --cpu-prof`.");
  return summarizeNativeStacks(b, threads, art, "gdb");
}

export const gdbAdapter: Adapter = {
  name: "gdb",
  tools: ["dump_stacks"],
  platforms: ["linux"],
  requires: ["gdb"],
  runtimes: ["native", "node", "go", "java", "unknown"],
  install: { linux: "sudo apt install gdb  |  sudo dnf install gdb" },
  priority: 5,
  check(base, env) {
    if (env.ptraceScope !== null && env.ptraceScope >= 1 && !env.isRoot) base.notes.push(`ptrace_scope=${env.ptraceScope}: can only attach to child processes without root`);
    return base;
  },
  async run(tool, _args, ctx) {
    if (tool !== "dump_stacks") throw new Error(`gdb adapter cannot run ${tool}`);
    return dumpStacks(ctx);
  },
};
