#!/bin/bash
# Claude Code のリモート環境で、テスト・lint・Playwright での確認ができるように依存を入れる
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "$CLAUDE_PROJECT_DIR"
# コンテナの状態はフックの後でキャッシュされるので npm ci ではなく npm install を使う
npm install --no-audit --no-fund
