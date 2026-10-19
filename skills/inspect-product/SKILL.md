---
name: inspect-product
description: Use when asked to review, audit, inspect or improve a whole product/app/site rather than chase one bug — "look over the product", "what should we fix", "is this ready to launch", "find problems", "suggest improvements". Walks the real running product like a user, observes the runtime with DEA, reads only the code the evidence points at, and returns ranked findings that each cite proof. Also use before a launch or after a big feature lands.
---

# Inspect a whole product

A product review written from reading code is a guess. This skill makes you
**walk the running product, observe it, and only then judge it** — so every
finding carries proof and a reproduction, not an opinion.

## The one rule

> **No finding without evidence.** Each finding names what you did, what you
> observed, and where it lives. If you cannot reproduce it, it is a
> *question*, not a finding. Say so.

Generic advice ("add tests", "improve onboarding", "consider analytics") is
failure. If it could have been written without opening the product, delete it.

## Phase 0 — Frame it (2 minutes, do not skip)

Answer in one line each, from the repo and the user:
- **What is this product, and who is the user?**
- **What is the one action that makes it succeed?** (the activation moment)
- **What does the user say they're worried about?**
- **Is there a staging/local URL, or is production the only target?**

Then state your plan: the flows you will walk, in order. The first flow is
always the brand-new-user path to the activation moment.

## Phase 1 — Walk it as a real user

Drive the actual product. Browser automation if it's a web app, the CLI if
it's a CLI, the API if it's a service. **Start from zero state** — fresh
profile, new account, empty data — because that is the state every new user
is in and the state developers never test.

For each flow, record: what you clicked/ran, what you expected, what happened,
how long it took. Capture screenshots or output at each decision point.

Walk at minimum:
1. **First run** — landing → the activation moment. Count every step, every
   decision, every word the user must read. This flow matters more than all
   the others combined.
2. **The core loop** — the thing a returning user does repeatedly.
3. **The money/irreversible path** — payment, deletion, publishing, trading.
4. **Return** — close everything, come back cold. Does state persist? Does
   anything look empty or broken that should be full?
5. **The edges** — empty state, one item, a large account, a slow network
   (throttle it), a narrow viewport, a reload mid-flow, the back button.

## Phase 2 — Observe the runtime (this is the part reviews skip)

While the product is running under that load, use **DEA** (the
`debug-anything` skill) on the server process or container:

- `readiness` → `attach` the app process
- `inspect_sockets` — connection pileups, CLOSE_WAIT, who it talks to
- `profile_cpu` during the core loop — where the time actually goes
- `snapshot_memory` twice across the loop → `diff_runs` — what grows
- `dump_stacks` if anything feels slow or stalls
- `report --html` to keep the evidence

Also collect, from the app itself: console errors, failed network requests,
response times of the slowest calls, and any error logs produced during your
walk. A clean-looking UI over a stream of 500s is a finding.

## Phase 3 — Check the things products actually die of

Work this list against what you observed. Each line is a question with a
yes/no answer and evidence, not a topic to muse on.

**Does it work at all, for a stranger?**
- Dead ends, broken links, pages that 404 or render empty
- Anything that requires knowledge the UI never gave the user
- Actions with no feedback — did it work? did it save?

**Correctness under reality**
- Does the same action twice produce the same result? (double-click submit)
- Does a reload mid-flow lose or duplicate data?
- Do two sessions/accounts interfere? (open a second incognito window)
- Are ordering, pagination, counts and totals actually right? Check one by hand.

**Cost and abuse** (the silent killers)
- What does one user cost you at 10× usage? Is anything uncapped per user?
- Can a free account be farmed for value? Can anyone call the expensive
  endpoint directly?
- Does anything expensive run without a limit, cache or timeout?

**Trust**
- Does it claim anything it does not do? (the fastest way to lose users)
- Secrets in client bundles, keys in URLs, PII in logs or shared state
- Irreversible actions without confirmation

**Does anyone come back?**
- Is there a reason to return tomorrow, and does the product *show* it?
- Does the product remember the user, and prove that it did?

**Can you tell if it's working?**
- Is the activation moment measured? Can you answer "did they come back?"
  with data? If not, that is a top-three finding.

## Phase 4 — Report

Rank findings by **damage × likelihood**, not by how easy they are to fix.
For each:

```
[SEVERITY] One-line claim
  Repro:    the exact steps / command
  Observed: what actually happened (quote output, name the screenshot)
  Evidence: DEA evidence id, log line, screenshot, or file:line
  Why it matters: the user- or money-level consequence
  Fix:      the smallest change that removes the cause
```

Severity: **blocker** (launch-stopping or data/money loss) · **high** (users
hit it and suffer) · **medium** (friction or future pain) · **low** (polish).

Close with: the **three** things to do first, and — honestly — what you could
*not* check and why. A review that pretends to be complete is worse than one
that names its blind spots.

## Phase 5 — Improve (only when asked)

If the user says "and fix it": work the list top-down, one finding per commit,
smallest change that removes the cause. **Re-walk the flow after each fix** and
show the new observation — a fix you did not re-observe is a claim, not a fix.
Never batch unrelated fixes into one commit.

## Keep yourself honest

- You walked the product before judging it. If you didn't, say so and go back.
- Every finding has a repro someone else could follow.
- You checked cost/abuse, not just UX. Those are the ones that end companies.
- You named what you could not test.
- You did not pad the list. Five real findings beat twenty guesses.
