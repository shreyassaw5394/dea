/**
 * lldb adapter (macOS): dump_stacks for native/Node targets.
 *   lldb -p PID --batch -o "thread backtrace all" -o detach
 */
import type { Adapter, AdapterContext } from "./types.js";
import type { ToolResult } from "../contracts.js";
import { ResultBuilder } from "../evidence.js";
import { runCapped, looksLikePermissionError, rootRequiredLimitation } from "../safety.js";
import { summarizeNativeStacks, type NativeThread } from "./gdb.js";

/** Parse `thread backtrace all` output (lldb). Pure. */
export function parseLldbBacktrace(raw: string): NativeThread[] {
  const threads: NativeThread[] = [];
  let cur: NativeThread | null = null;
  for (const line of raw.split("\n")) {
    let m = /^\*?\s*thread #(\d+)(?:, name = '([^']*)')?(?:, queue = '([^']*)')?/.exec(line);
    if (m) {
      const idx = Number(m[1]);
      const existing = threads.find((t) => t.index === idx);
      if (existing) {
        cur = existing;
        cur.frames = [];
        continue;
      }
      cur = { index: idx, name: m[2] ?? m[3], frames: [] };
      threads.push(cur);
      continue;
    }
    // frame #0: 0x00007ff8 libsystem_kernel.dylib`__psynch_cvwait + 10
    // frame #3: 0x0000000100003f2c app`main(argc=1, argv=...) at main.c:12:5
    m = /^\s*(?:\*\s*)?frame #(\d+): (0x[0-9a-f]+) ([^`]+)`(.+?)(?: \+ \d+)?(?: at (\S+))?$/.exec(line);
    if (m && cur) {
      const func = m[4]!.replace(/\(.*$/, "").trim();
      cur.frames.push({ n: Number(m[1]), func, loc: m[5] ?? m[3], addr: m[2] });
    }
  }
  return threads;
}

async function dumpStacks(ctx: AdapterContext): Promise<ToolResult> {
  const { session, target } = ctx;
  const b = new ResultBuilder("dump_stacks", session, target);
  if (!target.pid) return b.fail("no pid").build();
  const args = ["-p", String(target.pid), "--batch", "-o", "thread backtrace all", "-o", "detach", "-o", "quit"];
  const r = await runCapped("lldb", args, { timeoutMs: 45_000 });
  const raw = r.stdout + (r.stderr ? `\n--- stderr ---\n${r.stderr}` : "");
  const art = await b.writeArtifact("lldb-bt.txt", raw, "raw_text", `lldb ${args.join(" ")}`);
  if (looksLikePermissionError(raw) || /attach failed|not permitted|Permission denied|does not exist|unable to attach/i.test(raw)) {
    b.limitation(rootRequiredLimitation("dump_stacks", `lldb ${args.join(" ")}`));
    b.limitation("macOS: attaching to a process you did not spawn needs sudo, or the target must opt in (com.apple.security.get-task-allow). Hardened/SIP-protected binaries cannot be attached at all.");
    b.next("import_artifact (lldb, after running the sudo command above)", "inspect_sockets", "snapshot_memory", "profile_cpu (sample, own processes)");
    return b.fail("lldb could not attach (permission denied)").build();
  }
  const threads = parseLldbBacktrace(r.stdout);
  if (target.runtime === "node") b.limitation("native stacks only; JS frames appear as v8 internals. For JS-level stacks use the inspector (--inspect).");
  return summarizeNativeStacks(b, threads, art, "lldb");
}

export const lldbAdapter: Adapter = {
  name: "lldb",
  tools: ["dump_stacks"],
  platforms: ["darwin"],
  requires: ["lldb"],
  runtimes: ["native", "node", "go", "java", "unknown"],
  install: { darwin: "xcode-select --install" },
  priority: 5,
  check(base, env) {
    if (!env.isRoot) base.notes.push("macOS: attaching needs sudo unless the target is your own debuggable child");
    return base;
  },
  async run(tool, _args, ctx) {
    if (tool !== "dump_stacks") throw new Error(`lldb adapter cannot run ${tool}`);
    return dumpStacks(ctx);
  },
};
