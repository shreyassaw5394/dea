"""CrewAI tools for DebugAnything.

    from debuganything.crewai import debuganything_tools
    agent = Agent(role="SRE", goal="diagnose the slow API with evidence", tools=debuganything_tools(), ...)

Requires ``pip install debuganything[crewai]``.
"""
from __future__ import annotations

import json
from typing import Any, List, Optional, Type

from . import DebugAnything, TOOLS
from ._specs import SPECS, REQUIRED

try:
    from crewai.tools import BaseTool
    from pydantic import BaseModel, Field, create_model
except ImportError as e:  # pragma: no cover
    raise ImportError("pip install 'debuganything[crewai]'") from e

_PY = {"string": str, "integer": int, "boolean": bool, "array": List[str]}


def _model(tool: str) -> Type[BaseModel]:
    fields: dict = {}
    for name, spec in SPECS[tool].items():
        typ = _PY.get(spec.get("type", "string"), str)
        required = name in REQUIRED.get(tool, [])
        fields[name] = (typ if required else Optional[typ], Field(... if required else spec.get("default", None), description=spec.get("description", "")))
    return create_model(f"Dea{tool.title().replace('_', '')}Args", **fields)  # type: ignore[call-overload]


def debuganything_tools(client: Optional[DebugAnything] = None, include: Optional[List[str]] = None) -> List["BaseTool"]:
    debuganything = client or DebugAnything()
    out: List[BaseTool] = []
    for tool_name, desc in TOOLS.items():
        if include and tool_name not in include:
            continue

        class _Tool(BaseTool):
            name: str = f"dea_{tool_name}"
            description: str = desc + " Findings cite evidence ids; never state a cause without one."
            args_schema: Type[BaseModel] = _model(tool_name)
            _da_tool: str = tool_name

            def _run(self, **kwargs: Any) -> str:
                return json.dumps(_client.call(self._da_tool, **kwargs))

        out.append(_Tool())
    return out
