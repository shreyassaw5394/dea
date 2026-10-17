/**
 * diff_runs: compare two prior ToolResults of the same tool. Generic over the
 * evidence shape: evidence items with array data are keyed by a name-ish field
 * and compared numerically; metrics are compared directly.
 */
import type { Session, ToolResult } from "./contracts.js";
import { ResultBuilder, humanBytes } from "./evidence.js";

type Row = Record<string, unknown>;

const KEY_FIELDS = ["name", "frame", "function", "syscall", "remote", "type", "path", "fd", "state", "constructor", "key", "thread", "metric", "label"];
const NUM_FIELDS = ["total_ms", "count", "self", "total", "self_pct", "total_pct", "samples", "retained_bytes", "shallow_bytes", "bytes", "packets", "rss_kb", "vsz_kb", "errors", "value", "objects", "fds"];

function keyOf(row: Row): string | undefined {
  for (const k of KEY_FIELDS) {
    const v = row[k];
    if (typeof v === "string" || typeof v === "number") return `${k}=${v}`;
  }
  return undefined;
}

function numericFields(row: Row): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of NUM_FIELDS) if (typeof row[k] === "number") out[k] = row[k] as number;
  return out;
}

export interface DiffEntry {
  key: string;
  status: "grew" | "shrank" | "appeared" | "disappeared" | "same";
  field?: string;
  a?: number;
  b?: number;
  delta?: number;
}

/** Diff two evidence lists. Pure. */
export function diffEvidence(a: ToolResult["evidence"], b: ToolResult["evidence"]): { byKind: Record<string, DiffEntry[]>; metrics: DiffEntry[] } {
  const byKind: Record<string, DiffEntry[]> = {};
  const metrics: DiffEntry[] = [];
  const kinds = new Set([...a.map((e) => e.kind), ...b.map((e) => e.kind)]);
  for (const kind of kinds) {
    const rowsA = new Map<string, Row>();
    const rowsB = new Map<string, Row>();
    const collect = (list: ToolResult["evidence"], into: Map<string, Row>) => {
      for (const e of list.filter((x) => x.kind === kind)) {
        if (Array.isArray(e.data)) {
          for (const r of e.data as Row[]) {
            if (r && typeof r === "object") {
              const k = keyOf(r);
              if (k) into.set(k, r);
            }
          }
        } else if (e.data && typeof e.data === "object") {
          const r = e.data as Row;
          const nums = numericFields(r);
          if (Object.keys(nums).length) into.set(keyOf(r) ?? e.summary.split(":")[0]!, r);
        }
      }
    };
    collect(a, rowsA);
    collect(b, rowsB);
    const entries: DiffEntry[] = [];
    for (const [k, rb] of rowsB) {
      const ra = rowsA.get(k);
      const nb = numericFields(rb);
      if (!ra) {
        const f = Object.keys(nb)[0];
        entries.push({ key: k, status: "appeared", field: f, b: f ? nb[f] : undefined });
        continue;
      }
      const na = numericFields(ra);
      const field = Object.keys(nb).find((f) => f in na);
      if (!field) continue;
      const delta = nb[field]! - na[field]!;
      entries.push({ key: k, status: delta > 0 ? "grew" : delta < 0 ? "shrank" : "same", field, a: na[field], b: nb[field], delta });
    }
    for (const [k, ra] of rowsA) {
      if (!rowsB.has(k)) {
        const na = numericFields(ra);
        const f = Object.keys(na)[0];
        entries.push({ key: k, status: "disappeared", field: f, a: f ? na[f] : undefined });
      }
    }
    entries.sort((x, y) => Math.abs(y.delta ?? y.b ?? y.a ?? 0) - Math.abs(x.delta ?? x.b ?? x.a ?? 0));
    if (entries.length) {
      if (kind === "metric" || kind === "metric_series") metrics.push(...entries);
      else byKind[kind] = entries;
    }
  }
  return { byKind, metrics };
}

export async function diffRuns(session: Session, a: ToolResult, b: ToolResult): Promise<ToolResult> {
  const rb = new ResultBuilder("diff_runs", session, session.target);
  if (a.tool !== b.tool) rb.limitation(`comparing different tools (${a.tool} vs ${b.tool}); only overlapping evidence kinds are diffed`);
  const { byKind, metrics } = diffEvidence(a.evidence, b.evidence);
  const header = rb.evidenceOf("diff", `${a.run_id ?? a.tool} (${a.started_at ?? "?"}) → ${b.run_id ?? b.tool} (${b.started_at ?? "?"})`, { a: a.run_id, b: b.run_id, a_started: a.started_at, b_started: b.started_at });

  const isBytes = (f?: string) => Boolean(f && /bytes|rss|vsz/.test(f));
  const fmt = (v: number | undefined, f?: string) => (v === undefined ? "?" : isBytes(f) ? (f?.includes("kb") ? humanBytes(v * 1024) : humanBytes(v)) : String(Math.round(v * 100) / 100));

  if (metrics.length) {
    const ev = rb.evidenceOf("diff", `metrics: ${metrics.slice(0, 6).map((m) => `${m.key} ${fmt(m.a, m.field)}→${fmt(m.b, m.field)}`).join(", ")}`, metrics.slice(0, 40));
    for (const m of metrics) {
      if (m.status === "grew" && m.a && m.delta! / m.a > 0.2) {
        rb.finding("warn", `${m.key} grew ${fmt(m.a, m.field)} → ${fmt(m.b, m.field)} (+${((m.delta! / m.a) * 100).toFixed(0)}%)`, [ev, header]);
      }
    }
  }
  for (const [kind, entries] of Object.entries(byKind)) {
    const grew = entries.filter((e) => e.status === "grew").slice(0, 10);
    const appeared = entries.filter((e) => e.status === "appeared").slice(0, 10);
    const gone = entries.filter((e) => e.status === "disappeared").slice(0, 10);
    const shrank = entries.filter((e) => e.status === "shrank").slice(0, 10);
    const ev = rb.evidenceOf("diff", `${kind}: ${grew.length} grew, ${shrank.length} shrank, ${appeared.length} appeared, ${gone.length} disappeared`, { grew, shrank, appeared, disappeared: gone });
    const top = grew[0];
    if (top && top.delta && top.a !== undefined && (top.a === 0 || top.delta / top.a > 0.1)) {
      rb.finding(
        kind === "heap_retainer" || kind === "heap_summary" ? "high" : "warn",
        `${kind}: ${top.key} grew ${fmt(top.a, top.field)} → ${fmt(top.b, top.field)}${grew.length > 1 ? ` (and ${grew.length - 1} more grew)` : ""}`,
        [ev, header],
      );
    }
    if (appeared.length && !top) rb.finding("info", `${kind}: ${appeared.length} new item(s), e.g. ${appeared[0]!.key}`, [ev, header]);
  }
  if (!metrics.length && Object.keys(byKind).length === 0) {
    rb.finding("info", "no comparable numeric evidence between the two runs", [header]);
    rb.limitation("diff_runs compares evidence rows keyed by name/frame/syscall/remote/path/etc with numeric fields; these runs had none in common");
  }
  rb.next("report");
  return rb.build();
}
