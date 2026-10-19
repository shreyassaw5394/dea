/**
 * Pure analysis of captured tool output: the same parsers and finding logic
 * the live adapters and `debuganything import` use, with no filesystem dependency.
 * This is the module the in-browser analyzer on debuganything.dev builds from.
 */
import type { ImportTool, ToolResult } from "./contracts.js";
import { ResultBuilder, humanBytes } from "./evidence.js";
import { parseStrace, summarizeSyscallRecords, type SyscallRecord } from "./adapters/strace.js";
import { parseFsUsage } from "./adapters/fs_usage.js";
import { perfScriptToFolded } from "./adapters/perf.js";
import { parsePySpyDump, summarizePySpyDump, summarizeProfile } from "./adapters/pyspy.js";
import { sampleToFolded } from "./adapters/sample_macos.js";
import { parseGdbBacktrace, summarizeNativeStacks } from "./adapters/gdb.js";
import { parseLldbBacktrace } from "./adapters/lldb.js";
import { parseLsofFields, summarizeSockets, summarizeFiles } from "./adapters/lsof.js";
import { parseTcpdump, summarizeCaptureEvidence } from "./adapters/tcpdump.js";
import { parseJstack, summarizeJavaStacks } from "./adapters/jvm.js";
import { parseGoroutines, summarizeGoroutines } from "./adapters/goruntime.js";

/** Which Debug Anything tool an imported file corresponds to (so diff_runs/report treat it like a live run). */
export const IMPORT_TOOL_MAP: Record<ImportTool, string> = {
  strace: "trace_syscalls",
  fs_usage: "trace_syscalls",
  perf_script: "profile_cpu",
  folded: "profile_cpu",
  pyspy_dump: "dump_stacks",
  sample: "profile_cpu",
  gdb: "dump_stacks",
  lldb: "dump_stacks",
  lsof: "inspect_sockets",
  tcpdump: "capture_traffic",
  jstack: "dump_stacks",
  goroutines: "dump_stacks",
};

/** Seconds between first and last timestamp of records with HH:MM:SS.ffffff times. Pure. */
export function spanSeconds(records: SyscallRecord[]): number | undefined {
  const ts = records.map((r) => r.time).filter((t): t is string => Boolean(t));
  if (ts.length < 2) return undefined;
  const toS = (t: string) => {
    const [h, m, s] = t.split(":");
    return Number(h) * 3600 + Number(m) * 60 + Number(s);
  };
  let span = toS(ts[ts.length - 1]!) - toS(ts[0]!);
  if (span < 0) span += 86400;
  return Math.max(1, Math.round(span));
}

