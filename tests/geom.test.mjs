import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(0, eval)(readFileSync(join(ROOT, 'common/geom.js'), 'utf8'));
const CS = globalThis.ClipShot;
const { geom, util } = CS;

/* ---------------- normalizeMetrics ---------------- */
// Chrome 126 实测形态(有变动时用 options「诊断」dump 真机 JSON 回填此用例)
const modern = {
  layoutViewport: { pageX: 0, pageY: 120, clientWidth: 1280, clientHeight: 720 },
  visualViewport: { offsetX: 0, offsetY: 120, width: 1280, height: 600, pageScaleFactor: 1, clientWidth: 1280, clientHeight: 600, scrollX: 0, scrollY: 120 },
  contentSize: { x: 0, y: 120, width: 1280, height: 6000 },
  cssLayoutViewport: { pageX: 0, pageY: 120, clientWidth: 1280, clientHeight: 720 },
  cssVisualViewport: { offsetX: 0, offsetY: 120, width: 1280, height: 600, scale: 1, clientWidth: 1280, clientHeight: 600, scrollX: 0, scrollY: 120 },
  cssContentSize: { x: 0, y: 120, width: 1280, height: 6000 }
};
let r = geom.normalizeMetrics(modern);
assert.equal(r.cssW, 1280); assert.equal(r.cssH, 6000);
assert.equal(r.psf, 1); assert.equal(r.scrollY, 120);
assert.equal(r.sizeSource, 'cssContentSize');

// 旧形态:只有 contentSize + visualViewport(pageX/pageY)
const legacy = {
  contentSize: { x: 0, y: 0, width: 1024, height: 2048 },
  visualViewport: { pageX: 30, pageY: 200, pageScaleFactor: 2, clientWidth: 1024, clientHeight: 768 }
};
r = geom.normalizeMetrics(legacy);
assert.equal(r.cssW, 1024); assert.equal(r.cssH, 2048);
assert.equal(r.psf, 2); assert.equal(r.scrollY, 200);
assert.equal(r.sizeSource, 'contentSize');

// 真机样本①:Chrome 152 / macOS / dpr1 / 飞书文档页(用户面板诊断导出,2026-09-11)。
// 要点:cssContentSize 存在;cssVisualViewport 的滚动字段是 pageX/pageY(不是
// scrollX/scrollY),且带新字段 zoom —— 归一化取值顺序在此形态上已验证。
const chrome152 = {
  contentSize: { x: 0, y: 0, width: 1857, height: 934 },
  cssContentSize: { x: 0, y: 0, width: 1857, height: 934 },
  cssLayoutViewport: { clientHeight: 934, clientWidth: 1857, pageX: 0, pageY: 0 },
  cssVisualViewport: { clientHeight: 934, clientWidth: 1857, offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, scale: 1, zoom: 1 },
  layoutViewport: { clientHeight: 934, clientWidth: 1857, pageX: 0, pageY: 0 },
  visualViewport: { clientHeight: 934, clientWidth: 1857, offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, scale: 1, zoom: 1 }
};
r = geom.normalizeMetrics(chrome152);
assert.deepEqual(r, { cssW: 1857, cssH: 934, psf: 1, scrollX: 0, scrollY: 0, sizeSource: 'cssContentSize' });
// 同形态 + 非零 pageY(window 滚动的普通页面在该形态下的预期行为,锁死取值优先级)
r = geom.normalizeMetrics({
  cssContentSize: { width: 1857, height: 5000 },
  cssVisualViewport: { clientWidth: 1857, clientHeight: 934, pageX: 0, pageY: 400, scale: 1, zoom: 1 }
});
assert.equal(r.cssH, 5000);
assert.equal(r.scrollY, 400);

// 真机样本②:Chrome 152 / macOS / dpr1 / 飞书超长虚拟滚动文档(用户面板诊断导出,2026-09-16)。
// 与样本①同形态;要点:document 恒 934,内容在内部容器(scrollerH 17693),
// 含头部偏移后 17773 > MAX_CAPTURE_DIM → 整幅仿真不可用,必走分段(P008 治理对象)。
const chrome152long = {
  contentSize: { x: 0, y: 0, width: 1920, height: 934 },
  cssContentSize: { x: 0, y: 0, width: 1920, height: 934 },
  cssLayoutViewport: { clientHeight: 934, clientWidth: 1920, pageX: 0, pageY: 0 },
  cssVisualViewport: { clientHeight: 934, clientWidth: 1920, offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, scale: 1, zoom: 1 },
  layoutViewport: { clientHeight: 934, clientWidth: 1920, pageX: 0, pageY: 0 },
  visualViewport: { clientHeight: 934, clientWidth: 1920, offsetX: 0, offsetY: 0, pageX: 0, pageY: 0, scale: 1, zoom: 1 }
};
r = geom.normalizeMetrics(chrome152long);
assert.deepEqual(r, { cssW: 1920, cssH: 934, psf: 1, scrollX: 0, scrollY: 0, sizeSource: 'cssContentSize' });
// 该页的几何处置:17773 = 17693(scrollerH) + 64(scrollerTop) + 16(余量)
assert.equal(geom.pickEmulationScale(1920, 17773, 1, 60 * 1024 * 1024), 0, '超单边上限必须落分段');
assert.equal(geom.pickEmulationScale(1920, 15000, 1, 60 * 1024 * 1024), 1, '上限内仍可整幅');

// 空对象兜底
r = geom.normalizeMetrics({});
assert.equal(r.cssW, 1); assert.equal(r.psf, 1);

