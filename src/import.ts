/**
 * `debuganything import` / import_artifact: analyze raw tool output the user captured
 * themselves (typically with sudo, or on another machine). File handling lives
 * here; the parsing and finding logic is in analyze.ts (shared with the
 * in-browser analyzer).
 */
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import type { ImportTool, Session, ToolResult } from "./contracts.js";
import { ResultBuilder } from "./evidence.js";
import { LIMITS } from "./safety.js";
import { analyzeRaw, IMPORT_TOOL_MAP } from "./analyze.js";

export { IMPORT_TOOL_MAP, spanSeconds, analyzeText, detectTool } from "./analyze.js";

export async function importArtifact(session: Session, args: { tool: ImportTool; path: string; duration_s?: number }): Promise<ToolResult> {
  const toolName = IMPORT_TOOL_MAP[args.tool];
  const b = new ResultBuilder(toolName, session, session.target);
  let raw: string;
  try {
    const st = await stat(args.path);
    if (!st.isFile()) return b.fail(`${args.path} is not a regular file`).build();
    if (st.size > LIMITS.MAX_RAW_BYTES) return b.fail(`${args.path} is ${Math.round(st.size / 1024 / 1024)} MB; the import cap is ${LIMITS.MAX_RAW_BYTES / 1024 / 1024} MB (trim it first)`).build();
    raw = await readFile(args.path, "utf8");
  } catch (err) {
    return b.fail(`cannot read ${args.path}: ${(err as Error).message}`).build();
  }
  if (!raw.trim()) return b.fail(`${args.path} is empty`).build();
  const art = await b.writeArtifact(`imported-${basename(args.path)}`, raw, "raw_text", `imported ${args.tool} output from ${args.path}`);
  b.limitation(`imported from ${args.path}: Debug Anything did not run the tool, so flags, timing and target scope are whatever you used`);
  return analyzeRaw(b, { tool: args.tool, raw, duration_s: args.duration_s, art });
}
