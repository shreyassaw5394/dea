import { describe, expect, it } from "vitest";
import { ToolResult, Finding, exportJsonSchemas } from "../src/contracts.js";
import { ResultBuilder } from "../src/evidence.js";
import { capPayload, redact, clampDuration, assertSafeBpfFragment, assertSafeIdentifier } from "../src/safety.js";

const target = { kind: "pid" as const, id: "1", pid: 1, host: "local" };

describe("contracts", () => {
  it("rejects a finding without evidence ids", () => {
    expect(Finding.safeParse({ id: "f1", severity: "info", summary: "x", evidence_ids: [], confidence: "observed" }).success).toBe(false);
  });
  it("rejects a finding citing unknown evidence", () => {
    const r = ToolResult.safeParse({
      ok: true, tool: "t", session_id: "", target, duration_ms: 0,
      findings: [{ id: "f1", severity: "info", summary: "x", evidence_ids: ["e9"], confidence: "observed" }],
      evidence: [], limitations: [], suggested_next: [], artifacts: [],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain("unknown evidence id");
  });
  it("builder refuses findings without evidence", () => {
    const b = new ResultBuilder("t", null, target);
    expect(() => b.finding("info", "x", [])).toThrow(/without evidence/);
    expect(() => b.finding("info", "x", ["nope"])).toThrow(/unknown evidence/);
    const e = b.evidenceOf("note", "n", { a: 1 });
    b.finding("info", "ok", [e], "inferred");
    const r = b.build();
    expect(r.ok).toBe(true);
    expect(r.findings[0]!.confidence).toBe("inferred");
  });
  it("exports json schemas", () => {
    const s = exportJsonSchemas();
    expect(Object.keys(s)).toContain("ToolResult");
    expect(JSON.stringify(s.ToolResult)).toContain("evidence_ids");
  });
});

describe("safety", () => {
  it("redacts obvious secrets", () => {
    expect(redact("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def");
    expect(redact("AKIAABCDEFGHIJKLMNOP")).toContain("AKIA[REDACTED]");
    expect(redact("password=hunter22 user=bob")).toContain("password=[REDACTED]");
    expect(redact("https://u:p4ssw0rd@host/x")).toContain("u:[REDACTED]@");
    expect(redact("plain text")).toBe("plain text");
  });
  it("caps payload size and records the trim", () => {
    const big = { evidence: [{ data: Array.from({ length: 5000 }, (_, i) => ({ i, s: "x".repeat(50) })), summary: "big" }], limitations: [] as string[] };
    const capped = capPayload(big, 16 * 1024);
    expect(Buffer.byteLength(JSON.stringify(capped))).toBeLessThanOrEqual(16 * 1024 + 512);
    expect(capped.limitations.some((l) => /trimmed/.test(l))).toBe(true);
  });
  it("clamps durations", () => {
    expect(clampDuration(999, 10)).toBe(60);
    expect(clampDuration(undefined, 10)).toBe(10);
    expect(clampDuration(0, 10)).toBe(1);
    expect(clampDuration(45, 10, 30_000)).toBe(30);
  });
  it("rejects unsafe identifiers and filters", () => {
    expect(() => assertSafeIdentifier("api; rm -rf /")).toThrow();
    expect(assertSafeIdentifier("my-container_1")).toBe("my-container_1");
    expect(() => assertSafeBpfFragment("port 80; cat /etc/passwd")).toThrow();
    expect(assertSafeBpfFragment("tcp and port 443")).toBe("tcp and port 443");
  });
});
