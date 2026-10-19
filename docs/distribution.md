# Distribution — honest diagnosis and the plan

_Measured 2026-10-19, two days after first publish._

## What the numbers actually say

| Channel | Reality |
|---|---|
| npm `dea-agents` | **zero recorded downloads** (the downloads API has no record at all) |
| PyPI `dea-agents` | 195/week — almost entirely mirrors and scrapers |
| GitHub | 10 stars, 69 unique viewers, 159 unique cloners (clones ≫ views = bots) |
| Referrers | LinkedIn 25 views, debuganything.dev 5, github.com 3, t.co 2 — **that is everything** |
| MCP Registry | was stale at 0.3.0; now auto-publishes on every tag |
| Smithery | **not listed at all** |
| awesome-mcp-servers | PR open since Oct 18, unmerged |

**The honest read:** this is not yet a distribution problem. The total
marketing effort to date is one LinkedIn post, which produced 25 views. The
product is two days old. Nobody has heard of it. That is the whole story.

But three structural problems will cap it even once people do hear:

### 1. The name is a search dead end
"DEA" returns the Drug Enforcement Administration. "Debug Anything" is a
phrase, not a brand people will recall. We will never win search on the
product name — so **stop trying to**. Win on the *problem* instead (see
below). Keep the name; change what we rank for.

### 2. We are selling a problem people don't know they have
"Your agent can't see runtime" is true but abstract. Nobody searches for it.
People search for the symptom: *why is my node process using 4GB*, *how to
read strace output*, *test hangs in CI*. Every one of those is a door into
DEA, and we currently point none of them at us.

### 3. We're not in the two places agents get installed from
MCP Registry is fixed. **Smithery is the gap** — it is where a large share of
MCP installs originate, and we have no listing.

## The plan, in leverage order

### A. Be in the install path (days — mostly done now)
- [x] MCP Registry auto-publishes on tag (was stuck at 0.3.0)
- [x] `smithery.yaml` added → connect the repo at smithery.ai/new
- [x] Glama listed · Claude Code plugin · Cursor/VS Code deeplinks
- [ ] Nudge the awesome-mcp-servers PR (polite comment, offer to rebase)

### B. Rank for the symptom, not the product (weeks — highest ceiling)
The `/analyze` page is the right bet and is already built: paste strace,
py-spy, jstack, goroutine or lsof output, get findings, no install. It should
become **several** pages, each targeting one real query, each ending in the
same CTA:
- "how to read strace output" → `/analyze/strace`
- "py-spy dump explained" / "how to find a Python deadlock"
- "what is CLOSE_WAIT" / "too many open files"
- "Java thread dump analyzer" · "goroutine dump analyzer"
- "why did my CI job hang"
Each page: the explainer a human actually wants, a live paste box, a worked
example. This is the only channel that compounds while you sleep.

### C. Show it, once, properly (hours — biggest single spike)
One 60-second video of an agent finding a **real** bug it could not have
found by reading code — a hang, a leak, a CLOSE_WAIT pileup. Not a feature
tour. That clip is the Show HN, the Reddit post, the tweet and the README
hero, all from one artifact.

Then post it *once* in the places where this audience actually is:
- Show HN (Tue–Thu, 9–11am ET) — title names the problem, not the product
- r/devops, r/node, r/Python, r/golang — only in a thread where someone is
  actually stuck
- The Claude Code / Cursor / MCP Discords — as an answer to a question
- Hacker News comments where people complain about debugging agents

### D. Borrow an audience (the real unlock)
Ten people with developer audiences would move more than every registry
combined. The ask is small and specific: *"here is a 60-second clip of an
agent finding a deadlock — would you try it on something of yours?"*
Target: the tweet author who already asked about ptrace, MCP newsletter
writers, devtool YouTubers, the HOL team we already have contact with.

## What to measure

Weekly: npm downloads, unique GitHub viewers, `/analyze` sessions, referrers.
If `/analyze` traffic grows and npm doesn't, the funnel is broken at install.
If neither grows, the problem is still awareness, not product.
