# P001 · Agent 桥接截图方案(让 AI Agent 直接调用 ClipShot)

| 状态 | **已批准**(2026-09-11 用户拍板 §9 四项分叉)· 待开发 |
|---|---|
| 提案日期 | 2026-09-11 |
| 作者 | Claude Code + xzzcy0517 |
| 关联 | `background/pipeline.js`(复用捕获引擎)、`CLAUDE.md`(方案先行流程) |
| 特别要求 | 用户自述「电脑小白」:**《Agent 接入指南》是 P1 必备交付物**,必须 step-by-step 到"复制粘贴命令就能跑通",含每个 Agent 产品的接入配置与排错章节;指南写不合格 = P1 未完成 |

## 1. 背景与目标

Cursor / WorkBuddy / 豆包工作 / Codex 等 Agent 操作浏览器时,普遍只能拿到
**视口截图**(Playwright/CDP 的 screenshot),拿不到整页长图,更没有
「滚动加载→懒加载触发→整页捕获」的编排能力——这正是 ClipShot 已经做好的事。

目标:Agent 通过**一条本地指令**调用 ClipShot 完成截图,拿回图片(文件路径或
base64)直接喂给识图模型,无需人工点击。个人自用,安全边界=本机。

## 2. Agent 产品形态与可行性结论

| Agent 形态 | 代表 | 接入方式 | 可行性 |
|---|---|---|---|
| 能执行 shell 的任何 Agent | Codex、Claude Code、豆包、WorkBuddy | `curl http://127.0.0.1:8790/...` | ✅ 零门槛 |
| 支持 MCP 的 Agent | Cursor、Claude Code、Codex | MCP stdio 包装器(薄壳,转发到同一 relay) | ✅ 二期 |
| CDP/Playwright 驱动浏览器 | browser-use 类 | 见 §6 冲突分析 | ⚠️ 有 debugger 独占冲突,需降级策略 |

**核心可行性依据**(官方文档,2026-09 核实):
- MV3 SW 中 WebSocket 收发消息会重置 30s 空闲计时器 → relay 每 20s ping 即可让
  SW 常驻待命;断线自动重连兜底。(developer.chrome.com SW lifecycle / WebSockets how-to)
- 活跃 `chrome.debugger` 会话本身保活 SW(我们已依赖);单任务上限 5min > 作业超时 180s ✅。
- 扩展 SW 连 `ws://127.0.0.1` 不受页面 mixed-content 限制(扩展上下文);CSP 默认不拦
  connect-src——**此项列入 P1 首个实测验证点**。

## 3. 候选架构对比

| 方案 | 说明 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. 本地 WS/HTTP relay(推荐)** | 仓库带一个零依赖 Node 脚本:对 Agent 暴露 HTTP,对扩展暴露 WS | 安装=跑一条命令;跨平台;Agent 侧就是 curl;可扩展 MCP | 需要手动/开机启动 relay | ✅ 采用 |
| B. Native Messaging | Chrome 原生消息主机,浏览器自动拉起 | 无需手动启动 | 每台机器要装 host 清单(Mac/Linux 路径不同);调试繁琐;Agent 仍要另起 HTTP 面 | ❌ 收益不抵摩擦 |
| C. 页面内 postMessage 桥 | Agent 注入 JS 与 content script 通信 | 无额外进程 | 每页注入、时序脆弱、拿不到 SW 的 pipeline;跨域页面不可控 | ❌ 否决 |

## 4. 推荐架构(方案 A)

```
Agent(curl / MCP客户端 / Playwright脚本)
   │  HTTP POST 127.0.0.1:8790/v1/screenshot   {mode, target, format, returnAs}
   ▼
bridge/relay.mjs(零依赖 Node:HTTP server + WS server,同端口)
   │  WS JSON {id, cmd, args}  ⇄  {id, ok, result}   (20s ping 保活)
   ▼
扩展 SW(background/bridge.js 新模块,复用 pipeline.startJob)
   │  捕获完成 → 不开 preview 标签,把 imagestore 数据回传 relay
   ▼
relay 落盘 ~/clipshot-out/xxx.png(或透传 base64)→ HTTP 响应给 Agent
```

- **扩展侧**:`background/bridge.js`——WS 客户端(重连+心跳应答)、命令分发到
  pipeline、新增「静默交付」模式(`openPreview:false`,结果走 bridge 回传)。
  options 页加「Agent 桥接」设置区:开关、端口、token、输出目录。
- **relay 侧**:`bridge/relay.mjs`(HTTP+WS 一体)+ `bridge/mcp.mjs`(二期,零依赖
  手写 MCP stdio:initialize/tools-list/tools-call 三个方法即可)。
- **安全**:只绑 127.0.0.1;首次启动生成随机 token 打印到终端,填入扩展 options;
  HTTP 请求带 `X-ClipShot-Token`。本机其他进程无 token 不能驱动你的浏览器截图。

## 5. 指令集 v1(HTTP JSON,错误码沿用 `common/messages.js` 的 ERR 体系)

