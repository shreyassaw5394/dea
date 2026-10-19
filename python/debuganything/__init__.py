"""debuganything — Debug Anything from Python.

Thin, dependency-free wrapper around the Debug Anything CLI (``npx -y debuganything``). Every
method returns the Debug Anything ``ToolResult`` dict: ``findings`` cite ``evidence`` ids,
``limitations`` say what could not be observed, ``artifacts`` point at raw
files under ``~/.debuganything/sessions/<id>/``.

    from debuganything import DebugAnything
    debuganything = DEA()
    s = da.attach(12345)
    print(da.profile_cpu(s, duration_s=10)["findings"])
    da.detach(s)

Framework adapters: ``debuganything.langchain``, ``debuganything.llamaindex``,
``debuganything.crewai``. Agents that speak MCP can skip this package and run
``npx -y debuganything serve`` directly.
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
from typing import Any, Dict, List, Optional, Sequence

__version__ = "0.1.1"
__all__ = ["DebugAnything", "DebugAnythingError", "TOOLS", "ToolResult"]

ToolResult = Dict[str, Any]

TOOLS: Dict[str, str] = {
    "readiness": "OS, arch, which providers are usable, what is missing and how to install it, permission status. Call first.",
    "attach": "Resolve a target (pid, container, pod, or a command to spawn) and open a session. Returns session_id.",
    "detach": "Stop captures, write the report, keep artifacts.",
    "list_processes": "ps-style list (pid, comm, cpu, mem, user, container) with optional substring filter.",
    "trace_syscalls": "Linux strace for N seconds: top syscalls by time/count, slowest calls, error counts, blocked waits.",
    "profile_cpu": "CPU profile (py-spy / perf / sample): top frames, hottest stacks, flamegraph.svg artifact.",
    "dump_stacks": "Every thread's stack; flags lock waits and likely deadlocks.",
    "inspect_sockets": "Listening ports, connections by remote, CLOSE_WAIT/TIME_WAIT pileups, fd count vs ulimit.",
    "inspect_files": "Open fds by type, fd growth over a window, largest and deleted-but-open files.",
    "capture_traffic": "tcpdump scoped to the target's ports (needs consent=True): per-remote bytes, RSTs, retransmits, DNS.",
    "snapshot_memory": "RSS series; Node heap snapshot with top retainers; Python stacks with locals.",
    "diff_runs": "Diff two prior runs (e.g. snapshot_memory#1 vs #2): what grew, appeared, disappeared.",
    "container_info": "docker inspect/stats/top/logs, cgroup limits, OOM kills, restarts.",
    "report": "Markdown report of the whole session.",
    "import_artifact": "Analyze raw tool output you captured yourself (strace, fs_usage, perf script, py-spy dump, sample, gdb, lldb, lsof -F, tcpdump text) into Debug Anything evidence and findings.",
}


class DebugAnythingError(RuntimeError):
    """Raised when the Debug Anything CLI cannot be executed at all (Node/npx missing, bad JSON)."""


class DebugAnything:
    """Client for the Debug Anything CLI.

    Args:
        command: how to invoke DebugAnything. Defaults to ``["npx", "-y", "debuganything@latest"]``;
            pass ``["debuganything"]`` if installed globally. ``DEA_COMMAND`` env var (shell-split) overrides.
        timeout: subprocess timeout in seconds (Debug Anything itself caps tools at 60 s).
        raise_on_error: raise ``DebugAnythingError`` when ``ok`` is false instead of returning the result.
    """

    def __init__(self, command: Optional[Sequence[str]] = None, timeout: float = 120.0, raise_on_error: bool = False) -> None:
        env_cmd = os.environ.get("DEA_COMMAND")
        if command is None and env_cmd:
            command = env_cmd.split()
        if command is None:
            command = ["debuganything"] if shutil.which("debuganything") else ["npx", "-y", "debuganything@latest"]
        self.command: List[str] = list(command)
        self.timeout = timeout
        self.raise_on_error = raise_on_error

    # -- core ---------------------------------------------------------------

    def call(self, tool: str, **args: Any) -> ToolResult:
        """Call any Debug Anything tool by name. Returns the ToolResult dict."""
        if tool not in TOOLS:
            raise DebugAnythingError(f"unknown tool {tool!r}; known: {', '.join(TOOLS)}")
        argv = [*self.command, "call", tool, json.dumps({k: v for k, v in args.items() if v is not None})]
        try:
            proc = subprocess.run(argv, capture_output=True, text=True, timeout=self.timeout, check=False)
        except FileNotFoundError as e:
            raise DebugAnythingError(f"cannot run {argv[0]!r}: install Node.js >= 22 (https://nodejs.org) or set DEA_COMMAND") from e
        except subprocess.TimeoutExpired as e:
            raise DebugAnythingError(f"{tool} timed out after {self.timeout}s") from e
        out = proc.stdout.strip()
        start = out.find("{")
        if start < 0:
            raise DebugAnythingError(f"Debug Anything produced no JSON for {tool}: {proc.stderr.strip()[:500]}")
        try:
            result: ToolResult = json.loads(out[start:])
        except json.JSONDecodeError as e:
            raise DebugAnythingError(f"bad JSON from Debug Anything for {tool}: {e}") from e
        if self.raise_on_error and not result.get("ok", False):
            raise DebugAnythingError(result.get("error") or f"{tool} failed")
        return result

    # -- convenience --------------------------------------------------------

    def readiness(self) -> ToolResult:
        return self.call("readiness")

    def list_processes(self, filter: Optional[str] = None, limit: int = 100) -> ToolResult:
        return self.call("list_processes", filter=filter, limit=limit)

    def attach(self, target: Any, kind: Optional[str] = None) -> str:
        """Attach and return the session_id. Raises DebugAnythingError if attach failed."""
        r = self.call("attach", target=str(target), kind=kind)
        if not r.get("ok"):
            raise DebugAnythingError(r.get("error") or "attach failed")
        return str(r["session_id"])

    def detach(self, session_id: str) -> ToolResult:
        return self.call("detach", session_id=session_id)

    def trace_syscalls(self, session_id: str, duration_s: int = 10, categories: Optional[Sequence[str]] = None) -> ToolResult:
        return self.call("trace_syscalls", session_id=session_id, duration_s=duration_s, categories=list(categories) if categories else None)

    def profile_cpu(self, session_id: str, duration_s: int = 15) -> ToolResult:
        return self.call("profile_cpu", session_id=session_id, duration_s=duration_s)

    def dump_stacks(self, session_id: str) -> ToolResult:
        return self.call("dump_stacks", session_id=session_id)

    def inspect_sockets(self, session_id: str) -> ToolResult:
        return self.call("inspect_sockets", session_id=session_id)

    def inspect_files(self, session_id: str, window_s: int = 3) -> ToolResult:
        return self.call("inspect_files", session_id=session_id, window_s=window_s)

    def capture_traffic(self, session_id: str, duration_s: int = 10, filter: Optional[str] = None, consent: bool = False) -> ToolResult:
        """Requires consent=True — ask the user first; captures can contain secrets."""
        return self.call("capture_traffic", session_id=session_id, duration_s=duration_s, filter=filter, consent=consent)

    def snapshot_memory(self, session_id: str, heap: bool = True, window_s: int = 3) -> ToolResult:
        return self.call("snapshot_memory", session_id=session_id, heap=heap, window_s=window_s)

    def diff_runs(self, session_id: str, a: str, b: str) -> ToolResult:
        return self.call("diff_runs", session_id=session_id, a=a, b=b)

    def container_info(self, session_id: str) -> ToolResult:
        return self.call("container_info", session_id=session_id)

    def report(self, session_id: str, out: Optional[str] = None) -> ToolResult:
        return self.call("report", session_id=session_id, out=out)

    def import_artifact(self, session_id: str, tool: str, path: str, duration_s: Optional[int] = None) -> ToolResult:
        """Analyze output you captured yourself (e.g. `sudo strace …` or `sudo fs_usage …`)."""
        return self.call("import_artifact", session_id=session_id, tool=tool, path=path, duration_s=duration_s)

    # -- helpers ------------------------------------------------------------

    @staticmethod
    def findings(result: ToolResult) -> List[str]:
        """Human-readable finding lines with their evidence ids."""
        return [f"[{f['severity']}] {f['summary']} ({f['confidence']}; {','.join(f['evidence_ids'])})" for f in result.get("findings", [])]
