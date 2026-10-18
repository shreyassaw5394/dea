<p align="center"><a href="https://shreyassaw5394.github.io/dea"><img src="https://raw.githubusercontent.com/shreyassaw5394/dea/main/assets/dea-logo.png" alt="DEA — Debug Anything" width="560"></a></p>

# dea-agents (Python)

**Debug Anything from Python.** Observe a running process, container or pod —
syscalls, CPU profiles, thread stacks, sockets, packets, heap retainers — and
get findings that cite evidence. This package wraps the
[DEA](https://github.com/shreyassaw5394/dea) CLI (Node ≥ 22 required:
`npx -y dea-agents` is used automatically) and ships tool adapters for
LangChain, LlamaIndex and CrewAI.

```bash
pip install dea-agents                 # core (no deps)
pip install 'dea-agents[langchain]'    # + LangChain StructuredTools
pip install 'dea-agents[llamaindex]'   # + LlamaIndex FunctionTools
pip install 'dea-agents[crewai]'       # + CrewAI BaseTools
```

## Plain Python

```python
from dea_agents import DEA

dea = DEA()                       # uses `dea` if installed, else `npx -y dea-agents@latest`
print(dea.readiness()["findings"])
s = dea.attach(12345)             # pid, "my-container", "ns/pod", or a command
before = dea.snapshot_memory(s)
# ... exercise the target ...
after = dea.snapshot_memory(s)
diff = dea.diff_runs(s, before["run_id"], after["run_id"])
for line in DEA.findings(diff):
    print(line)                   # [high] heap_retainer: name=Array grew 2.0 KB → 50.1 MB (observed; e4,e1)
dea.report(s, out="report.md")
dea.detach(s)
```

Every call returns the DEA `ToolResult` dict (`ok`, `findings`, `evidence`,
`limitations`, `suggested_next`, `artifacts`). `capture_traffic` needs
`consent=True` — ask your user first.

## LangChain

```python
from dea_agents.langchain import dea_tools
from langgraph.prebuilt import create_react_agent

agent = create_react_agent(llm, dea_tools())
agent.invoke({"messages": [("user", "pid 12345 is slow — attach and tell me why, with evidence")]})
```

## LlamaIndex

```python
from dea_agents.llamaindex import dea_tools
from llama_index.core.agent import ReActAgent

agent = ReActAgent.from_tools(dea_tools(), llm=llm, verbose=True)
```

## CrewAI

```python
from dea_agents.crewai import dea_tools
from crewai import Agent

sre = Agent(role="SRE", goal="Diagnose the hung worker with evidence, never guess", tools=dea_tools(), llm=llm)
```

## Or just use MCP

Any framework with MCP support (LangChain `langchain-mcp-adapters`, LlamaIndex
`McpToolSpec`, CrewAI `MCPServerAdapter`, Claude Code, Codex, Cursor…) can run
DEA directly: `{"command": "npx", "args": ["-y", "dea-agents@latest", "serve"]}`.
Same 14 tools, same ToolResult, plus the guided prompts.

## Safety

DEA is read-only, never runs sudo, caps every tool at 60 s, redacts secrets in
what it returns, and keeps raw artifacts under `~/.dea/sessions/`. See
[docs/safety.md](https://github.com/shreyassaw5394/dea/blob/main/docs/safety.md).
MIT.