/** Run the import analysis for one tool's raw text on an existing builder. `art` is the registered raw artifact path. */
export async function analyzeRaw(b: ResultBuilder, args: { tool: ImportTool; raw: string; duration_s?: number; art: string }): Promise<ToolResult> {
  const raw = args.raw;
  const art = args.art;
  switch (args.tool) {
    case "strace":
    case "fs_usage": {
      const records = args.tool === "strace" ? parseStrace(raw) : parseFsUsage(raw);
      if (!records.length) return b.fail(`no ${args.tool} records parsed; expected ${args.tool === "strace" ? "strace -f -T -tt" : "fs_usage -w"} output`).build();
      const duration = args.duration_s ?? spanSeconds(records) ?? 1;
      summarizeSyscallRecords(b, records, duration, art);
      if (args.tool === "fs_usage") b.limitation("fs_usage shows file and network calls only; futex/select/kevent waits are not included");
      b.next("profile_cpu", "inspect_sockets");
      return b.build();
    }
    case "perf_script":
    case "folded":
    case "sample": {
      const folded = args.tool === "perf_script" ? perfScriptToFolded(raw) : args.tool === "sample" ? sampleToFolded(raw) : raw;
      if (!folded.trim()) return b.fail(`no stacks parsed from ${args.tool} output`).build();
      await b.writeArtifact("imported-folded.txt", folded, "folded_stacks", "folded stacks");
      const duration = args.duration_s ?? 10;
      if (!args.duration_s) b.limitation("duration not given; assumed 10 s for rate estimates (pass duration_s)");
      const hz = args.tool === "perf_script" ? 99 : args.tool === "sample" ? 1000 : undefined;
      return summarizeProfile(b, folded, duration, args.tool === "perf_script" ? "perf" : args.tool, hz);
    }
    case "pyspy_dump": {
      const dump = parsePySpyDump(raw);
      if (!dump.threads.length) return b.fail("no threads parsed; expected `py-spy dump` output").build();
      await summarizePySpyDump(b, dump, art, undefined);
      b.limitation("relative source paths could not be resolved (no live process); run with --locals or from the app directory for lock classification");
      return b.build();
    }
    case "jstack": {
      const dump = parseJstack(raw);
      return summarizeJavaStacks(b, dump, art);
    }
    case "goroutines": {
      const gs = parseGoroutines(raw);
      return summarizeGoroutines(b, gs, art);
    }
    case "gdb":
    case "lldb": {
      const threads = args.tool === "gdb" ? parseGdbBacktrace(raw) : parseLldbBacktrace(raw);
      return summarizeNativeStacks(b, threads, art, args.tool);
    }
    case "lsof": {
      const entries = parseLsofFields(raw);
      if (!entries.length) return b.fail("no lsof entries parsed; expected `lsof -nP -F pcufatsinTP` output").build();
      const s = summarizeSockets(entries);
      const f = summarizeFiles(entries);
      const listenEv = b.evidenceOf("socket_summary", s.listening.length ? `listening: ${s.listening.map((l) => `${l.proto} ${l.addr}:${l.port} (pid ${l.pid})`).join(", ")}` : "no listening sockets", s.listening, { artifact: art });
      const stateEv = b.evidenceOf("socket_summary", `${s.total_sockets} inet socket(s): ${Object.entries(s.byState).map(([k, v]) => `${k}=${v}`).join(" ") || "none established"}; udp=${s.udp}; unix=${s.unix_sockets}`, { by_state: s.byState, total: s.total_sockets }, { artifact: art });
      const remoteEv = b.evidenceOf("socket", s.byRemote.length ? `top remotes: ${s.byRemote.slice(0, 5).map((r) => `${r.remote} ×${r.count}`).join(", ")}` : "no remote connections", s.byRemote.slice(0, 30), { artifact: art });
      const fdEv = b.evidenceOf("fd_summary", `${f.total_fds} fd(s): ${Object.entries(f.byType).sort((a, c) => c[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ")}`, Object.entries(f.byType).map(([type, count]) => ({ type, count })), { artifact: art });
      if (s.listening.length) b.finding("info", `listening on ${s.listening.map((l) => `${l.proto}/${l.port}`).join(", ")}`, [listenEv]);
      const cw = s.byState.CLOSE_WAIT ?? 0;
      if (cw >= 20) b.finding("high", `${cw} sockets in CLOSE_WAIT — the peer closed and the target never called close()`, [stateEv], "inferred");
      else if (cw >= 5) b.finding("warn", `${cw} sockets in CLOSE_WAIT`, [stateEv], "inferred");
      if ((s.byState.TIME_WAIT ?? 0) >= 100) b.finding("warn", `${s.byState.TIME_WAIT} sockets in TIME_WAIT — connection churn`, [stateEv], "inferred");
      if (s.byRemote[0] && s.byRemote[0].count >= 50) b.finding("warn", `${s.byRemote[0].count} connections to ${s.byRemote[0].remote}`, [remoteEv], "inferred");
      if (f.deleted.length) {
        const delEv = b.evidenceOf("fd", `${f.deleted.length} deleted-but-open file(s), ${humanBytes(f.deleted.reduce((n, d) => n + d.size, 0))} held`, f.deleted.slice(0, 20), { artifact: art });
        b.finding("high", `${f.deleted.length} file(s) deleted while still open hold ${humanBytes(f.deleted.reduce((n, d) => n + d.size, 0))} of disk`, [delEv]);
      }
      if (b.findingCount === 0) b.finding("info", `${f.total_fds} fds, ${s.total_sockets} inet sockets, nothing alarming`, [fdEv, stateEv]);
      b.next("inspect_files", "trace_syscalls");
      return b.build();
    }
    case "tcpdump": {
      const pkts = parseTcpdump(raw);
      if (!pkts.length) return b.fail("no packets parsed; expected `tcpdump -nn -tt` text output (not a .pcap)").build();
      // Local ports unknown for an import: treat the most common port as local.
      const freq = new Map<number, number>();
      for (const p of pkts) for (const port of [p.sport, p.dport]) if (port) freq.set(port, (freq.get(port) ?? 0) + 1);
      const local = new Set([...freq].sort((a, c) => c[1] - a[1]).slice(0, 2).map(([p]) => p));
      b.limitation(`local ports inferred as ${[...local].join(", ")} (most frequent); per-remote grouping may be inverted for other flows`);
      summarizeCaptureEvidence(b, pkts, local, { filter: "(imported)", duration: args.duration_s ?? 0, textPath: art });
      return b.build();
    }
  }
}

