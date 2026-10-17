import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseLldbBacktrace } from "../../src/adapters/lldb.js";
import { classifyNativeThreads } from "../../src/adapters/gdb.js";

const fx = readFileSync(new URL("../fixtures/lldb/node-idle.txt", import.meta.url), "utf8");

describe("lldb backtrace parser", () => {
  it("parses threads once each with frames", () => {
    const t = parseLldbBacktrace(fx);
    expect(t.map((x) => x.index)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(t[0]!.name).toBe("com.apple.main-thread");
    expect(t[0]!.frames[0]!.func).toBe("kevent");
    expect(t[2]!.frames.map((f) => f.func)).toContain("uv_cond_wait");
  });
  it("classifies an idle node process as idle, not deadlocked", () => {
    const { lock, io, idle, running } = classifyNativeThreads(parseLldbBacktrace(fx));
    expect(lock).toEqual([]);
    expect(io).toEqual([]);
    expect(running).toEqual([]);
    expect(idle.length).toBe(7);
  });
});
