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

/* ---------- P007.2 选中交互纯逻辑 ---------- */
const box = { tool: 'rect', x: 10, y: 20, bw: 100, bh: 50, w: 2 };
let hs = P.handlePoints(box);
assert.equal(hs.length, 8);
assert.deepEqual({ x: hs[0].x, y: hs[0].y, dir: hs[0].dir }, { x: 10, y: 20, dir: 'nw' });
assert.equal(hs[2].dir, 'ne'); assert.equal(hs[4].dir, 'se'); assert.equal(hs[6].dir, 'sw');
let rr = P.resizeRect(box, 'e', 160, 999, false);
assert.deepEqual(rr, { x: 10, y: 20, bw: 150, bh: 50 });
rr = P.resizeRect(box, 'e', -5, 0, false); // 越过西边界 → 归一
assert.ok(Math.abs(rr.x + 5) < 1e-9 && Math.abs(rr.bw - 15) < 1e-9, JSON.stringify(rr));
rr = P.resizeRect(box, 'se', 130, 130, true); // Shift 角点锁正方形(取较大边)
assert.ok(Math.abs(rr.bw - rr.bh) < 1e-9);
let ha = P.handlePoints({ tool: 'arrow', x0: 0, y0: 0, x1: 10, y1: 10, w: 2 });
assert.deepEqual(ha.map((p) => p.dir), ['p0', 'p1']);
assert.deepEqual(P.handlePoints({ tool: 'text', x: 0, y: 0, text: 'a', fs: 20 }), []);

/* ---------- 命中(矩形/椭圆只命中描边带,内部可套画) ---------- */
assert.equal(P.hitAnn(box, 60, 45, 4), null, '矩形内部中心不该命中(可套画小矩形)');
assert.equal(P.hitAnn(box, 60, 22, 4), 'body', '矩形上边缘命中');
assert.equal(P.hitAnn(box, 12, 45, 4), 'body', '矩形左边缘命中');
assert.equal(P.hitAnn(box, 300, 45, 4), null);
const ell = { tool: 'ellipse', x: 0, y: 0, bw: 100, bh: 40, w: 2 };
assert.equal(P.hitAnn(ell, 95, 38, 2), null, '椭圆角区域不该命中');
assert.equal(P.hitAnn(ell, 50, 20, 2), null, '椭圆中心不该命中');
assert.equal(P.hitAnn(ell, 50, 35, 2), null, '椭圆描边带以内不该命中');
assert.equal(P.hitAnn(ell, 50, 39, 2), 'body', '椭圆下边缘命中');
const ar = { tool: 'arrow', x0: 0, y0: 0, x1: 100, y1: 0, w: 2 };
assert.equal(P.hitAnn(ar, 50, 3, 4), 'body');
assert.equal(P.hitAnn(ar, 50, 20, 4), null);
const tx = { tool: 'text', x: 5, y: 5, text: 'hi', fs: 20, color: '#000', _mw: 30, _mh: 28 };
assert.equal(P.hitAnn(tx, 20, 15, 4), 'body');
assert.equal(P.hitAnn(tx, 60, 15, 4), null);

/* ---------- Store:edit/del 可逆 ---------- */
const st2 = new CS.Store();
const ann = Object.assign({}, box);
st2.add(ann);
const b1 = P.snap(ann); // bw=100
ann.bw = 222;           // 真实流程:先改完,再 push edit(after 即时快照)
st2.edit(ann, b1);
st2.undo(); assert.equal(ann.bw, 100, 'undo 回到改动前');
st2.redo(); assert.equal(ann.bw, 222, 'redo 重放改动后');
st2.undo(); st2.undo(); // edit → add
assert.equal(st2.anns.length, 0);
st2.redo(); st2.redo();
assert.equal(st2.anns.length, 1); assert.equal(ann.bw, 222);
const st3 = new CS.Store();
const d1 = { tool: 'rect' }, d2 = { tool: 'rect' }, d3 = { tool: 'rect' };
[d1, d2, d3].forEach((a) => st3.add(a));
st3.stack.push({ t: 'del', item: d2, index: 1 }); st3.anns.splice(1, 1);
st3.undo(); assert.deepEqual(st3.anns, [d1, d2, d3], 'del 撤销按原位恢复');
st3.redo(); assert.deepEqual(st3.anns, [d1, d3]);

/* ---------- P014 形状库纯数据 ---------- */
assert.ok(Array.isArray(P.SHAPES) && P.SHAPES.length >= 26, '形状库条目不足');
const ids = new Set();
for (const s of P.SHAPES) {
  assert.ok(s.id && s.label && s.cat, '形状缺 id/label/cat: ' + JSON.stringify(s));
  assert.ok(!ids.has(s.id), '形状 id 重复: ' + s.id);
  ids.add(s.id);
}
for (const sid of ['line', 'arrow', 'darrow', 'elbow']) {
  assert.ok(P.SHAPES.find((s) => s.id === sid && s.line === true), sid + ' 应为线条类');
}
assert.ok(P.SHAPES.find((s) => s.id === 'cylinder' && s.fillable), '数据库圆柱应在库中且可填充');

