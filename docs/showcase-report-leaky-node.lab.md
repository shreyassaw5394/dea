# DEA session 20261017-222831-8528cd

- **Target:** pid `25` (pid 25, node) — runtime node
- **Host:** local (linux)
- **Created:** 2026-10-17T22:28:31.804Z
- **Runs:** 10 · **Artifacts dir:** `/dea/.lab-dea/sessions/20261017-222831-8528cd`

## Findings

- 🔴 **HIGH** vp_notify accounts for 20% of self time (20% inclusive)  
  _observed_ · profile_cpu#4 · evidence: `profile_cpu#4/e1`, `profile_cpu#4/e2`
  Hot path: fuse_file_put ← fuse_simple_request ← queue_request_and_unlock ← virtio_fs_wake_pending_and_unlock ← virtio_fs_enqueue_req ← vp_notify. Handoff: attach a step debugger (e.g. mcp-debugger) at vp_notify.
- 🔴 **HIGH** heap_summary: name=heap_total grew 15.0 MB → 89.5 MB (and 9 more grew)  
  _observed_ · diff_runs#10 · evidence: `diff_runs#10/e3`, `diff_runs#10/e1`
- 🔴 **HIGH** heap_retainer: name=Array grew 14.4 MB → 88.9 MB (and 2 more grew)  
  _observed_ · diff_runs#10 · evidence: `diff_runs#10/e4`, `diff_runs#10/e1`
- 🟠 **WARN** Array (object) retains 14.4 MB = 96% of the heap, held by FixedCircularBuffer.list  
  _observed_ · snapshot_memory#2 · evidence: `snapshot_memory#2/e6`, `snapshot_memory#2/e4`
  Take another snapshot_memory after load and diff_runs: if this retainer grows, it is the leak.
- 🟠 **WARN** 4800 path lookups (open/stat) in 8s — filesystem churn (missing cache? module resolution per request?)  
  _inferred_ · trace_syscalls#3 · evidence: `trace_syscalls#3/e1`
- 🟠 **WARN** 2655 read() calls in 8s (avg 0.076 ms) — many small reads; sync I/O in a loop?  
  _inferred_ · trace_syscalls#3 · evidence: `trace_syscalls#3/e1`
- 🟠 **WARN** slowest single call: epoll_pwait(15, [], 1024, 800, NULL, 8) took 807.259 ms  
  _observed_ · trace_syscalls#3 · evidence: `trace_syscalls#3/e2`
- 🟠 **WARN** ≈27 probable retransmissions — packet loss or a slow peer  
  _inferred_ · capture_traffic#8 · evidence: `capture_traffic#8/e2`
- 🟠 **WARN** Array (object) retains 88.9 MB = 99% of the heap, held by FixedCircularBuffer.list  
  _observed_ · snapshot_memory#9 · evidence: `snapshot_memory#9/e6`, `snapshot_memory#9/e4`
  Take another snapshot_memory after load and diff_runs: if this retainer grows, it is the leak.
- 🟠 **WARN** name=rss grew 72.5 MB → 173.3 MB (+139%)  
  _observed_ · diff_runs#10 · evidence: `diff_runs#10/e2`, `diff_runs#10/e1`
- 🟠 **WARN** name=rss_series grew 74212 → 177456 (+139%)  
  _observed_ · diff_runs#10 · evidence: `diff_runs#10/e2`, `diff_runs#10/e1`
- 🔵 **INFO** session 20261017-222831-8528cd attached to pid 25 (node, runtime node)  
  _observed_ · attach#1 · evidence: `attach#1/e1`
- 🔵 **INFO** RSS 72.5 MB, stable over 2s  
  _observed_ · snapshot_memory#2 · evidence: `snapshot_memory#2/e1`, `snapshot_memory#2/e2`
- 🔵 **INFO** epoll_pwait dominates: 6368.737 ms over 276 calls (90% of kernel time) — blocking wait, the process is waiting on something  
  _observed_ · trace_syscalls#3 · evidence: `trace_syscalls#3/e1`, `trace_syscalls#3/e2`
- 🔵 **INFO** Node main thread was idle in the event loop (first JS tick after 382 ms was processTimers in (internal)) — not stuck in JS; if callers hang, the work is pending on I/O or timers (inspect_sockets, trace_syscalls)  
  _inferred_ · dump_stacks#5 · evidence: `dump_stacks#5/e1`
- 🔵 **INFO** listening on TCP/3000, TCP/9229  
  _observed_ · inspect_sockets#6 · evidence: `inspect_sockets#6/e1`
