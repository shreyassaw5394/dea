import { describe, expect, it, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importArtifact, spanSeconds, IMPORT_TOOL_MAP } from "../src/import.js";
import { createSession } from "../src/session.js";
import type { Session } from "../src/contracts.js";

const fx = (p: string) => new URL(`./fixtures/${p}`, import.meta.url).pathname;
let session: Session;
beforeAll(async () => {
  process.env.DEA_HOME = mkdtempSync(join(tmpdir(), "dea-import-"));
  session = await createSession({ kind: "pid", id: "1", pid: 1, comm: "x", host: "local" });
});

describe("dea import", () => {
  it("maps every import tool to a DEA tool", () => {
    expect(Object.values(IMPORT_TOOL_MAP).every((t) => typeof t === "string")).toBe(true);
  });
  it("imports a real strace log into trace_syscalls findings", async () => {
    const r = await importArtifact(session, { tool: "strace", path: fx("strace/node-slow.log") });
    expect(r.ok).toBe(true);
    expect(r.tool).toBe("trace_syscalls");
    expect(r.evidence.some((e) => e.kind === "syscall_stat")).toBe(true);
    expect(r.findings.length).toBeGreaterThan(0);
    expect(r.limitations.some((l) => /imported from/.test(l))).toBe(true);
    expect(r.artifacts[0]!.path).toContain("imported-");
  });
  it("imports fs_usage output (macOS) with errno findings", async () => {
    const r = await importArtifact(session, { tool: "fs_usage", path: fx("fs_usage/node-slow.txt") });
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => /ECONNREFUSED/.test(f.summary))).toBe(true);
  });
  it("imports a py-spy dump into dump_stacks findings", async () => {
    const r = await importArtifact(session, { tool: "pyspy_dump", path: fx("pyspy/deadlock-dump.txt") });
    expect(r.ok).toBe(true);
    expect(r.tool).toBe("dump_stacks");
    expect(r.evidence.some((e) => e.kind === "lock_wait")).toBe(true);
  });
  it("imports perf script, sample and lldb output", async () => {
    const perf = await importArtifact(session, { tool: "perf_script", path: fx("perf/node-script.txt"), duration_s: 8 });
    expect(perf.ok).toBe(true);
    expect(perf.artifacts.some((a) => a.kind === "flamegraph_svg")).toBe(true);
    const sample = await importArtifact(session, { tool: "sample", path: fx("sample/node-idle.txt"), duration_s: 5 });
    expect(sample.ok).toBe(true);
    const lldb = await importArtifact(session, { tool: "lldb", path: fx("lldb/node-idle.txt") });
    expect(lldb.ok).toBe(true);
    expect(lldb.evidence.some((e) => e.kind === "stack_summary")).toBe(true);
  });
  it("imports lsof -F output", async () => {
    const r = await importArtifact(session, { tool: "lsof", path: fx("lsof/node-sockets-fields.txt") });
    expect(r.ok).toBe(true);
    expect(r.findings.some((f) => /listening on/.test(f.summary))).toBe(true);
  });
  it("fails cleanly on garbage", async () => {
    const r = await importArtifact(session, { tool: "strace", path: fx("sample/node-idle.txt") });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no strace records/);
  });
  it("estimates duration from timestamps", () => {
    expect(spanSeconds([{ time: "10:00:00.000", name: "a", args: "", result: "0", line: 1 }, { time: "10:00:07.500", name: "b", args: "", result: "0", line: 2 }])).toBe(8);
    expect(spanSeconds([])).toBeUndefined();
  });
});
