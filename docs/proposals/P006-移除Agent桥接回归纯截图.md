# P006 · 移除 Agent 桥接(MCP/Skill/操作),回归纯截图扩展

| 状态 | **已执行**(v0.7.0,2026-09-15;面板诊断按用户要求保留) |
|---|---|
| 提案日期 | 2026-09-15 |
| 触发 | 用户决定:截图本是调试用途,手动截即可;Agent 对接(P001/P002/P004/P005 全部)不再需要,要求连同文档整体删除 |
| 原则 | 一次删干净,不留死引用;git 历史是档案,删除的文件不归档不转存 |

## 1. 整删(29 个文件/目录)

| 项 | 说明 |
|---|---|
| `bridge/`(relay.mjs / mcp.mjs / setup.sh) | 桥本体 |
| `background/bridge.js`、`background/agent.js` | 扩展侧 WS 客户端 + 接管编排 |
| `skills/clipshot-screenshot/` | Agent Skill 包 |
| `docs/Agent接入指南.md`、`docs/新机器部署指南.md` | 面向 Agent 的两份文档 |
| `tests/ws-relay.test.mjs`、`tests/mcp.test.mjs` | 桥的集成测试 |
| `tests/fixtures/agent-playground.html` | P005 操作夹具 |
| `docs/proposals/P001、P002、P004、P005` | 被删能力的合同文档(历史在 git) |

## 2. 摘除式修改(保留文件内剥掉 Agent 相关部分)

| 文件 | 动作 |
|---|---|
| `background/sw.js` | importScripts 去 bridge/agent;删 CONSOLE/RELEASE/BRIDGE_STATE 路由、bridge.init/reload、agent 事件/alarm/storage.onChanged 接线 |
| `common/messages.js` | 删 SNAP/ACT_RUN/CONSOLE(_IN)/CONTROL_*/RELEASE/PICK_QUERY/BRIDGE_STATE;**保留** DIAG_METRICS(面板诊断属截图排障)与全部截图协议 |
| `content/content.js` | 删整个 P005 段(快照/动作引擎/徽标/Esc/console 桥/rev 追踪)+ PICK_QUERY 路由;保留 scrollTo/scrollIntoViewPick(截图引擎在用) |
| `background/pipeline.js` | 删桥专用死代码:silent/promise/_res/_rej(静默交付)、ensureActive(入口只剩面板活动标签)、runElement 的 selector 分支 |
| `options/*` | 删「Agent 桥接」「Agent 操作」两组设置与 initBridge/refreshBridge |
| `tests/run-all.sh` | 去两条桥测试 |
| `tests/sw-boot.test.mjs` | **保留**(SW 冷启动守门与桥无关),更新模块断言与数量 |
| `tests/manifest.test.mjs` | 无桥引用,预计零改动(跑一遍确认) |
| `CLAUDE.md` | 删文档路由「Agent 桥接」行;门禁构成措辞更新;加一条纪律:桥已删,勿复活 |
| `README.md` | 删 Agent 桥接特性行与新机器部署入口 |
| `docs/架构说明.md` | 删「Agent 桥接」「MCP 直连层」「Agent 操作层」三节与模块图 bridge 行;已知限制版本头更新 |
| `docs/路线图与开发日志.md` | v0.7.0 记录移除;里程碑表收掉 P001/P002/P005 行;后续候选删 P005-b/c、"眼睛和手";keep-3 收 v0.6.0 明细 |
| `docs/proposals/P003-超长页治理方案.md` | 头部加一行勘误:其中 relay/mcp 落点行随 P006 失效 |

## 3. 明确保留(它们属于截图本体)

- 全部捕获引擎(pipeline/cdp/networkidle/geom/imagestore/content 滚动+稳定门控)、
  popup/preview/options 截图设置、面板诊断(DIAG_METRICS)、右键截元素(PICK_GET)、
  sw-boot 守门测试、其余 5 个夹具、CDP 笔记(纯截图知识)、P003 提案。
- `chrome.debugger/scripting/alarms/tabs` 等权限:截图引擎在用,不收。

## 4. 版本与验收

- **0.7.0**(功能移除,minor);manifest/EXT_VER/日志三同步由闸门强制。
- 验收:`bash tests/run-all.sh` 全绿 + 全仓 `grep -riE "bridge|relay|mcp|skill|agent|接管|setup.sh" README.md CLAUDE.md docs/*.md background common content options popup preview tests` **零命中**(排除本提案与 CDP 笔记中允许的截图语义词);扩展重载后四按钮 + 右键 + 诊断 + 预览全功能正常(你本地验)。
