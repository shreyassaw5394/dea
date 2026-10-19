/**
 * Adapter registry. Each adapter declares the platforms it supports, the
 * binaries it requires, and the tools it serves. Readiness is computed from
 * these declarations; dispatch picks the highest-priority ready adapter whose
 * runtime filter matches the target.
 */
import type { Adapter } from "./types.js";
import type { Readiness, Target } from "../contracts.js";
import { lsofAdapter } from "./lsof.js";
import { pyspyAdapter } from "./pyspy.js";
import { straceAdapter } from "./strace.js";
import { gdbAdapter } from "./gdb.js";
import { lldbAdapter } from "./lldb.js";
import { heapNodeAdapter } from "./heap_node.js";
import { perfAdapter } from "./perf.js";
import { tcpdumpAdapter } from "./tcpdump.js";
import { dockerAdapter } from "./docker.js";
import { sampleMacosAdapter } from "./sample_macos.js";
import { bpftraceAdapter } from "./bpftrace.js";
import { psmemAdapter } from "./psmem.js";
import { fsUsageAdapter } from "./fs_usage.js";
import { jvmAdapter } from "./jvm.js";

export const adapters: Adapter[] = [
  jvmAdapter,
  lsofAdapter,
  pyspyAdapter,
  straceAdapter,
  fsUsageAdapter,
  gdbAdapter,
  lldbAdapter,
  heapNodeAdapter,
  psmemAdapter,
  perfAdapter,
  sampleMacosAdapter,
  tcpdumpAdapter,
  dockerAdapter,
  bpftraceAdapter,
];

export interface Candidate {
  adapter: Adapter;
  reason?: string;
}

/** All adapters that could serve `tool` for `target`, ready ones first by priority. */
export function candidatesFor(tool: string, target: Target, readiness: Readiness): { ready: Adapter[]; blocked: Candidate[] } {
  const ready: Adapter[] = [];
  const blocked: Candidate[] = [];
  for (const a of adapters) {
    if (!a.tools.includes(tool)) continue;
    const status = readiness.providers.find((p) => p.name === a.name);
    if (a.runtimes && target.runtime && !a.runtimes.includes(target.runtime)) {
      blocked.push({ adapter: a, reason: `serves ${a.runtimes.join("/")} targets, target is ${target.runtime}` });
      continue;
    }
    if (!status || status.status !== "ready") {
      blocked.push({ adapter: a, reason: `${status?.status ?? "unknown"}${status?.install_hint ? ` — ${status.install_hint}` : ""}` });
      continue;
    }
    ready.push(a);
  }
  ready.sort((x, y) => (y.priority ?? 0) - (x.priority ?? 0));
  return { ready, blocked };
}
