#!/usr/bin/env bash
# Adoption numbers across every surface, from public APIs. Usage: bash scripts/stats.sh
set -u
j() { curl -s -m 15 "$1"; }
echo "== npm dea-agents"
for p in last-day last-week last-month; do printf '  %-11s %s\n' "$p" "$(j https://api.npmjs.org/downloads/point/$p/dea-agents | python3 -c 'import json,sys; print(json.load(sys.stdin).get("downloads","?"))')"; done
echo "== PyPI dea-agents"
j https://pypistats.org/api/packages/dea-agents/recent | python3 -c 'import json,sys; d=json.load(sys.stdin).get("data",{}); print(f"  last day {d.get(\"last_day\",\"?\")}  week {d.get(\"last_week\",\"?\")}  month {d.get(\"last_month\",\"?\")}")' 2>/dev/null || echo "  (pypistats not available yet; try pepy.tech/project/dea-agents)"
echo "== GitHub shreyassaw5394/dea"
j https://api.github.com/repos/shreyassaw5394/dea | python3 -c 'import json,sys; d=json.load(sys.stdin); print(f"  stars {d.get(\"stargazers_count\")}  forks {d.get(\"forks_count\")}  watchers {d.get(\"subscribers_count\")}  open issues {d.get(\"open_issues_count\")}")'
echo "  contributors:"; j "https://api.github.com/repos/shreyassaw5394/dea/contributors?per_page=10" | python3 -c 'import json,sys; [print(f"    {c[\"login\"]:<24} {c[\"contributions\"]} commits") for c in json.load(sys.stdin)]'
echo "  clones/views (14d, needs gh auth):"; gh api repos/shreyassaw5394/dea/traffic/clones --jq '"    clones " + (.count|tostring) + " (" + (.uniques|tostring) + " unique)"' 2>/dev/null; gh api repos/shreyassaw5394/dea/traffic/views --jq '"    views  " + (.count|tostring) + " (" + (.uniques|tostring) + " unique)"' 2>/dev/null
echo "== MCP Registry"; j "https://registry.modelcontextprotocol.io/v0/servers?search=shreyassaw5394" | python3 -c 'import json,sys; [print("  "+s.get("server",s).get("name"), s.get("server",s).get("version")) for s in json.load(sys.stdin).get("servers",[])]' 2>/dev/null
echo "== Site: Vercel → project dea → Analytics (cookieless, enable once in the dashboard)"
