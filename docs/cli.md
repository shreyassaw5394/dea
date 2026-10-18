# CLI

The CLI mirrors the MCP tools 1:1. Add `--json` to any command to get the exact
`ToolResult` (see [mcp-contracts.md](mcp-contracts.md)); human output is a
compact table with colored severities.

```
dea setup [--yes] [--dry-run] [--agents claude,codex,cursor,gemini]
dea readiness                              # alias: doctor
dea ps [--filter name] [--limit n]         # alias: list-processes
dea attach <pid|container|ns/pod>          # prints a session id
dea attach -- node server.js               # spawn under capture (kind=command)
dea trace    --session S [--duration 10] [--categories network,file,process,signal,memory,all]
dea profile  --session S [--duration 15]
dea stacks   --session S
dea sockets  --session S
dea files    --session S [--window 3]
dea capture  --session S [--duration 10] [--filter 'tcp'] --consent
dea memory   --session S [--no-heap] [--window 3]
dea diff     --session S <a> <b>           # run ids like snapshot_memory#1, or ordinals
dea container --session S
dea report   --session S [--md out.md]
dea detach   --session S
dea why <target> [--symptom slow|leak|hang|crash|triage] [--wait 15] [--duration 10]   # one-command investigation
dea call <tool> '<json args>'              # any tool, raw ToolResult (used by the Python SDK)
dea port <port>                            # who holds a port (no session)
dea sessions list | prune [--days 7] [--all]
dea serve                                  # MCP server over stdio (alias: mcp)
dea update
```

Exit code is 1 when the result has `ok: false`.

## More examples

See [examples.md](examples.md) for eleven situations and [with-rea.md](with-rea.md) for static + runtime workflows.

## Example: leaky-node showcase

```bash
cd examples/leaky-node && npm start &          # prints pid
S=$(dea attach <pid> --json | jq -r .session_id)
dea memory --session $S
npm run load -- 300                            # exercise /work
dea memory --session $S
dea diff --session $S snapshot_memory#2 snapshot_memory#3
dea profile --session $S --duration 10         # while hitting /slow
dea report --session $S --md report.md
dea detach --session $S
```

Run ids are `<tool>#<n>` where `n` is the run's ordinal within the session
(attach is `#1`). `dea sessions list` shows every session; artifacts live under
`~/.dea/sessions/<id>/` (override with `DEA_HOME`).
