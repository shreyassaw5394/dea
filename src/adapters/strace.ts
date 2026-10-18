/**
 * strace adapter (Linux): trace_syscalls.
 *   strace -f -T -tt -e trace=<set> -p PID -o <file>
 * Returns top syscalls by total time and count, slowest individual calls,
 * error counts, and blocked waits. Raw log → artifact.
 */
import { readFile } from "node:fs/promises";
import type { Adapter, AdapterContext } from "./types.js";
import type { SyscallCategory, ToolResult } from "../contracts.js";
import { ResultBuilder } from "../evidence.js";
import { runCapped, clampDuration, looksLikePermissionError, rootRequiredLimitation, LIMITS } from "../safety.js";

export const CATEGORY_SETS: Record<SyscallCategory, string> = {
  network: "%network",
  file: "%file,%desc",
  process: "%process",
  signal: "%signal",
  memory: "%memory",
  all: "all",
};

export interface SyscallRecord {
  pid?: number;
  time?: string; // wall clock from -tt
  name: string;
  args: string;
  result: string; // "0", "-1 ENOENT (No such file or directory)", "?"
  errno?: string;
  duration_s?: number; // from -T
  unfinished?: boolean;
  resumed?: boolean;
  line: number; // 1-based line in the raw log
}

const LINE_RE = /^(?:\[pid\s+(\d+)\]\s+|(\d+)\s+)?(?:(\d{2}:\d{2}:\d{2}\.\d+)\s+)?(\w+)\((.*?)\)\s+=\s+(.+?)(?:\s+<([\d.]+)>)?$/;
const UNFINISHED_RE = /^(?:\[pid\s+(\d+)\]\s+|(\d+)\s+)?(?:(\d{2}:\d{2}:\d{2}\.\d+)\s+)?(\w+)\((.*)<unfinished \.\.\.>$/;
const RESUMED_RE = /^(?:\[pid\s+(\d+)\]\s+|(\d+)\s+)?(?:(\d{2}:\d{2}:\d{2}\.\d+)\s+)?<\.\.\. (\w+) resumed>\s*(.*?)\)?\s+=\s+(.+?)(?:\s+<([\d.]+)>)?$/;

/** Parse an strace log produced with -f -T -tt. Pure. */
export function parseStrace(raw: string): SyscallRecord[] {
  const out: SyscallRecord[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();
    if (!line || line.startsWith("strace:") || /\+\+\+ (exited|killed)|--- SIG/.test(line)) continue;
    let m = LINE_RE.exec(line);
    if (m) {
      const result = m[6]!;
      const errno = /^-1 ([A-Z]+)/.exec(result)?.[1];
      out.push({ pid: m[1] ? Number(m[1]) : m[2] ? Number(m[2]) : undefined, time: m[3], name: m[4]!, args: m[5]!, result, errno, duration_s: m[7] ? Number(m[7]) : undefined, line: i + 1 });
      continue;
    }
    m = UNFINISHED_RE.exec(line);
    if (m) {
      out.push({ pid: m[1] ? Number(m[1]) : m[2] ? Number(m[2]) : undefined, time: m[3], name: m[4]!, args: m[5]!, result: "?", unfinished: true, line: i + 1 });
      continue;
    }
    m = RESUMED_RE.exec(line);
    if (m) {
      const result = m[6]!;
      const errno = /^-1 ([A-Z]+)/.exec(result)?.[1];
      // Attach to the matching unfinished record for the same pid, if any.
      const pid = m[1] ? Number(m[1]) : m[2] ? Number(m[2]) : undefined;
      const open = [...out].reverse().find((r) => r.unfinished && r.name === m![4] && r.pid === pid && r.result === "?");
      if (open) {
        open.result = result;
        open.errno = errno;
        open.duration_s = m[7] ? Number(m[7]) : undefined;
        open.args += m[5] ?? "";
        open.resumed = true;
      } else out.push({ pid, time: m[3], name: m[4]!, args: m[5] ?? "", result, errno, duration_s: m[7] ? Number(m[7]) : undefined, resumed: true, line: i + 1 });
    }
  }
  return out;
}

