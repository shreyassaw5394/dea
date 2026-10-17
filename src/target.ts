/**
 * Resolve pid | container name | k8s pod | command → attachable Target.
 * Also provides the cross-platform process listing used by list_processes.
 *
 * Nothing here assumes the target is local forever: the resolved Target
 * carries `host` and the container block so later hosts (ssh, k8s) can
 * fill them in with the same shape.
 */
import { readFile, readdir, readlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { execa } from "execa";
import type { Target, TargetKind } from "./contracts.js";
import { assertPid, assertSafeIdentifier } from "./safety.js";
import { platform } from "./session.js";

export interface ProcessInfo {
  pid: number;
  ppid: number;
  user: string;
  cpu: number;
  mem: number;
  rss_kb: number;
  comm: string;
  args: string;
  container?: string;
}

// ---------------------------------------------------------------------------
// ps
// ---------------------------------------------------------------------------

/**
 * Parse ps output. We run ps twice because `comm` may contain spaces on macOS
 * and `args` always may: once with comm as the LAST column, once with args as
 * the last column, then join by pid. Pure.
 */
export function parsePs(commRaw: string, argsRaw = ""): ProcessInfo[] {
  const args = new Map<number, string>();
  for (const line of argsRaw.split("\n")) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m) args.set(Number(m[1]), m[2]!.trim());
  }
  const out: ProcessInfo[] = [];
  for (const line of commRaw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    // pid ppid user cpu mem rss comm...
    const m = /^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.*)$/.exec(t);
    if (!m) continue;
    const pid = Number(m[1]);
    const a = args.get(pid) ?? "";
    let comm = basename(m[7]!.trim());
    // macOS truncates comm to 16 chars; prefer argv[0]'s basename when it extends comm.
    const argv0 = basename(a.split(" ")[0] ?? "");
    if (argv0 && argv0.length > comm.length && argv0.startsWith(comm)) comm = argv0;
    out.push({ pid, ppid: Number(m[2]), user: m[3]!, cpu: Number(m[4]), mem: Number(m[5]), rss_kb: Number(m[6]), comm, args: a });
  }
  return out;
}

const COMM_COL = process.platform === "darwin" ? "ucomm=" : "comm=";

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

export async function listProcesses(filter?: string, limit = 100): Promise<ProcessInfo[]> {
  if (platform() === "win32") throw new Error("list_processes is not implemented on Windows yet");
  const [r1, r2] = await Promise.all([
    execa("ps", ["-axo", `pid=,ppid=,user=,%cpu=,%mem=,rss=,${COMM_COL}`], { reject: false, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }),
    execa("ps", ["-axo", "pid=,args="], { reject: false, timeout: 10_000, maxBuffer: 64 * 1024 * 1024 }),
  ]);
  let procs = parsePs(r1.stdout, r2.stdout);
  if (platform() === "linux") await annotateContainers(procs);
  if (filter) {
    const f = filter.toLowerCase();
    procs = procs.filter((p) => p.comm.toLowerCase().includes(f) || p.args.toLowerCase().includes(f) || p.user.toLowerCase().includes(f) || String(p.pid) === f);
  }
  procs.sort((a, b) => b.cpu - a.cpu || b.rss_kb - a.rss_kb);
  return procs.slice(0, limit);
}

/** Linux: read /proc/<pid>/cgroup to find a container id. */
export function containerIdFromCgroup(cgroup: string): string | undefined {
  const m = /(?:docker|cri-containerd|containerd|libpod|podman)[-/]([0-9a-f]{12,64})/.exec(cgroup) ?? /\/([0-9a-f]{64})(?:\.scope)?$/m.exec(cgroup);
  return m?.[1]?.slice(0, 12);
}

async function annotateContainers(procs: ProcessInfo[]): Promise<void> {
  await Promise.all(
    procs.map(async (p) => {
      try {
        const cg = await readFile(`/proc/${p.pid}/cgroup`, "utf8");
        const id = containerIdFromCgroup(cg);
        if (id) p.container = id;
      } catch {
        /* gone or no permission */
      }
    }),
  );
}