- 🔵 **INFO** 30 fds open, dominated by a_inode  
  _observed_ · inspect_files#7 · evidence: `inspect_files#7/e1`
- 🔵 **INFO** RSS 173.3 MB, stable over 2s  
  _observed_ · snapshot_memory#9 · evidence: `snapshot_memory#9/e1`, `snapshot_memory#9/e2`

## Runs

### attach#1 — ok (2 ms)

| id | kind | summary | source |
|---|---|---|---|
| e1 | process | attached to pid 25: pid=25 comm=node runtime=node children=0 |  |

_Suggested next:_ inspect_sockets, inspect_files, dump_stacks, profile_cpu, snapshot_memory, trace_syscalls, detach

### snapshot_memory#2 — ok (2908 ms)

| id | kind | summary | source |
|---|---|---|---|
| e1 | metric | rss=72.5 MB vsz=10.80 GB cpu=3.1% (1 pid) | `20261017T222834-snapshot_memory-mem-samples.json` |
| e2 | metric_series | rss 67.2 MB → 72.5 MB over 2s (5 samples) | `20261017T222834-snapshot_memory-mem-samples.json` |
| e3 | metric | proc status: HWM=72.5 MB anon=26.5 MB file=46.0 MB swap=0 B threads=7 |  |
| e4 | heap_summary | heap 15.0 MB in 88923 objects; by type: string 4.4 MB, native 4.0 MB, code 3.5 MB, array 963.8 KB | `20261017T222834-snapshot_memory-heap.heapsnapshot` |
| e5 | heap_summary | by constructor (self size): (string) 4.4 MB×16434, (native) 4.0 MB×262, (code) 3.5 MB×34468, (object shape) 778.6 KB×8703,  498.1 KB×2114 | `20261017T222834-snapshot_memory-heap.heapsnapshot` |
| e6 | heap_retainer | top retainers: Array (object) retains 14.4 MB via FixedCircularBuffer.list; Object (object) retains 14.4 MB via system / Context.primordials; Array (object) retains 14.4 MB via system / Context.builtinIds; Object (object) retains 14.4 MB via system / Context.optionsDict | `20261017T222834-snapshot_memory-heap.heapsnapshot` |

**Limitations:**
- RSS sampled 5× over 2s via ps; no allocation-site attribution for runtime node
- sent SIGUSR1 to pid 25 to activate Node's inspector on 127.0.0.1:9229 (it stays enabled until the process exits)
- heap snapshot: 84 chunks, 8 MB JSON
- retained sizes are a reachability approximation (shared subgraphs are over-counted); open the .heapsnapshot in Chrome DevTools for exact dominator-tree numbers

**Artifacts:**
- `/dea/.lab-dea/sessions/20261017-222831-8528cd/artifacts/20261017T222834-snapshot_memory-mem-samples.json` (json, 434 bytes)
- `/dea/.lab-dea/sessions/20261017-222831-8528cd/artifacts/20261017T222834-snapshot_memory-heap.heapsnapshot` (heapsnapshot, 8542765 bytes)

_Suggested next:_ snapshot_memory (again, after load), diff_runs

### trace_syscalls#3 — ok (8066 ms)

| id | kind | summary | source |
|---|---|---|---|
| e1 | syscall_stat | 10321 syscalls, 7101.703 ms inside the kernel over 8s; top by time: epoll_pwait 6368.737ms×276, openat 256.582ms×2400, read 200.945ms×2655, close 181.466ms×2402, statx 80.946ms×2400 | `20261017T222835-trace_syscalls-strace.log` |
| e2 | syscall_slow | slowest: epoll_pwait(15, [], 1024, 800, NULL, 8) 807.259ms; epoll_pwait(15, [], 1024, 800, NULL, 8) 806.411ms; epoll_pwait(15, [], 1024, 799, NULL, 8) 801.557ms | `20261017T222835-trace_syscalls-strace.log` L6800–6800 |
| e3 | syscall_error | no failing syscalls | `20261017T222835-trace_syscalls-strace.log` |
| e4 | metric | 93% of kernel time in blocking waits (futex/poll/epoll/read/recv/nanosleep) |  |

**Limitations:**
- traced 8s only (%file,%desc,%network); strace adds overhead to every syscall — latencies are inflated

**Artifacts:**
- `/dea/.lab-dea/sessions/20261017-222831-8528cd/artifacts/20261017T222835-trace_syscalls-strace.log` (raw_text, 1262671 bytes)

