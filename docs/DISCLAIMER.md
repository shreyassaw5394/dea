# Disclaimer and responsible use

DEA ("Debug Anything") attaches observation tools (`strace`, `py-spy`, `perf`,
`lsof`, `tcpdump`, `gdb`, `lldb`, heap snapshots, and others) to running
software and reports what it sees.

**Only observe systems you own or are explicitly authorized to debug.**
Attaching a tracer, profiler, debugger or packet capture to a process you are
not authorized to inspect may be illegal in your jurisdiction and may violate
your employer's or provider's policies. You are responsible for obtaining that
authorization before running Debug Anything.

Observation is not free:

- `ptrace`-based tools (`strace`, `gdb`, `py-spy` in some modes) pause the
  target for short periods and can slow it down measurably.
- Packet captures and heap snapshots can contain secrets. Debug Anything redacts obvious
  tokens in the excerpts it returns to the agent, but **raw artifacts on disk
  are not redacted**. Treat `~/.debuganything/sessions/` as sensitive.
- Profilers and tracers on production systems should be run with the same care
  you would apply doing it by hand.

Debug Anything is provided "as is", without warranty of any kind. The authors are not
responsible for outages, data exposure or any other damage resulting from its
use. See [LICENSE](LICENSE) for the full terms.

Debug Anything is read-only by default and never escalates privileges on its own. See
[docs/safety.md](docs/safety.md) for the full list of guards.
