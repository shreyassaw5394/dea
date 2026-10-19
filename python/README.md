<p align="center"><a href="https://debuganything.dev"><img src="https://raw.githubusercontent.com/shreyassaw5394/debuganything/main/assets/debuganything-logo.png" alt="Debug Anything" width="560"></a></p>

# debuganything (Python)

**Debug Anything from Python.** Observe a running process, container or pod —
syscalls, CPU profiles, thread stacks, sockets, packets, heap retainers — and
get findings that cite evidence. This package wraps the
[DebugAnything](https://github.com/shreyassaw5394/debuganything) CLI (Node ≥ 22 required:
`npx -y debuganything` is used automatically) and ships tool adapters for
LangChain, LlamaIndex and CrewAI.

```bash
pip install debuganything                 # core (no deps)
pip install 'debuganything[langchain]'    # + LangChain StructuredTools
pip install 'debuganything[llamaindex]'   # + LlamaIndex FunctionTools
pip install 'debuganything[crewai]'       # + CrewAI BaseTools
```

## Plain Python

```python
from debuganything import DebugAnything

debuganything = DebugAnything()                       # uses `debuganything` if installed, else `npx -y debuganything@latest`
print(da.readiness()["findings"])
s = da.attach(12345)             # pid, "my-container", "ns/pod", or a command
before = da.snapshot_memory(s)
# ... exercise the target ...
after = da.snapshot_memory(s)
diff = da.diff_runs(s, before["run_id"], after["run_id"])
for line in DebugAnything.findings(diff):
    print(line)                   # [high] heap_retainer: name=Array grew 2.0 KB → 50.1 MB (observed; e4,e1)
da.report(s, out="report.md")
da.detach(s)
```

Every call returns the Debug Anything `ToolResult` dict (`ok`, `findings`, `evidence`,
`limitations`, `suggested_next`, `artifacts`). `capture_traffic` needs
`consent=True` — ask your user first.

## LangChain

```python
from debuganything.langchain import debuganything_tools
from langgraph.prebuilt import create_react_agent

agent = create_react_agent(llm, debuganything_tools())
agent.invoke({"messages": [("user", "pid 12345 is slow — attach and tell me why, with evidence")]})
```

## LlamaIndex

```python
from debuganything.llamaindex import debuganything_tools
from llama_index.core.agent import ReActAgent

agent = ReActAgent.from_tools(debuganything_tools(), llm=llm, verbose=True)
```

## CrewAI

```python
from debuganything.crewai import debuganything_tools
from crewai import Agent

sre = Agent(role="SRE", goal="Diagnose the hung worker with evidence, never guess", tools=debuganything_tools(), llm=llm)
```

## Or just use MCP

Any framework with MCP support (LangChain `langchain-mcp-adapters`, LlamaIndex
`McpToolSpec`, CrewAI `MCPServerAdapter`, Claude Code, Codex, Cursor…) can run
Debug Anything directly: `{"command": "npx", "args": ["-y", "debuganything@latest", "serve"]}`.
Same 14 tools, same ToolResult, plus the guided prompts.

## Safety

Debug Anything is read-only, never runs sudo, caps every tool at 60 s, redacts secrets in
what it returns, and keeps raw artifacts under `~/.debuganything/sessions/`. See
[docs/safety.md](https://github.com/shreyassaw5394/debuganything/blob/main/docs/safety.md).

## License and disclaimer

MIT. Provided "as is", without warranty of any kind; the authors accept no liability for any damage arising from use. Only observe systems you own or are explicitly authorized to debug — you are solely responsible for authorization and legal compliance. Findings are automated diagnostics, not professional advice. See the full [DISCLAIMER](https://github.com/shreyassaw5394/debuganything/blob/main/DISCLAIMER.md).
