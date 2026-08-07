#!/usr/bin/env bash
# Produces the tarball that bootstrap.sh expects. Run from the repo root.
set -euo pipefail
OUT="${1:-/root/aurora-fileshare.tar.gz}"

tar -czf "$OUT" \
  --exclude='./node_modules' \
  --exclude='./dist' \
  --exclude='./public/build' \
  --exclude='./public/sw.js' \
  --exclude='./.git' \
  --exclude='./test/.tmp' \
  --exclude='./.env' \
  -C "$(dirname "$0")/.." .

echo "Wrote $OUT ($(stat -c %s "$OUT") bytes)"
