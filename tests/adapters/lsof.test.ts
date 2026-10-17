import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { parseLsofFields, summarizeSockets, summarizeFiles, parseProcLimits } from "../../src/adapters/lsof.js";

const fx = (n: string) => readFileSync(new URL(`../fixtures/lsof/${n}`, import.meta.url), "utf8");

describe("lsof parser", () => {
  it("parses -F field output (real macOS node server)", () => {
    const entries = parseLsofFields(fx("node-sockets-fields.txt"));
    expect(entries.length).toBeGreaterThan(0);
    const listen = entries.find((e) => e.tcpState === "LISTEN");
    expect(listen).toBeDefined();
    expect(listen!.name).toMatch(/:3000$/);
    expect(listen!.protocol).toBe("TCP");
    expect(listen!.command).toBe("node");
  });
  it("summarizes sockets", () => {
    const s = summarizeSockets(parseLsofFields(fx("node-sockets-fields.txt")));
    expect(s.listening.some((l) => l.port === 3000)).toBe(true);
    expect(s.total_sockets).toBeGreaterThanOrEqual(1);
  });
  it("summarizes files", () => {
    const f = summarizeFiles(parseLsofFields(fx("node-files-fields.txt")));
    expect(f.total_fds).toBeGreaterThan(5);
    expect(Object.keys(f.byType)).toContain("KQUEUE");
    expect(f.deleted).toEqual([]);
  });
  it("handles synthetic CLOSE_WAIT pileup and deleted files", () => {
    const raw = ["p100", "cnode", "ushreyas", "f20", "au", "tIPv4", "PTCP", "n10.0.0.1:3000->10.0.0.9:51000", "TST=CLOSE_WAIT", "f21", "au", "tIPv4", "PTCP", "n10.0.0.1:3000->10.0.0.9:51001", "TST=CLOSE_WAIT", "f22", "au", "tREG", "s1048576", "n/tmp/big.log (deleted)", ""].join("\n");
    const e = parseLsofFields(raw);
    expect(e).toHaveLength(3);
    const s = summarizeSockets(e);
    expect(s.byState.CLOSE_WAIT).toBe(2);
    expect(s.byRemote[0]!.remote).toBe("10.0.0.9");
    const f = summarizeFiles(e);
    expect(f.deleted).toHaveLength(1);
    expect(f.deleted[0]!.size).toBe(1048576);
  });
  it("parses /proc limits", () => {
    expect(parseProcLimits("Limit  Soft Limit  Hard Limit  Units\nMax open files  1024  524288  files\n")).toEqual({ soft: 1024, hard: 524288 });
    expect(parseProcLimits("Max open files  unlimited  unlimited  files")).toEqual({ soft: Infinity, hard: Infinity });
  });
});
