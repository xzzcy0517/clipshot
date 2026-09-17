#!/usr/bin/env bash
# ClipShot 静态校验:语法 + manifest + geom 单测 + 协议防漂移。服务器无浏览器时的自证手段。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "── node --check 全部 JS"
find . \( -path ./.git -o -path ./node_modules \) -prune -o -name '*.js' -print0 |
  xargs -0 -n1 node --check

echo "── 测试"
node tests/manifest.test.mjs
node tests/sw-boot.test.mjs
node tests/geom.test.mjs
node tests/protocol.test.mjs
node tests/edit.test.mjs
node tests/imagestore.test.mjs

echo "✔ 全部静态校验通过"
