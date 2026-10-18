"""LlamaIndex FunctionTools for DEA.

    from dea_agents.llamaindex import dea_tools
    agent = ReActAgent.from_tools(dea_tools(), llm=llm)

Requires ``pip install dea-agents[llamaindex]``.
"""
from __future__ import annotations

import json
from typing import Any, List, Optional

from . import DEA, TOOLS

try:
    from llama_index.core.tools import FunctionTool
except ImportError as e:  # pragma: no cover
    raise ImportError("pip install 'dea-agents[llamaindex]'") from e


def dea_tools(client: Optional[DEA] = None, include: Optional[List[str]] = None) -> List["FunctionTool"]:
    dea = client or DEA()
    out: List[FunctionTool] = []
    for name, desc in TOOLS.items():
        if include and name not in include:
            continue

        def _run(_name: str = name, **kwargs: Any) -> str:
            """Run a DEA tool. Pass arguments as keyword arguments (session_id, duration_s, ...)."""
            return json.dumps(dea.call(_name, **kwargs))

        out.append(FunctionTool.from_defaults(fn=_run, name=f"dea_{name}", description=desc + " Findings cite evidence ids."))
    return out
