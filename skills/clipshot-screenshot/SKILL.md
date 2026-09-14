---
name: clipshot-screenshot
description: >-
  Capture real web-page screenshots AND drive the page (click/type/observe)
  through the user's local ClipShot Chrome extension bridge. Use when asked to
  see the current browser page, capture a full-page/scrolling long screenshot,
  screenshot a specific element, verify UI changes, or perform multi-step
  browser tasks ("填这个表单并提交", "帮我在页面上点同意"). Requires: Chrome
  open with the ClipShot extension and「Agent 桥接」enabled. Trigger phrases:
  "截图看看浏览器"、"截个长图"、"看看当前页面"、"点一下/填一下页面上…"、"screenshot the page".
---

# ClipShot 截图 + 浏览器操作桥(Agent Skill)

本仓库自带的通用 skill:教任何支持 Agent Skill 的宿主(Claude Code / Claude /
支持 skill 的国产 Agent)通过本机 HTTP 桥使用用户 Chrome 里的 ClipShot 扩展——
截图(P001)与「手」操作页面(P005)是同一座桥。Cursor 用户走 MCP(`bridge/mcp.mjs`),
工具同名同义,不需要本文档。

## 使用前检查(每次会话第一次调用前做一次)

```bash
curl -s http://127.0.0.1:8790/v1/health
```

8790–8795 依次试,第一个连上的就是桥。响应里 `extension.connected` 必须为 true:

- 全端口拒接 → 桥没起来:提示用户在仓库目录跑 `bash bridge/setup.sh`(或打开 Cursor);
- `connected:false` → 扩展侧没开:提示 Chrome → ClipShot 设置页 → 勾选「启用 Agent 桥接」。

## 截图指令

```bash
curl -s http://127.0.0.1:<端口>/v1/screenshot \
  -H 'Content-Type: application/json' \
  -d '{"mode":"full"}'
```

| 参数 | 说明 |
|---|---|
| `mode` | `full` 整页滚动长图(默认,自动滚动加载懒内容)/ `visible` 当前屏 / `element` 指定元素(必填 `selector`) |
| `selector` | CSS 选择器,如 `"#article"`;配合 mode=element |
| `target` | `"active"`(默认)/ 数字 tabId / `{"urlContains":"关键字"}` |
| `format` | `png`(默认)/ `jpeg`(超长页更省体积) |
| `hideFixed` | 布尔;隐藏 sticky 顶栏/悬浮窗,默认沿用扩展设置 |

响应:

```json
{"ok": true,
 "image": {"path": "/Users/…/clipshot-out/ClipShot_20260914_1530_full.png",
           "parts": 1, "paths": ["…"], "widthPx": 1920, "heightPx": 8000, "sizeBytes": 1200000, "mime": "image/png"},
 "notes": ["已单张完整截取"]}
```

- **拿到 `image.path` 后直接用你的读图能力打开它**,这就是用户让你"看看浏览器"的内容;
- `parts > 1` 说明页面超长被分段(浏览器单张上限 ~16000px),`paths` 按序排列即整页,逐张读取;
- `notes` 是人话备注,值得转述给用户的关键信息(如"已按总长上限截断")。

失败响应:`{"ok":false,"error":"BUSY","message":"…"}`——message 已是给人看的中文,
原样转述即可;`BUSY` 等 10 秒重试,`DEVTOOLS_CONFLICT` 让用户关掉该页 F12。

## 「手」:操作浏览器页面(P005,同一座桥)

**规矩:先接管,再动手;每步「动作→自动等待→观察」一次调用。**

```bash
# ① 开启接管(告知用户一声;页面会亮「Agent 控制中」徽标,用户按 Esc 随时夺回)
curl -s http://127.0.0.1:<端口>/v1/control -H 'Content-Type: application/json' \
  -d '{"on":true,"target":"active"}'

# ② 快照:拿带编号的元素清单(idx 引用,别自己猜坐标)
curl -s http://127.0.0.1:<端口>/v1/snapshot -H 'Content-Type: application/json' -d '{}'

# ③ 执行 + 等待 + 观察(capture 让动作后的截图一并回你)
curl -s http://127.0.0.1:<端口>/v1/act -H 'Content-Type: application/json' -d '{
  "rev": <快照的rev>,
  "actions":[{"do":"input","idx":3,"text":"张三"},{"do":"click","idx":7}],
  "wait":{"until":["urlChange","newTab","consoleError"],"timeoutMs":8000},
  "capture":"visible"}'

# ④ 用完交还
curl -s http://127.0.0.1:<端口>/v1/control -H 'Content-Type: application/json' -d '{"on":false}'
```

动作库:`click / input / select{value} / keys{keys:"Enter"} / hover /
scroll{to:"bottom"|"top"|y|idx} / clickAt{x,y} / navigate{url} / back`。
返回 `after`:`url` 变了没、`tabEvents`(新标签/跳转,新标签会被自动跟进接管)、
`consoleErrors`(点出 bug 就在这里看到)、`changed`(哪些等待条件命中)、
`capture.paths`(动作后的截图,读它确认"点了之后的样子")。

**操作礼仪(必须遵守)**:
- `STALE_SNAPSHOT` → 页面变了,**重新 snapshot 再用新编号**,绝不沿用旧 idx;
- result 里出现 `danger:"支付"` 之类标记 → **先问用户再 confirm 执行**(默认只标记
  不拦截,拦截与否由用户设置);
- snapshot `captcha:true` → 验证码交给人,别绕;
- `SESSION_EXPIRED / STEPS_LIMIT / NOT_CONTROLLING` → 按 message 处理,不要狂重试;
- 银行/反爬严格站点可能识别程序点击(isTrusted),失败两次就报告用户改人工;
- 每步动作后真看一眼 capture 再决定下一步——这就是"眼睛+手"的意义。

## 边界与礼仪(截图)

- 整页模式期间用户页面会被"放大重排"一下,属正常,别连续连发;一次截图几十秒内保持耐心;
- 截图落在用户本机 `~/clipshot-out/`,不会外发;不要尝试关掉/重启桥进程;
- 无限滚动页只会截到已加载部分(notes 会说明),不要盲目重试。
