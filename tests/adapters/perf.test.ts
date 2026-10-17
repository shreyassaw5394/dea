import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { perfScriptToFolded } from "../../src/adapters/perf.js";
import { parseFolded, aggregateFrames } from "../../src/stacks.js";

const SAMPLE = `node 1234 5678.123456:     250000 cpu-clock:
\t    7f0a2b1c0a3e epoll_wait+0x4e (/usr/lib/x86_64-linux-gnu/libc.so.6)
\t          5a3c1b uv__io_poll+0x1ab (/usr/local/bin/node)
\t          5a1000 uv_run+0x100 (/usr/local/bin/node)

node 1234 5678.133456:     250000 cpu-clock:
\t    7f0a2b1c0a3e epoll_wait+0x4e (/usr/lib/x86_64-linux-gnu/libc.so.6)
\t          5a3c1b uv__io_poll+0x1ab (/usr/local/bin/node)
\t          5a1000 uv_run+0x100 (/usr/local/bin/node)

node 1234 5678.143456:     250000 cpu-clock:
\t    7f0a2b1d1111 __GI___libc_read+0x11 (/usr/lib/x86_64-linux-gnu/libc.so.6)
\t          5b0000 [unknown] (/usr/local/bin/node)
\t          5a1000 uv_run+0x100 (/usr/local/bin/node)

`;

describe("perf script → folded", () => {
  it("folds samples root-first with counts", () => {
    const folded = perfScriptToFolded(SAMPLE);
    const stacks = parseFolded(folded);
    expect(stacks).toHaveLength(2);
    const idle = stacks.find((s) => s.count === 2)!;
    expect(idle.frames).toEqual(["uv_run", "uv__io_poll", "epoll_wait"]);
    const rd = stacks.find((s) => s.count === 1)!;
    expect(rd.frames[1]).toBe("[unknown] (node)");
    expect(aggregateFrames(stacks).totalSamples).toBe(3);
  });
  it("parses a real fixture when present", () => {
    const p = new URL("../fixtures/perf/node-script.txt", import.meta.url);
    if (!existsSync(p)) return;
    const stacks = parseFolded(perfScriptToFolded(readFileSync(p, "utf8")));
    expect(stacks.length).toBeGreaterThan(1);
  });
});
