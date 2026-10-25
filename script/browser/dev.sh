#!/bin/bash
# Playwright での確認用に、開発サーバー（next dev）を裏で起動し、応答するまで待つ。
# 使い方: script/browser/dev.sh [ポート]             … next dev（速い。既定 3000）
#         script/browser/dev.sh --preview [ポート]   … 本番と同じ Workers の形（OpenNext でビルドして wrangler で動かす。CSP なども本番と同じ。既定 8787）
#         script/browser/dev.sh stop                 … 止める（どちらも）
# - ローカルの D1（.wrangler/、この環境の中だけ）に migrations を当ててから起動する。本番の D1 には触らない。
# - AUTH_SECRET / TOKEN_ENCRYPTION_KEY が環境変数に無ければ、確認用の鍵をこの環境の中で作って .playwright/ に置く
#   （git 管理外。本番やローカル PC の鍵とは別物。check.mjs --login も同じ鍵で Cookie を作る）。
# - GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET が無ければダミーを入れる（ログイン画面までは出るが、ログインはできない）。
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p .playwright
PID_FILE=.playwright/dev.pid

if [ "${1:-}" = "stop" ]; then
  if [ -f "$PID_FILE" ]; then kill -- "-$(cat "$PID_FILE")" 2>/dev/null || true; rm -f "$PID_FILE"; fi
  exit 0
fi

MODE=dev
if [ "${1:-}" = "--preview" ]; then MODE=preview; shift; fi
if [ "$MODE" = preview ]; then PORT="${1:-8787}"; else PORT="${1:-3000}"; fi
gen_key() { # $1: ファイル  32バイトの乱数を base64 で置く（無いときだけ作る）
  [ -s "$1" ] || (umask 077; node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("base64"))' > "$1")
  cat "$1"
}
export AUTH_SECRET="${AUTH_SECRET:-$(gen_key .playwright/dev-auth-secret)}"
export TOKEN_ENCRYPTION_KEY="${TOKEN_ENCRYPTION_KEY:-$(gen_key .playwright/dev-token-key)}"
export GOOGLE_CLIENT_ID="${GOOGLE_CLIENT_ID:-dummy-client-id}"
export GOOGLE_CLIENT_SECRET="${GOOGLE_CLIENT_SECRET:-dummy-client-secret}"
export NEXT_TELEMETRY_DISABLED=1

if curl -s -o /dev/null "http://localhost:$PORT/"; then
  echo "すでに http://localhost:$PORT/ で動いています"; exit 0
fi
npx wrangler d1 migrations apply DB --local > .playwright/d1.log 2>&1 || { echo "ローカル D1 の準備に失敗しました。.playwright/d1.log を見てください" >&2; exit 1; }
if [ -f "$PID_FILE" ]; then kill -- "-$(cat "$PID_FILE")" 2>/dev/null || true; rm -f "$PID_FILE"; fi
if [ "$MODE" = preview ]; then
  echo "ビルドしています（30秒ほど）…"
  npx opennextjs-cloudflare build > .playwright/build.log 2>&1 || { echo "ビルドに失敗しました。.playwright/build.log を見てください" >&2; exit 1; }
  # .dev.vars が無いので、上の環境変数を Worker の env に渡す（ファイルには書かない）
  CLOUDFLARE_INCLUDE_PROCESS_ENV=true setsid npx wrangler dev --port "$PORT" > .playwright/dev.log 2>&1 &
else
  setsid npx next dev -p "$PORT" > .playwright/dev.log 2>&1 &
fi
echo $! > "$PID_FILE"
for _ in $(seq 1 90); do
  if curl -s -o /dev/null "http://localhost:$PORT/"; then echo "起動しました: http://localhost:$PORT/（ログ: .playwright/dev.log）"; exit 0; fi
  sleep 1
done
echo "起動しませんでした。.playwright/dev.log を見てください" >&2
exit 1
