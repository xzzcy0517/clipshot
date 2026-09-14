# Agent 接入指南(给不看代码的你)

> **全新电脑第一次装?先去 [新机器部署指南.md](新机器部署指南.md)**(3 条命令 + 浏览器点 2 下);
> 本文讲接入方式的细节与进阶(本文默认扩展已经装好)。

这份指南的目标:**不写一行代码**,让 Cursor / 豆包工作 / WorkBuddy / Codex 这类
AI Agent 能直接调用 ClipShot 截图(包括你最爱的整页滚动长图),截好的图自动存进
`~/clipshot-out/` 文件夹,Agent 拿到文件路径就能识图。

原理一句话:你的电脑上跑一个很小的「传令官」程序(relay),Agent 对它喊一声,
它转告 Chrome 里的 ClipShot 去截图,截完把文件路径递回来。

---

## 第 0 步:检查电脑有没有 Node(只需一次)

打开「终端」(按 `Cmd+空格`,输入 `terminal` 回车),粘贴这行回车:

```bash
node --version
```

- 显示 `v18` 及以上数字 → 通过,去第 1 步。
- 提示 `command not found` → 去 https://nodejs.org/zh-cn 点 **LTS** 大按钮下载安装,装完重开终端再看一次。

## 第 1 步:启动传令官

终端里运行(路径换成你本地 ClipShot 仓库的位置,下同):

```bash
cd ~/你的路径/clipshot && node bridge/relay.mjs
```

会打印这样一个框:

```
┌─────────────────────────────────────────────────────
│ ClipShot Agent 桥 v0.3.0 已启动
│ 地址        http://127.0.0.1:8790
│ token       9f3a…(一串 32 位十六进制)  ← 复制这一串!
│ 截图输出    /Users/你/clipshot-out
│ 配置存于    /Users/你/.clipshot/relay.json
│ 用法与排错  docs/Agent接入指南.md
└─────────────────────────────────────────────────────
```

**这个终端窗口保持开着**(关了桥就断了)。右下角它会持续显示
`○ 等待扩展连接`,等你做完第 2 步会变成 `● 扩展已连接`。

> token 只在首次启动时生成一次,以后每次都一样;忘了就去 `~/.clipshot/relay.json` 里看。

## 第 2 步:告诉 ClipShot 扩展「token 对得上」

1. 地址栏进 `chrome://extensions` → ClipShot 卡片右下角「详情」→「扩展程序」旁的
   **图标**点开(或在工具栏点 ClipShot 图标 → 面板底部「打开设置页」);
2. 找到「**Agent 桥接**」区:勾选「启用 Agent 桥接」;
3. 把第 1 步打印的 token **原样粘贴**进 token 框(粘贴即自动保存);
4. 看「连接状态」:应显示 **● 已连接 relay**。
   - 显示 ○ 未连接:等 30 秒(桥每 30 秒自动重试),或点一下「刷新」;
   - 提示 token 不匹配:重新复制粘贴一遍。

## 第 3 步:验证通不通(30 秒)

**再开一个新的终端窗口**,粘贴(token 换成你自己的):

```bash
curl -s http://127.0.0.1:8790/v1/health
```

看到 `"extension":{"connected":true` 就全通了。手动截一张试试——
先在 Chrome 里随便打开一个长网页,然后:

```bash
curl -s http://127.0.0.1:8790/v1/screenshot \
  -H 'X-ClipShot-Token: 你的token' \
  -d '{"mode":"full"}'
```

几秒到几十秒后返回一堆信息,里面 `"path":"/Users/…/clipshot-out/ClipShot_xxx_full.png"`
——去这个文件双击打开,就是你的整页长图。**到这里,人肉流程闭环了。**

(极少数超长页会返回 `"parts":N, "paths":[part1, part2…]` ——N 张分段长图,
按序排列即整页;普通文档现在都会走"单张完整"路径,超长页的自动降尺度/分卷
逻辑见设置页「总长上限」「单图上限」。)

其他两种玩法:

```bash
# 只截当前一屏
… -d '{"mode":"visible"}'

# 截某个元素(按网页的 CSS 选择器,开发者工具右键「复制选择器」可得)
… -d '{"mode":"element","selector":"#article-body"}'

# 指定截哪个标签页(按网址包含匹配)/ 用 JPEG 压缩超长页
… -d '{"mode":"full","target":{"urlContains":"feishu.cn"},"format":"jpeg"}'
```

## 第 4 步:让 Agent 自己来调(重点,直接抄)

对会执行终端命令的 Agent(Cursor / 豆包工作 / Codex / WorkBuddy / Claude Code…),
把下面**整段**发给它一次,它以后就会自己截图了:

```text
【ClipShot 截图桥 接入说明——保存到你的项目记忆里】
本机运行着一个截图服务(ClipShot Agent 桥):
- 健康检查: curl -s http://127.0.0.1:8790/v1/health
- 截图:     curl -s http://127.0.0.1:8790/v1/screenshot \
              -H 'X-ClipShot-Token: 你的token' \
              -d '{"mode":"full"}'
- mode 可选:full(整页长图,自动滚动加载)/ visible(当前屏)/
  element(需 selector,截指定元素)
- target 可选:"active"(默认当前页)或 {"urlContains":"关键字"} 按网址找标签页
- 返回 JSON 的 image.path 就是 PNG/JPEG 文件路径,用你的识图能力读它即可看到页面内容;
  若 image.parts > 1,图被分为 image.paths 里的多个分段文件(part1…N),按序逐个读取即覆盖整页
- 错误处理:EXTENSION_OFFLINE=用户 Chrome 里桥接没启用/浏览器没开;
  BUSY=上一张还在截,等 10 秒重试;TIMEOUT=页面太大,改 format:"jpeg" 重试
- 截网页给我看之前,默认用 full 模式,它比你自己截图多能拍到滚动区域外的内容。
```

(把 `你的token` 替换成第 1 步那串。)之后你在 Agent 对话里说
「看看我现在浏览器这个页面」「把这个文档整页截下来读一下」,它自己会跑命令。

## MCP 直连(Cursor / Claude Code / Codex 推荐,免终端免 curl)

上面第 1~4 步的 curl 方式对所有 Agent 都有效。如果你的 Agent 支持 **MCP**
(Cursor、Claude Code、Codex CLI 都支持),可以用更丝滑的直连方式:
**不用再手动开 relay 终端窗口**——Agent 启动时会自动把桥拉起来,你在对话里
直接说「把当前页面整页截下来看看」,它就自己调 ClipShot 截图并读到文件路径。

### 一键安装

终端运行(路径换成你的仓库位置):

```bash
cd ~/你的路径/clipshot && node bridge/mcp.mjs --install
```

它会自动:
- **Claude Code**:执行 `claude mcp add clipshot …`(已装过会自动覆盖,幂等);
- **Cursor**:合并写入 `~/.cursor/mcp.json`(保留你已有的其它 MCP 服务器,
  改前自动备份为 `.bak`);
- **Codex / 其他产品**:打印现成配置片段(绝对路径都填好了),复制粘贴即可;
- 最后自检一遍,打印「✔ 安装完成」。

装完**重启你的 Agent**,对话里说一句「用 clipshot 查一下桥状态」或直接
「把当前浏览器页面整页截图」即可。截图文件照旧落在 `~/clipshot-out/`。

### 它和 curl 方式的关系

- 两者**并存不冲突**:MCP 进程内嵌了同一个 relay;如果你手动开着 P1 的 relay,
  MCP 进程会自动降级成客户端连它(端口不会打架)。
- 扩展侧**零变化**:还是设置页那一个「Agent 桥接」开关和 token,装过 P1 就不用再动。
- 不想用了怎么卸载:Claude Code 执行 `claude mcp remove clipshot`;
  Cursor 删除 `~/.cursor/mcp.json` 里的 `clipshot` 条目(或用 `.bak` 备份还原)。

### MCP 排错

