'use strict';
/**
 * P007 微信式截图编辑器(预览页内双状态标注)+ P014 画板教学化增强。
 * 决策基线见 docs/proposals/P007(D1 双状态 D2 七工具 D3 不可点选 D4 像素马赛克
 * D5 可再编 D6 Esc保标注/还原清标注 D7 所见即所得导出)与 P014(画板标注层/形状库)。
 * 核心承诺:原图不可变(标注=矢量层,坐标一律存「图像原始像素」系);
 * 画板标注挂在 #wrap 伪目标上(坐标=画板布局 px,原点固定左上,导出按 dpr 重绘);
 * 无标注且无画板层时导出走原 blob(零回归)。
 * 纯函数(CS.editP)与标注栈(CS.Store)在头部,可被 node 测试直接 eval。
 */
(function () {
  const CS = globalThis.ClipShot = globalThis.ClipShot || {};

  /* ================ 纯函数(可测) ================ */
  const P = {};
  /** 屏幕 CSS px → 图像原始像素 */
  P.screenToImg = function (sx, sy, rect, natW, natH) {
    return { x: (sx - rect.left) / rect.width * natW, y: (sy - rect.top) / rect.height * natH };
  };
  /** 图像原始像素 → 屏幕 CSS px */
  P.imgToScreen = function (x, y, rect, natW, natH) {
    return { x: rect.left + x / natW * rect.width, y: rect.top + y / natH * rect.height };
  };
  /** 两点矩形归一;shift 锁正方形(边取较大者,保持拖拽方向) */
  P.normRect = function (x0, y0, x1, y1, shift) {
    let w = x1 - x0, h = y1 - y0;
    if (shift) {
      const s = Math.max(Math.abs(w), Math.abs(h));
      w = (w < 0 ? -1 : 1) * s; h = (h < 0 ? -1 : 1) * s;
    }
    return { x: w < 0 ? x0 + w : x0, y: h < 0 ? y0 + h : y0, w: Math.abs(w), h: Math.abs(h) };
  };
  /** 箭头方向吸附(shift 锁 15° 整倍角),保持长度 */
  P.snapArrow = function (x0, y0, x1, y1, stepDeg) {
    const dx = x1 - x0, dy = y1 - y0, len = Math.hypot(dx, dy);
    if (!len) return { x1, y1 };
    const step = (stepDeg == null ? 15 : stepDeg) * Math.PI / 180;
    const a = Math.round(Math.atan2(dy, dx) / step) * step;
    return { x1: x0 + Math.cos(a) * len, y1: y0 + Math.sin(a) * len };
  };
  /** 点到线段距离 */
  P.ptSeg = function (px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const l2 = dx * dx + dy * dy;
    if (!l2) return Math.hypot(px - ax, py - ay);
    let t = ((px - ax) * dx + (py - ay) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };
  /** 折线包围盒(pad 外扩) */
  P.pathBBox = function (pts, pad) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of pts) {
      if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y;
      if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y;
    }
    const pd = pad || 0;
    return { x: x0 - pd, y: y0 - pd, w: (x1 - x0) + pd * 2, h: (y1 - y0) + pd * 2 };
  };
  P.clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  /** 点是否落在折线笔刷带内 */
  P.inStroke = function (pts, x, y, halfW) {
    for (let i = 1; i < pts.length; i++) {
      if (P.ptSeg(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= halfW) return true;
    }
    return pts.length === 1 && Math.hypot(x - pts[0].x, y - pts[0].y) <= halfW;
  };
  /** 肘形连接线:起点横到中线 → 竖 → 横到终点 */
  P.elbowPts = function (x0, y0, x1, y1) {
    const mx = (x0 + x1) / 2;
    return [{ x: x0, y: y0 }, { x: mx, y: y0 }, { x: mx, y: y1 }, { x: x1, y: y1 }];
  };
  /** 任意标注的包围盒(所在坐标系 px,pad 含线宽与箭头头余量) */
  P.annBBox = function (a) {
    const pad = (a.w || 2) / 2 + 1;
    if (a.bw !== undefined) return { x: a.x - pad, y: a.y - pad, w: a.bw + pad * 2, h: a.bh + pad * 2 };
    if (a.pts) return P.pathBBox(a.pts, pad);
    if (a.x0 !== undefined) {
      const p2 = pad + (a.w || 2) * 4; // 箭头头余量
      return {
        x: Math.min(a.x0, a.x1) - p2, y: Math.min(a.y0, a.y1) - p2,
        w: Math.abs(a.x1 - a.x0) + p2 * 2, h: Math.abs(a.y1 - a.y0) + p2 * 2
      };
    }
    if (a.tool === 'text') {
      return { x: a.x, y: a.y, w: a._mw || String(a.text).length * a.fs, h: a._mh || a.fs * 1.4 };
    }
    return { x: 0, y: 0, w: 0, h: 0 };
  };
  /**
   * P014 形状库(纯数据;绘制函数在下方 DOM 段 SHAPE_DRAW,图标与画布共用)。
   * line=true 用 x0/y0/x1/y1 几何(端点拖拽);否则用 x/y/bw/bh(8 把手)。
   * fillable=true 支持填充三态(无/淡/实)。
   */
  P.SHAPES = [
    { id: 'rect', label: '矩形', cat: '基本', fillable: true },
    { id: 'roundrect', label: '圆角矩形', cat: '基本', fillable: true },
    { id: 'ellipse', label: '椭圆', cat: '基本', fillable: true },
    { id: 'diamond', label: '菱形', cat: '基本', fillable: true },
    { id: 'triangle', label: '三角形', cat: '基本', fillable: true },
    { id: 'star', label: '五角星', cat: '基本', fillable: true },
    { id: 'pentagon', label: '五边形', cat: '基本', fillable: true },
    { id: 'hexagon', label: '六边形', cat: '基本', fillable: true },
    { id: 'line', label: '直线', cat: '线条', line: true },
    { id: 'arrow', label: '箭头', cat: '线条', line: true },
    { id: 'darrow', label: '双箭头', cat: '线条', line: true },
    { id: 'elbow', label: '肘形箭头', cat: '线条', line: true },
    { id: 'capsule', label: '起止框', cat: '流程图', fillable: true },
    { id: 'parallelogram', label: '数据', cat: '流程图', fillable: true },
    { id: 'cylinder', label: '数据库', cat: '流程图', fillable: true },
    { id: 'document', label: '文档', cat: '流程图', fillable: true },
    { id: 'predefined', label: '预定义过程', cat: '流程图', fillable: true },
    { id: 'classbox', label: '类框', cat: 'UML', fillable: true },
    { id: 'lifeline', label: '生命线', cat: 'UML' },
    { id: 'actor', label: '参与者', cat: 'UML' },
    { id: 'folder', label: '包', cat: 'UML', fillable: true },
    { id: 'foldnote', label: '注释', cat: 'UML', fillable: true },
    { id: 'cloud', label: '云', cat: '图标', fillable: true },
    { id: 'server', label: '服务器', cat: '图标', fillable: true },
    { id: 'browser', label: '浏览器', cat: '图标', fillable: true },
    { id: 'mobile', label: '手机', cat: '图标', fillable: true },
    { id: 'user', label: '用户', cat: '图标' },
    { id: 'gear', label: '齿轮', cat: '图标' }
  ];


  /** 标注当前几何快照(用于 edit 操作的可逆记录) */
  P.snap = function (a) {
    const o = { tool: a.tool };
    for (const k of ['x', 'y', 'bw', 'bh', 'x0', 'y0', 'x1', 'y1', 'w', 'fs', 'text', 'color', 'shape', 'fill']) {
      if (a[k] !== undefined) o[k] = a[k];
    }
    if (a.pts) o.pts = a.pts.map((p) => ({ x: p.x, y: p.y }));
    return o;
  };
  const DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const DIR_CURSOR = { nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize', e: 'ew-resize', se: 'nwse-resize', s: 'ns-resize', sw: 'nesw-resize', w: 'ew-resize' };
  /** 选中标注的把手点(图像 px):方框/椭圆/形状 8 向,箭头/线条 2 端,其余无 */
  P.handlePoints = function (a) {
    if (a.tool === 'rect' || a.tool === 'ellipse' || (a.tool === 'shape' && a.x0 === undefined)) {
      const x = a.x, y = a.y, w = a.bw, h = a.bh;
      return DIRS.map((d) => ({
        x: d.includes('w') ? x : d.includes('e') ? x + w : x + w / 2,
        y: d.includes('n') ? y : d.includes('s') ? y + h : y + h / 2,
        dir: d, c: DIR_CURSOR[d]
      }));
    }
    if (a.tool === 'arrow' || (a.tool === 'shape' && a.x0 !== undefined)) {
      return [{ x: a.x0, y: a.y0, dir: 'p0', c: 'move' }, { x: a.x1, y: a.y1, dir: 'p1', c: 'move' }];
    }
    return [];
  };
  /** 把手拖拽 → 新几何(rect 系);Shift 角点锁比例;方向翻转自动归一 */
  P.resizeRect = function (a, dir, ix, iy, shift) {
    let x0 = a.x, y0 = a.y, x1 = a.x + a.bw, y1 = a.y + a.bh;
    if (dir.includes('w')) x0 = ix; if (dir.includes('e')) x1 = ix;
    if (dir.includes('n')) y0 = iy; if (dir.includes('s')) y1 = iy;
    let w = x1 - x0, h = y1 - y0;
    if (shift && /^(nw|ne|se|sw)$/.test(dir)) {
      const s = Math.max(Math.abs(w), Math.abs(h));
      const fx = dir.includes('w') ? x1 : x0, fy = dir.includes('n') ? y1 : y0;
      w = (dir.includes('w') ? -1 : 1) * s; h = (dir.includes('n') ? -1 : 1) * s;
      x0 = fx; y0 = fy;
    }
    return { x: Math.min(x0, x0 + w), y: Math.min(y0, y0 + h), bw: Math.abs(w), bh: Math.abs(h) };
  };
  /** 命中检测:返回 'body' 或 null;矩形/椭圆只命中描边带(内部空白可继续套画),文字用缓存盒 */
  P.hitAnn = function (a, x, y, slop) {
    if (a.tool === 'rect') {
      const band = slop + (a.w || 2) / 2;
      const inOuter = x >= a.x - band && x <= a.x + a.bw + band && y >= a.y - band && y <= a.y + a.bh + band;
      if (!inOuter) return null;
      const inInner = x >= a.x + band && x <= a.x + a.bw - band && y >= a.y + band && y <= a.y + a.bh - band;
      return inInner ? null : 'body';
    }
    if (a.tool === 'ellipse') {
      const rx = a.bw / 2 || 1, ry = a.bh / 2 || 1;
      const band = slop + (a.w || 2) / 2;
      const cx = a.x + rx, cy = a.y + ry;
      const outer = ((x - cx) / (rx + band)) ** 2 + ((y - cy) / (ry + band)) ** 2;
      if (outer > 1) return null;
      const irx = Math.max(rx - band, 0.01), iry = Math.max(ry - band, 0.01);
      const inner = ((x - cx) / irx) ** 2 + ((y - cy) / iry) ** 2;
      return inner < 1 ? null : 'body';
    }
    if (a.tool === 'arrow') return P.ptSeg(x, y, a.x0, a.y0, a.x1, a.y1) <= slop + a.w / 2 ? 'body' : null;
    if (a.tool === 'shape') {
      if (a.x0 !== undefined) { // 线条类:直线/箭头/双箭头/肘形
        if (a.shape === 'elbow') {
          const pts = P.elbowPts(a.x0, a.y0, a.x1, a.y1);
          for (let i = 1; i < pts.length; i++) {
            if (P.ptSeg(x, y, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= slop + a.w / 2) return 'body';
          }
          return null;
        }
        return P.ptSeg(x, y, a.x0, a.y0, a.x1, a.y1) <= slop + a.w / 2 ? 'body' : null;
      }
      // bbox 类形状:整体物件,内部也算命中(便于选中拖动)
      return x >= a.x - slop && x <= a.x + a.bw + slop && y >= a.y - slop && y <= a.y + a.bh + slop ? 'body' : null;
    }
    if (a.tool === 'text') {
      const w = a._mw || a.text.length * a.fs, h = a._mh || a.fs * 1.4;
      return x >= a.x - slop && x <= a.x + w + slop && y >= a.y - slop && y <= a.y + h + slop ? 'body' : null;
    }
    return P.inStroke(a.pts, x, y, a.w / 2 + slop) ? 'body' : null;
  };

  /** 标注栈:add/edit/del/clear 四种操作,undo/redo 完整可逆;
   *  每个操作带全局递增 seq,跨目标(图片/画板)撤销时按 seq 选最新者(P014) */
  let opSeq = 0;
  class Store {
    constructor() { this.anns = []; this.stack = []; this.redone = []; }
    add(a) { this.anns.push(a); this.stack.push({ t: 'add', item: a, seq: ++opSeq }); this.redone.length = 0; }
    edit(item, before) {
      this.stack.push({ t: 'edit', item, before, after: P.snap(item), seq: ++opSeq });
      this.redone.length = 0;
    }
    del(item) {
      const i = this.anns.indexOf(item);
      if (i < 0) return false;
      this.anns.splice(i, 1);
      this.stack.push({ t: 'del', item, index: i, seq: ++opSeq });
      this.redone.length = 0;
      return true;
    }
    clearAll() {
      if (!this.anns.length) return false;
      const items = this.anns.slice();
      this.anns = [];
      this.stack.push({ t: 'clear', items, seq: ++opSeq });
      this.redone.length = 0;
      return true;
    }
    undo() {
      const op = this.stack.pop();
      if (!op) return null;
      this.redone.push(op);
      if (op.t === 'add') { const i = this.anns.lastIndexOf(op.item); if (i >= 0) this.anns.splice(i, 1); }
      else if (op.t === 'clear') this.anns.push(...op.items);
      else if (op.t === 'del') this.anns.splice(Math.min(op.index, this.anns.length), 0, op.item);
      else Object.assign(op.item, op.before);
      return op;
    }
    redo() {
      const op = this.redone.pop();
      if (!op) return null;
      this.stack.push(op);
      if (op.t === 'add') this.anns.push(op.item);
      else if (op.t === 'clear') { for (const it of op.items) { const i = this.anns.lastIndexOf(it); if (i >= 0) this.anns.splice(i, 1); } }
      else if (op.t === 'del') { const i = this.anns.indexOf(op.item); if (i >= 0) this.anns.splice(i, 1); }
      else Object.assign(op.item, op.after);
      return op;
    }
    get empty() { return this.anns.length === 0 && this.stack.length === 0; }
  }

  CS.editP = P;
  CS.Store = Store;

  if (typeof document === 'undefined') return; // node 下只导出纯逻辑

  /* ================ 编辑器实现(P014:画板标注层/形状库/背景与任意位置作画) ================ */
  const TOOLS = [
    { id: 'rect', key: '1', glyph: '▭', tip: '方框(Shift 锁正方形)', kind: 'shape' },
    { id: 'ellipse', key: '2', glyph: '◯', tip: '椭圆(Shift 锁正圆)', kind: 'shape' },
    { id: 'arrow', key: '3', glyph: '↗', tip: '箭头(Shift 吸附 15°)', kind: 'shape' },
    { id: 'pen', key: '4', glyph: '✎', tip: '画笔', kind: 'shape' },
    { id: 'mosaic', key: '5', glyph: '▦', tip: '马赛克(涂抹背景像素格,仅限图片上)', kind: 'mosaic' },
    { id: 'text', key: '6', glyph: 'T', tip: '文字(点击输入,Enter 换行,点空白处完成)', kind: 'text' },
    { id: 'highlight', key: '7', glyph: '⚡', tip: '高亮(半透明荧光条)', kind: 'highlight' },
    { id: 'shape', key: '8', glyph: '⬦', tip: '形状库:基本/线条/流程图/UML/图标,拖拽放置', kind: 'shape' }
  ];
  // 线宽标准按网页正文 14–16px 定:细=2 中=3 粗=5(图像像素);高亮/马赛克带按视觉需要加宽
  const TIERS = { shape: [2, 3, 5], mosaic: [16, 28, 44], highlight: [14, 22, 32], text: [14, 20, 28] };
  const COLORS = ['#f5222d', '#fa8c16', '#fadb14', '#52c41a', '#1677ff', '#722ed1', '#111111', '#ffffff'];
  const MOSAIC_CELL = 12;
  const TIER_DOT = [6, 9, 13]; // 三档实心圆直径(CSS px,对标微信:细=小圆 中=中圆 粗=大圆)
  const TIER_TEXT = ['小', '中', '大']; // 文字三档字号标签
  const FILL_MODES = ['none', 'alpha', 'solid'];
  const FILL_LABEL = { none: '无填充', alpha: '淡填充', solid: '实心填充' };

  /* -------- P014 形状绘制:bbox 类 draw(c,x,y,w,h,st);线条类 line(c,x0,y0,x1,y1,st) -------- */
  function rrPath(c, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    c.beginPath();
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }
  function polyPath(c, pts, close) {
    c.beginPath();
    c.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
    if (close !== false) c.closePath();
  }
  function regPoly(cx, cy, r, n, rotDeg) {
    const pts = [];
    for (let i = 0; i < n; i++) {
      const a = (rotDeg + i * 360 / n) * Math.PI / 180;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return pts;
  }
  function starPts(cx, cy, rO, rI) {
    const pts = [];
    for (let i = 0; i < 10; i++) {
      const a = (-90 + i * 36) * Math.PI / 180, r = i % 2 ? rI : rO;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return pts;
  }
  /** 填充(仅 fillable 形状):alpha=淡色填充,solid=实心;随后统一描边由调用方做 */
  function fillPath(c, st, fillable) {
    if (!fillable || !st.fill || st.fill === 'none') return;
    c.save();
    if (st.fill === 'alpha') c.globalAlpha = 0.16;
    c.fillStyle = st.col;
    c.fill();
    c.restore();
  }
  /** bbox 形状通用:build 建主路径 → 填充 → 描边 → detail 补内部细节线 */
  function shBox(build, detail, fillable) {
    return function (c, x, y, w, h, st) {
      build(c, x, y, w, h);
      fillPath(c, st, fillable !== false);
      c.stroke();
      if (detail) { c.beginPath(); detail(c, x, y, w, h, st); c.stroke(); }
    };
  }
  function arrowHead(c, x0, y0, x1, y1, col, lw) {
    const ang = Math.atan2(y1 - y0, x1 - x0);
    const dist = Math.hypot(x1 - x0, y1 - y0);
    const head = Math.min(Math.max(dist * 0.4, 8), Math.max(8, lw * 3.6));
    c.fillStyle = col;
    c.beginPath();
    c.moveTo(x1, y1);
    c.lineTo(x1 - Math.cos(ang - 0.42) * head, y1 - Math.sin(ang - 0.42) * head);
    c.lineTo(x1 - Math.cos(ang) * head * 0.55, y1 - Math.sin(ang) * head * 0.55);
    c.lineTo(x1 - Math.cos(ang + 0.42) * head, y1 - Math.sin(ang + 0.42) * head);
    c.closePath(); c.fill();
  }
  function linePath(c, x0, y0, x1, y1, st, headAtEnd, headAtStart) {
    c.beginPath(); c.moveTo(x0, y0); c.lineTo(x1, y1); c.stroke();
    if (headAtEnd) arrowHead(c, x0, y0, x1, y1, st.col, st.lw);
    if (headAtStart) arrowHead(c, x1, y1, x0, y0, st.col, st.lw);
  }
  const SHAPE_DRAW = {
    rect: shBox((c, x, y, w, h) => { c.beginPath(); c.rect(x, y, w, h); }),
    roundrect: shBox((c, x, y, w, h) => rrPath(c, x, y, w, h, Math.min(w, h) * 0.18)),
    ellipse: shBox((c, x, y, w, h) => { c.beginPath(); c.ellipse(x + w / 2, y + h / 2, Math.max(1, w / 2), Math.max(1, h / 2), 0, 0, Math.PI * 2); }),
    diamond: shBox((c, x, y, w, h) => polyPath(c, [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]])),
    triangle: shBox((c, x, y, w, h) => polyPath(c, [[x + w / 2, y], [x + w, y + h], [x, y + h]])),
    star: shBox((c, x, y, w, h) => polyPath(c, starPts(x + w / 2, y + h / 2, Math.min(w, h) / 2, Math.min(w, h) / 5))),
    pentagon: shBox((c, x, y, w, h) => polyPath(c, regPoly(x + w / 2, y + h / 2, Math.min(w, h) / 2, 5, -90))),
    hexagon: shBox((c, x, y, w, h) => polyPath(c, regPoly(x + w / 2, y + h / 2, Math.min(w, h) / 2, 6, 0))),
    capsule: shBox((c, x, y, w, h) => rrPath(c, x, y, w, h, h / 2)),
    parallelogram: shBox((c, x, y, w, h) => {
      const s = Math.min(w * 0.25, h * 0.9);
      polyPath(c, [[x + s, y], [x + w, y], [x + w - s, y + h], [x, y + h]]);
    }),
    cylinder: shBox((c, x, y, w, h) => {
      const ry = Math.max(2, h * 0.12);
      c.beginPath();
      c.ellipse(x + w / 2, y + ry, w / 2, ry, 0, 0, Math.PI * 2);
      c.moveTo(x, y + ry); c.lineTo(x, y + h - ry);
      c.ellipse(x + w / 2, y + h - ry, w / 2, ry, 0, Math.PI, 0, true);
      c.lineTo(x + w, y + ry);
    }),
    document: shBox((c, x, y, w, h) => {
      const b = y + h - Math.min(h * 0.14, 14), wv = Math.min(h * 0.14, 14);
      c.beginPath();
      c.moveTo(x, y); c.lineTo(x + w, y); c.lineTo(x + w, b);
      c.bezierCurveTo(x + w * 0.75, b + wv * 1.6, x + w * 0.55, b - wv * 1.6, x + w * 0.3, b);
      c.bezierCurveTo(x + w * 0.15, b + wv * 0.8, x + w * 0.08, b + wv * 0.4, x, b);
      c.closePath();
    }),
    predefined: shBox((c, x, y, w, h) => { c.beginPath(); c.rect(x, y, w, h); }, (c, x, y, w, h) => {
      const i = Math.max(4, w * 0.08);
      c.moveTo(x + i, y); c.lineTo(x + i, y + h); c.moveTo(x + w - i, y); c.lineTo(x + w - i, y + h);
    }),
    classbox: shBox((c, x, y, w, h) => { c.beginPath(); c.rect(x, y, w, h); }, (c, x, y, w, h) => {
      c.moveTo(x, y + h / 3); c.lineTo(x + w, y + h / 3);
      c.moveTo(x, y + h * 2 / 3); c.lineTo(x + w, y + h * 2 / 3);
    }),
    lifeline: shBox((c, x, y, w, h) => { c.beginPath(); c.rect(x, y, w, Math.max(6, h * 0.18)); },
      (c, x, y, w, h) => {
        c.save(); c.setLineDash([6, 5]);
        c.moveTo(x + w / 2, y + Math.max(6, h * 0.18)); c.lineTo(x + w / 2, y + h);
        c.stroke(); c.restore();
        c.beginPath();
      }, false),
    actor: shBox((c, x, y, w, h) => {
      const r = Math.min(w, h) * 0.14, cx = x + w / 2;
      c.beginPath(); c.arc(cx, y + r, r, 0, Math.PI * 2);
      c.moveTo(cx, y + r * 2); c.lineTo(cx, y + h * 0.55);
      c.moveTo(x + w * 0.08, y + h * 0.3); c.lineTo(x + w * 0.92, y + h * 0.3);
      c.moveTo(cx, y + h * 0.55); c.lineTo(x + w * 0.12, y + h);
      c.moveTo(cx, y + h * 0.55); c.lineTo(x + w * 0.88, y + h);
    }, null, false),
    folder: shBox((c, x, y, w, h) => {
      const t = Math.max(3, h * 0.22);
      c.beginPath();
      c.moveTo(x, y + t); c.lineTo(x, y); c.lineTo(x + w * 0.38, y); c.lineTo(x + w * 0.48, y + t);
      c.lineTo(x + w, y + t); c.lineTo(x + w, y + h); c.lineTo(x, y + h); c.closePath();
    }),
    foldnote: shBox((c, x, y, w, h) => {
      const f = Math.min(w, h) * 0.22;
      c.beginPath();
      c.moveTo(x, y); c.lineTo(x + w - f, y); c.lineTo(x + w, y + f); c.lineTo(x + w, y + h);
      c.lineTo(x, y + h); c.closePath();
      c.moveTo(x + w - f, y); c.lineTo(x + w - f, y + f); c.lineTo(x + w, y + f);
    }),
    cloud: shBox((c, x, y, w, h) => {
      c.beginPath();
      c.arc(x + w * 0.3, y + h * 0.62, h * 0.24, Math.PI * 0.5, Math.PI * 1.5);
      c.arc(x + w * 0.52, y + h * 0.38, h * 0.3, Math.PI * 0.95, Math.PI * 1.9);
      c.arc(x + w * 0.74, y + h * 0.6, h * 0.22, Math.PI * 1.4, Math.PI * 0.5);
      c.closePath();
    }),
    server: shBox((c, x, y, w, h) => rrPath(c, x, y, w, h, Math.min(w, h) * 0.08), (c, x, y, w, h) => {
      c.moveTo(x, y + h / 3); c.lineTo(x + w, y + h / 3);
      c.moveTo(x, y + h * 2 / 3); c.lineTo(x + w, y + h * 2 / 3);
      const r = Math.max(1.2, h * 0.045);
      for (const yy of [y + h / 6, y + h / 2, y + h * 5 / 6]) {
        c.moveTo(x + w * 0.82 + r, yy); c.arc(x + w * 0.82, yy, r, 0, Math.PI * 2);
      }
    }),
    browser: shBox((c, x, y, w, h) => rrPath(c, x, y, w, h, Math.min(w, h) * 0.08), (c, x, y, w, h) => {
      const t = Math.max(5, h * 0.2);
      c.moveTo(x, y + t); c.lineTo(x + w, y + t);
      const r = Math.max(1, t * 0.18);
      for (let i = 0; i < 3; i++) { c.moveTo(x + t * 0.5 + i * t * 0.42 + r, y + t / 2); c.arc(x + t * 0.5 + i * t * 0.42, y + t / 2, r, 0, Math.PI * 2); }
    }),
    mobile: shBox((c, x, y, w, h) => rrPath(c, x, y, w, h, Math.min(w, h) * 0.12), (c, x, y, w, h) => {
      const cx = x + w / 2;
      c.moveTo(cx - w * 0.12, y + h * 0.08); c.lineTo(cx + w * 0.12, y + h * 0.08);
      c.moveTo(cx - w * 0.16, y + h * 0.92); c.lineTo(cx + w * 0.16, y + h * 0.92);
    }),
    user: shBox((c, x, y, w, h) => {
      const cx = x + w / 2, r = Math.min(w, h) * 0.18;
      c.beginPath(); c.arc(cx, y + r * 1.2, r, 0, Math.PI * 2);
      c.moveTo(x + w * 0.1, y + h);
      c.arc(cx, y + h * 0.98, w * 0.4, Math.PI, Math.PI * 2);
    }, null, false),
    gear: shBox((c, x, y, w, h) => {
      const cx = x + w / 2, cy = y + h / 2, r1 = Math.min(w, h) * 0.2, r2 = Math.min(w, h) * 0.32, r3 = Math.min(w, h) * 0.42;
      c.beginPath(); c.arc(cx, cy, r2, 0, Math.PI * 2);
      c.moveTo(cx + r1, cy); c.arc(cx, cy, r1, 0, Math.PI * 2);
      for (let i = 0; i < 8; i++) {
        const a = i * Math.PI / 4;
        c.moveTo(cx + Math.cos(a) * r2, cy + Math.sin(a) * r2);
        c.lineTo(cx + Math.cos(a) * r3, cy + Math.sin(a) * r3);
      }
    }, null, false),
    line: { line: (c, x0, y0, x1, y1, st) => linePath(c, x0, y0, x1, y1, st, false, false) },
    arrow: { line: (c, x0, y0, x1, y1, st) => linePath(c, x0, y0, x1, y1, st, true, false) },
    darrow: { line: (c, x0, y0, x1, y1, st) => linePath(c, x0, y0, x1, y1, st, true, true) },
    elbow: {
      line: (c, x0, y0, x1, y1, st) => {
        const pts = P.elbowPts(x0, y0, x1, y1);
        c.beginPath();
        c.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) c.lineTo(pts[i].x, pts[i].y);
        c.stroke();
        arrowHead(c, pts[2].x, pts[2].y, pts[3].x, pts[3].y, st.col, st.lw);
      }
    }
  };

  const $ = (id) => document.getElementById(id);
  let overlay = null, ctx = null, stage = null, wrapEl = null, bar = null, previewBar = null, pop = null;
  let mode = 'preview';
  let tool = 'rect';
  const tierByKind = { shape: 1, mosaic: 1, highlight: 1, text: 1 };
  let colorIdx = 0;
  const targets = new Map(); // imgEl|wrapEl → {imgEl, blob, bmp, natW, natH, store, name, isBoard}
  const order = []; // 绘制/命中顺序:#wrap(画板层)恒在首位=最底层
  let boardT = null;  // P014 画板伪目标:isBoard,坐标=画板布局 px(s=1)
  let curShape = 'roundrect'; // 形状库当前形状
  let fillMode = 'none';      // 形状填充三态:none/alpha/solid
  let activeEl = null; // P012:预览页选中图,导出/复制默认作用于它(回退首张)
  let drag = null;
  let textInput = null;
  let selected = null;
  let hoverPt = null; // 马赛克笔刷圆圈光标位置(client 坐标 + 目标)
  let raf = 0;
  let hasMain = false;

  function toolDef(id) { return TOOLS.find((t) => t.id === id); }
  function shapeDef(id) { return P.SHAPES.find((s) => s.id === id); }
  function curColor() { return COLORS[colorIdx]; }
  function curWidth(kind) { const t = TIERS[kind]; return t[tierByKind[kind] || 0]; }

  function ensureDom() {
    if (overlay) return true;
    overlay = $('editlayer'); stage = $('stage'); wrapEl = $('wrap'); bar = $('editbar'); previewBar = $('previewbar');
    if (!overlay || !stage || !wrapEl || !bar || !previewBar) return false;
    ctx = overlay.getContext('2d');
    // P014 画板伪目标:点在非图片区域时标注进 boardT.store,坐标=画板布局 px
    boardT = { imgEl: wrapEl, isBoard: true, bmp: null, natW: 0, natH: 0, store: new Store(), name: '' };
    targets.set(wrapEl, boardT); order.push(wrapEl); // 首位:画板层压在最底
    buildToolbar();
    pop = document.createElement('div');
    pop.id = 'eb-pop';
    document.body.appendChild(pop);
    window.addEventListener('resize', () => { requestRedraw(); closePop(); });
    stage.addEventListener('scroll', () => { hoverPt = null; requestRedraw(); }, { passive: true });
    window.addEventListener('scroll', requestRedraw, { passive: true });
    stage.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKey);
    stage.addEventListener('dblclick', onDblClick);
    return true;
  }

  function buildToolbar() {
    const frag = document.createDocumentFragment();
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.dataset.tool = t.id; b.textContent = t.glyph;
      b.title = t.tip + '(快捷键 ' + t.key + ',再点一次展开/收起选项)';
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        if (tool === t.id && pop.style.display === 'flex') { closePop(); return; }
        setTool(t.id);
        openPop(t, b);
      });
      frag.appendChild(b);
    }
    const sep = () => { const s = document.createElement('span'); s.className = 'esep'; return s; };
    const mk = (id, txt, tip, fn) => {
      const b = document.createElement('button');
      b.id = id; b.textContent = txt; b.title = tip; b.addEventListener('click', fn);
      frag.appendChild(b); return b;
    };
    frag.appendChild(sep());
    mk('eb-undo', '↶ 撤销', '撤销上一个标注/还原操作(Ctrl/Cmd+Z)', doUndo);
    mk('eb-reset', '还原', '清除全部标注回到原图(可再撤销回来)', doReset);
    frag.appendChild(sep());
    mk('eb-copy', '复制', '复制当前呈现(含标注)到剪贴板', () => emit('copy'));
    mk('eb-download', '下载', '打开导出弹窗:剪裁/转格式/压缩/缩放,看清效果再下载', () => emit('download'));
    const done = document.createElement('button');
    done.id = 'eb-done'; done.className = 'primary'; done.textContent = '✔ 完成';
    done.title = '结束编辑(Enter / Esc),标注保留,可再点「编辑」继续';
    done.addEventListener('click', () => setMode('preview'));
    frag.appendChild(done);
    bar.appendChild(frag);
  }

  /* -------- 工具下方的选项条:线宽(线条示意)/字号(A 大小)+ 常用色,即选即生效 -------- */
  /* -------- 形状工具:选项条顶部再挂分类形状选择器(网格图标)+ 填充三态 -------- */
  function openPop(def, anchorBtn) {
    closePop();
    const kind = def.kind;
    pop._kind = kind;
    pop.classList.toggle('shapes', def.id === 'shape');
    let html = '';
    TIERS[kind].forEach((w, i) => {
      const inner = kind === 'text'
        ? '<span class="ta">' + TIER_TEXT[i] + '</span>'
        : '<i class="dot" style="width:' + TIER_DOT[i] + 'px;height:' + TIER_DOT[i] + 'px"></i>';
      html += '<button class="tier' + (i === tierByKind[kind] ? ' on' : '') + '" data-t="' + i + '" title="' +
        (kind === 'text' ? '字号 ' + w + 'px' : '线宽 ' + w + 'px') + '">' + inner + '</button>';
    });
    if (def.id === 'shape') {
      const sd = shapeDef(curShape);
      html += '<button class="fillbtn" data-fill title="切换填充(仅封闭形状生效)"' +
        (sd && sd.fillable ? '' : ' disabled') + '>填充:' + FILL_LABEL[fillMode] + '</button>';
    }
    html += '<span class="psp"></span>';
    if (kind !== 'mosaic') {
      COLORS.forEach((c, i) => {
        html += '<i class="pcolor' + (i === colorIdx ? ' on' : '') + '" data-c="' + i + '" style="background:' + c + '" title="常用色"></i>';
      });
    } else {
      html += '<span class="phint">马赛克无颜色(采样画面像素)</span>';
    }
    pop.innerHTML = html;
    if (def.id === 'shape') pop.insertBefore(buildShapePicker(), pop.firstChild);
    pop.style.display = 'flex';
    const r = anchorBtn.getBoundingClientRect();
    pop.style.left = Math.max(6, Math.min(r.left - 30, innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
    pop.querySelectorAll('.tier').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      applyTier(kind, +b.dataset.t);
      refreshPop(); // 选项条常驻,即改即生效不消失
    }));
    pop.querySelectorAll('.pcolor').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      applyColor(+b.dataset.c);
      refreshPop();
    }));
    pop.querySelectorAll('.shp').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      curShape = b.dataset.shape;
      const sd = shapeDef(curShape);
      if (sd && !sd.fillable) fillMode = 'none';
      refreshPop();
    }));
    const fb = pop.querySelector('[data-fill]');
    if (fb) fb.addEventListener('click', (e) => { e.stopPropagation(); cycleFill(); refreshPop(); });
  }
  /** 形状选择器:按分类分组的网格,图标用形状自身画法实时渲染 */
  function buildShapePicker() {
    const box = document.createElement('div');
    box.className = 'eb-shwrap';
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    let cat = null, grid = null;
    for (const sd of P.SHAPES) {
      if (sd.cat !== cat) {
        cat = sd.cat;
        const lab = document.createElement('div');
        lab.className = 'eb-shlab'; lab.textContent = cat;
        box.appendChild(lab);
        grid = document.createElement('div');
        grid.className = 'eb-shgrid';
        box.appendChild(grid);
      }
      const b = document.createElement('button');
      b.className = 'shp' + (sd.id === curShape ? ' on' : '');
      b.dataset.shape = sd.id;
      b.title = sd.label;
      b.appendChild(shapeIcon(sd, dark));
      grid.appendChild(b);
    }
    return box;
  }
  function shapeIcon(sd, dark) {
    const dpr = window.devicePixelRatio || 1;
    const cv = document.createElement('canvas');
    cv.width = 24 * dpr; cv.height = 24 * dpr;
    cv.style.width = '24px'; cv.style.height = '24px';
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.lineCap = 'round'; g.lineJoin = 'round';
    const st = { col: dark ? '#dde3ee' : '#44506a', lw: 1.5, fill: 'none' };
    g.strokeStyle = st.col; g.fillStyle = st.col; g.lineWidth = st.lw;
    const fn = SHAPE_DRAW[sd.id];
    if (!fn) return cv;
    if (sd.line) fn.line(g, 4, 12, 20, 12, st);
    else fn(g, 4, 4, 16, 16, st);
    return cv;
  }
  /** 填充三态循环:记为默认;选中封闭形状时同步生效(可撤销) */
  function cycleFill() {
    fillMode = FILL_MODES[(FILL_MODES.indexOf(fillMode) + 1) % FILL_MODES.length];
    const a = selected && selected.ann;
    if (!a || a.tool !== 'shape' || a.x0 !== undefined) return;
    const sd = shapeDef(a.shape);
    if (!sd || !sd.fillable) return;
    const before = P.snap(a);
    if ((a.fill || 'none') === fillMode) return;
    a.fill = fillMode;
    selected.t.store.edit(a, before);
    requestRedraw();
  }
  function closePop() { if (pop) { pop.style.display = 'none'; pop.innerHTML = ''; pop.classList.remove('shapes'); } }
  function openPopFor(id) {
    const btn = bar && bar.querySelector('[data-tool="' + id + '"]');
    if (btn) openPop(toolDef(id), btn);
  }
  function refreshPop() {
    if (!pop || pop.style.display !== 'flex') return;
    pop.querySelectorAll('.tier').forEach((x) => x.classList.toggle('on', +x.dataset.t === tierByKind[pop._kind]));
    pop.querySelectorAll('.pcolor').forEach((x) => x.classList.toggle('on', +x.dataset.c === colorIdx));
    pop.querySelectorAll('.shp').forEach((x) => x.classList.toggle('on', x.dataset.shape === curShape));
    const fb = pop.querySelector('[data-fill]');
    if (fb) {
      fb.textContent = '填充:' + FILL_LABEL[fillMode];
      const sd = shapeDef(curShape);
      fb.disabled = !(sd && sd.fillable);
    }
  }
  /** 档位改动:记为默认值;有选中标注/正在输入文字时同步生效(可撤销) */
  function applyTier(kind, i) {
    tierByKind[kind] = i;
    const v = TIERS[kind][i];
    if (kind === 'text' && textInput) { textInput.fs = v; styleTextInput(); autogrowText(); return; }
    const a = selected && selected.ann;
    if (!a || toolDef(a.tool).kind !== kind) return;
    const before = P.snap(a);
    if (kind === 'text') {
      if (a.fs === v) return;
      a.fs = v; measureText(a);
    } else {
      if (a.w === v) return;
      a.w = v; a._pal = null;
    }
    selected.t.store.edit(a, before);
    requestRedraw();
  }
  /** 颜色改动:记为默认色;有选中标注/正在输入文字时同步生效(可撤销) */
  function applyColor(i) {
    colorIdx = i;
    const c = COLORS[i];
    if (textInput) { textInput.color = c; styleTextInput(); return; }
    const a = selected && selected.ann;
    if (!a || a.tool === 'mosaic' || a.color === c) return;
    const before = P.snap(a);
    a.color = c;
    selected.t.store.edit(a, before);
    requestRedraw();
  }
  /** 选中标注时把它的颜色/线宽(字号)回显为当前档位;形状连同形状名/填充一起回显 */
  function syncFromAnn(a) {
    const kind = toolDef(a.tool).kind;
    if (a.color) { const ci = COLORS.indexOf(a.color); if (ci >= 0) colorIdx = ci; }
    if (a.tool === 'shape') { curShape = a.shape; fillMode = a.fill || 'none'; }
    const arr = TIERS[kind];
    const v = kind === 'text' ? a.fs : a.w;
    if (v == null) return;
    let best = 0, bd = Infinity;
    for (let i = 0; i < arr.length; i++) { const d = Math.abs(arr[i] - v); if (d < bd) { bd = d; best = i; } }
    tierByKind[kind] = best;
  }

  function setTool(id) {
    tool = id;
    hoverPt = null;
    for (const b of bar.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === id);
    document.body.dataset.tool = id;
    if (id !== 'text') commitText();
    requestRedraw();
  }

  function setMode(m) {
    if (m === mode) return;
    if (m === 'edit' && !order.length) return;
    mode = m;
    document.body.classList.toggle('editing', m === 'edit');
    if (bar) bar.style.display = m === 'edit' ? 'flex' : 'none';
    // previewbar 显隐交给 CSS:body.editing 隐藏;无主图时 .no-main 只留信息行
    if (m === 'edit') { setTool(tool); openPopFor(tool); }
    else { commitText(); closePop(); drag = null; hoverPt = null; select(); }
    requestRedraw();
  }

  /* ---------------- 标注目标 ---------------- */
  function mount(imgEl, blob, name) {
    if (!ensureDom()) return;
    const t = { imgEl, blob, name, bmp: null, natW: 0, natH: 0, store: new Store() };
    targets.set(imgEl, t); order.push(imgEl);
    createImageBitmap(blob).then((bmp) => { t.bmp = bmp; t.natW = bmp.width; t.natH = bmp.height; requestRedraw(); });
  }
  /** P014:从画板移除一张图(其标注随目标一起注销) */
  function unmount(imgEl) {
    const t = targets.get(imgEl);
    if (!t) return;
    if (selected && selected.t === t) select();
    if (activeEl === imgEl) activeEl = null;
    targets.delete(imgEl);
    const i = order.indexOf(imgEl);
    if (i > 0) order.splice(i, 1); // wrapEl 恒在 0 位,不动
    requestRedraw();
  }
  function targetOf(imgEl) { return targets.get(imgEl); }

  /* ---------------- 绘制 ---------------- */
  function requestRedraw() {
    if (raf || !ctx) return;
    raf = requestAnimationFrame(() => { raf = 0; redraw(); });
  }
  /** 目标的「原始像素」尺寸:画板伪目标恒等于当前布局尺寸(s=1) */
  function natOf(t, rect) {
    return t.isBoard ? { w: rect.width, h: rect.height } : { w: t.natW, h: t.natH };
  }
  function viewOf(t) {
    const rect = t.imgEl.getBoundingClientRect();
    if (t.isBoard) return { rect, natW: rect.width, natH: rect.height, bmp: null, s: 1 };
    return { rect, natW: t.natW, natH: t.natH, bmp: t.bmp, s: t.natW ? rect.width / t.natW : 0 };
  }
  function redraw() {
    const dpr = window.devicePixelRatio || 1;
    const w = innerWidth, h = innerHeight;
    if (overlay.width !== Math.round(w * dpr) || overlay.height !== Math.round(h * dpr)) {
      overlay.width = Math.round(w * dpr); overlay.height = Math.round(h * dpr);
      overlay.style.width = w + 'px'; overlay.style.height = h + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const imgEl of order) {
      const t = targets.get(imgEl);
      if (!t || !(t.bmp || t.isBoard) || !t.store.anns.length) continue;
      const view = viewOf(t);
      if (view.rect.bottom < 0 || view.rect.top > h || view.rect.right < 0 || view.rect.left > w) continue;
      for (const a of t.store.anns) drawAnn(ctx, a, view);
    }
    if (drag && drag.ann) {
      const t = targets.get(drag.imgEl);
      if (t && (t.bmp || t.isBoard)) drawAnn(ctx, drag.ann, viewOf(t));
    }
    // 马赛克笔刷:跟随鼠标的圆圈光标(白圈+黑描边,任意底色可见),对标微信
    if (mode === 'edit' && tool === 'mosaic' && hoverPt && hoverPt.t.bmp) {
      const view = viewOf(hoverPt.t);
      const r = Math.max(3, view.s * curWidth('mosaic') / 2);
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(0,0,0,.55)';
      ctx.beginPath(); ctx.arc(hoverPt.x, hoverPt.y, r + 0.75, 0, Math.PI * 2); ctx.stroke();
      ctx.strokeStyle = '#fff';
      ctx.beginPath(); ctx.arc(hoverPt.x, hoverPt.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    if (CS.Edit && CS.Edit._boardChange) CS.Edit._boardChange(); // 画板层增删后通知宿主重算容器尺寸
  }

  function M(view) {
    return {
      x: (ix) => view.rect.left + ix * view.s,
      y: (iy) => view.rect.top + iy * view.s,
      v: (lv) => lv * view.s
    };
  }

  function drawAnn(c, a, view) {
    if (!a || a._editing) return; // 重编辑中:隐藏原字,输入框即所见
    const m = M(view);
    c.save();
    c.lineCap = 'round'; c.lineJoin = 'round';
    const col = a.color || '#f5222d';
    if (a.tool === 'rect') {
      c.strokeStyle = col; c.lineWidth = Math.max(1, m.v(a.w));
      c.strokeRect(m.x(a.x), m.y(a.y), m.v(a.bw), m.v(a.bh));
    } else if (a.tool === 'ellipse') {
      c.strokeStyle = col; c.lineWidth = Math.max(1, m.v(a.w));
      c.beginPath();
      c.ellipse(m.x(a.x + a.bw / 2), m.y(a.y + a.bh / 2), Math.max(1, m.v(a.bw / 2)), Math.max(1, m.v(a.bh / 2)), 0, 0, Math.PI * 2);
      c.stroke();
    } else if (a.tool === 'arrow') {
      drawArrow(c, a.x0, a.y0, a.x1, a.y1, m, col, Math.max(1.5, m.v(a.w)));
    } else if (a.tool === 'pen') {
      c.strokeStyle = col; c.lineWidth = Math.max(1, m.v(a.w));
      path(c, a.pts, m); c.stroke();
    } else if (a.tool === 'highlight') {
      c.strokeStyle = col; c.globalAlpha = 0.5; c.lineWidth = m.v(a.w);
      path(c, a.pts, m); c.stroke();
    } else if (a.tool === 'mosaic') {
      paintMosaic(c, a, view, m);
    } else if (a.tool === 'shape') {
      const fn = SHAPE_DRAW[a.shape];
      if (fn) {
        const st = { col, lw: Math.max(1, m.v(a.w)), fill: a.fill || 'none' };
        c.strokeStyle = col; c.fillStyle = col; c.lineWidth = st.lw;
        if (a.x0 !== undefined) fn.line(c, m.x(a.x0), m.y(a.y0), m.x(a.x1), m.y(a.y1), st);
        else fn(c, m.x(a.x), m.y(a.y), m.v(a.bw), m.v(a.bh), st);
      }
    } else if (a.tool === 'text') {
      if (!a._mw) measureText(a);
      c.fillStyle = col;
      const fpx = Math.max(4, m.v(a.fs));
      c.font = fpx + 'px system-ui, "PingFang SC", sans-serif';
      c.textBaseline = 'top';
      const lines = String(a.text).split('\n');
      const lh = fpx * 1.4;
      for (let i = 0; i < lines.length; i++) c.fillText(lines[i], m.x(a.x), m.y(a.y) + i * lh);
    }
    c.restore();
    if (!view.export && selected && selected.ann === a && mode === 'edit') drawSelection(c, a, m);
  }
  /** 选中态:方框/椭圆/形状=虚线盒+8 把手;箭头/线条=两端圆点;文字=实线盒(颜色与文字一致,单击即可拖) */
  function drawSelection(c, a, m) {
    c.save();
    const hs = P.handlePoints(a);
    if (a.tool === 'text') {
      c.strokeStyle = a.color || '#f5222d'; c.lineWidth = 1; c.setLineDash([]);
      c.strokeRect(m.x(a.x - 2), m.y(a.y - 2), m.v((a._mw || a.text.length * a.fs) + 4), m.v((a._mh || a.fs * 1.4) + 4));
    } else {
      c.strokeStyle = '#2f6fe4'; c.lineWidth = 1;
      const bb = P.annBBox(a);
      c.setLineDash([4, 3]);
      c.strokeRect(m.x(bb.x), m.y(bb.y), m.v(bb.w), m.v(bb.h));
      for (const hd of hs) {
        c.setLineDash([]);
        c.fillStyle = '#fff'; c.strokeStyle = '#2f6fe4'; c.lineWidth = 1.2;
        if (hd.dir === 'p0' || hd.dir === 'p1') { c.beginPath(); c.arc(m.x(hd.x), m.y(hd.y), 4, 0, Math.PI * 2); c.fill(); c.stroke(); }
        else { c.fillRect(m.x(hd.x) - 3.5, m.y(hd.y) - 3.5, 7, 7); c.strokeRect(m.x(hd.x) - 3.5, m.y(hd.y) - 3.5, 7, 7); }
      }
    }
    c.restore();
  }
  function path(c, pts, m) {
    c.beginPath();
    c.moveTo(m.x(pts[0].x), m.y(pts[0].y));
    for (let i = 1; i < pts.length; i++) c.lineTo(m.x(pts[i].x), m.y(pts[i].y));
  }
  function drawArrow(c, x0, y0, x1, y1, m, col, lw) {
    const sx = m.x(x0), sy = m.y(y0), ex = m.x(x1), ey = m.y(y1);
    const ang = Math.atan2(ey - sy, ex - sx);
    const dist = Math.hypot(ex - sx, ey - sy);
    const head = Math.min(dist * 0.4, Math.max(8, lw * 3.6));
    c.strokeStyle = col; c.fillStyle = col; c.lineWidth = lw;
    c.beginPath();
    c.moveTo(sx, sy);
    c.lineTo(ex - Math.cos(ang) * head * 0.75, ey - Math.sin(ang) * head * 0.75);
    c.stroke();
    c.beginPath();
    c.moveTo(ex, ey);
    c.lineTo(ex - Math.cos(ang - 0.42) * head, ey - Math.sin(ang - 0.42) * head);
    c.lineTo(ex - Math.cos(ang) * head * 0.55, ey - Math.sin(ang) * head * 0.55);
    c.lineTo(ex - Math.cos(ang + 0.42) * head, ey - Math.sin(ang + 0.42) * head);
    c.closePath(); c.fill();
  }

  /** 背景采样马赛克:bbox 降采样为格子色板,笔带内的格子按屏幕方块填色(实时/导出同算法) */
  function mosaicPalette(t, a) {
    if (a._pal && a._pal.nat === t.natW) return a._pal;
    const bb = P.pathBBox(a.pts, a.w / 2);
    const x0 = P.clamp(bb.x, 0, t.natW), y0 = P.clamp(bb.y, 0, t.natH);
    const x1 = P.clamp(bb.x + bb.w, 0, t.natW), y1 = P.clamp(bb.y + bb.h, 0, t.natH);
    if (!(x1 > x0 && y1 > y0)) return null;
    const cols = P.clamp(Math.ceil((x1 - x0) / MOSAIC_CELL), 1, 480);
    const rows = P.clamp(Math.ceil((y1 - y0) / MOSAIC_CELL), 1, 480);
    const low = document.createElement('canvas'); low.width = cols; low.height = rows;
    const lc = low.getContext('2d');
    lc.drawImage(t.bmp, x0, y0, x1 - x0, y1 - y0, 0, 0, cols, rows);
    const data = lc.getImageData(0, 0, cols, rows).data;
    a._pal = { x0, y0, x1, y1, cols, rows, data, nat: t.natW };
    return a._pal;
  }
  function paintMosaic(c, a, view, m) {
    const t = { bmp: view.bmp, natW: view.natW };
    const pal = mosaicPalette(t, a);
    if (!pal) return;
    const cw = (pal.x1 - pal.x0) / pal.cols, ch = (pal.y1 - pal.y0) / pal.rows;
    const half = a.w / 2;
    for (let gy = 0; gy < pal.rows; gy++) {
      const cy = pal.y0 + (gy + 0.5) * ch;
      for (let gx = 0; gx < pal.cols; gx++) {
        const cx = pal.x0 + (gx + 0.5) * cw;
        if (!P.inStroke(a.pts, cx, cy, half)) continue;
        const i = (gy * pal.cols + gx) * 4;
        c.fillStyle = 'rgb(' + pal.data[i] + ',' + pal.data[i + 1] + ',' + pal.data[i + 2] + ')';
        c.fillRect(m.x(pal.x0 + gx * cw), m.y(pal.y0 + gy * ch), Math.max(1, m.v(cw)), Math.max(1, m.v(ch)));
      }
    }
  }

  /* ---------------- 指针交互 ---------------- */
  function mainTarget() {
    if (activeEl && targets.get(activeEl)) return targets.get(activeEl);
    const el = order.find((x) => { const t = targets.get(x); return t && !t.isBoard; });
    return el ? targets.get(el) : null;
  }
  function setActive(el) { if (targets.has(el) && !targets.get(el).isBoard) activeEl = el; }
  /** 命中的目标:先图片(后挂载优先),最后画板(点空白处=画板层) */
  function targetAt(e) {
    let board = null;
    for (let i = order.length - 1; i >= 0; i--) {
      const t = targets.get(order[i]);
      if (!t || !(t.bmp || t.isBoard)) continue;
      const r = t.imgEl.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        if (t.isBoard) { board = { t, rect: r }; continue; } // 画板兜底,图片优先
        const nat = natOf(t, r);
        return { t, rect: r, pt: P.screenToImg(e.clientX, e.clientY, r, nat.w, nat.h) };
      }
    }
    if (board) {
      const nat = natOf(board.t, board.rect);
      board.pt = P.screenToImg(e.clientX, e.clientY, board.rect, nat.w, nat.h);
      return board;
    }
    return null;
  }
  function hitTest(t, x, y) {
    const r = t.imgEl.getBoundingClientRect();
    const nat = natOf(t, r);
    const slop = 8 / (r.width / nat.w || 1);
    const hs = selected && selected.t === t ? P.handlePoints(selected.ann) : [];
    for (const hd of hs) {
      if (Math.hypot(x - hd.x, y - hd.y) <= slop * 0.9) return { kind: 'resize', hd };
    }
    for (let i = t.store.anns.length - 1; i >= 0; i--) {
      const a = t.store.anns[i];
      if (a.tool === 'mosaic') continue; // 马赛克即涂即定,不选中/不拖动(用户反馈)
      if (P.hitAnn(a, x, y, slop)) return { kind: 'body', a };
    }
    return null;
  }
  function select(t, a) {
    selected = (a && t) ? { t, ann: a } : null;
    if (selected) {
      setTool(a.tool); // 工具栏高亮跟随当前选中标注类型(用户反馈)
      syncFromAnn(a); // 颜色/线宽档位回显为该标注当前值
      // 选项条自动弹出,可直接改颜色/线宽(文字输入期间由 openText 自行弹出)
      if (mode === 'edit' && !textInput) openPopFor(a.tool);
    }
  }
  function onPointerDown(e) {
    if (mode !== 'edit' || e.button !== 0) return;
    if ((bar && bar.contains(e.target)) || (pop && pop.contains(e.target))) { return; }
    const hit = targetAt(e);
    if (!hit) { commitText(); select(); requestRedraw(); return; }
    const target = hit.t;
    if (target.isBoard && toolDef(tool).kind === 'mosaic') { // 画板空白处无像素可采样
      commitText(); select(); requestRedraw();
      if (CS.Edit.onHint) CS.Edit.onHint('马赛克只能涂抹在图片上');
      return;
    }
    const hitRes = hitTest(target, hit.pt.x, hit.pt.y);
    if (hitRes && hitRes.kind === 'resize') {
      commitText();
      drag = { mode: 'resize', imgEl: target.imgEl, ann: selected.ann, hd: hitRes.hd, before: P.snap(selected.ann), x: hit.pt.x, y: hit.pt.y };
      e.preventDefault(); return;
    }
    if (hitRes && hitRes.kind === 'body') {
      commitText();
      select(target, hitRes.a);
      drag = { mode: 'move', imgEl: target.imgEl, ann: hitRes.a, before: P.snap(hitRes.a), lastX: hit.pt.x, lastY: hit.pt.y, moved: false };
      requestRedraw(); e.preventDefault(); return;
    }
    // 空白:新画(图片上=图片标注;画板空白=画板标注)
    if (tool === 'text') {
      if (textInput) { commitText(); requestRedraw(); return; } // 先定稿为最终态,不连锁开新输入框
      if (selected) { select(); requestRedraw(); return; } // 有选中框时先取消选中(box 消失)
      openText(target, hit.pt); return;
    }
    commitText(); select();
    drag = {
      mode: 'draw', imgEl: target.imgEl, tool, kind: toolDef(tool).kind, shift: e.shiftKey,
      shape: curShape,
      x0: hit.pt.x, y0: hit.pt.y, x1: hit.pt.x, y1: hit.pt.y,
      pts: [{ x: hit.pt.x, y: hit.pt.y }],
      ann: null
    };
    e.preventDefault();
  }
  function onPointerMove(e) {
    if (mode === 'edit' && tool === 'mosaic') trackBrush(e); // 涂抹中也要跟手
    if (!drag) { updateHoverCursor(e); return; }
    const t = targets.get(drag.imgEl); if (!t) return;
    const rect = t.imgEl.getBoundingClientRect();
    const nat = natOf(t, rect);
    const p = P.screenToImg(e.clientX, e.clientY, rect, nat.w, nat.h);
    if (drag.mode === 'draw') {
      drag.x1 = p.x; drag.y1 = p.y; drag.shift = e.shiftKey;
      if (drag.kind === 'mosaic' || drag.tool === 'pen' || drag.tool === 'highlight') {
        const last = drag.pts[drag.pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) > 2) drag.pts.push({ x: p.x, y: p.y });
      }
      drag.ann = buildDragAnn();
    } else if (drag.mode === 'resize') {
      const a = drag.ann;
      if (a.x0 !== undefined) { // 箭头/线条类:端点拖拽
        if (drag.hd.dir === 'p0') { a.x0 = p.x; a.y0 = p.y; } else { a.x1 = p.x; a.y1 = p.y; }
      } else {
        const r = P.resizeRect({ x: drag.before.x, y: drag.before.y, bw: drag.before.bw, bh: drag.before.bh }, drag.hd.dir, p.x, p.y, e.shiftKey);
        a.x = r.x; a.y = r.y; a.bw = r.bw; a.bh = r.bh;
      }
      a._pal = null;
    } else if (drag.mode === 'move') {
      const dx = p.x - drag.lastX, dy = p.y - drag.lastY;
      if (dx || dy) {
        drag.moved = true;
        const a = drag.ann;
        if (a.pts) for (const q of a.pts) { q.x += dx; q.y += dy; }
        if (a.x !== undefined && a.bw === undefined) { a.x += dx; a.y += dy; }
        if (a.bw !== undefined) { a.x += dx; a.y += dy; }
        if (a.x0 !== undefined) { a.x0 += dx; a.y0 += dy; a.x1 += dx; a.y1 += dy; }
        a._pal = null;
        drag.lastX = p.x; drag.lastY = p.y;
      }
    }
    requestRedraw();
  }
  /** 马赛克笔刷圆圈:记录悬停位置并触发重绘(圆圈画在 overlay 上) */
  function trackBrush(e) {
    const t0 = firstTargetAt(e);
    hoverPt = t0 ? { x: e.clientX, y: e.clientY, t: t0 } : null;
    requestRedraw();
  }
  function updateHoverCursor(e) {
    let cur = mode === 'edit' ? 'crosshair' : '';
    if (mode === 'edit' && tool === 'mosaic') {
      cur = hoverPt ? 'none' : 'crosshair'; // 圆圈光标取代系统光标
    } else if (mode === 'edit') {
      const hit = targetAt(e);
      if (hit) {
        const t0 = hit.t, p0 = hit.pt;
        const nat = natOf(t0, hit.rect);
        const slop = 8 / (hit.rect.width / nat.w || 1);
        const hs = selected && selected.t === t0 ? P.handlePoints(selected.ann) : [];
        for (const hd of hs) if (Math.hypot(p0.x - hd.x, p0.y - hd.y) <= slop * 0.9) { cur = hd.c; break; }
        if (cur === 'crosshair') {
          for (let i = t0.store.anns.length - 1; i >= 0; i--) {
            const a = t0.store.anns[i];
            if (a.tool !== 'mosaic' && P.hitAnn(a, p0.x, p0.y, slop)) { cur = 'move'; break; }
          }
        }
      }
    }
    if (document.body.dataset.cursor !== cur) {
      document.body.dataset.cursor = cur;
      const st = document.getElementById('stage'); if (st) st.style.cursor = cur || '';
    }
  }
  /** 仅图片目标命中(马赛克笔刷用;画板层不算) */
  function firstTargetAt(e) {
    for (const el of order) {
      const t = targets.get(el);
      if (!t || !t.bmp || t.isBoard) continue;
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) return t;
    }
    return null;
  }
  function onPointerUp() {
    if (!drag) return;
    const t = targets.get(drag.imgEl);
    if (drag.mode === 'draw') {
      const ann = buildDragAnn();
      drag = null;
      if (ann && t) t.store.add(ann);
    } else if (drag.mode === 'resize' || (drag.mode === 'move' && drag.moved)) {
      if (t) t.store.edit(drag.ann, drag.before);
      if (drag.mode === 'resize' && drag.ann.bw !== undefined) { const a = drag.ann; a._pal = null; }
      drag = null;
    } else { drag = null; }
    requestRedraw();
  }
  function onDblClick(e) {
    if (mode !== 'edit') return;
    const hit = targetAt(e); if (!hit) return;
    const t = hit.t, p = hit.pt;
    const nat = natOf(t, hit.rect);
    const slop = 8 / (hit.rect.width / nat.w || 1);
    for (let i = t.store.anns.length - 1; i >= 0; i--) {
      const a = t.store.anns[i];
      if (a.tool === 'text' && P.hitAnn(a, p.x, p.y, slop)) {
        e.preventDefault();
        select(t, a);
        openText(t, { x: a.x, y: a.y }, a);
        return;
      }
    }
  }
  function buildDragAnn() {
    if (!drag) return null;
    const base = { tool: drag.tool, color: curColor() };
    if (drag.tool === 'rect' || drag.tool === 'ellipse') {
      const r = P.normRect(drag.x0, drag.y0, drag.x1, drag.y1, drag.shift);
      if (r.w < 2 && r.h < 2) return null;
      return Object.assign(base, { x: r.x, y: r.y, bw: r.w, bh: r.h, w: curWidth('shape') });
    }
    if (drag.tool === 'arrow') {
      let { x1, y1 } = drag;
      if (drag.shift) ({ x1, y1 } = P.snapArrow(drag.x0, drag.y0, drag.x1, drag.y1, 15));
      if (Math.hypot(x1 - drag.x0, y1 - drag.y0) < 3) return null;
      return Object.assign(base, { x0: drag.x0, y0: drag.y0, x1, y1, w: curWidth('shape') });
    }
    if (drag.tool === 'shape') {
      const sd = shapeDef(drag.shape || curShape);
      if (!sd) return null;
      if (sd.line) {
        let { x1, y1 } = drag;
        if (drag.shift && sd.id !== 'elbow') ({ x1, y1 } = P.snapArrow(drag.x0, drag.y0, x1, y1, 15));
        if (Math.hypot(x1 - drag.x0, y1 - drag.y0) < 3) return null;
        return { tool: 'shape', shape: sd.id, color: curColor(), x0: drag.x0, y0: drag.y0, x1, y1, w: curWidth('shape') };
      }
      const r = P.normRect(drag.x0, drag.y0, drag.x1, drag.y1, drag.shift);
      if (r.w < 2 && r.h < 2) return null;
      return {
        tool: 'shape', shape: sd.id, color: curColor(),
        x: r.x, y: r.y, bw: r.w, bh: r.h, w: curWidth('shape'),
        fill: sd.fillable ? fillMode : 'none'
      };
    }
    if (drag.tool === 'pen') {
      if (drag.pts.length < 2) return null;
      return Object.assign(base, { pts: drag.pts.map((p) => ({ x: p.x, y: p.y })), w: curWidth('shape') });
    }
    if (drag.tool === 'highlight') {
      if (drag.pts.length < 2) return null;
      return Object.assign(base, { pts: drag.pts.map((p) => ({ x: p.x, y: p.y })), w: curWidth('highlight') });
    }
    if (drag.tool === 'mosaic') {
      if (drag.pts.length < 1) return null;
      return { tool: 'mosaic', pts: drag.pts.map((p) => ({ x: p.x, y: p.y })), w: curWidth('mosaic') };
    }
    return null;
  }

  /* ---------------- 文字(微信式:Enter 换行,点空白完成;编辑中可改色/字号) ---------------- */
  function openText(t, pt, existing) {
    commitText();
    const inp = document.createElement('textarea');
    inp.id = 'eb-textinput';
    inp.rows = 1;
    textInput = {
      inp, t, pt, existing,
      fs: existing ? existing.fs : curWidth('text'),
      color: existing ? (existing.color || curColor()) : curColor()
    };
    styleTextInput();
    if (existing) { inp.value = existing.text; existing._editing = true; requestRedraw(); }
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation(); // Enter 走默认换行;Esc 放弃改动
      if (e.key === 'Escape') { inp.value = existing ? existing.text : ''; commitText(); }
    });
    inp.addEventListener('input', autogrowText);
    document.body.appendChild(inp);
    autogrowText();
    // 输入期间选项条保持展开:字号/颜色即点即改
    openPopFor('text');
    if (existing) { inp.focus(); inp.select(); } else setTimeout(() => inp.focus(), 0);
  }
  function styleTextInput() {
    if (!textInput) return;
    const { inp, t, pt, fs, color } = textInput;
    const rect = t.imgEl.getBoundingClientRect();
    const k = rect.width / natOf(t, rect).w || 1;
    inp.style.left = (rect.left + pt.x * k) + 'px';
    inp.style.top = (rect.top + pt.y * k) + 'px';
    inp.style.color = color;
    inp.style.font = Math.max(6, fs * k) + 'px/1.4 system-ui, "PingFang SC", sans-serif';
  }
  function autogrowText() {
    if (!textInput) return;
    const { inp, t, fs } = textInput;
    const rect = t.imgEl.getBoundingClientRect();
    const k = rect.width / natOf(t, rect).w || 1;
    if (!measCtx) { measCtx = document.createElement('canvas').getContext('2d'); }
    measCtx.font = Math.max(6, fs * k) + 'px system-ui, "PingFang SC", sans-serif';
    let w = 0;
    for (const ln of (inp.value || ' ').split('\n')) w = Math.max(w, measCtx.measureText(ln).width);
    inp.style.width = Math.max(80, Math.min(w + 28, innerWidth * 0.9)) + 'px';
    inp.style.height = 'auto';
    inp.style.height = inp.scrollHeight + 'px';
  }
  function commitText() {
    if (!textInput) return;
    const { inp, t, pt, existing, fs, color } = textInput;
    const v = inp.value.trim();
    textInput = null; inp.remove();
    if (existing) {
      delete existing._editing;
      if (!v) { // 清空提交 = 删除该文字(可撤销)
        t.store.del(existing);
        if (selected && selected.ann === existing) select();
      } else {
        const before = P.snap(existing);
        let changed = false;
        if (v !== existing.text) { existing.text = v; changed = true; }
        if (color && color !== existing.color) { existing.color = color; changed = true; }
        if (fs && fs !== existing.fs) { existing.fs = fs; changed = true; }
        if (changed) { measureText(existing); t.store.edit(existing, before); }
      }
      select(); // 定稿即最终态:不留选中框,只显示文字
      requestRedraw(); return;
    }
    if (v) {
      const a = { tool: 'text', x: pt.x, y: pt.y, text: v, color, fs };
      measureText(a);
      t.store.add(a);
      select(); // 同上:定稿不带选中框
      requestRedraw();
    }
  }
  let measCtx = null;
  function measureText(a) {
    if (!measCtx) { measCtx = document.createElement('canvas').getContext('2d'); }
    measCtx.font = a.fs + 'px system-ui, "PingFang SC", sans-serif';
    const lines = String(a.text).split('\n');
    let w = 0;
    for (const ln of lines) w = Math.max(w, measCtx.measureText(ln).width);
    a._mw = w;
    a._mh = lines.length * a.fs * 1.4;
  }

  /* ---------------- 栈操作:跨目标按操作 seq 选最新者(P014 画板层与图片混排) ---------------- */
  function activeTargets() { return order.map((el) => targets.get(el)).filter(Boolean); }
  function pickTop(getter, cmp) {
    let best = null;
    for (const t of activeTargets()) {
      const arr = getter(t.store);
      if (!arr.length) continue;
      const top = arr[arr.length - 1];
      if (!best || cmp(top, best.top)) best = { t, top };
    }
    return best && best.t;
  }
  function doUndo() {
    const t = pickTop((s) => s.stack, (a, b) => (a.seq || 0) > (b.seq || 0));
    if (t) t.store.undo();
    requestRedraw();
  }
  function doRedo() { // 撤销是 seq 降序弹出的,重做按 seq 升序补回
    const t = pickTop((s) => s.redone, (a, b) => (a.seq || 0) < (b.seq || 0));
    if (t) t.store.redo();
    requestRedraw();
  }
  function doReset() { let hit = false; for (const t of activeTargets()) if (t.store.clearAll()) hit = true; if (hit) requestRedraw(); }

  /* ---------------- 键盘 ---------------- */
  function onKey(e) {
    if (CS.Edit.modalOpen && CS.Edit.modalOpen()) return; // 导出弹窗打开时不响应编辑器快捷键
    if (textInput || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const meta = e.ctrlKey || e.metaKey;
    if (mode === 'edit') {
      if (meta && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
      if (meta && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); doRedo(); return; }
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); setMode('preview'); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (selected) { const a = selected.ann; const tt = selected.t; tt.store.del(a); select(); } else doUndo(); requestRedraw(); return; }
      if (meta && e.key === 'c') return; // 让宿主复制
      if (/^[1-8]$/.test(e.key)) {
        const td = TOOLS.find((x) => x.key === e.key);
        if (td) { setTool(td.id); openPopFor(td.id); }
        return;
      }
    } else if (e.key === 'e' || e.key === 'E') {
      if (order.length) setMode('edit');
    }
  }

  /* ---------------- 导出(所见即所得) ---------------- */
  async function exportBlob(imgEl) {
    const t = imgEl ? targets.get(imgEl) : mainTarget();
    if (!t || !t.bmp) return null;
    if (!t.store.anns.length) return null;
    const c = document.createElement('canvas');
    c.width = t.natW; c.height = t.natH;
    const cc = c.getContext('2d');
    cc.drawImage(t.bmp, 0, 0);
    const view = { rect: { left: 0, top: 0, width: t.natW }, natW: t.natW, natH: t.natH, bmp: t.bmp, s: 1, export: true };
    for (const a of t.store.anns) { a._pal = null; drawAnn(cc, a, view); }
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('合成失败'))), 'image/png'));
  }

  /* -------- P014 画板标注层:坐标=画板布局 px;导出按 scale(dpr)重绘,与卡片合成同坐标系 -------- */
  function hasBoardAnns() { return !!(boardT && boardT.store.anns.length); }
  function boardAnnsBBox() {
    if (!hasBoardAnns()) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const a of boardT.store.anns) {
      const bb = P.annBBox(a);
      if (bb.x < x0) x0 = bb.x; if (bb.y < y0) y0 = bb.y;
      if (bb.x + bb.w > x1) x1 = bb.x + bb.w; if (bb.y + bb.h > y1) y1 = bb.y + bb.h;
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  /** 把画板标注层画到导出画布:scale = 导出分辨率 / 画板布局 px(即 dpr) */
  function drawBoardLayer(c2d, scale) {
    if (!hasBoardAnns()) return;
    const view = { rect: { left: 0, top: 0, width: 0 }, s: scale, bmp: null, export: true };
    for (const a of boardT.store.anns) drawAnn(c2d, a, view);
  }

  function emit(kind) {
    CS.Edit._emit && CS.Edit._emit(kind, mainTarget());
  }

  CS.Edit = {
    mount, unmount, targetOf, exportBlob, setMode, setActive, get mode() { return mode; },
    redraw: requestRedraw,
    hasBoardAnns, boardAnnsBBox, drawBoardLayer,
    modalOpen: null, // preview.js 赋值为导出弹窗状态查询,打开时屏蔽编辑器快捷键
    onHint: null,    // preview.js 赋值为 toast,编辑器内轻提示(如马赛克仅限图片)
    setHasMain(v) {
      hasMain = !!v;
      const p = document.getElementById('previewbar');
      if (p) p.classList.toggle('no-main', !v);
    },
    _emit: null,
    _boardChange: null // preview.js 赋值为 relayout,画板层变化时重算容器尺寸
  };
})();