export async function processInfo(pid: number): Promise<ProcessInfo | undefined> {
  const [r1, r2] = await Promise.all([
    execa("ps", ["-o", `pid=,ppid=,user=,%cpu=,%mem=,rss=,${COMM_COL}`, "-p", String(pid)], { reject: false, timeout: 5000 }),
    execa("ps", ["-o", "pid=,args=", "-p", String(pid)], { reject: false, timeout: 5000 }),
  ]);
  return parsePs(r1.stdout, r2.stdout)[0];
}

/** All descendant pids of `pid` (one ps call). */
export async function descendantPids(pid: number): Promise<number[]> {
  const r = await execa("ps", ["-axo", "pid=,ppid="], { reject: false, timeout: 5000 });
  const children = new Map<number, number[]>();
  for (const line of r.stdout.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)/.exec(line);
    if (!m) continue;
    const c = Number(m[1]);
    const p = Number(m[2]);
    if (!children.has(p)) children.set(p, []);
    children.get(p)!.push(c);
  }
  const out: number[] = [];
  const stack = [pid];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const c of children.get(cur) ?? []) {
      out.push(c);
      stack.push(c);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

export function detectRuntime(comm: string, args: string): NonNullable<Target["runtime"]> {
  const s = `${comm} ${args}`.toLowerCase();
  if (/(^|\/|\s)python[\d.]*(\s|$)|uvicorn|gunicorn|celery|flask|django|\.py(\s|$)/.test(s)) return "python";
  if (/(^|\/|\s)(node|nodejs|bun|deno|tsx|ts-node)(\s|$)|\.m?[jt]s(\s|$)|next-server|electron/.test(s)) return "node";
  if (/(^|\/|\s)java(\s|$)|\.jar(\s|$)|jvm/.test(s)) return "java";
  if (/(^|\/|\s)go(\s|$)|\/go\/bin\//.test(s)) return "go";
  if (comm) return "native";
  return "unknown";
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  kind?: TargetKind;
  /** For kind=command: directory to tee stdout/stderr into. */
  captureDir?: string;
}

export function guessKind(target: string, kind?: TargetKind): TargetKind {
  if (kind) return kind;
  if (/^\d+$/.test(target.trim())) return "pid";
  if (target.includes(" ") || target.startsWith("./") || target.startsWith("/")) return "command";
  if (/^[a-z0-9-]+\/[a-z0-9.-]+$/i.test(target) && !target.includes(":")) return "pod";
  return "container";
}

export async function resolveTarget(input: string, opts: ResolveOptions = {}): Promise<Target> {
  const kind = guessKind(input, opts.kind);
  switch (kind) {
    case "pid":
      return resolvePid(Number(input.trim()));
    case "container":
      return resolveContainer(input.trim());
    case "pod":
      return resolvePod(input.trim());
    case "command":
      return spawnCommand(input, opts.captureDir);
  }
}

export async function resolvePid(pid: number, extra: Partial<Target> = {}): Promise<Target> {
  assertPid(pid);
  const info = await processInfo(pid);
  if (!info) throw new Error(`no such process: ${pid}`);
  const pids = await descendantPids(pid);
  let cmdline = info.args;
  if (platform() === "linux") {
    try {
      cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim() || cmdline;
    } catch {
      /* keep ps args */
    }
  }
  return {
    kind: "pid",
    id: String(pid),
    pid,
    comm: info.comm,
    cmdline,
    pids,
    runtime: detectRuntime(info.comm, cmdline),
    host: "local",
    ...extra,
  };
}

async function resolveContainer(name: string): Promise<Target> {
  assertSafeIdentifier(name, "container name");
  const { dockerInspectForAttach } = await import("./adapters/docker.js");
  const info = await dockerInspectForAttach(name);
  if (!info) throw new Error(`container not found: ${name} (docker inspect returned nothing)`);
  if (!info.pid) throw new Error(`container ${name} is not running (no host pid)`);
  const canSeeHostPid = platform() === "linux" && existsSync(`/proc/${info.pid}`);
  const base: Target = {
    kind: "container",
    id: name,
    pid: canSeeHostPid ? info.pid : undefined,
    comm: info.comm,
    cmdline: info.cmdline,
    runtime: detectRuntime(info.comm ?? "", info.cmdline ?? ""),
    host: "local",
    container: { runtime: "docker", id: info.id, name: info.name, image: info.image },
  };
  if (canSeeHostPid) {
    try {
      base.pids = await descendantPids(info.pid);
    } catch {
      /* ignore */
    }
  }
  return base;
}

async function resolvePod(ref: string): Promise<Target> {
  assertSafeIdentifier(ref, "pod reference");
  const [ns, name] = ref.includes("/") ? ref.split("/", 2) : ["default", ref];
  // v0: resolve a pod to a local container only when the kubelet runs on this host (kind/minikube/k3s).
  const r = await execa("kubectl", ["get", "pod", name!, "-n", ns!, "-o", "jsonpath={.status.containerStatuses[0].containerID}"], { reject: false, timeout: 10_000 });
  if (r.exitCode !== 0) throw new Error(`kubectl get pod failed: ${r.stderr.trim() || "kubectl not available"}`);
  const containerId = r.stdout.trim().replace(/^[a-z-]+:\/\//, "");
  if (!containerId) throw new Error(`pod ${ref} has no running container`);
  const t = await resolveContainer(containerId.slice(0, 12)).catch(() => undefined);
  return {
    kind: "pod",
    id: ref,
    pid: t?.pid,
    pids: t?.pids,
    comm: t?.comm,
    cmdline: t?.cmdline,
    runtime: t?.runtime,
    host: "local",
    container: { runtime: "k8s", id: containerId.slice(0, 12), name: name!, namespace: ns! },
  };
}

/** Spawn a command under capture; stdout/stderr are tee'd to files in captureDir. */
export async function spawnCommand(cmdline: string, captureDir?: string): Promise<Target & { spawned: { pid: number; stdout: string; stderr: string } }> {
  const argv = splitArgs(cmdline);
  if (argv.length === 0) throw new Error("empty command");
  const dir = captureDir ?? process.cwd();
  const stdoutPath = join(dir, "stdout.log");
  const stderrPath = join(dir, "stderr.log");
  const out = createWriteStream(stdoutPath);
  const err = createWriteStream(stderrPath);
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "pipe", "pipe"], detached: true, env: process.env });
  child.stdout.pipe(out);
  child.stderr.pipe(err);
  child.stdout.pipe(process.stderr);
  child.stderr.pipe(process.stderr);
  child.unref();
  if (!child.pid) throw new Error(`failed to spawn: ${cmdline}`);
  // Give it a moment to fail fast (bad binary, immediate crash).
  await new Promise((r) => setTimeout(r, 500));
  const info = await processInfo(child.pid);
  const comm = info?.comm ?? basename(argv[0]!);
  return {
    kind: "command",
    id: cmdline,
    pid: child.pid,
    comm,
    cmdline,
    pids: await descendantPids(child.pid),
    runtime: detectRuntime(comm, cmdline),
    host: "local",
    spawned: { pid: child.pid, stdout: stdoutPath, stderr: stderrPath },
  };
}

/** Minimal shell-ish argv splitter supporting quotes. No expansion, no shell. */
export function splitArgs(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < s.length) cur += s[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else if (c === "\\" && i + 1 < s.length) cur += s[++i];
    else cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

/** Linux: resolve the executable path of a pid via /proc. */
export async function exePath(pid: number): Promise<string | undefined> {
  try {
    return await readlink(`/proc/${pid}/exe`);
  } catch {
    return undefined;
  }
}

/** Linux: list thread ids of a pid. */
export async function threadIds(pid: number): Promise<number[]> {
  try {
    return (await readdir(`/proc/${pid}/task`)).map(Number).filter(Number.isFinite);
  } catch {
    return [];
  }
}

/** Primary pid plus descendants, for scoping adapters. */
export function targetPids(t: Target): number[] {
  const set = new Set<number>();
  if (t.pid) set.add(t.pid);
  for (const p of t.pids ?? []) set.add(p);
  return [...set];
}