/* ---------------- parseImageSize ---------------- */
const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_1x1 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';
let sz = geom.parseImageSize(util.b64Decode(PNG_1x1));
assert.deepEqual(sz, { width: 1, height: 1, mime: 'image/png' });
sz = geom.parseImageSize(util.b64Decode(JPEG_1x1));
assert.ok(sz, 'JPEG 应能解析');
assert.equal(sz.mime, 'image/jpeg');
assert.equal(sz.width, 1); assert.equal(sz.height, 1);
assert.equal(geom.parseImageSize(util.b64Decode('aGVsbG8td29ybGQtaGVyZS0thhhh')), null, '非图片返回 null');

/* ---------------- aspectOk(捕获完整性对账) ---------------- */
// 正常:设备分辨率与 CSS 分辨率都守恒
assert.ok(geom.aspectOk({ width: 2560, height: 40000 }, 1280, 20000));
assert.ok(geom.aspectOk({ width: 1280, height: 20000 }, 1280, 20000));
// 截断(超纹理上限,如 16384)比例失真 → 拒绝
assert.ok(!geom.aspectOk({ width: 1280, height: 16384 }, 1280, 50000), '截断图必须被拒');
assert.ok(!geom.aspectOk({ width: 1280, height: 8192 }, 1280, 20000, 0.5), '半分辨率截断也要拒');
// 小尺寸兜底容差至少 0.01
assert.ok(geom.aspectOk({ width: 37, height: 52 }, 37, 52));
// 空/非法输入
assert.ok(!geom.aspectOk(null, 100, 100));
assert.ok(!geom.aspectOk({ width: 0, height: 10 }, 100, 100));
assert.ok(!geom.aspectOk({ width: 10, height: 10 }, 100, 0));

/* ---------------- clampClip ---------------- */
assert.deepEqual(geom.clampClip({ x: -5, y: 100, width: 10, height: 20 }, 100, 200), { x: 0, y: 100, width: 10, height: 20 });
assert.deepEqual(geom.clampClip({ x: 95, y: 195, width: 20, height: 20 }, 100, 200), { x: 95, y: 195, width: 5, height: 5 });
// Math.round 对 .5 向 +∞ 取整:30.5→31,40.5→41
assert.deepEqual(geom.clampClip({ x: 10.4, y: 20.6, width: 30.5, height: 40.5 }, 1000, 1000), { x: 10, y: 21, width: 31, height: 41 });

/* ---------------- P003:pickEmulationScale / clampTotal / planVolumes ---------------- */
const AREA = 60 * 1024 * 1024;
assert.equal(geom.MAX_CAPTURE_DIM, 16000);
// v0.4.4:禁止分数缩放(0.9×+超大视口实测栅格撕裂)→ 原生放得下才单张,否则分段
assert.equal(geom.pickEmulationScale(1920, 17756, 1, AREA), 0, '单边 17756>16000 → 0 → 分段');
assert.equal(geom.pickEmulationScale(1857, 17756, 2, AREA), 0);
assert.equal(geom.pickEmulationScale(800, 15900, 2, AREA), 0, '15900×2=31800 超单边 → 分段');
assert.equal(geom.pickEmulationScale(1280, 6000, 2, AREA), 2, '原生 2× 放得下 → 单张');
assert.equal(geom.pickEmulationScale(1920, 15000, 1, AREA), 1, '单边/面积都在限内 → 原生 1×');
assert.equal(geom.pickEmulationScale(1280, 90000, 2, AREA), 0, '极端超长 → 分段');
assert.equal(geom.pickEmulationScale(16000, 16000, 1, AREA), 0, '单边达标但面积 256M 超限 → 分段');
// 自定义 maxDim
assert.equal(geom.pickEmulationScale(100, 5000, 1, AREA, 4000), 0);
assert.equal(geom.pickEmulationScale(100, 3000, 1, AREA, 4000), 1);
// clampTotal
assert.deepEqual(geom.clampTotal(17756, 60000), { h: 17756, truncated: false, dropped: 0 });
assert.deepEqual(geom.clampTotal(85000, 60000), { h: 60000, truncated: true, dropped: 25000 });
// planVolumes:5 段×8000(+尾段 5000),卷上限 30000 → 3 段一卷 + 剩余一卷
const vols = geom.planVolumes([8000, 8000, 8000, 8000, 8000, 5000], 30000);
assert.deepEqual(vols, [
  { from: 0, count: 3, height: 24000 },
  { from: 3, count: 3, height: 21000 }
]);
assert.equal(vols[0].height <= 30000, true);
assert.equal(vols.reduce((n, v) => n + v.count, 0), 6, '所有段必须被装箱,不丢段');
let cursor = 0;
for (const v of vols) { assert.equal(v.from, cursor); cursor += v.count; }
// 单段超限:自成一卷不丢数据
const v2 = geom.planVolumes([40000, 1000], 30000);
assert.equal(v2.length, 2); assert.equal(v2[0].height, 40000); assert.equal(v2[1].height, 1000);

/* ---------------- splitRanges ---------------- */
assert.deepEqual(geom.splitRanges(9500, 4000), [[0, 4000], [4000, 8000], [8000, 9500]]);
assert.deepEqual(geom.splitRanges(8000, 4000), [[0, 4000], [4000, 8000]]);
assert.deepEqual(geom.splitRanges(0, 4000), [[0, 0]]);

/* ---------------- b64 往返 ---------------- */
const bytes = new Uint8Array(70000).map((_, i) => i % 256);
assert.deepEqual(Array.from(util.b64Decode(util.b64Encode(bytes))), Array.from(bytes));

console.log('✔ geom.test.mjs');
