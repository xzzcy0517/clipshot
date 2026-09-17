/**
 * imagestore 单测:单图/多图/上传会话三条链路的 put→meta→chunk 往返,
 * 以及 sw.js 分块路由的接线回归(v0.9.0 曾漏传 m.item 导致全部截图报 STALE_JOB)。
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(0, eval)(readFileSync(join(ROOT, 'common/messages.js'), 'utf8'));
(0, eval)(readFileSync(join(ROOT, 'common/geom.js'), 'utf8'));
(0, eval)(readFileSync(join(ROOT, 'background/imagestore.js'), 'utf8'));
const CS = globalThis.ClipShot;
const IS = CS.imagestore;

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG_1x1 = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==';

/* ---------- 单图:截图产物路径(preview 按 index 拉块,item 缺省) ---------- */
IS.put('j1', { mime: 'image/png', name: 'a.png', segments: [{ b64: PNG_1x1 }] });
let mt = IS.meta('j1');
assert.equal(mt.ok, true);
assert.equal(mt.name, 'a.png');
assert.deepEqual(mt.segments, [1]);
assert.equal(mt.chunkCount, 1);
assert.equal(mt.items, undefined, '单图不带 items 字段(向后兼容)');
let ck = IS.chunk('j1', undefined, 0); // preview 单图调用形态:item 缺省
assert.equal(ck.ok, true);
assert.equal(ck.b64, PNG_1x1);
assert.equal(ck.seg, 0);
assert.equal(IS.chunk('j1', undefined, 1).ok, false, '越界块应报 STALE_JOB');
IS.done('j1');
assert.equal(IS.meta('j1').ok, false, 'done 后 meta 应过期');

/* ---------- 多图:P009 上传批次(items 按索引拉块) ---------- */
IS.putItems('j2', {
  items: [
    { mime: 'image/png', name: 'x.png', segments: [{ b64: PNG_1x1 }] },
    { mime: 'image/jpeg', name: 'y.jpg', segments: [{ b64: JPEG_1x1 }] }
  ]
});
mt = IS.meta('j2');
assert.equal(mt.ok, true);
assert.equal(mt.items.length, 2);
assert.equal(mt.items[0].name, 'x.png');
assert.equal(mt.items[1].chunkCount, 1);
assert.equal(IS.chunk('j2', 0, 0).b64, PNG_1x1);
assert.equal(IS.chunk('j2', 1, 0).b64, JPEG_1x1, 'item=1 必须取到第二张');
assert.equal(IS.chunk('j2', 9, 0).ok, false, 'item 越界应报 STALE_JOB');

/* ---------- 上传会话:begin/chunk/done → 入店可读;尺寸头解析;上限拦截 ---------- */
let r = IS.uploadBegin({ uploadId: 'u1', name: 'p.png', mime: 'image/png', size: 68 });
assert.equal(r.ok, true);
IS.uploadChunk({ uploadId: 'u1', b64: PNG_1x1.slice(0, 40) });
IS.uploadChunk({ uploadId: 'u1', b64: PNG_1x1.slice(40) });
r = IS.uploadDone({ uploadId: 'u1' });
assert.equal(r.ok, true);
assert.equal(r.jobId, 'u1');
mt = IS.meta('u1');
assert.equal(mt.items.length, 1);
assert.equal(mt.items[0].widthPx, 1, '尺寸头应解出 1x1');
assert.equal(IS.chunk('u1', 0, 0).b64, PNG_1x1, '分块上传后应完整拼回');
r = IS.uploadBegin({ uploadId: 'u2', name: 'big.png', mime: 'image/png', size: 51 * 1024 * 1024 });
assert.equal(r.ok, false);
assert.equal(r.error, 'FILE_TOO_LARGE');
r = IS.uploadBegin({ uploadId: 'u3', name: 'a.txt', mime: 'text/plain', size: 10 });
assert.equal(r.ok, false, '非图片 MIME 应拦截');

/* ---------- 接线回归:sw.js 分块路由必须透传 m.item(v0.9.0 事故) ---------- */
const swSrc = readFileSync(join(ROOT, 'background/sw.js'), 'utf8');
assert.ok(
  /imagestore\.chunk\(m\.jobId,\s*m\.item,\s*m\.index\)/.test(swSrc),
  'sw.js IMG_CHUNK 路由必须按 (jobId, item, index) 透传,缺一即全部报 STALE_JOB'
);

console.log('✔ imagestore.test.mjs(单图/多图/上传会话/路由接线)');
