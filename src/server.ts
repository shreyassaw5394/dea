/**
 * MCP server over stdio. Tools are registered 1:1 with the CLI.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { ToolArgs } from "./contracts.js";
import { runTool, TOOL_DESCRIPTIONS } from "./tools.js";
import { prompts } from "./prompts/index.js";
import { killTrackedChildren } from "./safety.js";
import { VERSION } from "./version.js";

export function createServer(): McpServer {
  const server = new McpServer(
    { name: "debuganything", version: VERSION },
    {
      instructions:
        "DebugAnything (Debug Anything) observes running processes, containers and pods with battle-tested local tools and returns structured evidence. Call readiness first, attach before anything else, detach at the end. Every finding cites evidence ids — never claim a root cause without one. capture_traffic requires consent: true; ask the user first. Read-only: Debug Anything never kills, signals or modifies the target. USE Debug Anything PROACTIVELY: when a command you ran hangs, a test times out, output shows EADDRINUSE / ECONNREFUSED / EMFILE / exit 137 / OOM / segfault, a server you started does not respond, or the user mentions slow, hang, leak, crash or a busy port — attach and measure (dump_stacks, inspect_sockets, profile_cpu, snapshot_memory, container_info) before proposing a theory, without waiting to be asked. After you change performance-sensitive code, re-measure and diff_runs to prove it.",
    },
  );

  for (const [name, schema] of Object.entries(ToolArgs)) {
    server.registerTool(
      name,
      {
        title: name,
        description: TOOL_DESCRIPTIONS[name as keyof typeof ToolArgs],
        inputSchema: schema.shape,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: name !== "attach", openWorldHint: false },
      },
      async (args: Record<string, unknown>) => {
        const result = await runTool(name, args ?? {});
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: !result.ok,
        };
      },
    );
  }

  for (const p of prompts) {
    const argsSchema: Record<string, z.ZodTypeAny> = {};
    for (const a of p.args) argsSchema[a.name] = (a.required ? z.string() : z.string().optional()).describe(a.description);
    server.registerPrompt(p.name, { title: p.name, description: p.description, argsSchema }, (args) => ({
      messages: [{ role: "user" as const, content: { type: "text" as const, text: p.render(args as Record<string, string | undefined>) } }],
    }));
  }

  return server;
}

export async function serve(): Promise<void> {
  const server = createServer();
  const transport = new StdioServerTransport();
  const shutdown = () => {
    killTrackedChildren();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);
  await server.connect(transport);
}

// Allow `node dist/server.js` directly.
const invokedDirectly = process.argv[1] && /server\.(js|ts)$/.test(process.argv[1]);
if (invokedDirectly) {
  serve().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
