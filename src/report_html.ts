/**
 * Self-contained HTML session report: ranked findings with expandable
 * evidence, per-run detail, embedded flamegraphs. One file, no external
 * resources — made to be posted in a Slack thread or an issue.
 */
import { readFile } from "node:fs/promises";
import type { Session, ToolResult } from "./contracts.js";
import { redact } from "./safety.js";
import { VERSION } from "./version.js";

const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function renderHtmlReport(session: Session): Promise<string> {
  const runs: ToolResult[] = [];
  for (const r of session.runs) {
    try {
      runs.push(JSON.parse(await readFile(r.file, "utf8")) as ToolResult);
    } catch { /* skip */ }
  }
  const flames: Array<{ name: string; svg: string }> = [];
  for (const r of runs) {
    for (const a of r.artifacts ?? []) {
      if (a.kind === "flamegraph_svg" && flames.length < 3) {
        try {
          const svg = await readFile(a.path, "utf8");
          if (svg.includes("<svg") && svg.length < 3_000_000) flames.push({ name: a.path.split("/").pop()!, svg });
        } catch { /* skip */ }
      }
    }
  }
  return renderHtmlReportFromRuns(session, runs, flames);
}

/** Pure renderer, testable. */
export function renderHtmlReportFromRuns(session: Session, runs: ToolResult[], flames: Array<{ name: string; svg: string }> = []): string {
  const t = session.target;
  const all = runs.flatMap((r) => r.findings.map((f) => ({ run: r, f })));
  const order = { high: 0, warn: 1, info: 2 } as const;
  all.sort((a, b) => order[a.f.severity] - order[b.f.severity]);
  const evOf = (run: ToolResult, id: string) => run.evidence.find((e) => e.id === id);
  const counts = { high: 0, warn: 0, info: 0 } as Record<string, number>;
  for (const { f } of all) counts[f.severity] = (counts[f.severity] ?? 0) + 1;

  const findingCards = all.map(({ run, f }) => `
    <div class="finding ${f.severity}">
      <div><span class="sev">${f.severity}</span> ${esc(redact(f.summary))} <span class="dim">· ${esc(f.confidence)} · ${esc(run.run_id ?? run.tool)}</span></div>
      ${f.detail ? `<div class="detail">${esc(redact(f.detail))}</div>` : ""}
      <div class="ev">${f.evidence_ids.map((id) => {
        const e = evOf(run, id);
        if (!e) return "";
        const payload = e.data !== undefined ? JSON.stringify(e.data, null, 2) : "";
        return `<details><summary><code>${esc(id)}</code> ${esc(redact(e.summary))}</summary>${payload ? `<pre>${esc(redact(payload).slice(0, 8000))}</pre>` : ""}${e.artifact ? `<div class="dim">source: <code>${esc(e.artifact.split("/").pop())}</code>${e.lines ? ` L${e.lines[0]}–${e.lines[1]}` : ""}</div>` : ""}</details>`;
      }).join("")}</div>
    </div>`).join("\n");

  const runRows = runs.map((r) => `
    <details class="run"><summary><b>${esc(r.run_id ?? r.tool)}</b> — ${r.ok ? "ok" : "FAILED"} · ${r.duration_ms} ms · ${r.evidence.length} evidence · ${r.findings.length} finding(s)</summary>
      ${r.error ? `<div class="detail">error: ${esc(redact(r.error))}</div>` : ""}
      <table><tr><th>id</th><th>kind</th><th>summary</th></tr>
      ${r.evidence.map((e) => `<tr><td><code>${esc(e.id)}</code></td><td>${esc(e.kind)}</td><td>${esc(redact(e.summary))}</td></tr>`).join("")}
      </table>
      ${r.limitations?.length ? `<div class="dim">limitations: ${r.limitations.map((l) => esc(redact(l))).join(" · ")}</div>` : ""}
    </details>`).join("\n");

  const flameBlocks = flames.map((f) => `<details open class="run"><summary><b>flamegraph</b> — ${esc(f.name)}</summary><div class="flame">${f.svg.replace(/<script[\s\S]*?<\/script>/gi, "")}</div></details>`).join("\n");

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>DEA report — ${esc(t.kind)} ${esc(t.id)}</title>
<style>
:root{--bg:#0b0d12;--fg:#eef2f8;--muted:#9aa3b2;--dim:#5f6878;--acc:#7cc4ff;--warn:#ffb86b;--high:#ff7b7b;--card:#121521;--line:#1f2434;color-scheme:dark}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;padding:32px 20px}
.wrap{max-width:920px;margin:0 auto}code,pre{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
h1{font-size:24px;margin:0 0 4px}.dim{color:var(--dim);font-size:13px}.meta{color:var(--muted);font-size:14px;margin-bottom:22px}
.badges span{display:inline-block;border:1px solid var(--line);border-radius:999px;padding:2px 10px;font-size:12.5px;margin-right:6px}
.finding{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--dim);border-radius:10px;padding:12px 14px;margin-top:10px}
.finding.high{border-left-color:var(--high)}.finding.warn{border-left-color:var(--warn)}.finding.info{border-left-color:var(--acc)}
.sev{font-size:11px;font-weight:800;letter-spacing:.12em;text-transform:uppercase}
.finding.high .sev{color:var(--high)}.finding.warn .sev{color:var(--warn)}.finding.info .sev{color:var(--acc)}
.detail{color:var(--muted);font-size:13.5px;margin-top:6px;white-space:pre-wrap}
.ev{margin-top:8px;border-top:1px dashed var(--line);padding-top:6px;font-size:13.5px;color:var(--muted)}
details{margin:6px 0}summary{cursor:pointer}pre{background:#0f1320;border:1px solid var(--line);border-radius:8px;padding:10px;overflow-x:auto;font-size:12px;max-height:340px}
.run{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:10px 14px;margin-top:10px;font-size:14px}
table{border-collapse:collapse;width:100%;margin-top:8px;font-size:13px}th,td{text-align:left;border-bottom:1px solid var(--line);padding:5px 8px;vertical-align:top}th{color:var(--dim);font-weight:600}
.flame{overflow-x:auto;background:#fff;border-radius:8px;margin-top:8px}.flame svg{display:block;max-width:100%;height:auto}
footer{margin-top:34px;color:var(--dim);font-size:12.5px;border-top:1px solid var(--line);padding-top:14px}
h2{font-size:17px;margin:26px 0 4px}
</style></head><body><div class="wrap">
<h1>DEA report</h1>
<div class="meta">${[`${esc(t.kind)} <code>${esc(t.id)}</code>`, t.pid && String(t.pid) !== t.id ? `pid ${t.pid}` : "", t.comm ? esc(t.comm) : "", t.runtime && t.runtime !== t.comm ? esc(t.runtime) : "", `${esc(t.host)} (${esc(session.platform)})`, esc(session.created_at)].filter(Boolean).join(" · ")}</div>
<div class="badges"><span style="color:var(--high)">${counts.high ?? 0} high</span><span style="color:var(--warn)">${counts.warn ?? 0} warn</span><span style="color:var(--acc)">${counts.info ?? 0} info</span><span>${runs.length} runs</span></div>
<h2>Findings</h2>
${findingCards || '<div class="dim">no findings recorded</div>'}
${flameBlocks ? `<h2>Flamegraphs</h2>${flameBlocks}` : ""}
<h2>Runs</h2>
${runRows}
<footer>Generated by <a href="https://debuganything.dev" style="color:var(--acc)">DEA — Debug Anything</a> v${esc(VERSION)} · session ${esc(session.id)} · every finding cites evidence ids; raw artifacts stay on the machine that ran DEA. Provided "as is", no warranty — verify before acting.</footer>
</div></body></html>`;
}
