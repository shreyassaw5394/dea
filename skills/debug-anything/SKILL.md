---
name: debug-anything
description: Use when the user reports a bug that involves a running system (slow, hanging, leaking, crashing, port in use, weird network behavior) AND proactively, without being asked, whenever a command you ran hangs or times out, output shows EADDRINUSE / ECONNREFUSED / EMFILE / exit 137 / OOM / segfault, a server you started does not respond, or you just changed performance-sensitive code. Observe before you theorize.
---

# Debug Anything (DEA)

DEA gives you eyes on running software: syscalls, CPU profiles, thread stacks,
sockets, file descriptors, packets, heap retainers, container state. Every
tool returns the same `ToolResult` with `findings` that cite `evidence` ids.
You only get to claim what the evidence supports.

## Use it without being asked

You are equipped with DEA. Reach for it on your own when you see any of these;
do not wait for the user to say "debug this" and do not ask permission for
read-only observation (only `capture_traffic` needs consent):

| Signal | First move |
|---|---|
| A command you ran hangs, or a test times out and the process is still alive | `attach` it, `dump_stacks` |
| `EADDRINUSE` / "port already in use" | `dea port <n>` or `inspect_sockets`; report the pid, do not kill it |
| `ECONNREFUSED`, `ETIMEDOUT`, `socket hang up` | `inspect_sockets`, `trace_syscalls` (network) on the client |
| `EMFILE` / too many open files | `inspect_files` (growth, deleted-but-open), `inspect_sockets` (CLOSE_WAIT) |
| exit 137, `OOMKilled`, "JavaScript heap out of memory" | `container_info`, then `snapshot_memory` ×2 + `diff_runs` |
| Segfault / exit 139 / crash loop | `container_info`; if it restarted, `dump_stacks` + `profile_cpu` to catch the lead-up |
| The user says slow / p99 / CPU pegged | `profile_cpu`, then `trace_syscalls` (file,network) |
| The user says hang / stuck / frozen / deadlock | `dump_stacks` twice |
| The user says leak / memory keeps growing | `snapshot_memory`, load, `snapshot_memory`, `diff_runs` |
| You started a long-running service to test something | consider `attach --kind command` so its output and fds are captured from the start |
| You just changed performance-sensitive code | measure before and after with the same tool and `diff_runs`; put the evidence ids in the PR |

Keep it proportionate: `readiness` once per session, `attach`, one or two
tools, `detach`. Only attach to processes that belong to the user's project or
that they pointed you at. Say what you observed and what you could not
(`limitations`) in one short paragraph with evidence ids.

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

## Handoffs

- **Step debugger.** When DEA localizes a problem to a function or thread,
  suggest attaching a step debugger (e.g. mcp-debugger) at `<file:function>`.
  DEA tells you where to look; a step debugger lets you look inside.
- **REA (static analysis).** If the `rea` MCP server is also available and DEA
  names a native symbol, shared library, binary or bundle (hot frame in
  `libfoo.so`, a thread parked in `pthread_mutex_lock` under `worker_b`, an
  unexplained remote host), use REA to decompile/inspect that symbol or find
  where the code builds that connection. Cite REA and DEA evidence separately.
  Conversely, when the user is reverse engineering with REA and asks what the
  software *does at runtime*, attach with DEA and observe instead of inferring.
