/**
 * Readiness: probe OS, tools on PATH, and permissions. Always works.
 */
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { arch, release } from "node:os";
import { execa } from "execa";
import type { ProviderReadiness, Readiness, ToolName } from "./contracts.js";
import { ToolName as ToolNameSchema } from "./contracts.js";
import { adapters } from "./adapters/index.js";
import { isRoot } from "./safety.js";
import { platform, sessionsDir } from "./session.js";
import { VERSION } from "./version.js";

export function which(binary: string): string | null {
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const extra = platform() === "darwin" ? ["/usr/sbin", "/sbin", "/opt/homebrew/bin", "/usr/local/bin"] : ["/usr/sbin", "/sbin", "/usr/local/bin"];
  for (const p of [...paths, ...extra]) {
    const full = join(p, binary);
    if (existsSync(full)) return full;
  }
  return null;
}

async function readIntFile(path: string): Promise<number | null> {
  try {
    const v = parseInt((await readFile(path, "utf8")).trim(), 10);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

async function sudoNonInteractive(): Promise<boolean> {
  if (!which("sudo")) return false;
  try {
    const r = await execa("sudo", ["-n", "true"], { reject: false, timeout: 3000 });
    return r.exitCode === 0;
  } catch {
    return false;
  }
}

async function sipEnabled(): Promise<boolean | null> {
  if (platform() !== "darwin") return null;
  try {
    const r = await execa("csrutil", ["status"], { reject: false, timeout: 3000 });
    if (/enabled/i.test(r.stdout)) return true;
    if (/disabled/i.test(r.stdout)) return false;
    return null;
  } catch {
    return null;
  }
}

async function developerMode(): Promise<boolean | null> {
  if (platform() !== "darwin") return null;
  try {
    const r = await execa("DevToolsSecurity", ["-status"], { reject: false, timeout: 3000 });
    if (/enabled/i.test(r.stdout)) return true;
    if (/disabled/i.test(r.stdout)) return false;
    return null;
  } catch {
    return null;
  }
}

async function linuxCapabilities(): Promise<string[]> {
  if (platform() !== "linux") return [];
  try {
    const status = await readFile("/proc/self/status", "utf8");
    const m = /CapEff:\s*([0-9a-f]+)/i.exec(status);
    if (!m) return [];
    const eff = BigInt("0x" + m[1]!);
    const caps: string[] = [];
    if (eff & (1n << 19n)) caps.push("CAP_SYS_PTRACE");
    if (eff & (1n << 13n)) caps.push("CAP_NET_RAW");
    if (eff & (1n << 12n)) caps.push("CAP_NET_ADMIN");
    if (eff & (1n << 21n)) caps.push("CAP_SYS_ADMIN");
    if (eff & (1n << 38n)) caps.push("CAP_PERFMON");
    if (eff & (1n << 39n)) caps.push("CAP_BPF");
    return caps;
  } catch {
    return [];
  }
}

export async function probeReadiness(): Promise<Readiness> {
  const os = platform();
  const root = isRoot();
  const [ptraceScope, perfParanoid, sudo, sip, dev, caps] = await Promise.all([
    os === "linux" ? readIntFile("/proc/sys/kernel/yama/ptrace_scope") : Promise.resolve(null),
    os === "linux" ? readIntFile("/proc/sys/kernel/perf_event_paranoid") : Promise.resolve(null),
    sudoNonInteractive(),
    sipEnabled(),
    developerMode(),
    linuxCapabilities(),
  ]);

  const providers: ProviderReadiness[] = [];
  for (const a of adapters) {
    const requires = a.requires.map((b) => ({ binary: b, path: which(b) }));
    const missing = requires.filter((r) => !r.path).map((r) => r.binary);
    let status: ProviderReadiness["status"] = "ready";
    const notes: string[] = [];
    if (!a.platforms.includes(os)) status = "unsupported_platform";
    else if (a.tools.length === 0) status = "not_implemented";
    else if (missing.length) status = "missing";
    let base: ProviderReadiness = {
      name: a.name,
      tools: a.tools,
      status,
      requires,
      install_hint: status === "missing" ? a.install?.[os] : undefined,
      notes,
    };
    if (a.check && status === "ready") {
      base = await a.check(base, { platform: os, isRoot: root, ptraceScope, perfParanoid });
    }
    if (a.runtimes?.length) base.notes.push(`serves ${a.runtimes.join("/")} targets`);
    providers.push(base);
  }

  const available = new Set<string>();
  const unavailable = new Map<string, string>();
  for (const t of ToolNameSchema.options as ToolName[]) {
    if (["readiness", "attach", "detach", "list_processes", "diff_runs", "report"].includes(t)) {
      available.add(t);
      continue;
    }
    const serving = providers.filter((p) => p.tools.includes(t));
    if (serving.some((p) => p.status === "ready")) available.add(t);
    else {
      const reasons = serving.map((p) => `${p.name}: ${p.status}${p.install_hint ? ` (${p.install_hint})` : ""}`);
      unavailable.set(t, reasons.join("; ") || "no adapter on this platform");
    }
  }

  return {
    os,
    arch: arch(),
    kernel: release(),
    node: process.version,
    dea_version: VERSION,
    is_root: root,
    has_sudo_noninteractive: sudo,
    permissions: {
      ptrace_scope: ptraceScope,
      capabilities: caps,
      sip_enabled: sip,
      developer_mode: dev,
      perf_event_paranoid: perfParanoid,
    },
    providers,
    tools_available: [...available],
    tools_unavailable: [...unavailable].map(([tool, reason]) => ({ tool, reason })),
    sessions_dir: sessionsDir(),
  };
}
