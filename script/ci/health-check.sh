#!/usr/bin/env bash
# デプロイした Worker の動作確認。反映を待つため、少し間を空けて最大3回試す。
# - トップページと、Auth.js のプロバイダー一覧（Worker 上の Next.js と
#   AUTH_SECRET などのシークレットが揃っているか）の両方が正しく応答するか
# - トップページの CSP に nonce があり、ページ内のインラインスクリプトがすべて同じ nonce を持っているか
#   （nonce がずれるとスクリプトが止まって画面が動かないのに、ページ自体は 200 を返すため、ここで見る）
set -euo pipefail
URL="${HEALTH_CHECK_URL:-https://re-mail.eusng90912.workers.dev}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

check_csp_nonce() {
  curl -fsS -D "$TMP/h.txt" -o "$TMP/p.html" -H "accept: text/html" "$URL/" || return 1
  local nonce
  nonce="$(grep -i '^content-security-policy:' "$TMP/h.txt" | grep -o "'nonce-[A-Za-z0-9+/=]*'" | head -1 | sed "s/'nonce-//; s/'//")"
  if [ -z "$nonce" ]; then echo "CSP に nonce がありません"; return 1; fi
  # src の無い <script> を数え、そのうち nonce が合っていないものがあれば失敗
  local inline bad
  inline="$(grep -o '<script[^>]*>' "$TMP/p.html" | grep -vc ' src=' || true)"
  bad="$(grep -o '<script[^>]*>' "$TMP/p.html" | grep -v ' src=' | grep -vc "nonce=\"$nonce\"" || true)"
  if [ "$inline" -eq 0 ]; then echo "インラインスクリプトが見つかりません（ページの形が変わった可能性）"; return 1; fi
  if [ "$bad" -ne 0 ]; then echo "nonce の合わないインラインスクリプトが ${bad} 個あります"; return 1; fi
  return 0
}

for i in 1 2 3; do
  if curl -fsS -o /dev/null "$URL/" \
    && curl -fsS "$URL/api/auth/providers" | grep -q '"google"' \
    && check_csp_nonce; then
    echo "Worker は正常に応答しています"
    exit 0
  fi
  sleep $((i * 10))
done
echo "::error::Worker が正しく応答しません: $URL"
exit 1
