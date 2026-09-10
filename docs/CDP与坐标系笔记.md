# CDP 与坐标系笔记

本页记录 `Page.getLayoutMetrics` / `Page.captureScreenshot` 的实测语义与踩坑依据。
**原则:以真机 dump 为准,不凭文档猜**——字段历史上变动多次,Chrome 版本间有漂移。

## 已核实的外部事实

| 事实 | 来源 |
|---|---|
| Chrome 116+ 活跃 debugger 会话让 MV3 SW 保活 | developer.chrome.com SW lifecycle 文档 |
| `fromSurface:false` 时 `clip` 与 `captureBeyondViewport` 被忽略 | Chromium issue 40760789 |
| `captureBeyondViewport` 截图会使视口瞬时缩放到全页尺寸,影响 sticky/fixed 渲染 | Chromium issue 40256133(本项目的对策:隐藏 fixed + 分段强制隐藏) |
| `clip.scale` 是对输出图的降/升采样,与 dpr 相乘 | SO 76908352;clip 坐标为文档 CSS px |
| clip 用错 viewport 坐标 vs document 坐标是常见事故 | chrome-devtools-mcp issue #2684 |

## getLayoutMetrics 字段矩阵(归一化目标)

| 需要的量 | 依次尝试 | 备注 |
|---|---|---|
| 文档 CSS 尺寸 | `cssContentSize` → `contentSize` | 旧版只有后者;新版两者并存 |
| 页面缩放 psf | `cssVisualViewport.scale` → `visualViewport.pageScaleFactor` → 1 | |
| 滚动偏移 | `vv.scrollX/Y` → `vv.pageX/pageY` → `vv.pageScrollX/Y` | 三朝字段名 |

dpr **不**取自 CDP:取 content 的 `window.devicePixelRatio`(即 surface 输出像素/CSS px 倍数),
再用 `parseImageSize` 解出真实像素宽高交叉验证。

## 真机 dump 样本(待回填)

> 本地 Chrome 打开对应页面 → 设置页「导出当前页诊断信息」→ 把 JSON 粘在这里,
> 同步补进 `tests/geom.test.mjs`。**截图错位/尺寸类 bug 先收这个。**

### 样本 1:clip-probe.html @ Chrome ____ / 缩放 100% / dpr ____
```json
{ "待回填": true }
```

### 样本 2:同一页 @ 系统缩放 125%(dpr 1.25)
```json
{ "待回填": true }
```

## 整页捕获行为要点

- **v0.2.0 最终结论:`captureBeyondViewport` 不可信**(v0.1.0 无 clip、v0.1.1 带显式
  clip 两轮实测都**只渲染第一屏、其余留白且画布尺寸正确**——绝对尺寸与比例对账
  都防不住这种"尺寸对、内容空"的失败)。主路径改为
  **`Emulation.setDeviceMetricsOverride` 放大/定位视口 + 普通视口截图**,与 DevTools
  「Capture full size screenshot」同款机制;它同时天然触发一次 IntersectionObserver
  批量懒加载(capture 前 waitForIdle 等它落地)。
- 仿真视口的面积纪律:单边/面积过大时 Chrome 拒绝或渲染空白,本项目限制
  cssW×dpr×H×dpr ≤ 60M 设备像素,超出走「分段仿真」(每段视口=chunk 高)。
- 副作用:视口仿真期间页面按放大视口重排(如 100vh 元素会变高),fixed 元素会
  粘在巨大视口顶部——隐藏固定元素选项在此模式下尤为重要;结束必须
  `clearDeviceMetricsOverride`(runFull finally 有双保险)。
- **完整性校验用宽高比对账**:Chrome 渲染存在 ~16384px 量级的硬上限,超限截断的图
  比例必失真;`geom.aspectOk` 利用「比例在 CSS px / 设备 px 两种解释下都守恒」这一点,
  不依赖对 clip 单位语义的猜测。截断/空白类 bug 的兜底判定都走它。
- clip 的 dpr 语义仍待真机标定(见上方待回填样本):若返回图宽 ≈ cssW(而非 cssW×dpr),
  说明该版本 clip+scale:1 输出 CSS 分辨率——内容完整,仅分辨率降低。
- 不加 clip 的旧语义(整文档输出)已不再使用;回顶主要为消除 sticky 的视觉状态。
- fixed 元素在超视口捕获中会绘制在文档顶部一份(40256133 的副作用)→ 这是
  「隐藏固定元素」默认开启、分段模式强制开启的原因。
- 尺寸上限:单幅约在 16000+ CSS px 高度级别出现失败/空白 → `splitThreshold` 默认 16000;
  preview 画布合成上限 32767 单边设备 px → 超出退化为分段列表逐段下载。
- PNG 无 quality 参数;JPEG quality 60–100;剪贴板只收 PNG。

## 框选裁剪的坐标链

```
marquee 矩形(视口 CSS px,框选期间锁定滚动故无换算误差)
  → captureVisibleTab(设备 px 整视口图)
  → sx=round(x·dpr) … 钳制到位图内 → OffscreenCanvas.drawImage 原样裁出(不缩放)
```
