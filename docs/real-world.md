<img src="https://raw.githubusercontent.com/shreyassaw5394/debuganything/main/assets/debuganything-mark-512.png" alt="" width="56" align="right">

# Real-world situations

Incident patterns every on-call engineer has seen, and what a Debug Anything session
looks like on each. Where numbers come from our own reproductions
(`examples/`, the Linux lab) they are real; the rest are marked *illustrative*
and show the shape of the evidence, not a specific customer. Every finding Debug Anything
prints cites evidence ids; that is the point.

---

## 1. "We hit EMFILE at 2 am" — CLOSE_WAIT pileup behind a load balancer

**Symptom.** A Node/Go/Java service behind an ALB starts returning 500s a few
hours after deploy. Restart fixes it. Logs say `EMFILE: too many open files`.

**What usually happens.** Someone raises `ulimit -n` and moves on.

**Debug Anything session.**

```bash
S=$(debuganything attach 2231 --json | jq -r .session_id)
debuganything sockets --session $S
debuganything files   --session $S --window 10
```

**Evidence (illustrative).**

```
HIGH  412 sockets in CLOSE_WAIT — the peer closed and the target never called close(); fd leak in the connection-handling code [inferred; e2]
HIGH  980 fds open vs soft limit 1024 (96%) — EMFILE imminent [observed; e4]
e2    socket_summary  1004 inet socket(s): ESTABLISHED=61 CLOSE_WAIT=412 TIME_WAIT=9
e3    socket          top remotes: 10.0.3.17 ×388 (CLOSE_WAIT 371)   ← the load balancer
e4    metric_series   fds 902 → 980 over 10s (+78)
```

**Fix.** The LB idle timeout (60 s) is shorter than the app's keep-alive
timeout; the app never notices the LB closed. Set the server keep-alive below
the LB's, or handle `close`/`timeout` on the socket.

**Prove it.** `debuganything sockets` again after the fix → `CLOSE_WAIT=3`; `debuganything diff`
shows the state count dropping.

---

## 2. "Disk is 100 % full but `du` says 40 GB free"

**Symptom.** `/var` is full. `du -sh /var/log` is small. Deleting files frees nothing.

**Debug Anything session.**

```bash
debuganything ps --filter java
S=$(debuganything attach 4120 --json | jq -r .session_id)
debuganything files --session $S
```

**Evidence (illustrative, Linux only).**

```
HIGH  1 file(s) deleted while still open hold 38.2 GB of disk — "disk full but nothing there" [observed; e5]
e5    fd    /var/log/app/app.log.1 (deleted)  fd 7  38.2 GB
```

**Fix.** logrotate deleted the file but the process still has it open. Use
`copytruncate`, or send the app its reopen signal (`SIGHUP`/`SIGUSR1`). Debug Anything
tells you which pid and fd; it will not truncate it for you.

---

## 3. "Postgres says too many connections" — pool exhaustion in a Django app

**Symptom.** Under load, requests queue; Postgres shows 100/100 connections;
p99 goes to 8 s.

**Debug Anything session.**

```bash
S=$(debuganything attach 8812 --json | jq -r .session_id)    # a gunicorn worker
debuganything sockets --session $S
debuganything trace   --session $S --duration 10 --categories network
debuganything stacks  --session $S
```

**Evidence (illustrative).**

```
WARN  64 connections to 10.0.5.9 — connection pool exhaustion or missing reuse [inferred; e3]
WARN  18× connect failed with ECONNREFUSED — a downstream service is not accepting connections [observed; e3]
INFO  recvfrom dominates: 7 412 ms over 211 calls (91% of kernel time) — blocking wait [observed; e1,e2]
e2    syscall_slow   slowest: recvfrom(fd 23 ← 10.0.5.9:5432) 1 980 ms
      dump_stacks: 4 thread(s) blocked in I/O: worker-3 at execute (cursor.py:88) [cursor.execute(sql)]
```

**Fix.** Each worker opens its own connections and never reuses them
(`CONN_MAX_AGE=0`). Put pgbouncer in front or set `CONN_MAX_AGE`, and cap
worker count × pool size below `max_connections`.

---

## 4. "The Celery worker just stops" — deadlock after a refactor

**Symptom.** Throughput drops to zero every few hours. CPU idle. Restart fixes it.

**Debug Anything session.** `debuganything why 5570 --symptom hang`

**Evidence (real, from `examples/deadlock-py` in the Linux lab).**

```
HIGH  likely deadlock: 42 thread(s) blocked acquiring locks and no thread is running —
      worker-ab-20 at worker_ab (app.py:38) [with lock_b:]; worker-ba-20 at worker_ba (app.py:45) [with lock_a:] … [inferred; e14,e1]
      21 thread(s) are joined on them. Re-run dump_stacks: identical positions confirm a deadlock.
```

**Fix.** Two code paths take `lock_a`/`lock_b` in opposite order. Fix the lock
order (or use one lock). The source lines in brackets are read from the
process's own files, so you know exactly where.

