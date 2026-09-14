# Agent 接入指南(curl 直连方式;Cursor 首选看另一份)

> **新电脑第一次装 / 只用 Cursor** → 看 [新机器部署指南.md](新机器部署指南.md)(更短)。
> 本文服务两类人:①要在**没有 Cursor 的机器**上用 Agent/脚本直接调截图;
> ②把所有细节(指令格式、返回语义、排错)看全的人。
> v0.5.0 起零配置:**没有 token,端口 8790–8795 自动**。

## 桥从哪来

任选其一(同一时刻只需要一个):

- **打开 Cursor** 即可——MCP 注册过的话它自动拉起桥(推荐,平时就用这个);
- 机器上没有 Cursor 时,终端跑一次(窗口保持开着,它自己会找空闲端口):

```bash
cd ~/你的路径/clipshot && node bridge/relay.mjs
```

浏览器侧只需一次:ClipShot 设置页 →「Agent 桥接」→ 勾选启用。之后扩展会自动
在 8790–8795 里找到桥(桥先起后起都无所谓,双方各自重试)。

## 手动试一把

**健康检查**(不带任何密钥):

```bash
curl -s http://127.0.0.1:8790/v1/health
```

`"extension":{"connected":true` 即链路通。截图(注意 **Content-Type 必须是
application/json**,curl 的 `-d` 默认头不是它,要显式加):

```bash
curl -s http://127.0.0.1:8790/v1/screenshot \
  -H 'Content-Type: application/json' \
  -d '{"mode":"full"}'
```

返回里的 `"image":{"path":"/Users/…/clipshot-out/ClipShot_…_full.png", …}`,
双击 path 看整页长图。若 `"parts">1`(极罕见,超 ~40000px 才出现):`paths`
里是多个分段文件,按序即整页。

其它玩法:

```bash
# 只截当前屏
… -d '{"mode":"visible"}'
# 按 CSS 选择器截元素(在开发者工具里右键元素 → Copy selector)
… -d '{"mode":"element","selector":"#article-body"}'
# 按网址指定标签页;超长页用 JPEG;不动固定元素
… -d '{"mode":"full","target":{"urlContains":"feishu.cn"},"format":"jpeg","hideFixed":true}'
# 列出可截的标签页
curl -s http://127.0.0.1:8790/v1/tabs
```

## 让 Agent 自己来调(整段发给它一次)

```text
【ClipShot 截图桥 接入说明——保存到你的项目记忆里】
本机运行着截图服务(ClipShot Agent 桥,无密钥):
- 端口探测:依次 curl -s http://127.0.0.1:8790/v1/health 直到 8795,连上的即桥
- 截图:  curl -s http://127.0.0.1:<端口>/v1/screenshot \
           -H 'Content-Type: application/json' \
           -d '{"mode":"full"}'
- mode:full 整页长图(默认,自动滚动加载)/ visible 当前屏 / element 需 selector
- target:"active"(默认)| tabId 数字 | {"urlContains":"关键字"}
- 响应 image.path 是图片文件路径,读它即可看到页面内容;parts>1 时读 paths 列表
- 错误转述:message 已是中文;BUSY=等 10 秒重试,EXTENSION_OFFLINE=让用户打开
  Chrome 并在 ClipShot 设置页勾选「启用 Agent 桥接」
- 我说"看浏览器页面"时优先用 full 模式,它能拍到滚动区域外的内容
```

支持 **Agent Skill** 的宿主(Claude Code/Claude)有更省事的路:把仓库
`skills/clipshot-screenshot/` 目录复制进它的 skills 目录,skill 里已经写好上面全部内容。

## 指令参考(权威合同在 docs/proposals/P001 §5)

| 端点 | 方法 | 说明 |
|---|---|---|
| `/v1/health` | GET | 桥/扩展/版本状态 |
| `/v1/tabs` | GET | 可截标签页列表 |
| `/v1/screenshot` | POST JSON | mode/selector/target/format/hideFixed;返回 image.path(s) |
| `/v1/control` | POST JSON | P005 接管开关 on/target/ttlSec(徽标+Esc 夺回) |
| `/v1/snapshot` | POST JSON | 带编号交互元素清单 + rev(结构变动即 STALE) |
| `/v1/act` | POST JSON | actions(8 种)+wait(urlChange/newTab/consoleError)+capture → after 观察包 |
| `/v1/events` | GET | 接管期标签/控制台增量事件 |

## 排错速查

| 你看到 | 一步解决 |
|---|---|
| `node: command not found` | 装 Node ≥18(https://nodejs.org/zh-cn) |
| 手动 relay 报端口占用 | **正常**:8790 上多半已是 Cursor 自动拉起的桥——什么都不用关,curl 照常打 8790;确要自己起会报错也无妨,桥已经有一个了 |
| `connection refused` 全端口 | 桥没跑:开 Cursor,或回上面「桥从哪来」手动起一个 |
| health 里 `connected:false` | 设置页没勾启用 / 扩展在休眠:点一下工具栏 ClipShot 图标,等 30 秒 |
| `415 JSON_REQUIRED` | 忘了加 `-H 'Content-Type: application/json'` |
| `BUSY` | 上一张还在截,等 10 秒 |
| `DEVTOOLS_CONFLICT` | 目标页开着 F12,关掉(或换 visible 模式) |
| 「页面脚本未就绪」 | 刷新那个标签页 |
| 超长文档中段重复/结尾缺 | 扩展旧了:`git pull` + `chrome://extensions` 刷新 ⟳ |

## 安全模型(v0.5.0 起,替代旧 token 方案)

- 桥只绑 `127.0.0.1`,局域网/互联网都进不来;
- 浏览器里的恶意网页无法驱动它:POST 强制 `application/json` → 跨源必触发
  CORS 预检,而 relay 永不返回 CORS 头 → 预检失败,请求根本到不了;
- 本机其它进程不设防——能运行你代码的机器上,密钥也无意义;
- 总开关=扩展设置页的「启用 Agent 桥接」勾选,不勾时扩展物理不连接。

## 进阶(可跳过)

- **开机自启桥(无 Cursor 的机器)**:`~/Library/LaunchAgents/com.clipshot.relay.plist`
  模板见 git 历史版本文档/或用 launchd 自行配置;`KeepAlive` 拉起 `/usr/local/bin/node
  <仓库>/bridge/relay.mjs`(路径以 `which node` 为准)。只用 Cursor 的机器**不需要**。
- **Playwright 自启浏览器要用截图**:launch 参数加
  `--disable-extensions-except=<仓库绝对路径> --load-extension=<仓库绝对路径>`,
  并在该浏览器里同样勾选启用。整页模式与 Playwright 的 CDP 会互相独占调试器,
  冲突时收到 `DEVTOOLS_CONFLICT`,让 Agent 先释放页面或改用 visible。
