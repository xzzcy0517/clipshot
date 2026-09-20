'use strict';
/**
 * 预览页:meta → chunk 分块拉取 SW 暂存截图;多段按解码高度堆叠/分卷;
 * 缩放/下载/复制 + P007 微信式编辑(双状态:默认预览态,点「编辑」才出工具栏)。
 * 编辑逻辑在 edit.js;导出所见即所得,无标注时与旧版行为逐字节一致。
 * P014 画板教学化:滑杆/数字无级缩放;＋图片/Ctrl+V 粘贴续传;卡片可移除;
 * 画板背景(透明/常用色/自定义);新建空白画布;画板标注层(空白处可画)随导出合成。
 */
(function () {
  const CS = globalThis.ClipShot;
  const Edit = CS.Edit;
  const $ = (id) => document.getElementById(id);
  const jobId = new URLSearchParams(location.search).get('job');

  let meta = null;
  let currentBlob = null;   // 主图原始 blob(未编辑时导出直通它)
  let imgEl = null;         // 主图(单图/合成图);纯多图列表时为 null
  let naturalW = 0, naturalH = 0; // 主图设备像素
  let activeImg = null;     // P012:当前选中图,缩放/复制/下载都作用于它
  const scales = new Map(); // img → 缩放比(1 = 设备像素 / dpr 的 CSS 尺寸)
  const blobOf = new Map(); // img → 原始 blob(主图与列表项)
  /* P013 画板:卡片自由拖动,多卡片时导出按布局合成 */
  const cards = [];         // {el, img, x, y},顺序 = 构建顺序(自动堆叠按此序)
  let boardTouched = false; // 用户拖过卡片即不再自动堆叠
  let boardDrag = null;
  let openStateEl = null;   // P009 空态框(有内容后即移除)
  let cardSeq = 0;          // 粘贴/添加图片的命名序号
  let wrapW = 0, wrapH = 0; // relayout 记忆,不变则不重排(防 _boardChange 回环)
  /* P014 画板背景:transparent 或任意颜色;localStorage 记忆,导出合成时垫底色 */
  let boardBg = 'transparent';
  try { boardBg = localStorage.getItem('cs.boardBg') || 'transparent'; } catch (e) { /* 无存储权限时用默认 */ }

  function fail(text) {
    $('info').textContent = '';
    const s = $('status');
    s.textContent = text;
    s.classList.remove('hidden');
  }

  async function send(msg) {
    return chrome.runtime.sendMessage(msg);
  }

  function fmtBytes(b) {
    if (b > 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
    return (b / 1024).toFixed(0) + ' KB';
  }

  async function init() {
    if (!jobId) return openState(); // P009:无任务参数 = 图片工作台空态,可直接上传
    const m = await send({ type: CS.MSG.IMG_META, jobId });
    if (!m || !m.ok) return fail(CS.errText((m && m.error) || CS.ERR.STALE_JOB));
    meta = m;
    if (m.items && m.items.length) return initItems(m); // P009 多图上传

    // 分块拉取
    const segB64 = new Array(m.segments.length).fill('');
    for (let i = 0; i < m.chunkCount; i++) {
      const c = await send({ type: CS.MSG.IMG_CHUNK, jobId, index: i });
      if (!c || !c.ok) return fail(CS.errText((c && c.error) || CS.ERR.STALE_JOB));
      segB64[c.seg] += c.b64;
      $('info').textContent = `接收数据 ${Math.round((i + 1) / m.chunkCount * 100)}%`;
    }
    send({ type: CS.MSG.IMG_DONE, jobId }).catch(() => {}); // 释放 SW 内存

    const blobs = segB64.map(b64 => new Blob([CS.util.b64Decode(b64)], { type: meta.mime }));
    if (blobs.length === 1) {
      showBlob(blobs[0]);
    } else {
      await composeSegments(blobs);
    }
    renderNotes();
    renderInfo();
  }

  /** P009 空态:无 job 时给上传/空白画布/粘贴入口(上传完带 jobId 重进本页) */
  function openState() {
    $('info').textContent = '图片工作台';
    const box = document.createElement('div');
    box.className = 'open-state';
    const tip = document.createElement('p');
    tip.textContent = '上传图片后即可标注、排版、转格式、压缩;也可新建空白画布直接作画(支持 Ctrl+V 粘贴)';
    const btn = document.createElement('button');
    btn.className = 'primary'; btn.textContent = '打开图片编辑';
    const blank = document.createElement('button');
    blank.textContent = '新建空白画布'; blank.style.marginLeft = '8px';
    blank.addEventListener('click', () => makeBlankCanvas());
    const fi = document.createElement('input');
    fi.type = 'file'; fi.accept = 'image/*'; fi.multiple = true; fi.hidden = true;
    btn.addEventListener('click', () => fi.click());
    fi.addEventListener('change', async () => {
      const files = [...(fi.files || [])];
      fi.value = '';
      if (!files.length) return;
      btn.disabled = true;
      const r = await CS.uploadImages(files, (t) => { tip.textContent = t; });
      btn.disabled = false;
      if (!r.ok) { tip.textContent = '上传失败:' + (r.error === 'NO_IMAGE' ? '所选文件不是图片' : CS.errText(r.error)); return; }
      location.href = 'preview.html?job=' + r.jobId;
    });
    box.append(tip, btn, blank, fi);
    openStateEl = box;
    $('wrap').appendChild(box);
    applyBoardBg();
    relayout();
  }
  /** 有内容后撤掉空态框 */
  function leaveOpenState() {
    if (openStateEl) { openStateEl.remove(); openStateEl = null; }
  }

  /** P009 多图上传:逐张拉取进画板(P013),自动堆叠,可拖动摆位,下载按布局合成 */
  async function initItems(m) {
    for (let i = 0; i < m.items.length; i++) {
      const it = m.items[i];
      let b64 = '';
      for (let c = 0; c < it.chunkCount; c++) {
        const r = await send({ type: CS.MSG.IMG_CHUNK, jobId, item: i, index: c });
        if (!r || !r.ok) return fail(CS.errText((r && r.error) || CS.ERR.STALE_JOB));
        b64 += r.b64;
        $('info').textContent = `接收图片 ${i + 1}/${m.items.length} ${Math.round((c + 1) / it.chunkCount * 100)}%`;
      }
      const blob = new Blob([CS.util.b64Decode(b64)], { type: it.mime });
      $('wrap').appendChild(buildCard(it.name, blob, it.name).el);
      (it.notes || []).forEach(addNote);
    }
    send({ type: CS.MSG.IMG_DONE, jobId }).catch(() => {});
    Edit.setHasMain(true);
    $('info').textContent = '共 ' + m.items.length + ' 张图片,画板可拖动摆位,下载按布局导出';
    toast('画板模式:拖动图片摆位置,下载按布局导出');
    // 文件名兜底(选中后由 selectImg 逐张刷新信息行)
    meta = { name: m.items[0].name, mime: m.items[0].mime, notes: [], widthPx: m.items[0].widthPx, heightPx: m.items[0].heightPx };
  }

  function showBlob(blob) {
    currentBlob = blob;
    const card = buildCard('', blob, meta.name, (img) => {
      naturalW = img.naturalWidth; naturalH = img.naturalHeight;
      renderInfo();
      Edit.setHasMain(true);
    });
    imgEl = card.img;
    $('wrap').appendChild(card.el);
  }

  /** P012:选中一张图(单图恒为唯一选中),右下面板的缩放/复制/下载作用于它 */
  function selectImg(img) {
    if (!img) return;
    activeImg = img;
    if (Edit.setActive) Edit.setActive(img);
    document.querySelectorAll('.board-card img.sel').forEach((x) => x.classList.remove('sel'));
    if (img.closest('.board-card')) img.classList.add('sel');
    const t = Edit.targetOf(img);
    const blob = blobOf.get(img);
    const bits = [];
    if (t && t.name) bits.push(t.name);
    if (img.naturalWidth) bits.push(img.naturalWidth + ' × ' + img.naturalHeight + ' px');
    if (blob) bits.push(fmtMime(blob.type) + ' · ' + fmtBytes(blob.size));
    if (bits.length) $('info').textContent = bits.join(' · ');
    if (img.naturalWidth) applyScale();
  }

  /**
   * 多段合成(P003 分卷):按各段实际解码高度装箱(每卷 ≤30000 设备 px),
   * 一卷装下全部 → 单张合成长图;否则每卷一张。装箱失败退化为逐段列表。
   */
  async function composeSegments(blobs) {
    try {
      const bitmaps = await Promise.all(blobs.map(b => createImageBitmap(b)));
      const vols = CS.geom.planVolumes(bitmaps.map(b => b.height), 30000);
      const compose = async (from, count) => {
        const part = bitmaps.slice(from, from + count);
        const h = part.reduce((n, b) => n + b.height, 0);
        const w = part.reduce((n, b) => Math.max(n, b.width), 0);
        if (h > 32767 || w > 32767) throw new Error('canvas-overflow');
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        let y = 0;
        for (const bmp of part) { ctx.drawImage(bmp, 0, y); y += bmp.height; }
        return new Promise((res, rej) => canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob failed')), meta.mime));
      };
      if (vols.length === 1) {
        showBlob(await compose(0, bitmaps.length));
        addNote('长图由 ' + blobs.length + ' 段自动拼接为一张');
        return;
      }
      $('info').textContent = `整页过长,已分 ${vols.length} 卷展示(每卷一张长图)`;
      for (let vi = 0; vi < vols.length; vi++) {
        const v = vols[vi];
        const blob = await compose(v.from, v.count);
        if (vi === 0) currentBlob = blob;
        $('wrap').appendChild(buildCard(`第 ${vi + 1} / ${vols.length} 卷(${v.count} 段,${v.height} px)`,
          blob, dotName(meta.name, `-vol${vi + 1}`)).el);
      }
      Edit.setHasMain(true);
      addNote('整图超出浏览器画布上限,已分 ' + vols.length + ' 卷;画板中按卷序堆叠,可拖动摆位,下载按布局合成');
    } catch (e) {
      // 回退:分段展示 + 逐段下载
      $('info').textContent = '图片超出画布上限,按分段展示';
      blobs.forEach((blob, i) => {
        $('wrap').appendChild(buildCard(`第 ${i + 1} / ${blobs.length} 段`, blob, dotName(meta.name, '-' + (i + 1))).el);
      });
      Edit.setHasMain(true);
      currentBlob = blobs[0];
      addNote('整图超出浏览器画布限制,已按分段展示;画板中可拖动摆位,下载按布局合成');
    }
  }

  /* ---------------- P013 画板:卡片自由拖动,多卡片导出按布局合成 ---------------- */
  function cardDispSize(card) {
    const dpr = window.devicePixelRatio || 1;
    const s = scales.get(card.img) || 1;
    return { w: card.img.naturalWidth / dpr * s, h: card.img.naturalHeight / dpr * s };
  }
  /** 未手动拖过:按构建顺序纵向堆叠(分卷/多图天然成序) */
  function autoStack() {
    let y = 0;
    for (const c of cards) {
      if (!c.img.naturalWidth) continue;
      c.x = 0; c.y = y;
      c.el.style.left = '0px';
      c.el.style.top = y + 'px';
      y += cardDispSize(c).h + 24;
    }
  }
  /** 画板 bbox(布局 CSS px):卡片 ∪ P014 画板标注;原点可为负(标注画出左上界) */
  function boardBBox() {
    let x0 = null, y0 = null, x1 = 0, y1 = 0;
    const union = (x, y, w, h) => {
      if (x0 === null) { x0 = x; y0 = y; x1 = x + w; y1 = y + h; return; }
      x0 = Math.min(x0, x); y0 = Math.min(y0, y);
      x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
    };
    for (const c of cards) {
      if (!c.img.naturalWidth) continue;
      const d = cardDispSize(c);
      union(c.x, c.y, d.w, d.h);
    }
    const ab = Edit.boardAnnsBBox && Edit.boardAnnsBBox();
    if (ab) union(ab.x, ab.y, ab.w, ab.h);
    if (x0 === null) return { x: 0, y: 0, w: 0, h: 0 };
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  /** wrap 尺寸 = 内容右/下界 ∪ 视口(留白供画板作画);导出只用 boardBBox,不带视口余量 */
  function relayout() {
    const bb = boardBBox();
    const minW = Math.max(0, $('stage').clientWidth - 32), minH = Math.max(0, $('stage').clientHeight - 32);
    const W = Math.ceil(Math.max(bb.x + bb.w, minW)), H = Math.ceil(Math.max(bb.y + bb.h, minH));
    if (W === wrapW && H === wrapH) return;
    wrapW = W; wrapH = H;
    $('wrap').style.width = W + 'px';
    $('wrap').style.height = H + 'px';
  }
  /** 画板卡片:cap 悬浮标签 + ×移除 + 图;预览态拖动摆位置(编辑态拖动=画标注,不抢) */
  function buildCard(label, blob, filename, onready, opts) {
    const el = document.createElement('div');
    el.className = 'board-card';
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = label;
    if (!label) cap.style.display = 'none';
    const img = new Image();
    img.draggable = false;
    img.title = '拖动摆位置;右下角缩放;下载按画板布局导出';
    img.src = URL.createObjectURL(blob);
    const card = { el, img, x: 0, y: 0, fresh: !!(opts && opts.fresh) };
    img.onload = () => {
      blobOf.set(img, blob);
      Edit.mount(img, blob, filename);
      // 单卡片(或显式 fit):s 为纯视图(初始适应,与旧版观感一致);多卡片:s 为布局量,初始自然尺寸
      const fit = opts && typeof opts.fit === 'boolean' ? opts.fit : cards.length === 1;
      card.fitScale = fit;
      scales.set(img, fit ? fitScaleOf(img) : 1);
      applyImg(img);
      if (!boardTouched) autoStack();
      else if (card.fresh) { // 手动布局中追加:放到其它内容右侧,不压旧卡片
        let mx = 0;
        for (const c of cards) { if (c === card || !c.img.naturalWidth) continue; mx = Math.max(mx, c.x + cardDispSize(c).w); }
        const ab = Edit.boardAnnsBBox && Edit.boardAnnsBBox();
        if (ab) mx = Math.max(mx, ab.x + ab.w);
        card.x = mx ? mx + 40 : 0; card.y = 0;
        el.style.left = card.x + 'px'; el.style.top = '0px';
      }
      relayout();
      if (onready) onready(img);
      if (!activeImg) selectImg(img);
      if (card.fresh) selectImg(img);
    };
    el.addEventListener('pointerdown', (e) => {
      if (Edit.mode === 'edit' || e.button !== 0) return;
      selectImg(img);
      boardDrag = { card, sx: e.clientX, sy: e.clientY, x: card.x, y: card.y };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    el.addEventListener('pointermove', (e) => {
      if (!boardDrag || boardDrag.card !== card) return;
      boardTouched = true;
      card.x = Math.max(0, boardDrag.x + e.clientX - boardDrag.sx);
      card.y = Math.max(0, boardDrag.y + e.clientY - boardDrag.sy);
      el.style.left = card.x + 'px';
      el.style.top = card.y + 'px';
      relayout();
      Edit.redraw();
    });
    el.addEventListener('pointerup', () => { boardDrag = null; });
    const bx = document.createElement('button');
    bx.className = 'bx'; bx.textContent = '×'; bx.title = '从画板移除这张图(及其标注)';
    bx.addEventListener('pointerdown', (e) => e.stopPropagation());
    bx.addEventListener('click', (e) => { e.stopPropagation(); removeCard(card); });
    el.appendChild(cap); el.appendChild(img); el.appendChild(bx);
    cards.push(card);
    return card;
  }
  /** 从画板移除卡片:注销编辑目标、回收 URL,选中态顺延到第一张 */
  function removeCard(card) {
    const i = cards.indexOf(card);
    if (i < 0) return;
    cards.splice(i, 1);
    URL.revokeObjectURL(card.img.src);
    blobOf.delete(card.img);
    scales.delete(card.img);
    if (Edit.unmount) Edit.unmount(card.img);
    card.el.remove();
    if (activeImg === card.img) {
      activeImg = null;
      if (cards.length) selectImg(cards[0].img);
    }
    relayout();
    Edit.redraw();
    Edit.setHasMain(cards.length > 0);
    $('info').textContent = cards.length ? $('info').textContent : '画板已空:可 ＋图片 / ＋空白画布 / Ctrl+V 粘贴';
    toast('已移除图片');
  }
  /** 画板合成:垫背景色 → 按卡片位置缩放拼图 → P014 画板标注层;单卡无标注无背景不走这里(原图直通零回归) */
  async function composeBoard() {
    const dpr = window.devicePixelRatio || 1;
    const bb = boardBBox();
    const W = Math.round(bb.w * dpr), H = Math.round(bb.h * dpr);
    if (!(W > 0 && H > 0)) throw new Error('empty-board');
    if (W > 32767 || H > 32767) throw new Error('canvas-overflow');
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const cx = c.getContext('2d');
    if (boardBg !== 'transparent') { cx.fillStyle = boardBg; cx.fillRect(0, 0, W, H); }
    cx.save();
    cx.translate(-Math.round(bb.x * dpr), -Math.round(bb.y * dpr)); // 标注可能画到负象限,平移对齐
    for (const card of cards) {
      if (!card.img.naturalWidth) continue;
      let src = blobOf.get(card.img);
      try { const edited = await Edit.exportBlob(card.img); if (edited) src = edited; } catch (e) { /* 标注合成失败用原图 */ }
      if (!src) continue;
      const bmp = await createImageBitmap(src);
      const s = scales.get(card.img) || 1;
      cx.drawImage(bmp, Math.round(card.x * dpr), Math.round(card.y * dpr),
        Math.round(bmp.width * s), Math.round(bmp.height * s));
      bmp.close();
    }
    if (Edit.drawBoardLayer) Edit.drawBoardLayer(cx, dpr);
    cx.restore();
    const out = await new Promise((res) => c.toBlob(res, 'image/png'));
    if (!out) throw new Error('toBlob failed');
    return out;
  }

  function dotName(name, suffix) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) + suffix + name.slice(i) : name + suffix;
  }
  /** 导出物为 PNG:改文件名扩展名 */
  function asPng(name) {
    const i = name.lastIndexOf('.');
    return (i > 0 ? name.slice(0, i) : name) + '.png';
  }

  function renderInfo() {
    if (!meta) return;
    const size = currentBlob ? fmtBytes(currentBlob.size) : '';
    $('info').textContent = `${naturalW || meta.widthPx || '?'} × ${naturalH || meta.heightPx || '?'} px · ` +
      (meta.mime === 'image/png' ? 'PNG' : 'JPEG') + (size ? ' · ' + size : '');
  }

  function renderNotes() {
    const box = $('notes');
    (meta.notes || []).forEach(addNote);
  }
  function addNote(text) {
    const d = document.createElement('div');
    d.className = 'note';
    const s = document.createElement('span');
    s.textContent = text;
    const x = document.createElement('button');
    x.className = 'nx'; x.textContent = '×'; x.title = '移除这条提示';
    x.addEventListener('click', () => d.remove());
    d.append(s, x);
    $('notes').appendChild(d);
  }

  /* ---------------- 缩放(P014:滑杆/数字无级调节 + 平滑滚轮;± 按钮 ×1.1 细调) ---------------- */
  const ZMIN = 0.05, ZMAX = 4;
  /** 缩放作用目标:选中图优先,回退第一张(蓝框消掉后仍可缩放,语义不变) */
  function mainImg() {
    if (activeImg && activeImg.isConnected) return activeImg;
    return cards.length ? cards[0].img : null;
  }
  /** 把 img 的缩放比落到样式(明确宽度后须摘掉 max-width:100%,否则放大不生效) */
  function applyImg(img) {
    const dpr = window.devicePixelRatio || 1;
    img.style.maxWidth = 'none';
    img.style.width = Math.round(img.naturalWidth / dpr * (scales.get(img) || 1)) + 'px';
  }
  function curScale() { const img = mainImg(); return img ? (scales.get(img) || 1) : 1; }
  function fitScaleOf(img) {
    const dpr = window.devicePixelRatio || 1;
    return ($('stage').clientWidth - 32) / (img.naturalWidth / dpr);
  }
  /** 缩放控件回显:滑杆与数字框同步当前比例 */
  function syncZoomUI() {
    const v = Math.round(curScale() * 100);
    $('zoom-range').value = v;
    $('zoom-num').value = v;
  }
  function applyScale() {
    const img = mainImg();
    if (!img || !img.naturalWidth) { syncZoomUI(); return; }
    applyImg(img);
    syncZoomUI();
    Edit.redraw();
  }
  function setScale(img, s) {
    if (!img || !img.naturalWidth) return;
    scales.set(img, Math.max(ZMIN, Math.min(ZMAX, s)));
    applyImg(img);
    if (img === mainImg()) syncZoomUI();
    Edit.redraw();
    if (!boardTouched) autoStack(); // 缩放改了卡片尺寸,未手动布局时顺势重堆叠
    relayout();
  }
  $('zoom-in').addEventListener('click', () => setScale(mainImg(), curScale() * 1.1));
  $('zoom-out').addEventListener('click', () => setScale(mainImg(), curScale() / 1.1));
  $('zoom-100').addEventListener('click', () => setScale(mainImg(), 1));
  $('zoom-fit').addEventListener('click', () => { const img = mainImg(); if (img) setScale(img, fitScaleOf(img)); });
  $('zoom-range').addEventListener('input', () => setScale(mainImg(), +$('zoom-range').value / 100));
  $('zoom-num').addEventListener('change', () => {
    const v = Math.round(+$('zoom-num').value || 100);
    setScale(mainImg(), v / 100);
    syncZoomUI(); // 超界时回显钳制后的值
  });
  $('stage').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setScale(mainImg(), curScale() * Math.exp(-e.deltaY * 0.001)); // 指数平滑:触控板逐像素,滚轮每格约 ±8%
  }, { passive: false });

  /* ---------------- P014 画板操作:添加/粘贴/移除图片、背景、空白画布、点空白消蓝框 ---------------- */
  /** 点卡片以外的空白:消掉图片选中蓝框(activeImg 保留为操作兜底,只去视觉) */
  function clearImgSel() {
    document.querySelectorAll('.board-card img.sel').forEach((x) => x.classList.remove('sel'));
  }
  $('stage').addEventListener('pointerdown', (e) => {
    if (e.target.closest && e.target.closest('.board-card')) return;
    clearImgSel();
  });

  /** 画板内直接加图:不走 SW/重载,blob 直接建卡;单图 fit 态在转多图时归一为布局量 1 */
  function addImageBlobs(files) {
    const imgs = [...files].filter((f) => /^image\//.test(f.type || ''));
    if (!imgs.length) { toast('没有可用的图片文件', 'err'); return false; }
    leaveOpenState();
    const wasEmpty = cards.length === 0;
    for (const f of imgs) {
      const name = f.name || ('粘贴图片-' + (++cardSeq) + '.png');
      const card = buildCard('', f, name, null, { fresh: true, fit: wasEmpty && imgs.length === 1 });
      $('wrap').appendChild(card.el);
    }
    if (cards.length > 1) {
      for (const c of cards) {
        if (c.fitScale) { c.fitScale = false; scales.set(c.img, 1); if (c.img.naturalWidth) applyImg(c.img); }
      }
    }
    if (!boardTouched) autoStack();
    relayout();
    Edit.setHasMain(true);
    toast('已添加 ' + imgs.length + ' 张图片,可拖动摆位');
    return true;
  }
  $('btn-addimg').addEventListener('click', () => $('fi-add').click());
  $('fi-add').addEventListener('change', () => {
    const fs = [...($('fi-add').files || [])];
    $('fi-add').value = '';
    if (fs.length) addImageBlobs(fs);
  });
  /** Ctrl+V 粘贴图片上画板(导出弹窗打开时不抢) */
  window.addEventListener('paste', (e) => {
    if (Edit.modalOpen && Edit.modalOpen()) return;
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file' && /^image\//.test(it.type)) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (!files.length) return; // 文本等粘贴走默认(如文字输入框)
    e.preventDefault();
    addImageBlobs(files);
  });

  /** 新建空白画布:视口大小 ×dpr 的透明 PNG 卡片,非破坏式追加 */
  async function makeBlankCanvas() {
    leaveOpenState();
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(480, $('stage').clientWidth - 32), h = Math.max(360, $('stage').clientHeight - 32);
    const c = document.createElement('canvas');
    c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    if (!blob) return;
    const card = buildCard('空白画布', blob, '空白画布.png', null, { fresh: true, fit: false });
    $('wrap').appendChild(card.el);
    Edit.setHasMain(true);
    toast('已新建空白画布:点「✎ 编辑」即可写字作画');
  }
  $('btn-blank').addEventListener('click', makeBlankCanvas);

  /* -------- 画板背景:透明(棋盘格)/常用色/自定义色;导出合成时垫底色 -------- */
  const BG_SWATCHES = [
    ['transparent', '透明'], ['#ffffff', '白板'], ['#f1f5f9', '浅灰'], ['#fef9c3', '米黄'],
    ['#dbeafe', '浅蓝'], ['#dcfce7', '浅绿'], ['#111827', '深色'], ['#000000', '纯黑']
  ];
  function applyBoardBg() {
    if (boardBg !== 'transparent') { $('wrap').style.background = boardBg; return; }
    const dark = matchMedia('(prefers-color-scheme: dark)').matches;
    $('wrap').style.background = dark
      ? 'repeating-conic-gradient(#2a3040 0% 25%, #171a21 0% 50%) 0 0 / 24px 24px'
      : 'repeating-conic-gradient(#c8cdd6 0% 25%, #fff 0% 50%) 0 0 / 24px 24px';
  }
  function setBoardBg(v) {
    boardBg = v;
    try { localStorage.setItem('cs.boardBg', v); } catch (e) { /* 忽略 */ }
    applyBoardBg();
    $('bgpop').querySelectorAll('.bgsw').forEach((x) => x.classList.toggle('on', x.dataset.bg === v));
    if (cards.length || (Edit.hasBoardAnns && Edit.hasBoardAnns())) toast('背景已切换,导出将带上底色');
  }
  function buildBgPop() {
    const pop = $('bgpop');
    for (const [v, name] of BG_SWATCHES) {
      const b = document.createElement('button');
      b.className = 'bgsw' + (v === boardBg ? ' on' : '');
      b.dataset.bg = v;
      b.title = name;
      if (v === 'transparent') b.classList.add('checker');
      else b.style.background = v;
      b.addEventListener('click', (e) => { e.stopPropagation(); setBoardBg(v); });
      pop.insertBefore(b, pop.querySelector('label'));
    }
    pop.querySelector('label').addEventListener('click', (e) => e.stopPropagation());
    $('bg-custom').addEventListener('input', () => setBoardBg($('bg-custom').value));
  }
  $('btn-bg').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('bgpop');
    if (pop.hidden) {
      pop.hidden = false;
      const r = $('btn-bg').getBoundingClientRect();
      pop.style.right = Math.max(8, innerWidth - r.right) + 'px';
      pop.style.bottom = (innerHeight - r.top + 8) + 'px';
    } else pop.hidden = true;
  });
  window.addEventListener('pointerdown', (e) => {
    const pop = $('bgpop');
    if (!pop.hidden && !pop.contains(e.target) && e.target !== $('btn-bg')) pop.hidden = true;
  });

  /* ---------------- 下载 / 复制(所见即所得) ---------------- */
  async function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    try {
      await chrome.downloads.download({ url, filename, saveAs: false, conflictAction: 'uniquify' });
    } catch (e) {
      const a = document.createElement('a');
      a.href = url; a.download = filename; a.click();
    }
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* -------- P010/P011 导出弹窗:左原图(可剪裁/可放大)右效果,滑杆即调即看 -------- */
  const dlOpts = { format: 'original', quality: 85, scale: 100 }; // 记住上次选择
  let dlgCtx = null;   // {blob, name, bmpP, dims, crop, srcUrl, outUrl, out, outName, seq}
  let dlgTimer = 0;
  let encoding = false, requeue = false; // 编码互斥:连续拖动不并发重编码(性能)
  let cropMode = false;
  let cropDrag = null;
  let dlgFs = false;   // 弹窗全屏态(v0.9.6),会话内记忆
  let lb = null;       // 灯箱状态 {which:'src'|'out', fit}

  function renameExt(name, mime) {
    const ext = mime === 'image/jpeg' ? '.jpg' : mime === 'image/webp' ? '.webp' : '.png';
    const i = name.lastIndexOf('.');
    return (i > 0 ? name.slice(0, i) : name) + ext;
  }
  function fmtMime(mime) {
    return mime === 'image/png' ? 'PNG' : mime === 'image/jpeg' ? 'JPEG' :
      mime === 'image/webp' ? 'WebP' : String(mime || 'image/png').replace('image/', '').toUpperCase();
  }
  /** 源图位图只解码一次(弹窗会话内缓存,Promise 去重) */
  function ensureBmp(ctx0) {
    if (!ctx0.bmpP) ctx0.bmpP = createImageBitmap(ctx0.blob);
    return ctx0.bmpP;
  }
  /** 按选项剪裁/转码/缩放;不需要改动时原样直通;超画布上限/编码失败抛错 */
  async function encode(blob, opts, bmp) {
    const mime = opts.format === 'original' ? (blob.type || 'image/png') : 'image/' + opts.format;
    const cr = opts.crop;
    const sx = cr ? Math.round(cr.x) : 0, sy = cr ? Math.round(cr.y) : 0;
    const sw = cr ? Math.max(1, Math.round(cr.w)) : bmp.width;
    const sh = cr ? Math.max(1, Math.round(cr.h)) : bmp.height;
    const w = Math.max(1, Math.round(sw * opts.scale / 100));
    const h = Math.max(1, Math.round(sh * opts.scale / 100));
    if (!cr && opts.scale === 100 && blob.type === mime) return { blob, mime, w: bmp.width, h: bmp.height };
    if (w > 32767 || h > 32767) throw new Error('canvas-overflow');
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const cx = c.getContext('2d');
    if (mime === 'image/jpeg') { cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); } // 透明底转 JPEG 垫白
    cx.drawImage(bmp, sx, sy, sw, sh, 0, 0, w, h);
    const out = await new Promise((res) => c.toBlob(res, mime, mime === 'image/png' ? undefined : opts.quality / 100));
    if (!out) throw new Error('toBlob failed');
    return { blob: out, mime: out.type || mime, w, h }; // 不支持的 mime 会被浏览器降级,out.type 才是真实格式
  }

  async function openExport(blob, name) {
    if (!blob) return;
    closeExport(); // 清掉上一次的状态与 object URL
    const srcUrl = URL.createObjectURL(blob);
    dlgCtx = { blob, name, bmpP: null, dims: null, crop: null, srcUrl, outUrl: null, out: null, outName: name, seq: 0 };
    setCropMode(false);
    updateCropButtons();
    renderCropBox();
    $('dlg-src').src = srcUrl;
    $('dlg-src-info').textContent = fmtMime(blob.type) + ' · ' + fmtBytes(blob.size);
    $('dl-format').value = dlOpts.format;
    $('dl-quality').value = dlOpts.quality;
    $('dl-scale').value = dlOpts.scale;
    $('dlg-go').disabled = true;
    $('dlg-summary').textContent = '';
    syncCtlLabels();
    $('dlmodal').hidden = false;
    const ctx0 = dlgCtx;
    ensureBmp(ctx0).then((b) => {
      if (dlgCtx !== ctx0) return;
      ctx0.dims = { w: b.width, h: b.height };
      $('dlg-src-info').textContent = b.width + ' × ' + b.height + ' px · ' + fmtMime(blob.type) + ' · ' + fmtBytes(blob.size);
      syncCtlLabels();
    }).catch(() => {});
    schedulePreview(0);
    setTimeout(() => $('dl-format').focus(), 0);
  }
  function closeExport() {
    closeLightbox();
    if (!dlgCtx) return;
    clearTimeout(dlgTimer);
    URL.revokeObjectURL(dlgCtx.srcUrl);
    if (dlgCtx.outUrl) URL.revokeObjectURL(dlgCtx.outUrl);
    if (dlgCtx.bmpP) dlgCtx.bmpP.then((b) => b.close()).catch(() => {});
    dlgCtx = null;
    cropDrag = null;
    setCropMode(false);
    $('dlmodal').hidden = true;
    $('dlg-src').removeAttribute('src');
    $('dlg-out').removeAttribute('src');
  }
  function schedulePreview(delay) {
    clearTimeout(dlgTimer);
    if (dlgCtx) $('dlg-go').disabled = true;
    dlgTimer = setTimeout(refreshPreview, delay == null ? 200 : delay);
  }
  /** 右栏实时预览:按当前选项重编码(防抖 + 互斥;seq/identity 防旧请求覆盖新结果) */
  async function refreshPreview() {
    const ctx0 = dlgCtx; if (!ctx0) return;
    if (encoding) { requeue = true; return; }
    encoding = true;
    const seq = ++ctx0.seq;
    const tip = $('dlg-out-tip');
    tip.textContent = '处理中…'; tip.hidden = false;
    try {
      const bmp = await ensureBmp(ctx0);
      const r = await encode(ctx0.blob, { format: dlOpts.format, quality: dlOpts.quality, scale: dlOpts.scale, crop: ctx0.crop }, bmp);
      if (dlgCtx !== ctx0 || ctx0.seq !== seq) return;
      const url = URL.createObjectURL(r.blob);
      if (ctx0.outUrl) URL.revokeObjectURL(ctx0.outUrl);
      ctx0.outUrl = url; ctx0.out = r;
      ctx0.outName = renameExt(ctx0.name, r.mime);
      $('dlg-out').src = url;
      tip.hidden = true;
      $('dlg-out-info').textContent = r.w + ' × ' + r.h + ' px · ' + fmtMime(r.mime) + ' · ' + fmtBytes(r.blob.size);
      $('dlg-go').disabled = false;
      $('dlg-go').textContent = '下载 ' + fmtMime(r.mime) + ' · ' + fmtBytes(r.blob.size);
      const srcSize = ctx0.blob.size, d = r.blob.size - srcSize;
      $('dlg-summary').textContent = d === 0 ? '' :
        '体积 ' + fmtBytes(srcSize) + ' → ' + fmtBytes(r.blob.size) +
        (d < 0 ? '(减小 ' + Math.round(-d / srcSize * 100) + '%)' : '(增大 ' + Math.round(d / srcSize * 100) + '%)');
    } catch (e) {
      if (dlgCtx !== ctx0 || ctx0.seq !== seq) return;
      tip.textContent = '该尺寸超出浏览器画布上限,无法转换;请降低缩放比例';
      $('dlg-out-info').textContent = '';
      $('dlg-summary').textContent = '';
      $('dlg-go').disabled = true;
    } finally {
      encoding = false;
      if (requeue) { requeue = false; if (dlgCtx) schedulePreview(0); }
    }
  }
  /** 剪裁后基准尺寸 = 剪裁框;否则整张图 */
  function baseDims() {
    if (!dlgCtx) return null;
    if (dlgCtx.crop) return { w: dlgCtx.crop.w, h: dlgCtx.crop.h };
    return dlgCtx.dims;
  }
  /** 控件回显:质量行仅 JPEG/WebP 显示;缩放滑杆带目标像素 */
  function syncCtlLabels() {
    $('dl-quality-row').style.display = (dlOpts.format === 'jpeg' || dlOpts.format === 'webp') ? 'flex' : 'none';
    $('dl-quality-v').textContent = dlOpts.quality + '%';
    let sv = dlOpts.scale + '%';
    const bd = baseDims();
    if (bd) {
      sv += ' → ' + Math.max(1, Math.round(bd.w * dlOpts.scale / 100)) + ' × ' +
        Math.max(1, Math.round(bd.h * dlOpts.scale / 100)) + ' px';
    }
    $('dl-scale-v').textContent = sv;
  }

  $('dl-format').addEventListener('change', () => { dlOpts.format = $('dl-format').value; syncCtlLabels(); schedulePreview(); });
  $('dl-quality').addEventListener('input', () => { dlOpts.quality = +$('dl-quality').value; $('dl-quality-v').textContent = dlOpts.quality + '%'; schedulePreview(); });
  $('dl-scale').addEventListener('input', () => { dlOpts.scale = +$('dl-scale').value; syncCtlLabels(); schedulePreview(); });
  /** 全屏切换:弹窗铺满视口,对比图更大;剪裁框随 pane 几何重定位 */
  function setDlgFs(on) {
    dlgFs = !!on;
    $('dlg').classList.toggle('fs', dlgFs);
    $('dlg-fs').textContent = dlgFs ? '退出全屏' : '⛶ 全屏';
    renderCropBox();
  }
  $('dlg-fs').addEventListener('click', () => setDlgFs(!dlgFs));
  $('dlg-close').addEventListener('click', closeExport);
  $('dlg-cancel').addEventListener('click', closeExport);
  $('dlg-mask').addEventListener('click', closeExport);
  $('dlg-go').addEventListener('click', () => {
    const ctx0 = dlgCtx;
    if (!ctx0 || !ctx0.out) return;
    downloadBlob(ctx0.out.blob, ctx0.outName);
    toast('已开始下载:' + ctx0.outName);
    closeExport();
  });
  // 弹窗内按键不外泄(E 进编辑 / Esc 退编辑等编辑器快捷键),Esc 逐层退:剪裁 → 全屏 → 关闭,Enter 确认
  $('dlg').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { e.preventDefault(); if (cropMode) setCropMode(false); else if (dlgFs) setDlgFs(false); else closeExport(); }
    else if (e.key === 'Enter' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'BUTTON') {
      e.preventDefault();
      if (!$('dlg-go').disabled) $('dlg-go').click();
    }
  });
  Edit.modalOpen = () => !$('dlmodal').hidden;

  /* -------- 剪裁(P011):左栏拖框,松手即生效,右栏实时更新 -------- */
  const srcPane = $('dlg-pane-src');
  function setCropMode(on) {
    cropMode = !!on && !!dlgCtx;
    srcPane.classList.toggle('cropping', cropMode);
    $('dlg-crop-hint').hidden = !cropMode;
    $('dlg-crop').textContent = cropMode ? '✔ 完成剪裁' : '✂ 剪裁';
    $('dlg-crop').classList.toggle('on', cropMode);
    renderCropBox();
  }
  function updateCropButtons() {
    $('dlg-crop-clear').hidden = !(dlgCtx && dlgCtx.crop);
  }
  /** 左 pane 内图片内容区(object-fit:contain 居中)相对 pane padding-box 的偏移与比例 */
  function paneImgRect() {
    const nat = dlgCtx && dlgCtx.dims;
    if (!nat) return null;
    const s = Math.min(srcPane.clientWidth / nat.w, srcPane.clientHeight / nat.h);
    return { s, x: (srcPane.clientWidth - nat.w * s) / 2, y: (srcPane.clientHeight - nat.h * s) / 2 };
  }
  /** 屏幕坐标 → 图像原始像素(钳到图内) */
  function paneToImg(e) {
    const m = paneImgRect(); if (!m) return null;
    const r = srcPane.getBoundingClientRect();
    const nat = dlgCtx.dims;
    const px = (e.clientX - r.left - srcPane.clientLeft - m.x) / m.s;
    const py = (e.clientY - r.top - srcPane.clientTop - m.y) / m.s;
    return { x: Math.min(Math.max(px, 0), nat.w), y: Math.min(Math.max(py, 0), nat.h) };
  }
  function clampCrop(c) {
    const nat = dlgCtx.dims;
    c.w = Math.min(c.w, nat.w); c.h = Math.min(c.h, nat.h);
    c.x = Math.min(Math.max(c.x, 0), nat.w - c.w);
    c.y = Math.min(Math.max(c.y, 0), nat.h - c.h);
  }
  function renderCropBox() {
    const box = $('dlg-cropbox');
    const c = dlgCtx && dlgCtx.crop;
    const m = c ? paneImgRect() : null;
    if (!m) { box.hidden = true; return; }
    box.hidden = false;
    box.style.left = (m.x + c.x * m.s) + 'px';
    box.style.top = (m.y + c.y * m.s) + 'px';
    box.style.width = Math.max(2, c.w * m.s) + 'px';
    box.style.height = Math.max(2, c.h * m.s) + 'px';
    box.style.pointerEvents = cropMode ? 'auto' : 'none'; // 非剪裁态只作展示,不挡点击放大
    $('dlg-cropbox-size').textContent = Math.round(c.w) + ' × ' + Math.round(c.h);
  }
  srcPane.addEventListener('pointerdown', (e) => {
    if (!cropMode || !dlgCtx || !dlgCtx.dims || e.button !== 0) return;
    const p = paneToImg(e); if (!p) return;
    const c = dlgCtx.crop;
    cropDrag = (c && p.x >= c.x && p.x <= c.x + c.w && p.y >= c.y && p.y <= c.y + c.h)
      ? { mode: 'move', dx: p.x - c.x, dy: p.y - c.y }
      : { mode: 'new', x0: p.x, y0: p.y };
    srcPane.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  srcPane.addEventListener('pointermove', (e) => {
    if (!cropDrag || !dlgCtx || !dlgCtx.dims) return;
    const p = paneToImg(e); if (!p) return;
    if (cropDrag.mode === 'new') {
      dlgCtx.crop = {
        x: Math.min(cropDrag.x0, p.x), y: Math.min(cropDrag.y0, p.y),
        w: Math.abs(p.x - cropDrag.x0), h: Math.abs(p.y - cropDrag.y0)
      };
    } else if (dlgCtx.crop) {
      dlgCtx.crop.x = p.x - cropDrag.dx;
      dlgCtx.crop.y = p.y - cropDrag.dy;
    }
    clampCrop(dlgCtx.crop);
    renderCropBox();
    syncCtlLabels(); // 缩放目标像素跟随剪裁尺寸(纯文本,无编码开销)
  });
  srcPane.addEventListener('pointerup', () => {
    if (!cropDrag) return;
    cropDrag = null;
    const c = dlgCtx && dlgCtx.crop;
    if (c && (c.w < 8 || c.h < 8)) dlgCtx.crop = null; // 误点小框视为放弃
    renderCropBox();
    updateCropButtons();
    syncCtlLabels();
    if (dlgCtx) schedulePreview(0); // 松手即生效,右栏实时更新
  });
  $('dlg-crop').addEventListener('click', () => setCropMode(!cropMode));
  $('dlg-crop-clear').addEventListener('click', () => {
    if (!dlgCtx) return;
    dlgCtx.crop = null;
    renderCropBox();
    updateCropButtons();
    syncCtlLabels();
    schedulePreview(0);
  });
  window.addEventListener('resize', () => { if (dlgCtx) renderCropBox(); relayout(); });

  /* -------- 放大查看(P011 灯箱):原图/导出图同位切换,保持缩放与滚动位置 -------- */
  function openLightbox(which) {
    if (!dlgCtx) return;
    if (which === 'out' && !dlgCtx.outUrl) return;
    lb = { which, fit: true, zoom: 1 };
    $('lightbox').hidden = false;
    applyLightbox(false);
    window.addEventListener('keydown', onLbKey, true); // 捕获相:先于编辑器/弹窗快捷键
    $('lb-close').focus();
  }
  function closeLightbox() {
    if (!lb) return;
    lb = null;
    window.removeEventListener('keydown', onLbKey, true);
    $('lightbox').hidden = true;
    $('lb-img').removeAttribute('src');
  }
  function applyLightbox(preserve) {
    if (!lb) return;
    if (!dlgCtx) return closeLightbox();
    const view = $('lb-view'), img = $('lb-img');
    const fx = preserve ? view.scrollLeft / Math.max(1, view.scrollWidth) : 0.5;
    const fy = preserve ? view.scrollTop / Math.max(1, view.scrollHeight) : 0.5;
    $('lb-title').textContent = lb.which === 'src' ? '原图' : '导出效果(当前选项)';
    $('lb-src').classList.toggle('on', lb.which === 'src');
    $('lb-out').classList.toggle('on', lb.which === 'out');
    $('lb-out').disabled = !dlgCtx.outUrl;
    const render = () => {
      if (!lb) return;
      img.classList.toggle('fit', lb.fit);
      img.style.width = lb.fit ? '' : Math.max(1, Math.round(img.naturalWidth * lb.zoom)) + 'px';
      $('lb-zoom').textContent = lb.fit ? '适应窗口' : Math.round(lb.zoom * 100) + '%';
      view.scrollLeft = fx * view.scrollWidth;
      view.scrollTop = fy * view.scrollHeight;
    };
    img.onload = render;
    img.src = lb.which === 'src' ? dlgCtx.srcUrl : dlgCtx.outUrl;
    if (img.complete && img.naturalWidth) render();
  }
  function onLbKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeLightbox(); }
    else if (e.key === 'ArrowLeft') { e.stopPropagation(); e.preventDefault(); $('lb-src').click(); }
    else if (e.key === 'ArrowRight') { e.stopPropagation(); e.preventDefault(); if (!$('lb-out').disabled) $('lb-out').click(); }
  }
  $('lb-src').addEventListener('click', () => { if (lb && lb.which !== 'src') { lb.which = 'src'; applyLightbox(true); } });
  $('lb-out').addEventListener('click', () => { if (lb && lb.which !== 'out' && dlgCtx && dlgCtx.outUrl) { lb.which = 'out'; applyLightbox(true); } });
  /** 点图/缩放按钮:适应窗口 ↔ 100% 原大 */
  function lbToggle() { if (!lb) return; if (lb.fit) { lb.fit = false; lb.zoom = 1; } else lb.fit = true; applyLightbox(true); }
  /** 无级缩放:适应态先按当前显示比例起算;滚动位置按比例保持 */
  function lbStep(k) {
    if (!lb) return;
    const img = $('lb-img');
    if (!img.naturalWidth) return;
    const cur = lb.fit
      ? Math.min($('lb-view').clientWidth / img.naturalWidth, $('lb-view').clientHeight / img.naturalHeight)
      : lb.zoom;
    lb.fit = false;
    lb.zoom = Math.min(8, Math.max(0.05, cur * k));
    applyLightbox(true);
  }
  $('lb-zoom').addEventListener('click', lbToggle);
  $('lb-img').addEventListener('click', lbToggle);
  $('lb-zin').addEventListener('click', () => lbStep(1.25));
  $('lb-zout').addEventListener('click', () => lbStep(1 / 1.25));
  $('lb-view').addEventListener('wheel', (e) => {
    if (!lb || !e.ctrlKey) return;
    e.preventDefault();
    lbStep(e.deltaY < 0 ? 1.1 : 1 / 1.1);
  }, { passive: false });
  $('lb-close').addEventListener('click', closeLightbox);
  $('lb-mask').addEventListener('click', closeLightbox);
  $('dlg-src').addEventListener('click', () => { if (!cropMode) openLightbox('src'); });
  $('dlg-out').addEventListener('click', () => { if (dlgCtx && dlgCtx.outUrl) openLightbox('out'); });

  /** 指定图的当前呈现:多卡/有画板标注/有底色→画板合成;单卡有标注→全分辨率合成 PNG,无标注→原始 blob(零回归) */
  async function displayBlobFor(img) {
    const t = img && Edit.targetOf(img);
    const baseName = (meta && meta.name) || (t && t.name) || 'board.png';
    const composed = cards.length > 1 || boardBg !== 'transparent' || (Edit.hasBoardAnns && Edit.hasBoardAnns());
    if (composed) {
      const blob = await composeBoard();
      return { blob, name: asPng(baseName) };
    }
    const name = (t && t.name) || (meta && meta.name) || 'image.png';
    if (t) {
      try {
        const edited = await Edit.exportBlob(img);
        if (edited) return { blob: edited, name: img === imgEl ? asPng(name) : asPng(dotName(name, '-标注')) };
      } catch (e) { /* 合成失败退回原图 */ }
    }
    return { blob: img ? blobOf.get(img) : null, name };
  }

  async function doDownload() {
    try {
      const { blob, name } = await displayBlobFor(activeImg);
      if (!blob) return;
      openExport(blob, name);
    } catch (e) {
      if (e && e.message === 'empty-board') return toast('画板还没有内容,先添加图片或作画', 'err');
      toast('画板超出浏览器画布上限,请用右下角 － 缩小图片后再导出', 'err');
    }
  }
  /** 复制到剪贴板(恒 PNG) */
  async function copyPng(blob) {
    try {
      let out = blob;
      if (out.type !== 'image/png') {
        const bmp = await createImageBitmap(out);
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        out = await new Promise(res => c.toBlob(res, 'image/png'));
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': out })]);
      toast('已复制到剪贴板');
    } catch (e) {
      toast('复制失败,请使用下载或在图片上右键复制', 'err');
    }
  }
  async function doCopy() {
    try {
      const { blob } = await displayBlobFor(activeImg);
      if (blob) copyPng(blob);
    } catch (e) {
      toast('画板超出浏览器画布上限,请缩小后再复制', 'err');
    }
  }

  $('btn-download').addEventListener('click', doDownload);
  $('btn-copy').addEventListener('click', doCopy);
  $('btn-edit').addEventListener('click', () => Edit.setMode('edit'));
  // 编辑态工具栏里的 复制/下载 复用同一出口(作用于选中图,见 edit.js mainTarget)
  Edit._emit = (kind) => { if (kind === 'copy') doCopy(); else if (kind === 'download') doDownload(); };
  Edit.onHint = (t) => toast(t);            // 编辑器轻提示(如马赛克仅限图片)
  Edit._boardChange = relayout;             // 画板标注层增删 → 重算 wrap 尺寸

  buildBgPop();
  applyBoardBg();
  syncZoomUI();

  /** P012 操作提示:底部居中 toast,滑入后自动消失;kind='err' 为错误红 */
  function toast(text, kind) {
    const box = $('toasts');
    const d = document.createElement('div');
    d.className = 'toast' + (kind ? ' ' + kind : '');
    d.textContent = text;
    box.appendChild(d);
    requestAnimationFrame(() => d.classList.add('show'));
    setTimeout(() => {
      d.classList.remove('show');
      setTimeout(() => d.remove(), 300);
    }, 2200);
  }

  init();
})();
