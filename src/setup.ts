/**
 * `dea setup` — register the MCP server + skill with Claude Code, Codex,
 * Cursor and Gemini CLI. Shows the exact change, backs up the file, writes.
 */
import { readFile, writeFile, mkdir, copyFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import pc from "picocolors";
import { HOOK_SCRIPT } from "./hook.js";

export const MCP_ENTRY = { command: "npx", args: ["-y", "dea-agents@latest", "serve"] } as const;

export interface AgentTarget {
  id: "claude" | "codex" | "cursor" | "gemini";
  label: string;
  configPath(home: string): string;
  /** Config exists → agent considered installed. Claude Code may have either file. */
  detect(home: string): boolean;
  format: "json" | "toml";
  /** JSON path to the mcpServers object, or TOML table name. */
  key: string;
  skillsDir?(home: string): string;
}

export const AGENTS: AgentTarget[] = [
  {
    id: "claude",
    label: "Claude Code",
    configPath: (h) => join(h, ".claude.json"),
    detect: (h) => existsSync(join(h, ".claude.json")) || existsSync(join(h, ".claude", "settings.json")) || existsSync(join(h, ".claude")),
    format: "json",
    key: "mcpServers",
    skillsDir: (h) => join(h, ".claude", "skills", "debug-anything"),
  },
  {
    id: "codex",
    label: "Codex",
    configPath: (h) => join(h, ".codex", "config.toml"),
    detect: (h) => existsSync(join(h, ".codex")),
    format: "toml",
    key: "mcp_servers.dea",
    skillsDir: (h) => join(h, ".codex", "skills", "debug-anything"),
  },
  {
    id: "cursor",
    label: "Cursor",
    configPath: (h) => join(h, ".cursor", "mcp.json"),
    detect: (h) => existsSync(join(h, ".cursor")),
    format: "json",
    key: "mcpServers",
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    configPath: (h) => join(h, ".gemini", "settings.json"),
    detect: (h) => existsSync(join(h, ".gemini")),
    format: "json",
    key: "mcpServers",
    skillsDir: (h) => join(h, ".gemini", "skills", "debug-anything"),
  },
];

/** Produce the new JSON config text given existing text. Pure. */
export function patchJsonConfig(existing: string | null, key = "mcpServers"): { next: string; changed: boolean } {
  let obj: Record<string, unknown> = {};
  if (existing && existing.trim()) {
    try {
      obj = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      throw new Error("existing config is not valid JSON; refusing to overwrite it");
    }
  }
  const servers = ((obj[key] as Record<string, unknown> | undefined) ?? {}) as Record<string, unknown>;
  const current = JSON.stringify(servers.dea ?? null);
  const desired = JSON.stringify(MCP_ENTRY);
  if (current === desired) return { next: existing ?? JSON.stringify(obj, null, 2) + "\n", changed: false };
  servers.dea = { command: MCP_ENTRY.command, args: [...MCP_ENTRY.args] };
  obj[key] = servers;
  return { next: JSON.stringify(obj, null, 2) + "\n", changed: true };
}

/** Claude Code hooks entries (settings.json). Pure. */
export function patchClaudeHooks(existing: string | null, scriptPath: string): { next: string; changed: boolean } {
  let obj: Record<string, any> = {};
  if (existing && existing.trim()) {
    try {
      obj = JSON.parse(existing);
    } catch {
      throw new Error("existing settings.json is not valid JSON; refusing to overwrite it");
    }
  }
  const cmd = `node "${scriptPath}"`;
  const hooks = (obj.hooks ??= {});
  let changed = false;
  const ensure = (event: string, matcher: string | undefined) => {
    const list: any[] = (hooks[event] ??= []);
    const has = list.some((g) => Array.isArray(g?.hooks) && g.hooks.some((h: any) => typeof h?.command === "string" && h.command.includes("dea-hook.mjs")));
    if (has) return;
    list.push({ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: cmd, timeout: 10 }] });
    changed = true;
  };
  ensure("PostToolUse", "Bash");
  ensure("UserPromptSubmit", undefined);
  return { next: JSON.stringify(obj, null, 2) + "\n", changed };
}

export const TOML_BLOCK = `[mcp_servers.dea]\ncommand = "npx"\nargs = ["-y", "dea-agents@latest", "serve"]\n`;

