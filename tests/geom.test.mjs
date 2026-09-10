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

/* ---------------- clampClip ---------------- */
assert.deepEqual(geom.clampClip({ x: -5, y: 100, width: 10, height: 20 }, 100, 200), { x: 0, y: 100, width: 10, height: 20 });
assert.deepEqual(geom.clampClip({ x: 95, y: 195, width: 20, height: 20 }, 100, 200), { x: 95, y: 195, width: 5, height: 5 });
// Math.round 对 .5 向 +∞ 取整:30.5→31,40.5→41
assert.deepEqual(geom.clampClip({ x: 10.4, y: 20.6, width: 30.5, height: 40.5 }, 1000, 1000), { x: 10, y: 21, width: 31, height: 41 });

/* ---------------- splitRanges ---------------- */
assert.deepEqual(geom.splitRanges(9500, 4000), [[0, 4000], [4000, 8000], [8000, 9500]]);
assert.deepEqual(geom.splitRanges(8000, 4000), [[0, 4000], [4000, 8000]]);
assert.deepEqual(geom.splitRanges(0, 4000), [[0, 0]]);

/* ---------------- b64 往返 ---------------- */
const bytes = new Uint8Array(70000).map((_, i) => i % 256);
assert.deepEqual(Array.from(util.b64Decode(util.b64Encode(bytes))), Array.from(bytes));

console.log('✔ geom.test.mjs');
