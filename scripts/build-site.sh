#!/usr/bin/env bash
# Assemble the static site into _site/ (used by both GitHub Pages and Vercel).
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf _site && mkdir -p _site/docs
cp -r site/* _site/
cp -r docs/* _site/docs/
cp README.md _site/docs/README.md
cp docs/demo.mp4 _site/docs/demo.mp4 2>/dev/null || true
cp assets/dea-logo.png assets/dea-logo-light.png assets/dea-mark-512.png _site/ 2>/dev/null || true
echo "site assembled in _site/ ($(find _site -type f | wc -l | tr -d ' ') files)"