/* ---------- P014 肘形连接 ---------- */
const elb = P.elbowPts(0, 0, 100, 50);
assert.equal(elb.length, 4);
assert.equal(elb[1].x, 50); assert.equal(elb[1].y, 0);
assert.equal(elb[2].x, 50); assert.equal(elb[2].y, 50);

/* ---------- P014 形状命中:bbox 类整体可命中,线条类按笔带 ---------- */
const shBox = { tool: 'shape', shape: 'diamond', x: 0, y: 0, bw: 100, bh: 60, w: 2 };
assert.equal(P.hitAnn(shBox, 50, 30, 4), 'body', '形状内部应命中(整体物件)');
assert.equal(P.hitAnn(shBox, 120, 30, 4), null);
const shLine = { tool: 'shape', shape: 'line', x0: 0, y0: 0, x1: 100, y1: 0, w: 2 };
assert.equal(P.hitAnn(shLine, 50, 3, 4), 'body');
assert.equal(P.hitAnn(shLine, 50, 20, 4), null);
const shElb = { tool: 'shape', shape: 'elbow', x0: 0, y0: 0, x1: 100, y1: 50, w: 2 };
assert.equal(P.hitAnn(shElb, 50, 25, 3), 'body', '肘形竖段应命中');
assert.equal(P.hitAnn(shElb, 10, 40, 3), null, '肘形空白角不该命中');

/* ---------- P014 形状把手/快照 ---------- */
assert.equal(P.handlePoints(shBox).length, 8, 'bbox 形状 8 把手');
assert.deepEqual(P.handlePoints(shLine).map((p) => p.dir), ['p0', 'p1'], '线条形状 2 端点');
const snapShape = P.snap({ tool: 'shape', shape: 'star', fill: 'alpha', x: 1, y: 2, bw: 30, bh: 40, w: 3, color: '#000' });
assert.equal(snapShape.shape, 'star');
assert.equal(snapShape.fill, 'alpha');

/* ---------- P014 annBBox:导出/容器尺寸共用 ---------- */
const bbRect = P.annBBox({ tool: 'rect', x: 10, y: 20, bw: 100, bh: 50, w: 2 });
assert.deepEqual(bbRect, { x: 8, y: 18, w: 104, h: 54 });
const bbArr = P.annBBox({ tool: 'arrow', x0: 0, y0: 0, x1: 100, y1: 0, w: 3 });
assert.ok(bbArr.x < 0 && bbArr.y < 0 && bbArr.w > 100, '箭头包围盒含头部余量');
const bbTxt = P.annBBox({ tool: 'text', x: 5, y: 6, text: 'ab', fs: 20, _mw: 40, _mh: 28 });
assert.deepEqual(bbTxt, { x: 5, y: 6, w: 40, h: 28 });

/* ---------- P014 Store:操作带全局递增 seq,del 方法可逆 ---------- */
const stA = new CS.Store(), stB = new CS.Store();
const oa = { tool: 'rect', x: 0, y: 0, bw: 1, bh: 1, w: 2 }, ob = { tool: 'pen', pts: [{ x: 0, y: 0 }], w: 2 };
stA.add(oa); stB.add(ob);
const seqA = stA.stack[0].seq, seqB = stB.stack[0].seq;
assert.ok(seqA && seqB && seqB > seqA, 'seq 应全局递增(跨栈)');
assert.ok(stB.del(ob));
assert.equal(stB.anns.length, 0);
assert.ok(stB.stack[stB.stack.length - 1].seq > seqB, 'del 也带 seq');
stB.undo();
assert.deepEqual(stB.anns, [ob], 'del 撤销按原位恢复');

/* ---------- v0.10.2 unionRect:导出画布=图像∪标注包围盒(出界保留) ---------- */
assert.deepEqual(P.unionRect({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 4, h: 4 }),
  { x: 0, y: 0, w: 10, h: 10 }, '内含时并集不变');
// 矩形标注左上出界:annBBox pad=2 → {x:-32,y:8,w:44,h:34};与图像 {0,0,100,80} 并集
const U1 = P.unionRect({ x: 0, y: 0, w: 100, h: 80 },
  P.annBBox({ tool: 'rect', x: -30, y: 10, bw: 40, bh: 30, w: 2 }));
assert.deepEqual(U1, { x: -32, y: 0, w: 132, h: 80 }, '左出界并集向左扩');
// 箭头右出界:并集向右扩,其余边不变
const U2 = P.unionRect({ x: 0, y: 0, w: 100, h: 80 },
  P.annBBox({ tool: 'arrow', x0: 50, y0: 40, x1: 160, y1: 40, w: 3 }));
assert.ok(U2.x === 0 && U2.y === 0 && U2.h === 80 && U2.w > 160, '箭头右出界并集含头部余量: ' + JSON.stringify(U2));
// 画板标注负象限:并集原点可为负
const U3 = P.unionRect({ x: -50, y: -20, w: 30, h: 30 }, { x: 10, y: 0, w: 40, h: 60 });
assert.deepEqual(U3, { x: -50, y: -20, w: 100, h: 80 });

console.log('✔ edit.test.mjs(坐标/几何/栈/选中交互/形状库/画板层/导出并集)');
