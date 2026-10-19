# Agents use Debug Anything on their own

A tool nobody invokes is useless. Once Debug Anything is set up, agents are expected to
reach for it **without being asked** when a running system misbehaves. Three
layers make that happen.

## 1. The skill says when

`skills/debug-anything/SKILL.md` (installed by `debuganything setup` for Claude Code,
Codex and Gemini CLI, or via `npx skills add shreyassaw5394/debuganything`) has a
"Use it without being asked" table:

| Signal | First move |
|---|---|
| A command the agent ran hangs, or a test times out while the process is alive | `attach`, `dump_stacks` |
| `EADDRINUSE` | `debuganything port <n>` / `inspect_sockets`; report the pid, never kill it |
| `ECONNREFUSED`, `ETIMEDOUT`, `socket hang up` | `inspect_sockets`, `trace_syscalls` (network) |
| `EMFILE` | `inspect_files`, `inspect_sockets` |
| exit 137, `OOMKilled`, heap out of memory | `container_info`, `snapshot_memory` ×2, `diff_runs` |
| segfault / crash loop | `container_info`, then `dump_stacks` + `profile_cpu` on the restarted process |
| user says slow / hang / leak / crash | the matching `dea_*` prompt order |
| the agent just changed performance-sensitive code | measure before/after, `diff_runs`, evidence ids in the PR |

Read-only tools need no permission; `capture_traffic` always needs the
user's consent. The skill also says to keep it proportionate (one or two
tools, then `detach`) and to attach only to the user's own processes.

## 2. The MCP server says so too

The server's `instructions` (what every MCP client shows the model) carry the
same rule: on those signals, attach and measure before proposing a theory,
and re-measure after a fix.

## 3. A hook notices the signal (Claude Code)

`debuganything setup` writes `~/.debuganything/hooks/debuganything-hook.mjs` (dependency-free, ~40 ms) and
registers it in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "node \"~/.debuganything/hooks/debuganything-hook.mjs\"", "timeout": 10 }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node \"~/.debuganything/hooks/debuganything-hook.mjs\"", "timeout": 10 }] }]
  }
}
```

After every Bash command and every user prompt it scans for the signals above
(`EADDRINUSE`, `EMFILE`, `OOMKilled`, `exit 137`, `Timeout`, `SIGSEGV`,
"hangs", "slow", "leak", …) and, only when one matches, adds a short context
note to the model:

```
[Debug Anything] The last command's output shows a runtime problem signal. DEA (Debug Anything) is installed: observe before you theorize.
- port_busy (“EADDRINUSE: address already in use :::3000”): run `debuganything port <port>` … never kill it blindly
Protocol: readiness (once per session) → attach <pid|container|command> → the tool above → detach. Cite evidence ids …
```

It never runs Debug Anything itself, never blocks the tool, and stays silent on normal
output. Disable with `debuganything setup --no-hooks` or by deleting the two entries.
Codex, Cursor and Gemini CLI have no equivalent hook API today; they rely on
layers 1 and 2.

## What "proactive" does not mean

- No background daemons, no polling, no attaching to processes the user did
  not point the agent at. Proactive means *reacting to a signal the agent
  already saw*.
- No mutations. The agent may observe without asking; it must still ask before
  `capture_traffic`, and it must never kill, signal or patch the target.
- No silence. Every proactive observation ends with a one-paragraph summary
  that cites evidence ids and states limitations.
