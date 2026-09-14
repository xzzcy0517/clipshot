#!/usr/bin/env bash
# ClipShot 新机器一键设置(Mac/Linux)。在克隆下来的仓库目录里运行:
#   bash bridge/setup.sh
# 它做三件事:检查 Node 版本 → 注册 Cursor/Claude Code 的 MCP → 打印 token 和
# 剩余的手动步骤(加载 Chrome 扩展只能手动,浏览器出于安全不允许脚本代劳)。
set -euo pipefail
cd "$(dirname "$0")/.."

echo "① 检查运行环境…"
if ! command -v node >/dev/null 2>&1; then
  echo "   ✗ 未找到 node。请先安装 Node.js ≥18:"
  echo "     Mac: 去 https://nodejs.org/zh-cn 点 LTS 下载安装,装完重开终端再跑本脚本"
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "   ✗ Node 版本过低($(node --version)),需要 ≥18。升级后重试。"
  exit 1
fi
echo "   ✔ node $(node --version)"
[ -f manifest.json ] || { echo "   ✗ 当前目录不是 ClipShot 仓库根目录"; exit 1; }
echo "   ✔ 仓库目录:$(pwd)"

echo "② 注册 MCP(Cursor / Claude Code)并自检…"
node bridge/mcp.mjs --install "$@"

echo
echo "── 若上面第②步一切正常,现在去浏览器完成最后两步(见上方输出框)即可 ──"