/** Analyze pasted text fully in memory (no session directory, browser-safe). */
export async function analyzeText(tool: ImportTool, raw: string, opts: { duration_s?: number } = {}): Promise<ToolResult> {
  const b = new ResultBuilder(IMPORT_TOOL_MAP[tool], { id: "paste", dir: ":memory:" }, { kind: "command", id: "(pasted output)", host: "browser" });
  if (!raw.trim()) return b.fail("pasted text is empty").build();
  const art = await b.writeArtifact(`${tool}.txt`, raw, "raw_text", `pasted ${tool} output`);
  b.limitation("analyzed from pasted output: Debug Anything did not run the tool, so flags, timing and target scope are whatever you used");
  return analyzeRaw(b, { tool, raw, duration_s: opts.duration_s, art });
}

/** Guess which tool produced this output. Returns undefined when unsure. */
export function detectTool(raw: string): ImportTool | undefined {
  const head = raw.slice(0, 20000);
  if (/^goroutine \d+ \[/m.test(head)) return "goroutines";
  if (/java\.lang\.Thread\.State:/.test(head) || /^Full thread dump /m.test(head)) return "jstack";
  if (/^Process\s+\d+:|^Thread (0x[0-9a-f]+|\d+) \((idle|active)\)/m.test(head)) return "pyspy_dump";
  if (/^\* thread #\d+/m.test(head)) return "lldb";
  if (/^Thread \d+ \(.*\):\s*$/m.test(head) && /^#\d+\s/m.test(head)) return "gdb";
  if (/^Call graph:/m.test(head) || /^Analysis of sampling/m.test(head)) return "sample";
  if (/^p\d+\s*$/m.test(head) && /^f\d+/m.test(head)) return "lsof";
  if (/^\d+\.\d+\s+(\S+\s+(In|Out)\s+)?IP6? /m.test(head) || /^\d{2}:\d{2}:\d{2}\.\d+\s+(\S+\s+(In|Out)\s+)?IP6? /m.test(head)) return "tcpdump";
  if (/^[\w.$:;<>()[\]~/+-]+(;[^ ]+)+ \d+$/m.test(head)) return "folded";
  if (/^\s*[0-9a-f]+ .+ \(.*\)$/m.test(head) && /^\S+\s+\d+(\/\d+)? (\[\d+\] )?\d+\.\d+:/m.test(head)) return "perf_script";
  if (/\b\w+\(.*\)\s+=\s+(-?\d+|0x[0-9a-f]+|\?)/.test(head) && /<\d+\.\d+>|^\d{2}:\d{2}:\d{2}/m.test(head)) return "strace";
  if (/\b\w+\(.*\)\s+=\s+(-?\d+|0x[0-9a-f]+)/.test(head)) return "strace";
  if (/^\d{2}:\d{2}:\d{2}(\.\d+)?\s+\S+/m.test(head) && /\S+\.\d+\s*$/m.test(head)) return "fs_usage";
  return undefined;
}
