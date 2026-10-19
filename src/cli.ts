/**
 * commander CLI, 1:1 with the MCP tools. `--json` prints the exact ToolResult.
 */
import { Command } from "commander";
import pc from "picocolors";
import { runTool } from "./tools.js";
import type { ToolResult } from "./contracts.js";
import { listSessions, pruneSessions } from "./session.js";
import { humanBytes } from "./evidence.js";
import { VERSION } from "./version.js";

const program = new Command();
program
  .name("debuganything")
  .description("◎ Debug Anything. Observe any running process. No breakpoints, no restarts, no instrumentation.\n  https://debuganything.dev")
  .version(VERSION, "-v, --version")
  .option("--json", "print the raw ToolResult JSON")
  .showHelpAfterError();

function wantJson(cmd: Command): boolean {
  return Boolean(cmd.optsWithGlobals().json);
}

async function emit(cmd: Command, result: ToolResult): Promise<void> {
  if (wantJson(cmd)) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  } else {
    process.stdout.write(renderHuman(result));
  }
  if (!result.ok) process.exitCode = 1;
}

const SEV = { high: pc.red, warn: pc.yellow, info: pc.cyan } as const;

export function renderHuman(r: ToolResult): string {
  const out: string[] = [];
  const head = `${r.ok ? pc.green("✔") : pc.red("✖")} ${pc.bold(r.tool)}${r.run_id ? pc.dim(` (${r.run_id})`) : ""}${r.session_id ? pc.dim(`  session ${r.session_id}`) : ""}  ${pc.dim(`${r.duration_ms} ms`)}`;
  out.push(head);
  if (r.error) out.push(`  ${pc.red("error:")} ${r.error}`);
  if (r.findings.length) {
    out.push(pc.bold("  Findings"));
    for (const f of r.findings) {
      const color = SEV[f.severity];
      out.push(`  ${color(pad(f.severity.toUpperCase(), 5))} ${f.summary} ${pc.dim(`[${f.confidence}; ${f.evidence_ids.join(",")}]`)}`);
      if (f.detail) out.push(`        ${pc.dim(f.detail)}`);
    }
  }
  if (r.evidence.length) {
    out.push(pc.bold("  Evidence"));
    for (const e of r.evidence.slice(0, 25)) {
      out.push(`  ${pc.dim(pad(e.id, 4))} ${pad(e.kind, 15)} ${e.summary}${e.artifact ? pc.dim(`  → ${short(e.artifact)}${e.lines ? `:${e.lines[0]}-${e.lines[1]}` : ""}`) : ""}`);
    }
    if (r.evidence.length > 25) out.push(pc.dim(`  … ${r.evidence.length - 25} more (use --json)`));
  }
  if (r.limitations.length) {
    out.push(pc.bold("  Limitations"));
    for (const l of r.limitations) out.push(`  ${pc.yellow("!")} ${l}`);
  }
  if (r.artifacts.length) {
    out.push(pc.bold("  Artifacts"));
    for (const a of r.artifacts) out.push(`  ${pc.dim("•")} ${a.path} ${pc.dim(`(${a.kind}, ${humanBytes(a.bytes)}${a.truncated ? ", truncated" : ""})`)}`);
  }
  if (r.suggested_next.length) out.push(`  ${pc.dim("next:")} ${r.suggested_next.join(", ")}`);
  return out.join("\n") + "\n";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}
