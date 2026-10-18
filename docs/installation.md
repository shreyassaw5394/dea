# Installation

## Requirements

- Node.js ≥ 22 (DEA itself).
- The observation tools you want: see [providers.md](providers.md). None are
  required to install DEA; `readiness` tells you what is usable.

## Register with your agent (recommended)

```bash
npx dea-agents setup
```

`setup` detects Claude Code (`~/.claude.json`), Codex (`~/.codex/config.toml`),
Cursor (`~/.cursor/mcp.json`) and Gemini CLI (`~/.gemini/settings.json`),
shows the exact entry it will add, backs up each file to `*.bak-dea`, writes
the MCP server entry, and copies the `debug-anything` skill where the agent
supports skills (Claude Code, Codex, Gemini CLI). Restart the agent afterwards.

Flags: `--yes` (no prompt), `--dry-run`, `--agents claude,cursor`, `--home <dir>`.

## Manual MCP registration

Add this to your agent's MCP config:

```json
{
  "mcpServers": {
    "dea": { "command": "npx", "args": ["-y", "dea-agents@latest", "serve"] }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.dea]
command = "npx"
args = ["-y", "dea-agents@latest", "serve"]
```

## CLI only

```bash
npm install --global dea-agents
dea readiness
```

or without installing: `npx -y dea-agents@latest readiness`.

## Update

```bash
dea update            # npm install --global dea-agents@latest
npx dea-agents@latest setup   # refresh registrations after a major version
```

## Linux permissions

Most tools attach with `ptrace`. Without root you can only attach to processes
you own **and** `kernel.yama.ptrace_scope` must be `0` (default is `1` on
Ubuntu). For the current boot:

```bash
sudo sysctl kernel.yama.ptrace_scope=0
sudo sysctl kernel.perf_event_paranoid=1      # perf on your own processes
sudo setcap cap_net_raw,cap_net_admin=eip "$(which tcpdump)"   # capture without sudo
```

DEA never runs these for you. Inside Docker: `--cap-add SYS_PTRACE` (and
`--cap-add PERFMON` for perf, `--cap-add NET_RAW` for tcpdump).

## macOS

`lsof`, `sample`, `lldb`, `fs_usage` and `tcpdump` ship with the OS; `py-spy` via
`pip install py-spy`. There is no strace or perf on macOS: `trace_syscalls` uses
`fs_usage`, which needs root. DEA never escalates; it prints the command, you run
it, and `dea import fs_usage <file> --session <id>` analyzes the output. Attaching
`py-spy`/`lldb` to processes you did not start also needs `sudo` (SIP).

## Windows

Not supported yet. `readiness` returns a clear "not yet". Planned: ETW,
`procdump`, `handle.exe`.