/** Patch a TOML config: replace an existing [mcp_servers.dea] table or append one. Pure, no TOML dependency. */
export function patchTomlConfig(existing: string | null): { next: string; changed: boolean } {
  const text = existing ?? "";
  const re = /^\[mcp_servers\.dea\]\n(?:(?!\[)[^\n]*\n?)*/m;
  if (re.test(text)) {
    const current = re.exec(text)![0];
    if (current.trim() === TOML_BLOCK.trim()) return { next: text, changed: false };
    return { next: text.replace(re, TOML_BLOCK), changed: true };
  }
  const sep = text.length && !text.endsWith("\n") ? "\n\n" : text.length ? "\n" : "";
  return { next: text + sep + TOML_BLOCK, changed: true };
}

function skillSourceDir(): string {
  // dist/cli.js → ../skills ; src/setup.ts → ../skills
  const here = dirname(fileURLToPath(import.meta.url));
  for (const cand of [join(here, "..", "skills", "debug-anything"), join(here, "..", "..", "skills", "debug-anything")]) {
    if (existsSync(join(cand, "SKILL.md"))) return cand;
  }
  throw new Error("skills/debug-anything/SKILL.md not found next to the package");
}

export interface SetupOptions {
  yes?: boolean;
  home?: string;
  agents?: string[];
  dryRun?: boolean;
  /** Install the Claude Code proactive hook (default true). */
  hooks?: boolean;
  /** Test hook. */
  log?: (s: string) => void;
}

export async function setup(opts: SetupOptions = {}): Promise<{ written: string[]; skipped: string[] }> {
  const home = opts.home ?? homedir();
  const log = opts.log ?? ((s: string) => process.stdout.write(s + "\n"));
  const wanted = AGENTS.filter((a) => (opts.agents ? opts.agents.includes(a.id) : a.detect(home)));
  const written: string[] = [];
  const skipped: string[] = [];
  if (wanted.length === 0) {
    log(pc.yellow("No supported agent detected (looked for ~/.claude.json, ~/.codex/, ~/.cursor/, ~/.gemini/)."));
    log(`Add this to your agent's MCP config manually:\n${JSON.stringify({ mcpServers: { dea: MCP_ENTRY } }, null, 2)}`);
    return { written, skipped };
  }
  log(pc.bold("DEA setup will:"));
  const plans: Array<{ agent: AgentTarget; path: string; next: string; changed: boolean; existing: string | null }> = [];
  for (const agent of wanted) {
    const path = agent.configPath(home);
    const existing = existsSync(path) ? await readFile(path, "utf8") : null;
    const { next, changed } = agent.format === "json" ? patchJsonConfig(existing, agent.key) : patchTomlConfig(existing);
    plans.push({ agent, path, next, changed, existing });
    log(`\n${pc.cyan("•")} ${pc.bold(agent.label)} → ${path} ${changed ? "" : pc.dim("(already registered)")}`);
    if (changed) {
      log(pc.dim(agent.format === "json" ? JSON.stringify({ [agent.key]: { dea: MCP_ENTRY } }, null, 2) : TOML_BLOCK.trim()));
    }
    if (agent.skillsDir) log(pc.dim(`  + copy skills/debug-anything/SKILL.md → ${agent.skillsDir(home)}/SKILL.md`));
    if (agent.id === "claude" && opts.hooks !== false) {
      log(pc.dim(`  + write ${join(home, ".dea", "hooks", "dea-hook.mjs")} and register it in ${join(home, ".claude", "settings.json")} (hooks.PostToolUse[Bash], hooks.UserPromptSubmit) so the agent reaches for DEA on EADDRINUSE / OOM / timeouts / "it hangs" without being asked. Disable with --no-hooks.`));
    }
  }
  if (opts.dryRun) {
    log(pc.dim("\n--dry-run: nothing written."));
    return { written, skipped: plans.map((p) => p.path) };
  }
  if (!opts.yes) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl.question("\nApply these changes? Existing files are backed up to *.bak-dea [y/N] ")).trim().toLowerCase();
    rl.close();
    if (ans !== "y" && ans !== "yes") {
      log("aborted; nothing written");
      return { written, skipped: plans.map((p) => p.path) };
    }
  }
  const skillSrc = skillSourceDir();
  for (const p of plans) {
    if (p.changed) {
      await mkdir(dirname(p.path), { recursive: true });
      if (p.existing !== null) await copyFile(p.path, `${p.path}.bak-dea`);
      await writeFile(p.path, p.next);
      written.push(p.path);
    } else skipped.push(p.path);
    if (p.agent.skillsDir) {
      const dir = p.agent.skillsDir(home);
      await mkdir(dir, { recursive: true });
      await copyFile(join(skillSrc, "SKILL.md"), join(dir, "SKILL.md"));
      written.push(join(dir, "SKILL.md"));
    }
    if (p.agent.id === "claude" && opts.hooks !== false) {
      const hookDir = join(home, ".dea", "hooks");
      await mkdir(hookDir, { recursive: true });
      const script = join(hookDir, "dea-hook.mjs");
      await writeFile(script, HOOK_SCRIPT, { mode: 0o755 });
      written.push(script);
      const settingsPath = join(home, ".claude", "settings.json");
      const existing = existsSync(settingsPath) ? await readFile(settingsPath, "utf8") : null;
      const { next, changed } = patchClaudeHooks(existing, script);
      if (changed) {
        await mkdir(dirname(settingsPath), { recursive: true });
        if (existing !== null) await copyFile(settingsPath, `${settingsPath}.bak-dea`);
        await writeFile(settingsPath, next);
        written.push(settingsPath);
      }
    }
  }
  log(`\n${pc.green("Done.")} ${written.length} file(s) written. ${pc.bold("Restart your agent")} and ask it: “My API gets slow after a few minutes — attach to it and tell me why, with evidence.”`);
  return { written, skipped };
}