function short(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

// --- commands -------------------------------------------------------------

program
  .command("serve")
  .alias("mcp")
  .description("run the MCP server over stdio")
  .action(async () => {
    const { serve } = await import("./server.js");
    await serve();
  });

program
  .command("setup")
  .description("register Debug Anything's MCP server and skill with Claude Code / Codex / Cursor / Gemini CLI")
  .option("--yes", "do not ask for confirmation")
  .option("--home <dir>", "home directory to write configs into (for testing)")
  .option("--agents <list>", "comma-separated subset: claude,codex,cursor,gemini")
  .option("--dry-run", "show what would change without writing")
  .option("--no-hooks", "do not install the Claude Code proactive hook")
  .action(async (opts) => {
    const { setup } = await import("./setup.js");
    await setup({ yes: Boolean(opts.yes), home: opts.home, agents: opts.agents?.split(",").map((s: string) => s.trim()), dryRun: Boolean(opts.dryRun), hooks: opts.hooks !== false });
  });

program
  .command("hook")
  .argument("[event]", "PostToolUse | UserPromptSubmit (read from stdin JSON when omitted)")
  .description("agent hook: read a hook event on stdin, print a Debug Anything nudge when the output/prompt shows a runtime-problem signal")
  .action(async (_event?: string) => {
    const { detectTriggers, renderNudge } = await import("./hook.js");
    let raw = "";
    for await (const c of process.stdin) raw += c;
    let ev: any = {};
    try {
      ev = JSON.parse(raw);
    } catch {
      return;
    }
    const scope = ev.hook_event_name === "UserPromptSubmit" ? "prompt" : "output";
    const text = scope === "prompt" ? String(ev.prompt ?? "") : [ev.tool_response?.stdout, ev.tool_response?.stderr, ev.tool_response?.output].filter(Boolean).join("\n");
    const nudge = renderNudge(detectTriggers(text, scope), scope);
    if (nudge) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: ev.hook_event_name, additionalContext: nudge } }) + "\n");
  });

program
  .command("init")
  .description("set up THIS repo for Debug Anything: .mcp.json + .cursor/mcp.json entries and an agent rule in AGENTS.md/CLAUDE.md (commit them)")
  .option("--dir <path>", "project directory (default: cwd)")
  .option("--dry-run", "show what would change without writing")
  .action(async (opts) => {
    const { init } = await import("./setup.js");
    await init({ dir: opts.dir, dryRun: Boolean(opts.dryRun) });
  });

program
  .command("readiness")
  .alias("doctor")
  .description("probe OS, tools on PATH and permissions")
  .action(async function (this: Command) {
    await emit(this, await runTool("readiness", {}));
  });

program
  .command("ps")
  .alias("list-processes")
  .description("list processes to pick a target")
  .option("--filter <text>", "substring filter on command/args/user")
  .option("--limit <n>", "max rows", "50")
  .action(async function (this: Command, opts) {
    const r = await runTool("list_processes", { filter: opts.filter, limit: Number(opts.limit) });
    if (wantJson(this)) return emit(this, r);
    const rows = (r.evidence[0]?.data as Array<Record<string, unknown>> | undefined) ?? [];
    process.stdout.write(`${pad("PID", 8)}${pad("USER", 12)}${pad("%CPU", 7)}${pad("RSS", 10)}${pad("CONTAINER", 14)}COMMAND\n`);
    for (const p of rows) {
      process.stdout.write(`${pad(String(p.pid), 8)}${pad(String(p.user).slice(0, 11), 12)}${pad(String(p.cpu), 7)}${pad(humanBytes(Number(p.rss_kb) * 1024), 10)}${pad(String(p.container ?? "-"), 14)}${String(p.comm)} ${pc.dim(String(p.args ?? "").slice(0, 80))}\n`);
    }
    if (!r.ok) await emit(this, r);
  });

program
  .command("attach")
  .description("attach to <pid|container|pod> or `-- cmd args...` and print a session id")
  .argument("<target...>", "pid, container, pod, or a command after --")
  .option("--kind <kind>", "pid|container|pod|command (default: auto)")
  .action(async function (this: Command, targetParts: string[], opts) {
    const target = targetParts.join(" ");
    const kind = opts.kind ?? (targetParts.length > 1 ? "command" : undefined);
    const r = await runTool("attach", { target, kind });
    await emit(this, r);
    if (r.ok && !wantJson(this)) process.stdout.write(`\n${pc.bold("session:")} ${r.session_id}\n`);
  });

program
  .command("detach")
  .requiredOption("--session <id>", "session id")
  .description("stop captures, write report, keep artifacts")
  .action(async function (this: Command, opts) {
    await emit(this, await runTool("detach", { session_id: opts.session }));
  });

const sessionTool = (name: string, tool: string, desc: string, extra?: (c: Command) => Command, map?: (o: Record<string, unknown>) => Record<string, unknown>) => {
  let c = program.command(name).description(desc).requiredOption("--session <id>", "session id");
  if (extra) c = extra(c);
  c.action(async function (this: Command, opts: Record<string, unknown>) {
    const args = { session_id: opts.session, ...(map ? map(opts) : {}) };
    await emit(this, await runTool(tool, args));
  });
};

