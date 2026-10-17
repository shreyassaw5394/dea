---
name: debug-anything
description: Use when the user reports a bug that involves a running system: slow, hanging, leaking, crashing, port in use, weird network behavior. Observe before you theorize.
---

# Debug Anything (DEA)

DEA gives you eyes on running software: syscalls, CPU profiles, thread stacks,
sockets, file descriptors, packets, heap retainers, container state. Every
tool returns the same `ToolResult` with `findings` that cite `evidence` ids.
You only get to claim what the evidence supports.

## Session protocol

1. **Always call `readiness` first** in a session. Read `tools_available` and
   `tools_unavailable`; do not call tools that are unavailable, tell the user
   what is missing and the install hint instead.
2. **Always `attach` before any other tool.** Pass a pid, container name, pod
   (`namespace/name`) or a command (`kind: "command"` spawns it under
   capture). Use the returned `session_id` for everything.
3. **Always `detach` at the end.** It stops captures and writes the report.
4. Prefer each result's `suggested_next`. Stop when the evidence answers the
   question.

## Investigation orders

**Slow** (`dea_slow`): `profile_cpu` → `trace_syscalls` (network,file) →
`inspect_sockets` → `report`. CPU-bound if a few frames dominate self time;
otherwise look at blocked syscalls and remote hosts.

**Leak** (`dea_leak`): `snapshot_memory` → exercise the target → `snapshot_memory`
→ `diff_runs a=snapshot_memory#1 b=snapshot_memory#2` → `report`. The top
grower in retained size is the suspect. RSS up without heap up → native memory.

**Hang** (`dea_hang`): `dump_stacks` → `inspect_sockets` → `trace_syscalls`
(5 s) → `report`. Two threads each waiting on the other's lock = deadlock
(look for `lock_wait` evidence). One thread in a socket read = waiting on a
remote.

**Crash** (`dea_crash`): `container_info` (OOMKilled, exit code, restarts,
cgroup limits, log tail) → `report`. Exit 137 = SIGKILL (often OOM),
139 = SIGSEGV, 143 = SIGTERM.

**Port busy** (`dea_port_busy`): CLI `dea port <port>` or `attach` candidates
and `inspect_sockets`; report pid + command line. Never kill it yourself.

## Evidence rules

- **Never state a root cause without citing an evidence id** from a tool
  result, e.g. "readFileSync dominates CPU (profile_cpu#1/e2)".
- Phrase unsupported ideas as hypotheses and name the tool that would test
  them: "Hypothesis: downstream latency. Test: trace_syscalls network."
- Respect `confidence`: "observed" is read from tool output; "inferred" is a
  reasoning step — say which is which.
- Read `limitations`. "sampled 10 s", "no symbols", "ran without root" change
  what you may conclude.

## Consent and safety

- `capture_traffic` requires `consent: true`. **Ask the user before passing
  it.** Packet captures can contain secrets.
- DEA is read-only and never escalates privileges. If a tool returns
  `ok: false` with a sudo command in `limitations`, show the user that command;
  do not try to run it yourself.
- Payloads are redacted; raw artifacts under `~/.dea/sessions/` are not.

## After a fix

Re-run the same measuring tool and call `diff_runs` on the before/after run
ids to prove the fix. Put the diff's evidence ids in your summary.

## Handoff

When DEA localizes a problem to a function or thread, suggest attaching a
step debugger (e.g. mcp-debugger) at `<file:function>`. DEA tells you where
to look; a step debugger lets you look inside.
