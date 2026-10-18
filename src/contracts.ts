/**
 * DEA contracts — the single most important file.
 *
 * Every tool, whether invoked over MCP or from the CLI, returns a `ToolResult`.
 * Findings MUST cite evidence ids; the schema rejects findings that do not.
 * Agents only get to claim what the evidence supports.
 *
 * Nothing here assumes "localhost": targets are abstract (pid today, container
 * and pod now, remote host next), and every result carries the same shape.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

export const TargetKind = z.enum(["pid", "container", "pod", "command"]);
export type TargetKind = z.infer<typeof TargetKind>;

export const Target = z.object({
  kind: TargetKind,
  /** Opaque identifier as given by the user: "1234", "api-1", "ns/pod", "node app.js". */
  id: z.string().min(1),
  /** Host pid once resolved (for containers: the host-side pid of PID 1). */
  pid: z.number().int().positive().optional(),
  /** Process command name (comm). */
  comm: z.string().optional(),
  /** Full command line if known. */
  cmdline: z.string().optional(),
  /** Child pids that belong to the target tree at attach time. */
  pids: z.array(z.number().int().positive()).optional(),
  /** Detected runtime, used to pick an adapter: python → py-spy, node → inspector, ... */
  runtime: z.enum(["python", "node", "java", "go", "native", "unknown"]).optional(),
  /** Where the target lives. "local" today; "ssh://host" / "k8s://ctx" tomorrow. */
  host: z.string().default("local"),
  /** Container id / pod metadata when kind is container or pod. */
  container: z
    .object({
      runtime: z.enum(["docker", "podman", "containerd", "k8s"]),
      id: z.string(),
      name: z.string().optional(),
      image: z.string().optional(),
      namespace: z.string().optional(),
    })
    .optional(),
});
export type Target = z.infer<typeof Target>;

// ---------------------------------------------------------------------------
// Evidence, findings, artifacts
// ---------------------------------------------------------------------------

