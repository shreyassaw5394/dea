/**
 * JVM thread dumps: parse `jstack <pid>` / `jcmd <pid> Thread.print` output
 * into threads + monitors, detect deadlocks and monitor contention.
 * Pure parsing/summarizing (used by dea import, the web analyzer, and the
 * live dump_stacks path when a JDK is present).
 */
import type { ToolResult } from "../contracts.js";
import { ResultBuilder } from "../evidence.js";

export type JavaFrame = { func: string; loc?: string };
export type JavaThread = {
  name: string;
  id?: number;
  daemon: boolean;
  state?: string; // NEW/RUNNABLE/BLOCKED/WAITING/TIMED_WAITING/TERMINATED
  frames: JavaFrame[];
  waitingToLock?: string; // monitor address
  holding: string[];      // monitors held
};

export type JstackDump = { threads: JavaThread[]; deadlockText?: string; jniRefs?: number };

export function parseJstack(raw: string): JstackDump {
  const threads: JavaThread[] = [];
  let cur: JavaThread | undefined;
  let deadlock: string[] | undefined;
  const lines = raw.split("\n");
  for (const line of lines) {
    if (/^Found .* Java-level deadlock/i.test(line)) deadlock = [line.trim()];
    else if (deadlock && deadlock.length < 40 && line.trim()) deadlock.push(line.trim());

    const head = line.match(/^"(.+)"\s+(#(\d+)\s+)?(daemon\s+)?prio=/) ?? line.match(/^"(.+)"\s+(#(\d+))?.*(daemon)?.*\bnid=/);
    if (head) {
      cur = { name: head[1]!, id: head[3] ? Number(head[3]) : undefined, daemon: /\bdaemon\b/.test(line), frames: [], holding: [] };
      threads.push(cur);
      continue;
    }
    if (!cur) continue;
    const st = line.match(/^\s+java\.lang\.Thread\.State:\s+(\w+)/);
    if (st) { cur.state = st[1]; continue; }
    const at = line.match(/^\s+at\s+([\w.$/<>]+)\((.*?)\)/);
    if (at) { cur.frames.push({ func: at[1]!, loc: at[2] && at[2] !== "Native Method" ? at[2] : undefined }); continue; }
    const wait = line.match(/^\s+-\s+(?:waiting to lock|parking to wait for|waiting on)\s+<(0x[0-9a-f]+)>/);
    if (wait) { cur.waitingToLock = wait[1]; continue; }
    const locked = line.match(/^\s+-\s+locked\s+<(0x[0-9a-f]+)>/);
    if (locked) cur.holding.push(locked[1]!);
  }
  return { threads: threads.filter((t) => t.frames.length || t.state), deadlockText: deadlock?.join("\n") };
}

export async function summarizeJavaStacks(b: ResultBuilder, dump: JstackDump, artifact: string): Promise<ToolResult> {
  const ts = dump.threads;
  if (!ts.length) {
    b.limitation("no Java threads parsed (expected `jstack <pid>` or `jcmd <pid> Thread.print` output)");
    return b.fail("jstack: no threads parsed").build();
  }
  const byState = new Map<string, JavaThread[]>();
  for (const t of ts) {
    const s = t.state ?? "UNKNOWN";
    byState.set(s, [...(byState.get(s) ?? []), t]);
  }
  const blocked = byState.get("BLOCKED") ?? [];
  const runnable = byState.get("RUNNABLE") ?? [];
  const summaryEv = b.evidenceOf(
    "stack_summary",
    `${ts.length} JVM thread(s): ${[...byState].map(([s, v]) => `${s}=${v.length}`).join(" ")}`,
    ts.slice(0, 200).map((t) => ({ name: t.name, state: t.state, daemon: t.daemon, top: t.frames[0]?.func })),
    { artifact },
  );
  for (const t of ts.filter((x) => x.state === "BLOCKED" || x.name === "main").slice(0, 10)) {
    b.evidenceOf("stack", `${t.name} [${t.state}]: ${t.frames.slice(0, 5).map((f) => f.func.split(".").slice(-2).join(".")).join(" ← ")}`, { name: t.name, state: t.state, waiting_to_lock: t.waitingToLock, holding: t.holding, frames: t.frames.slice(0, 20).map((f) => `${f.func}${f.loc ? ` (${f.loc})` : ""}`) }, { artifact });
  }

  if (dump.deadlockText) {
    const dlEv = b.evidenceOf("lock_wait", dump.deadlockText.split("\n")[0]!, { jstack_deadlock_section: dump.deadlockText }, { artifact });
    b.finding("high", `the JVM itself reports a deadlock: ${dump.deadlockText.split("\n")[0]}`, [dlEv, summaryEv], "observed", dump.deadlockText);
  } else if (blocked.length >= 2) {
    // circular wait: A waits for a monitor B holds and vice versa
    const holders = new Map<string, JavaThread>();
    for (const t of ts) for (const m of t.holding) holders.set(m, t);
    const cycles = blocked.filter((t) => {
      const holder = t.waitingToLock ? holders.get(t.waitingToLock) : undefined;
      return holder && holder.waitingToLock && holders.get(holder.waitingToLock)?.name === t.name;
    });
    const lockEv = b.evidenceOf("lock_wait", `${blocked.length} BLOCKED thread(s): ${blocked.slice(0, 6).map((t) => `${t.name} wants <${t.waitingToLock ?? "?"}> at ${t.frames[0]?.func ?? "?"}`).join("; ")}`, blocked.slice(0, 30).map((t) => ({ name: t.name, wants: t.waitingToLock, holds: t.holding, at: t.frames[0]?.func })), { artifact });
    if (cycles.length) b.finding("high", `deadlock: circular monitor wait between ${cycles.map((t) => t.name).join(" and ")}`, [lockEv, summaryEv], "inferred", "Each thread holds the monitor the other wants.");
    else {
      const wantCounts = new Map<string, number>();
      for (const t of blocked) if (t.waitingToLock) wantCounts.set(t.waitingToLock, (wantCounts.get(t.waitingToLock) ?? 0) + 1);
      const hot = [...wantCounts].sort((a, c) => c[1] - a[1])[0];
      if (hot && hot[1] >= 3) {
        const holder = holders.get(hot[0]);
        b.finding("high", `monitor contention: ${hot[1]} threads blocked on <${hot[0]}>${holder ? `, held by ${holder.name} at ${holder.frames[0]?.func ?? "?"}` : ""}`, [lockEv], "observed");
      } else b.finding("warn", `${blocked.length} thread(s) BLOCKED on monitors`, [lockEv], "observed");
    }
  }

  const main = ts.find((t) => t.name === "main");
  if (main && (main.state === "WAITING" || main.state === "TIMED_WAITING") && !dump.deadlockText) {
    const ev = b.evidenceOf("stack", `main is ${main.state} in ${main.frames[0]?.func ?? "?"}`, main.frames.slice(0, 10).map((f) => f.func), { artifact });
    b.finding("info", `main thread is ${main.state} in ${main.frames[0]?.func ?? "?"} — normal for servers; relevant if this process should be doing work`, [ev]);
  }
  if (ts.length >= 500) b.finding("warn", `${ts.length} threads — likely an unbounded thread pool or a thread leak`, [summaryEv], "inferred");
  if (!b.findingCount) b.finding("info", `${ts.length} threads, ${runnable.length} RUNNABLE, no monitor contention visible`, [summaryEv]);
  b.next("inspect_sockets", "snapshot_memory", "profile_cpu");
  return b.build();
}

// ---------------------------------------------------------------------------
// Live adapter: jstack/jcmd against a running JVM
// ---------------------------------------------------------------------------
import type { Adapter, AdapterContext } from "./types.js";
import { runCapped, rootRequiredLimitation } from "../safety.js";

async function liveDump(ctx: AdapterContext): Promise<ToolResult> {
  const { session, target } = ctx;
  const b = new ResultBuilder("dump_stacks", session, target);
  const pid = target.pid;
  if (!pid) return b.fail("no resolved pid for target").build();
  // jcmd Thread.print includes lock info and is the modern entry; jstack is the fallback.
  const bad = (x: { exitCode: number | null; stdout: string }) => x.exitCode !== 0 || !/java\.lang\.Thread\.State:|Full thread dump/.test(x.stdout);
  let r = await runCapped("jcmd", [String(pid), "Thread.print", "-l"], { timeoutMs: 20_000 });
  if (bad(r)) r = await runCapped("jstack", ["-l", String(pid)], { timeoutMs: 20_000 });
  if (bad(r)) {
    if (/Operation not permitted|AttachNotSupported|well-known file is not secure/i.test(r.stderr + r.stdout)) {
      b.limitation(rootRequiredLimitation("dump_stacks", `jstack -l ${pid}`));
      b.limitation("the JVM attach mechanism requires the same user as the target (or root)");
      b.next(`import_artifact (tool: jstack) after running it yourself`);
      return b.fail("jstack/jcmd could not attach").build();
    }
    return b.fail(`jcmd/jstack failed: ${(r.stderr || r.stdout).slice(0, 300)}`).build();
  }
  const art = await b.writeArtifact("jstack.txt", r.stdout, "raw_text", "JVM thread dump");
  return summarizeJavaStacks(b, parseJstack(r.stdout), art);
}

export const jvmAdapter: Adapter = {
  name: "jstack",
  tools: ["dump_stacks"],
  platforms: ["linux", "darwin"],
  requires: ["jcmd"],
  runtimes: ["java"],
  install: { linux: "install a JDK (jcmd/jstack ship with it)", darwin: "brew install openjdk" },
  priority: 20,
  async run(tool, _args, ctx) {
    if (tool !== "dump_stacks") throw new Error(`jstack adapter cannot run ${tool}`);
    return liveDump(ctx);
  },
};