---

## 5. "Every request is slow for a second, then fine" — a blocked Node event loop

**Symptom.** p50 is 20 ms, p99 is 1.4 s, CPU on one core is pegged in bursts.

**Debug Anything session.**

```bash
S=$(debuganything attach 3310 --json | jq -r .session_id)
debuganything stacks  --session $S          # inspector pause: what is the main thread doing right now?
debuganything profile --session $S --duration 10
debuganything trace   --session $S --duration 8 --categories file
```

**Evidence (real, from `examples/leaky-node` `/slow` in the Linux lab).**

```
WARN  18000 path lookups (open/stat) in 8s — filesystem churn [inferred; e1]
WARN  9274 read() calls in 8s (avg 0.104 ms) — many small reads; sync I/O in a loop? [inferred; e1]
WARN  __arch_copy_to_user accounts for 58.3% of CPU work; the process was CPU-busy ≈22% of the time [observed; e1,e2,e3]
      Hot path: generic_file_read_iter ← filemap_read ← copy_page_to_iter ← __arch_copy_to_user
```

**Fix.** `fs.readFileSync` (or `JSON.parse` of a huge body, or sync
compression) on the request path. Move it to a worker thread or stream it;
cache the file.

---

## 6. "The pod restarts every few hours" — OOMKilled with a quiet leak

**Symptom.** Kubernetes shows `OOMKilled`, restart count climbing. Nothing in
the app logs.

**Debug Anything session.**

```bash
S=$(debuganything attach api-7f9c --json | jq -r .session_id)     # container name / id
debuganything container --session $S
debuganything memory    --session $S
# wait 10 minutes of traffic
debuganything memory    --session $S
debuganything diff      --session $S snapshot_memory#3 snapshot_memory#4
```

**Evidence (real numbers from `examples/leaky-node`; container block illustrative).**

```
HIGH  container was OOM-killed (State.OOMKilled=true) [observed; e1,e2]
WARN  memory at 94% of the 512.0 MB limit — close to OOM [observed; e3,e2]
WARN  Array (object) retains 50.1 MB = 87% of the heap, held by system / Context.retained [observed; e5,e3]
HIGH  heap_retainer: name=Array grew 2.0 KB → 50.1 MB [observed; e4,e1]
```

**Fix.** A module-level cache/array that is only ever appended to. Bound it
(LRU, TTL) or clear it per request. Open the `.heapsnapshot` artifact in
Chrome DevTools if you want the full dominator tree.

---

## 7. "Latency spikes every ~30 s" — DNS on every request

**Symptom.** Calls to a partner API are fast most of the time, then 300–900 ms.

**Debug Anything session (needs consent).**

```bash
debuganything capture --session $S --duration 10 --consent
debuganything sockets --session $S
```

**Evidence (illustrative).**

```
WARN  api.partner.com resolved 212× in 10s — no DNS caching [inferred; e4]
WARN  127 sockets in TIME_WAIT — high connection churn (no keep-alive / connection pooling?) [inferred; e2]
e4    dns_query   DNS: api.partner.com ×212, cdn.partner.com ×31
```

**Fix.** The HTTP client creates a new connection (and a new lookup) per
request. Use a keep-alive agent / session and a resolver cache. The TIME_WAIT
count drops first; the DNS count second.

---

## 8. "Address already in use" after a crash

**Symptom.** `npm run dev` fails with `EADDRINUSE :3000`. Nothing obvious is running.

**Debug Anything session.** `debuganything port 3000`

**Evidence (real, macOS).**

```
HIGH  port 8080 is held by pid 61326 (node, user shreyassawant) in LISTEN [observed; e1,e2]
      command: node server.js. Debug Anything will not kill it; decide yourself.
```

Usually an orphaned child from a previous dev-server run (nodemon, ts-node,
a VS Code task). Debug Anything names it; you kill it.

---

## 9. "It's pegged at 100 % CPU" — a native hot spot you cannot read

**Symptom.** A C++/Rust/Go service burns a core; no obvious loop in your code.

**Debug Anything session.** `debuganything profile --session $S --duration 15`

**Evidence (illustrative).**

```
WARN  parse_frame (libfoo.so) accounts for 71% of CPU work; the process was CPU-busy ≈98% of the time [observed; e1,e2,e3]
next: decompile parse_frame in libfoo.so with a static-analysis tool / disassembler
```

**Fix.** Open the symbol in your decompiler to see the quadratic loop; after the fix, `debuganything diff profile_cpu#2 profile_cpu#3` is the proof in
the PR.

---

### What these have in common

- The first command is always the same: attach, then the tool that measures
  the symptom. No log spelunking, no guessing which flag `strace` needs.
- The output names a pid, fd, socket state, symbol or source line, and the
  evidence id that backs it.
- The fix is yours. Debug Anything never kills, truncates, signals or patches anything.
