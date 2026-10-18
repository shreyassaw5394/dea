<img src="https://raw.githubusercontent.com/shreyassaw5394/dea/main/assets/dea-mark-512.png" alt="" width="56" align="right">

# Examples

Copy-paste prompts for agents and commands for the terminal, by situation.
Every result has the same shape: `findings` that cite `evidence` ids,
`limitations` that say what could not be observed, `artifacts` on disk.

## 1. "The API gets slow after a few minutes"

**Ask your agent**

> My API on pid 48213 gets slow after ~10 minutes of traffic. Attach with DEA, profile it while I hit it, and tell me whether it's CPU, I/O or a downstream service. Cite evidence.

**Terminal**

```bash
dea why 48213 --symptom slow
# or step by step
S=$(dea attach 48213 --json | jq -r .session_id)
dea profile --session $S --duration 15          # py-spy / perf / sample → flamegraph.svg
dea trace   --session $S --duration 10 --categories file,network   # Linux
dea sockets --session $S                        # who is it talking to?
dea report  --session $S --md slow.md && dea detach --session $S
```

What to look for: a frame with >20 % of *work* samples (CPU-bound), a syscall
dominating kernel time (`read`/`openat` churn → sync I/O; `epoll_wait` →
waiting), or one remote with dozens of connections (`inspect_sockets`).

## 2. "Memory keeps growing"

> Node process 51120 grows 50 MB an hour. Take a heap snapshot, let me run load, take another, diff them, and name the retainer.

```bash
S=$(dea attach 51120 --json | jq -r .session_id)
dea memory --session $S                  # snapshot_memory#2
# ... exercise the app ...
dea memory --session $S                  # snapshot_memory#3
dea diff   --session $S snapshot_memory#2 snapshot_memory#3
```

Expected finding: `heap_retainer: name=Array grew 2.0 KB → 50.1 MB`, with the
snapshot naming the retaining path (`system / Context.retained` = a closure
variable called `retained`). For Python you get RSS series and stacks with
locals; the limitation says to enable `tracemalloc` for allocation sites.

## 3. "It's stuck" (hang / deadlock)

> The worker in container `jobs-1` hangs after ~20 requests. Dump the stacks twice and tell me what each thread is waiting on.

```bash
dea why jobs-1 --symptom hang
```

Expected finding on a deadlock: `likely deadlock: 2 thread(s) blocked acquiring locks and no thread is running — worker-ab at worker_ab (app.py:38) [with lock_b:]; worker-ba at worker_ba (app.py:45) [with lock_a:]`.
Identical positions on the second dump confirm it. If every thread is idle in
`select`/`epoll`, the process is not stuck; the caller is waiting on something else.

## 4. "Address already in use"

```bash
dea port 8080
```

Prints the pid, user and full command line holding the port. DEA never kills
it; you decide.

## 5. "It died" (container crash)

> Container `api-3` restarted twice overnight. Was it OOM? What do the logs say?

```bash
S=$(dea attach api-3 --json | jq -r .session_id)
dea container --session $S
```

Findings: `container was OOM-killed (State.OOMKilled=true)`, memory at N % of
the limit, cgroup `oom_kill` count, CPU throttling share, error-ish log lines.
Exit 137 = SIGKILL (usually OOM), 139 = SIGSEGV, 143 = SIGTERM.

## 6. Spawn a command under observation

Useful for scripts and CLIs that exit quickly or for reproducing a bug from a
clean start. stdout/stderr are tee'd into the session.

```bash
S=$(dea attach -- node scripts/import.js --all --json | jq -r .session_id)
dea files   --session $S --window 5     # fd growth while it runs
dea trace   --session $S --duration 20
```

## 7. Prove the fix

Run the same measurement before and after, then diff.

```bash
dea profile --session $S --duration 10      # profile_cpu#2  (before)
# deploy the fix / restart, attach again if the pid changed
dea profile --session $S2 --duration 10     # profile_cpu#2  (after)
dea diff --session $S2 profile_cpu#2 profile_cpu#2   # within one session: #2 vs #3
```

Put the diff's evidence ids in the PR description. A reviewer can open the
artifacts and check the claim.

## 8. In CI: a regression gate

```bash
# fail the job if the service leaks more than 20 % RSS under the smoke test
S=$(dea attach "$PID" --json | jq -r .session_id)
A=$(dea memory --session "$S" --no-heap --json | jq -r .run_id)
./smoke-test.sh
B=$(dea memory --session "$S" --no-heap --json | jq -r .run_id)
dea diff --session "$S" "$A" "$B" --json | jq -e '[.findings[] | select(.severity=="warn" and (.summary|test("rss grew")))] | length == 0'
```

`--json` output is stable and documented in [mcp-contracts.md](mcp-contracts.md).

## 9. Network: who is it really talking to? (consent)

> With my permission, capture 10 s of traffic from pid 48213 and tell me which hosts, whether there are RSTs or retransmits, and what DNS names it resolves.

```bash
dea capture --session $S --duration 10 --consent
```

The filter is derived from the target's own ports; DEA refuses an unbounded
capture. Needs root / `CAP_NET_RAW` / `access_bpf`; otherwise it returns the
exact `sudo` command instead of running it.

## 10. From Python agents

```python
from dea_agents import DEA
dea = DEA()
s = dea.attach("api-3")
for line in DEA.findings(dea.container_info(s)):
    print(line)
dea.detach(s)
```

LangChain / LlamaIndex / CrewAI adapters: [python/README.md](../python/README.md).
