import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchJsonConfig, patchTomlConfig, setup, TOML_BLOCK } from "../src/setup.js";

describe("setup config patching", () => {
  it("adds dea to an existing JSON config without touching other servers", () => {
    const { next, changed } = patchJsonConfig(JSON.stringify({ mcpServers: { other: { command: "x" } }, theme: "dark" }));
    expect(changed).toBe(true);
    const obj = JSON.parse(next);
    expect(obj.theme).toBe("dark");
    expect(obj.mcpServers.other.command).toBe("x");
    expect(obj.mcpServers.dea).toEqual({ command: "npx", args: ["-y", "dea-agents@latest", "serve"] });
  });
  it("is idempotent", () => {
    const first = patchJsonConfig(null).next;
    expect(patchJsonConfig(first).changed).toBe(false);
  });
  it("refuses invalid JSON", () => {
    expect(() => patchJsonConfig("{not json")).toThrow(/valid JSON/);
  });
  it("appends or replaces the TOML table", () => {
    const a = patchTomlConfig('model = "o3"\n');
    expect(a.changed).toBe(true);
    expect(a.next).toBe('model = "o3"\n\n' + TOML_BLOCK);
    expect(patchTomlConfig(a.next).changed).toBe(false);
    const stale = 'model = "o3"\n\n[mcp_servers.dea]\ncommand = "old"\n\n[other]\nx = 1\n';
    const b = patchTomlConfig(stale);
    expect(b.changed).toBe(true);
    expect(b.next).toContain('args = ["-y", "dea-agents@latest", "serve"]');
    expect(b.next).toContain("[other]");
    expect(b.next).not.toContain('command = "old"');
  });
});

describe("setup against a fake home", () => {
  it("writes configs, backups and skills for detected agents", async () => {
    const home = mkdtempSync(join(tmpdir(), "dea-home-"));
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { other: {} } }));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "config.toml"), 'model = "x"\n');
    mkdirSync(join(home, ".cursor"));
    const logs: string[] = [];
    const { written } = await setup({ yes: true, home, log: (s) => logs.push(s) });
    expect(written).toContain(join(home, ".claude.json"));
    expect(existsSync(join(home, ".claude.json.bak-dea"))).toBe(true);
    expect(JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")).mcpServers.dea.command).toBe("npx");
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.dea]");
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(true);
    expect(existsSync(join(home, ".claude", "skills", "debug-anything", "SKILL.md"))).toBe(true);
    expect(existsSync(join(home, ".gemini", "settings.json"))).toBe(false); // not detected
    expect(logs.join("\n")).toContain("Restart your agent");
  });
  it("dry-run writes nothing", async () => {
    const home = mkdtempSync(join(tmpdir(), "dea-home-"));
    writeFileSync(join(home, ".claude.json"), "{}");
    const { written } = await setup({ yes: true, dryRun: true, home, log: () => {} });
    expect(written).toEqual([]);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe("{}");
  });
});

describe("dea init (project-level)", () => {
  it("writes .mcp.json, .cursor/mcp.json and an AGENTS.md rule, idempotently", async () => {
    const { init, patchAgentsMd } = await import("../src/setup.js");
    const dir = mkdtempSync(join(tmpdir(), "dea-proj-"));
    writeFileSync(join(dir, "CLAUDE.md"), "# My project\n\nRules.\n");
    const r = await init({ dir, log: () => {} });
    expect(r.written).toContain(join(dir, ".mcp.json"));
    expect(JSON.parse(readFileSync(join(dir, ".cursor", "mcp.json"), "utf8")).mcpServers.dea.command).toBe("npx");
    const md = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    expect(md.startsWith("# My project")).toBe(true);
    expect(md).toContain("## Runtime debugging with DEA");
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    const again = await init({ dir, log: () => {} });
    expect(again.written).toEqual([]);
    expect(patchAgentsMd(null).next).toContain("DEA");
  });
});
