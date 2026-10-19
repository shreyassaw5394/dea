#!/usr/bin/env bash
# Assemble the static site into _site/ (used by both GitHub Pages and Vercel).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf _site && mkdir -p _site/docs
cp -r site/* _site/
cp -r docs/* _site/docs/
cp README.md _site/docs/README.md
cp docs/demo.mp4 _site/docs/demo.mp4 2>/dev/null || true
cp assets/debuganything-logo.png assets/debuganything-logo-light.png assets/debuganything-mark-512.png _site/ 2>/dev/null || true
{ cat site/llms.txt; echo; for f in README.md docs/installation.md docs/examples.md docs/real-world.md docs/workflows.md docs/proactive.md docs/cli.md docs/providers.md docs/safety.md; do echo; echo "----- $f -----"; echo; cat "$f"; done; } > _site/llms-full.txt
echo "site assembled in _site/ ($(find _site -type f | wc -l | tr -d ' ') files)"
