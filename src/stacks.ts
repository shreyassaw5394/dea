/**
 * Folded-stack utilities shared by profilers (py-spy, perf, sample):
 * parse "a;b;c N" lines, aggregate self/total per frame, find hottest stacks,
 * and render a flamegraph SVG with a small inline implementation (no Perl).
 */

export interface FoldedStack {
  frames: string[]; // root → leaf
  count: number;
}

/** Parse folded/collapsed stacks ("root;child;leaf 12"). Pure. */
export function parseFolded(raw: string): FoldedStack[] {
  const out: FoldedStack[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trimEnd();
    if (!t) continue;
    const sp = t.lastIndexOf(" ");
    if (sp < 0) continue;
    const count = Number(t.slice(sp + 1));
    if (!Number.isFinite(count)) continue;
    const frames = t.slice(0, sp).split(";").filter(Boolean);
    if (frames.length) out.push({ frames, count });
  }
  return out;
}

export interface FrameStat {
  frame: string;
  self: number;
  total: number;
  self_pct: number;
  total_pct: number;
}

/** Aggregate self and inclusive sample counts per frame. Pure. */
export function aggregateFrames(stacks: FoldedStack[], limit = 15): { frames: FrameStat[]; totalSamples: number } {
  const self = new Map<string, number>();
  const total = new Map<string, number>();
  let totalSamples = 0;
  for (const s of stacks) {
    totalSamples += s.count;
    const leaf = s.frames[s.frames.length - 1]!;
    self.set(leaf, (self.get(leaf) ?? 0) + s.count);
    for (const f of new Set(s.frames)) total.set(f, (total.get(f) ?? 0) + s.count);
  }
  const frames = [...total.keys()]
    .map((frame) => ({
      frame,
      self: self.get(frame) ?? 0,
      total: total.get(frame) ?? 0,
      self_pct: totalSamples ? Math.round((1000 * (self.get(frame) ?? 0)) / totalSamples) / 10 : 0,
      total_pct: totalSamples ? Math.round((1000 * (total.get(frame) ?? 0)) / totalSamples) / 10 : 0,
    }))
    .sort((a, b) => b.self - a.self || b.total - a.total)
    .slice(0, limit);
  return { frames, totalSamples };
}

/** Hottest full stacks by count. Pure. */
export function hottestStacks(stacks: FoldedStack[], limit = 5, maxDepth = 12): Array<{ count: number; pct: number; stack: string[] }> {
  const total = stacks.reduce((s, x) => s + x.count, 0);
  return [...stacks]
    .sort((a, b) => b.count - a.count)
    .slice(0, limit)
    .map((s) => ({ count: s.count, pct: total ? Math.round((1000 * s.count) / total) / 10 : 0, stack: s.frames.length > maxDepth ? [...s.frames.slice(0, 3), `… ${s.frames.length - maxDepth + 3} frames …`, ...s.frames.slice(-(maxDepth - 4))] : s.frames }));
}

/** Frames that look like idle/wait rather than CPU work. */
export const IDLE_FRAME = /\b(semaphore_wait_trap|__psynch_mutexwait|__ulock_wait|__workq_kernreturn|__sigsuspend|__wait4|epoll_wait|epoll_pwait|kevent|poll|select|futex|nanosleep|clock_nanosleep|pthread_cond_wait|pthread_cond_timedwait|__psynch_cvwait|mach_msg|mach_msg2_trap|__semwait_signal|__select|__workq_kernreturn|uv__io_poll|uv_run|sleep|time\.sleep|wait|_wait_for_tstate_lock|<idle>|swapper)\b/i;

// ---------------------------------------------------------------------------
// Flamegraph SVG
// ---------------------------------------------------------------------------

interface Node {
  name: string;
  value: number;
  children: Map<string, Node>;
}

function buildTree(stacks: FoldedStack[]): Node {
  const root: Node = { name: "all", value: 0, children: new Map() };
  for (const s of stacks) {
    root.value += s.count;
    let cur = root;
    for (const f of s.frames) {
      let n = cur.children.get(f);
      if (!n) {
        n = { name: f, value: 0, children: new Map() };
        cur.children.set(f, n);
      }
      n.value += s.count;
      cur = n;
    }
  }
  return root;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function colorFor(name: string): string {
  // Deterministic warm palette keyed by name hash, like flamegraph.pl's "hot".
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const r = 205 + (h % 50);
  const g = 60 + ((h >> 8) % 120);
  const b = (h >> 16) % 60;
  return `rgb(${r},${g},${b})`;
}

/** Render folded stacks as a self-contained flamegraph SVG. Pure. */
export function renderFlamegraph(stacks: FoldedStack[], opts: { title?: string; width?: number; minWidthPx?: number } = {}): string {
  const width = opts.width ?? 1200;
  const rowH = 16;
  const minW = opts.minWidthPx ?? 0.5;
  const root = buildTree(stacks);
  const total = root.value || 1;
  let maxDepth = 0;
  const rects: string[] = [];
  const walk = (n: Node, x: number, depth: number) => {
    const w = (n.value / total) * width;
    if (w < minW) return;
    maxDepth = Math.max(maxDepth, depth);
    const label = w > 40 ? n.name.slice(0, Math.floor(w / 7)) : "";
    rects.push(
      `<g class="f"><title>${esc(n.name)} (${n.value} samples, ${((100 * n.value) / total).toFixed(2)}%)</title><rect x="${x.toFixed(2)}" y="${depth}" width="${w.toFixed(2)}" height="${rowH - 1}" fill="${colorFor(n.name)}" rx="1"/>${label ? `<text x="${(x + 2).toFixed(2)}" y="${depth + 11.5}">${esc(label)}</text>` : ""}</g>`,
    );
    let cx = x;
    const kids = [...n.children.values()].sort((a, b) => b.value - a.value);
    for (const k of kids) {
      walk(k, cx, depth + 1);
      cx += (k.value / total) * width;
    }
  };
  walk(root, 0, 0);
  const height = (maxDepth + 1) * rowH + 40;
  // y positions are depth indexes; flip so root is at the bottom.
  const body = rects.map((r) => r.replace(/ y="(\d+)"/, (_m, d) => ` y="${height - 24 - (Number(d) + 1) * rowH}"`).replace(/<text x="([\d.]+)" y="(\d+)\.5"/, (_m, x, d) => `<text x="${x}" y="${height - 24 - (Number(d) + 1) * rowH + 11.5}"`)).join("\n");
  return `<?xml version="1.0" standalone="no"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Verdana, sans-serif" font-size="11">
<style>.f rect:hover{stroke:#000;stroke-width:1}.f text{pointer-events:none;fill:#000}</style>
<rect width="100%" height="100%" fill="#f8f8f8"/>
<text x="${width / 2}" y="18" text-anchor="middle" font-size="15">${esc(opts.title ?? "Flame Graph")} — ${total} samples</text>
${body}
<text x="8" y="${height - 6}" fill="#666">Generated by DEA (Debug Anything). Hover for counts; width = share of samples.</text>
</svg>
`;
}
