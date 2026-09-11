# P002 · MCP 直连方案(Agent 对话里直接调 ClipShot,免终端免 curl)

| 状态 | **已实现**(commit `930c24f`,2026-09-11;扩展零改动不 bump,RELAY_VERSION 0.4.0)· 待用户在 Cursor/Claude Code 冒烟 |
|---|---|
| 提案日期 | 2026-09-11 |
| 前置 | P001-P1 已验收(HTTP/curl 通路可用);本提案是其 MCP 原生升级,**扩展本体零改动** |
| 关联 | `bridge/relay.mjs`(复用)、`docs/Agent接入指南.md`(将增补 MCP 章节) |

## 1. 一句话与背景

P1 已能让 Agent 用 curl 截图,但有两个不丝滑处:relay 要人肉开一个终端窗口常驻;
Agent 要走「执行 shell 命令→解析 JSON→再读文件」三跳。MCP 直连把这三件事全消掉:
**Agent 产品(Cursor / Claude Code / Codex 等)自己把桥进程拉起来,LLM 在对话里
直接调用 `clipshot_screenshot` 工具,图片直接出现在它的"眼睛"里。**

## 2. MCP 是什么(给不看协议文档的人)

MCP(Model Context Protocol)= AI Agent 产品的「USB 接口标准」。你在 Agent 的配置里
登记一条「有个叫 clipshot 的工具服务,启动命令是 X」,之后:

1. Agent 启动时**自动替你运行** X(不需要你开终端,关掉 Agent 它也跟着退出);
2. Agent 问 X「你有哪些工具」,X 回答:截图/查健康/列标签页;
3. 对话里 LLM 决定调用工具 → Agent 把参数发给 X → X 干完活把**图片本身**塞回对话。

**为什么不用再手动启动本地服务**:P1 的 relay 是你手动 `node bridge/relay.mjs` 起的
独立进程;P2 的 `bridge/mcp.mjs` 把 **relay 整个内嵌**进来,由 Agent 宿主按配置自动
拉起、自动管理生死。你不感知任何常驻窗口。(relay 的 HTTP 接口同时还在——curl 用法
完全不变,两条路并存。)

## 3. 架构

```
Cursor / Claude Code / Codex(宿主,自动 spawn 子进程)
   │  stdio:JSON-RPC(MCP 标准,零依赖手写 ~200 行)
   ▼
bridge/mcp.mjs ──内嵌── startRelay()(复用 relay.mjs,HTTP+WS 照旧监听 127.0.0.1)
   │                                  ▲
   │ tools/call                       │ WS(协议与 P1 完全一致,扩展无感知)
   ▼                                  │
 截图/健康/标签页 ────────────  Chrome 扩展 background/bridge.js(零改动)
```

- **端口冲突自动降级**:若 8790 已被占用(比如你手动开着 P1 relay,或两个 Agent
  产品各拉了一个 mcp.mjs),后来者检测 `EADDRINUSE` → 自动变身为「纯客户端」,
  通过 HTTP+token 调已存在的 relay(token 从 `~/.clipshot/relay.json` 读)。
  多宿主共存不打架,扩展只连一条 WS。
- **实现清单**:`bridge/mcp.mjs`(stdio JSON-RPC:initialize / tools/list /
  tools/call / ping;stdout 只走协议,日志一律 stderr)+ `--install` 子命令(见 §6)。

## 4. 工具面(v1 三个,克制)

| 工具 | 参数 | 返回 |
|---|---|---|
| `clipshot_screenshot` | `mode`(full/visible/element)、`selector`(element 必填)、`target`(active/tabId/{urlContains})、`format`、`hideFixed` | **仅文本块:落盘路径 + 尺寸/格式/大小 + notes,永不内联图片**(用户决策:省上下文,Agent 按路径自己读图;后续有反馈再加内联开关) |
| `clipshot_health` | — | relay/扩展连接状态、版本、输出目录 |
| `clipshot_tabs` | — | 可截取的标签页列表(tabId/url/title/active) |

