# Safety

Debug Anything observes. It does not change the target. These guards are implemented in
`src/safety.ts` and used by every adapter.

## Read-only by default

No v0 tool kills, signals (except the two documented below), writes memory,
sets breakpoints, or installs probes that modify behavior. Any future mutating
tool goes through the `consent` mechanism **and** a design discussion.

Documented side effects:

- `snapshot_memory` / `dump_stacks` on a Node target may send **SIGUSR1** to
  enable Node's inspector when it is not already listening. This is Node's
  documented mechanism; the inspector stays on until the process exits. The
  result's `limitations` says so.
- `ptrace`-based tools (`strace`, `gdb`, `lldb`, `py-spy`) stop the target
  briefly while attaching/reading. `dump_stacks` typically pauses for < 1 s.

## Consent

`capture_traffic` requires `consent: true`. The skill instructs agents to ask
the user before passing it. Packet captures can contain secrets.

## Hard caps

| Cap | Value |
|---|---|
| Wall clock per tool | 60 s (`capture_traffic`: 30 s) |
| Raw output written to disk | 50 MB, then the child is killed |
| Payload returned to the agent | 16 KB (summaries + pointers; cited evidence is never dropped) |
| Subprocess kill | SIGTERM, then SIGKILL after 2 s |

Every subprocess runs through `runCapped()` with execa — never a shell. Pids,
container names and filters are validated against strict patterns.

## Privilege

Debug Anything never runs `sudo`. If a tool needs root, the result is `ok: false` with a
`limitations` entry containing the exact command you could run yourself.
`readiness` reports `ptrace_scope`, `perf_event_paranoid`, capabilities, SIP
and `sudo -n` status up front.

## Scoping

Adapters only touch the attached pid tree (pid + descendants at attach time)
or the attached container. `capture_traffic` derives its BPF filter from the
target's sockets and refuses to run if it cannot find any — there is no
unbounded capture.

## Cleanup

`detach` and process exit kill all tracked children and stop captures.
Artifacts persist under `~/.debuganything/sessions/<id>/`; `debuganything sessions prune` removes
detached sessions older than 7 days (`--all` for everything).

## Secrets

Everything returned to the agent (evidence summaries, data, findings, report)
passes through `redact()`: Bearer tokens, AWS keys, JWTs, `password=`,
`api_key=`, Stripe/GitHub/Slack tokens, private keys, and `user:pass@` in
URLs. **Raw artifacts on disk are not redacted** — `.pcap`, `.heapsnapshot`
and strace logs can contain secrets. Treat the sessions directory as sensitive.

## Proactive hook

`debuganything setup` registers a Claude Code hook that reads command output and prompts *locally*, matches a fixed list of regexes, and prints a context note. It runs no Debug Anything tool, sends nothing anywhere, and can be removed with `--no-hooks`. See [proactive.md](proactive.md).

## No cloud, no telemetry

Debug Anything makes no network calls of its own. The only outbound action is the explicit
`debuganything update` command (npm). Nothing leaves your machine unless you send it.
