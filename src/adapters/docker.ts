/**
 * docker adapter: container_info (inspect/stats/logs/top + cgroup limits) and
 * the container → host pid mapping used by attach.
 */
import { readFile } from "node:fs/promises";
import type { Adapter, AdapterContext } from "./types.js";
import type { ToolResult } from "../contracts.js";
import { ResultBuilder, humanBytes } from "../evidence.js";
import { runCapped, assertSafeIdentifier } from "../safety.js";
import { platform } from "../session.js";

export interface DockerAttachInfo {
  id: string;
  name: string;
  image?: string;
  pid: number;
  comm?: string;
  cmdline?: string;
  running: boolean;
}

export interface DockerInspect {
  Id: string;
  Name: string;
  Config?: { Image?: string; Cmd?: string[] | null; Entrypoint?: string[] | null };
  State?: { Status?: string; Running?: boolean; Pid?: number; OOMKilled?: boolean; ExitCode?: number; StartedAt?: string; FinishedAt?: string; Error?: string; RestartCount?: number };
  HostConfig?: { Memory?: number; MemorySwap?: number; NanoCpus?: number; CpuQuota?: number; CpuPeriod?: number; CpuShares?: number; PidsLimit?: number | null; RestartPolicy?: { Name?: string } };
  RestartCount?: number;
  NetworkSettings?: { Ports?: Record<string, Array<{ HostIp: string; HostPort: string }> | null> };
}

/** Parse `docker inspect` JSON. Pure. */
export function parseDockerInspect(raw: string): DockerInspect | undefined {
  try {
    const arr = JSON.parse(raw);
    const obj = Array.isArray(arr) ? arr[0] : arr;
    return obj && typeof obj === "object" ? (obj as DockerInspect) : undefined;
  } catch {
    return undefined;
  }
}