_Suggested next:_ profile_cpu, inspect_sockets, inspect_files

### profile_cpu#4 — ok (9508 ms)

| id | kind | summary | source |
|---|---|---|---|
| e1 | frame_hot | top self: vp_notify 20%, node::fs::Open 6.7%, v8::internal::ThreadIsolation::JitPageReference::UnregisterRange 6.7%, v8::internal::BinarySearch<(v8::internal::SearchMode)1, v8::internal::Descriptor 6.7%, sg_init_one 6.7% (15 samples over 8s) | `20261017T222852-profile_cpu-flamegraph.svg` |
| e2 | stack | hottest stack (13.3%): queue_request_and_unlock ← virtio_fs_wake_pending_and_unlock ← virtio_fs_enqueue_req ← vp_notify | `20261017T222852-profile_cpu-flamegraph.svg` |
| e3 | metric | 15 samples, ~0% in idle/wait frames |  |

**Limitations:**
- 92 stack frames have no symbols — start Node with --perf-basic-prof (or --perf-prof) so JIT frames get names
- perf samples at 99 Hz with frame-pointer unwinding; frames may be missing in code built without frame pointers (use --call-graph dwarf manually for those)
- sampled 8s only; perf sampling

**Artifacts:**
- `/dea/.lab-dea/sessions/20261017-222831-8528cd/artifacts/20261017T222843-profile_cpu-perf.data` (raw_text, 42020 bytes)
- `/dea/.lab-dea/sessions/20261017-222831-8528cd/artifacts/20261017T222852-profile_cpu-perf-script.txt` (raw_text, 35815 bytes)
- `/dea/.lab-dea/sessions/20261017-222831-8528cd/artifacts/20261017T222852-profile_cpu-perf-folded.txt` (folded_stacks, 12870 bytes)
- `/dea/.lab-dea/sessions/20261017-222831-8528cd/artifacts/20261017T222852-profile_cpu-flamegraph.svg` (flamegraph_svg, 43807 bytes)

_Suggested next:_ trace_syscalls, dump_stacks, inspect_sockets

### dump_stacks#5 — ok (447 ms)

| id | kind | summary | source |
|---|---|---|---|
| e1 | stack | main thread (pause latency 382 ms): processTimers@(internal):507 | `20261017T222853-dump_stacks-node-stack.txt` |

**Limitations:**
- JS main thread only; worker threads and libuv threadpool are not shown (use gdb/lldb for native threads)

**Artifacts:**
- `/dea/.lab-dea/sessions/20261017-222831-8528cd/artifacts/20261017T222853-dump_stacks-node-stack.txt` (raw_text, 30 bytes)

_Suggested next:_ profile_cpu, trace_syscalls, inspect_sockets

### inspect_sockets#6 — ok (338 ms)

| id | kind | summary | source |
|---|---|---|---|
| e1 | socket_summary | listening: TCP *:3000 (pid 25), TCP 127.0.0.1:9229 (pid 25) | `20261017T222856-inspect_sockets-lsof-sockets.txt` |
| e2 | socket_summary | 3 inet socket(s): ESTABLISHED=1; udp=0; unix=0 | `20261017T222856-inspect_sockets-lsof-sockets.txt` |
| e3 | socket | top remotes: 127.0.0.1 ×1 | `20261017T222856-inspect_sockets-lsof-sockets.txt` |
| e4 | fd_summary | 30 open fd(s); open-file limit soft=1048576 hard=1048576 (/proc/25/limits) |  |

**Artifacts:**
- `/dea/.lab-dea/sessions/20261017-222831-8528cd/artifacts/20261017T222856-inspect_sockets-lsof-sockets.txt` (raw_text, 198 bytes)

_Suggested next:_ inspect_files, trace_syscalls, capture_traffic (needs consent)

### inspect_files#7 — ok (2337 ms)

| id | kind | summary | source |
|---|---|---|---|
| e1 | fd_summary | 30 fd(s): a_inode=12 FIFO=10 CHR=3 REG=2 IPv6=2 IPv4=1 | `20261017T222856-inspect_files-lsof-files.txt` |
| e2 | metric | open-file limit soft=1048576 hard=1048576 (/proc/25/limits) |  |
| e3 | fd | largest open files: leaky.log 568 B, leaky.log 568 B | `20261017T222856-inspect_files-lsof-files.txt` |
| e4 | metric_series | fds 30 → 30 over 2s (+0) |  |

**Artifacts:**
- `/dea/.lab-dea/sessions/20261017-222831-8528cd/artifacts/20261017T222856-inspect_files-lsof-files.txt` (raw_text, 1912 bytes)

