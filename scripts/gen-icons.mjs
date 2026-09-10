#!/usr/bin/env node
/**
 * 零依赖生成扩展占位图标(纯 node zlib 手写最小 PNG)。
 * 用法:node scripts/gen-icons.mjs   → 写入 icons/icon{16,32,48,128}.png
 * 设计:圆角蓝底 + 白色文档 + 三行内容线 + 橙色向下滚动箭头。
 * 不满意可直接替换 icons/ 下的文件(尺寸需一致)。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------- PNG 编码 ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = CRC_TABLE[(crc ^ b) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth 8, color type RGBA
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0; // filter none
    rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- 绘制 ---------------- */
function hex(c) { return [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)]; }
const BG = hex('#2F6FE4'), PAGE = hex('#FFFFFF'), LINE = hex('#8A93A6'), ARROW = hex('#F5A623');

function draw(size) {
  const px = Buffer.alloc(size * size * 4);
  const set = (x, y, rgb, a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = a;
  };
  const u = (v) => Math.round(v * size);
  const r = u(0.18); // 圆角半径
  const inBg = (x, y) => {
    const dx = Math.max(r - x, x - (size - 1 - r), 0);
    const dy = Math.max(r - y, y - (size - 1 - r), 0);
    return dx * dx + dy * dy <= r * r;
  };
  // 文档页
  const pL = u(0.20), pR = u(0.58), pT = u(0.12), pB = u(0.88);
  const pr = Math.max(1, u(0.05));
  const inPage = (x, y) => {
    if (x < pL || x > pR || y < pT || y > pB) return false;
    const dx = Math.max(pr - (x - pL), (x - pR) + pr, 0);
    const dy = Math.max(pr - (y - pT), (y - pB) + pr, 0);
    return dx * dx + dy * dy <= pr * pr;
  };
  // 内容线(三行)
  const line = (y) => y >= pT + u(0.10) && y <= pB - u(0.08);
  // 箭头:竖杆 + 三角
  const aCx = u(0.76), aTop = u(0.28), aShaftB = u(0.62);
  const aW = Math.max(1, u(0.05));
  const triTop = u(0.58), triBot = u(0.80), triHalf = Math.max(2, u(0.13));

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!inBg(x, y)) continue;
      set(x, y, BG);
      if (inPage(x, y)) {
        set(x, y, PAGE);
        if (size >= 32 && line(y) && (y % u(0.16) < Math.max(1, u(0.045))) && x > pL + u(0.06) && x < pR - u(0.06)) {
          set(x, y, LINE);
        }
      }
      const inShaft = Math.abs(x - aCx) <= aW && y >= aTop && y <= aShaftB;
      const triY = y >= triTop && y <= triBot;
      const inTri = triY && Math.abs(x - aCx) <= triHalf * ((triBot - y) / Math.max(1, triBot - triTop));
      if (inShaft || inTri) set(x, y, ARROW);
    }
  }
  return px;
}

mkdirSync(join(ROOT, 'icons'), { recursive: true });
for (const s of [16, 32, 48, 128]) {
  writeFileSync(join(ROOT, `icons/icon${s}.png`), encodePng(s, s, draw(s)));
  console.log(`icons/icon${s}.png`);
}
