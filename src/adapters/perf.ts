/**
 * perf adapter (Linux): profile_cpu for native / Node / Go / Java targets.
 *   perf record -F 99 -g -p PID -o <file> -- sleep N
 *   perf script -i <file>  → folded stacks (our own folder, no Perl) → flamegraph.svg
 * Node: symbols need `--perf-basic-prof` on the target; we say so.
 */
import { readFile } from "node:fs/promises";
import type { Adapter, AdapterContext } from "./types.js";
import type { ToolResult } from "../contracts.js";
import { ResultBuilder } from "../evidence.js";
import { runCapped, clampDuration, looksLikePermissionError, rootRequiredLimitation, LIMITS } from "../safety.js";
import { summarizeProfile } from "./pyspy.js";

/**
 * Fold `perf script` output into "frame;frame;frame count" lines. Pure.
 * perf script prints one sample header line followed by indented stack lines
 * (leaf first) and a blank line:
 *   node 1234 5678.123456:     250000 cpu-clock:
 *           7f0a2b1c0a3e epoll_wait+0x4e (/usr/lib/libc.so.6)
 *           5a3c1b uv__io_poll+0x1ab (/usr/bin/node)
 */
export function perfScriptToFolded(raw: string, opts: { includeComm?: boolean } = {}): string {
  const counts = new Map<string, number>();
  let comm: string | null = null;
  let frames: string[] = [];
  const flush = () => {
    if (comm !== null && frames.length) {
      const stack = [...(opts.includeComm ? [comm] : []), ...frames.reverse()];
      const key = stack.join(";");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    comm = null;
    frames = [];
  };
  for (const line of raw.split("\n")) {
    if (!line.trim()) {
      flush();
      continue;
    }
    if (!/^\s/.test(line)) {
      // header: comm pid [cpu] time: period event:
      flush();
      const m = /^(\S+)\s+\d+/.exec(line);
      comm = m ? m[1]! : "?";
      continue;
    }
    const m = /^\s+[0-9a-f]+\s+(.+?)(?:\+0x[0-9a-f]+)?\s+\((.*)\)\s*$/.exec(line);
    if (m && comm !== null) {
      let sym = m[1]!;
      const dso = m[2]!;
      if (sym === "[unknown]") sym = `[unknown] (${dso.split("/").pop()})`;
      frames.push(sym.replace(/;/g, ","));
    }
  }
  flush();
  return [...counts].map(([k, v]) => `${k} ${v}`).join("\n") + (counts.size ? "\n" : "");
}

async function profileCpu(ctx: AdapterContext, args: { duration_s?: number }): Promise<ToolResult> {
  const { session, target } = ctx;
  const b = new ResultBuilder("profile_cpu", session, target);
  if (!target.pid) return b.fail("no pid").build();
  const duration = clampDuration(args.duration_s, 15);
  const dataPath = b.artifactPath("perf.data");
  const recArgs = ["record", "-F", "99", "-g", "--call-graph", "fp", "-p", String(target.pid), "-o", dataPath, "--", "sleep", String(duration)];
  const rec = await runCapped("perf", recArgs, { timeoutMs: duration * 1000 + LIMITS.DURATION_SLACK_MS + 10_000 });
  if (rec.exitCode !== 0 || looksLikePermissionError(rec.stderr) || /perf_event_open|Permission|not permitted/i.test(rec.stderr)) {
    await b.writeArtifact("perf-stderr.txt", rec.stderr, "raw_text");
    if (looksLikePermissionError(rec.stderr) || /paranoid|perf_event_open/i.test(rec.stderr)) {
      b.limitation(rootRequiredLimitation("profile_cpu", `perf ${recArgs.join(" ")}`));
      b.limitation("Linux: lower kernel.perf_event_paranoid to 1 (sudo sysctl kernel.perf_event_paranoid=1) or grant CAP_PERFMON; inside Docker add --cap-add PERFMON --cap-add SYS_ADMIN");
      return b.fail("perf record needs permissions").build();
    }
    b.limitation(`perf record exited ${rec.exitCode}: ${rec.stderr.trim().slice(0, 300)}`);
    return b.fail("perf record failed").build();
  }
  const scriptPath = b.artifactPath("perf-script.txt");
  const scr = await runCapped("perf", ["script", "-i", dataPath, "-F", "comm,pid,time,event,ip,sym,dso"], { timeoutMs: 60_000, stdoutFile: scriptPath });
  const raw = await readFile(scriptPath, "utf8").catch(() => "");
  await b.addArtifact(dataPath, "raw_text", { description: "perf.data (binary)" });
  await b.addArtifact(scriptPath, "raw_text", { description: "perf script output", truncated: scr.outputCapped });
  const folded = perfScriptToFolded(raw);
  await b.writeArtifact("perf-folded.txt", folded, "folded_stacks", "folded stacks");
  const unknown = (folded.match(/\[unknown\]/g) ?? []).length;
  if (unknown > 0) b.limitation(`${unknown} stack frames have no symbols${target.runtime === "node" ? " — start Node with --perf-basic-prof (or --perf-prof) so JIT frames get names" : target.runtime === "java" ? " — use perf-map-agent or async-profiler for JIT frames" : "; install debug symbols or build with frame pointers"}`);
  b.limitation("perf samples at 99 Hz with frame-pointer unwinding; frames may be missing in code built without frame pointers (use --call-graph dwarf manually for those)");
  return summarizeProfile(b, folded, duration, "perf", 99);
}

export const perfAdapter: Adapter = {
  name: "perf",
  tools: ["profile_cpu"],
  platforms: ["linux"],
  requires: ["perf"],
  runtimes: ["native", "node", "go", "java", "unknown"],
  install: { linux: "sudo apt install linux-perf  (Debian/Ubuntu: linux-tools-$(uname -r))  |  sudo dnf install perf" },
  priority: 5,
  check(base, env) {
    if (env.perfParanoid !== null && env.perfParanoid > 1 && !env.isRoot) base.notes.push(`perf_event_paranoid=${env.perfParanoid}: cannot profile other processes without root`);
    return base;
  },
  async run(tool, args, ctx) {
    if (tool !== "profile_cpu") throw new Error(`perf adapter cannot run ${tool}`);
    return profileCpu(ctx, args as { duration_s?: number });
  },
};
