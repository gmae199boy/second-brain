#!/usr/bin/env bash
# bmad-loop [verify] command (2026-10-29): the repository's full check, `pnpm test`
# (build, typecheck and every test project, PostgreSQL tests on the test container).
# Exit 75 = environment fault (bmad-loop pauses without charging an attempt; the
# coordinator repairs and resumes): Docker not answering, or dependencies missing.
set -uo pipefail

if ! docker info >/dev/null 2>&1; then
  echo "verify: docker does not answer (OrbStack off?)" >&2
  exit 75
fi
if [ ! -d node_modules ]; then
  echo "verify: node_modules missing — run pnpm install --frozen-lockfile" >&2
  exit 75
fi
pnpm test
