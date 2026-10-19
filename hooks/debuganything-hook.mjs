#!/usr/bin/env node
// Debug Anything proactive hook for Claude Code. Installed by `debuganything setup`; remove the hooks entries in
// ~/.claude/settings.json (or run `debuganything setup --no-hooks`) to disable. Reads the hook event on stdin,
// prints additional context when command output or the prompt shows a runtime-problem signal.
const TRIGGERS = [{"id":"port_busy","pattern":"EADDRINUSE|address already in use|port (\\d+) is (already )?in use|bind\\(\\): Address already in use","flags":"i","scope":"both","hint":"run `debuganything port <port>` (or inspect_sockets) to see which pid holds the port; never kill it blindly"},{"id":"conn_refused","pattern":"ECONNREFUSED|connection refused|ECONNRESET|socket hang up|ETIMEDOUT|connect timed out|EHOSTUNREACH","flags":"i","scope":"output","hint":"attach Debug Anything to the client and run inspect_sockets / trace_syscalls (network) to see which remote fails and how"},{"id":"fd_exhaustion","pattern":"EMFILE|too many open files|ENFILE","flags":"i","scope":"both","hint":"attach Debug Anything and run inspect_files (fd growth, deleted-but-open) and inspect_sockets (CLOSE_WAIT pileups)"},{"id":"oom","pattern":"OOMKilled|Out of memory|oom-kill|exit(ed)? (code|status)[ =:]*137|Killed process \\d+|JavaScript heap out of memory|MemoryError|Cannot allocate memory","flags":"i","scope":"both","hint":"attach Debug Anything: container_info (OOM/limits) and snapshot_memory twice around load, then diff_runs to name the retainer"},{"id":"timeout","pattern":"timed? ?out after|Timeout - Async callback|Test timeout of|exceeded timeout|context deadline exceeded|TimeoutError","flags":"i","scope":"output","hint":"if the process under test is still running, attach Debug Anything and run dump_stacks (waiting on a lock? a socket?) before changing timeouts"},{"id":"hang_words","pattern":"\\b(hangs?|hanging|stuck|frozen|freezes|deadlock(ed)?|not responding|never (returns|finishes|completes))\\b","flags":"i","scope":"prompt","hint":"attach Debug Anything and run dump_stacks first — do not theorize about the hang from the code"},{"id":"slow_words","pattern":"\\b(slow|slower|latency|p99|p95|takes forever|sluggish|cpu (is )?(pegged|at 100)|100% cpu)\\b","flags":"i","scope":"prompt","hint":"attach Debug Anything and run profile_cpu then trace_syscalls (file,network) — measure before optimizing"},{"id":"leak_words","pattern":"\\b(memory (leak|keeps growing|grows|usage grows)|leaking|rss (grows|keeps)|heap (grows|keeps growing)|out of memory)\\b","flags":"i","scope":"prompt","hint":"attach Debug Anything, snapshot_memory, exercise the target, snapshot_memory again, diff_runs"},{"id":"crash_words","pattern":"\\b(crashed|crashes|keeps restarting|restart loop|CrashLoopBackOff|segfault|SIGSEGV|core dumped|exit code 1[34][0-9])\\b","flags":"i","scope":"both","hint":"attach Debug Anything to the container/pid and run container_info (exit code, OOM, restarts, log tail)"},{"id":"segv","pattern":"Segmentation fault|SIGSEGV|SIGABRT|SIGBUS|core dumped|fatal error: unexpected signal","flags":"i","scope":"output","hint":"if it restarted, attach Debug Anything and dump_stacks/profile_cpu to catch the lead-up; hand the symbol to a step debugger or a static-analysis tool"}];
let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let ev;
  try { ev = JSON.parse(raw); } catch { return; }
  const event = ev.hook_event_name || "";
  let text = "";
  let scope = "output";
  if (event === "UserPromptSubmit") { text = String(ev.prompt || ""); scope = "prompt"; }
  else if (event === "PostToolUse") {
    if (ev.tool_name !== "Bash") return;
    const r = ev.tool_response || {};
    text = [r.stdout, r.stderr, r.output, typeof r === "string" ? r : ""].filter(Boolean).join("\n");
    const cmd = String((ev.tool_input || {}).command || "");
    if (/\b(debuganything|debugany)\b/.test(cmd)) return; // don't nudge about Debug Anything's own output
  } else return;
  if (!text || text.length > 400000) return;
  const hits = [];
  for (const t of TRIGGERS) {
    if (t.scope !== "both" && t.scope !== scope) continue;
    const m = new RegExp(t.pattern, t.flags).exec(text);
    if (m) hits.push({ id: t.id, hint: t.hint, match: m[0].slice(0, 80) });
  }
  if (!hits.length) return;
  const where = scope === "output" ? "The last command's output" : "The user's message";
  const lines = hits.slice(0, 3).map((h) => "- " + h.id + " (\u201c" + h.match + "\u201d): " + h.hint);
  const additionalContext = ["[Debug Anything] " + where + " shows a runtime problem signal. Debug Anything is installed: observe before you theorize.", ...lines,
    "Protocol: readiness (once per session) \u2192 attach <pid|container|command> \u2192 the tool above \u2192 detach. Cite evidence ids (e.g. dump_stacks#2/e3) in your answer; capture_traffic needs the user's consent. Skip this if the user explicitly said not to attach to anything."].join("\n");
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext } }) + "\n");
});
