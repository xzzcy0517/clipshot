# P016 · 整页捕获自动隐藏滚动容器外的页面 chrome(页头/侧栏)

| 状态 | **已实现,待用户实测**(v0.10.6,2026-09-23) |
|---|---|
| 提案日期 | 2026-09-23 |
| 前置 | P008(段间锚点)、P015(手动预热模式);CDP 笔记样本 2(scrollerTop=64) |
| 目标 | 飞书类内部滚动容器页的页头/侧栏不再进入整页截图,根除「每段顶部重复一条页头」 |

## 1. 现象与实测依据

用户实测(2026-09-23,飞书 wiki 文档页):

- 页头 `<div class="navigation-bar … navigation-bar-suite-header-v2" style="z-index:89; height:64px">`
  **一直固定显示在最上方,现有「隐藏固定元素」消除不掉**;手动从 HTML 删除后再截,
  中段重复消失;
- 该元素同时「遮挡翻页」——占用每段视口顶部 64px。

## 2. 根因

1. 该页头 inline style 无 position,是**普通流内元素**:飞书布局为
   「页头(64px) + 内部滚动容器」上下排列,document 不滚动、容器滚动。
   `scanAndHide` 只抓 `position: fixed/sticky`,自然漏掉(诊断样本 2 的
   `scrollerTop: 64` 正是它的高度,互证);
2. 捕获时仿真视口 = 页头 64px + 容器内容,**每段顶部都带上页头** → 段间重复;
   且容器实高比视口少 64px,段起点推进口径与实际可见内容错位。

## 3. 方案

通用机制,不写死站点选择器(飞书 class 名随版本变):

- content 新增 `hideOutOfScrollerChrome()`:内部滚动容器页(`findScroller` 判
  internal)时,从容器沿祖先链向上,把每一层**不含容器的兄弟子树**全部
  `display:none`(存进与 fixed/sticky 相同的 hiddenList,RESTORE_FIXED 一并恢复);
- 挂进 `HIDE_FIXED` 新增参数 `fullPage`:仅整页捕获(runFull 两轮 +
  runSegmented 强制轮)传 true;**元素/框选不传**——display:none 会回流,
  已测得的 rect 会失效;
- 隐藏后容器顶到 0:整幅路径 capH 公式 `scrollerH + scrollerTop + 16` 自动
  退化为 `scrollerH + 16`(v0.7.4 的 scrollerTop 补偿在 hideFixed=off 时仍兜底);
- 隐藏后容器占满仿真视口,分段「视口高=段高」口径重新成立,段缝连续;
- notes 明示「已隐藏滚动容器外的页面元素 N 个(页头/侧栏等)」。

幂等:`hiddenSeen` 去重,第二轮复检无成本;非 internal 页返回 0 无副作用。

## 4. 边界与风险

- 容器若是 `calc(100vh - 64px)` 这类**写死偏移**的高度(非 flex 自适应),
  隐藏页头后容器不会长高 → 整幅路径会触发既有 FIXED_CONTAINER 明确报错
  (飞书为 flex 布局,用户实测删除页头后容器自动占满,不在此列);
- 隐藏期间用户看到页头消失,截完自动恢复(与 fixed 隐藏同生命周期);
- 用户确需保留页头时:关闭「隐藏固定元素」选项即可回到 v0.7.4 行为
  (页头出现一次在整幅图顶部;分段路径仍强制隐藏,与 fixed 同纪律)。

## 5. 改动面

| 文件 | 动作 |
|---|---|
| `content/content.js` | `hideOutOfScrollerChrome()`;`hideFixed(fullPage)`;HIDE_FIXED 带参 |
| `background/pipeline.js` | `hideFixedRound(job, fullPage)`;runFull 两轮 + runSegmented 传 true;chrome 注记 |
| `common/messages.js` | HIDE_FIXED 协议注释;EXT_VER bump |
| `popup/popup.html`、`options/options.html` | hideFixed 选项文案 |
| 文档 | 本提案;日志 v0.10.6(patch);CDP 笔记回填;指南补一句 |

## 6. 验收(用户实测)

1. 飞书 wiki 长文档整页截图(自动与手动预热两种模式):页头不再出现,
   中段无重复、段缝连续;
2. 截图过程中页头消失、完成后页面恢复原样;
3. 普通长页(document 滚动)回归:与 v0.10.5 一致,notes 无 chrome 条目;
4. 右键元素截图回归:rect 精确不受回流影响(该路径不启用本机制)。
