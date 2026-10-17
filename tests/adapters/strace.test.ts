import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { parseStrace, aggregateSyscalls, describeArgs } from "../../src/adapters/strace.js";

const SAMPLE = `12345 10:00:00.000100 openat(AT_FDCWD, "/app/server.js", O_RDONLY|O_CLOEXEC) = 20 <0.000031>
12345 10:00:00.000200 read(20, "import http"..., 65536) = 1234 <0.000012>
12345 10:00:00.000300 read(20, "", 65536) = 0 <0.000005>
12345 10:00:00.000400 close(20) = 0 <0.000004>
12345 10:00:00.000500 openat(AT_FDCWD, "/app/missing.json", O_RDONLY) = -1 ENOENT (No such file or directory) <0.000020>
12345 10:00:00.000600 epoll_wait(5, [], 1024, 800) = 0 <0.800912>
12345 10:00:00.801600 connect(21, {sa_family=AF_INET, sin_port=htons(5432), sin_addr=inet_addr("10.0.0.5")}, 16) = -1 ECONNREFUSED (Connection refused) <0.000210>
12346 10:00:00.801700 futex(0x7f0, FUTEX_WAIT_PRIVATE, 0, NULL <unfinished ...>
12345 10:00:00.801800 nanosleep({tv_sec=0, tv_nsec=800000000}, NULL) = 0 <0.800100>
12346 10:00:01.601900 <... futex resumed>) = 0 <0.800200>
12345 10:00:01.602000 write(1, "slow done\\n", 10) = 10 <0.000015>
+++ exited with 0 +++
`;

describe("strace parser", () => {
  it("parses lines, errors, durations, and unfinished/resumed pairs", () => {
    const r = parseStrace(SAMPLE);
    expect(r).toHaveLength(10);
    expect(r[0]!.name).toBe("openat");
    expect(r[0]!.pid).toBe(12345);
    expect(r[0]!.duration_s).toBeCloseTo(0.000031);
    const enoent = r.find((x) => x.errno === "ENOENT")!;
    expect(describeArgs(enoent)).toBe("/app/missing.json");
    const conn = r.find((x) => x.name === "connect")!;
    expect(conn.errno).toBe("ECONNREFUSED");
    expect(describeArgs(conn)).toBe("10.0.0.5:5432");
    const futex = r.find((x) => x.name === "futex")!;
    expect(futex.unfinished).toBe(true);
    expect(futex.resumed).toBe(true);
    expect(futex.duration_s).toBeCloseTo(0.8002);
    expect(futex.line).toBe(8);
  });
  it("aggregates by total time, counts errors, flags waits", () => {
    const agg = aggregateSyscalls(parseStrace(SAMPLE));
    expect(agg.stats[0]!.syscall).toMatch(/epoll_wait|nanosleep|futex/);
    const reads = agg.stats.find((s) => s.syscall === "read")!;
    expect(reads.count).toBe(2);
    expect(agg.errors.map((e) => `${e.syscall}:${e.errno}`)).toEqual(expect.arrayContaining(["openat:ENOENT", "connect:ECONNREFUSED"]));
    expect(agg.slowest[0]!.name).toBe("epoll_wait");
    expect(agg.waitMs).toBeGreaterThan(2000);
  });
  it("parses a real fixture when present", () => {
    const p = new URL("../fixtures/strace/node-slow.log", import.meta.url);
    if (!existsSync(p)) return;
    const r = parseStrace(readFileSync(p, "utf8"));
    expect(r.length).toBeGreaterThan(50);
    const agg = aggregateSyscalls(r);
    expect(agg.stats.length).toBeGreaterThan(3);
  });
});
