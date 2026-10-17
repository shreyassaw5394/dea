import type { ProviderReadiness, Session, Target, ToolResult } from "../contracts.js";
import type { Readiness } from "../contracts.js";

export type Platform = "linux" | "darwin" | "win32";

export interface AdapterContext {
  session: Session;
  target: Target;
  readiness: Readiness;
}

export interface Adapter {
  /** Provider name, e.g. "strace". */
  name: string;
  /** MCP tool names this adapter can serve. */
  tools: string[];
  platforms: Platform[];
  /** Binaries that must be on PATH. */
  requires: string[];
  /** Optional: only serve these runtimes (e.g. py-spy → python). */
  runtimes?: Array<NonNullable<Target["runtime"]>>;
  /** Human install hint, per platform. */
  install?: Partial<Record<Platform, string>>;
  /** Readiness probe (binaries resolved by the registry; adapter adds permission notes). */
  check?(base: ProviderReadiness, env: { platform: Platform; isRoot: boolean; ptraceScope: number | null; perfParanoid: number | null }): Promise<ProviderReadiness> | ProviderReadiness;
  /** Run one of this adapter's tools. */
  run(tool: string, args: Record<string, unknown>, ctx: AdapterContext): Promise<ToolResult>;
  /** Priority when several adapters can serve the same tool for the same target (higher wins). */
  priority?: number;
}