export const EvidenceKind = z.enum([
  "syscall_stat",
  "syscall_slow",
  "syscall_error",
  "stack",
  "stack_summary",
  "lock_wait",
  "frame_hot",
  "socket",
  "socket_summary",
  "fd",
  "fd_summary",
  "packet_summary",
  "dns_query",
  "tls_sni",
  "metric",
  "metric_series",
  "heap_retainer",
  "heap_summary",
  "log_excerpt",
  "process",
  "process_list",
  "container_state",
  "cgroup",
  "diff",
  "readiness",
  "note",
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

export const Evidence = z.object({
  /** Short stable id within a result, e.g. "e1", "e2". Findings reference these. */
  id: z.string().min(1),
  kind: EvidenceKind,
  /** Human-readable one-liner so an auditor can read the evidence list alone. */
  summary: z.string().min(1),
  /** Structured, raw-ish facts. Kept small (the whole payload is capped). */
  data: z.unknown(),
  /** Path to the artifact this evidence was derived from, if any. */
  artifact: z.string().optional(),
  /** 1-based inclusive line range in the artifact backing this evidence. */
  lines: z.tuple([z.number().int().min(1), z.number().int().min(1)]).optional(),
});
export type Evidence = z.infer<typeof Evidence>;

export const Severity = z.enum(["info", "warn", "high"]);
export type Severity = z.infer<typeof Severity>;

export const Confidence = z.enum(["observed", "inferred"]);
export type Confidence = z.infer<typeof Confidence>;

export const Finding = z.object({
  id: z.string().min(1),
  severity: Severity,
  summary: z.string().min(1),
  /** MUST be non-empty. A finding that cites nothing is not a finding. */
  evidence_ids: z.array(z.string().min(1)).min(1, "a finding must cite at least one evidence id"),
  /** "observed" = directly read from tool output; "inferred" = a reasoned step, must be stated. */
  confidence: Confidence,
  /** Optional longer explanation / reasoning. */
  detail: z.string().optional(),
});
export type Finding = z.infer<typeof Finding>;

export const ArtifactKind = z.enum([
  "raw_text",
  "flamegraph_svg",
  "folded_stacks",
  "heapsnapshot",
  "pcap",
  "json",
  "markdown",
  "log",
]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

export const Artifact = z.object({
  path: z.string().min(1),
  kind: ArtifactKind,
  bytes: z.number().int().min(0),
  /** True if the output cap was hit and the artifact is truncated. */
  truncated: z.boolean().optional(),
  description: z.string().optional(),
});
export type Artifact = z.infer<typeof Artifact>;

// ---------------------------------------------------------------------------
// ToolResult — every tool returns exactly this
// ---------------------------------------------------------------------------

export const ToolName = z.enum([
  "readiness",
  "attach",
  "detach",
  "list_processes",
  "trace_syscalls",
  "profile_cpu",
  "dump_stacks",
  "inspect_sockets",
  "inspect_files",
  "capture_traffic",
  "snapshot_memory",
  "diff_runs",
  "container_info",
  "report",
  "import_artifact",
]);
export type ToolName = z.infer<typeof ToolName>;

export const ToolResult = z
  .object({
    ok: z.boolean(),
    tool: z.string().min(1),
    /** "" for tools that run without a session (readiness, list_processes). */
    session_id: z.string(),
    target: Target,
    duration_ms: z.number().int().min(0),
    findings: z.array(Finding),
    evidence: z.array(Evidence),
    limitations: z.array(z.string()),
    suggested_next: z.array(z.string()),
    artifacts: z.array(Artifact),
    /** Set when ok === false. */
    error: z.string().optional(),
    /** ISO timestamp of when the tool started. */
    started_at: z.string().optional(),
    /** Monotonic index within the session; used by diff_runs to address prior results. */
    run_id: z.string().optional(),
  })
  .superRefine((r, ctx) => {
    const ids = new Set(r.evidence.map((e) => e.id));
    r.findings.forEach((f, i) => {
      for (const eid of f.evidence_ids) {
        if (!ids.has(eid)) {
          ctx.addIssue({
            code: "custom",
            path: ["findings", i, "evidence_ids"],
            message: `finding ${f.id} cites unknown evidence id "${eid}"`,
          });
        }
      }
    });
  });
export type ToolResult = z.infer<typeof ToolResult>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export const SessionState = z.enum(["attached", "detached"]);

export const Session = z.object({
  id: z.string().min(1),
  state: SessionState,
  target: Target,
  created_at: z.string(),
  detached_at: z.string().optional(),
  /** Absolute path of the session directory under ~/.dea/sessions/. */
  dir: z.string(),
  /** Platform the session was created on. */
  platform: z.enum(["linux", "darwin", "win32"]),
  /** Ordered list of run ids, each one a saved ToolResult json in <dir>/runs/. */
  runs: z.array(
    z.object({
      run_id: z.string(),
      tool: z.string(),
      ok: z.boolean(),
      started_at: z.string(),
      duration_ms: z.number().int().min(0),
      file: z.string(),
    }),
  ),
  /** For kind=command: pid of the spawned child, and where its output is tee'd. */
  spawned: z
    .object({
      pid: z.number().int().positive(),
      stdout: z.string(),
      stderr: z.string(),
      exit_code: z.number().int().nullable().optional(),
    })
    .optional(),
});
export type Session = z.infer<typeof Session>;

// ---------------------------------------------------------------------------
// Readiness
// ---------------------------------------------------------------------------

export const ProviderStatus = z.enum(["ready", "missing", "no_permission", "unsupported_platform", "not_implemented"]);

export const ProviderReadiness = z.object({
  name: z.string(),
  tools: z.array(z.string()),
  status: ProviderStatus,
  /** Binaries this provider needs, with resolution. */
  requires: z.array(z.object({ binary: z.string(), path: z.string().nullable() })),
  /** How to fix, if not ready. */
  install_hint: z.string().optional(),
  /** Extra detail, e.g. "ptrace_scope=1: can only trace children; run with sudo or set to 0". */
  notes: z.array(z.string()).default([]),
});
export type ProviderReadiness = z.infer<typeof ProviderReadiness>;

export const Readiness = z.object({
  os: z.enum(["linux", "darwin", "win32"]),
  arch: z.string(),
  kernel: z.string().optional(),
  node: z.string(),
  dea_version: z.string(),
  is_root: z.boolean(),
  has_sudo_noninteractive: z.boolean(),
  permissions: z.object({
    /** Linux: contents of /proc/sys/kernel/yama/ptrace_scope, or null when absent. */
    ptrace_scope: z.number().int().nullable(),
    /** Linux: CAP_SYS_PTRACE / CAP_NET_RAW effective, when determinable. */
    capabilities: z.array(z.string()).default([]),
    /** macOS: System Integrity Protection enabled. */
    sip_enabled: z.boolean().nullable(),
    /** macOS: whether the Developer Tools group lets us attach without sudo. */
    developer_mode: z.boolean().nullable(),
    /** Linux: perf_event_paranoid value. */
    perf_event_paranoid: z.number().int().nullable(),
  }),
  providers: z.array(ProviderReadiness),
  /** Flattened: which MCP tools can be served right now. */
  tools_available: z.array(z.string()),
  tools_unavailable: z.array(z.object({ tool: z.string(), reason: z.string() })),
  sessions_dir: z.string(),
});
export type Readiness = z.infer<typeof Readiness>;

// ---------------------------------------------------------------------------
// Tool argument schemas (shared by MCP server and CLI)
// ---------------------------------------------------------------------------

export const ImportTool = z.enum(["strace", "fs_usage", "perf_script", "folded", "pyspy_dump", "sample", "gdb", "lldb", "lsof", "tcpdump"]);
export type ImportTool = z.infer<typeof ImportTool>;

export const SyscallCategory = z.enum(["network", "file", "process", "signal", "memory", "all"]);
export type SyscallCategory = z.infer<typeof SyscallCategory>;

export const ToolArgs = {
  readiness: z.object({}),
  attach: z.object({
    target: z.string().min(1).describe("pid, container name/id, k8s pod (ns/name), or a command line (with kind=command)"),
    kind: TargetKind.optional().describe("Defaults to auto-detect: numeric → pid, else container, else command"),
  }),
  detach: z.object({ session_id: z.string().min(1) }),
  list_processes: z.object({
    filter: z.string().optional().describe("Substring match on command / args / user"),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  trace_syscalls: z.object({
    session_id: z.string().min(1),
    duration_s: z.number().int().min(1).max(60).default(10),
    categories: z.array(SyscallCategory).default(["all"]),
  }),
  profile_cpu: z.object({
    session_id: z.string().min(1),
    duration_s: z.number().int().min(1).max(60).default(15),
    /** Required when the profiler will use perf on a system the user flagged as production; always safe to pass. */
    consent: z.boolean().optional(),
  }),
  dump_stacks: z.object({ session_id: z.string().min(1) }),
  inspect_sockets: z.object({ session_id: z.string().min(1) }),
  inspect_files: z.object({
    session_id: z.string().min(1),
    window_s: z.number().int().min(0).max(30).default(3).describe("Observe fd growth over this many seconds (0 = single snapshot)"),
  }),
  capture_traffic: z.object({
    session_id: z.string().min(1),
    duration_s: z.number().int().min(1).max(30).default(10),
    filter: z.string().optional().describe("Extra BPF filter ANDed with the target's ports"),
    consent: z.boolean().optional().describe("Required. Packet capture may contain secrets; ask the user first."),
  }),
  snapshot_memory: z.object({
    session_id: z.string().min(1),
    heap: z.boolean().default(true).describe("Take a heap snapshot where supported (Node). Set false for metrics only."),
    window_s: z.number().int().min(0).max(30).default(3).describe("Sample RSS over this many seconds"),
  }),
  diff_runs: z.object({
    session_id: z.string().min(1),
    a: z.string().min(1).describe("run id of the earlier result"),
    b: z.string().min(1).describe("run id of the later result"),
  }),
  container_info: z.object({ session_id: z.string().min(1) }),
  report: z.object({
    session_id: z.string().min(1),
    out: z.string().optional().describe("Optional path to also write the markdown to"),
  }),
  import_artifact: z.object({
    session_id: z.string().min(1),
    tool: ImportTool.describe("What produced the file"),
    path: z.string().min(1).describe("Path to the raw output file you captured yourself (e.g. with sudo)"),
    duration_s: z.number().int().min(1).max(3600).optional().describe("How long the capture ran, when the file has no timestamps (profiles)"),
  }),
} as const;

export type ToolArgsOf<K extends keyof typeof ToolArgs> = z.infer<(typeof ToolArgs)[K]>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Validate a ToolResult; throws with a readable message if findings cite nothing. */
export function assertToolResult(r: unknown): ToolResult {
  const parsed = ToolResult.safeParse(r);
  if (!parsed.success) {
    throw new Error(`invalid ToolResult: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  return parsed.data;
}

/** JSON Schemas for docs/mcp-contracts.md. */
export function exportJsonSchemas(): Record<string, unknown> {
  return {
    ToolResult: z.toJSONSchema(ToolResult),
    Finding: z.toJSONSchema(Finding),
    Evidence: z.toJSONSchema(Evidence),
    Artifact: z.toJSONSchema(Artifact),
    Target: z.toJSONSchema(Target),
    Session: z.toJSONSchema(Session),
    Readiness: z.toJSONSchema(Readiness),
    ToolArgs: Object.fromEntries(Object.entries(ToolArgs).map(([k, v]) => [k, z.toJSONSchema(v)])),
  };
}
