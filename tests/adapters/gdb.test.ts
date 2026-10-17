import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { parseGdbBacktrace, classifyNativeThreads } from "../../src/adapters/gdb.js";

const DEADLOCK = `[New LWP 1235]
[New LWP 1236]
[Thread debugging using libthread_db enabled]
0x00007f3a1c2a4e2d in __lll_lock_wait () from /lib/x86_64-linux-gnu/libpthread.so.0

Thread 3 (Thread 0x7f3a1b7fe700 (LWP 1236) "worker-b"):
#0  0x00007f3a1c2a4e2d in __lll_lock_wait () from /lib/x86_64-linux-gnu/libpthread.so.0
#1  0x00007f3a1c29d0f3 in pthread_mutex_lock () from /lib/x86_64-linux-gnu/libpthread.so.0
#2  0x000055d5c0a01234 in worker_b (arg=0x0) at app.c:42
#3  0x00007f3a1c29a609 in start_thread () from /lib/x86_64-linux-gnu/libpthread.so.0
#4  0x00007f3a1c1c1293 in clone () from /lib/x86_64-linux-gnu/libc.so.6

Thread 2 (Thread 0x7f3a1bfff700 (LWP 1235) "worker-a"):
#0  0x00007f3a1c2a4e2d in __lll_lock_wait () from /lib/x86_64-linux-gnu/libpthread.so.0
#1  0x00007f3a1c29d0f3 in pthread_mutex_lock () from /lib/x86_64-linux-gnu/libpthread.so.0
#2  0x000055d5c0a01111 in worker_a (arg=0x0) at app.c:30
#3  0x00007f3a1c29a609 in start_thread () from /lib/x86_64-linux-gnu/libpthread.so.0
#4  0x00007f3a1c1c1293 in clone () from /lib/x86_64-linux-gnu/libc.so.6

Thread 1 (Thread 0x7f3a1c0c9740 (LWP 1234) "app"):
#0  0x00007f3a1c29b9f5 in __pthread_clockjoin_ex () from /lib/x86_64-linux-gnu/libpthread.so.0
#1  0x000055d5c0a01400 in main () at app.c:60
`;

describe("gdb backtrace parser", () => {
  it("parses a synthetic deadlock", () => {
    const t = parseGdbBacktrace(DEADLOCK);
    expect(t.map((x) => x.name)).toEqual(["worker-b", "worker-a", "app"]);
    expect(t[0]!.tid).toBe(1236);
    expect(t[0]!.frames[2]!.func).toBe("worker_b");
    expect(t[0]!.frames[2]!.loc).toBe("app.c:42");
    const { lock, running } = classifyNativeThreads(t);
    expect(lock.map((l) => l.at)).toEqual(["worker_b (app.c:42)", "worker_a (app.c:30)"]);
    expect(running.map((r) => r.name)).toEqual(["app"]);
  });
  it("parses a real gdb fixture when present", () => {
    const p = new URL("../fixtures/gdb/node-idle.txt", import.meta.url);
    if (!existsSync(p)) return;
    const t = parseGdbBacktrace(readFileSync(p, "utf8"));
    expect(t.length).toBeGreaterThan(1);
    expect(t.every((x) => x.frames.length > 0)).toBe(true);
  });
});
