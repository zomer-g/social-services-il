#!/bin/sh
# Build-time. Runs once as root; the result is baked into the image.
set -eu

# Dev dependencies are needed to compile TypeScript and bundle the SPAs, then
# pruned so they do not count against the image size cap.
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev --no-audit --no-fund
