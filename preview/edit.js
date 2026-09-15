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

  /** 标注栈:add/clear 两种操作,undo/redo 完整可逆 */
  class Store {
    constructor() { this.anns = []; this.stack = []; this.redone = []; }
    add(a) { this.anns.push(a); this.stack.push({ t: 'add', item: a }); this.redone.length = 0; }
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
      else this.anns.push(...op.items);
      return op;
    }
    redo() {
      const op = this.redone.pop();
      if (!op) return null;
      this.stack.push(op);
      if (op.t === 'add') this.anns.push(op.item);
      else for (const it of op.items) { const i = this.anns.lastIndexOf(it); if (i >= 0) this.anns.splice(i, 1); }
      return op;
    }
    get empty() { return this.anns.length === 0 && this.stack.length === 0; }
  }

  CS.editP = P;
  CS.Store = Store;

  if (typeof document === 'undefined') return; // node 下只导出纯逻辑

  /* ================ 编辑器实现 ================ */
  const TOOLS = [
    { id: 'rect', key: '1', glyph: '▭', tip: '方框(Shift 正方形)' },
    { id: 'ellipse', key: '2', glyph: '◯', tip: '椭圆(Shift 正圆)' },
    { id: 'arrow', key: '3', glyph: '↗', tip: '箭头(Shift 吸附15°)' },
    { id: 'pen', key: '4', glyph: '✎', tip: '画笔' },
    { id: 'mosaic', key: '5', glyph: '▦', tip: '马赛克(拖拽涂抹)' },
    { id: 'text', key: '6', glyph: 'T', tip: '文字(点击落字,Enter 完成)' },
    { id: 'highlight', key: '7', glyph: '⚡', tip: '高亮(半透明荧光条)' }
  ];
  const COLORS = ['#f5222d', '#fa8c16', '#fadb14', '#52c41a', '#1677ff', '#722ed1', '#111111', '#ffffff'];
  const WIDTH_TIERS = { shape: [3, 6, 12], brush: [16, 28, 48], highlight: [22, 36, 56], text: [14, 20, 28] };
  const MOSAIC_CELL = 12;

  const $ = (id) => document.getElementById(id);
  let overlay = null, ctx = null, stage = null, bar = null, previewBar = null;
  let mode = 'preview';
  let tool = 'rect', colorIdx = 0, tier = 1;
  const targets = new Map(); // imgEl → {imgEl, blob, bmp, natW, natH, store, name}
  const order = [];          // 挂载顺序(第一个=主图)
  let drag = null;           // 正在画的预览标注
  let textInput = null;
  let raf = 0;

  function curColor() { return COLORS[colorIdx]; }
  function curWidth(kind) { const t = WIDTH_TIERS[kind]; return t[P.clamp(tier, 0, t.length - 1)]; }

  function ensureDom() {
    if (overlay) return true;
    overlay = $('editlayer'); stage = $('stage'); bar = $('editbar'); previewBar = $('previewbar');
    if (!overlay || !stage || !bar || !previewBar) return false;
    ctx = overlay.getContext('2d');
    buildToolbar();
    window.addEventListener('resize', requestRedraw);
    stage.addEventListener('scroll', requestRedraw, { passive: true });
    window.addEventListener('scroll', requestRedraw, { passive: true });
    stage.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('keydown', onKey);
    return true;
  }

  function buildToolbar() {
    const frag = document.createDocumentFragment();
    for (const t of TOOLS) {
      const b = document.createElement('button');
      b.dataset.tool = t.id; b.textContent = t.glyph; b.title = t.tip + ' (快捷键 ' + t.key + ')';
      b.addEventListener('click', () => setTool(t.id));
      frag.appendChild(b);
    }
    const sep = () => { const s = document.createElement('span'); s.className = 'esep'; return s; };
    frag.appendChild(sep());
    const colorBtn = document.createElement('button');
    colorBtn.id = 'eb-color'; colorBtn.title = '颜色(点击切换,展开选色)';
    colorBtn.innerHTML = '<span class="cdot"></span><span class="cmenu"></span>';
    colorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = colorBtn.querySelector('.cmenu');
      const open = menu.classList.toggle('on');
      if (open && !menu.childElementCount) {
        COLORS.forEach((c, i) => {
          const d = document.createElement('i');
          d.style.background = c;
          d.addEventListener('click', (ev) => { ev.stopPropagation(); colorIdx = i; syncColorBtn(); menu.classList.remove('on'); requestRedraw(); });
          menu.appendChild(d);
        });
      }
      if (!open) return;
      const off = () => { menu.classList.remove('on'); document.removeEventListener('pointerdown', off); };
      document.addEventListener('pointerdown', off);
    });
    frag.appendChild(colorBtn);
    const wBtn = document.createElement('button');
    wBtn.id = 'eb-width'; wBtn.title = '粗细/字号档(点击循环 细/中/粗;文字工具对应 14/20/28)';
    wBtn.addEventListener('click', () => { tier = (tier + 1) % 3; syncWidthBtn(); requestRedraw(); });
    frag.appendChild(wBtn);
    frag.appendChild(sep());
    const mk = (id, txt, tip, fn) => {
      const b = document.createElement('button');
      b.id = id; b.textContent = txt; b.title = tip; b.addEventListener('click', fn);
      frag.appendChild(b); return b;
    };
    mk('eb-undo', '↶', '撤销 (Ctrl/Cmd+Z)', doUndo);
    mk('eb-redo', '↷', '重做 (Ctrl/Cmd+Shift+Z)', doRedo);
    mk('eb-reset', '还原', '清除全部标注(可撤销)', doReset);
    frag.appendChild(sep());
    mk('eb-copy', '复制', '复制带标注图片到剪贴板', () => emit('copy'));
    mk('eb-download', '下载', '下载带标注图片', () => emit('download'));
    const done = document.createElement('button');
    done.id = 'eb-done'; done.className = 'primary'; done.textContent = '✔ 完成'; done.title = '结束编辑 (Enter / Esc),标注保留';
    done.addEventListener('click', () => setMode('preview'));
    frag.appendChild(done);
    bar.appendChild(frag);
    syncColorBtn(); syncWidthBtn();
  }
  function syncColorBtn() {
    const b = $('eb-color'); if (!b) return;
    b.querySelector('.cdot').style.background = curColor();
  }
  function syncWidthBtn() {
    const b = $('eb-width'); if (!b) return;
    b.textContent = ['─', '━', '▊'][tier];
  }

  function setTool(id) {
    tool = id;
    for (const b of bar.querySelectorAll('[data-tool]')) b.classList.toggle('on', b.dataset.tool === id);
    document.body.dataset.tool = id;
    if (id !== 'text') commitText();
  }

  let hasMain = false; // 是否存在主图(单张/合成场景);分卷列表场景由 preview.js 关闭底栏
  function setMode(m) {
    if (m === mode) return;
    if (m === 'edit' && !order.length) return;
    mode = m;
    document.body.classList.toggle('editing', m === 'edit');
    const barEl = $('editbar'), pbarEl = $('previewbar');
    if (barEl) barEl.style.display = m === 'edit' ? 'flex' : 'none';
    if (pbarEl) pbarEl.style.display = (m !== 'edit' && hasMain) ? 'flex' : 'none';
    if (m === 'edit') { setTool(tool); }
    else { commitText(); drag = null; }
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
  function redraw() {
    const dpr = window.devicePixelRatio || 1;
    const w = innerWidth, h = innerHeight;
    if (overlay.width !== w * dpr || overlay.height !== h * dpr) {
      overlay.width = w * dpr; overlay.height = h * dpr;
      overlay.style.width = w + 'px'; overlay.style.height = h + 'px';
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (const imgEl of order) {
      const t = targets.get(imgEl);
      if (!t || !t.bmp || !t.store.anns.length) continue;
      const rect = imgEl.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > h || rect.right < 0 || rect.left > w) continue;
      const view = { rect, natW: t.natW, natH: t.natH, bmp: t.bmp, s: rect.width / t.natW };
      for (const a of t.store.anns) drawAnn(ctx, a, view);
    }
    if (drag) { const t = targets.get(drag.imgEl); if (t && t.bmp) drawAnn(ctx, drag.ann, { rect: t.imgEl.getBoundingClientRect(), natW: t.natW, natH: t.natH, bmp: t.bmp, s: t.imgEl.getBoundingClientRect().width / t.natW }); }
  }

  function M(view) { // 图像px → screen px 闭包
    return {
      x: (ix) => view.rect.left + ix * view.s,
      y: (iy) => view.rect.top + iy * view.s,
      v: (lv) => lv * view.s
    };
  }

  function drawAnn(c, a, view) {
    const m = M(view);
    c.save();
    c.lineCap = 'round'; c.lineJoin = 'round';
    const col = a.color || '#f5222d';
    if (a.tool === 'rect') {
      c.strokeStyle = col; c.lineWidth = m.v(a.w);
      c.strokeRect(m.x(a.x), m.y(a.y), m.v(a.bw), m.v(a.bh));
    } else if (a.tool === 'ellipse') {
      c.strokeStyle = col; c.lineWidth = m.v(a.w);
      c.beginPath();
      c.ellipse(m.x(a.x + a.bw / 2), m.y(a.y + a.bh / 2), Math.max(1, m.v(a.bw / 2)), Math.max(1, m.v(a.bh / 2)), 0, 0, Math.PI * 2);
      c.stroke();
    } else if (a.tool === 'arrow') {
      drawArrow(c, a.x0, a.y0, a.x1, a.y1, m, col, Math.max(1.5, m.v(a.w)));
    } else if (a.tool === 'pen') {
      c.strokeStyle = col; c.lineWidth = m.v(a.w);
      path(c, a.pts, m); c.stroke();
    } else if (a.tool === 'highlight') {
      c.strokeStyle = col; c.globalAlpha = 0.5; c.lineWidth = m.v(a.w);
      path(c, a.pts, m); c.stroke();
    } else if (a.tool === 'mosaic') {
      paintMosaic(c, a, view, m);
    } else if (a.tool === 'text') {
      c.fillStyle = col;
      c.font = Math.max(4, m.v(a.fs)) + 'px system-ui, "PingFang SC", sans-serif';
      c.textBaseline = 'top';
      c.fillText(a.text, m.x(a.x), m.y(a.y));
    }
    c.restore();
  }
  function path(c, pts, m) {
    c.beginPath();
    c.moveTo(m.x(pts[0].x), m.y(pts[0].y));
    for (let i = 1; i < pts.length; i++) c.lineTo(m.x(pts[i].x), m.y(pts[i].y));
  }
  function drawArrow(c, x0, y0, x1, y1, m, col, lwScreen) {
    const sx = m.x(x0), sy = m.y(y0), ex = m.x(x1), ey = m.y(y1);
    const ang = Math.atan2(ey - sy, ex - sx);
    const dist = Math.hypot(ex - sx, ey - sy);
    const head = Math.min(dist * 0.4, Math.max(8, lwScreen * 4.2));
    c.strokeStyle = col; c.fillStyle = col; c.lineWidth = lwScreen;
    c.beginPath();
    c.moveTo(sx, sy);
    c.lineTo(ex - Math.cos(ang) * head * 0.7, ey - Math.sin(ang) * head * 0.7);
    c.stroke();
    c.beginPath();
    c.moveTo(ex, ey);
    c.lineTo(ex - Math.cos(ang - 0.42) * head, ey - Math.sin(ang - 0.42) * head);
    c.lineTo(ex - Math.cos(ang) * head * 0.55, ey - Math.sin(ang) * head * 0.55);
    c.lineTo(ex - Math.cos(ang + 0.42) * head, ey - Math.sin(ang + 0.42) * head);
    c.closePath(); c.fill();
  }

  /** 马赛克:按 bbox 降采样再放大(smoothing off),按笔刷轨迹做 destination-in 遮罩 */
  function paintMosaic(c, a, view, m) {
    const bb = P.pathBBox(a.pts, a.w / 2);
    const clipX0 = Math.max(0, bb.x), clipY0 = Math.max(0, bb.y);
    const clipX1 = Math.min(view.natW, bb.x + bb.w), clipY1 = Math.min(view.natH, bb.y + bb.h);
    if (!(clipX1 > clipX0 && clipY1 > clipY0)) return;
    const iw = clipX1 - clipX0, ih = clipY1 - clipY0;
    const sw = Math.max(1, Math.round(m.v(iw))), sh = Math.max(1, Math.round(m.v(ih)));
    if (sw * sh > 4e7) return; // 屏上面积极大的极端情况保护
    // 1) 低分辨率像素块源
    const cols = Math.max(1, Math.round(iw / MOSAIC_CELL)), rows = Math.max(1, Math.round(ih / MOSAIC_CELL));
    const low = document.createElement('canvas'); low.width = cols; low.height = rows;
    const lc = low.getContext('2d');
    lc.drawImage(view.bmp, clipX0, clipY0, iw, ih, 0, 0, cols, rows);
    const big = document.createElement('canvas'); big.width = sw; big.height = sh;
    const bc = big.getContext('2d');
    bc.imageSmoothingEnabled = false;
    bc.drawImage(low, 0, 0, cols, rows, 0, 0, sw, sh);
    // 2) 轨迹遮罩
    const mask = document.createElement('canvas'); mask.width = sw; mask.height = sh;
    const mc = mask.getContext('2d');
    mc.strokeStyle = '#000'; mc.lineWidth = Math.max(2, m.v(a.w)); mc.lineCap = 'round'; mc.lineJoin = 'round';
    mc.beginPath();
    mc.moveTo(m.x(a.pts[0].x) - m.x(clipX0), m.y(a.pts[0].y) - m.y(clipY0));
    for (let i = 1; i < a.pts.length; i++) mc.lineTo(m.x(a.pts[i].x) - m.x(clipX0), m.y(a.pts[i].y) - m.y(clipY0));
    mc.stroke();
    mc.globalCompositeOperation = 'destination-in';
    mc.drawImage(big, 0, 0);
    c.drawImage(mask, m.x(clipX0), m.y(clipY0), sw, sh);
  }

  /* ---------------- 指针交互 ---------------- */
  function mainTarget() { const el = order[0]; return el && targets.get(el); }
  function eventImg(e) {
    for (const el of order) {
      const r = el.getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
        return { t: targets.get(el), rect: r, pt: P.screenToImg(e.clientX, e.clientY, r, targets.get(el).natW, targets.get(el).natH) };
      }
    }
    return null;
  }

  function onPointerDown(e) {
    if (mode !== 'edit' || e.button !== 0 || bar.contains(e.target)) return;
    const hit = eventImg(e);
    if (!hit || !hit.t.bmp) return;
    if (tool === 'text') { commitText(); openText(hit.t, hit.pt); return; }
    commitText();
    const kind = tool === 'pen' || tool === 'mosaic' || tool === 'highlight' ? 'brush' : 'shape';
    drag = {
      imgEl: hit.t.imgEl, tool, kind, shift: e.shiftKey,
      x0: hit.pt.x, y0: hit.pt.y, x1: hit.pt.x, y1: hit.pt.y,
      pts: [{ x: hit.pt.x, y: hit.pt.y }],
      ann: null
    };
    e.preventDefault();
  }
  function onPointerMove(e) {
    if (!drag) return;
    const t = targets.get(drag.imgEl); if (!t) return;
    const rect = t.imgEl.getBoundingClientRect();
    const p = P.screenToImg(e.clientX, e.clientY, rect, t.natW, t.natH);
    drag.x1 = p.x; drag.y1 = p.y; drag.shift = e.shiftKey;
    if (drag.kind === 'brush') {
      const last = drag.pts[drag.pts.length - 1];
      if (Math.hypot(p.x - last.x, p.y - last.y) > 2) drag.pts.push({ x: p.x, y: p.y });
    }
    drag.ann = buildDragAnn();
    requestRedraw();
  }
  function onPointerUp() {
    if (!drag) return;
    const ann = buildDragAnn();
    const t = targets.get(drag.imgEl);
    drag = null;
    if (ann && t) { t.store.add(ann); requestRedraw(); }
    else requestRedraw();
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
    if (drag.kind === 'brush') {
      const wKind = drag.tool === 'highlight' ? 'highlight' : 'brush';
      if (drag.pts.length < 2) return null;
      return Object.assign(base, { pts: drag.pts.map((p) => ({ x: p.x, y: p.y })), w: curWidth(wKind) });
    }
    return null;
  }

  /* ---------------- 文字 ---------------- */
  function openText(t, pt) {
    commitText();
    const rect = t.imgEl.getBoundingClientRect();
    const inp = document.createElement('input');
    inp.id = 'eb-textinput'; inp.type = 'text';
    inp.style.left = (rect.left + pt.x / t.natW * rect.width) + 'px';
    inp.style.top = (rect.top + pt.y / t.natH * rect.height) + 'px';
    inp.style.color = curColor();
    inp.style.font = Math.max(6, curWidth('text') * (rect.width / t.natW)) + 'px system-ui';
    inp.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') commitText();
      if (e.key === 'Escape') { inp.value = ''; commitText(); }
    });
    document.body.appendChild(inp);
    textInput = { inp, t, pt };
    setTimeout(() => inp.focus(), 0);
  }
  function commitText() {
    if (!textInput) return;
    const { inp, t, pt } = textInput;
    const v = inp.value.trim();
    textInput = null; inp.remove();
    if (v) {
      t.store.add({ tool: 'text', x: pt.x, y: pt.y, text: v, color: curColor(), fs: curWidth('text') });
      requestRedraw();
    }
  }

  /* ---------------- 栈操作 ---------------- */
  function activeTargets() { return order.map((el) => targets.get(el)).filter(Boolean); }
  function doUndo() { for (const t of activeTargets()) if (t.store.undo()) break; requestRedraw(); }
  function doRedo() { for (const t of activeTargets()) if (t.store.redo()) break; requestRedraw(); }
  function doReset() { for (const t of activeTargets()) t.store.clearAll(); requestRedraw(); }

  /* ---------------- 键盘 ---------------- */
  function onKey(e) {
    if (textInput || e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    const meta = e.ctrlKey || e.metaKey;
    if (mode === 'edit') {
      if (meta && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); return; }
      if (meta && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); doRedo(); return; }
      if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); setMode('preview'); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); doUndo(); return; }
    } else if (e.key === 'e' || e.key === 'E') {
      const t = mainTarget(); if (t) { setMode('edit'); }
      return;
    }
    if (mode === 'edit' && /^[1-7]$/.test(e.key)) {
      const td = TOOLS.find((x) => x.key === e.key);
      if (td) setTool(td.id);
    }
  }

  /* ---------------- 导出(所见即所得) ---------------- */
  async function exportBlob(imgEl) {
    const t = imgEl ? targets.get(imgEl) : mainTarget();
    if (!t || !t.bmp) return null;
    if (!t.store.anns.length) return null; // 当前无标注 → 原 blob(所见即所得 + 零回归)
    const c = document.createElement('canvas');
    c.width = t.natW; c.height = t.natH;
    const cc = c.getContext('2d');
    cc.drawImage(t.bmp, 0, 0);
    const view = { rect: { left: 0, top: 0, width: t.natW }, natW: t.natW, natH: t.natH, bmp: t.bmp, s: 1 };
    // 导出态:map 直接以图像像素为单位(rect 宽=natW,s=1)
    view.x = 0;
    for (const a of t.store.anns) drawAnn(cc, a, view);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('合成失败'))), 'image/png'));
  }

  function emit(kind) {
    const t = mainTarget();
    CS.Edit._emit && CS.Edit._emit(kind, t);
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