sessionTool(
  "trace",
  "trace_syscalls",
  "strace the target (Linux)",
  (c) => c.option("--duration <s>", "seconds (max 60)", "10").option("--categories <list>", "network,file,process,signal,memory,all", "all"),
  (o) => ({ duration_s: Number(o.duration), categories: String(o.categories).split(",") }),
);
sessionTool("profile", "profile_cpu", "CPU profile (py-spy / perf / sample)", (c) => c.option("--duration <s>", "seconds (max 60)", "15").option("--consent", "consent for heavy profiling"), (o) => ({ duration_s: Number(o.duration), consent: Boolean(o.consent) }));
sessionTool("stacks", "dump_stacks", "dump all thread stacks");
sessionTool("sockets", "inspect_sockets", "listening ports, connections, states, fd counts");
sessionTool("files", "inspect_files", "open fds by type, growth, deleted-but-open", (c) => c.option("--window <s>", "growth window seconds", "3"), (o) => ({ window_s: Number(o.window) }));
sessionTool(
  "capture",
  "capture_traffic",
  "tcpdump scoped to the target's ports (requires --consent)",
  (c) => c.option("--duration <s>", "seconds (max 30)", "10").option("--filter <bpf>", "extra BPF filter").option("--consent", "I have authorization to capture this traffic"),
  (o) => ({ duration_s: Number(o.duration), filter: o.filter, consent: Boolean(o.consent) }),
);
sessionTool("memory", "snapshot_memory", "RSS over time + heap snapshot/retainers", (c) => c.option("--no-heap", "skip heap snapshot").option("--window <s>", "RSS sampling window seconds", "3"), (o) => ({ heap: o.heap !== false, window_s: Number(o.window) }));
sessionTool("container", "container_info", "docker inspect/stats/logs + cgroup limits");

program
  .command("diff")
  .requiredOption("--session <id>", "session id")
  .argument("<a>", "earlier run id (snapshot_memory#1), or <session_id>:<run> for a baseline from another session")
  .argument("<b>", "later run id, e.g. snapshot_memory#2")
  .description("diff two runs — within a session, or against a recorded healthy baseline session")
  .action(async function (this: Command, a: string, b: string, opts) {
    await emit(this, await runTool("diff_runs", { session_id: opts.session, a, b }));
  });

program
  .command("report")
  .requiredOption("--session <id>", "session id")
  .option("--md <file>", "also write markdown to this file")
  .option("--html", "also render a self-contained, shareable report.html (embedded flamegraphs)")
  .description("markdown report of the session")
  .action(async function (this: Command, opts) {
    const r = await runTool("report", { session_id: opts.session, out: opts.md, html: Boolean(opts.html) });
    if (wantJson(this)) return emit(this, r);
    const md = (r.evidence[0]?.data as { markdown_preview?: string } | undefined)?.markdown_preview;
    if (md) process.stdout.write(md + (md.length >= 3000 ? "\n…(full report in artifact)\n" : "\n"));
    await emit(this, r);
  });

program
  .command("why")
  .alias("investigate")
  .argument("<target...>", "pid, container, pod, or a command after --")
  .option("--symptom <s>", "slow | leak | hang | crash | triage (default: triage)", "triage")
  .option("--kind <kind>", "pid|container|pod|command (default: auto)")
  .option("--wait <s>", "leak: seconds between the two memory snapshots", "15")
  .option("--duration <s>", "profile/trace seconds", "10")
  .description("one-command investigation: attach → the right tools for the symptom → report → detach")
  .action(async function (this: Command, targetParts: string[], opts) {
    const { investigate, summarizeFindings } = await import("./investigate.js");
    const json = wantJson(this);
    const target = targetParts.join(" ");
    const symptom = ["slow", "leak", "hang", "crash", "triage"].includes(opts.symptom) ? opts.symptom : "triage";
    if (!json) process.stdout.write(`${pc.bold("Debug Anything")} investigating ${pc.cyan(target)} for ${pc.cyan(symptom)} …\n\n`);
    const out = await investigate(target, {
      symptom,
      kind: opts.kind ?? (targetParts.length > 1 ? "command" : undefined),
      waitS: Number(opts.wait),
      durationS: Number(opts.duration),
      onResult: (r) => {
        if (!json) process.stdout.write(renderHuman(r) + "\n");
      },
      onNote: (s) => {
        if (!json) process.stdout.write(pc.dim(`… ${s}\n`));
      },
    });
    if (json) return void process.stdout.write(JSON.stringify(out, null, 2) + "\n");
    const ranked = summarizeFindings(out.results.filter((r) => !["attach", "detach", "report"].includes(r.tool)));
    process.stdout.write(pc.bold("\n=== Summary ===\n"));
    if (!ranked.length) process.stdout.write("no findings — see limitations above\n");
    for (const f of ranked.slice(0, 12)) process.stdout.write(`${SEV[f.severity as keyof typeof SEV](pad(f.severity.toUpperCase(), 5))} ${f.summary} ${pc.dim(`[${f.confidence}; ${f.ref}]`)}\n`);
    if (out.report_path) process.stdout.write(`\n${pc.dim("report:")} ${out.report_path}\n`);
    if (out.results.some((r) => !r.ok)) process.exitCode = 1;
  });

