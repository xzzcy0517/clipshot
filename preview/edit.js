'use strict';
/**
 * P007 微信式截图编辑器(预览页内双状态标注)。
 * 决策基线见 docs/proposals/P007:D1 双状态 D2 七工具 D3 不可点选 D4 像素马赛克
 * D5 可再编 D6 Esc保标注/还原清标注 D7 所见即所得导出。
 * 核心承诺:原图不可变(标注=矢量层,坐标一律存「图像原始像素」系);
 * 无标注时导出走原 blob(零回归)。
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


  /** 标注当前几何快照(用于 edit 操作的可逆记录) */
  P.snap = function (a) {
    const o = { tool: a.tool };
    for (const k of ['x', 'y', 'bw', 'bh', 'x0', 'y0', 'x1', 'y1', 'w', 'fs', 'text', 'color']) {
      if (a[k] !== undefined) o[k] = a[k];
    }
    if (a.pts) o.pts = a.pts.map((p) => ({ x: p.x, y: p.y }));
    return o;
  };
  const DIRS = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
  const DIR_CURSOR = { nw: 'nwse-resize', n: 'ns-resize', ne: 'nesw-resize', e: 'ew-resize', se: 'nwse-resize', s: 'ns-resize', sw: 'nesw-resize', w: 'ew-resize' };
  /** 选中标注的把手点(图像 px):方框/椭圆 8 向,箭头 2 端,其余无 */
  P.handlePoints = function (a) {
    if (a.tool === 'rect' || a.tool === 'ellipse') {
      const x = a.x, y = a.y, w = a.bw, h = a.bh;
      return DIRS.map((d) => ({
        x: d.includes('w') ? x : d.includes('e') ? x + w : x + w / 2,
        y: d.includes('n') ? y : d.includes('s') ? y + h : y + h / 2,
        dir: d, c: DIR_CURSOR[d]
      }));
    }
    if (a.tool === 'arrow') {
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
  /** 命中检测:返回 'body' 或 null;椭圆用归一半径,文字用缓存盒 */
  P.hitAnn = function (a, x, y, slop) {
    if (a.tool === 'rect' || a.tool === 'ellipse') {
      if (a.tool === 'rect') {
        return x >= a.x - slop && x <= a.x + a.bw + slop && y >= a.y - slop && y <= a.y + a.bh + slop ? 'body' : null;
      }
      const rx = a.bw / 2 || 1, ry = a.bh / 2 || 1;
      const nx = (x - (a.x + rx)) / (rx + slop), ny = (y - (a.y + ry)) / (ry + slop);
      return nx * nx + ny * ny <= 1 ? 'body' : null;
    }
    if (a.tool === 'arrow') return P.ptSeg(x, y, a.x0, a.y0, a.x1, a.y1) <= slop + a.w / 2 ? 'body' : null;
    if (a.tool === 'text') {
      const w = a._mw || a.text.length * a.fs, h = a._mh || a.fs * 1.4;
      return x >= a.x - slop && x <= a.x + w + slop && y >= a.y - slop && y <= a.y + h + slop ? 'body' : null;
    }
    return P.inStroke(a.pts, x, y, a.w / 2 + slop) ? 'body' : null;
  };

  /** 标注栈:add/clear 两种操作,undo/redo 完整可逆 */
  class Store {
    constructor() { this.anns = []; this.stack = []; this.redone = []; }
    add(a) { this.anns.push(a); this.stack.push({ t: 'add', item: a }); this.redone.length = 0; }
    edit(item, before) {
      this.stack.push({ t: 'edit', item, before, after: P.snap(item) });
      this.redone.length = 0;
    }
    clearAll() {
      if (!this.anns.length) return false;
      const items = this.anns.slice();
      this.anns = [];
      this.stack.push({ t: 'clear', items });
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

  /* ================ 编辑器实现(v0.8.1:选项条内联交互) ================ */
  const TOOLS = [
    { id: 'rect', key: '1', glyph: '▭', tip: '方框(Shift 锁正方形)', kind: 'shape' },
    { id: 'ellipse', key: '2', glyph: '◯', tip: '椭圆(Shift 锁正圆)', kind: 'shape' },
    { id: 'arrow', key: '3', glyph: '↗', tip: '箭头(Shift 吸附 15°)', kind: 'shape' },
    { id: 'pen', key: '4', glyph: '✎', tip: '画笔', kind: 'shape' },
    { id: 'mosaic', key: '5', glyph: '▦', tip: '马赛克(涂抹背景像素格)', kind: 'mosaic' },
    { id: 'text', key: '6', glyph: 'T', tip: '文字(点击输入,Enter 完成)', kind: 'text' },
    { id: 'highlight', key: '7', glyph: '⚡', tip: '高亮(半透明荧光条)', kind: 'highlight' }
  ];
  // 线宽标准按网页正文 14–16px 定:细=2 中=3 粗=5(图像像素);高亮/马赛克带按视觉需要加宽
  const TIERS = { shape: [2, 3, 5], mosaic: [16, 28, 44], highlight: [14, 22, 32], text: [14, 20, 28] };
  const COLORS = ['#f5222d', '#fa8c16', '#fadb14', '#52c41a', '#1677ff', '#722ed1', '#111111', '#ffffff'];
  const MOSAIC_CELL = 12;
  const TIER_LABELS = ['细', '中', '粗'];

  const $ = (id) => document.getElementById(id);
  let overlay = null, ctx = null, stage = null, bar = null, previewBar = null, pop = null;
  let mode = 'preview';
  let tool = 'rect';
  const tierByKind = { shape: 1, mosaic: 1, highlight: 1, text: 1 };
  let colorIdx = 0;
  const targets = new Map(); // imgEl → {imgEl, blob, bmp, natW, natH, store, name}
  const order = [];
  let drag = null;
  let textInput = null;
  let selected = null;
  let raf = 0;
  let hasMain = false;

  function toolDef(id) { return TOOLS.find((t) => t.id === id); }
  function curColor() { return COLORS[colorIdx]; }
  function curWidth(kind) { const t = TIERS[kind]; return t[tierByKind[kind] || 0]; }

  function ensureDom() {
    if (overlay) return true;
    overlay = $('editlayer'); stage = $('stage'); bar = $('editbar'); previewBar = $('previewbar');
    if (!overlay || !stage || !bar || !previewBar) return false;
    ctx = overlay.getContext('2d');
    buildToolbar();
    pop = document.createElement('div');
    pop.id = 'eb-pop';
    document.body.appendChild(pop);
    window.addEventListener('resize', () => { requestRedraw(); closePop(); });
    stage.addEventListener('scroll', requestRedraw, { passive: true });
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
    mk('eb-download', '下载', '下载当前呈现(含标注)', () => emit('download'));
    const done = document.createElement('button');
    done.id = 'eb-done'; done.className = 'primary'; done.textContent = '✔ 完成';
    done.title = '结束编辑(Enter / Esc),标注保留,可再点「编辑」继续';
    done.addEventListener('click', () => setMode('preview'));
    frag.appendChild(done);
    bar.appendChild(frag);
  }

  /* -------- 工具下方的选项条:粗细(字号)+ 常用色,即选即生效 -------- */
  function openPop(def, anchorBtn) {
    closePop();
    const kind = def.kind;
    let html = '';
    TIERS[kind].forEach((w, i) => {
      html += '<button class="tier' + (i === tierByKind[kind] ? ' on' : '') + '" data-t="' + i + '">' +
        (kind === 'text' ? w + 'px' : TIER_LABELS[i]) + '</button>';
    });
    html += '<span class="psp"></span>';
    if (kind !== 'mosaic') {
      COLORS.forEach((c, i) => {
        html += '<i class="pcolor' + (i === colorIdx ? ' on' : '') + '" data-c="' + i + '" style="background:' + c + '" title="常用色"></i>';
      });
    } else {
      html += '<span class="phint">马赛克无颜色(采样画面像素)</span>';
    }
    pop.innerHTML = html;
    pop.style.display = 'flex';
    const r = anchorBtn.getBoundingClientRect();
    pop.style.left = Math.max(6, Math.min(r.left - 30, innerWidth - pop.offsetWidth - 8)) + 'px';
    pop.style.top = (r.bottom + 6) + 'px';
    pop.querySelectorAll('.tier').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      tierByKind[kind] = +b.dataset.t;
      closePop();
    }));
    pop.querySelectorAll('.pcolor').forEach((b) => b.addEventListener('click', (e) => {
      e.stopPropagation();
      colorIdx = +b.dataset.c;
      closePop();
    }));
  }
  function closePop() { if (pop) { pop.style.display = 'none'; pop.innerHTML = ''; } }

  function setTool(id) {
    tool = id;
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
    if (previewBar) previewBar.style.display = (m !== 'edit' && hasMain) ? 'flex' : 'none';
    if (m === 'edit') { setTool(tool); }
    else { commitText(); closePop(); drag = null; select(); }
    requestRedraw();
  }

  /* ---------------- 标注目标 ---------------- */
  function mount(imgEl, blob, name) {
    if (!ensureDom()) return;
    const t = { imgEl, blob, name, bmp: null, natW: 0, natH: 0, store: new Store() };
    targets.set(imgEl, t); order.push(imgEl);
    createImageBitmap(blob).then((bmp) => { t.bmp = bmp; t.natW = bmp.width; t.natH = bmp.height; requestRedraw(); });
  }
  function targetOf(imgEl) { return targets.get(imgEl); }

  /* ---------------- 绘制 ---------------- */
  function requestRedraw() {
    if (raf || !ctx) return;
    raf = requestAnimationFrame(() => { raf = 0; redraw(); });
  }
  function viewOf(t) {
    const rect = t.imgEl.getBoundingClientRect();
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
      if (!t || !t.bmp || !t.store.anns.length) continue;
      const view = viewOf(t);
      if (view.rect.bottom < 0 || view.rect.top > h || view.rect.right < 0 || view.rect.left > w) continue;
      for (const a of t.store.anns) drawAnn(ctx, a, view);
    }
    if (drag && drag.ann) {
      const t = targets.get(drag.imgEl);
      if (t && t.bmp) drawAnn(ctx, drag.ann, viewOf(t));
    }
  }

  function M(view) {
    return {
      x: (ix) => view.rect.left + ix * view.s,
      y: (iy) => view.rect.top + iy * view.s,
      v: (lv) => lv * view.s
    };
  }

  function drawAnn(c, a, view) {
    if (!a) return;
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
    } else if (a.tool === 'text') {
      if (!a._mw) measureText(a);
      c.fillStyle = col;
      c.font = Math.max(4, m.v(a.fs)) + 'px system-ui, "PingFang SC", sans-serif';
      c.textBaseline = 'top';
      c.fillText(a.text, m.x(a.x), m.y(a.y));
    }
    c.restore();
    if (selected && selected.ann === a && mode === 'edit') drawSelection(c, a, m);
  }
  /** 选中态:方框/椭圆=虚线盒+8 把手;箭头=两端圆点;文字=实线盒(颜色与文字一致,单击即可拖) */
  function drawSelection(c, a, m) {
    c.save();
    const hs = P.handlePoints(a);
    if (a.tool === 'text') {
      c.strokeStyle = a.color || '#f5222d'; c.lineWidth = 1; c.setLineDash([]);
      c.strokeRect(m.x(a.x - 2), m.y(a.y - 2), m.v((a._mw || a.text.length * a.fs) + 4), m.v((a._mh || a.fs * 1.4) + 4));
    } else {
      c.strokeStyle = '#2f6fe4'; c.lineWidth = 1;
      if (a.bw !== undefined) { c.setLineDash([4, 3]); c.strokeRect(m.x(a.x), m.y(a.y), m.v(a.bw), m.v(a.bh)); }
      if (a.tool === 'pen' || a.tool === 'arrow') {
        const bb = P.pathBBox(a.pts || [{ x: a.x0, y: a.y0 }, { x: a.x1, y: a.y1 }], a.w / 2);
        c.setLineDash([4, 3]); c.strokeRect(m.x(bb.x), m.y(bb.y), m.v(bb.w), m.v(bb.h));
      }
      for (const hd of hs) {
        c.setLineDash([]);
        c.fillStyle = '#fff'; c.strokeStyle = '#2f6fe4'; c.lineWidth = 1.2;
        if (hd.dir === 'p0' || hd.dir === 'p1') { c.beginPath(); c.arc(m.x(hd.x), m.y(hd.y), 4, 0, Math.PI * 2); c.fill(); c.stroke(); }
        else c.fillRect(m.x(hd.x) - 3.5, m.y(hd.y) - 3.5, 7, 7);
        if (a.bw !== undefined) c.strokeRect(m.x(hd.x) - 3.5, m.y(hd.y) - 3.5, 7, 7);
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
  function mainTarget() { const el = order[0]; return el && targets.get(el); }
  function eventImg(e) {
    for (const el of order) {
      const t = targets.get(el);
      if (!t || !t.bmp) continue;
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        return { t, rect: r, pt: P.screenToImg(e.clientX, e.clientY, r, t.natW, t.natH) };
      }
    }
    return null;
  }
  function hitTest(t, x, y) {
    const slop = 8 / (t.imgEl.getBoundingClientRect().width / t.natW || 1);
    const hs = selected && selected.t === t ? P.handlePoints(selected.ann) : [];
    for (const hd of hs) {
      if (Math.hypot(x - hd.x, y - hd.y) <= slop * 0.9) return { kind: 'resize', hd };
    }
    for (let i = t.store.anns.length - 1; i >= 0; i--) {
      const a = t.store.anns[i];
      if (P.hitAnn(a, x, y, slop)) return { kind: 'body', a };
    }
    return null;
  }
  function select(t, a) {
    selected = (a && t) ? { t, ann: a } : null;
  }
  function onPointerDown(e) {
    if (mode !== 'edit' || e.button !== 0) return;
    if ((bar && bar.contains(e.target)) || (pop && pop.contains(e.target))) { return; }
    closePop();
    const hit = eventImg(e);
    if (!hit) { select(); requestRedraw(); return; }
    const target = hit.t;
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
    // 空白:新画
    if (tool === 'text') { commitText(); openText(target, hit.pt); return; }
    commitText(); select();
    drag = {
      mode: 'draw', imgEl: target.imgEl, tool, kind: toolDef(tool).kind, shift: e.shiftKey,
      x0: hit.pt.x, y0: hit.pt.y, x1: hit.pt.x, y1: hit.pt.y,
      pts: [{ x: hit.pt.x, y: hit.pt.y }],
      ann: null
    };
    e.preventDefault();
  }
  function imgPoint(e) {
    for (const el of order) {
      const t = targets.get(el);
      if (!t || !t.bmp) continue;
      const r = el.getBoundingClientRect();
      const s = r.width / t.natW || 1;
      return P.screenToImg(e.clientX, e.clientY, r, t.natW, t.natH);
    }
    return null;
  }
  function onPointerMove(e) {
    const p0 = imgPoint(e);
    if (!drag) { updateHoverCursor(e, p0); return; }
    const t = targets.get(drag.imgEl); if (!t) return;
    const rect = t.imgEl.getBoundingClientRect();
    const p = P.screenToImg(e.clientX, e.clientY, rect, t.natW, t.natH);
    if (drag.mode === 'draw') {
      drag.x1 = p.x; drag.y1 = p.y; drag.shift = e.shiftKey;
      if (drag.kind === 'mosaic' || drag.tool === 'pen' || drag.tool === 'highlight') {
        const last = drag.pts[drag.pts.length - 1];
        if (Math.hypot(p.x - last.x, p.y - last.y) > 2) drag.pts.push({ x: p.x, y: p.y });
      }
      drag.ann = buildDragAnn();
    } else if (drag.mode === 'resize') {
      const a = drag.ann;
      if (a.tool === 'arrow') {
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
  function updateHoverCursor(e, p0) {
    let cur = mode === 'edit' ? (tool === 'text' ? 'text' : 'crosshair') : '';
    if (mode === 'edit' && p0) {
      const t0 = firstTargetAt(e);
      if (t0) {
        const hs = selected && selected.t === t0 ? P.handlePoints(selected.ann) : [];
        const slop = 8 / (t0.imgEl.getBoundingClientRect().width / t0.natW || 1);
        for (const hd of hs) if (Math.hypot(p0.x - hd.x, p0.y - hd.y) <= slop * 0.9) { cur = hd.c; break; }
        if (cur === 'crosshair') {
          for (let i = t0.store.anns.length - 1; i >= 0; i--) {
            if (P.hitAnn(t0.store.anns[i], p0.x, p0.y, slop)) { cur = 'move'; break; }
          }
        }
      }
    }
    if (document.body.dataset.cursor !== cur) {
      document.body.dataset.cursor = cur;
      const st = document.getElementById('stage'); if (st) st.style.cursor = cur || '';
    }
  }
  function firstTargetAt(e) {
    for (const el of order) {
      const t = targets.get(el);
      if (!t || !t.bmp) continue;
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
    const t = firstTargetAt(e); if (!t || !t.bmp) return;
    const rect = t.imgEl.getBoundingClientRect();
    const p = P.screenToImg(e.clientX, e.clientY, rect, t.natW, t.natH);
    const slop = 8 / (rect.width / t.natW || 1);
    for (let i = t.store.anns.length - 1; i >= 0; i--) {
      const a = t.store.anns[i];
      if (a.tool === 'text' && P.hitAnn(a, p.x, p.y, slop)) { select(t, a); openText(t, { x: a.x, y: a.y }, a); return; }
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

  /* ---------------- 文字 ---------------- */
  function openText(t, pt, existing) {
    commitText();
    const rect = t.imgEl.getBoundingClientRect();
    const inp = document.createElement('input');
    inp.id = 'eb-textinput'; inp.type = 'text';
    inp.style.left = (rect.left + pt.x / t.natW * rect.width) + 'px';
    inp.style.top = (rect.top + pt.y / t.natH * rect.height) + 'px';
    inp.style.color = existing ? (existing.color || curColor()) : curColor();
    inp.style.font = Math.max(6, (existing ? existing.fs : curWidth('text')) * (rect.width / t.natW)) + 'px system-ui';
    if (existing) inp.value = existing.text;
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commitText();
      if (e.key === 'Escape') { if (existing) inp.value = existing.text; else inp.value = ''; commitText(); }
    });
    document.body.appendChild(inp);
    textInput = { inp, t, pt, existing };
    if (existing) { inp.focus(); inp.select(); } else setTimeout(() => inp.focus(), 0);
  }
  function commitText() {
    if (!textInput) return;
    const { inp, t, pt, existing } = textInput;
    const v = inp.value.trim();
    const fs = existing ? existing.fs : curWidth('text');
    const color = existing ? existing.color : curColor();
    textInput = null; inp.remove();
    if (existing) {
      if (v && v !== existing.text) { t.store.edit(existing, P.snap(existing)); existing.text = v; t.store.stack[t.store.stack.length - 1].after = P.snap(existing); }
      requestRedraw(); return;
    }
    if (v) {
      const a = { tool: 'text', x: pt.x, y: pt.y, text: v, color, fs };
      measureText(a);
      t.store.add(a);
      select(t, a);
      requestRedraw();
    }
  }
  let measCtx = null;
  function measureText(a) {
    if (!measCtx) { measCtx = document.createElement('canvas').getContext('2d'); }
    measCtx.font = a.fs + 'px system-ui, "PingFang SC", sans-serif';
    a._mw = measCtx.measureText(a.text).width;
    a._mh = a.fs * 1.4;
  }

  /* ---------------- 栈操作 ---------------- */
  function activeTargets() { return order.map((el) => targets.get(el)).filter(Boolean); }
  function doUndo() { for (const t of activeTargets()) if (t.store.undo()) break; requestRedraw(); }
  function doRedo() { for (const t of activeTargets()) if (t.store.redo()) break; requestRedraw(); }
  function doReset() { let hit = false; for (const t of activeTargets()) if (t.store.clearAll()) hit = true; if (hit) requestRedraw(); }

  /* ---------------- 键盘 ---------------- */
  function onKey(e) {
    if (textInput || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const meta = e.ctrlKey || e.metaKey;
    if (mode === 'edit') {
      if (meta && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
      if (meta && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); doRedo(); return; }
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); setMode('preview'); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); if (selected) { const a = selected.ann; const tt = selected.t; const i = tt.store.anns.indexOf(a); if (i >= 0) { tt.store.stack.push({ t: 'del', item: a, index: i }); tt.store.redone.length = 0; tt.store.anns.splice(i, 1); } select(); } else doUndo(); requestRedraw(); return; }
      if (meta && e.key === 'c') return; // 让宿主复制
      if (/^[1-7]$/.test(e.key)) {
        const td = TOOLS.find((x) => x.key === e.key);
        if (td) { setTool(td.id); closePop(); }
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
    const view = { rect: { left: 0, top: 0, width: t.natW }, natW: t.natW, natH: t.natH, bmp: t.bmp, s: 1 };
    for (const a of t.store.anns) { a._pal = null; drawAnn(cc, a, view); }
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('合成失败'))), 'image/png'));
  }

  function emit(kind) {
    CS.Edit._emit && CS.Edit._emit(kind, mainTarget());
  }

  CS.Edit = {
    mount, targetOf, exportBlob, setMode, get mode() { return mode; },
    redraw: requestRedraw,
    setHasMain(v) {
      hasMain = !!v;
      const p = document.getElementById('previewbar');
      if (p && mode === 'preview') p.style.display = v ? 'flex' : 'none';
    },
    _emit: null
  };
})();
