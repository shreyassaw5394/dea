# deadlock-py

Stdlib-only threaded HTTP server that deadlocks after ~20 requests (two locks
taken in opposite order).

```bash
python3 app.py
for i in $(seq 1 30); do curl -s -m 2 localhost:5000/; done   # hangs at request 20
```

DEA: `dump_stacks` shows `worker-ab-20` blocked in `worker_ab` waiting for
`lock_b` and `worker-ba-20` blocked in `worker_ba` waiting for `lock_a`.
