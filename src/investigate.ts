/**
 * `debuganything why <target>` — a one-command investigation for people without an agent.
 * Runs the same tool sequence the MCP prompts prescribe, prints each result,
 * and ends with a ranked summary + report path. Skips tools readiness says are
 * unavailable instead of failing.
 */
import type { ToolResult } from "./contracts.js";
import { runTool, cachedReadiness } from "./tools.js";

export type Symptom = "slow" | "leak" | "hang" | "crash" | "triage";

export interface InvestigateOptions {
  symptom: Symptom;
  kind?: "pid" | "container" | "pod" | "command";
  /** Seconds to wait between the two memory snapshots (leak). */
  waitS?: number;
  /** Profile / trace durations. */
  durationS?: number;
  /** Allow capture_traffic (needs consent). */
  consent?: boolean;
  onResult?: (r: ToolResult) => void;
  onNote?: (s: string) => void;
}

const PLANS: Record<Symptom, Array<{ tool: string; args?: (o: InvestigateOptions) => Record<string, unknown>; note?: string }>> = {
  slow: [
    { tool: "snapshot_memory", args: () => ({ window_s: 2, heap: false }) },
    { tool: "profile_cpu", args: (o) => ({ duration_s: o.durationS ?? 10 }) },
    { tool: "trace_syscalls", args: (o) => ({ duration_s: Math.min(o.durationS ?? 10, 10), categories: ["file", "network"] }) },
    { tool: "inspect_sockets" },
  ],
  leak: [
    { tool: "snapshot_memory", args: () => ({ window_s: 2 }) },
    { tool: "__wait__", note: "exercise the target now (send traffic, run the job)" },
    { tool: "snapshot_memory", args: () => ({ window_s: 2 }) },
    { tool: "diff_runs", args: () => ({ a: "snapshot_memory", b: "snapshot_memory" }) },
  ],
  hang: [
    { tool: "dump_stacks" },
    { tool: "inspect_sockets" },
    { tool: "trace_syscalls", args: () => ({ duration_s: 5, categories: ["all"] }) },
    { tool: "dump_stacks", note: "second snapshot: identical positions confirm a hang" },
  ],
  crash: [{ tool: "container_info" }, { tool: "snapshot_memory", args: () => ({ window_s: 2 }) }],
  triage: [
    { tool: "inspect_sockets" },
    { tool: "inspect_files", args: () => ({ window_s: 2 }) },
    { tool: "snapshot_memory", args: () => ({ window_s: 2 }) },
    { tool: "dump_stacks" },
    { tool: "profile_cpu", args: (o) => ({ duration_s: o.durationS ?? 8 }) },
  ],
};

export interface InvestigateOutcome {
  session_id: string;
  results: ToolResult[];
  report_path?: string;
}

export async function investigate(target: string, opts: InvestigateOptions): Promise<InvestigateOutcome> {
  const note = opts.onNote ?? (() => {});
  const emit = opts.onResult ?? (() => {});
  const readiness = await cachedReadiness();
  const attach = await runTool("attach", { target, kind: opts.kind });
  emit(attach);
  if (!attach.ok) return { session_id: "", results: [attach] };
  const session_id = attach.session_id;
  const results: ToolResult[] = [attach];
  let firstMem: string | undefined;
  for (const step of PLANS[opts.symptom]) {
    if (step.tool === "__wait__") {
      const w = opts.waitS ?? 15;
      note(`waiting ${w}s — ${step.note}`);
      await new Promise((r) => setTimeout(r, w * 1000));
      continue;
    }
    if (!readiness.tools_available.includes(step.tool)) {
      const reason = readiness.tools_unavailable.find((u) => u.tool === step.tool)?.reason ?? "unavailable";
      note(`skipping ${step.tool}: ${reason}`);
      continue;
    }
    if (step.tool === "container_info" && attach.target.kind !== "container" && attach.target.kind !== "pod") {
      note("skipping container_info: target is not a container");
      continue;
    }
    if (step.note) note(step.note);
    let args = step.args?.(opts) ?? {};
    if (step.tool === "diff_runs") {
      const mems = results.filter((r) => r.tool === "snapshot_memory" && r.run_id).map((r) => r.run_id!);
      if (mems.length < 2) {
        note("skipping diff_runs: need two snapshot_memory runs");
        continue;
      }
      args = { a: mems[mems.length - 2], b: mems[mems.length - 1] };
    }
    const r = await runTool(step.tool, { session_id, ...args });
    results.push(r);
    emit(r);
    if (step.tool === "snapshot_memory" && !firstMem) firstMem = r.run_id;
  }
  const report = await runTool("report", { session_id });
  results.push(report);
  const detach = await runTool("detach", { session_id });
  results.push(detach);
  return { session_id, results, report_path: report.artifacts[0]?.path };
}

/** Rank all findings across results for the final summary. Pure. */
export function summarizeFindings(results: ToolResult[]): Array<{ severity: string; summary: string; ref: string; confidence: string }> {
  const order = { high: 0, warn: 1, info: 2 } as const;
  return results
    .flatMap((r) => r.findings.map((f) => ({ severity: f.severity, summary: f.summary, ref: `${r.run_id ?? r.tool}/${f.evidence_ids.join(",")}`, confidence: f.confidence })))
    .sort((a, b) => order[a.severity as keyof typeof order] - order[b.severity as keyof typeof order]);
}