export interface SyscallStat {
  syscall: string;
  count: number;
  total_ms: number;
  avg_ms: number;
  max_ms: number;
  errors: number;
}

const WAIT_SYSCALLS = new Set(["futex", "epoll_wait", "epoll_pwait", "epoll_pwait2", "poll", "ppoll", "select", "pselect6", "nanosleep", "clock_nanosleep", "wait4", "waitid", "read", "recvfrom", "recvmsg", "recv", "accept", "accept4", "connect", "flock", "fcntl", "io_uring_enter", "rt_sigtimedwait", "pause", "sched_yield"]);

/** Aggregate per-syscall stats. Pure. */
export function aggregateSyscalls(records: SyscallRecord[]): { stats: SyscallStat[]; errors: Array<{ errno: string; syscall: string; count: number; example?: string }>; slowest: SyscallRecord[]; totalMs: number; waitMs: number } {
  const by = new Map<string, SyscallStat>();
  const errBy = new Map<string, { errno: string; syscall: string; count: number; example?: string }>();
  let totalMs = 0;
  let waitMs = 0;
  for (const r of records) {
    const s = by.get(r.name) ?? { syscall: r.name, count: 0, total_ms: 0, avg_ms: 0, max_ms: 0, errors: 0 };
    s.count++;
    const ms = (r.duration_s ?? 0) * 1000;
    s.total_ms += ms;
    s.max_ms = Math.max(s.max_ms, ms);
    if (r.errno) {
      s.errors++;
      const k = `${r.errno}:${r.name}`;
      const e = errBy.get(k) ?? { errno: r.errno, syscall: r.name, count: 0, example: r.args.slice(0, 120) };
      e.count++;
      errBy.set(k, e);
    }
    by.set(r.name, s);
    totalMs += ms;
    if (WAIT_SYSCALLS.has(r.name)) waitMs += ms;
  }
  const stats = [...by.values()].map((s) => ({ ...s, total_ms: round(s.total_ms), avg_ms: round(s.count ? s.total_ms / s.count : 0), max_ms: round(s.max_ms) })).sort((a, b) => b.total_ms - a.total_ms);
  const errors = [...errBy.values()].sort((a, b) => b.count - a.count);
  const slowest = [...records].filter((r) => r.duration_s !== undefined).sort((a, b) => b.duration_s! - a.duration_s!).slice(0, 10);
  return { stats, errors, slowest, totalMs: round(totalMs), waitMs: round(waitMs) };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Extract a human-ish target from syscall args: path for open/stat, fd + addr for connect, fd for read/write. Pure. */
export function describeArgs(r: SyscallRecord): string {
  const path = /"([^"]{1,120})"/.exec(r.args)?.[1];
  const addr = /sin_addr=inet_addr\("([^"]+)"\)|sin6_addr=inet_pton\([^,]+,\s*"([^"]+)"|sun_path="([^"]+)"/.exec(r.args);
  const port = /sin6?_port=htons\((\d+)\)/.exec(r.args)?.[1];
  const parts: string[] = [];
  if (path && !addr) parts.push(path);
  if (addr) parts.push(`${addr[1] ?? addr[2] ?? addr[3]}${port ? `:${port}` : ""}`);
  if (!parts.length) parts.push(r.args.slice(0, 60));
  return parts.join(" ");
}

