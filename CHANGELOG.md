# Changelog

## 0.4.0 — 2026-10-19

- **In-browser analyzer** at <https://debuganything.dev/analyze>: paste strace, py-spy, jstack, goroutine, lsof, gdb/lldb, perf, folded, sample or tcpdump output and get the same evidence-backed findings — nothing uploaded. Core refactor: `src/analyze.ts` is the pure analysis entry (`analyzeText`, `detectTool`), shared by `dea import` and the web bundle.
- **Java**: `jstack`/`jcmd Thread.print` live adapter (runtime=java) and `dea import jstack` — JVM-reported deadlocks, circular monitor waits, monitor contention, thread explosions.
- **Go**: `dea import goroutines` for `/debug/pprof/goroutine?debug=2` / SIGQUIT dumps — goroutine leaks by parked site, minutes-stuck goroutines, mutex contention, global stalls.
- **Shareable HTML report**: `dea report --html` / MCP `report {html:true}` — one self-contained file with ranked findings, expandable evidence and embedded flamegraphs.
- **Baseline diffs across sessions**: `diff_runs` accepts `<session_id>:<run>` refs, so a recorded healthy run can be diffed against a broken one.
- **CI hang forensics**: new [dea-action](https://github.com/shreyassaw5394/dea-action) — wrap a CI command; on timeout DEA attaches and uploads stacks, sockets and findings before the kill.
- `dea why` is now the flagship entry point in the README and on the site.

## 0.3.1 — 2026-10-18

- Permission-denied attaches (strace, py-spy, gdb, lldb, perf) now populate `suggested_next` with the `dea import` follow-up and the unprivileged tools that still work, instead of returning empty. (Thanks @Kantorcodes for the question that surfaced it.)

## 0.3.0 — 2026-10-18

- **`dea import <tool> <file>`** / MCP `import_artifact`: analyze output you captured yourself (strace, fs_usage, perf script, folded stacks, py-spy dump, sample, gdb, lldb, lsof -F, tcpdump text) with the same parsers and findings as a live run. Closes the "needs root" gap without DEA ever escalating.
- **`fs_usage` adapter (macOS)**: `trace_syscalls` on a Mac. Runs when root; otherwise prints the exact sudo command and the import step.
- Adapters refactored into run + summarize halves (`summarizeSyscallRecords`, `summarizePySpyDump`, `summarizeCaptureEvidence`).

## 0.2.0 — 2026-10-18

- **Proactive use.** Skill gains a "use it without being asked" table; MCP server instructions tell agents to measure on hang/timeout/EADDRINUSE/EMFILE/OOM/segfault signals; `dea setup` installs a Claude Code hook (`~/.dea/hooks/dea-hook.mjs`, PostToolUse on Bash + UserPromptSubmit) that nudges the model when such a signal appears. `--no-hooks` to skip. `dea hook` subcommand for other integrations.
- `dea init`: project-level setup (.mcp.json, .cursor/mcp.json, AGENTS.md/CLAUDE.md rule) so every teammate's agent gets DEA.
- Docs: `docs/proactive.md`, `docs/real-world.md`, `docs/workflows.md`.

## 0.1.1 — 2026-10-18

- `suggested_next` now includes a static-analysis handoff ("decompile <symbol> in <dso>") for hot native frames and blocked native threads.
- Docs: `docs/examples.md` (10 situations); skill gains step-debugger / static-analysis handoff rules; community links point at GitHub Discussions.
- Python package 0.1.0 on PyPI; CI publishes npm on `v*` tags and PyPI on `py-v*` tags.

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