export function attachInfoFromInspect(d: DockerInspect): DockerAttachInfo {
  const argv = [...(d.Config?.Entrypoint ?? []), ...(d.Config?.Cmd ?? [])];
  return {
    id: d.Id.slice(0, 12),
    name: (d.Name ?? "").replace(/^\//, ""),
    image: d.Config?.Image,
    pid: d.State?.Pid ?? 0,
    comm: argv[0]?.split("/").pop(),
    cmdline: argv.join(" ") || undefined,
    running: Boolean(d.State?.Running),
  };
}

export async function dockerInspectForAttach(name: string): Promise<DockerAttachInfo | undefined> {
  assertSafeIdentifier(name, "container name");
  const r = await runCapped("docker", ["inspect", name], { timeoutMs: 10_000 });
  if (r.exitCode !== 0) return undefined;
  const d = parseDockerInspect(r.stdout);
  return d ? attachInfoFromInspect(d) : undefined;
}

/** Parse `docker stats --no-stream --format json`. Pure. */
export interface DockerStats {
  cpu_pct: number;
  mem_usage: string;
  mem_pct: number;
  net_io: string;
  block_io: string;
  pids: number;
}
export function parseDockerStats(raw: string): DockerStats | undefined {
  const line = raw.trim().split("\n").find((l) => l.startsWith("{"));
  if (!line) return undefined;
  try {
    const j = JSON.parse(line) as Record<string, string>;
    return {
      cpu_pct: parseFloat(j.CPUPerc ?? "0"),
      mem_usage: j.MemUsage ?? "",
      mem_pct: parseFloat(j.MemPerc ?? "0"),
      net_io: j.NetIO ?? "",
      block_io: j.BlockIO ?? "",
      pids: parseInt(j.PIDs ?? "0", 10),
    };
  } catch {
    return undefined;
  }
}

/** Parse `docker top <c> -eo pid,comm,args` → rows. Pure. */
export function parseDockerTop(raw: string): Array<{ pid: number; comm: string; args: string }> {
  const lines = raw.trim().split("\n").slice(1);
  const out: Array<{ pid: number; comm: string; args: string }> = [];
  for (const l of lines) {
    const m = /^\s*(\d+)\s+(\S+)\s*(.*)$/.exec(l);
    if (m) out.push({ pid: Number(m[1]), comm: m[2]!, args: m[3] ?? "" });
  }
  return out;
}

/** Linux cgroup v2 memory.events / cpu.stat for a container's pid. */
export async function readCgroupStats(pid: number): Promise<{ oom_kill?: number; oom?: number; max?: number; throttled_usec?: number; nr_throttled?: number; nr_periods?: number } | undefined> {
  try {
    const cg = await readFile(`/proc/${pid}/cgroup`, "utf8");
    const m = /^0::(.*)$/m.exec(cg);
    if (!m) return undefined;
    const base = `/sys/fs/cgroup${m[1]}`;
    const out: Record<string, number> = {};
    const parse = (text: string) => {
      for (const line of text.split("\n")) {
        const [k, v] = line.trim().split(/\s+/);
        if (k && v && /^\d+$/.test(v)) out[k] = Number(v);
      }
    };
    for (const f of ["memory.events", "cpu.stat"]) {
      try {
        parse(await readFile(`${base}/${f}`, "utf8"));
      } catch {
        /* ignore */
      }
    }
    return out;
  } catch {
    return undefined;
  }
}

async function containerInfo(ctx: AdapterContext): Promise<ToolResult> {
  const { session, target } = ctx;
  const b = new ResultBuilder("container_info", session, target);
  const name = target.container?.id ?? target.id;
  if (!target.container) {
    if (platform() === "linux" && target.pid) {
      // Attached by pid; check if it lives in a container.
      try {
        const cg = await readFile(`/proc/${target.pid}/cgroup`, "utf8");
        const { containerIdFromCgroup } = await import("../target.js");
        const cid = containerIdFromCgroup(cg);
        if (cid) return containerInfoFor(b, cid, ctx);
      } catch {
        /* ignore */
      }
    }
    b.limitation("target is not a container (attach with kind=container or a container name to get container_info)");
    return b.fail("not a container target").build();
  }
  return containerInfoFor(b, name, ctx);
}

async function containerInfoFor(b: ResultBuilder, name: string, _ctx: AdapterContext): Promise<ToolResult> {
  const [inspectR, statsR, topR, logsR] = await Promise.all([
    runCapped("docker", ["inspect", name], { timeoutMs: 10_000 }),
    runCapped("docker", ["stats", "--no-stream", "--format", "{{json .}}", name], { timeoutMs: 15_000 }),
    runCapped("docker", ["top", name, "-eo", "pid,comm,args"], { timeoutMs: 10_000 }),
    runCapped("docker", ["logs", "--tail", "200", "--timestamps", name], { timeoutMs: 10_000 }),
  ]);
  if (inspectR.exitCode !== 0) {
    b.limitation(`docker inspect failed: ${inspectR.stderr.trim()}`);
    return b.fail("docker inspect failed").build();
  }
  const d = parseDockerInspect(inspectR.stdout);
  if (!d) return b.fail("could not parse docker inspect output").build();
  const inspectPath = await b.writeArtifact("inspect.json", inspectR.stdout, "json", "docker inspect");
  const logsText = logsR.stdout + logsR.stderr;
  const logsPath = await b.writeArtifact("logs.txt", logsText, "log", "docker logs --tail 200");

  const st = d.State ?? {};
  const hc = d.HostConfig ?? {};
  const stateEv = b.evidenceOf(
    "container_state",
    `state=${st.Status} running=${st.Running} pid=${st.Pid} oom_killed=${st.OOMKilled} exit=${st.ExitCode} restarts=${d.RestartCount ?? st.RestartCount ?? 0}`,
    { status: st.Status, running: st.Running, host_pid: st.Pid, oom_killed: st.OOMKilled, exit_code: st.ExitCode, started_at: st.StartedAt, finished_at: st.FinishedAt, restart_count: d.RestartCount ?? st.RestartCount, error: st.Error, image: d.Config?.Image },
    { artifact: inspectPath },
  );
  const limits = {
    memory_bytes: hc.Memory || null,
    memory_swap_bytes: hc.MemorySwap || null,
    nano_cpus: hc.NanoCpus || null,
    cpu_quota: hc.CpuQuota || null,
    cpu_period: hc.CpuPeriod || null,
    pids_limit: hc.PidsLimit ?? null,
    restart_policy: hc.RestartPolicy?.Name ?? null,
  };
  const limitsEv = b.evidenceOf(
    "cgroup",
    `limits: memory=${hc.Memory ? humanBytes(hc.Memory) : "unlimited"} cpus=${hc.NanoCpus ? (hc.NanoCpus / 1e9).toFixed(2) : hc.CpuQuota && hc.CpuPeriod ? (hc.CpuQuota / hc.CpuPeriod).toFixed(2) : "unlimited"} pids=${hc.PidsLimit ?? "unlimited"}`,
    limits,
    { artifact: inspectPath },
  );

  const stats = parseDockerStats(statsR.stdout);
  let statsEv: string | undefined;
  if (stats) {
    statsEv = b.evidenceOf("metric", `cpu=${stats.cpu_pct}% mem=${stats.mem_usage} (${stats.mem_pct}%) net=${stats.net_io} block=${stats.block_io} pids=${stats.pids}`, stats);
  } else b.limitation("docker stats unavailable (container not running?)");

  const top = parseDockerTop(topR.stdout);
  if (top.length) b.evidenceOf("process_list", `${top.length} process(es) in container; pid1=${top[0]?.comm}`, top.slice(0, 30));

  const ports = Object.entries(d.NetworkSettings?.Ports ?? {}).map(([k, v]) => `${k}→${(v ?? []).map((x) => `${x.HostIp}:${x.HostPort}`).join(",") || "unpublished"}`);
  if (ports.length) b.evidenceOf("socket_summary", `published ports: ${ports.join(" ")}`, ports);

  // Log tail excerpt: errors and OOM-ish lines.
  const logLines = logsText.split("\n");
  const interesting = logLines.filter((l) => /error|exception|fatal|panic|oom|killed|out of memory|traceback|segfault/i.test(l)).slice(-15);
  if (interesting.length) {
    b.evidenceOf("log_excerpt", `${interesting.length} error-ish line(s) in last ${logLines.length} log lines`, interesting, { artifact: logsPath });
  }

  // cgroup (linux host only)
  if (platform() === "linux" && st.Pid) {
    const cg = await readCgroupStats(st.Pid);
    if (cg && Object.keys(cg).length) {
      const cgEv = b.evidenceOf("cgroup", `cgroup: oom_kill=${cg.oom_kill ?? 0} oom=${cg.oom ?? 0} throttled=${cg.nr_throttled ?? 0}/${cg.nr_periods ?? 0} periods`, cg);
      if ((cg.oom_kill ?? 0) > 0) b.finding("high", `cgroup reports ${cg.oom_kill} OOM kill(s) for this container`, [cgEv]);
      if ((cg.nr_periods ?? 0) > 0 && (cg.nr_throttled ?? 0) / cg.nr_periods! > 0.1) {
        b.finding("warn", `CPU throttled in ${(((cg.nr_throttled ?? 0) / cg.nr_periods!) * 100).toFixed(0)}% of cgroup periods — the CPU quota is a bottleneck`, [cgEv, limitsEv]);
      }
    }
  } else if (platform() === "darwin") {
    b.limitation("on macOS the Docker VM hides host pids and cgroups; ptrace-based tools cannot attach to container processes from the host — run Debug Anything inside the container or on a Linux host");
  }

  // Findings
  if (st.OOMKilled) b.finding("high", "container was OOM-killed (State.OOMKilled=true)", [stateEv, limitsEv]);
  if (!st.Running) b.finding("high", `container is not running (status=${st.Status}, exit=${st.ExitCode})`, [stateEv]);
  const restarts = d.RestartCount ?? st.RestartCount ?? 0;
  if (restarts > 0) b.finding("warn", `container has restarted ${restarts} time(s)`, [stateEv]);
  if (stats && hc.Memory && stats.mem_pct > 85) b.finding("warn", `memory at ${stats.mem_pct}% of the ${humanBytes(hc.Memory)} limit — close to OOM`, [statsEv!, limitsEv]);
  if (stats && stats.cpu_pct > 90) b.finding("warn", `container CPU at ${stats.cpu_pct}%`, [statsEv!]);
  if (interesting.length) {
    b.finding("info", `recent logs contain ${interesting.length} error-ish line(s) (see evidence)`, [b.evidenceOf("log_excerpt", "error-ish log lines", interesting.slice(-5), { artifact: logsPath })]);
  }
  if (b.findingCount === 0 && st.Running) {
    b.finding("info", `container running${stats ? `, memory ${stats.mem_pct}% of ${hc.Memory ? humanBytes(hc.Memory) : "host"} and cpu ${stats.cpu_pct}%` : ""}, no OOM kill, no restarts`, statsEv ? [stateEv, limitsEv, statsEv] : [stateEv, limitsEv]);
  }
  b.next("snapshot_memory", "profile_cpu", "inspect_sockets");
  return b.build();
}

export const dockerAdapter: Adapter = {
  name: "docker",
  tools: ["container_info"],
  platforms: ["linux", "darwin"],
  requires: ["docker"],
  install: { linux: "https://docs.docker.com/engine/install/", darwin: "brew install --cask docker  (or Colima/OrbStack)" },
  priority: 10,
  async run(tool, _args, ctx) {
    if (tool !== "container_info") throw new Error(`docker adapter cannot run ${tool}`);
    return containerInfo(ctx);
  },
};
