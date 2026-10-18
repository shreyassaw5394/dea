import { describe, expect, it } from "vitest";
import { parsePs, splitArgs, guessKind, detectRuntime, containerIdFromCgroup } from "../src/target.js";
import { diffEvidence } from "../src/diff.js";
import { renderReportFromRuns } from "../src/report.js";
import type { Session, ToolResult } from "../src/contracts.js";

describe("target helpers", () => {
  it("parses ps with two-call join (macOS spaces in comm)", () => {
    const comm = "  876     1 shreyas  0.0  0.2  65968 Creative Cloud Content Manager.node\n 47504 1 shreyas 1.5 0.3 49000 node\n";
    const args = "  876 /Applications/Utilities/Adobe/Creative Cloud Content Manager.node --flag\n 47504 node server.js\n";
    const p = parsePs(comm, args);
    expect(p).toHaveLength(2);
    expect(p[0]!.comm).toBe("Creative Cloud Content Manager.node");
    expect(p[0]!.args).toContain("--flag");
    expect(p[1]).toMatchObject({ pid: 47504, comm: "node", args: "node server.js", rss_kb: 49000 });
  });
  it("splits args with quotes, no shell", () => {
    expect(splitArgs(`node app.js --name "a b" 'c d' e\\ f`)).toEqual(["node", "app.js", "--name", "a b", "c d", "e f"]);
  });
  it("guesses target kinds", () => {
    expect(guessKind("1234")).toBe("pid");
    expect(guessKind("api-1")).toBe("container");
    expect(guessKind("default/web-0")).toBe("pod");
    expect(guessKind("node server.js")).toBe("command");
    expect(guessKind("./run.sh")).toBe("command");
    expect(guessKind("x", "pid")).toBe("pid");
  });
  it("detects runtimes", () => {
    expect(detectRuntime("python3", "python3 app.py")).toBe("python");
    expect(detectRuntime("Python", "/Library/Frameworks/Python.framework/Versions/3.10/Resources/Python.app/Contents/MacOS/Python app.py")).toBe("python");
    expect(detectRuntime("node", "node server.js")).toBe("node");
    expect(detectRuntime("java", "java -jar app.jar")).toBe("java");
    expect(detectRuntime("nginx", "nginx: master process")).toBe("native");
  });
  it("extracts container ids from cgroup", () => {
    expect(containerIdFromCgroup("0::/system.slice/docker-abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890.scope")).toBe("abcdef123456");
    expect(containerIdFromCgroup("0::/user.slice")).toBeUndefined();
  });
});

describe("diff", () => {
  it("finds growth, appearance and disappearance", () => {
    const a = [{ id: "e1", kind: "heap_retainer" as const, summary: "", data: [{ name: "Array", retained_bytes: 100 }, { name: "Gone", retained_bytes: 5 }] }, { id: "e2", kind: "metric" as const, summary: "", data: { name: "rss", rss_kb: 1000 } }];
    const b = [{ id: "e1", kind: "heap_retainer" as const, summary: "", data: [{ name: "Array", retained_bytes: 300 }, { name: "New", retained_bytes: 7 }] }, { id: "e2", kind: "metric" as const, summary: "", data: { name: "rss", rss_kb: 1500 } }];
    const d = diffEvidence(a, b);
    const hr = d.byKind.heap_retainer!;
    expect(hr.find((x) => x.key === "name=Array")).toMatchObject({ status: "grew", delta: 200 });
    expect(hr.find((x) => x.key === "name=New")!.status).toBe("appeared");
    expect(hr.find((x) => x.key === "name=Gone")!.status).toBe("disappeared");
    expect(d.metrics[0]).toMatchObject({ key: "name=rss", status: "grew", delta: 500 });
  });
});

describe("report", () => {
  it("renders findings with evidence pointers and redacts", () => {
    const session: Session = { id: "s1", state: "detached", target: { kind: "pid", id: "1", pid: 1, comm: "node", host: "local" }, created_at: "2026-01-01T00:00:00Z", dir: "/tmp/x", platform: "linux", runs: [] };
    const run: ToolResult = { ok: true, tool: "inspect_sockets", run_id: "inspect_sockets#1", session_id: "s1", target: session.target, duration_ms: 5, findings: [{ id: "f1", severity: "high", summary: "token=abcdef123456 leaked", evidence_ids: ["e1"], confidence: "observed" }], evidence: [{ id: "e1", kind: "socket", summary: "x | y", data: {}, artifact: "/tmp/x/a.txt", lines: [3, 9] }], limitations: ["l1"], suggested_next: ["report"], artifacts: [{ path: "/tmp/x/a.txt", kind: "raw_text", bytes: 10 }] };
    const md = renderReportFromRuns(session, [run]);
    expect(md).toContain("# DEA session s1");
    expect(md).toContain("🔴 **HIGH**");
    expect(md).toContain("`inspect_sockets#1/e1`");
    expect(md).toContain("L3–9");
    expect(md).toContain("[REDACTED]");
    expect(md).not.toContain("abcdef123456");
    expect(md).toContain("x \\| y");
  });
});

describe("investigate summary", () => {
  it("ranks findings by severity with run refs", async () => {
    const { summarizeFindings } = await import("../src/investigate.js");
    const mk = (tool: string, sev: "info" | "warn" | "high"): ToolResult => ({ ok: true, tool, run_id: `${tool}#1`, session_id: "s", target: { kind: "pid", id: "1", host: "local" }, duration_ms: 1, findings: [{ id: "f1", severity: sev, summary: sev, evidence_ids: ["e1"], confidence: "observed" }], evidence: [{ id: "e1", kind: "note", summary: "", data: null }], limitations: [], suggested_next: [], artifacts: [] });
    const r = summarizeFindings([mk("a", "info"), mk("b", "high"), mk("c", "warn")]);
    expect(r.map((x) => x.severity)).toEqual(["high", "warn", "info"]);
    expect(r[0]!.ref).toBe("b#1/e1");
  });
});
