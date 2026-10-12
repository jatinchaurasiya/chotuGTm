#!/usr/bin/env bash
# chotu: point git at the repo-owned hooks dir (.githooks/).
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

chmod +x .githooks/pre-commit
git config core.hooksPath .githooks
echo "[setup-hooks] core.hooksPath=$(git config core.hooksPath)"
