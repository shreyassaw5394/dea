import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { analyzeText, detectTool } from "../src/analyze.js";
import type { ImportTool } from "../src/contracts.js";

const fx = (dir: string) => {
  const d = join(__dirname, "fixtures", dir);
  const f = readdirSync(d).find((x) => !x.startsWith("."));
  return readFileSync(join(d, f!), "utf8");
};

const CASES: Array<[dir: string, tool: ImportTool]> = [
  ["strace", "strace"],
  ["fs_usage", "fs_usage"],
  ["pyspy", "pyspy_dump"],
  ["gdb", "gdb"],
  ["lldb", "lldb"],
  ["lsof", "lsof"],
  ["tcpdump", "tcpdump"],
  ["sample", "sample"],
];

describe("analyzeText (in-memory, browser-safe path)", () => {
  for (const [dir, tool] of CASES) {
    it(`analyzes ${tool} without a session directory`, async () => {
      const r = await analyzeText(tool, fx(dir));
      expect(r.ok).toBe(true);
      expect(r.evidence.length).toBeGreaterThan(0);
      expect(r.findings.length).toBeGreaterThan(0);
      for (const f of r.findings) expect(f.evidence_ids.length).toBeGreaterThan(0);
      for (const a of r.artifacts) expect(a.path.startsWith("(pasted)")).toBe(true);
    });
  }

  it("fails cleanly on empty input", async () => {
    const r = await analyzeText("strace", "   ");
    expect(r.ok).toBe(false);
  });

  it("fails cleanly on garbage", async () => {
    const r = await analyzeText("pyspy_dump", "hello world\nnothing here");
    expect(r.ok).toBe(false);
  });
});

describe("detectTool", () => {
  for (const [dir, tool] of CASES) {
    it(`detects ${tool}`, () => {
      expect(detectTool(fx(dir))).toBe(tool);
    });
  }
  it("returns undefined for prose", () => {
    expect(detectTool("Dear diary, the server is slow again.")).toBeUndefined();
  });
});
