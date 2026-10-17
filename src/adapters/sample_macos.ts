/**
 * sample adapter (macOS): profile_cpu via `sample PID duration -file out`.
 * We convert sample's call tree into folded stacks and reuse the shared
 * flamegraph/frame summary.
 */
import { readFile } from "node:fs/promises";
import type { Adapter, AdapterContext } from "./types.js";
import type { ToolResult } from "../contracts.js";
import { ResultBuilder } from "../evidence.js";
import { runCapped, clampDuration, looksLikePermissionError, rootRequiredLimitation, LIMITS } from "../safety.js";
import { summarizeProfile } from "./pyspy.js";

/**
 * Convert the "Call graph:" section of `sample` output into folded stacks.
 * sample prints an indented tree like:
 *   2000 Thread_12345   DispatchQueue_1: com.apple.main-thread  (serial)
 *   + 2000 start  (in dyld) + 1234  [0x...]
 *   +   2000 main  (in node) + 56  [0x...]
 *   +     1500 uv_run  (in node) ...
 *   +     ! 400 foo (in node)
 * Each line's leading "+ " / "! " / ": " / "| " characters encode depth.
 * Pure.
 */
export function sampleToFolded(raw: string): string {
  const start = raw.indexOf("Call graph:");
  if (start < 0) return "";
  const end = raw.indexOf("\nTotal number in stack", start);
  const section = raw.slice(start, end > 0 ? end : undefined).split("\n").slice(1);
  const stack: Array<{ depth: number; name: string; count: number; childSum: number }> = [];
  const out: string[] = [];
  const flushLeaf = (node: { name: string; count: number; childSum: number }, path: string[]) => {
    const self = node.count - node.childSum;
    if (self > 0) out.push(`${[...path, node.name].join(";")} ${self}`);
  };
  for (const line of section) {
    if (!line.trim()) continue;
    // prefix = everything before the sample count: 4 spaces, then 2 chars per level ("+ ", "! ", ": ", "| " or "  ").
    const m = /^((?:\s|[+!:|])*?)(\d+)\s+(.+?)(?:\s{2}\(in ([^)]+)\))?(?:\s+\+\s+\d+)?(?:\s+\[0x[0-9a-f]+(?:,0x[0-9a-f]+)?\])?\s*$/.exec(line);
    if (!m) continue;
    const depth = Math.max(0, Math.floor((m[1]!.length - 4) / 2));
    const count = Number(m[2]);
    let name = m[3]!.trim();
    const dso = m[4];
    if (/^Thread_\d+/.test(name)) name = name.replace(/\s+DispatchQueue.*$/, "").replace(/\s{2,}.*$/, "");
    if (dso && !/^Thread_/.test(name)) name = `${name} (${dso})`;
    name = name.replace(/;/g, ",");
    while (stack.length && stack[stack.length - 1]!.depth >= depth) {
      const node = stack.pop()!;
      flushLeaf(node, stack.map((s) => s.name));
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.childSum += count;
    stack.push({ depth, name, count, childSum: 0 });
  }
  while (stack.length) {
    const node = stack.pop()!;
    flushLeaf(node, stack.map((s) => s.name));
  }
  return out.join("\n") + (out.length ? "\n" : "");
}

async function profileCpu(ctx: AdapterContext, args: { duration_s?: number }): Promise<ToolResult> {
  const { session, target } = ctx;
  const b = new ResultBuilder("profile_cpu", session, target);
  if (!target.pid) return b.fail("no pid").build();
  const duration = clampDuration(args.duration_s, 15);
  const out = b.artifactPath("sample.txt");
  const sArgs = [String(target.pid), String(duration), "1", "-mayDie", "-file", out];
  const r = await runCapped("sample", sArgs, { timeoutMs: duration * 1000 + LIMITS.DURATION_SLACK_MS + 10_000 });
  const raw = await readFile(out, "utf8").catch(() => "");
  if (!raw) {
    if (looksLikePermissionError(r.stderr + r.stdout) || /Unable to sample|not permitted|failed to attach|Sampling failed/i.test(r.stderr + r.stdout)) {
      b.limitation(rootRequiredLimitation("profile_cpu", `sample ${sArgs.join(" ")}`));
      b.limitation("macOS: sampling another user's or a hardened process needs sudo");
      return b.fail("sample could not attach").build();
    }
    b.limitation(`sample: ${(r.stderr || r.stdout).trim().slice(0, 300)}`);
    return b.fail("sample produced no output").build();
  }
  await b.addArtifact(out, "raw_text", { description: `sample ${duration}s` });
  const folded = sampleToFolded(raw);
  await b.writeArtifact("sample-folded.txt", folded, "folded_stacks", "folded stacks derived from sample call graph");
  b.limitation("`sample` samples every 1 ms across all threads including idle ones; idle frames (kevent, __psynch_cvwait, mach_msg) are expected to dominate for servers");
  return summarizeProfile(b, folded, duration, "sample", 1000);
}

export const sampleMacosAdapter: Adapter = {
  name: "sample",
  tools: ["profile_cpu"],
  platforms: ["darwin"],
  requires: ["sample"],
  runtimes: ["native", "node", "go", "java", "unknown"],
  install: { darwin: "preinstalled (/usr/bin/sample)" },
  priority: 5,
  async run(tool, args, ctx) {
    if (tool !== "profile_cpu") throw new Error(`sample adapter cannot run ${tool}`);
    return profileCpu(ctx, args as { duration_s?: number });
  },
};
