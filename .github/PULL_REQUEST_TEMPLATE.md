## What

<!-- One paragraph: what changes and why. Link the issue if there is one. -->

## Evidence

<!-- For adapter/parser changes: paste the real tool output you captured into tests/fixtures/ and the Debug Anything result it now produces. Findings must cite evidence ids. -->

## Checklist

- [ ] `npm run check` passes (typecheck, lint, tests, build)
- [ ] New/changed parser has a fixture test in `tests/adapters/`
- [ ] Read-only: no new side effects on the target (or `consent` gating + a note in `docs/safety.md`)
- [ ] README "What you can observe" table and `docs/providers.md` updated if a tool/adapter changed
- [ ] `CHANGELOG.md` entry
