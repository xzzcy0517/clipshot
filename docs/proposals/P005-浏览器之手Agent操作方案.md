# P005 · 给浏览器装上「手」:Agent 远程操作方案(快照→动作→观察闭环)

| 状态 | **已实现**(v0.6.0,2026-09-14)· 待用户本地验收(agent-playground + 真实页面) |
|---|---|
| 提案日期 | 2026-09-14 |
| 前置 | P001/P002/P004 已交付:零配置桥(截图/标签页/快照基础)、Cursor MCP 通路已验收 |
| 关联 | `background/bridge.js` `background/pipeline.js` `content/content.js` `bridge/relay.mjs` `bridge/mcp.mjs` `skills/clipshot-screenshot/` |

## 0. 需求还原(用户构想的忠实转写)

> Cursor 发任务 → 插件截图+读页面 → Cursor 决策点哪个按钮 → 插件执行点击 →
> 每次动作后回报「点了之后的样子」(截图/新 tab/重定向/控制台报错)→ Cursor 据此
> 下下一步 → 多步任务全程自动,**不告诉插件具体怎么点**。

## 1. 核心架构判断:一个大脑,一双手

**插件内嵌 LLM 在 v1 中不做,也不该做。** 理由:

1. 决策(点哪)的智能已在宿主(Cursor)——它能看到快照和截图;插件执行「点第 7 项」
   是确定性 DOM 代码,不需要第二次思考;
2. 双模型 = 每步两次推理延迟 + 两份 token 成本 + 跨模型排障(错了说不清是谁的判断);
3. API key 放扩展(同步盘/打包物)是长期安全隐患;
4. 「不教插件怎么点」的正确实现是**等待条件 + 复合动作**(§4),插件照方抓药,
   智能始终在 Cursor。

内嵌模型(DeepSeek 等)作为**可选独立模块**列 §8(P3-c),服务「没开 Cursor 时插件
自己也能干点小事」的场景,按需再立项。

## 2. 协议总览(扩展 v0.5.0 桥之上新增,零配置沿用)

```
POST /v1/control   {on:true, target?, ttlSec?}   → 开启/关闭接管(返回 sessionId)
POST /v1/snapshot  {}                           → 页面快照(§3)
POST /v1/act       {actions:[…], wait?, capture?}→ 执行动作组+等待+观察(§4)【本方案核心】
GET  /v1/events    {sinceMs?}                    → 增量事件流(标签页/导航/控制台)
GET  /v1/health | /v1/tabs | /v1/screenshot       (已有,不变)
```

全部端点要求 `control.on`(除 health/tabs),即**先声明接管才能动手**。

## 3. 快照(/v1/snapshot):给模型看的页面,不是给人看的 HTML

- `page`:url/title/viewport/scroll 位置;
- `elements`:可交互元素**带编号清单**——`{idx, role, text, name, rectVp, sel, disabled}`;
  采集规则:`a/button/input/select/textarea/[role]/[onclick]/[tabindex]/label`,
  文本取 innerText|aria-label|placeholder|title(截 60 字),viewport 内全量 +
  视口外最多 40 项(标 `offscreen`),上限 160 项防 token 爆炸;
  识别到验证码控件(recaptcha/hcaptcha iframe)时置 `captcha:true` 供宿主绕人;
- `revision`:快照版本号;act 引用过期 revision → 返回 `STALE_SNAPSHOT`+最新快照
  (防“页面变了还按旧坐标点”——这是很多自动化翻车的第一原因);
- 可选 `annotate:true`:把编号画在页面上截图回传(Set-of-Marks 视觉派用法,
  适合视觉模型直接“点 27 号”);v1 默认文字快照即可。

## 4. 动作 + 等待 + 观察(/v1/act):一次调用完成「点→等→看」

```jsonc
POST /v1/act
{ "actions":[
    {"do":"click","idx":7},                       // 或 "sel":"#agree"
    {"do":"input","idx":12,"text":"张三"},        // React/Vue 受控组件兼容写法
    {"do":"select","idx":13,"value":"Beijing"},
    {"do":"keys","keys":"Enter"},
    {"do":"scroll","to":"bottom"},                // 或 {y:800}/{idx:20} 滚到元素
    {"do":"navigate","url":"https://…"}, {"do":"back"}
  ],
  "wait": { "until":["renderQuiet","urlChange","newTab","consoleError"],
             "quietMs":500, "timeoutMs":8000 },   // 任一满足即返回;全不满足超时也返回
  "capture": "visible"                             // 可选:顺带回一张截图路径
}
→ {
  "ok":true,
  "results":[{"action":"click","target":"「同意」","applied":true}],
  "after": {                                     // 「点了之后的样子」
    "url":"…","title":"…",
    "tabEvents":[{"type":"created","tabId":91,"url":"…"}],   // 新标签/关闭/跟进
    "consoleErrors":[{"msg":"TypeError…","at":…}],           // 探针缓冲增量
    "changed":["renderQuiet"],                                // 哪些等待条件命中
    "screenshotPath":"~/clipshot-out/…",                       // capture 时
    "snapshotRevision":4
  }
}
```