```jsonc
// POST /v1/screenshot
{
  "mode": "full | visible | element",   // element 必须带 selector
  "target": "active | <tabId> | url 子串匹配",  // 默认 active
  "selector": ".doc-content",           // mode=element 时:querySelector 定位(比右键拾取更适合 Agent)
  "format": "png | jpeg", "hideFixed": true
}
// v1 只回文件路径(用户决策:不要 base64,截图直接落盘方便人眼查看):
// → 200 {"ok":true,"jobId":"…","image":{"path":"/Users/…/clipshot-out/ClipShot_….png",
//        "mime":"image/png","widthPx":1440,"heightPx":23000,"bytes":…},"notes":[…]}
// → 200 {"ok":false,"error":"DEVTOOLS_CONFLICT","message":"请先关闭该标签页的开发者工具…"}
```

辅助指令:`GET /v1/health`(relay+扩展连通性、版本)、`GET /v1/tabs`(可截目标列表)。
**不做**:region 框选(需要人拖拽,与 Agent 场景矛盾)、任何写操作。

Agent 侧用法示例:

```bash
curl -s 127.0.0.1:8790/v1/screenshot -H "X-ClipShot-Token: $TOKEN" \
  -d '{"mode":"full","target":"active"}'
# → 拿 path 给识图模型;或 "returnAs":"base64" 直接内联
```

MCP(二期)工具面:`clipshot_screenshot(mode,target,selector,format)` 返回
image content块(Cursor/Claude Code 原生识图)、`clipshot_health`。

## 6. 关键风险与对策(讨论重点)

| 风险 | 场景 | 对策 |
|---|---|---|
| **debugger 独占冲突** | Agent 用 Playwright/CDP 已附着目标页,扩展 attach 报 `Another debugger` | ① 返回明确错误码,Agent 可先 `browser.close()`/换标签再调;② `mode:visible` 永不受影响(captureVisibleTab 不占 debugger);③ 文档写明:整页截图瞬间不要并发跑 CDP 操作 |
| Playwright 自启浏览器没装扩展 | Agent launch 全新 Chromium | 文档给出 `--load-extension=/path/to/clipshot --disable-extensions-except=…` 启动参数模板;relay 侧 /v1/health 能暴露"扩展未连接" |
| SW 休眠丢 WS | Chrome 更新改变保活语义 | 20s 心跳 + 指数退避重连 + `chrome.alarms` 看门狗;relay 检测扩展离线时 HTTP 直接报 `EXTENSION_OFFLINE`,Agent 可重试 |
| ws://127.0.0.1 被 CSP/策略拦 | 企业策略或未来 Chrome 收紧 | P1 第一个验证点;万一被拦,降级方案=Native Messaging(方案 B 作备胎保留) |
| 大图 HTTP 传输 | 几十 MB PNG | localhost 无压力;默认 returnAs=file 避免 JSON 膨胀 |
| 截图期间页面被 Agent 操作 | 并发写 | 同一 target 串行:bridge 作业复用 jobsByTab 防重入,冲突返回 BUSY |

## 7. 分期与验收

- **P1(核心闭环)**:`bridge/relay.mjs` + `background/bridge.js` + 静默交付 +
  screenshot(full/visible)+ element(selector)+ health/tabs + options 设置区 + token
  + **`docs/Agent接入指南.md`(小白向,必备)**。
  验收:`node bridge/relay.mjs` 启动后,终端 `curl` 三连(health→visible→full)全通,
  飞书文档整页长图落盘成功;断开 relay 扩展无残留;SW 休眠 60s 后指令仍能唤醒执行;
  **用户按指南独立(不问我)完成首次接入 = 指南合格**。
- **P2(MCP 薄壳)**:`bridge/mcp.mjs` 零依赖 stdio 包装,Cursor/Claude Code 配置
  模板入文档;验收:Cursor 里对话「截个整页图给我看」直接回图。
- **P3(观察项)**:多浏览器实例、截图历史查询、selector 等待语义(waitFor)——按实际使用反馈再立项。

## 8. 落库与规范变更(随本方案一并生效)

- 新目录 `docs/proposals/`:功能扩展一律「P编号-标题.md」,头部状态表
  (草案→评审中→已批准→已实现/已否决);实现后在状态表回填 commit/版本。
- `CLAUDE.md` 新增「方案先行」纪律:新功能先写提案→用户确认→开发→回填状态。

## 9. 已确认的决策(2026-09-11 用户拍板)

1. **架构 = 方案 A**(WS/HTTP relay);方案 B(Native Messaging)保留为 P3 备胎。
2. **返回 = 仅文件路径**,落盘 `~/clipshot-out/`(options 可改);v1 不做 base64 内联。
3. **token 鉴权 P1 就上**:relay 首次启动生成随机 token 打印到终端,填入扩展设置页。
4. **MCP 薄壳严格 P2**:P1 先验证 HTTP 闭环(含 ws://127.0.0.1 连通、SW 保活实测)。
5. 默认端口 8790;《Agent 接入指南》(`docs/Agent接入指南.md`)为 P1 必备交付物,
   面向电脑小白:启动/验证/各 Agent 产品接入配置/排错,全部给可复制粘贴的命令。
