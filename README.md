# ClipShot 滚动长截图

自用 Chrome 扩展(MV3,零构建零依赖):把整个网页截成一张长图。

- **整页滚动长截图**:自动滚动触发懒加载 → `chrome.debugger` CDP 一次性捕获整页,超大页面自动分段拼接
- **可视区域截图**:当前一屏,不出现调试横幅
- **框选区域截图**:拖拽选区,所见即所得
- **右击截取元素**:页面任意元素右键 → 「ClipShot:截取此元素」
- **隐藏固定元素**:sticky 顶栏、悬浮客服等可从长图中剔除
- 截图完成后打开**预览页**:缩放查看、下载 PNG/JPEG、复制到剪贴板
- **Agent 桥接**:本机 HTTP 指令调用截图,给 Cursor / 豆包 / Codex 等 AI Agent 用,
  图片落盘 `~/clipshot-out/`;支持 MCP 直连一键安装(`node bridge/mcp.mjs --install`,
  Cursor/Claude Code 对话里直接调)——见 [docs/Agent接入指南.md](docs/Agent接入指南.md)

## 快速上手

1. 打开 `chrome://extensions/`,右上角开启「开发者模式」
2. 「加载已解压的扩展程序」→ 选择本仓库根目录 `/opt/clipshot`(或本地 clone 后的目录)
3. 快捷键:`Alt+Shift+F` 整页 / `Alt+Shift+V` 可视区 / `Alt+Shift+S` 框选 / `Alt+Shift+P` 面板
4. 截图期间页面顶部会出现「ClipShot 正在调试此浏览器」提示条,**属正常现象,切勿点「取消」**,截完自动消失

详见 [docs/安装与调试指南.md](docs/安装与调试指南.md)。

## 开发

**任何 Agent(Claude Code / Kimi / 其他)或新人接手,先读 [CLAUDE.md](CLAUDE.md)**——环境约束、门禁、纪律和文档路由都在那一页(AGENTS.md 是它的兼容指针)。

服务器(无浏览器)上只做静态校验:`bash tests/run-all.sh`;行为验证在本地 Chrome 用 `tests/fixtures/` 下的夹具页。
架构与决策见 [docs/架构说明.md](docs/架构说明.md),进度见 [docs/路线图与开发日志.md](docs/路线图与开发日志.md)。
一批工作完成后,Agent 会提醒你执行 neat-freak(`/neat`)做知识归档——是否收尾由你决定;本仓库自带项目级 skill(`.claude/skills/neat-freak/`)。