| 现象 | 一步解决 |
|---|---|
| Agent 里看不到 clipshot 工具 | 重启 Agent;确认安装时打印过 ✔;Cursor 看设置→MCP 列表里 clipshot 是否绿色 |
| 工具报「扩展未连接」 | 和第 3 步一样:Chrome 开着、设置页桥接已启用、token 一致 |
| 想看桥的日志 | Claude Code:`claude mcp list` 看状态;Cursor:MCP 面板点开看 stderr 日志 |
| 端口 8790 被别的东西占了 | `node bridge/mcp.mjs --install --port 8791`(手动配置的产品记得 args 里加 `--port 8791`) |

## 进阶(可跳过)

**A. 开机自动启动 relay(Mac)**:新建文件 `~/Library/LaunchAgents/com.clipshot.relay.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.clipshot.relay</string>
  <key>ProgramArguments</key><array>
    <string>/usr/local/bin/node</string>   <!-- 用 `which node` 查出实际路径替换 -->
    <string>/你的路径/clipshot/bridge/relay.mjs</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/clipshot-relay.log</string>
  <key>StandardErrorPath</key><string>/tmp/clipshot-relay.log</string>
</dict></plist>
```

终端执行:`launchctl load ~/Library/LaunchAgents/com.clipshot.relay.plist`
(卸载:`launchctl unload …` 同一路径)。之后 relay 常驻后台,日志在 `/tmp/clipshot-relay.log`。

**B. Agent 用 Playwright/CDP 自启浏览器时**:那个浏览器没有你的扩展,启动参数加上:

```js
chromium.launchPersistentContext('', {
  headless: false,
  args: ['--disable-extensions-except=/你的路径/clipshot', '--load-extension=/你的路径/clipshot']
});
```

并且要在那个浏览器里再做一次第 2 步的启用+token。
⚠️ 冲突提醒:Playwright 自己正用 CDP 调试某个页面时,ClipShot 的**整页模式**会报
`DEVTOOLS_CONFLICT`(一个页面只能有一个调试者);`visible` 模式不受影响。
让 Agent 先 `page` 释放或换用 visible。

**C. MCP 直连**:已上线,见上一节「MCP 直连」。

## 排错速查

| 你看到 | 意思 | 一步解决 |
|---|---|---|
| `node: command not found` | 没装 Node | 第 0 步装 Node |
| relay 启动报 `EADDRINUSE` | 8790 上已有一个桥 | 先 `lsof -nP -iTCP:8790 -sTCP:LISTEN` 看占用者:是 `mcp.mjs` = **Cursor 自动拉起的桥,正常在跑,不用管也别杀**(用 MCP 接入时本就不需要手动跑 relay.mjs,curl 也直接打这个桥);是别的终端里的手动 relay → 回那窗口 Ctrl+C 或 `lsof -ti:8790 \| xargs kill`;确要并存 → `--port 8791`(扩展设置页同步改) |
| health 里 `connected:false` | 扩展侧没连上 | 设置页确认已勾选启用 + token 完全一致;点 ClipShot 图标唤醒扩展;等 30 秒 |
| curl 报 `connection refused` | relay 没在跑 | 回第 1 步启动它 |
| 401 `BAD_TOKEN` | curl 里的 token 不对 | 从 `~/.clipshot/relay.json` 重抄 |
| `BUSY` | 上一张还在截 | 等 10 秒重试 |
| `DEVTOOLS_CONFLICT` | 该页被调试器/Playwright 占用 | 关掉 DevTools 或换 visible 模式 |
| `EXTENSION_DEAD:请刷新页面` 类提示 | 页面是扩展安装前就开着的 | 刷新那个网页再截 |
| 截出来的图很长但分辨率低 | 走了 1/2 降分辨率或分段 | 正常;介意就在设置页调大分段阈值/用 PNG |
| 504 `TIMEOUT` | 页面太大太慢 | 加 `"format":"jpeg"`,或分段阈值调小 |

## 安全须知(一句话版)

桥只监听 `127.0.0.1`(本机),不会暴露到局域网/互联网;所有指令(health 除外)
必须带 token,没有 token 的本机其他程序也指挥不动你的浏览器。
不要把你的 token 发给任何人或写进公开仓库。
