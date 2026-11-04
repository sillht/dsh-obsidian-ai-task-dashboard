#!/bin/sh
# 把 vault 里正在用的看板代码复制到这个仓库（只复制下面列出的文件，个人设置不会被带过来）。
# 用法：./sync.sh            默认从 ~/Obsidian/SecondBrain/_dashboard 复制
#      DASH=/path/to/vault/_dashboard ./sync.sh
set -eu
DASH="${DASH:-$HOME/Obsidian/SecondBrain/_dashboard}"
cd "$(dirname "$0")"
for f in view.js view.css debug.md news/fetch.mjs \
         fonts/doto.css fonts/doto-1.woff2 fonts/doto-2.woff2 fonts/spacemono.css \
         fonts/spacemono-1.woff2 fonts/spacemono-2.woff2 fonts/spacemono-3.woff2 \
         fonts/spacemono-4.woff2 fonts/spacemono-5.woff2 fonts/spacemono-6.woff2; do
  cp "$DASH/$f" "$f"
done
echo "已复制。提交前先看一眼：git diff --stat"