/** Shared by strace, fs_usage and `dea import`: records → evidence + findings. */
export function summarizeSyscallRecords(b: ResultBuilder, records: SyscallRecord[], duration: number, artifactPath: string): void {
  const agg = aggregateSyscalls(records);
  const topEv = b.evidenceOf(
    "syscall_stat",
    `${records.length} syscalls, ${agg.totalMs} ms inside the kernel over ${duration}s; top by time: ${agg.stats
      .slice(0, 5)
      .map((s) => `${s.syscall} ${s.total_ms}ms×${s.count}`)
      .join(", ")}`,
    agg.stats.slice(0, 20),
    { artifact: artifactPath },
  );
  const slow = agg.slowest.slice(0, 8).map((rec) => ({ syscall: rec.name, ms: round((rec.duration_s ?? 0) * 1000), pid: rec.pid, at: rec.time, target: describeArgs(rec), result: rec.result.slice(0, 60), line: rec.line }));
  const slowEv = b.evidenceOf("syscall_slow", slow.length ? `slowest: ${slow.slice(0, 3).map((s) => `${s.syscall}(${s.target}) ${s.ms}ms`).join("; ")}` : "no timed syscalls", slow, { artifact: artifactPath, lines: slow[0] ? [slow[0].line, slow[0].line] : undefined });
  const errEv = b.evidenceOf("syscall_error", agg.errors.length ? `errors: ${agg.errors.slice(0, 5).map((e) => `${e.syscall}→${e.errno}×${e.count}`).join(", ")}` : "no failing syscalls", agg.errors.slice(0, 15), { artifact: artifactPath });
  const waitPct = agg.totalMs ? Math.round((100 * agg.waitMs) / agg.totalMs) : 0;
  const waitEv = b.evidenceOf("metric", `${waitPct}% of kernel time in blocking waits (futex/poll/epoll/read/recv/nanosleep)`, { name: "wait_pct", value: waitPct, wait_ms: agg.waitMs, total_ms: agg.totalMs });

  // Findings
  const top = agg.stats[0];
  if (top && agg.totalMs > 0 && top.total_ms / agg.totalMs > 0.5) {
    const isWait = WAIT_SYSCALLS.has(top.syscall);
    b.finding(isWait ? "info" : "warn", `${top.syscall} dominates: ${top.total_ms} ms over ${top.count} calls (${Math.round((100 * top.total_ms) / agg.totalMs)}% of kernel time)${isWait ? " — blocking wait, the process is waiting on something" : ""}`, [topEv, slowEv], "observed");
  }
  const nanosleep = agg.stats.find((s) => /nanosleep/.test(s.syscall));
  if (nanosleep && nanosleep.total_ms > duration * 100) b.finding("warn", `${nanosleep.total_ms} ms in ${nanosleep.syscall} (${nanosleep.count} calls) — deliberate sleeps/timers on the request path`, [topEv], "inferred");
  const fileChurn = agg.stats.filter((s) => /^(openat|open|stat|newfstatat|statx|lstat|access|readlink)$/.test(s.syscall)).reduce((n, s) => n + s.count, 0);
  if (fileChurn > duration * 200) b.finding("warn", `${fileChurn} path lookups (open/stat) in ${duration}s — filesystem churn (missing cache? module resolution per request?)`, [topEv], "inferred");
  const reads = agg.stats.find((s) => s.syscall === "read");
  if (reads && reads.count > duration * 300) b.finding("warn", `${reads.count} read() calls in ${duration}s (avg ${reads.avg_ms} ms) — many small reads; sync I/O in a loop?`, [topEv], "inferred");
  for (const e of agg.errors.slice(0, 4)) {
    const sev = /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EMFILE|ENOSPC|ENOMEM/.test(e.errno) ? "high" : e.count > 50 ? "warn" : "info";
    const hint = e.errno === "EAGAIN" ? " (non-blocking I/O would-block; normal for event loops unless excessive)" : e.errno === "ENOENT" ? ` (missing file; e.g. ${e.example?.split(",")[0]})` : e.errno === "ECONNREFUSED" ? " — a downstream service is not accepting connections" : "";
    b.finding(sev, `${e.count}× ${e.syscall} failed with ${e.errno}${hint}`, [errEv], "observed");
  }
  if (slow[0] && slow[0].ms > 500) b.finding("warn", `slowest single call: ${slow[0].syscall}(${slow[0].target}) took ${slow[0].ms} ms`, [slowEv], "observed");
  if (b.findingCount === 0) b.finding("info", `${records.length} syscalls in ${duration}s, nothing dominant; top ${top?.syscall ?? "?"}`, [topEv, waitEv]);
}

