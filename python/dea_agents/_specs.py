"""Shared argument schemas for framework adapters (mirrors src/contracts.ts ToolArgs)."""
from __future__ import annotations

from typing import Any, Dict

SESSION = {"session_id": {"type": "string", "description": "session id from attach"}}

SPECS: Dict[str, Dict[str, Any]] = {
    "readiness": {},
    "attach": {
        "target": {"type": "string", "description": "pid, container name, k8s pod (ns/name) or a command line"},
        "kind": {"type": "string", "enum": ["pid", "container", "pod", "command"], "description": "default: auto-detect"},
    },
    "detach": {**SESSION},
    "list_processes": {"filter": {"type": "string"}, "limit": {"type": "integer", "default": 100}},
    "trace_syscalls": {**SESSION, "duration_s": {"type": "integer", "default": 10, "maximum": 60}, "categories": {"type": "array", "items": {"type": "string", "enum": ["network", "file", "process", "signal", "memory", "all"]}}},
    "profile_cpu": {**SESSION, "duration_s": {"type": "integer", "default": 15, "maximum": 60}},
    "dump_stacks": {**SESSION},
    "inspect_sockets": {**SESSION},
    "inspect_files": {**SESSION, "window_s": {"type": "integer", "default": 3}},
    "capture_traffic": {**SESSION, "duration_s": {"type": "integer", "default": 10, "maximum": 30}, "filter": {"type": "string"}, "consent": {"type": "boolean", "description": "REQUIRED true; ask the user first"}},
    "snapshot_memory": {**SESSION, "heap": {"type": "boolean", "default": True}, "window_s": {"type": "integer", "default": 3}},
    "diff_runs": {**SESSION, "a": {"type": "string", "description": "earlier run id, e.g. snapshot_memory#2"}, "b": {"type": "string", "description": "later run id"}},
    "container_info": {**SESSION},
    "report": {**SESSION, "out": {"type": "string", "description": "optional path to also write the markdown to"}},
}

REQUIRED: Dict[str, list] = {
    "attach": ["target"],
    "diff_runs": ["session_id", "a", "b"],
    "capture_traffic": ["session_id", "consent"],
}
for _name, _spec in SPECS.items():
    if "session_id" in _spec and _name not in REQUIRED:
        REQUIRED[_name] = ["session_id"]
REQUIRED.setdefault("readiness", [])
REQUIRED.setdefault("list_processes", [])


def json_schema(tool: str) -> Dict[str, Any]:
    return {"type": "object", "properties": SPECS[tool], "required": REQUIRED.get(tool, [])}
