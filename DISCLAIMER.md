# Disclaimer

**By downloading, installing, or using DEA ("Debug Anything"), you accept this
disclaimer in full. If you do not agree with it, do not use Debug Anything.**

Debug Anything is a free, open-source diagnostic tool distributed under the
[MIT License](LICENSE). This page restates and supplements the license's
warranty and liability terms in plain language. Nothing here grants rights
beyond the license.

## 1. No warranty

Debug Anything is provided **"as is" and "as available"**, without warranty of any kind,
express or implied, including but not limited to the warranties of
merchantability, fitness for a particular purpose, accuracy, reliability,
availability, and non-infringement. No oral or written information or advice
given by the authors, contributors, or community creates any warranty.

## 2. Limitation of liability

To the maximum extent permitted by applicable law, **the authors, maintainers,
and contributors of Debug Anything shall not be liable for any claim, damages, or other
liability** — whether in an action of contract, tort, or otherwise — arising
from, out of, or in connection with Debug Anything or its use, including but not limited
to: service outages or degraded performance of observed systems; crashes or
corruption of target processes; loss or exposure of data (including secrets
captured in artifacts); lost profits, revenue, or business interruption; costs
of substitute services; or any legal or regulatory consequences of your use.
This applies even if advised of the possibility of such damage.

## 3. You are solely responsible for your use

Debug Anything attaches observation tools (`strace`, `py-spy`, `perf`, `lsof`, `tcpdump`,
`gdb`, `lldb`, heap snapshots, and others) to running software. **You alone
decide what to observe, where, and when — and you bear all risk and
responsibility for those decisions and their consequences.** Exercise the same
care you would running these tools by hand, and prefer testing on
non-production systems first.

## 4. Authorized systems only

**Only observe systems you own or are explicitly authorized to debug.**
Attaching a tracer, profiler, debugger, or packet capture to a process you are
not authorized to inspect may violate computer-misuse, wiretapping, or privacy
laws in your jurisdiction, and may violate your employer's or provider's
policies and agreements. You are solely responsible for obtaining
authorization before running Debug Anything and for complying with all applicable laws,
regulations, contracts, and policies. Debug Anything is intended for lawful, authorized
debugging only; the authors do not condone and are not responsible for any
unauthorized or unlawful use.

## 5. Observation has costs, artifacts are sensitive

- `ptrace`-based tools (`strace`, `gdb`, `py-spy` in some modes) pause the
  target for short periods and can slow it down measurably.
- Packet captures, heap snapshots, and raw logs can contain secrets, personal
  data, and other sensitive information. Debug Anything redacts obvious tokens in the
  excerpts it returns to the agent, but **raw artifacts on disk are not
  redacted**. Treat `~/.debuganything/sessions/` as sensitive; securing, retaining, and
  deleting that data is your responsibility.

## 6. Output is not professional advice

Debug Anything's findings are automated diagnostics derived from tool output. They may be
incomplete, outdated, or wrong. They are **not** professional, engineering,
security, compliance, or legal advice, and must not be relied on as the sole
basis for operational decisions. Verify findings independently before acting
on them.

## 7. Third-party tools

Debug Anything orchestrates independent third-party tools (`strace`, `py-spy`, `perf`,
`tcpdump`, `gdb`, `lldb`, and others). Those tools are developed and licensed
by their respective owners, are governed by their own licenses and terms, and
their behavior is outside the authors' control. No affiliation with or
endorsement by those projects is implied.

## 8. Personal, independent project

Debug Anything is developed and maintained by its contributors **in their personal,
individual capacities** as an open-source project. It is not affiliated with,
sponsored by, or endorsed by any employer, company, or organization of any
contributor, and no such entity bears any responsibility for it.

## 9. No obligation of support or continuity

Debug Anything may change, break, or be discontinued at any time without notice. Nothing
creates an obligation to provide maintenance, support, updates, or fixes.

## 10. Safety guards are best-effort

Debug Anything is read-only by default and never escalates privileges on its own
(see [docs/safety.md](docs/safety.md)). These guards are engineering
safeguards, not guarantees, and do not shift any responsibility described
above.

---

*Summary (not a substitute for the above): free tool, no warranty, no
liability, observe only what you're authorized to observe, your systems and
data are your responsibility.*
