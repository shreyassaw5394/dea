import { describe, expect, it } from "vitest";
import { renderHtmlReportFromRuns } from "../src/report_html.js";
import type { Session, ToolResult } from "../src/contracts.js";

const session: Session = {
  id: "s1", state: "detached", created_at: "2026-10-19T00:00:00Z", dir: "/tmp/s1", platform: "linux",
  target: { kind: "pid", id: "123", pid: 123, comm: "node", host: "box" },
  runs: [],
};
const run: ToolResult = {
  tool: "inspect_sockets", run_id: "inspect_sockets#1", session_id: "s1", ok: true, started_at: "2026-10-19T00:00:01Z", duration_ms: 42,
  target: session.target,
  evidence: [{ id: "e1", kind: "socket_summary", summary: "26 sockets in CLOSE_WAIT <script>alert(1)</script>", data: { CLOSE_WAIT: 26 } }],
  findings: [{ id: "f1", severity: "high", summary: "socket leak & <b>bold</b>", evidence_ids: ["e1"], confidence: "observed" }],
  artifacts: [], limitations: ["lim one"], suggested_next: [],
};

describe("renderHtmlReportFromRuns", () => {
  const html = renderHtmlReportFromRuns(session, [run], [{ name: "f.svg", svg: "<svg><script>evil()</script><rect/></svg>" }]);
  it("is a complete standalone document", () => {
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("DEA report");
    expect(html).not.toContain("http://"); // no external resources
  });
  it("renders findings with evidence and escapes HTML", () => {
    expect(html).toContain("socket leak &amp; &lt;b&gt;bold&lt;/b&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert(1)</script>");
  });
  it("strips scripts from embedded flamegraphs", () => {
    expect(html).toContain("<rect/>");
    expect(html).not.toContain("evil()");
  });
  it("shows severity counts and limitations", () => {
    expect(html).toContain("1 high");
    expect(html).toContain("lim one");
  });
});
