import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { parsePySpyDump, findLockWaits, sameLockGroups, mergeResults } from "../../src/adapters/pyspy.js";

const DEADLOCK = `Process 4321: python3 app.py
Python v3.10.9 (/usr/bin/python3.10)

Thread 0x7F1A2B3C4D00 (idle): "MainThread"
    select (selectors.py:416)
    serve_forever (socketserver.py:232)
    <module> (app.py:70)
Thread 0x7F1A2A000700 (idle): "worker-ab-20"
    worker_ab (app.py:22)
        Arguments:
            n: 20
        Locals:
            self: <_thread.lock object at 0x7f1a2c0f0a80>
    run (threading.py:953)
    _bootstrap_inner (threading.py:1016)
    _bootstrap (threading.py:973)
Thread 0x7F1A29800700 (idle): "worker-ba-20"
    worker_ba (app.py:29)
    run (threading.py:953)
    _bootstrap_inner (threading.py:1016)
    _bootstrap (threading.py:973)
Thread 0x7F1A29000700 (idle): "Thread-3 (process_request_thread)"
    _wait_for_tstate_lock (threading.py:1116)
    join (threading.py:1096)
    do_GET (app.py:45)
`;

describe("py-spy dump parser", () => {
  it("parses threads, frames and locals", () => {
    const d = parsePySpyDump(DEADLOCK);
    expect(d.pid).toBe(4321);
    expect(d.python).toBe("3.10.9");
    expect(d.threads.map((t) => t.name)).toEqual(["MainThread", "worker-ab-20", "worker-ba-20", "Thread-3 (process_request_thread)"]);
    expect(d.threads[1]!.frames[0]!.locals).toMatchObject({ n: "20" });
  });
  it("classifies waits using the source line when readable", () => {
    const src = (f: string) => (f === "app.py" ? ["", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "    with lock_b:", "", "", "", "", "", "", "    with lock_a:", ""].join("\n") : undefined);
    const waits = findLockWaits(parsePySpyDump(DEADLOCK), src);
    const byThread = Object.fromEntries(waits.map((w) => [w.thread, w]));
    expect(byThread["worker-ab-20"]!.kind).toBe("lock");
    expect(byThread["worker-ab-20"]!.source).toBe("with lock_b:");
    expect(byThread["worker-ba-20"]!.kind).toBe("lock");
    expect(byThread["Thread-3 (process_request_thread)"]!.kind).toBe("join");
    expect(byThread["MainThread"]!.kind).toBe("io");
    expect(sameLockGroups(waits)).toEqual([]);
  });
  it("falls back to native when the source is unreadable", () => {
    const waits = findLockWaits(parsePySpyDump(DEADLOCK), () => undefined);
    expect(waits.find((w) => w.thread === "worker-ab-20")!.kind).toBe("native");
  });
  it("merges results renumbering evidence ids", () => {
    const base = { ok: true, tool: "t", session_id: "s", target: { kind: "pid" as const, id: "1", host: "local" }, duration_ms: 1, findings: [{ id: "f1", severity: "info" as const, summary: "a", evidence_ids: ["e1"], confidence: "observed" as const }], evidence: [{ id: "e1", kind: "note" as const, summary: "x", data: 1 }], limitations: [], suggested_next: [], artifacts: [] };
    const extra = { ...base, findings: [{ id: "f1", severity: "warn" as const, summary: "b", evidence_ids: ["e1"], confidence: "observed" as const }], evidence: [{ id: "e1", kind: "note" as const, summary: "y", data: 2 }] };
    const m = mergeResults(base, extra);
    expect(m.evidence.map((e) => e.id)).toEqual(["e1", "e2"]);
    expect(m.findings[1]!.evidence_ids).toEqual(["e2"]);
  });
  it("parses a real fixture when present", () => {
    const p = new URL("../fixtures/pyspy/deadlock-dump.txt", import.meta.url);
    if (!existsSync(p)) return;
    const d = parsePySpyDump(readFileSync(p, "utf8"));
    expect(d.threads.length).toBeGreaterThan(1);
    const waits = findLockWaits(d, () => undefined);
    expect(waits.filter((w) => w.kind === "join").length).toBeGreaterThanOrEqual(2);
    expect(waits.filter((w) => w.kind === "native" && /worker_(ab|ba)/.test(w.at)).length).toBeGreaterThanOrEqual(2);
  });
});
