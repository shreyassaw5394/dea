/**
 * MCP prompts: guided investigations. Each is a text template telling the
 * agent the order, what to look for, and to never state a cause without an
 * evidence id.
 */
export interface DeaPrompt {
  name: string;
  description: string;
  args: Array<{ name: string; description: string; required: boolean }>;
  render(args: Record<string, string | undefined>): string;
}

const RULES = `Rules for this investigation:
1. Call \`readiness\` first if you have not in this session. Respect tools_unavailable.
2. Call \`attach\` before any other tool and \`detach\` when done. Use the returned session_id everywhere.
3. Never state a root cause without citing an evidence id (e.g. "profile_cpu#1/e3") from a tool result. Unsupported ideas are hypotheses: say so and name the tool that would test them.
4. Before passing \`consent: true\` (capture_traffic), ask the user explicitly.
5. Prefer the tool's \`suggested_next\`. Stop when the evidence answers the question; do not run everything.
6. End with \`report\` and summarize: findings (with evidence ids), limitations, and the next step — including a step-debugger handoff when a function/thread is localized.`;

export const prompts: DeaPrompt[] = [
  {
    name: "dea_slow",
    description: "\"X is slow\": profile CPU, trace syscalls (network/file), inspect sockets, report.",
    args: [
      { name: "target", description: "pid, container name, pod, or command", required: true },
      { name: "symptom", description: "what the user observes (e.g. p99 latency 3s after 10 minutes)", required: false },
    ],
    render: (a) => `The user reports that ${a.target} is slow${a.symptom ? `: ${a.symptom}` : ""}. Find out why, with evidence.

Order:
1. readiness
2. attach { target: "${a.target}" }
3. profile_cpu { session_id, duration_s: 15 } — look at top frames by self time and the hottest stack. CPU-bound if a few frames dominate; otherwise the time is spent waiting.
4. trace_syscalls { session_id, duration_s: 10, categories: ["network","file"] } (Linux) — look at total time per syscall, the slowest individual calls, and blocked waits (futex/poll/epoll/nanosleep). Many slow read()/write() on sockets → downstream latency. Many open()/stat() → filesystem churn.
5. inspect_sockets { session_id } — many connections to one remote, CLOSE_WAIT pileups, or fd count near ulimit.
6. If a function is localized: suggest attaching a step debugger (e.g. mcp-debugger) at that file:function. If a remote host is localized: suggest capture_traffic with consent.
7. report { session_id }, then detach.

${RULES}`,
  },
  {
    name: "dea_leak",
    description: "\"memory keeps growing\": snapshot memory twice around some load, diff, report.",
    args: [
      { name: "target", description: "pid, container name, pod, or command", required: true },
      { name: "exercise", description: "how to generate load between snapshots (a command or instruction)", required: false },
    ],
    render: (a) => `The user reports that ${a.target} keeps growing in memory. Find what grows, with evidence.

Order:
1. readiness
2. attach { target: "${a.target}" }
3. snapshot_memory { session_id } — baseline RSS and (Node) heap retainers.
4. Exercise the target${a.exercise ? `: ${a.exercise}` : " (ask the user how, or send representative traffic yourself)"}. Wait at least 10 seconds.
5. snapshot_memory { session_id } again.
6. diff_runs { session_id, a: "snapshot_memory#1", b: "snapshot_memory#2" } — what grew in retained size, what appeared. The top grower is the suspect; name the constructor/closure and the retaining path if present.
7. Optionally repeat 4–6 once to confirm the trend is monotonic, not a one-off.
8. report { session_id }, then detach.

Note: RSS growth without heap growth points at native memory, buffers or fragmentation — say so instead of blaming JS/Python objects. Python targets get RSS series plus py-spy dump with locals, not heap retainers; state that limitation.

${RULES}`,
  },
  {
    name: "dea_hang",
    description: "\"it's stuck\": dump stacks, inspect sockets, short syscall trace, report.",
    args: [{ name: "target", description: "pid, container name, pod, or command", required: true }],
    render: (a) => `The user reports that ${a.target} is hung or stuck. Find what it is waiting on, with evidence.

Order:
1. readiness
2. attach { target: "${a.target}" }
3. dump_stacks { session_id } — look at every thread's top frames. Deadlock = two or more threads waiting on locks held by each other (the tool flags lock_wait evidence). Single thread blocked in a socket read = waiting on a remote. All threads idle = the process is not stuck, the caller is.
4. inspect_sockets { session_id } — is there an ESTABLISHED connection to a remote with nothing happening? Which remote?
5. trace_syscalls { session_id, duration_s: 5 } (Linux) — zero syscalls = spinning or deadlocked in user space; one blocked read/recvfrom/futex = waiting.
6. If a thread/function is localized: suggest attaching a step debugger (e.g. mcp-debugger) there.
7. report { session_id }, then detach.

${RULES}`,
  },
  {
    name: "dea_crash",
    description: "\"it died\": container state, OOM/exit codes, logs tail, core/dmesg hints, report.",
    args: [{ name: "target", description: "container name or pid of the restarted process", required: true }],
    render: (a) => `The user reports that ${a.target} crashed or died. Establish how it died, with evidence.

Order:
1. readiness
2. attach { target: "${a.target}" } (for a container that is down, attach still works for container_info)
3. container_info { session_id } — OOMKilled, exit code (137 = SIGKILL/OOM, 139 = SIGSEGV, 143 = SIGTERM), restart count, cgroup memory limit vs usage, error lines in the log tail.
4. If not a container: ask the user for the exit code / signal and check dmesg or journalctl for "Out of memory: Killed process <pid>" and segfault lines (DEA does not read dmesg itself yet; say so).
5. If a core file or crash log exists, suggest a step debugger / lldb on the core (handoff).
6. If it restarted and is running now: snapshot_memory and profile_cpu to catch the lead-up.
7. report { session_id }, then detach.

${RULES}`,
  },
  {
    name: "dea_port_busy",
    description: "\"address already in use\": find the process holding a port.",
    args: [{ name: "port", description: "the TCP/UDP port that is busy", required: true }],
    render: (a) => `The user cannot bind port ${a.port} (EADDRINUSE). Identify what holds it, with evidence.

Order:
1. readiness
2. list_processes { filter: "" } is not enough on its own — ports are per socket. Use the dedicated path: run \`dea port ${a.port}\` via the CLI if available, or:
3. attach to the most likely owner (list_processes, then attach by pid) and call inspect_sockets { session_id } — the listening sockets evidence names the port and pid.
4. If unsure which process, iterate: attach to candidates from list_processes and inspect_sockets each; a listening socket on :${a.port} is the answer.
5. Report the pid, command line, user and whether it is a stale instance of the user's own app. Do NOT kill it; tell the user the exact pid so they can decide.
6. detach.

${RULES}`,
  },
];

export function getPrompt(name: string): DeaPrompt | undefined {
  return prompts.find((p) => p.name === name);
}
