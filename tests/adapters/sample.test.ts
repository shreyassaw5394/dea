import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { sampleToFolded } from "../../src/adapters/sample_macos.js";
import { parseFolded, aggregateFrames } from "../../src/stacks.js";

const fx = readFileSync(new URL("../fixtures/sample/node-idle.txt", import.meta.url), "utf8");

describe("sample (macOS) call graph → folded", () => {
  it("folds the call graph with one leaf per thread", () => {
    const folded = sampleToFolded(fx);
    const stacks = parseFolded(folded);
    expect(stacks.length).toBeGreaterThan(3);
    const main = stacks.find((s) => s.frames[0]!.startsWith("Thread_") && s.frames.some((f) => f.startsWith("kevent")));
    expect(main).toBeDefined();
    expect(main!.frames.at(-1)).toMatch(/^kevent \(libsystem_kernel\.dylib\)/);
    // Each thread contributes exactly its sample count (4255 in this capture).
    const { totalSamples } = aggregateFrames(stacks);
    const threads = (fx.match(/^\s{4}\d+ Thread_/gm) ?? []).length;
    expect(totalSamples).toBe(4255 * threads);
  });
  it("returns empty for input without a call graph", () => {
    expect(sampleToFolded("nothing here")).toBe("");
  });
});
