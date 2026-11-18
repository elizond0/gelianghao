#!/bin/bash
# 轮询 CDN 直到新 bundle 生效（cache-busting 参数绕缓存）
# 用法：
#   bash scripts/deploy-poll.sh              # 自动取本仓库 dist/app.bundle.js 的 md5 作为目标
#   bash scripts/deploy-poll.sh <md5>        # 显式指定（排查时可覆盖）
# r27：原来 TARGET 写死在脚本里、每次部署前要手工 sed 改；忘了改就一直轮询旧值直到 TIMEOUT
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-$(md5sum "$DIR/dist/app.bundle.js" | cut -d' ' -f1)}"
echo "TARGET=$TARGET"
for i in $(seq 1 40); do
  MD5=$(curl -sL "https://elizond0.github.io/gelianghao/app.bundle.js?cb=$RANDOM$RANDOM" | md5sum | cut -d' ' -f1)
  if [ "$MD5" = "$TARGET" ]; then echo "try$i $MD5 NEW-LIVE"; exit 0; fi
  echo "try$i $MD5 old"
  sleep 15
done
echo "TIMEOUT"; exit 1
