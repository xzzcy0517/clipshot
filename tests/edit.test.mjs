/**
 * P007 编辑器纯逻辑测试:坐标换算 / Shift 锁形 / 箭头 15° 吸附 / 折线包围盒 /
 * 笔带命中 / 标注栈 undo-redo-clear。edit.js 在无 document 环境只导出纯逻辑。
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
(0, eval)(readFileSync(join(ROOT, 'preview/edit.js'), 'utf8'));
const CS = globalThis.ClipShot;
assert.ok(CS.editP && CS.Store, '纯逻辑未导出');
const P = CS.editP;

/* ---------- 坐标换算往返 ---------- */
const rect = { left: 40, top: 90, width: 960, height: 4800 };
const nat = [1920, 9600];
let p = P.screenToImg(520, 2490, rect, nat[0], nat[1]);
assert.ok(Math.abs(p.x - 960) < 1e-6 && Math.abs(p.y - 4800) < 1e-6, JSON.stringify(p));
let q = P.imgToScreen(p.x, p.y, rect, nat[0], nat[1]);
assert.ok(Math.abs(q.x - 520) < 1e-6 && Math.abs(q.y - 2490) < 1e-6);

/* ---------- normRect:归一 + Shift 锁正方形 ---------- */
let r = P.normRect(100, 50, 40, 20, false);
assert.deepEqual(r, { x: 40, y: 20, w: 60, h: 30 });
r = P.normRect(100, 50, 40, 20, true); // shift:边取 max(|dx|,|dy|)=60,方向保持(向左上)
assert.deepEqual(r, { x: 40, y: -10, w: 60, h: 60 });
r = P.normRect(0, 0, 50, 10, true);
assert.deepEqual(r, { x: 0, y: 0, w: 50, h: 50 });

/* ---------- 箭头 15° 吸附 ---------- */
let a = P.snapArrow(0, 0, 100, 37, 15); // ≈20.3° → 最近 15° 倍数 = 15°
let ang = Math.atan2(a.y1, a.x1) * 180 / Math.PI;
assert.ok(Math.abs(ang - 15) < 1e-4, String(ang));
assert.ok(Math.abs(Math.hypot(a.x1, a.y1) - Math.hypot(100, 37)) < 1e-4, '吸附保持长度');
a = P.snapArrow(0, 0, 100, 0, 15);
assert.ok(Math.abs(a.y1) < 1e-9 && a.x1 > 0);

/* ---------- 包围盒 / 笔带命中 ---------- */
const bb = P.pathBBox([{ x: 10, y: 20 }, { x: 50, y: 80 }], 5);
assert.deepEqual(bb, { x: 5, y: 15, w: 50, h: 70 });
assert.ok(P.inStroke([{ x: 0, y: 0 }, { x: 100, y: 0 }], 50, 3, 5));
assert.ok(!P.inStroke([{ x: 0, y: 0 }, { x: 100, y: 0 }], 50, 8, 5));
assert.ok(P.inStroke([{ x: 10, y: 10 }], 12, 13, 4));

/* ---------- clamp ---------- */
assert.equal(P.clamp(7, 0, 5), 5);
assert.equal(P.clamp(-2, 0, 5), 0);

/* ---------- 标注栈 ---------- */
const st = new CS.Store();
const A1 = { tool: 'rect', x: 0, y: 0, w: 1, color: '#f00' };
const A2 = { tool: 'pen', pts: [{ x: 0, y: 0 }], color: '#00f' };
st.add(A1); st.add(A2);
assert.equal(st.anns.length, 2);
st.undo();
assert.equal(st.anns.length, 1);
st.redo();
assert.equal(st.anns.length, 2);
assert.ok(st.clearAll());
assert.equal(st.anns.length, 0);
st.undo(); // 撤销“还原” → 全部回来
assert.equal(st.anns.length, 2);
assert.deepEqual(st.anns, [A1, A2]);
st.undo(); st.undo();
assert.equal(st.anns.length, 0);
assert.equal(st.undo(), null, '栈空 undo 返回 null');
st.redo(); st.redo();
assert.equal(st.anns.length, 2);
assert.equal(st.clearAll(), true);
assert.equal(st.clearAll(), false, '空栈 clearAll 不入操作');
st.add(A1); // 新操作清空 redo 分支
assert.equal(st.redo(), null);

console.log('✔ edit.test.mjs(坐标/几何/栈)');
