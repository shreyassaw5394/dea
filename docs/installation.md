# Installation

## Requirements

- Node.js ≥ 22 (Debug Anything itself).
- The observation tools you want: see [providers.md](providers.md). None are
  required to install Debug Anything; `readiness` tells you what is usable.

## Register with your agent (recommended)

```bash
npx debuganything setup
```

`setup` detects Claude Code (`~/.claude.json`), Codex (`~/.codex/config.toml`),
Cursor (`~/.cursor/mcp.json`) and Gemini CLI (`~/.gemini/settings.json`),
shows the exact entry it will add, backs up each file to `*.bak-debuganything`, writes
the MCP server entry, and copies the `debug-anything` skill where the agent
supports skills (Claude Code, Codex, Gemini CLI). Restart the agent afterwards.

Flags: `--yes` (no prompt), `--dry-run`, `--agents claude,cursor`, `--home <dir>`.

## Manual MCP registration

Add this to your agent's MCP config:

```json
{
  "mcpServers": {
    "debuganything": { "command": "npx", "args": ["-y", "debuganything@latest", "serve"] }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.debuganything]
command = "npx"
args = ["-y", "debuganything@latest", "serve"]
```

## CLI only

```bash
npm install --global debuganything
debuganything readiness
```

or without installing: `npx -y debuganything@latest readiness`.

## Update

```bash
debuganything update            # npm install --global debuganything@latest
npx debuganything@latest setup   # refresh registrations after a major version
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

Debug Anything never runs these for you. Inside Docker: `--cap-add SYS_PTRACE` (and
`--cap-add PERFMON` for perf, `--cap-add NET_RAW` for tcpdump).

## macOS

`lsof`, `sample`, `lldb`, `fs_usage` and `tcpdump` ship with the OS; `py-spy` via
`pip install py-spy`. There is no strace or perf on macOS: `trace_syscalls` uses
`fs_usage`, which needs root. Debug Anything never escalates; it prints the command, you run
it, and `debuganything import fs_usage <file> --session <id>` analyzes the output. Attaching
`py-spy`/`lldb` to processes you did not start also needs `sudo` (SIP).

## Windows

Not supported yet. `readiness` returns a clear "not yet". Planned: ETW,
`procdump`, `handle.exe`.
