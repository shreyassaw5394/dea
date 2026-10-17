/**
 * psmem adapter: generic snapshot_memory for any runtime — RSS/VSZ sampled
 * over a window via ps (works everywhere, no root). Node and Python adapters
 * build on top of it.
 */
import { readFile } from "node:fs/promises";
import type { Adapter, AdapterContext } from "./types.js";
import type { ToolResult } from "../contracts.js";
import { ResultBuilder, humanBytes } from "../evidence.js";
import { runCapped } from "../safety.js";
import { platform } from "../session.js";
import { targetPids } from "../target.js";

export interface MemSample {
  t_ms: number;
  rss_kb: number;
  vsz_kb: number;
  cpu: number;
  threads?: number;
}

/** Parse `ps -o rss=,vsz=,%cpu= -p PID` (one line). Pure. */
export function parsePsMem(raw: string): { rss_kb: number; vsz_kb: number; cpu: number } | undefined {
  const m = /^\s*(\d+)\s+(\d+)\s+([\d.]+)/.exec(raw);
  if (!m) return undefined;
  return { rss_kb: Number(m[1]), vsz_kb: Number(m[2]), cpu: Number(m[3]) };
}

/** Parse Linux /proc/<pid>/status for memory fields. Pure. */
export function parseProcStatus(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of ["VmRSS", "VmHWM", "VmSize", "VmSwap", "RssAnon", "RssFile", "RssShmem", "Threads"]) {
    const m = new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(text);
    if (m) out[key] = Number(m[1]);
  }
  return out;
}

export async function sampleMemory(pids: number[], windowS: number, intervalMs = 500): Promise<MemSample[]> {
  const samples: MemSample[] = [];
  const start = Date.now();
  const n = windowS <= 0 ? 1 : Math.max(2, Math.floor((windowS * 1000) / intervalMs) + 1);
  for (let i = 0; i < n; i++) {
    const r = await runCapped("ps", ["-o", "rss=,vsz=,%cpu=", "-p", pids.join(",")], { timeoutMs: 5000 });
    let rss = 0;
    let vsz = 0;
    let cpu = 0;
    for (const line of r.stdout.split("\n")) {
      const p = parsePsMem(line);
      if (p) {
        rss += p.rss_kb;
        vsz += p.vsz_kb;
        cpu += p.cpu;
      }
    }
    samples.push({ t_ms: Date.now() - start, rss_kb: rss, vsz_kb: vsz, cpu });
    if (i < n - 1) await new Promise((res) => setTimeout(res, intervalMs));
  }
  return samples;
}

export async function snapshotMemoryGeneric(ctx: AdapterContext, args: { window_s?: number }): Promise<ToolResult> {
  const { session, target } = ctx;
  const b = new ResultBuilder("snapshot_memory", session, target);
  const pids = targetPids(target);
  if (!pids.length) return b.fail("no pid").build();
  const window = Math.min(args.window_s ?? 3, 30);
  const samples = await sampleMemory(pids, window);
  if (!samples.length || samples.every((s) => s.rss_kb === 0)) return b.fail("ps returned no memory data (process gone?)").build();
  const first = samples[0]!;
  const last = samples[samples.length - 1]!;
  const art = await b.writeArtifact("mem-samples.json", JSON.stringify(samples, null, 2), "json", "RSS/VSZ samples");
  const rssEv = b.evidenceOf("metric", `rss=${humanBytes(last.rss_kb * 1024)} vsz=${humanBytes(last.vsz_kb * 1024)} cpu=${last.cpu}% (${pids.length} pid${pids.length > 1 ? "s" : ""})`, { name: "rss", rss_kb: last.rss_kb, vsz_kb: last.vsz_kb, cpu: last.cpu, pids: pids.length }, { artifact: art });
  const seriesEv = b.evidenceOf("metric_series", `rss ${humanBytes(first.rss_kb * 1024)} → ${humanBytes(last.rss_kb * 1024)} over ${window}s (${samples.length} samples)`, { name: "rss_series", value: last.rss_kb, start_kb: first.rss_kb, end_kb: last.rss_kb, delta_kb: last.rss_kb - first.rss_kb, window_s: window, samples: samples.length }, { artifact: art });
  if (platform() === "linux" && target.pid) {
    try {
      const st = parseProcStatus(await readFile(`/proc/${target.pid}/status`, "utf8"));
      b.evidenceOf("metric", `proc status: HWM=${humanBytes((st.VmHWM ?? 0) * 1024)} anon=${humanBytes((st.RssAnon ?? 0) * 1024)} file=${humanBytes((st.RssFile ?? 0) * 1024)} swap=${humanBytes((st.VmSwap ?? 0) * 1024)} threads=${st.Threads ?? "?"}`, { name: "proc_status", ...st });
    } catch {
      /* ignore */
    }
  }
  const delta = last.rss_kb - first.rss_kb;
  if (window > 0 && delta > Math.max(10 * 1024, first.rss_kb * 0.05)) {
    b.finding("warn", `RSS grew ${humanBytes(delta * 1024)} in ${window}s (${humanBytes(first.rss_kb * 1024)} → ${humanBytes(last.rss_kb * 1024)})`, [seriesEv], "observed", "Take another snapshot_memory after exercising the target and diff_runs them.");
  } else {
    b.finding("info", `RSS ${humanBytes(last.rss_kb * 1024)}, stable over ${window}s`, [rssEv, seriesEv]);
  }
  b.limitation(`RSS sampled ${samples.length}× over ${window}s via ps; no allocation-site attribution for runtime ${target.runtime ?? "unknown"}`);
  b.next("snapshot_memory (again, after load)", "diff_runs");
  return b.build();
}

export const psmemAdapter: Adapter = {
  name: "ps",
  tools: ["snapshot_memory"],
  platforms: ["linux", "darwin"],
  requires: ["ps"],
  priority: 1,
  async run(tool, args, ctx) {
    if (tool !== "snapshot_memory") throw new Error(`ps adapter cannot run ${tool}`);
    return snapshotMemoryGeneric(ctx, args as { window_s?: number });
  },
};