_Suggested next:_ inspect_sockets, trace_syscalls

### capture_traffic#8 — ok (5347 ms)

| id | kind | summary | source |
|---|---|---|---|
| e1 | note | filter: ((port 3000 or port 48278 or port 9229) or (udp and port 53)) |  |
| e2 | packet_summary | 261 packets, 3.8 MB payload over 3.24s; RST=0 retransmit≈27 unanswered SYN=0 | `20261017T222859-capture_traffic-capture.pcap` |
| e3 | packet_summary | per remote: 127.0.0.1 261p/3.8 MB rtx×27 | `20261017T222904-capture_traffic-capture.txt` |

**Limitations:**
- retransmits are approximated from repeated (flow,length) pairs within 250 ms; open the .pcap in Wireshark for exact analysis
- TLS SNI and payloads need a deeper snaplen/-v; this capture used -s 256 -q. Raw .pcap may contain secrets and is NOT redacted

**Artifacts:**
- `/dea/.lab-dea/sessions/20261017-222831-8528cd/artifacts/20261017T222859-capture_traffic-capture.pcap` (pcap, 53129 bytes)
- `/dea/.lab-dea/sessions/20261017-222831-8528cd/artifacts/20261017T222904-capture_traffic-capture.txt` (raw_text, 45461 bytes)

_Suggested next:_ inspect_sockets, trace_syscalls

### snapshot_memory#9 — ok (2506 ms)

| id | kind | summary | source |
|---|---|---|---|
| e1 | metric | rss=173.3 MB vsz=10.99 GB cpu=4.4% (1 pid) | `20261017T222906-snapshot_memory-mem-samples.json` |
| e2 | metric_series | rss 171.0 MB → 173.3 MB over 2s (5 samples) | `20261017T222906-snapshot_memory-mem-samples.json` |
| e3 | metric | proc status: HWM=173.3 MB anon=125.2 MB file=48.1 MB swap=0 B threads=8 |  |
| e4 | heap_summary | heap 89.5 MB in 84569 objects; by type: string 41.8 MB, native 41.5 MB, code 3.0 MB, array 945.1 KB | `20261017T222906-snapshot_memory-heap.heapsnapshot` |
| e5 | heap_summary | by constructor (self size): (string) 41.8 MB×17110, (native) 41.5 MB×862, (code) 3.0 MB×27420, (object shape) 776.0 KB×8738, (object properties) 489.2 KB×1227 | `20261017T222906-snapshot_memory-heap.heapsnapshot` |
| e6 | heap_retainer | top retainers: Array (object) retains 88.9 MB via FixedCircularBuffer.list; Object (object) retains 88.9 MB via system / Context.primordials; Array (object) retains 88.9 MB via system / Context.retained; Array (object) retains 88.9 MB via system / Context.builtinIds | `20261017T222906-snapshot_memory-heap.heapsnapshot` |

**Limitations:**
- RSS sampled 5× over 2s via ps; no allocation-site attribution for runtime node
- heap snapshot: 82 chunks, 8 MB JSON
- retained sizes are a reachability approximation (shared subgraphs are over-counted); open the .heapsnapshot in Chrome DevTools for exact dominator-tree numbers

**Artifacts:**
- `/dea/.lab-dea/sessions/20261017-222831-8528cd/artifacts/20261017T222906-snapshot_memory-mem-samples.json` (json, 438 bytes)
- `/dea/.lab-dea/sessions/20261017-222831-8528cd/artifacts/20261017T222906-snapshot_memory-heap.heapsnapshot` (heapsnapshot, 8305870 bytes)

_Suggested next:_ snapshot_memory (again, after load), diff_runs

### diff_runs#10 — ok (1 ms)

| id | kind | summary | source |
|---|---|---|---|
| e1 | diff | snapshot_memory#2 (2026-10-17T22:28:31.984Z) → snapshot_memory#9 (2026-10-17T22:29:04.848Z) |  |
| e2 | diff | metrics: name=rss 72.5 MB→173.3 MB, name=rss_series 74212→177456 |  |
| e3 | diff | heap_summary: 10 grew, 5 shrank, 2 appeared, 2 disappeared |  |
| e4 | diff | heap_retainer: 3 grew, 0 shrank, 0 appeared, 0 disappeared |  |

_Suggested next:_ report

---
_Generated by DEA (Debug Anything). Every finding above cites evidence ids; raw artifacts are unredacted on disk._
