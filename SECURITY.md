# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
<https://github.com/shreyassaw5394/debuganything/security/advisories/new>. Do not open a
public issue. We acknowledge reports within 72 hours and credit reporters in
the advisory unless they prefer otherwise.

## Supported versions

The latest minor release on npm (`debuganything`) and PyPI (`debuganything`) receives
fixes. Older versions: upgrade.

## Threat model

Debug Anything runs **locally, as you**, driven by an AI agent or the CLI. It never runs
`sudo`, never phones home, and only observes. The agent that drives it already
has shell access on the same machine, so Debug Anything does not try to be a sandbox for
the agent; it tries to make *observation* safe and auditable.

What Debug Anything guarantees:

- **No shell.** Every subprocess is spawned with an argv array through execa;
  pids, container names, pod names, session ids and BPF fragments are validated
  against strict patterns before use.
- **Read-only.** No tool kills, signals (see the one exception below), writes
  memory, sets breakpoints or modifies the target.
- **Bounded.** 60 s wall clock per tool (30 s for captures), 50 MB raw output,
  16 KB returned to the agent, imports capped at 50 MB and regular files only.
- **Scoped.** Adapters touch only the attached pid tree or container. Packet
  captures derive their filter from the target's own ports and refuse to run
  unbounded. `capture_traffic` requires explicit consent on every call.
- **Redacted payloads.** Bearer/API/AWS/JWT/Stripe/GitHub/Slack tokens,
  `password=`, private keys and `user:pass@` URLs are scrubbed from everything
  returned to the agent. **Raw artifacts under `~/.debuganything/sessions/` are not
  redacted**; treat that directory as sensitive and prune it.
- **No network.** Debug Anything makes no outbound connections. The only exception is the
  explicit `debuganything update` command (npm).

Known side effects, by design and documented in results:

- `snapshot_memory` / `dump_stacks` on a Node target may send `SIGUSR1` to
  enable Node's inspector on `127.0.0.1:9229`. The inspector stays enabled
  until the process exits and accepts connections from any local user with
  access to that loopback port. Start the target with `--inspect` on a chosen
  port if that matters to you.
- `attach --kind command` spawns the command you name, as you. Treat it like
  running it yourself.
- `debuganything setup` edits agent config files (`~/.claude.json`,
  `~/.claude/settings.json`, `~/.codex/config.toml`, `~/.cursor/mcp.json`,
  `~/.gemini/settings.json`) after showing the diff and keeping a `.bak-debuganything`
  copy. The Claude Code hook it installs reads hook events from stdin, matches
  fixed regexes and prints text; it executes nothing.
- `debuganything import` reads the file you point it at and copies it into the session
  directory.

Out of scope:

- The behavior of the underlying tools (`strace`, `perf`, `tcpdump`, …).
- Prompt injection against the agent itself. Debug Anything's evidence contract makes an
  agent's claims auditable; it does not control what the agent decides to do.

## Supply chain

- npm releases are published by CI from a tag with Sigstore provenance; PyPI
  releases by CI from a tag. No release is built on a laptop.
- `main` is protected: pull request, one code-owner approval, green CI on
  Linux and macOS, squash merge. Workflow tokens are read-only; third-party
  actions are allow-listed.
- Dependabot alerts and security updates, secret scanning with push
  protection, and CodeQL are enabled on the repository. `npm audit` runs in CI.
- Runtime dependencies are five small packages: `@modelcontextprotocol/sdk`,
  `zod`, `execa`, `commander`, `picocolors`. The Python package has none.
