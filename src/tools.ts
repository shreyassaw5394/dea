/**
 * Tool dispatcher shared by the MCP server and the CLI.
 * Core tools (readiness, attach, detach, list_processes, diff_runs, report)
 * live here; everything else goes to the highest-priority ready adapter.
 */
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { ToolArgs, type Readiness, type Target, type ToolResult } from "./contracts.js";
import { ResultBuilder, failedResult } from "./evidence.js";
import { probeReadiness } from "./readiness.js";
import { createSession, detachSession, loadRun, recordRun, requireAttached, saveSession, loadSession, platform } from "./session.js";
import { listProcesses, resolveTarget } from "./target.js";
import { requireConsent, ConsentRequiredError } from "./safety.js";
import { candidatesFor } from "./adapters/index.js";
import { diffRuns } from "./diff.js";
import { renderReport } from "./report.js";

const NO_TARGET: Target = { kind: "pid", id: "-", host: "local" };

let readinessCache: { at: number; value: Readiness } | null = null;
export async function cachedReadiness(maxAgeMs = 30_000): Promise<Readiness> {
  if (readinessCache && Date.now() - readinessCache.at < maxAgeMs) return readinessCache.value;
  const value = await probeReadiness();
  readinessCache = { at: Date.now(), value };
  return value;
}

export const TOOL_DESCRIPTIONS: Record<keyof typeof ToolArgs, string> = {
  readiness: "Report OS, arch, which providers (strace, py-spy, perf, lsof, tcpdump, gdb/lldb, docker...) are usable, what is missing and how to install it, and permission status (ptrace_scope, sudo, SIP). Always call this first.",
  attach: "Resolve a target (pid, container, k8s pod, or a command to spawn under capture) and open a session. Returns session_id used by every other tool. Read-only: nothing is modified.",
  detach: "Stop any running captures for the session, finalize the report, keep artifacts under ~/.dea/sessions/<id>/.",
  list_processes: "ps-style list (pid, comm, cpu, mem, user, container) for picking a target. Optional substring filter.",
  trace_syscalls: "Linux strace of the target for N seconds: top syscalls by total time and count, slowest individual calls, error counts (ENOENT/EAGAIN/ECONNREFUSED...), blocked waits. Raw log saved as artifact.",
  profile_cpu: "CPU profile for N seconds: py-spy (Python), perf (native/Node on Linux), sample (macOS). Returns top frames (self/total), hottest stacks, flamegraph.svg artifact.",
  dump_stacks: "Instant snapshot of every thread's stack (py-spy dump / gdb / lldb / Node inspector). The key tool for hangs and deadlocks; flags threads waiting on the same lock.",
  inspect_sockets: "lsof/ss view of the target: listening ports, established connections grouped by remote, states (CLOSE_WAIT pileups, TIME_WAIT counts), fd count vs ulimit.",
  inspect_files: "Open file descriptors by type, growth over a short window, largest open files, deleted-but-open files (disk full but nothing there).",
  capture_traffic: "tcpdump scoped to the target's ports for N seconds (max 30). Per-remote bytes/packets, retransmits, RSTs, DNS queries, TLS SNI. .pcap artifact. REQUIRES consent: true — ask the user first.",
  snapshot_memory: "RSS/VSZ sampled over a window; Node: heap snapshot with top retainers by retained size; Python: py-spy dump with locals. Take two and diff_runs them to find what grows.",
  diff_runs: "Diff two prior runs of the same tool in this session (e.g. snapshot_memory#1 vs snapshot_memory#2, profile_cpu#1 vs #2): what grew, appeared, disappeared.",
  container_info: "docker inspect/stats/top/logs tail for the target container, host pid mapping, cgroup limits: throttled? OOM-killed before? restarts?",
  report: "Markdown report of the whole session: findings, evidence excerpts, artifact paths. Optionally written to a file.",
};

