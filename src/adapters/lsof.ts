/**
 * lsof adapter: inspect_sockets, inspect_files, and the `dea port` lookup.
 * Works on Linux and macOS without root for your own processes.
 *
 * We use lsof's machine-readable field output (-F) so parsing does not depend
 * on column alignment.
 */
import { readFile } from "node:fs/promises";
import type { Adapter, AdapterContext } from "./types.js";
import type { Target, ToolResult } from "../contracts.js";
import { ResultBuilder, humanBytes } from "../evidence.js";
import { runCapped, looksLikePermissionError, isRoot, rootRequiredLimitation } from "../safety.js";
import { platform } from "../session.js";
import { targetPids } from "../target.js";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface LsofEntry {
  pid: number;
  command: string;
  user?: string;
  fd: string; // "cwd", "txt", "20u", ...
  type: string; // REG, DIR, CHR, FIFO, unix, IPv4, IPv6, KQUEUE, PIPE, ...
  size?: number;
  inode?: string;
  name: string;
  tcpState?: string; // LISTEN, ESTABLISHED, CLOSE_WAIT, ...
  protocol?: "TCP" | "UDP";
  deleted?: boolean;
}

/** Parse `lsof -nP -F pcufatsinTP` output. Pure. */
export function parseLsofFields(raw: string): LsofEntry[] {
  const out: LsofEntry[] = [];
  let pid = 0;
  let command = "";
  let user: string | undefined;
  let cur: Partial<LsofEntry> | null = null;
  const flush = () => {
    if (cur && cur.fd !== undefined) {
      const name = cur.name ?? "";
      out.push({
        pid,
        command,
        user,
        fd: cur.fd,
        type: cur.type ?? "",
        size: cur.size,
        inode: cur.inode,
        name,
        tcpState: cur.tcpState,
        protocol: cur.protocol,
        deleted: /\(deleted\)/.test(name) || undefined,
      });
    }
    cur = null;
  };
  for (const line of raw.split("\n")) {
    if (!line) continue;
    const tag = line[0]!;
    const val = line.slice(1);
    switch (tag) {
      case "p":
        flush();
        pid = Number(val);
        break;
      case "c":
        command = val;
        break;
      case "u":
        user = val;
        break;
      case "L":
        user = val;
        break;
      case "f":
        flush();
        cur = { fd: val };
        break;
      case "t":
        if (cur) cur.type = val;
        break;
      case "s":
        if (cur) cur.size = Number(val);
        break;
      case "i":
        if (cur) cur.inode = val;
        break;
      case "n":
        if (cur) cur.name = val;
        break;
      case "P":
        if (cur && (val === "TCP" || val === "UDP")) cur.protocol = val;
        break;
      case "T":
        if (cur && val.startsWith("ST=")) cur.tcpState = val.slice(3);
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

export interface SocketSummary {
  listening: Array<{ pid: number; proto: string; addr: string; port: number }>;
  byState: Record<string, number>;
  byRemote: Array<{ remote: string; count: number; states: Record<string, number> }>;
  total_sockets: number;
  unix_sockets: number;
  udp: number;
}

function splitAddr(s: string): { host: string; port: number } {
  const i = s.lastIndexOf(":");
  if (i < 0) return { host: s, port: 0 };
  return { host: s.slice(0, i), port: Number(s.slice(i + 1)) || 0 };
}

/** Summarize network entries. Pure. */
export function summarizeSockets(entries: LsofEntry[]): SocketSummary {
  const listening: SocketSummary["listening"] = [];
  const byState: Record<string, number> = {};
  const remotes = new Map<string, { count: number; states: Record<string, number> }>();
  let total = 0;
  let unix = 0;
  let udp = 0;
  for (const e of entries) {
    if (e.type === "unix") {
      unix++;
      continue;
    }
    if (e.type !== "IPv4" && e.type !== "IPv6") continue;
    total++;
    const proto = e.protocol ?? (e.tcpState ? "TCP" : "UDP");
    if (proto === "UDP") udp++;
    if (e.tcpState === "LISTEN") {
      const { host, port } = splitAddr(e.name);
      listening.push({ pid: e.pid, proto, addr: host, port });
      continue;
    }
    if (e.tcpState) byState[e.tcpState] = (byState[e.tcpState] ?? 0) + 1;
    const arrow = e.name.indexOf("->");
    if (arrow >= 0) {
      const remote = e.name.slice(arrow + 2);
      const { host } = splitAddr(remote);
      const r = remotes.get(host) ?? { count: 0, states: {} };
      r.count++;
      if (e.tcpState) r.states[e.tcpState] = (r.states[e.tcpState] ?? 0) + 1;
      remotes.set(host, r);
    }
  }
  const byRemote = [...remotes].map(([remote, v]) => ({ remote, ...v })).sort((a, b) => b.count - a.count);
  return { listening, byState, byRemote, total_sockets: total, unix_sockets: unix, udp };
}

export interface FileSummary {
  byType: Record<string, number>;
  total_fds: number;
  largest: Array<{ fd: string; size: number; name: string }>;
  deleted: Array<{ fd: string; size: number; name: string }>;
  regular_files: number;
}

/** Summarize fd entries (numeric fds only). Pure. */
export function summarizeFiles(entries: LsofEntry[]): FileSummary {
  const byType: Record<string, number> = {};
  const numeric = entries.filter((e) => /^\d+/.test(e.fd));
  const regular = numeric.filter((e) => e.type === "REG");
  for (const e of numeric) byType[e.type || "?"] = (byType[e.type || "?"] ?? 0) + 1;
  const largest = [...regular]
    .filter((e) => typeof e.size === "number")
    .sort((a, b) => (b.size ?? 0) - (a.size ?? 0))
    .slice(0, 10)
    .map((e) => ({ fd: e.fd, size: e.size ?? 0, name: e.name }));
  const deleted = numeric.filter((e) => e.deleted).map((e) => ({ fd: e.fd, size: e.size ?? 0, name: e.name }));
  return { byType, total_fds: numeric.length, largest, deleted, regular_files: regular.length };
}

/** Parse Linux /proc/<pid>/limits for Max open files. Pure. */
export function parseProcLimits(text: string): { soft: number | null; hard: number | null } {
  const m = /^Max open files\s+(\S+)\s+(\S+)/m.exec(text);
  if (!m) return { soft: null, hard: null };
  const n = (s: string) => (s === "unlimited" ? Infinity : Number(s));
  return { soft: n(m[1]!), hard: n(m[2]!) };
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

async function runLsof(pids: number[], extra: string[] = []): Promise<{ entries: LsofEntry[]; stderr: string; exitCode: number | null; raw: string }> {
  // -n no DNS, -P no port names, -F fields, -w suppress warnings. lsof exits 1 when some pids have nothing; fine.
  const args = ["-nP", "-w", "-a", "-F", "pcufatsinTP", ...extra];
  if (pids.length) args.push("-p", pids.join(","));
  const r = await runCapped("lsof", args, { timeoutMs: 20_000 });
  return { entries: parseLsofFields(r.stdout), stderr: r.stderr, exitCode: r.exitCode, raw: r.stdout };
}

async function openFileLimit(pid: number): Promise<{ soft: number | null; hard: number | null; source: string }> {
  if (platform() === "linux") {
    try {
      return { ...parseProcLimits(await readFile(`/proc/${pid}/limits`, "utf8")), source: `/proc/${pid}/limits` };
    } catch {
      /* fallthrough */
    }
  }
  // macOS: no per-process view without root; report launchd's maxfiles as an approximation.
  if (platform() === "darwin") {
    const r = await runCapped("launchctl", ["limit", "maxfiles"], { timeoutMs: 5000 });
    const m = /maxfiles\s+(\S+)\s+(\S+)/.exec(r.stdout);
    if (m) {
      const n = (s: string) => (s === "unlimited" ? Infinity : Number(s));
      return { soft: n(m[1]!), hard: n(m[2]!), source: "launchctl limit maxfiles (system default, not the target's own ulimit)" };
    }
  }
  return { soft: null, hard: null, source: "unknown" };
}

async function inspectSockets(ctx: AdapterContext): Promise<ToolResult> {
  const { session, target } = ctx;
  const b = new ResultBuilder("inspect_sockets", session, target);
  const pids = targetPids(target);
  if (!pids.length) return b.fail("target has no host pid; cannot inspect sockets").build();
  const { entries, stderr, raw } = await runLsof(pids, ["-i"]);
  const art = await b.writeArtifact("lsof-sockets.txt", raw, "raw_text", `lsof -nP -i -p ${pids.join(",")}`);
  if (entries.length === 0 && looksLikePermissionError(stderr)) {
    b.limitation(rootRequiredLimitation("inspect_sockets", `lsof -nP -i -p ${pids.join(",")}`));
    return b.fail("lsof could not read the target's fds (permission denied)").build();
  }
  const s = summarizeSockets(entries);
  const listenEv = b.evidenceOf(
    "socket_summary",
    s.listening.length ? `listening: ${s.listening.map((l) => `${l.proto} ${l.addr}:${l.port} (pid ${l.pid})`).join(", ")}` : "no listening sockets",
    s.listening,
    { artifact: art },
  );
  const stateEv = b.evidenceOf("socket_summary", `${s.total_sockets} inet socket(s): ${Object.entries(s.byState).map(([k, v]) => `${k}=${v}`).join(" ") || "none established"}; udp=${s.udp}; unix=${s.unix_sockets}`, { by_state: s.byState, total: s.total_sockets, udp: s.udp, unix: s.unix_sockets }, { artifact: art });
  const remoteEv = b.evidenceOf("socket", s.byRemote.length ? `top remotes: ${s.byRemote.slice(0, 5).map((r) => `${r.remote} ×${r.count}`).join(", ")}` : "no remote connections", s.byRemote.slice(0, 30).map((r) => ({ remote: r.remote, count: r.count, states: r.states })), { artifact: art });

  // fd count vs limit
  const all = await runLsof(pids);
  const files = summarizeFiles(all.entries);
  const lim = await openFileLimit(pids[0]!);
  const fdEv = b.evidenceOf("fd_summary", `${files.total_fds} open fd(s); open-file limit soft=${lim.soft ?? "?"} hard=${lim.hard ?? "?"} (${lim.source})`, { fds: files.total_fds, soft: lim.soft === Infinity ? "unlimited" : lim.soft, hard: lim.hard === Infinity ? "unlimited" : lim.hard, source: lim.source });

  // Findings
  if (s.listening.length) b.finding("info", `listening on ${s.listening.map((l) => `${l.proto}/${l.port}`).join(", ")}`, [listenEv]);
  const cw = s.byState.CLOSE_WAIT ?? 0;
  if (cw >= 20) b.finding("high", `${cw} sockets in CLOSE_WAIT — the peer closed and the target never called close(); fd leak in the connection-handling code`, [stateEv], "inferred");
  else if (cw >= 5) b.finding("warn", `${cw} sockets in CLOSE_WAIT — the target is slow to close connections the peer already closed`, [stateEv], "inferred");
  const tw = s.byState.TIME_WAIT ?? 0;
  if (tw >= 100) b.finding("warn", `${tw} sockets in TIME_WAIT — high connection churn (no keep-alive / connection pooling?)`, [stateEv], "inferred");
  const syn = s.byState.SYN_SENT ?? 0;
  if (syn >= 3) b.finding("warn", `${syn} sockets stuck in SYN_SENT — a remote is not answering connection attempts`, [stateEv, remoteEv], "observed");
  const top = s.byRemote[0];
  if (top && top.count >= 50) b.finding("warn", `${top.count} connections to ${top.remote} — connection pool exhaustion or missing reuse`, [remoteEv], "inferred");
  if (lim.soft && lim.soft !== Infinity && files.total_fds / lim.soft > 0.8) b.finding("high", `${files.total_fds} fds open vs soft limit ${lim.soft} (${Math.round((100 * files.total_fds) / lim.soft)}%) — EMFILE imminent`, [fdEv]);
  if (!s.listening.length && !s.byRemote.length) b.finding("info", "target has no inet sockets open", [stateEv]);

  if (platform() === "darwin" && !isRoot()) b.limitation("macOS lsof without root only sees processes owned by the current user");
  if (pids.length > 1) b.limitation(`included ${pids.length} pids (target + descendants)`);
  b.next("inspect_files", "trace_syscalls", s.byRemote.length ? "capture_traffic (needs consent)" : "profile_cpu");
  return b.build();
}

async function inspectFiles(ctx: AdapterContext, args: { window_s?: number }): Promise<ToolResult> {
  const { session, target } = ctx;
  const b = new ResultBuilder("inspect_files", session, target);
  const pids = targetPids(target);
  if (!pids.length) return b.fail("target has no host pid; cannot inspect files").build();
  const first = await runLsof(pids);
  if (first.entries.length === 0 && looksLikePermissionError(first.stderr)) {
    b.limitation(rootRequiredLimitation("inspect_files", `lsof -nP -p ${pids.join(",")}`));
    return b.fail("lsof could not read the target's fds (permission denied)").build();
  }
  const art = await b.writeArtifact("lsof-files.txt", first.raw, "raw_text", `lsof -nP -p ${pids.join(",")}`);
  const f1 = summarizeFiles(first.entries);
  const window = Math.min(args.window_s ?? 3, 30);
  let f2: FileSummary | undefined;
  if (window > 0) {
    await new Promise((r) => setTimeout(r, window * 1000));
    const second = await runLsof(pids);
    f2 = summarizeFiles(second.entries);
  }
  const typeEv = b.evidenceOf("fd_summary", `${f1.total_fds} fd(s): ${Object.entries(f1.byType).sort((a, b2) => b2[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(" ")}`, Object.entries(f1.byType).map(([type, count]) => ({ type, count })), { artifact: art });
  const lim = await openFileLimit(pids[0]!);
  const limEv = b.evidenceOf("metric", `open-file limit soft=${lim.soft === Infinity ? "unlimited" : lim.soft ?? "?"} hard=${lim.hard === Infinity ? "unlimited" : lim.hard ?? "?"} (${lim.source})`, { name: "fd_limit_soft", value: lim.soft === Infinity ? -1 : lim.soft, hard: lim.hard === Infinity ? -1 : lim.hard, fds: f1.total_fds });
  if (f1.largest.length) {
    b.evidenceOf("fd", `largest open files: ${f1.largest.slice(0, 3).map((l) => `${l.name.split("/").pop()} ${humanBytes(l.size)}`).join(", ")}`, f1.largest, { artifact: art });
  }
  let growthEv: string | undefined;
  if (f2) {
    growthEv = b.evidenceOf("metric_series", `fds ${f1.total_fds} → ${f2.total_fds} over ${window}s (${f2.total_fds - f1.total_fds >= 0 ? "+" : ""}${f2.total_fds - f1.total_fds})`, { name: "open_fds", value: f2.total_fds, start: f1.total_fds, end: f2.total_fds, window_s: window });
  }
  if (f1.deleted.length) {
    const delEv = b.evidenceOf("fd", `${f1.deleted.length} deleted-but-open file(s), ${humanBytes(f1.deleted.reduce((s, d) => s + d.size, 0))} held`, f1.deleted.slice(0, 20), { artifact: art });
    b.finding("high", `${f1.deleted.length} file(s) deleted while still open hold ${humanBytes(f1.deleted.reduce((s, d) => s + d.size, 0))} of disk — "disk full but nothing there"`, [delEv]);
  }
  if (f2 && f2.total_fds - f1.total_fds >= Math.max(5, f1.total_fds * 0.1)) {
    b.finding("high", `fd count grew ${f1.total_fds} → ${f2.total_fds} in ${window}s — fd leak`, [growthEv!], "inferred");
  }
  if (lim.soft && lim.soft !== Infinity && f1.total_fds / lim.soft > 0.8) b.finding("high", `${f1.total_fds} fds vs soft limit ${lim.soft}`, [typeEv, limEv]);
  if (f1.largest[0] && f1.largest[0].size > 1024 ** 3) b.finding("info", `largest open file is ${humanBytes(f1.largest[0].size)}: ${f1.largest[0].name}`, [b.evidenceOf("fd", "largest file", f1.largest[0], { artifact: art })]);
  if (b.findingCount === 0) b.finding("info", `${f1.total_fds} fds open, dominated by ${Object.entries(f1.byType).sort((a, b2) => b2[1] - a[1])[0]?.[0] ?? "?"}`, [typeEv]);
  if (platform() === "darwin") b.limitation("macOS lsof does not mark deleted-but-open files; that check only works on Linux");
  b.next("inspect_sockets", "trace_syscalls");
  return b.build();
}

/** `dea port <n>`: who listens on a port. No session. */
export async function whoHoldsPort(port: number): Promise<ToolResult> {
  const target: Target = { kind: "pid", id: `port:${port}`, host: "local" };
  const b = new ResultBuilder("inspect_sockets", null, target);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return b.fail(`invalid port ${port}`).build();
  const [tcp, udp] = await Promise.all([
    runCapped("lsof", ["-nP", "-w", "-F", "pcufatsinTP", `-iTCP:${port}`], { timeoutMs: 15_000 }),
    runCapped("lsof", ["-nP", "-w", "-F", "pcufatsinTP", `-iUDP:${port}`], { timeoutMs: 15_000 }),
  ]);
  const entries = [...parseLsofFields(tcp.stdout), ...parseLsofFields(udp.stdout)];
  const holders = new Map<number, { pid: number; command: string; user?: string; states: string[]; names: string[] }>();
  for (const e of entries) {
    const h = holders.get(e.pid) ?? { pid: e.pid, command: e.command, user: e.user, states: [], names: [] };
    if (e.tcpState) h.states.push(e.tcpState);
    h.names.push(e.name);
    holders.set(e.pid, h);
  }
  const list = [...holders.values()];
  const ev = b.evidenceOf("socket", list.length ? `port ${port}: ${list.map((h) => `pid ${h.pid} ${h.command} [${[...new Set(h.states)].join(",") || "UDP"}]`).join("; ")}` : `nothing holds port ${port} (visible to this user)`, list);
  const listener = list.find((h) => h.states.includes("LISTEN"));
  if (listener) {
    const { processInfo } = await import("../target.js");
    const info = await processInfo(listener.pid);
    const pev = b.evidenceOf("process", `pid ${listener.pid}: ${info?.args ?? listener.command} (user ${info?.user ?? listener.user ?? "?"})`, info ?? listener);
    b.finding("high", `port ${port} is held by pid ${listener.pid} (${listener.command}${info?.user ? `, user ${info.user}` : ""}) in LISTEN`, [ev, pev], "observed", `command: ${info?.args ?? "?"}. DEA will not kill it; decide yourself.`);
  } else if (list.length) {
    b.finding("warn", `port ${port} has ${list.length} process(es) with non-listening sockets (${[...new Set(list.flatMap((h) => h.states))].join(",") || "UDP"}) — a TIME_WAIT/CLOSE_WAIT leftover can also block bind without SO_REUSEADDR`, [ev], "inferred");
  } else {
    b.finding("info", `no process visible to this user holds port ${port}`, [ev]);
    if (!isRoot()) b.limitation("other users' processes are invisible without root; try: sudo lsof -nP -iTCP:" + port);
  }
  return b.build();
}

export const lsofAdapter: Adapter = {
  name: "lsof",
  tools: ["inspect_sockets", "inspect_files"],
  platforms: ["linux", "darwin"],
  requires: ["lsof"],
  install: { linux: "sudo apt install lsof  |  sudo dnf install lsof", darwin: "preinstalled (/usr/sbin/lsof)" },
  priority: 10,
  async run(tool, args, ctx) {
    if (tool === "inspect_sockets") return inspectSockets(ctx);
    if (tool === "inspect_files") return inspectFiles(ctx, args as { window_s?: number });
    throw new Error(`lsof adapter cannot run ${tool}`);
  },
};
