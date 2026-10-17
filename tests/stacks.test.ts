import { describe, expect, it } from "vitest";
import { parseFolded, aggregateFrames, hottestStacks, renderFlamegraph } from "../src/stacks.js";

const folded = `main;work;hot 50\nmain;work;cold 10\nmain;idle;epoll_wait 40\n`;

describe("stacks", () => {
  it("parses folded stacks", () => {
    const s = parseFolded(folded);
    expect(s).toHaveLength(3);
    expect(s[0]!.frames).toEqual(["main", "work", "hot"]);
    expect(s[0]!.count).toBe(50);
  });
  it("aggregates self and total", () => {
    const { frames, totalSamples } = aggregateFrames(parseFolded(folded));
    expect(totalSamples).toBe(100);
    const hot = frames.find((f) => f.frame === "hot")!;
    expect(hot.self).toBe(50);
    expect(hot.self_pct).toBe(50);
    const work = frames.find((f) => f.frame === "work")!;
    expect(work.total).toBe(60);
    expect(work.self).toBe(0);
  });
  it("finds hottest stacks", () => {
    const h = hottestStacks(parseFolded(folded), 1);
    expect(h[0]!.stack).toEqual(["main", "work", "hot"]);
    expect(h[0]!.pct).toBe(50);
  });
  it("renders a flamegraph svg", () => {
    const svg = renderFlamegraph(parseFolded(folded), { title: "t" });
    expect(svg).toContain("<svg");
    expect(svg).toContain("hot (50 samples");
    expect(svg).toContain("epoll_wait");
  });
});
