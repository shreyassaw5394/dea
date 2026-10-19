# Roadmap

Debug Anything's master plan has four steps; v0 is step 1.

1. **Local** — one MCP, one laptop, one process. Evidence over guesses. *(this release)*
2. **Anywhere** — containers, pods, remote hosts over SSH, fleets. Same tools, same contracts.
3. **Always-on** — agents that watch production, notice the regression at 3 am, attach, diagnose, open the PR with the flamegraph attached, and page a human only with proof.
4. **The standard** — the evidence contract (findings must cite evidence) becomes how any tool reports to any agent, so a human can audit an agent's claim in one click.

## Next up

- **bpftrace** canned scripts: syscall latency histograms, fd opens by path, TCP retransmits (`src/adapters/bpftrace.ts` has the scripts; needs the tool wiring).
- **Kubernetes pods** beyond local kubelets: `kubectl debug` ephemeral containers running Debug Anything, results streamed back as the same `ToolResult`.
- **Remote agent mode over SSH**: `debuganything attach user@host:pid`; adapters run remotely, artifacts sync back.
- **Windows**: ETW-based CPU sampling, `procdump` stacks, `handle.exe` for fds.
- **Java**: async-profiler for CPU/alloc, `jcmd Thread.print` for stacks with monitor ownership.
- **Go**: `pprof` endpoints when exposed; `delve` batch stacks with goroutine wait reasons.
- **Rust/C++**: DWARF unwinding (`perf --call-graph dwarf`) and `heaptrack`.
- **eBPF-based tracing** as the default on Linux where available (lower overhead than strace).
- **Python heap**: `tracemalloc` snapshots via `py-spy`-style injection; `memray` integration.
- **Node CPU** via the inspector (`Profiler.start`) so JS frames have names without `--perf-basic-prof`.
- **Deadlock ownership**: parse lock owners (gdb `p *mutex`, py-spy `--locals`) to draw the wait-for graph.
- **Step-debugger handoff**: emit a ready-to-use `mcp-debugger` attach call in `suggested_next`.
- **Evidence export**: signed JSON bundle of a session for audit.

Contributions welcome — see [CONTRIBUTING.md](../CONTRIBUTING.md) for the ~80-line adapter recipe.
