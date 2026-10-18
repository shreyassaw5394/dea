# Changelog

## 0.1.0 — 2026-10-17

First release: "Observe any running process. No breakpoints, no restarts, no instrumentation."

- **Contracts**: `ToolResult` with findings that must cite evidence ids (enforced by schema), `Evidence` with artifact pointers, `Session`, `Target`, `Readiness`. JSON schemas exported to `docs/mcp-contracts.md`.
- **Tools (14)**: `readiness`, `attach`, `detach`, `list_processes`, `trace_syscalls`, `profile_cpu`, `dump_stacks`, `inspect_sockets`, `inspect_files`, `capture_traffic`, `snapshot_memory`, `diff_runs`, `container_info`, `report` — identical over MCP and CLI (`--json`).
- **Prompts**: `dea_slow`, `dea_leak`, `dea_hang`, `dea_crash`, `dea_port_busy`.
- **Adapters**: lsof, ps, py-spy, Node inspector (heap snapshot retainers + JS stack), strace, gdb, lldb, perf (+ inline flamegraph SVG), macOS `sample`, tcpdump (consent, scoped filter), docker; bpftrace scripts staged (not wired).
- **Safety**: read-only, 60 s / 30 s wall caps, 50 MB raw cap, 16 KB payload cap, no auto-sudo, scoped captures, redaction of secrets in payloads, child cleanup on detach/exit.
- **Setup**: `dea setup` registers the MCP server and the `debug-anything` skill with Claude Code, Codex, Cursor and Gemini CLI (backs up configs, asks first).
- **Examples**: `leaky-node`, `deadlock-py`, `busy-port` with reproducible DEA sessions in `docs/showcases.md`.
- **CLI extras**: `dea why <target> --symptom …` one-command investigation; `dea call <tool> <json>` for scripts/SDKs; `dea port <n>`.
- **Python**: `dea-agents` on PyPI with LangChain, LlamaIndex and CrewAI tool adapters (`python/`).
- **Site**: GitHub Pages landing + docs (`site/`, `.github/workflows/pages.yml`).
- **Linux lab**: `docker/linux-lab` image with every provider for fixture capture and live runs from macOS.
