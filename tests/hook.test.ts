import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { detectTriggers, renderNudge, HOOK_SCRIPT } from "../src/hook.js";
import { patchClaudeHooks, setup } from "../src/setup.js";

describe("proactive triggers", () => {
  it("detects runtime-problem signals in command output", () => {
    const ids = detectTriggers("Error: listen EADDRINUSE: address already in use :::3000\n", "output").map((h) => h.id);
    expect(ids).toContain("port_busy");
    expect(detectTriggers("FATAL ERROR: Reached heap limit JavaScript heap out of memory", "output")[0]!.id).toBe("oom");
    expect(detectTriggers("Test timeout of 5000ms exceeded", "output")[0]!.id).toBe("timeout");
    expect(detectTriggers("all 12 tests passed", "output")).toEqual([]);
  });
  it("detects symptom words in prompts but not in output", () => {
    expect(detectTriggers("the worker hangs after 20 requests", "prompt")[0]!.id).toBe("hang_words");
    expect(detectTriggers("my api is slow", "prompt")[0]!.id).toBe("slow_words");
    expect(detectTriggers("something slow happened", "output")).toEqual([]);
  });
  it("renders a nudge with the protocol", () => {
    const n = renderNudge(detectTriggers("EMFILE: too many open files", "output"), "output");
    expect(n).toContain("[DEA]");
    expect(n).toContain("inspect_files");
    expect(n).toContain("attach");
    expect(renderNudge([], "output")).toBe("");
  });
  it("standalone hook script emits additionalContext for Bash output and prompts, stays silent otherwise", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dea-hook-"));
    const script = join(dir, "dea-hook.mjs");
    writeFileSync(script, HOOK_SCRIPT);
    const run = async (ev: unknown) => (await execa("node", [script], { input: JSON.stringify(ev) })).stdout;
    const out = await run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "npm start" }, tool_response: { stdout: "", stderr: "Error: listen EADDRINUSE :::8080" } });
    const parsed = JSON.parse(out);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(parsed.hookSpecificOutput.additionalContext).toContain("dea port");
    expect(await run({ hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "dea port 8080" }, tool_response: { stdout: "EADDRINUSE" } })).toBe("");
    expect(await run({ hook_event_name: "PostToolUse", tool_name: "Read", tool_response: { stdout: "EADDRINUSE" } })).toBe("");
    const p = JSON.parse(await run({ hook_event_name: "UserPromptSubmit", prompt: "the celery worker is stuck again" }));
    expect(p.hookSpecificOutput.additionalContext).toContain("dump_stacks");
    expect(await run({ hook_event_name: "UserPromptSubmit", prompt: "rename this function" })).toBe("");
  });
});

describe("setup installs the Claude Code hook", () => {
  it("patches settings.json idempotently", () => {
    const a = patchClaudeHooks('{"permissions":{"allow":["Bash(ls:*)"]}}', "/h/.dea/hooks/dea-hook.mjs");
    expect(a.changed).toBe(true);
    const obj = JSON.parse(a.next);
    expect(obj.permissions.allow).toEqual(["Bash(ls:*)"]);
    expect(obj.hooks.PostToolUse[0].matcher).toBe("Bash");
    expect(obj.hooks.UserPromptSubmit[0].hooks[0].command).toContain("dea-hook.mjs");
    expect(patchClaudeHooks(a.next, "/h/.dea/hooks/dea-hook.mjs").changed).toBe(false);
  });
  it("writes the script and settings for a detected Claude Code install; --no-hooks skips", async () => {
    const home = mkdtempSync(join(tmpdir(), "dea-home-"));
    writeFileSync(join(home, ".claude.json"), "{}");
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), '{"theme":"dark"}');
    await setup({ yes: true, home, log: () => {} });
    expect(existsSync(join(home, ".dea", "hooks", "dea-hook.mjs"))).toBe(true);
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
    expect(settings.theme).toBe("dark");
    expect(settings.hooks.PostToolUse[0].hooks[0].command).toContain("dea-hook.mjs");
    expect(existsSync(join(home, ".claude", "settings.json.bak-dea"))).toBe(true);
    const home2 = mkdtempSync(join(tmpdir(), "dea-home-"));
    writeFileSync(join(home2, ".claude.json"), "{}");
    await setup({ yes: true, home: home2, hooks: false, log: () => {} });
    expect(existsSync(join(home2, ".dea", "hooks", "dea-hook.mjs"))).toBe(false);
  });
});
