<img src="https://raw.githubusercontent.com/shreyassaw5394/debuganything/main/assets/debuganything-mark-512.png" alt="" width="56" align="right">

# Adopting Debug Anything in your workflow

From "I installed it" to "every agent on the team measures before it guesses".
Each step is one command or one committed file.

## Day 0 — you

```bash
npx debuganything setup        # registers the MCP server, the skill and (Claude Code) the proactive hook
debuganything readiness               # what works on this machine; install hints for the rest
```

Ask your agent something that needs a running system — *"the dev server is
slow, attach and tell me why"* — and read a result with evidence ids once.
That is the whole learning curve.

## Day 1 — a new or existing project

```bash
cd my-project
debuganything init                    # writes .mcp.json, .cursor/mcp.json and a rule into AGENTS.md / CLAUDE.md
git add .mcp.json .cursor/mcp.json AGENTS.md && git commit -m "chore: Debug Anything for agents"
```

Now every teammate's Claude Code and Cursor picks up Debug Anything from the repo, and
the committed rule tells any agent *when* to use it: on hangs, timeouts,
`EADDRINUSE`, `EMFILE`, OOM, segfaults, or the words slow / hang / leak /
crash — and to prove performance fixes with `diff_runs`. Each person still runs
`npx debuganything setup` once for the skill and hook.

**Starting a brand-new project?** Run `debuganything init` right after `git init`. The
rule is most valuable before the first "it works on my machine".

## Day 2 — pull requests carry evidence

Add to your PR template:

```markdown
## Runtime evidence (for perf / bug fixes)
<!-- Debug Anything run ids + evidence ids, e.g. profile_cpu#2/e1 → profile_cpu#3/e1 via diff_runs#4 -->
```

Reviewers stop asking "did you measure?" because the answer is a run id they
can open (`~/.debuganything/sessions/<id>/report.md`, or paste the report into the PR).

## Day 3 — CI regression gate

Smoke-test the service under Debug Anything and fail the job on growth. Full snippet in
[examples.md §8](examples.md#8-in-ci-a-regression-gate):

```bash
S=$(debuganything attach "$PID" --json | jq -r .session_id)
A=$(debuganything memory --session "$S" --no-heap --json | jq -r .run_id)
./smoke-test.sh
B=$(debuganything memory --session "$S" --no-heap --json | jq -r .run_id)
debuganything diff --session "$S" "$A" "$B" --json | jq -e '[.findings[] | select(.summary|test("rss grew"))] | length == 0'
```

Linux runners have `strace`, `lsof`, `perf` a package install away
([providers.md](providers.md)); the `docker/linux-lab` image has them all.

## Containers and Kubernetes

- **Docker on Linux:** `debuganything attach <container>` resolves the host pid; every
  tool works. Add `--cap-add SYS_PTRACE` to the container for strace/gdb/py-spy.
- **Docker on macOS:** the VM hides pids; use `container_info` from the host
  or run Debug Anything inside the container.
- **Kubernetes:** run Debug Anything in an ephemeral debug container that shares the pod's
  process namespace:

  ```bash
  kubectl debug -it pod/api-7f9c --image=ghcr.io/<you>/dea-lab --target=api -- \
    bash -c 'debuganything why 1 --symptom hang'
  ```

  (`--target` shares the PID namespace so pid 1 is the app. Build the image
  from `docker/linux-lab/Dockerfile` plus `npm i -g debuganything`.)

## Staging and production etiquette

Debug Anything is read-only and never escalates, but observation is not free:
ptrace-based tools pause the target briefly, captures can contain secrets.

1. Attach to one instance, not the fleet.
2. Prefer `inspect_sockets` / `inspect_files` / `snapshot_memory --no-heap`
   (no pause) before `dump_stacks` / `trace_syscalls` (brief pause).
3. `capture_traffic` only with explicit consent and a named reason.
4. Artifacts stay on the host under `~/.debuganything/sessions/`; `debuganything sessions prune`
   when done. Raw artifacts are not redacted.

## Agent teams and automation

A Python SRE agent that reacts to an alert and reports with evidence:

```python
from debuganything import Debug Anything
debuganything = DEA()
s = da.attach(alert["pid"])
r = da.dump_stacks(s) if alert["kind"] == "hang" else da.profile_cpu(s, 10)
post_to_slack("\n".join(Debug Anything.findings(r)) + f"\nreport: {da.report(s)['artifacts'][0]['path']}")
da.detach(s)
```

LangChain / LlamaIndex / CrewAI adapters give the same tools to an LLM agent:
[python/README.md](../python/README.md).

## Day-1 checklist

- [ ] `npx debuganything setup` on each developer machine
- [ ] `debuganything init` in the repo; commit `.mcp.json`, `.cursor/mcp.json`, `AGENTS.md`/`CLAUDE.md`
- [ ] PR template asks for runtime evidence on perf/bug fixes
- [ ] CI smoke job with a `diff_runs` gate (optional)
- [ ] Linux hosts: `ptrace_scope`, `perf_event_paranoid`, tcpdump caps per [installation.md](installation.md)
