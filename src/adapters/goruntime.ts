/**
 * Go goroutine dumps: parse `/debug/pprof/goroutine?debug=2` or SIGQUIT
 * output, detect goroutine leaks, long-blocked goroutines and deadlocks.
 * Pure parsing/summarizing (dea import + web analyzer).
 */
import type { ToolResult } from "../contracts.js";
import { ResultBuilder } from "../evidence.js";

export type Goroutine = { id: number; state: string; minutes?: number; frames: Array<{ func: string; loc?: string }> };

export function parseGoroutines(raw: string): Goroutine[] {
  const out: Goroutine[] = [];
  let cur: Goroutine | undefined;
  let lastFunc: string | undefined;
  for (const line of raw.split("\n")) {
    const head = line.match(/^goroutine\s+(\d+)\s+\[([^\],]+)(?:,\s*(\d+)\s*minutes)?\]:/);
    if (head) {
      cur = { id: Number(head[1]), state: head[2]!.trim(), minutes: head[3] ? Number(head[3]) : undefined, frames: [] };
      out.push(cur);
      lastFunc = undefined;
      continue;
    }
    if (!cur) continue;
    const loc = line.match(/^\s+(\S+\.go:\d+)/);
    if (loc && lastFunc) {
      cur.frames[cur.frames.length - 1]!.loc = loc[1];
      lastFunc = undefined;
      continue;
    }
    const fn = line.match(/^(\S+?)\(.*\)$/) ?? line.match(/^(created by .+)$/);
    if (fn && line && !line.startsWith("\t")) {
      cur.frames.push({ func: fn[1]! });
      lastFunc = fn[1];
    }
  }
  return out;
}

const BLOCKED_STATES = /^(chan receive|chan send|select|semacquire|sync\.(Mutex|RWMutex)\.|IO wait|sleep|GC assist wait|force gc \(idle\)|sync\.Cond\.Wait)/;

export async function summarizeGoroutines(b: ResultBuilder, gs: Goroutine[], artifact: string): Promise<ToolResult> {
  if (!gs.length) {
    b.limitation("no goroutines parsed (expected `curl localhost:PORT/debug/pprof/goroutine?debug=2` or SIGQUIT dump output)");
    return b.fail("goroutines: none parsed").build();
  }
  const byState = new Map<string, Goroutine[]>();
  for (const g of gs) byState.set(g.state, [...(byState.get(g.state) ?? []), g]);
  const states = [...byState].sort((a, c) => c[1].length - a[1].length);
  const summaryEv = b.evidenceOf(
    "stack_summary",
    `${gs.length} goroutine(s): ${states.slice(0, 6).map(([s, v]) => `${s}=${v.length}`).join(" ")}`,
    states.map(([s, v]) => ({ state: s, count: v.length, example_top: v[0]?.frames[0]?.func })),
    { artifact },
  );

  // Leak heuristic: many goroutines parked at the same site
  const bySite = new Map<string, Goroutine[]>();
  for (const g of gs) {
    if (!BLOCKED_STATES.test(g.state)) continue;
    const site = `${g.state} @ ${g.frames[0]?.func ?? "?"}`;
    bySite.set(site, [...(bySite.get(site) ?? []), g]);
  }
  const hot = [...bySite].sort((a, c) => c[1].length - a[1].length)[0];
  if (hot && hot[1].length >= 100) {
    const g0 = hot[1][0]!;
    const ev = b.evidenceOf("stack", `${hot[1].length} goroutines parked at ${hot[0]}`, { site: hot[0], example: g0.frames.slice(0, 8).map((f) => `${f.func}${f.loc ? ` (${f.loc})` : ""}`) }, { artifact });
    b.finding(hot[1].length >= 1000 ? "high" : "warn", `goroutine leak: ${hot[1].length} goroutines blocked at ${hot[0]}${g0.frames[0]?.loc ? ` (${g0.frames[0].loc})` : ""} — something creates them and never lets them finish`, [ev, summaryEv], "inferred", "Find who spawns them: the `created by` frame in the dump names the call site.");
  }
  const old = gs.filter((g) => (g.minutes ?? 0) >= 10).sort((a, c) => (c.minutes ?? 0) - (a.minutes ?? 0));
  if (old.length) {
    const ev = b.evidenceOf("lock_wait", `${old.length} goroutine(s) blocked ≥10 minutes; oldest ${old[0]!.minutes} min in ${old[0]!.state} at ${old[0]!.frames[0]?.func ?? "?"}`, old.slice(0, 15).map((g) => ({ id: g.id, state: g.state, minutes: g.minutes, top: g.frames[0]?.func, loc: g.frames[0]?.loc })), { artifact });
    b.finding(old[0]!.minutes! >= 60 ? "high" : "warn", `${old.length} goroutine(s) stuck for ${old[0]!.minutes}+ minutes (${old[0]!.state} at ${old[0]!.frames[0]?.func ?? "?"}) — a peer, channel or lock never delivered`, [ev], "observed");
  }
  const mutex = gs.filter((g) => /^sync\.(Mutex|RWMutex)/.test(g.state) || g.state === "semacquire" && /sync\.\(\*(Mutex|RWMutex)\)/.test(g.frames[0]?.func ?? ""));
  if (mutex.length >= 5) {
    const ev = b.evidenceOf("lock_wait", `${mutex.length} goroutines acquiring mutexes; top site ${mutex[0]!.frames.find((f) => !/^sync\./.test(f.func))?.func ?? "?"}`, mutex.slice(0, 10).map((g) => ({ id: g.id, top: g.frames.find((f) => !/^sync\./.test(f.func))?.func })), { artifact });
    b.finding("warn", `mutex contention: ${mutex.length} goroutines waiting to lock`, [ev], "observed");
  }
  const running = byState.get("running") ?? [];
  if (!running.length && gs.length > 1 && gs.every((g) => BLOCKED_STATES.test(g.state) || g.state === "runnable")) {
    b.finding(gs.length <= 20 ? "high" : "warn", `no goroutine is running — all ${gs.length} are parked (${states.slice(0, 3).map(([s, v]) => `${v.length} in ${s}`).join(", ")})`, [summaryEv], "inferred", "If the process should be serving traffic, this is a global stall: check channel senders and lock holders.");
  }
  if (!b.findingCount) b.finding("info", `${gs.length} goroutines, ${running.length} running — nothing alarming in this snapshot`, [summaryEv]);
  b.next("inspect_sockets", "profile_cpu", "trace_syscalls");
  return b.build();
}
