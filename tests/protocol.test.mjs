/**
 * 协议防漂移测试:common/messages.js 中定义的每个 MSG 常量,
 * 必须在「除定义文件外」的至少两个不同源文件中被引用(即收发两端都存在),
 * 避免改名字后一端忘记同步导致的静默失联。
 */
import { readFileSync, readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(0, eval)(readFileSync(join(ROOT, 'common/messages.js'), 'utf8'));
const CS = globalThis.ClipShot;

const DIRS = ['background', 'common', 'content', 'popup', 'preview', 'options'];
const sources = {};
for (const d of DIRS) {
  for (const f of readdirSync(join(ROOT, d))) {
    if (!f.endsWith('.js')) continue;
    sources[`${d}/${f}`] = readFileSync(join(ROOT, d, f), 'utf8');
  }
}

for (const [key, value] of Object.entries(CS.MSG)) {
  const hits = Object.entries(sources)
    .filter(([path, src]) => new RegExp(`MSG\\.${key}\\b`).test(src))
    .map(([path]) => path);
  assert.ok(hits.length >= 2, `MSG.${key}(${value})只在 ${hits.join(',') || '没有'} 引用,应至少收发两端各一处`);
}

// 滚动 port 名称一致性
const portHits = Object.entries(sources).filter(([, src]) => /SCROLL_PORT\b/.test(src)).map(([p]) => p);
assert.ok(portHits.length >= 2, `SCROLL_PORT 只在 ${portHits.join(',')} 引用`);

console.log('✔ protocol.test.mjs');