export async function runTool(name: string, rawArgs: Record<string, unknown>): Promise<ToolResult> {
  const schema = (ToolArgs as Record<string, (typeof ToolArgs)[keyof typeof ToolArgs]>)[name];
  if (!schema) return failedResult(name, null, NO_TARGET, `unknown tool: ${name}`);
  const parsed = schema.safeParse(rawArgs);
  if (!parsed.success) {
    return failedResult(name, null, NO_TARGET, `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  const args = parsed.data as Record<string, unknown>;
  try {
    switch (name) {
      case "readiness":
        return await toolReadiness();
      case "attach":
        return await toolAttach(args as { target: string; kind?: Target["kind"] });
      case "detach":
        return await toolDetach(args as { session_id: string });
      case "list_processes":
        return await toolListProcesses(args as { filter?: string; limit: number });
      case "diff_runs":
        return await toolDiffRuns(args as { session_id: string; a: string; b: string });
      case "report":
        return await toolReport(args as { session_id: string; out?: string });
      default:
        return await dispatchAdapter(name, args);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const sessionId = typeof args.session_id === "string" ? args.session_id : "";
    const limitations = err instanceof ConsentRequiredError ? ["consent required — ask the user, then pass consent: true"] : [];
    const r = failedResult(name, null, NO_TARGET, msg, limitations);
    return { ...r, session_id: sessionId };
  }
}

async function toolReadiness(): Promise<ToolResult> {
  const r = await probeReadiness();
  readinessCache = { at: Date.now(), value: r };
  const b = new ResultBuilder("readiness", null, NO_TARGET);
  const sys = b.evidenceOf("readiness", `${r.os}/${r.arch} node=${r.node} root=${r.is_root} sudo-n=${r.has_sudo_noninteractive} ptrace_scope=${r.permissions.ptrace_scope ?? "n/a"} sip=${r.permissions.sip_enabled ?? "n/a"}`, {
    os: r.os,
    arch: r.arch,
    kernel: r.kernel,
    node: r.node,
    dea_version: r.dea_version,
    is_root: r.is_root,
    has_sudo_noninteractive: r.has_sudo_noninteractive,
    permissions: r.permissions,
    sessions_dir: r.sessions_dir,
  });
  const prov = b.evidenceOf(
    "readiness",
    `${r.providers.filter((p) => p.status === "ready").length}/${r.providers.length} providers ready: ${r.providers.map((p) => `${p.name}=${p.status}`).join(" ")}`,
    r.providers,
  );
  const tools = b.evidenceOf("readiness", `tools available: ${r.tools_available.join(", ")}`, { available: r.tools_available, unavailable: r.tools_unavailable });
  b.finding("info", `${r.tools_available.length} of 14 tools available on ${r.os}`, [tools, prov]);
  for (const u of r.tools_unavailable) b.limitation(`${u.tool}: ${u.reason}`);
  if (r.os === "linux" && r.permissions.ptrace_scope !== null && r.permissions.ptrace_scope >= 1 && !r.is_root) {
    b.finding("warn", `ptrace_scope=${r.permissions.ptrace_scope}: strace/gdb/py-spy can only attach to your own child processes without root`, [sys], "observed", "Fix for this boot: sudo sysctl kernel.yama.ptrace_scope=0  (DEA will not run this for you)");
  }
  if (r.os === "linux" && r.permissions.perf_event_paranoid !== null && r.permissions.perf_event_paranoid > 1 && !r.is_root) {
    b.finding("warn", `perf_event_paranoid=${r.permissions.perf_event_paranoid}: perf cannot profile other users' processes without root`, [sys], "observed", "Fix for this boot: sudo sysctl kernel.perf_event_paranoid=1");
  }
  if (r.os === "darwin" && !r.is_root) {
    b.limitation("macOS: attaching py-spy/lldb/sample to processes you did not start usually needs sudo; tcpdump always needs sudo or membership in the access_bpf group");
  }
  if (r.os === "win32") b.limitation("Windows is not supported yet (planned: ETW / procdump based adapters)");
  b.next("list_processes", "attach");
  return b.build();
}

async function toolAttach(args: { target: string; kind?: Target["kind"] }): Promise<ToolResult> {
  if (platform() === "win32") return failedResult("attach", null, NO_TARGET, "Windows is not supported yet");
  // For commands we need the session dir before spawning so output can be tee'd.
  const isCommand = (args.kind ?? (await import("./target.js")).guessKind(args.target)) === "command";
  let target: Target;
  let session;
  if (isCommand) {
    session = await createSession({ kind: "command", id: args.target, host: "local" });
    const spawned = await (await import("./target.js")).spawnCommand(args.target, session.dir);
    const { spawned: sp, ...t } = spawned;
    target = t;
    session.target = target;
    session.spawned = sp;
    await saveSession(session);
  } else {
    target = await resolveTarget(args.target, { kind: args.kind });
    session = await createSession(target);
  }
  const b = new ResultBuilder("attach", session, target);
  const ev = b.evidenceOf("process", `attached to ${target.kind} ${target.id}: pid=${target.pid ?? "?"} comm=${target.comm ?? "?"} runtime=${target.runtime ?? "?"} children=${target.pids?.length ?? 0}`, target);
  b.finding("info", `session ${session.id} attached to pid ${target.pid ?? "?"} (${target.comm ?? "unknown"}, runtime ${target.runtime ?? "unknown"})`, [ev]);
  if (!target.pid) b.limitation("no host pid for this target on this platform; pid-based tools (strace, py-spy, gdb, lsof) will not work. container_info still works.");
  if (session.spawned) b.limitation(`spawned command; stdout/stderr tee'd to ${session.spawned.stdout} and ${session.spawned.stderr}`);
  const readiness = await cachedReadiness();
  const next = ["inspect_sockets", "inspect_files", "dump_stacks", "profile_cpu", "snapshot_memory", "trace_syscalls", "container_info"].filter((t) => readiness.tools_available.includes(t));
  if (target.kind !== "container" && target.kind !== "pod") next.splice(next.indexOf("container_info"), next.includes("container_info") ? 1 : 0);
  b.next(...next, "detach");
  const result = b.build();
  return recordRun(session, result);
}

async function toolDetach(args: { session_id: string }): Promise<ToolResult> {
  const session = await loadSession(args.session_id);
  await detachSession(session);
  const b = new ResultBuilder("detach", session, session.target);
  const md = await renderReport(session);
  const reportPath = join(session.dir, "report.md");
  await writeFile(reportPath, md);
  await b.addArtifact(reportPath, "markdown", { description: "session report" });
  const ev = b.evidenceOf("note", `session ${session.id} detached after ${session.runs.length} run(s); report at ${reportPath}`, { runs: session.runs.map((r) => r.run_id), report: reportPath });
  b.finding("info", `detached; ${session.runs.length} run(s) kept under ${session.dir}`, [ev]);
  return b.build();
}

async function toolListProcesses(args: { filter?: string; limit: number }): Promise<ToolResult> {
  const b = new ResultBuilder("list_processes", null, NO_TARGET);
  const procs = await listProcesses(args.filter, args.limit);
  const ev = b.evidenceOf(
    "process_list",
    `${procs.length} process(es)${args.filter ? ` matching "${args.filter}"` : ""}, sorted by cpu then rss`,
    procs.map((p) => ({ pid: p.pid, ppid: p.ppid, user: p.user, cpu: p.cpu, mem: p.mem, rss_kb: p.rss_kb, comm: p.comm, args: p.args.slice(0, 160), container: p.container })),
  );
  if (procs.length === 0) b.finding("info", `no processes match "${args.filter ?? ""}"`, [ev]);
  else {
    const top = procs[0]!;
    b.finding("info", `top by cpu: pid ${top.pid} ${top.comm} (${top.cpu}% cpu, ${Math.round(top.rss_kb / 1024)} MB rss)`, [ev]);
  }
  b.next("attach");
  return b.build();
}

async function toolDiffRuns(args: { session_id: string; a: string; b: string }): Promise<ToolResult> {
  const session = await loadSession(args.session_id);
  const [a, bb] = await Promise.all([loadRun(session, args.a), loadRun(session, args.b)]);
  const result = await diffRuns(session, a, bb);
  return recordRun(session, result);
}

async function toolReport(args: { session_id: string; out?: string }): Promise<ToolResult> {
  const session = await loadSession(args.session_id);
  const md = await renderReport(session);
  const b = new ResultBuilder("report", session, session.target);
  const path = join(session.dir, "report.md");
  await writeFile(path, md);
  await b.addArtifact(path, "markdown", { description: "session report" });
  if (args.out) {
    await writeFile(args.out, md);
    await b.addArtifact(args.out, "markdown", { description: "copy of session report" });
  }
  const allFindings = [] as Array<{ run: string; severity: string; summary: string }>;
  for (const r of session.runs) {
    try {
      const tr = await loadRun(session, r.run_id);
      for (const f of tr.findings) allFindings.push({ run: r.run_id, severity: f.severity, summary: f.summary });
    } catch {
      /* ignore */
    }
  }
  const ev = b.evidenceOf("note", `report with ${allFindings.length} finding(s) across ${session.runs.length} run(s)`, { findings: allFindings.slice(0, 50), markdown_preview: md.slice(0, 3000) });
  b.finding("info", `report written to ${path}`, [ev]);
  return b.build();
}

async function dispatchAdapter(tool: string, args: Record<string, unknown>): Promise<ToolResult> {
  const session = await requireAttached(String(args.session_id));
  requireConsent(tool, args as { consent?: boolean });
  const readiness = await cachedReadiness();
  const { ready, blocked } = candidatesFor(tool, session.target, readiness);
  if (ready.length === 0) {
    const reasons = blocked.map((c) => `${c.adapter.name}: ${c.reason}`);
    const r = failedResult(tool, session, session.target, `no ready adapter for ${tool} on ${readiness.os}${session.target.runtime ? ` (runtime ${session.target.runtime})` : ""}`, reasons.length ? reasons : ["no adapter declares this tool for this platform"], ["readiness"]);
    return recordRun(session, r);
  }
  let last: ToolResult | undefined;
  for (const adapter of ready) {
    const result = await adapter.run(tool, args, { session, target: session.target, readiness });
    last = result;
    if (result.ok) break;
    // Try the next adapter only on "can't serve" style failures, not on genuine measured failures.
    if (!/cannot attach|not supported|requires|unsupported|needs/i.test(result.error ?? "")) break;
  }
  return recordRun(session, last!);
}
