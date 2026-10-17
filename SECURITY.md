# Security policy

## Reporting a vulnerability

Please email the maintainers (see `package.json` → `author`/`bugs`) or open a
GitHub security advisory at
<https://github.com/shreyassaw5394/dea/security/advisories/new>.
Do not open a public issue for security problems.

We aim to acknowledge reports within 72 hours.

## Scope

In scope:

- Privilege escalation through DEA (DEA must never run anything as root on its own).
- Escaping the attached target scope (reading another process's data, unbounded captures).
- Secret leakage in payloads returned to the agent (redaction bypass).
- Command injection via tool arguments (pids, container names, filters, durations).
- Unsafe writes outside `~/.dea/` or outside the agent config files `dea setup` declares.

Out of scope:

- The behavior of the underlying tools themselves (`strace`, `perf`, `tcpdump`, ...).
- Contents of raw artifacts on disk — they are documented as unredacted.

## Design notes

See [docs/safety.md](docs/safety.md). DEA has no network component, no
telemetry and no update check beyond the explicit `dea update` command.
