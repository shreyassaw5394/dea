# Contributing to DEA

Thanks for helping agents see running software.

## Setup

```bash
git clone https://github.com/shreyassaw5394/dea
cd dea
npm install
npm run check        # typecheck + lint + tests + build
npx tsx src/cli.ts readiness
```

Node.js ≥ 22. Tests run without root and without any of the external tools
installed: adapters are tested against captured fixture output in
`tests/fixtures/`.

## Adding an adapter (~80 lines)

1. Create `src/adapters/<tool>.ts` exporting an `Adapter`:

   ```ts
   import type { Adapter } from "./types.js";

   export const myAdapter: Adapter = {
     name: "mytool",
     tools: ["inspect_something"],
     platforms: ["linux", "darwin"],
     requires: ["mytool"],           // binaries that must be on PATH
     async check(ctx) { /* return Readiness entry */ },
     async run(tool, args, ctx) { /* build cmd → run with caps → parse → ToolResult */ },
   };
   ```

2. Keep parsing pure: `export function parseMyTool(raw: string): Parsed` so it
   can be unit-tested on a fixture.
3. Run the real tool once against an example app, save the output to
   `tests/fixtures/<tool>/*.txt`, and write `tests/adapters/<tool>.test.ts`.
4. Register the adapter in `src/adapters/index.ts`.
5. Every finding must cite evidence ids. The schema rejects findings without
   them — do not work around this.
6. Add the row to the README "What you can observe" table and to
   `docs/providers.md` (install commands per OS).

## Rules

- Read-only. No adapter may mutate the target (kill, signal, write memory)
  without the `consent` mechanism **and** a discussion in an issue first.
- Every subprocess goes through `runCapped()` in `src/safety.ts`.
- Never auto-sudo. If root is needed, return `ok: false` with a limitation
  that includes the exact command the user can run.
- `--json` output is the `ToolResult` contract, nothing else.

## Commits and releases

Conventional-ish messages (`feat:`, `fix:`, `docs:`). Bump `version` in
`package.json` and `server.json` together and add a `CHANGELOG.md` entry.
