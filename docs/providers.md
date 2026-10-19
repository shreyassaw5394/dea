# Providers

Every adapter declares the binaries it needs; `debuganything readiness` tells you which
are usable on this machine and prints these install hints. Debug Anything never installs
anything itself.

| Provider | Tools | Linux | macOS | Root needed? |
|---|---|---|---|---|
| **lsof** | `inspect_sockets`, `inspect_files`, `debuganything port` | `apt install lsof` / `dnf install lsof` | preinstalled | no (own processes); root to see other users |
| **ps** | `snapshot_memory` (RSS series, all runtimes) | `apt install procps` | preinstalled | no |
| **py-spy** | `profile_cpu`, `dump_stacks`, `snapshot_memory` for Python | `pip install py-spy` | `pip install py-spy` / `brew install py-spy` | Linux: `ptrace_scope=0` or root · macOS: **always sudo** |
| **node-inspector** | `snapshot_memory` (heap retainers), `dump_stacks` (JS main thread) for Node | built in (uses Node's inspector protocol) | built in | no (sends SIGUSR1 to the target to enable the inspector) |
| **strace** | `trace_syscalls` | `apt install strace` | — | `ptrace_scope=0` or root |
| **fs_usage** | `trace_syscalls` on macOS (file + network calls with timing) | — | preinstalled | **yes** — Debug Anything prints the sudo command; then `debuganything import fs_usage <file>` |
| **gdb** | `dump_stacks` native/Node/Go/Java | `apt install gdb` | — | `ptrace_scope=0` or root |
| **lldb** | `dump_stacks` native/Node | — | `xcode-select --install` | own debuggable children, else sudo |
| **perf** | `profile_cpu` native/Node/Go/Java + flamegraph | `apt install linux-perf` (Debian) / `linux-tools-$(uname -r)` (Ubuntu) / `dnf install perf` | — | `perf_event_paranoid ≤ 1` or root |
| **sample** | `profile_cpu` native/Node + flamegraph | — | preinstalled (`/usr/bin/sample`) | no for own processes |
| **tcpdump** | `capture_traffic` (consent) | `apt install tcpdump` | preinstalled | yes (or `setcap cap_net_raw` / `access_bpf` group) |
| **docker** | `container_info`, container → host pid mapping | docker engine | Docker Desktop / Colima / OrbStack | docker group |
| **bpftrace** | *(not implemented in v0)* | `apt install bpftrace` | — | root |

## No root? Capture it yourself, then import

Any provider that needs privileges can be run by you and handed back to Debug Anything with the same parsers and findings:

```bash
sudo strace -f -T -tt -p 1234 -o trace.log          # Linux
sudo fs_usage -w -f filesys,network -p 1234 > fs.txt  # macOS
debuganything import strace trace.log --session $S
debuganything import fs_usage fs.txt --session $S
```

Also accepted: `perf script` output, py-spy `dump` / `record --format raw`, macOS `sample`, `gdb`/`lldb` backtraces, `lsof -nP -F pcufatsinTP`, `tcpdump -nn -tt -r file`.

## Linux one-liner (Debian/Ubuntu)

```bash
sudo apt install -y strace gdb lsof tcpdump procps linux-tools-$(uname -r) && pip install py-spy
```

## macOS one-liner

```bash
xcode-select --install; pip install py-spy
```

`lsof`, `sample`, `lldb` and `tcpdump` are already there.

## Container / Kubernetes notes

- Attaching from the host to a process inside a Docker container works on
  Linux (the container's processes are host processes). On macOS the Docker VM
  hides them: run Debug Anything *inside* the container, or use `container_info` only.
- Containers need `--cap-add SYS_PTRACE` for strace/gdb/py-spy,
  `--cap-add PERFMON` (or `SYS_ADMIN`) for perf, `--cap-add NET_RAW` for tcpdump.
- `docker/linux-lab/Dockerfile` builds an image with every provider for
  running Debug Anything on a Linux target from any host.

## Node symbol names in perf

Start the target with `node --perf-basic-prof app.js` so JIT frames get names
in `perf` flamegraphs. Without it, JS frames show as `[unknown] (node)`;
`profile_cpu` tells you when that happens.
