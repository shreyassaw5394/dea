"""LlamaIndex FunctionTools for DebugAnything.

    from debuganything.llamaindex import debuganything_tools
    agent = ReActAgent.from_tools(debuganything_tools(), llm=llm)

Requires ``pip install debuganything[llamaindex]``.
"""
from __future__ import annotations

import json
from typing import Any, List, Optional

from . import DebugAnything, TOOLS

try:
    from llama_index.core.tools import FunctionTool
except ImportError as e:  # pragma: no cover
    raise ImportError("pip install 'debuganything[llamaindex]'") from e


def debuganything_tools(client: Optional[DebugAnything] = None, include: Optional[List[str]] = None) -> List["FunctionTool"]:
    debuganything = client or DebugAnything()
    out: List[FunctionTool] = []
    for name, desc in TOOLS.items():
        if include and name not in include:
            continue

        def _run(_name: str = name, **kwargs: Any) -> str:
            """Run a Debug Anything tool. Pass arguments as keyword arguments (session_id, duration_s, ...)."""
            return json.dumps(_client.call(_name, **kwargs))

        out.append(FunctionTool.from_defaults(fn=_run, name=f"dea_{name}", description=desc + " Findings cite evidence ids."))
    return out