设计要点:**文件永远落盘**(P1 决策不变,`~/clipshot-out/`),工具只回路径与元信息,
LLM 需要看图时由宿主自己读文件(Claude Code/Cursor 都支持读本地图片)。
工具描述文本用中文写清何时该用 full(默认推荐)、何时 visible。

## 5. 各 Agent 产品怎么配(小白版,届时写进接入指南)

| 产品 | 配置方式 |
|---|---|
| **Claude Code** | 终端一条命令:`claude mcp add clipshot -- node <仓库绝对路径>/bridge/mcp.mjs`(或 `node bridge/mcp.mjs --install` 自动执行) |
| **Cursor** | 设置 → MCP → Add,粘贴三行 JSON(`command:"node"`,`args:[绝对路径]`);`--install` 可自动写入 `~/.cursor/mcp.json`(合并不覆盖) |
| **Codex CLI** | `~/.codex/config.toml` 加 `[mcp_servers.clipshot]` 段;`--install` 打印现成段落供粘贴(TOML 自动改写风险高,只打印不动手) |
| **豆包工作 / WorkBuddy 等** | 支持 MCP 的:同上模式(命令+绝对路径);不支持 MCP 的:**继续用 P1 的 curl 接入提示词**,能力等价,只是多一跳 |

## 6. 「一键安装」= `node bridge/mcp.mjs --install`

自动探测并配置,全程打印人话进度:
1. 找 `claude` CLI → 有则执行 `claude mcp add`(幂等,已存在先 remove);
2. 找 `~/.cursor/` → 有则合并写入 `~/.cursor/mcp.json`(保留用户已有 servers);
3. Codex/其他:打印对应配置片段(含已解析好的绝对路径与 node 路径),复制粘贴即可;
4. 最后自动跑一次自检:spawn 一个 mcp 子进程走 initialize→tools/list→health,
   打印「✔ 安装成功,重启你的 Agent 后即可在对话里说:截个当前页面给我看」。

## 7. 安全与边界

- 与 P1 完全一致:只绑 127.0.0.1;HTTP 面仍需 token;MCP stdio 面由宿主 spawn,
  天然只有本机能连。**无新增密钥、无新增网络暴露面、扩展侧零改动零新权限。**
- mcp.mjs 崩溃不影响 P1:HTTP curl 通路独立存在;两进程并存时自动降级(§3)。

## 8. 测试策略(服务器可全验,延续 P1 标准)

`tests/mcp.test.mjs`(零依赖):spawn `node bridge/mcp.mjs` 子进程,stdio 灌 JSON-RPC:
initialize/tools/list 协议合规性(含 protocolVersion 回显、能力声明)→ 假扩展 WS 客户端
(复用 ws-relay.test 手法)→ `tools/call clipshot_screenshot` 端到端:断言 image 块
base64 可解码、落盘文件存在、text 块含路径 → `clipshot_health/tabs` → 端口占用降级路径
(先起一个 relay 再 spawn mcp,断言 client 模式工作)→ `--install` 的 dry-run(只打印)。
CI 全绿后才算完成;扩展侧因零改动,**不需要重新走浏览器验收**,只需宿主里说一句话冒烟。

## 9. 版本与落库

扩展本体零改动 → **不 bump 扩展版本**(纪律#2);`RELAY_VERSION` 0.3.0 → 0.4.0
(relay.mjs 与 mcp.mjs 共用)。开发日志记「P002 实现(不 bump)」条目;
`docs/Agent接入指南.md` 增补「MCP 直连」章节;本提案状态回填 commit。

## 10. 已确认的决策(2026-09-11 用户拍板)

1. **永不内联图片,只回文件路径**+元信息(省上下文;Agent 按路径自己读图;
   后续若有用户反馈再加内联开关)。
2. **`--install` 允许合并式改写 `~/.cursor/mcp.json`**,写前备份 `.bak`;
   Claude Code 走官方 `claude mcp add`(幂等);Codex 只打印片段。
3. **工具面克制为三个**:`clipshot_screenshot` / `clipshot_health` / `clipshot_tabs`;
   DOM/点击等「眼睛和手」工具族留 P3 立项。