async function traceSyscalls(ctx: AdapterContext, args: { duration_s?: number; categories?: SyscallCategory[] }): Promise<ToolResult> {
  const { session, target } = ctx;
  const b = new ResultBuilder("trace_syscalls", session, target);
  if (!target.pid) return b.fail("no pid").build();
  const duration = clampDuration(args.duration_s, 10);
  const cats = args.categories?.length ? args.categories : (["all"] as SyscallCategory[]);
  const set = cats.includes("all") ? "all" : [...new Set(cats.map((c) => CATEGORY_SETS[c]))].join(",");
  const out = b.artifactPath("strace.log");
  const straceArgs = ["-f", "-T", "-tt", "-qq", "-s", "64", "-e", `trace=${set}`, "-p", String(target.pid), "-o", out];
  // strace has no --duration; we rely on the time cap (SIGTERM → strace detaches cleanly).
  const r = await runCapped("strace", straceArgs, { timeoutMs: duration * 1000, captureInMemory: true });
  const raw = await readFile(out, "utf8").catch(() => "");
  const art = await b.addArtifact(out, "raw_text", { description: `strace ${straceArgs.join(" ")} for ${duration}s`, truncated: r.outputCapped });
  if (!raw.trim()) {
    const cmd = `strace ${straceArgs.join(" ")}`;
    if (looksLikePermissionError(r.stderr)) {
      b.limitation(rootRequiredLimitation("trace_syscalls", cmd));
      b.limitation("Linux: kernel.yama.ptrace_scope ≥ 1 blocks attaching to non-child processes; sudo sysctl kernel.yama.ptrace_scope=0 for this boot, or run DEA as root / with CAP_SYS_PTRACE");
      return b.fail("strace could not attach (permission denied)").build();
    }
    if (r.stderr.trim()) b.limitation(`strace: ${r.stderr.trim().slice(0, 300)}`);
    const ev = b.evidenceOf("syscall_stat", `0 syscalls in ${duration}s`, { name: "syscalls", count: 0 });
    b.finding("info", `no syscalls in ${duration}s — the process made no kernel calls (spinning in user space, or fully idle in a wait that started before the trace)`, [ev], "inferred");
    b.next("dump_stacks", "profile_cpu");
    return b.build();
  }
  summarizeSyscallRecords(b, parseStrace(raw), duration, art.path);
  b.limitation(`traced ${duration}s only (${set}); strace adds overhead to every syscall — latencies are inflated`);
  if (r.outputCapped) b.limitation(`raw log hit the ${LIMITS.MAX_RAW_BYTES / 1024 / 1024} MB cap and was cut short`);
  b.next("profile_cpu", "inspect_sockets", "inspect_files");
  return b.build();
}

export const straceAdapter: Adapter = {
  name: "strace",
  tools: ["trace_syscalls"],
  platforms: ["linux"],
  requires: ["strace"],
  install: { linux: "sudo apt install strace  |  sudo dnf install strace  |  apk add strace" },
  priority: 10,
  check(base, env) {
    if (env.ptraceScope !== null && env.ptraceScope >= 1 && !env.isRoot) base.notes.push(`ptrace_scope=${env.ptraceScope}: can only trace child processes without root`);
    return base;
  },
  async run(tool, args, ctx) {
    if (tool !== "trace_syscalls") throw new Error(`strace adapter cannot run ${tool}`);
    return traceSyscalls(ctx, args as { duration_s?: number; categories?: SyscallCategory[] });
  },
};
