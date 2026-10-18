<img src="https://raw.githubusercontent.com/shreyassaw5394/dea/main/assets/dea-mark-512.png" alt="" width="56" align="right">

# Showcases

Three deliberately broken apps in [`examples/`](../examples) and the exact DEA
sessions that diagnose them. Transcripts below are real output: the Linux run
is the `docker/linux-lab` image (Debian 12, arm64, root, Node 22.23, Python
3.11) driven by `docker/linux-lab/run-lab.sh`; the macOS run is a MacBook Pro
(Darwin 25, no sudo, own processes). Numbers vary run to run; the shape does not.

Every finding cites evidence ids (`e1`, `e2`…); the evidence rows point at
artifacts in the session directory. Nothing below was typed by hand. The full
markdown report DEA wrote for the leaky-node session is in
[example-report-leaky-node.md](example-report-leaky-node.md).

---

## 1. leaky-node — "memory keeps growing, and /slow is slow"

[`examples/leaky-node`](../examples/leaky-node): an HTTP server whose `/work`
route pushes every request body into a module-level array through a closure
(never removed), and whose `/slow` route does 1 500 synchronous
`readFileSync` calls of a 256 KB file and then waits on an 800 ms timer.

```bash
cd examples/leaky-node && node server.js &        # pid printed
S=$(dea attach <pid> --json | jq -r .session_id)
dea memory  --session $S                          # baseline
node load.js 400 2                                # 400 × /work (64 KB bodies)
dea memory  --session $S
dea diff    --session $S snapshot_memory#2 snapshot_memory#3
dea trace   --session $S --duration 8 --categories file,network   # Linux
dea profile --session $S --duration 8
dea report  --session $S --md report.md && dea detach --session $S
```

### The leak (macOS, no sudo)

```
✔ snapshot_memory (snapshot_memory#2)
  INFO  RSS 48.0 MB, stable over 1s [observed; e1,e2]

✔ snapshot_memory (snapshot_memory#3)
  INFO  RSS 273.0 MB, stable over 1s [observed; e1,e2]
  WARN  Array (object) retains 50.1 MB = 87% of the heap, held by system / Context.retained [observed; e5,e3]
        Take another snapshot_memory after load and diff_runs: if this retainer grows, it is the leak.
  e3   heap_summary    heap 57.5 MB in 81k objects; by type: string 24 MB, native 24 MB, …
  e5   heap_retainer   top retainers: Array (object) retains 50.1 MB via system / Context.retained; …

✔ diff_runs (diff_runs#4)
  WARN  name=rss grew 48.0 MB → 273.0 MB (+468%) [observed; e2,e1]
  HIGH  heap_summary: name=heap_total grew 6.8 MB → 57.5 MB (and 9 more grew) [observed; e3,e1]
  HIGH  heap_retainer: name=Array grew 2.0 KB → 50.1 MB (and 2 more grew) [observed; e4,e1]
```

`system / Context.retained` is V8's name for a closure variable called
`retained` — the module-level array in `server.js`. Retained sizes are exact
(dominated set per candidate), not a reachability guess. The `.heapsnapshot`
artifact opens in Chrome DevTools for the full dominator tree.

### The slow route (Linux lab)

```
✔ trace_syscalls (trace_syscalls#3)   8 s, categories file,network
  WARN  18000 path lookups (open/stat) in 8s — filesystem churn (missing cache? module resolution per request?) [inferred; e1]
  WARN  9274 read() calls in 8s (avg 0.105 ms) — many small reads; sync I/O in a loop? [inferred; e1]
  WARN  slowest single call: epoll_pwait(15, [], 1024, 631, NULL, 8) took 637.397 ms [observed; e2]
  e1   syscall_stat    36757 syscalls, 3725 ms inside the kernel over 8s; top by time: epoll_pwait 1808ms×206, read 977ms×9274, openat 310ms×9000, close 298ms×9003, statx 297ms×9000
  e4   metric          75% of kernel time in blocking waits

✔ profile_cpu (profile_cpu#4)   perf, 8 s
  WARN  __arch_copy_to_user accounts for 58.3% of CPU work (62.3% inclusive); the process was CPU-busy ≈22% of the time [observed; e1,e2,e3]
        Hot path: generic_file_read_iter ← filemap_read ← copy_page_to_iter ← __arch_copy_to_user
  ! 86 stack frames have no symbols — start Node with --perf-basic-prof so JIT frames get names
  • …/profile_cpu-flamegraph.svg (flamegraph_svg, 33.8 KB)
```

