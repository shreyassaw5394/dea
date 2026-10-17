/**
 * bpftrace adapter (Linux, optional): a few canned read-only scripts.
 * Not wired to a v0 tool yet — it is listed in readiness as not_implemented so
 * agents see it exists. Scripts are kept here for the next milestone
 * (trace_latency / trace_fd_opens / trace_tcp_retransmits).
 */
import type { Adapter } from "./types.js";

export const SCRIPTS = {
  syscall_latency: (pid: number) => `tracepoint:raw_syscalls:sys_enter /pid == ${pid}/ { @s[tid] = nsecs; } tracepoint:raw_syscalls:sys_exit /pid == ${pid} && @s[tid]/ { @us[args->id] = hist((nsecs - @s[tid]) / 1000); delete(@s[tid]); } interval:s:10 { exit(); }`,
  fd_opens: (pid: number) => `tracepoint:syscalls:sys_enter_openat /pid == ${pid}/ { @[str(args->filename)] = count(); } interval:s:10 { exit(); }`,
  tcp_retransmits: () => `kprobe:tcp_retransmit_skb { @[comm] = count(); } interval:s:10 { exit(); }`,
} as const;

export const bpftraceAdapter: Adapter = {
  name: "bpftrace",
  tools: [],
  platforms: ["linux"],
  requires: ["bpftrace"],
  install: { linux: "sudo apt install bpftrace" },
  async run() {
    throw new Error("bpftrace adapter is not implemented in v0");
  },
};
