'use strict';
/** 设置默认值与读写包装(chrome.storage.sync)。依赖 common/messages.js 先加载。 */
globalThis.ClipShot = globalThis.ClipShot || {};
(function (CS) {
  CS.SETTINGS_DEFAULTS = {
    format: 'png',            // 'png' | 'jpeg'
    jpegQuality: 85,          // 60–100
    hideFixed: true,          // 截图时隐藏 fixed/sticky 元素
    scrollSpeed: 'standard',  // 'fast'(0.9) | 'standard'(0.75) | 'slow'(0.6) 视口步长比例
    autoJpegForLong: true,    // 文档高度超过 autoJpegMinCssH 时自动改用 JPEG
    autoJpegMinCssH: 12000,
    splitThreshold: 16000,    // 超过此 CSS 高度改用分段捕获
    chunkHeight: 4000,        // 分段每段 CSS 高度
    maxScrollPx: 30000        // 自动滚动扫页的最大行程(无限流保护)
  };

  CS.SCROLL_SPEED_RATIO = { fast: 0.9, standard: 0.75, slow: 0.6 };

  CS.loadSettings = async function () {
    const stored = await chrome.storage.sync.get(null);
    const out = Object.assign({}, CS.SETTINGS_DEFAULTS);
    for (const k of Object.keys(CS.SETTINGS_DEFAULTS)) {
      if (Object.prototype.hasOwnProperty.call(stored, k)) out[k] = stored[k];
    }
    return out;
  };

  CS.saveSettings = async function (patch) {
    await chrome.storage.sync.set(patch);
  };
})(globalThis.ClipShot);
