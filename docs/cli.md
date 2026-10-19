# CLI

The CLI mirrors the MCP tools 1:1. Add `--json` to any command to get the exact
`ToolResult` (see [mcp-contracts.md](mcp-contracts.md)); human output is a
compact table with colored severities.

```
debuganything setup [--yes] [--dry-run] [--agents claude,codex,cursor,gemini]
debuganything init [--dir p] [--dry-run]             # project-level: .mcp.json, .cursor/mcp.json, AGENTS.md/CLAUDE.md rule
debuganything readiness                              # alias: doctor
debuganything ps [--filter name] [--limit n]         # alias: list-processes
debuganything attach <pid|container|ns/pod>          # prints a session id
debuganything attach -- node server.js               # spawn under capture (kind=command)
debuganything trace    --session S [--duration 10] [--categories network,file,process,signal,memory,all]
debuganything profile  --session S [--duration 15]
debuganything stacks   --session S
debuganything sockets  --session S
debuganything files    --session S [--window 3]
debuganything capture  --session S [--duration 10] [--filter 'tcp'] --consent
debuganything memory   --session S [--no-heap] [--window 3]
debuganything diff     --session S <a> <b>           # run ids like snapshot_memory#1, or ordinals
debuganything container --session S
debuganything report   --session S [--md out.md]
debuganything detach   --session S
debuganything why <target> [--symptom slow|leak|hang|crash|triage] [--wait 15] [--duration 10]   # one-command investigation
debuganything import <tool> <file> --session S [--duration s]   # analyze output you captured yourself: strace | fs_usage | perf_script | folded | pyspy_dump | sample | gdb | lldb | lsof | tcpdump
debuganything call <tool> '<json args>'              # any tool, raw ToolResult (used by the Python SDK)
debuganything port <port>                            # who holds a port (no session)
debuganything sessions list | prune [--days 7] [--all]
debuganything serve                                  # MCP server over stdio (alias: mcp)
debuganything update
```

Exit code is 1 when the result has `ok: false`.

## More examples

See [examples.md](examples.md) for ten situations, [real-world.md](real-world.md) for incident patterns and [workflows.md](workflows.md) for team adoption.

## Example: leaky-node showcase

```bash
cd examples/leaky-node && npm start &          # prints pid
S=$(debuganything attach <pid> --json | jq -r .session_id)
debuganything memory --session $S
npm run load -- 300                            # exercise /work
debuganything memory --session $S
debuganything diff --session $S snapshot_memory#2 snapshot_memory#3
debuganything profile --session $S --duration 10         # while hitting /slow
debuganything report --session $S --md report.md
debuganything detach --session $S
```

Run ids are `<tool>#<n>` where `n` is the run's ordinal within the session
(attach is `#1`). `debuganything sessions list` shows every session; artifacts live under
`~/.debuganything/sessions/<id>/` (override with `DEA_HOME`).
