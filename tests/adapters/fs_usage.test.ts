import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseFsUsage } from "../../src/adapters/fs_usage.js";
import { aggregateSyscalls } from "../../src/adapters/strace.js";

const fx = readFileSync(new URL("../fixtures/fs_usage/node-slow.txt", import.meta.url), "utf8");

describe("fs_usage parser (macOS)", () => {
  it("parses calls, durations, blocked flag, errno brackets and the process", () => {
    const r = parseFsUsage(fx);
    expect(r).toHaveLength(10);
    expect(r[0]).toMatchObject({ name: "open", pid: 84294, duration_s: 0.000031 });
    expect(r[0]!.args).toContain("/private/tmp/leaky-node-payload.bin");
    expect(r[2]!.result).toBe("0 (blocked)");
    const missing = r.find((x) => x.args.includes("missing.json"))!;
    expect(missing.errno).toBe("ENOENT");
    const conn = r.find((x) => x.name === "connect")!;
    expect(conn.errno).toBe("ECONNREFUSED");
    expect(r.find((x) => x.name === "RdData")!.duration_s).toBeCloseTo(0.0004);
  });
  it("feeds the shared syscall aggregation", () => {
    const agg = aggregateSyscalls(parseFsUsage(fx));
    expect(agg.stats[0]!.syscall).toBe("kevent");
    expect(agg.errors.map((e) => e.errno)).toEqual(expect.arrayContaining(["ENOENT", "ECONNREFUSED"]));
  });
});