export async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}


// ---------------------------------------------------------------------------
// `dea init` — project-level setup so every teammate's agent gets DEA
// ---------------------------------------------------------------------------

export const AGENTS_MD_BLOCK = `## Runtime debugging with DEA

DEA (Debug Anything) is registered as an MCP server for this repo (\`.mcp.json\`, \`.cursor/mcp.json\`).
When something *running* misbehaves — a command hangs, a test times out, you see EADDRINUSE / ECONNREFUSED /
EMFILE / exit 137 / OOM / a segfault, a server you started does not respond, or the user says slow, hang,
leak or crash — attach and measure before theorizing: \`readiness\` → \`attach\` → \`dump_stacks\` /
\`profile_cpu\` / \`inspect_sockets\` / \`snapshot_memory\` / \`container_info\` → \`detach\`. Cite evidence ids
(e.g. \`profile_cpu#2/e3\`). Read-only tools need no permission; \`capture_traffic\` needs the user's consent.
After a performance fix, re-measure and \`diff_runs\` to prove it; put the evidence ids in the PR.
Docs: https://github.com/shreyassaw5394/dea
`;

export interface InitOptions {
  dir?: string;
  dryRun?: boolean;
  log?: (s: string) => void;
}

/** Append the DEA block to an AGENTS.md/CLAUDE.md-style file if not present. Pure. */
export function patchAgentsMd(existing: string | null): { next: string; changed: boolean } {
  const text = existing ?? "";
  if (text.includes("## Runtime debugging with DEA")) return { next: text, changed: false };
  const sep = text.length === 0 ? "" : text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  return { next: text + sep + AGENTS_MD_BLOCK, changed: true };
}

export async function init(opts: InitOptions = {}): Promise<{ written: string[]; skipped: string[] }> {
  const dir = opts.dir ?? process.cwd();
  const log = opts.log ?? ((s: string) => process.stdout.write(s + "\n"));
  const written: string[] = [];
  const skipped: string[] = [];
  const plans: Array<{ path: string; next: string; changed: boolean; existing: string | null; what: string }> = [];
  for (const rel of [".mcp.json", join(".cursor", "mcp.json")]) {
    const path = join(dir, rel);
    const existing = existsSync(path) ? await readFile(path, "utf8") : null;
    const { next, changed } = patchJsonConfig(existing);
    plans.push({ path, next, changed, existing, what: "MCP server entry" });
  }
  // One agent-instructions file: prefer existing AGENTS.md, then CLAUDE.md, else create AGENTS.md.
  const candidates = ["AGENTS.md", "CLAUDE.md"].map((f) => join(dir, f));
  const target = candidates.find((p) => existsSync(p)) ?? candidates[0]!;
  const existingMd = existsSync(target) ? await readFile(target, "utf8") : null;
  const md = patchAgentsMd(existingMd);
  plans.push({ path: target, next: md.next, changed: md.changed, existing: existingMd, what: "runtime-debugging rule for agents" });

  log(pc.bold(`DEA init in ${dir} will:`));
  for (const p of plans) log(`${pc.cyan("•")} ${p.path} ${p.changed ? pc.dim(`(+ ${p.what})`) : pc.dim("(already set up)")}`);
  if (opts.dryRun) {
    log(pc.dim("--dry-run: nothing written."));
    return { written, skipped: plans.map((p) => p.path) };
  }
  for (const p of plans) {
    if (!p.changed) {
      skipped.push(p.path);
      continue;
    }
    await mkdir(dirname(p.path), { recursive: true });
    if (p.existing !== null) await copyFile(p.path, `${p.path}.bak-dea`);
    await writeFile(p.path, p.next);
    written.push(p.path);
  }
  log(`${pc.green("Done.")} Commit these files so every teammate's agent gets DEA. Each person still runs ${pc.bold("npx dea-agents setup")} once for the skill and hook.`);
  return { written, skipped };
}
