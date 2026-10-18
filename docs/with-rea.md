# Using DEA with REA

[REA — Reverse Engineer Anything](https://github.com/morluto/rea) is static:
binaries, bundles, APKs, firmware, pseudocode, strings, call graphs. DEA is
dynamic: the same software while it runs. They share a shape (one MCP, many
adapters, evidence-first results, `npx <pkg> setup`), so an agent can use both
in one investigation without learning two mental models.

```bash
npx rea-agents setup && npx dea-agents setup   # both register with your agent
```

## The loop

```
   REA (static)                                DEA (runtime)
   what the code CAN do            ⇄           what the code IS doing
   symbols, strings, call graph                 hot frames, stacks, sockets, packets
```

- **REA → DEA: confirm a hypothesis at runtime.** REA finds an HTTP client, a
  hard-coded host, a suspicious timer, a mutex. DEA shows whether the running
  process actually talks to that host (`inspect_sockets`, `capture_traffic`),
  whether the timer fires (`trace_syscalls` shows `nanosleep`/`epoll_wait`),
  whether the mutex is contended (`dump_stacks` → `lock_wait`).
- **DEA → REA: explain a runtime observation.** DEA localizes a problem to a
  symbol or shared library (`__arch_copy_to_user` under `readFileSync`,
  `libfoo.so` `parse_frame`, a thread parked in `pthread_mutex_lock` under
  `worker_b`). REA decompiles that function and shows what it does and who
  calls it. DEA's `suggested_next` names the symbol and DSO for exactly this
  handoff.

## Worked example: an Electron app that "phones home"

1. **REA:** `analyze-javascript-application /Applications/Foo.app` → finds a
   module that builds requests to `telemetry.example.com` behind a feature flag.
2. **DEA:** attach to the running app, `inspect_sockets` → an ESTABLISHED
   connection to `203.0.113.7:443`; `capture_traffic` (consent) → TLS SNI
   `telemetry.example.com`, 12 requests in 10 s, DNS resolved every time (no
   caching).
3. Together: the static finding is now a runtime fact with evidence ids a
   reviewer can check, and the DNS-churn detail is something static analysis
   could not have shown.

## Worked example: a native daemon that pegs a core

1. **DEA:** `profile_cpu` → `parse_frame (libfoo.so)` is 71 % of work samples;
   `suggested_next` says *"REA: decompile `parse_frame` in `libfoo.so`"*.
2. **REA:** native analysis of `libfoo.so` → `parse_frame` has an O(n²) scan
   over the input buffer with a `strlen` in the loop condition.
3. **DEA again, after the fix:** `profile_cpu` + `diff_runs` → the frame drops
   from 71 % to 3 %. The PR carries both the decompilation and the diff.

## Prompts that use both

> Use REA to find where this binary opens network connections, then use DEA to attach to pid 4242 and show me which of those it actually uses in the next 30 seconds. Cite REA and DEA evidence separately.

> DEA says thread #7 is blocked in `pthread_mutex_lock` under `scheduler_tick`. Use REA to decompile `scheduler_tick` and tell me which lock it takes and who else takes it.

> This container keeps getting OOM-killed (DEA container_info). Use DEA snapshot_memory to find the retainer, then REA to find where in the bundle that object is created.

## Division of labour, in one line

REA tells you what the code can do. DEA tells you what it is doing. A step
debugger (e.g. mcp-debugger) lets you stop it at the line both of them pointed at.
