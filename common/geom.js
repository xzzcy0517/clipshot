'use strict';
/**
 * 纯几何/图像函数(无 chrome API 依赖,可被 node 测试直接 eval)。
 * 依赖 common/messages.js 先加载(挂到同一 ClipShot 命名空间)。
 */
globalThis.ClipShot = globalThis.ClipShot || {};
(function (CS) {
  const geom = {};

  function num(v, d) {
    return (typeof v === 'number' && isFinite(v)) ? v : (d || 0);
  }

  /**
   * 归一化 CDP Page.getLayoutMetrics。
   * 历史上字段多次变动(cssContentSize/contentSize、scale/pageScaleFactor、
   * scrollX/pageX 等),这里做防御性读取;真机样本用 options 页「诊断」dump
   * 后回填到 tests/geom.test.mjs,再按样本收紧,不凭文档猜测。
   */
  geom.normalizeMetrics = function (m) {
    m = m || {};
    const src = m.cssContentSize ? 'cssContentSize' : 'contentSize';
    const css = m.cssContentSize || m.contentSize || {};
    const cssW = Math.max(1, num(css.width, 1));
    const cssH = Math.max(1, num(css.height, 1));
    const vv = m.cssVisualViewport || m.visualViewport || {};
    const psf = num(vv.scale != null ? vv.scale : vv.pageScaleFactor, 1) || 1;
    const scrollX = num(vv.scrollX != null ? vv.scrollX : (vv.pageX != null ? vv.pageX : vv.pageScrollX), 0);
    const scrollY = num(vv.scrollY != null ? vv.scrollY : (vv.pageY != null ? vv.pageY : vv.pageScrollY), 0);
    return { cssW, cssH, psf, scrollX, scrollY, sizeSource: src };
  };

  /**
   * 从图片字节解析真实像素尺寸。支持 PNG(SOI/IHDR)与 JPEG(SOF0/2)。
   * 无法识别时返回 null。
   */
  geom.parseImageSize = function (bytes) {
    if (!bytes || bytes.length < 24) return null;
    // PNG: 89 50 4E 47 0D 0A 1A 0A, IHDR 宽高在大端 offset 16/20
    if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
      const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      return { width: dv.getUint32(16), height: dv.getUint32(20), mime: 'image/png' };
    }
    // JPEG: FF D8 后扫描段, SOF marker 0xFFC0..0xFFCF(除 C4/CC)、0xFFE0..0xFFEF 中 DHT/DAC 等跳过
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
      let i = 2;
      while (i + 9 < bytes.length) {
        if (bytes[i] !== 0xFF) { i++; continue; }
        const marker = bytes[i + 1];
        if (marker === 0xFF) { i++; continue; }
        if (marker === 0xD8 || marker === 0x01 || (marker >= 0xD0 && marker <= 0xD7)) { i += 2; continue; }
        const segLen = (bytes[i + 2] << 8) | bytes[i + 3];
        const isSof = (marker >= 0xC0 && marker <= 0xCF) && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
        if (isSof) {
          const h = (bytes[i + 5] << 8) | bytes[i + 6];
          const w = (bytes[i + 7] << 8) | bytes[i + 8];
          return { width: w, height: h, mime: 'image/jpeg' };
        }
        i += 2 + segLen;
      }
      return null;
    }
    return null;
  };

  /**
   * 宽高比对账:捕获结果 sz 与请求区域 w×h(CSS px)的比例是否一致。
   * 截断/超纹理上限的图必然比例失真,而该校验与 clip 按 CSS px 还是设备 px
   * 解释无关(两种情况下比例都守恒),故用它替代绝对尺寸断言。
   */
  geom.aspectOk = function (sz, w, h, tol) {
    if (!sz || !sz.width || !sz.height || w <= 0 || h <= 0) return false;
    const want = h / w;
    const got = sz.height / sz.width;
    return Math.abs(got - want) <= Math.max(0.01, want * (tol != null ? tol : 0.04));
  };

  /** 把一段 clip 矩形钳制到文档范围内;返回四舍五入后的整数值。 */
  geom.clampClip = function (rect, cssW, cssH) {
    let x = Math.max(0, Math.min(Math.round(rect.x || 0), Math.max(0, Math.round(cssW) - 1)));
    let y = Math.max(0, Math.min(Math.round(rect.y || 0), Math.max(0, Math.round(cssH) - 1)));
    let w = Math.max(1, Math.min(Math.round(rect.width || 0), Math.round(cssW) - x));
    let h = Math.max(1, Math.min(Math.round(rect.height || 0), Math.round(cssH) - y));
    return { x, y, width: w, height: h };
  };

  /**
   * Chrome surface 捕获单边物理上限(GPU 纹理 ~16384,留安全边距取 16000)。
   * v0.4.2 实测教训:超限不报错——输出尺寸/宽高比全对,但超限尾部内容
   * 「回绕」成首屏复制,几何校验防不住,必须捕获前限制。
   */
  geom.MAX_CAPTURE_DIM = 16000;

  /**
   * 整幅仿真可用的 deviceScaleFactor(P003 整幅优先):
   * 需同时满足 面积 (capW*s)×(capH*s) ≤ areaCap、单边 capW*s/capH*s ≤ maxDim;
   * 取满足条件的最大 s,夹在 [1, dpr];连 s=1 都放不下时返回 0,调用方走分段。
   */
  geom.pickEmulationScale = function (capW, capH, dpr, areaCap, maxDim) {
    if (!(capW > 0 && capH > 0 && dpr >= 1 && areaCap > 0)) return 0;
    const dimCap = maxDim > 0 ? maxDim : geom.MAX_CAPTURE_DIM;
    const s = Math.min(
      dpr,
      Math.sqrt(areaCap / (capW * capH)),
      dimCap / capH,
      dimCap / capW
    );
    return s >= 1 ? s : 0;
  };

  /** 总长闸门(P003):超过 maxTotal 截断,返回 {h, truncated, dropped}。 */
  geom.clampTotal = function (h, maxTotal) {
    if (!(maxTotal > 0) || h <= maxTotal) return { h, truncated: false, dropped: 0 };
    return { h: maxTotal, truncated: true, dropped: h - maxTotal };
  };

  /**
   * 分卷装箱(P003):把有序段高数组按累计 ≤cap 切成卷 [{from, count, height}]。
   * 单段即超 cap 时自成一卷(不丢数据,由调用方降级展示)。
   */
  geom.planVolumes = function (heights, cap) {
    const vols = [];
    let cur = null;
    for (let i = 0; i < heights.length; i++) {
      const h = Math.max(0, heights[i] | 0);
      if (!cur || (cur.height + h > cap && cur.height > 0)) {
        cur = { from: i, count: 0, height: 0 };
        vols.push(cur);
      }
      cur.count++;
      cur.height += h;
    }
    return vols;
  };

  /** 把 total 切成不超过 chunkSize 的连续区间 [start,end) 列表。 */
  geom.splitRanges = function (total, chunkSize) {
    const out = [];
    const cs = Math.max(1, Math.floor(chunkSize));
    const t = Math.max(0, Math.floor(total));
    for (let s = 0; s < t; s += cs) {
      out.push([s, Math.min(s + cs, t)]);
    }
    if (out.length === 0) out.push([0, t]);
    return out;
  };

  /* ---------- 小工具(纯函数,Node 16+/浏览器均有 btoa/atob) ---------- */
  const util = {};
  util.b64Encode = function (u8) {
    let bin = '';
    const STEP = 0x8000;
    for (let i = 0; i < u8.length; i += STEP) {
      bin += String.fromCharCode.apply(null, u8.subarray(i, i + STEP));
    }
    return btoa(bin);
  };
  util.b64Decode = function (b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
  };
  util.sleep = function (ms) { return new Promise(r => setTimeout(r, ms)); };

  CS.geom = geom;
  CS.util = util;
})(globalThis.ClipShot);
