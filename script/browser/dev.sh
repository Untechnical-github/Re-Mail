#!/bin/bash
# Playwright での確認用に、開発サーバー（next dev）を裏で起動し、応答するまで待つ。
# 使い方: script/browser/dev.sh [ポート]   止める: script/browser/dev.sh stop
# ログイン用の値が無ければダミーを入れる（本物のシークレットは使わない。Google へのログインはできない）。
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .playwright
PID_FILE=.playwright/dev.pid

if [ "${1:-}" = "stop" ]; then
  if [ -f "$PID_FILE" ]; then kill -- "-$(cat "$PID_FILE")" 2>/dev/null || true; rm -f "$PID_FILE"; fi
  exit 0
fi

PORT="${1:-3000}"
export AUTH_SECRET="${AUTH_SECRET:-$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')}"
export GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-dummy-client-id}"
export GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-dummy-client-secret}"
export NEXT_TELEMETRY_DISABLED=1

if curl -s -o /dev/null "http://localhost:$PORT/"; then
  echo "すでに http://localhost:$PORT/ で動いています"; exit 0
fi
setsid npx next dev -p "$PORT" > .playwright/dev.log 2>&1 &
echo $! > "$PID_FILE"
for _ in $(seq 1 90); do
  if curl -s -o /dev/null "http://localhost:$PORT/"; then echo "起動しました: http://localhost:$PORT/（ログ: .playwright/dev.log）"; exit 0; fi
  sleep 1
done
echo "起動しませんでした。.playwright/dev.log を見てください" >&2
exit 1
