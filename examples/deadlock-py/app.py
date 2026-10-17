"""Tiny threaded HTTP server that deadlocks on two locks after ~20 requests.

    python app.py            # listens on :5000
    for i in $(seq 1 30); do curl -s localhost:5000/ ; done   # hangs around request 20

Two worker threads alternate lock order (lock_a→lock_b vs lock_b→lock_a).
A small sleep between acquisitions makes the deadlock deterministic once both
workers are busy at the same time, which happens when request 20 arrives.
"""
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

lock_a = threading.Lock()
lock_b = threading.Lock()
counter = 0
counter_lock = threading.Lock()
DEADLOCK_AFTER = int(os.environ.get("DEADLOCK_AFTER", "20"))


def burn(ms: int = 150) -> int:
    """CPU-bound hashing so profile_cpu has a hot frame."""
    import hashlib
    h = hashlib.sha256()
    end = time.time() + ms / 1000
    n = 0
    while time.time() < end:
        h.update(b"x" * 4096)
        n += 1
    return n


def worker_ab(n: int) -> None:
    with lock_a:
        time.sleep(0.05 if n >= DEADLOCK_AFTER else 0)
        with lock_b:
            time.sleep(0.001)


def worker_ba(n: int) -> None:
    with lock_b:
        time.sleep(0.05 if n >= DEADLOCK_AFTER else 0)
        with lock_a:
            time.sleep(0.001)


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        global counter
        with counter_lock:
            counter += 1
            n = counter
        if "burn" in self.path:
            burn()
        if n >= DEADLOCK_AFTER:
            # Fire both orders concurrently → deadlock.
            t1 = threading.Thread(target=worker_ab, args=(n,), name=f"worker-ab-{n}")
            t2 = threading.Thread(target=worker_ba, args=(n,), name=f"worker-ba-{n}")
            t1.start()
            t2.start()
            t1.join()
            t2.join()
        else:
            worker_ab(n)
        self.send_response(200)
        self.end_headers()
        self.wfile.write(f"request {n} ok\n".encode())

    def log_message(self, *args):  # quiet
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5055"))
    srv = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    print(f"deadlock-py listening on http://127.0.0.1:{port}  pid={os.getpid()}  deadlocks at request {DEADLOCK_AFTER}", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        sys.exit(0)