实现要点:
- 点击=目标元素上派发 `pointerdown/mousedown/pointerup/mouseup/click`(bubbles+
  composed),先 `scrollIntoView`;输入=原生 value setter + `input/change` 事件
  (兼容受控组件);这些不经过 debugger,与 Playwright 类工具**零冲突**;
- `renderQuiet` 复用 `cs/render.stable`(scrollHeight+节点数连续采样);
- **新标签跟进**:命中 `openerTabId==本会话页` 的新 tab → 接管会话自动迁移到它并
  在 `tabEvents` 里声明(follow 可关);
- 事件缓冲:接管期间 content 探针(MAIN world 注 console.error/onerror/
  unhandledrejection)+ SW 的 tabs.onCreated/onRemoved/onUpdated 环形缓冲(200 条),
  `/v1/events` 增量拉。

## 5. 安全设计(按 §9 用户决策落地,默认偏「松」但底线不松)

1. **接管显式化(底线,不可关)**:设置页「启用 Agent 桥接」总开关 + 逐会话
   `control(on)`;接管中页面右上角常亮徽标「🤖 Agent 控制中 · Esc 交还」,
   **Esc 夺回硬底线**;`ttlSec` 默认 300s(设置页 30–1800 可调),每次 act 续期,
   超时自动释放并记 `control-off` 事件;
2. **危险动作:默认标记不拦截**(dangerMode=mark):目标文本/类名命中
   `支付|付款|转账|删除|提现|解绑|退出登录|delete…` 或 `input[type=password]`
   → result 里带 `danger` 字段,由宿主 Agent 的礼仪规范(skill/MCP 工具描述)
   强制「先问用户再 confirm」;设置页可切 `block` 恢复硬拦截(CONFIRM_REQUIRED);
3. **域名黑名单**:设置页,默认空(自用信任),命中域 control 直接拒绝;
4. **步数与频率**:每会话 act 上限 60 步(5–500 可调)、最短间隔 400ms,防打转;
5. 沿用既有防线:127.0.0.1 + JSON 预检;「启用 Agent 桥接」不勾,整个面物理不存在。

## 6. 宿主侧接入(MCP/skill 同步升级)

- 新增 MCP 工具:`clipshot_control(on,target)`、`clipshot_snapshot`、
  `clipshot_act(actions,wait,capture)`;`skills/clipshot-screenshot/SKILL.md`
  扩为「截图 + 操作」,写清接管礼仪(先 control 后 act、STALE 就重拍快照、
  CONFIRM_REQUIRED 必须问人、captcha 交给人);
- Cursor 里最终体验:一句「帮我把这个报销单填了并提交」,它自己快照→点→看→再点,
  全程页面右上角有徽标,你随时 Esc 夺权。

## 7. 分阶段与验收

- **P3-a 双手核心**(本提案 §2–§6):control/snapshot/act/events + 安全全套 +
  新标签跟进。夹具 `tests/fixtures/agent-playground.html`(表单+受控输入+
  延迟跳转按钮+新开 tab 按钮+会 throw 的按钮+懒加载区);
  验收:对 Cursor 说「去 playground 填表提交,遇到弹窗点确认,新开的 tab 也要报
  出地址」,它多步走完且 `consoleErrors` 里能看到故意抛的错;银行域/支付按钮被
  CONFIRM_REQUIRED 拦住;Esc 交还立即生效。
- **P3-b 增强**:annotate 视觉快照、拖拽/文件上传动作、跨标签并行观察、act 失败
  自动重拍快照的 STALE 自愈、(可选)接管操作录屏成 GIF 附在 events。
- **P3-c 内嵌模型(独立提案再议)**:面板自带 DeepSeek 小助手,不依赖宿主;
  届时单独设计 key 存储与成本。

## 8. 已知限制(写在前头)

- `isTrusted=false`:严格反自动化站点(银行/抢票)能识别合成事件,此类场景别用;
  验证码一律交给人;
- iframe 内元素仍是盲区(沿用全局限制);
- 复杂 canvas 应用(在线设计稿类)snapshot 基本为空——那类站点的“手”得走像素点击
  (`{"do":"clickAt","x":900,"y":420}`,P3-b 视需求加);
- 速度:每步≈快照(1-3k token)+模型思考+act,重仪式流程请耐心。

## 9. 已确认的决策(2026-09-14 用户拍板)

1. 单大脑:v1 不内嵌 LLM(DeepSeek 独立模块留待以后)。
2. 新标签**自动跟进**接管(默认开,可在设置页关)。
3. 安全「更松」:dangerMode=**mark**(危险动作标记不拦截,拦截为可选);
   域名黑名单默认空;ttl 300s;徽标 + Esc 夺回保留为硬底线。
4. P3-a 完整闭环一次交付(本次);`clickAt` 像素点击已一并纳入。

## 10. 原开放问题

1. 认同「v1 不内嵌 LLM,大脑=Cursor」吗?(§1)
2. 安全默认值:危险词表 + 域名黑名单(空)+ ttl 120s + 40 步/会话——松紧如何?
3. 新标签**自动跟进**(接管迁移到新 tab)默认开还是默认关(只报告不接管)?
4. 交付节奏:P3-a 一次做完(推荐,协议闭环切不开),还是先只给 snapshot+act 最小版?
5. `clickAt 像素点击` 放 P3-a 还是 P3-b?
