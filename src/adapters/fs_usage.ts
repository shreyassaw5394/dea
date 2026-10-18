/**
 * fs_usage adapter (macOS): trace_syscalls without strace.
 *   fs_usage -w -f filesys,network -p PID
 * Works with SIP enabled but needs root. When DEA is not root it returns the
 * exact command to run yourself plus `dea import fs_usage <file>`.
 */
import type { Adapter, AdapterContext } from "./types.js";
import type { SyscallCategory, ToolResult } from "../contracts.js";
import { ResultBuilder } from "../evidence.js";
import { runCapped, clampDuration, isRoot, looksLikePermissionError, rootRequiredLimitation, LIMITS } from "../safety.js";
import { summarizeSyscallRecords, type SyscallRecord } from "./strace.js";

/** macOS errno numbers fs_usage prints in brackets, e.g. "[  2]". */
const DARWIN_ERRNO: Record<number, string> = { 1: "EPERM", 2: "ENOENT", 4: "EINTR", 5: "EIO", 9: "EBADF", 11: "EDEADLK", 12: "ENOMEM", 13: "EACCES", 17: "EEXIST", 20: "ENOTDIR", 21: "EISDIR", 22: "EINVAL", 24: "EMFILE", 28: "ENOSPC", 32: "EPIPE", 35: "EAGAIN", 36: "EINPROGRESS", 54: "ECONNRESET", 57: "ENOTCONN", 60: "ETIMEDOUT", 61: "ECONNREFUSED", 65: "EHOSTUNREACH" };

/**
 * Parse `fs_usage -w` lines into SyscallRecords. Pure.
 *   22:47:41.812345  read         F=23  B=0x1000          0.000012   node.12345
 *   22:47:41.812400  RdData[A]    /Users/x/payload.bin    0.000500 W node.12345
 *   22:47:41.813000  open         [  2] (R_____) /etc/missing   0.000030   node.12345
 * elapsed seconds is the last numeric token before an optional "W" (= the call blocked) and "proc.tid".
 */
export function parseFsUsage(raw: string): SyscallRecord[] {
  const out: SyscallRecord[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trimEnd();
    const m = /^(\d{2}:\d{2}:\d{2}\.\d+)\s+(\S+)\s+(.*?)\s+(\d+\.\d{6})(?:\s+(W))?\s+(\S+?)\.(\d+)\s*$/.exec(line);
    if (!m) continue;
    const name = m[2]!.replace(/\[.*$/, "");
    const args = m[3]!.trim();
    const err = /\[\s*(\d+)\]/.exec(args);
    const errno = err ? (DARWIN_ERRNO[Number(err[1])] ?? `E${err[1]}`) : undefined;
    out.push({ pid: Number(m[7]), time: m[1], name, args: args.replace(/\[\s*\d+\]\s*/, "").replace(/^\(\S+\)\s*/, ""), result: errno ? `-1 ${errno}` : m[5] ? "0 (blocked)" : "0", errno, duration_s: Number(m[4]), line: i + 1 });
  }
  return out;
}

const FS_FILTERS: Record<SyscallCategory, string | undefined> = { network: "network", file: "filesys", process: "exec", signal: undefined, memory: undefined, all: "filesys,network,exec" };

async function traceSyscalls(ctx: AdapterContext, args: { duration_s?: number; categories?: SyscallCategory[] }): Promise<ToolResult> {
  const { session, target } = ctx;
  const b = new ResultBuilder("trace_syscalls", session, target);
  if (!target.pid) return b.fail("no pid").build();
  const duration = clampDuration(args.duration_s, 10);
  const cats = args.categories?.length ? args.categories : (["all"] as SyscallCategory[]);
  const filters = [...new Set(cats.map((c) => FS_FILTERS[c]).filter(Boolean))].join(",") || "filesys,network";
  const out = b.artifactPath("fs_usage.txt");
  const fsArgs = ["-w", "-f", filters, "-p", String(target.pid)];
  const cmd = `sudo fs_usage ${fsArgs.join(" ")} > ${out}`;
  if (!isRoot()) {
    b.limitation(rootRequiredLimitation("trace_syscalls", `fs_usage ${fsArgs.join(" ")}`));
    b.limitation(`macOS has no strace; fs_usage needs root. Run for ~${duration}s then Ctrl-C:  ${cmd}   and then:  dea import fs_usage ${out} --session ${session.id}`);
    b.limitation("or run the target on Linux (docker/linux-lab) where strace gives the full breakdown");
    b.next(`import_artifact (fs_usage, ${out})`, "inspect_sockets", "profile_cpu");
    return b.fail("fs_usage needs root; DEA never escalates").build();
  }
  const r = await runCapped("fs_usage", fsArgs, { timeoutMs: duration * 1000, stdoutFile: out, captureInMemory: false });
  const { readFile } = await import("node:fs/promises");
  const raw = await readFile(out, "utf8").catch(() => "");
  const art = await b.addArtifact(out, "raw_text", { description: `fs_usage ${fsArgs.join(" ")} for ${duration}s`, truncated: r.outputCapped });
  if (!raw.trim()) {
    if (looksLikePermissionError(r.stderr)) {
      b.limitation(rootRequiredLimitation("trace_syscalls", `fs_usage ${fsArgs.join(" ")}`));
      return b.fail("fs_usage could not run (permission denied)").build();
    }
    const ev = b.evidenceOf("syscall_stat", `0 syscalls in ${duration}s`, { name: "syscalls", count: 0 });
    b.finding("info", `no file/network syscalls in ${duration}s — idle, or spinning in user space`, [ev], "inferred");
    return b.build();
  }
  summarizeSyscallRecords(b, parseFsUsage(raw), duration, art.path);
  b.limitation(`fs_usage shows file and network calls only (filters: ${filters}); futex/select/kevent waits are not included — use dump_stacks for those`);
  if (r.outputCapped) b.limitation(`raw log hit the ${LIMITS.MAX_RAW_BYTES / 1024 / 1024} MB cap`);
  b.next("profile_cpu", "inspect_sockets", "inspect_files");
  return b.build();
}

export const fsUsageAdapter: Adapter = {
  name: "fs_usage",
  tools: ["trace_syscalls"],
  platforms: ["darwin"],
  requires: ["fs_usage"],
  install: { darwin: "preinstalled (/usr/bin/fs_usage); needs sudo" },
  priority: 5,
  check(base, env) {
    if (!env.isRoot) base.notes.push("needs root: DEA will print the sudo command and you can `dea import fs_usage <file>`");
    return base;
  },
  async run(tool, args, ctx) {
    if (tool !== "trace_syscalls") throw new Error(`fs_usage adapter cannot run ${tool}`);
    return traceSyscalls(ctx, args as { duration_s?: number; categories?: SyscallCategory[] });
  },
};