Read: 9 000 `openat`+`statx`+`close` triples and 9 274 `read()`s in eight
seconds is `readFileSync` in a loop; the CPU is in the kernel copying file
pages to user space; the remaining wall time is `epoll_pwait` sleeping on the
800 ms timer. The handoff in the result: *attach a step debugger at the
function that calls readFileSync*.

The same session on Linux also ran `capture_traffic` (consent) on the
target's own ports: `628 packets, 11.3 MB payload over 3.5 s; RST=0 retransmit=0`
— confirming the slowness is not the network.

---

## 2. deadlock-py — "it hangs after ~20 requests"

[`examples/deadlock-py`](../examples/deadlock-py): a `ThreadingHTTPServer`
whose request handler, from request 20 on, starts two workers that take
`lock_a`→`lock_b` and `lock_b`→`lock_a`.

```bash
cd examples/deadlock-py && python3 app.py &       # :5055
for i in $(seq 1 25); do curl -s -m 1 localhost:5055/; done   # hangs at 20
S=$(dea attach <pid> --json | jq -r .session_id)
dea stacks --session $S
```

Linux lab transcript (py-spy; on macOS py-spy needs `sudo` and DEA says so
instead of escalating):

```
✔ dump_stacks (dump_stacks#4)
  HIGH  likely deadlock: 42 thread(s) blocked acquiring locks and no thread is running —
        worker-ab-20 at worker_ab (app.py:38) [with lock_b:]; worker-ba-20 at worker_ba (app.py:45) [with lock_a:];
        worker-ab-21 at worker_ab (app.py:36) [with lock_a:]; worker-ba-21 at worker_ba (app.py:43) [with lock_b:]; … [inferred; e14,e1]
        21 thread(s) are joined on them (Thread-20 (process_request_thread), …). Re-run dump_stacks: identical
        positions confirm a deadlock. Handoff: attach a step debugger (e.g. mcp-debugger) at worker_ab (app.py:38) to inspect lock owners.
  INFO  1 thread(s) blocked in I/O: MainThread at serve_forever (socketserver.py:233) [observed; e14]
  e1   stack_summary   64 thread(s): 0 active, 64 idle; python 3.11.2
  e4   stack           worker-ab-20 [idle]: worker_ab@app.py:38 ← run@threading.py:975 ← …
  e5   stack           worker-ba-20 [idle]: worker_ba@app.py:45 ← run@threading.py:975 ← …
```

py-spy shows a thread blocked in a C-level lock acquire with the *Python
caller* as its top frame, so DEA reads that source line (resolving relative
paths against the target's cwd) and classifies the wait: `with lock_b:` →
lock; `.join(` → join; `sleep(` → sleep; `.recv(` → I/O. Two or more threads
in lock waits with nothing running is reported as a *likely* deadlock
(`confidence: inferred`) with the instruction to confirm by dumping again.

Before the deadlock, the same session profiled a CPU-bound route:

```
✔ profile_cpu (profile_cpu#3)   py-spy, 4 s
  WARN  burn (app.py:30) accounts for 95.6% of CPU work (95.6% inclusive); the process was CPU-busy ≈23% of the time [observed; e1,e2,e3]
        Hot path: handle (server.py:432) ← handle_one_request (server.py:420) ← do_GET (app.py:56) ← burn (app.py:30)
```

---

## 3. busy-port — "address already in use"

[`examples/busy-port`](../examples/busy-port): one process holds `:8080`,
another fails to bind.

```bash
cd examples/busy-port && node server.js &
node bind.js            # bind :8080 failed: EADDRINUSE
dea port 8080
```

```
✔ inspect_sockets  367 ms
  HIGH  port 8080 is held by pid 61326 (node, user shreyassawant) in LISTEN [observed; e1,e2]
        command: node server.js. DEA will not kill it; decide yourself.
  e1   socket          port 8080: pid 61326 node [LISTEN]
  e2   process         pid 61326: node server.js (user shreyassawant)
```

No session needed. If nothing is listening but `bind` still fails, the same
command reports TIME_WAIT/CLOSE_WAIT leftovers, and `limitations` tells you
other users' processes are invisible without root.

---

## What was stubbed or untested live

- `bpftrace`: scripts staged in `src/adapters/bpftrace.ts`, not wired to a tool (`readiness` shows `not_implemented`).
- Kubernetes `attach ns/pod`: implemented against `kubectl`, not exercised live.
- `container_info`: adapter and parsers tested on fixtures; a live docker-in-docker run was not part of the lab (Docker Desktop on macOS hides host pids, which `container_info` reports as a limitation).
- Windows: `readiness` returns "not supported yet".
- py-spy on macOS: refused without sudo (by design); exercised live on Linux.
