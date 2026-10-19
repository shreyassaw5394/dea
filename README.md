<p align="center"><a href="https://debuganything.dev"><img src="https://raw.githubusercontent.com/shreyassaw5394/dea/main/assets/dea-logo.png" alt="DEA — Debug Anything" width="640"></a></p>

# DEA: Debug Anything

**Observe any running process. No breakpoints, no restarts, no instrumentation.**

One MCP server and CLI that gives any coding agent — Claude Code, Codex, Cursor, Gemini CLI — eyes on running software: syscalls, CPU flamegraphs, thread stacks, sockets and file descriptors, packets, heap retainers, container state. Battle-tested local tools (`strace`, `py-spy`, `perf`, `lsof`, `tcpdump`, `gdb`/`lldb`, Node's inspector) do the observing; DEA turns their output into **structured evidence** an agent can reason about and a human can audit.

[![npm](https://img.shields.io/npm/v/dea-agents.svg)](https://www.npmjs.com/package/dea-agents)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![MCP](https://img.shields.io/badge/MCP-server-8A2BE2)](server.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933)](package.json)
[![npm downloads](https://img.shields.io/npm/dm/dea-agents.svg?label=npm%20downloads)](https://www.npmjs.com/package/dea-agents)
[![PyPI downloads](https://img.shields.io/pypi/dm/dea-agents.svg?label=pypi%20downloads)](https://pypi.org/project/dea-agents/)
[![GitHub stars](https://img.shields.io/github/stars/shreyassaw5394/dea.svg?style=flat&label=stars)](https://github.com/shreyassaw5394/dea/stargazers)
[![Discord](https://img.shields.io/badge/discord-join-5865F2)](https://discord.gg/htPuQ5grg)

[Quick start](#quick-start) · [How DEA works](#how-dea-works) · [What you can observe](#what-you-can-observe) · [Showcases](#showcases) · [Workflows](docs/workflows.md) · [Python / LangChain / CrewAI](#python-langchain-llamaindex-crewai) · [Safety](#safety) · [FAQ](#faq) · [Roadmap](#roadmap) · [Community](#community)

```bash
npx dea-agents why <pid>       # or: why api-container --symptom leak
```

One command against any pid, container or pod: attach → the right tools for the symptom (`slow` / `leak` / `hang` / `crash` / `triage`) → **ranked findings, every one citing evidence ids** → detach. Hooking it to your agent instead: `npx dea-agents setup`. No install at all? [Paste tool output in the browser](https://debuganything.dev/analyze).

![DEA finding a Node.js leak: two memory snapshots, a diff, and the retainer named with evidence ids](docs/demo.gif)

> Website: <https://debuganything.dev> · Community: [Discord](https://discord.gg/htPuQ5grg) · [Discussions](https://github.com/shreyassaw5394/dea/discussions) · Only ever download DEA from this repo, the `dea-agents` npm/PyPI packages, or that site.

## Where DEA sits

Step-through debuggers over MCP already exist and are good: [debugmcp/mcp-debugger](https://github.com/debugmcp/mcp-debugger) (7 languages), [microsoft/DebugMCP](https://github.com/microsoft/DebugMCP) (VS Code), [jdwp-mcp](https://github.com/search?q=jdwp-mcp) (Java), [jkolo/debug-mcp](https://github.com/jkolo/debug-mcp) (.NET), [pprof-mcp-agent](https://github.com/search?q=pprof-mcp-agent) (Go). They need a debug adapter, a debug port, or an instrumented/restarted target, and they assume you already know where to put the breakpoint.

DEA is the layer before that: black-box observation of any pid, container or pod with zero instrumentation, turned into evidence.

> **mcp-debugger is for when you know where to put the breakpoint. DEA is for when you don't.**

They are complementary. When DEA localizes a problem to a function or thread, its `suggested_next` includes the handoff: *"attach a step debugger (e.g. mcp-debugger) at `file:function`"* — and, for native symbols, *"decompile `parse_frame` in `libfoo.so` with your static-analysis tool"*. More situations: [docs/examples.md](docs/examples.md).

## Why this exists

Software is written once and runs forever, and most engineering pain is in the running part. Agents just got very good at the writing part. They are still blind to the running part — an agent can read every line of your code and still cannot tell you why the process in front of it is eating 4 GB. Observability vendors solved this for humans with dashboards. Nobody has solved it for agents.

DEA is a sensory layer for software agents. The plan:

1. **Local** — one MCP, one laptop, one process. Evidence over guesses. *(this release)*
2. **Anywhere** — containers, pods, remote hosts over SSH, fleets. Same tools, same contracts.
3. **Always-on** — agents that watch production, notice the regression at 3 am, attach, diagnose, and open the PR with the flamegraph attached, paging a human only with proof.
4. **The standard** — the evidence contract (findings must cite evidence) becomes how any tool reports to any agent, so a human can audit an agent's claim in one click.

Every interface is designed so step-1 code survives to step 4: targets are abstract (`pid` today, `container` and `pod` now, `host` next), adapters are pluggable, and every result has the same evidence schema. Nothing assumes localhost.

## Quick start

### 0. The one-liner

```bash
npx dea-agents why <pid|container|pod>     # symptom flags: --symptom slow|leak|hang|crash
```

`why` is the whole product in one command: it runs readiness, attaches, picks the right observation battery for the symptom, and prints ranked findings with the evidence ids to back them. Everything below is that same engine, wired into your agent.

### 1. Set up your agent

```bash
npx dea-agents setup
```

Detects Claude Code, Codex, Cursor and Gemini CLI, shows the exact config entry it will add, backs up the file, writes it, and installs the `debug-anything` skill where the agent supports skills. Then restart your agent.

**One-click installs:** [![Install MCP Server in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/en/install-mcp?name=dea&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsImRlYS1hZ2VudHNAbGF0ZXN0Iiwic2VydmUiXX0=) [![Install in VS Code](https://img.shields.io/badge/VS_Code-Install_DEA-0098FF?style=flat-square&logo=visualstudiocode&logoColor=white)](https://vscode.dev/redirect/mcp/install?name=dea&config=%7B%22name%22%3A%22dea%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22dea-agents%40latest%22%2C%22serve%22%5D%7D) [![Install in VS Code Insiders](https://img.shields.io/badge/VS_Code_Insiders-Install_DEA-24bfa5?style=flat-square&logo=visualstudiocode&logoColor=white)](https://insiders.vscode.dev/redirect/mcp/install?name=dea&config=%7B%22name%22%3A%22dea%22%2C%22command%22%3A%22npx%22%2C%22args%22%3A%5B%22-y%22%2C%22dea-agents%40latest%22%2C%22serve%22%5D%7D)

Claude Code plugin: `/plugin marketplace add shreyassaw5394/dea` then `/plugin install dea@dea` · Gemini CLI: `gemini extensions install https://github.com/shreyassaw5394/dea` · Skill: `npx skills add shreyassaw5394/dea`


### 2. Ask your agent

> *My API gets slow after a few minutes — attach to it and tell me why, with evidence.*

> *Something is holding port 8080. Who?*

> *This Python worker hangs after ~20 requests. Find out what it is waiting on.*

The agent calls `readiness`, `attach`, then the right tools, and answers with findings that cite evidence ids — or tells you what it could not observe and why.

### 3. No agent? One command

```bash
npx -y dea-agents@latest why 12345 --symptom leak     # or: slow | hang | crash | triage
dea why my-container --symptom crash
dea why -- node server.js                             # spawn it under observation
```

`why` attaches, runs the right tools for the symptom, prints each result, and
ends with a ranked summary and the report path. Skips tools `readiness` says
you cannot run instead of failing.

### 4. Or step by step

```bash
npx -y dea-agents@latest readiness
dea ps --filter node
S=$(dea attach 12345 --json | jq -r .session_id)
dea profile --session $S --duration 10
dea sockets --session $S
dea report  --session $S --md report.md
dea detach  --session $S
dea port 8080                      # who holds a port — no session needed
```

Every command takes `--json` and prints the exact `ToolResult`. See [docs/cli.md](docs/cli.md).

### 5. Set up a repo for the whole team

```bash
cd my-project && dea init     # .mcp.json + .cursor/mcp.json + a rule in AGENTS.md/CLAUDE.md — commit them
```

Every teammate's Claude Code and Cursor now gets DEA from the repo, with the rule telling agents when to use it. Adoption flow day by day: [docs/workflows.md](docs/workflows.md).

### 6. Install as an agent skill

The `debug-anything` skill (investigation orders, evidence rules, consent
etiquette) is installed by `setup` for Claude Code, Codex and Gemini CLI, and
is also available through [skills.sh](https://skills.sh):

```bash
npx skills add shreyassaw5394/dea
```

### 7. Update

```bash
dea update                        # or: npx dea-agents@latest setup
```

## How DEA works

```
agent ──MCP──▶ DEA server ──▶ dispatcher ──▶ adapter (strace | py-spy | perf | lsof | tcpdump | gdb/lldb | inspector | docker)
                                 │                │  build command → run with caps → write raw artifact → parse → aggregate
                                 ▼                ▼
                           ToolResult { findings[] ──cite──▶ evidence[] ──point──▶ artifacts[] }  + limitations + suggested_next
```

- **Sessions.** `attach` resolves a target (pid, container, pod, or a command spawned under capture) into `~/.dea/sessions/<id>/`. Every tool result is saved as a run (`profile_cpu#2`), so `diff_runs` can compare before/after and `report` can assemble the whole investigation.
- **Evidence contract.** A `Finding` without `evidence_ids` is rejected by the schema. `confidence: "inferred"` is allowed but must be stated. Agents only get to claim what the evidence supports. Full schemas: [docs/mcp-contracts.md](docs/mcp-contracts.md).
- **Adapters.** Each declares platforms, required binaries and the tools it serves; `readiness` computes what works on this machine. Parsers are pure functions tested on real captured output. Adding one takes ~80 lines: [CONTRIBUTING.md](CONTRIBUTING.md).
- **Prompts.** `dea_slow`, `dea_leak`, `dea_hang`, `dea_crash`, `dea_port_busy` are guided investigations: the order of tools, what to look for, and the rule to never state a cause without an evidence id.

## What you can observe

New in 0.4: Java thread dumps (`jstack`, live or imported), Go goroutine dumps, a [paste-in browser analyzer](https://debuganything.dev/analyze), shareable HTML reports (`dea report --html`), cross-session baseline diffs (`dea diff --session now '<baseline>:<run>' <run>`), and [CI hang forensics as a GitHub Action](https://github.com/shreyassaw5394/dea-action).


| Target | What DEA returns | Requirements |
|---|---|---|
| **Any process: sockets** (`inspect_sockets`) | listening ports, connections grouped by remote, CLOSE_WAIT / TIME_WAIT / SYN_SENT pileups, fd count vs ulimit | `lsof` — Linux, macOS; no root for your own processes |
| **Any process: files** (`inspect_files`) | fds by type, fd growth over a window, largest open files, deleted-but-open files holding disk | `lsof` — Linux, macOS (deleted-but-open: Linux only) |
| **Any process: memory** (`snapshot_memory`) | RSS/VSZ series, `/proc` status (anon/file/swap/threads) | `ps` — Linux, macOS |
| **Node.js: heap** (`snapshot_memory`) | V8 heap snapshot, bytes by type and constructor, top retainers by retained size with retaining path (`Context.retained`, `Map.table`…) | Node's inspector (enabled via `SIGUSR1` if needed) — Linux, macOS |
| **Node.js: JS stack** (`dump_stacks`) | main-thread JS call frames, idle vs blocked event loop | Node's inspector — Linux, macOS |
| **Python: CPU** (`profile_cpu`) | top frames by self/total time, hottest stacks, `flamegraph.svg` | `py-spy` — Linux (`ptrace_scope=0` or root), macOS (sudo) |
| **Python: threads** (`dump_stacks`) | every thread's stack, blocked threads classified as lock / join / sleep / I/O using the source line (`with lock_b:`), deadlock detection | `py-spy` — Linux, macOS (sudo) |
| **macOS: file + network syscalls** (`trace_syscalls`) | per-call timing, blocked calls, errno (ENOENT, ECONNREFUSED…) via `fs_usage`; needs root, so DEA prints the sudo command and you `dea import fs_usage <file>` | `fs_usage` — macOS, preinstalled |
| **Anything you captured yourself** (`dea import`) | strace, fs_usage, perf script, py-spy, sample, gdb/lldb, lsof, tcpdump text → same evidence and findings as a live run. The answer to "needs root" | — |
| **Linux: syscalls** (`trace_syscalls`) | top syscalls by total time and count, slowest calls with paths/addresses, error counts (ENOENT, EAGAIN, ECONNREFUSED…), share of time in blocking waits | `strace` — Linux; `ptrace_scope=0` or root |
| **Native / Node / Go / Java: CPU** (`profile_cpu`) | perf sampling → folded stacks → `flamegraph.svg` (no Perl), idle vs work split | `perf` — Linux (`perf_event_paranoid ≤ 1` or root); Node needs `--perf-basic-prof` for JIT names |
| **Native / Node: CPU on macOS** (`profile_cpu`) | `sample` call graph → folded stacks → flamegraph | `sample` — macOS, preinstalled |
| **Native / Node / Go / Java: threads** (`dump_stacks`) | all thread backtraces, threads in mutex waits vs condition waits vs blocking I/O, deadlock heuristic | `gdb` — Linux; `lldb` — macOS |
| **Network** (`capture_traffic`, consent) | per-remote packets/bytes, RSTs, unanswered SYNs, probable retransmits, DNS queries, `.pcap` artifact; filter derived from the target's own ports, never unbounded | `tcpdump` — Linux, macOS; root / `CAP_NET_RAW` / `access_bpf` |
| **Docker container** (`container_info`) | state, OOMKilled, exit code, restarts, memory/CPU limits vs usage, cgroup throttling and OOM events, published ports, error lines in the log tail; container → host pid mapping for every other tool | `docker` — Linux (host pid visible), macOS (`container_info` only) |
| **Kubernetes pod** (`attach ns/pod`) | resolves the pod's container to a local pid when the kubelet runs on this host (kind, minikube, k3s) | `kubectl` — experimental |
| **Port in use** (`dea port N`) | pid, command line and user holding the port, or TIME_WAIT/CLOSE_WAIT leftovers | `lsof` |
| **Before/after** (`diff_runs`) | what grew, shrank, appeared or disappeared between two runs of the same tool | — |
| Windows | not yet — `readiness` says so | planned: ETW, procdump |

Honest status: everything above was run live on Linux (Debian 12 container, root) and macOS 15 (own processes, no sudo) against the example apps. `bpftrace` scripts are staged but not wired to a tool yet. Install commands per OS: [docs/providers.md](docs/providers.md).

## Examples

**Real-world situations** — CLOSE_WAIT pileups and EMFILE, disk full but `du` disagrees, Postgres pool exhaustion, a Celery deadlock, a blocked Node event loop, OOMKilled pods, DNS on every request, EADDRINUSE after a crash, a native hot spot you cannot read — each with the session, the evidence and the fix: [docs/real-world.md](docs/real-world.md).

Ten copy-paste situations — slow API, leak, hang, port in use, container crash, spawn-under-observation, prove-the-fix, CI regression gate, consented packet capture, Python agents — are in [docs/examples.md](docs/examples.md).

## Showcases

Reproducible with `examples/`. Full transcripts in [docs/showcases.md](docs/showcases.md); a complete report DEA wrote itself is in [docs/example-report-leaky-node.md](docs/example-report-leaky-node.md).

**leaky-node** — HTTP server that keeps every request body alive in a module-level array, plus a `/slow` route doing `readFileSync` in a loop and an 800 ms timer.
`snapshot_memory` ×2 + `diff_runs`: RSS 85 → 172 MB (+102 %), heap 37 → 97 MB, the top retainer is an `Array` whose retained size grew 17 → 47 MB. `trace_syscalls` (8 s): 5 600 `openat`/`statx` lookups and 3 314 `read()` calls — "sync I/O in a loop", and `epoll_pwait` sleeping ~800 ms at a time.

**deadlock-py** — threaded server that takes two locks in opposite order after request 20.
`dump_stacks`: `worker-ab-20` blocked at `app.py:26` `[with lock_b:]`, `worker-ba-20` blocked at `app.py:33` `[with lock_a:]`, eight request threads joined on them, no thread running → "likely deadlock", with the handoff to a step debugger at `worker_ab`.

**busy-port** — a process holding `:8080` and a script failing with `EADDRINUSE`.
`dea port 8080`: `port 8080 is held by pid 47508 (node, user shreyassawant) in LISTEN — command: node server.js. DEA will not kill it; decide yourself.`

## Agents use it without being asked

Once installed, agents are told to reach for DEA on their own: when a command they ran hangs, a test times out, output shows `EADDRINUSE` / `ECONNREFUSED` / `EMFILE` / exit 137 / OOM / segfault, a server they started does not respond, or you mention slow, hang, leak or crash. For Claude Code, `setup` also installs a tiny hook that spots those signals in command output and prompts and nudges the model toward the right DEA tool. Read-only observation needs no permission; `capture_traffic` always does. Details and the off switch (`--no-hooks`): [docs/proactive.md](docs/proactive.md).

## Python, LangChain, LlamaIndex, CrewAI

```bash
pip install dea-agents                 # plain client (no deps; uses npx under the hood)
pip install 'dea-agents[langchain]'    # dea_agents.langchain.dea_tools()
pip install 'dea-agents[llamaindex]'   # dea_agents.llamaindex.dea_tools()
pip install 'dea-agents[crewai]'       # dea_agents.crewai.dea_tools()
```

```python
from dea_agents import DEA
dea = DEA()
s = dea.attach(12345)
print(DEA.findings(dea.profile_cpu(s, duration_s=10)))
dea.detach(s)
```

Each adapter exposes the same 14 tools with the same `ToolResult`. Frameworks
with native MCP support can skip the package and run `npx -y dea-agents serve`.
Details: [python/README.md](python/README.md).

## Why not just ask the agent to debug?

Because today it cannot. Agents cannot attach to a process; they fumble `strace`/`perf`/`lsof` syntax and flags; a 10 s strace is 1.5 MB of text that blows the context window; and when they cannot measure, they guess — confidently. DEA gives them eyes (the right tool, the right flags, inside hard caps) and evidence (summaries that point to raw artifacts, findings that must cite them). You get a diagnosis you can audit instead of a plausible story.

## Safety

- **Read-only.** v0 tools only observe. No kill, no breakpoints, no probes that modify behavior. Documented exception: Node targets may receive `SIGUSR1` to enable the inspector.
- **Consent.** `capture_traffic` requires `consent: true`; the skill tells agents to ask you first.
- **Hard caps.** 60 s per tool (30 s for captures), 50 MB raw output on disk, 16 KB returned to the agent (summaries + pointers; cited evidence is never dropped). Every child is killed with SIGTERM then SIGKILL.
- **No sudo, ever.** If a tool needs root you get `ok: false` and the exact command you could run yourself. `readiness` reports `ptrace_scope`, `perf_event_paranoid`, SIP and `sudo -n` status up front.
- **Scoped.** Adapters touch only the attached pid tree or container. Captures are filtered to the target's ports and refuse to run unbounded.
- **Secrets.** Bearer tokens, AWS keys, JWTs, `password=`, API keys, private keys and `user:pass@` URLs are redacted in everything returned to the agent. **Raw artifacts on disk are not redacted** — treat `~/.dea/sessions/` as sensitive.
- **No cloud. No telemetry.** DEA makes no network calls of its own. Everything stays on your machine.

Details: [docs/safety.md](docs/safety.md) · [DISCLAIMER.md](DISCLAIMER.md) · [SECURITY.md](SECURITY.md)

## FAQ

**Which agents work?** Anything that speaks MCP over stdio. `setup` knows Claude Code, Codex, Cursor and Gemini CLI; for others add `{"command":"npx","args":["-y","dea-agents@latest","serve"]}` to the MCP config ([docs/installation.md](docs/installation.md)).

**Do I need to install strace / perf / py-spy?** Only for the tools you want. `readiness` lists what is usable and prints install hints. `lsof`, `ps` and Node's inspector work out of the box on Linux and macOS.

**Does it need root?** Not for your own processes on macOS (`lsof`, `sample`, `lldb`, inspector) or on Linux with `ptrace_scope=0`. `py-spy` and `fs_usage` on macOS and `tcpdump` everywhere do; DEA prints the exact `sudo` command, you run it, and `dea import <tool> <file>` analyzes the output with the same parsers.

**What can't it see on macOS?** There is no strace or perf. `fs_usage` (via import) covers file and network calls; `sample`, `lldb`, `lsof` and the Node inspector cover the rest. For the full syscall and kernel-time picture, run the target in a Linux container (`docker/linux-lab`).

**Does DEA upload anything?** No. No network calls, no telemetry, no update checks except the explicit `dea update`.

**Can it debug a Docker container?** On Linux, yes — attach by container name and every tool works through the host pid. On macOS the Docker VM hides pids, so only `container_info` works from the host; run DEA inside the container instead (`docker/linux-lab` has an image with every provider).

**How is this different from a step debugger?** DEA never stops your program at a line. It samples, traces and snapshots a running process and tells you *where* to look. Then hand off to `mcp-debugger` or your IDE to look *inside*.

**Where are the artifacts?** `~/.dea/sessions/<id>/` (`DEA_HOME` to override). `dea sessions list` / `dea sessions prune`.

## Roadmap

bpftrace canned scripts · Kubernetes pods via ephemeral debug containers · Windows (ETW, procdump) · Java (async-profiler, `jcmd Thread.print`) · Go (`pprof`, delve goroutine dumps) · Rust/C++ DWARF unwinding · eBPF-first tracing on Linux · Python `tracemalloc`/`memray` · Node CPU via inspector `Profiler` · lock-owner graphs · remote agent mode over SSH. Full list: [docs/roadmap.md](docs/roadmap.md).

## Community

- **Discord:** <https://discord.gg/htPuQ5grg> — questions, show-and-tell, help reading a session.
- **Discussions:** <https://github.com/shreyassaw5394/dea/discussions> — longer-form ideas and RFCs.
- **Issues:** bugs and adapter requests via the templates. **Discussions** for ideas.
- **Security:** private advisories only, see [SECURITY.md](SECURITY.md).

## Contributing

`main` is protected: every change is a pull request reviewed by a code owner.
An adapter is ~80 lines: declare `platforms`/`requires`/`tools`, build the command, run it through `runCapped`, parse with a pure function, emit evidence and findings through `ResultBuilder` (which refuses findings without evidence). Capture the real tool output once into `tests/fixtures/` and test the parser on it. Recipe in [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributors

Everyone who has landed a pull request. Add an adapter, a fixture or a doc and your face shows up here.

<a href="https://github.com/shreyassaw5394/dea/graphs/contributors"><img src="https://contrib.rocks/image?repo=shreyassaw5394/dea" alt="contributors"></a>

Numbers across npm, PyPI, GitHub and the MCP Registry: `bash scripts/stats.sh`.

## License and disclaimer

MIT — see [LICENSE](LICENSE). DEA is provided **"as is", without warranty of any kind**; the authors and contributors accept **no liability** for outages, data exposure, or any other damage arising from its use. DEA attaches observation tools to running software: **only observe systems you own or are explicitly authorized to debug** — you are solely responsible for authorization and for complying with applicable laws and policies. Observation is not free (ptrace pauses targets; captures and heap dumps can contain secrets), findings are automated diagnostics rather than professional advice, and DEA is an independent project developed by its contributors in their personal capacities, unaffiliated with any employer or with the third-party tools it orchestrates. Full terms: [DISCLAIMER.md](DISCLAIMER.md).
