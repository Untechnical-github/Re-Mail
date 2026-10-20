#!/usr/bin/env bash
# 一時的な失敗（ネットワーク、GitHub や npm の障害など）に備えて、コマンドを最大3回試す。
#   bash script/ci/retry.sh npm ci
for attempt in 1 2 3; do
  "$@" && exit 0
  if [ "$attempt" -lt 3 ]; then
    echo "::warning::失敗したので $((attempt * 20)) 秒後にやり直します（${attempt}/3）: $*"
    sleep $((attempt * 20))
  fi
done
echo "::error::3回試しても失敗しました: $*"
exit 1
