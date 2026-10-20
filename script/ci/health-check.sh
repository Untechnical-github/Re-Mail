#!/usr/bin/env bash
# デプロイした Worker の動作確認。反映を待つため、少し間を空けて最大3回試す。
# トップページと、Auth.js のプロバイダー一覧（Worker 上の Next.js と
# AUTH_SECRET などのシークレットが揃っているか）の両方が正しく応答するかを見る。
set -euo pipefail
URL="https://re-mail.eusng90912.workers.dev"
for i in 1 2 3; do
  if curl -fsS "$URL/" | grep -q 'Re:Mail' \
    && curl -fsS "$URL/api/auth/providers" | grep -q '"google"'; then
    echo "Worker は正常に応答しています"
    exit 0
  fi
  sleep $((i * 10))
done
echo "::error::Worker が正しく応答しません: $URL"
exit 1