program
  .command("import")
  .argument("<tool>", "strace | fs_usage | perf_script | folded | pyspy_dump | sample | gdb | lldb | lsof | tcpdump")
  .argument("<file>", "raw output file you captured yourself (e.g. with sudo)")
  .requiredOption("--session <id>", "session id")
  .option("--duration <s>", "how long the capture ran (for profiles without timestamps)")
  .description("analyze tool output you captured yourself — same evidence and findings as a live run")
  .action(async function (this: Command, tool: string, file: string, opts) {
    await emit(this, await runTool("import_artifact", { session_id: opts.session, tool, path: file, duration_s: opts.duration ? Number(opts.duration) : undefined }));
  });

program
  .command("call")
  .argument("<tool>", "MCP tool name, e.g. trace_syscalls")
  .argument("[args]", "JSON object of arguments", "{}")
  .description("call any tool by name with JSON args and print the ToolResult (used by the Python SDK and scripts)")
  .action(async (tool: string, args: string) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(args) as Record<string, unknown>;
    } catch {
      process.stdout.write(JSON.stringify({ ok: false, tool, error: "args must be a JSON object" }) + "\n");
      process.exitCode = 1;
      return;
    }
    const r = await runTool(tool, parsed);
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
    if (!r.ok) process.exitCode = 1;
  });

program
  .command("port")
  .argument("<port>", "TCP/UDP port number")
  .description("who holds a port? (lsof -i :PORT, no session needed)")
  .action(async function (this: Command, port: string) {
    const { whoHoldsPort } = await import("./adapters/lsof.js");
    const r = await whoHoldsPort(Number(port));
    await emit(this, r);
  });

const sessions = program.command("sessions").description("manage ~/.debuganything/sessions");
sessions
  .command("list")
  .description("list sessions")
  .action(async function (this: Command) {
    const list = await listSessions();
    if (wantJson(this)) return void process.stdout.write(JSON.stringify(list, null, 2) + "\n");
    if (!list.length) return void process.stdout.write("no sessions\n");
    process.stdout.write(`${pad("SESSION", 26)}${pad("STATE", 10)}${pad("RUNS", 6)}${pad("SIZE", 10)}TARGET\n`);
    for (const s of list) process.stdout.write(`${pad(s.id, 26)}${pad(s.state, 10)}${pad(String(s.runs), 6)}${pad(humanBytes(s.bytes), 10)}${s.target}\n`);
  });
sessions
  .command("prune")
  .description("remove detached sessions older than N days (default 7)")
  .option("--days <n>", "age threshold", "7")
  .option("--all", "remove every session")
  .action(async (opts) => {
    const removed = await pruneSessions({ olderThanDays: Number(opts.days), all: Boolean(opts.all) });
    process.stdout.write(removed.length ? `removed ${removed.length}: ${removed.join(", ")}\n` : "nothing to prune\n");
  });

program
  .command("update")
  .description("update Debug Anything to the latest published version")
  .action(async () => {
    const { execa } = await import("execa");
    process.stdout.write(pc.dim("$ npm install --global debuganything@latest\n"));
    const r = await execa("npm", ["install", "--global", "debuganything@latest"], { reject: false, stdio: "inherit" });
    if (r.exitCode !== 0) {
      process.stdout.write(`${pc.yellow("global install failed.")} If you use npx, nothing to do: \`npx -y debuganything@latest\` always fetches the latest.\n`);
      process.exitCode = 1;
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(pc.red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
