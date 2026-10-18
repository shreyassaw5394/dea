"""LangChain tools for DEA.

    from dea_agents.langchain import dea_tools
    tools = dea_tools()                 # 14 StructuredTools, one per DEA tool
    agent = create_react_agent(llm, tools)

Each tool returns the ToolResult as a JSON string. Requires ``pip install dea-agents[langchain]``.
"""
from __future__ import annotations

import json
from typing import Any, List, Optional, Type

from . import DEA, TOOLS
from ._specs import SPECS, REQUIRED

try:
    from langchain_core.tools import StructuredTool
    from pydantic import BaseModel, Field, create_model
except ImportError as e:  # pragma: no cover
    raise ImportError("pip install 'dea-agents[langchain]'") from e

_PY = {"string": str, "integer": int, "boolean": bool, "array": List[str]}


def _model(tool: str) -> Type[BaseModel]:
    fields: dict = {}
    for name, spec in SPECS[tool].items():
        typ = _PY.get(spec.get("type", "string"), str)
        required = name in REQUIRED.get(tool, [])
        default = ... if required else spec.get("default", None)
        fields[name] = (typ if required else Optional[typ], Field(default, description=spec.get("description", "")))
    return create_model(f"Dea{tool.title().replace('_', '')}Args", **fields)  # type: ignore[call-overload]


def dea_tools(client: Optional[DEA] = None, include: Optional[List[str]] = None) -> List["StructuredTool"]:
    """Build one LangChain StructuredTool per DEA tool."""
    dea = client or DEA()
    out: List[StructuredTool] = []
    for name, desc in TOOLS.items():
        if include and name not in include:
            continue

        def _run(_name: str = name, **kwargs: Any) -> str:
            return json.dumps(dea.call(_name, **kwargs))

        out.append(StructuredTool.from_function(func=_run, name=f"dea_{name}", description=desc + " Findings cite evidence ids; never state a cause without one.", args_schema=_model(name)))
    return out
