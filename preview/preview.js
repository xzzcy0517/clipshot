'use strict';
/**
 * 预览页:meta → chunk 分块拉取 SW 暂存截图;多段按解码高度堆叠/分卷;
 * 缩放/下载/复制 + P007 微信式编辑(双状态:默认预览态,点「编辑」才出工具栏)。
 * 编辑逻辑在 edit.js;导出所见即所得,无标注时与旧版行为逐字节一致。
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

  /** P009 空态:无 job 时给上传入口(上传完带 jobId 重进本页) */
  function openState() {
    $('info').textContent = '图片工作台';
    const box = document.createElement('div');
    box.className = 'open-state';
    const tip = document.createElement('p');
    tip.textContent = '上传图片后即可标注、转格式、压缩(可多选)';
    const btn = document.createElement('button');
    btn.className = 'primary'; btn.textContent = '打开图片编辑';
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
    box.append(tip, btn, fi);
    $('wrap').appendChild(box);
  }

  /** P009 多图上传:逐张拉取,列表展示,每张独立编辑/复制/下载 */
  async function initItems(m) {
    const list = document.createElement('div');
    list.className = 'seg-list';
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
      list.appendChild(buildSegItem(it.name + ' ', blob, it.name));
      (it.notes || []).forEach(addNote);
    }
    send({ type: CS.MSG.IMG_DONE, jobId }).catch(() => {});
    $('wrap').appendChild(list);
    Edit.setHasMain(true);
    $('info').textContent = '共 ' + m.items.length + ' 张图片,点击选中后用右下角面板操作';
    if (m.items.length > 1) toast('共 ' + m.items.length + ' 张图片,点选一张即可编辑/复制/下载');
    // 文件名兜底(选中后由 selectImg 逐张刷新信息行)
    meta = { name: m.items[0].name, mime: m.items[0].mime, notes: [], widthPx: m.items[0].widthPx, heightPx: m.items[0].heightPx };
  }

  function showBlob(blob) {
    currentBlob = blob;
    const url = URL.createObjectURL(blob);
    imgEl = new Image();
    imgEl.src = url;
    imgEl.onload = () => {
      naturalW = imgEl.naturalWidth; naturalH = imgEl.naturalHeight;
      blobOf.set(imgEl, blob);
      renderInfo();
      Edit.mount(imgEl, blob, meta.name);
      scales.set(imgEl, fitScaleOf(imgEl));
      selectImg(imgEl);
      Edit.setHasMain(true);
    };
    $('wrap').appendChild(imgEl);
  }

  /** P012:选中一张图(单图恒为唯一选中),右下面板的缩放/复制/下载作用于它 */
  function selectImg(img) {
    if (!img) return;
    activeImg = img;
    if (Edit.setActive) Edit.setActive(img);
    document.querySelectorAll('.seg-item img.sel').forEach((x) => x.classList.remove('sel'));
    if (img.closest('.seg-item')) img.classList.add('sel');
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
      const list = document.createElement('div');
      list.className = 'seg-list';
      for (let vi = 0; vi < vols.length; vi++) {
        const v = vols[vi];
        const blob = await compose(v.from, v.count);
        if (vi === 0) currentBlob = blob;
        const item = buildSegItem(`第 ${vi + 1} / ${vols.length} 卷(${v.count} 段,${v.height} px)`,
          blob, dotName(meta.name, `-vol${vi + 1}`));
        list.appendChild(item);
      }
      $('wrap').appendChild(list);
      Edit.setHasMain(true);
      addNote('整图超出浏览器画布上限,已分 ' + vols.length + ' 卷;点选一卷,右下角面板即可编辑/复制/下载,按卷序排列即整页');
    } catch (e) {
      // 回退:分段展示 + 逐段下载
      $('info').textContent = '图片超出画布上限,按分段展示';
      const list = document.createElement('div');
      list.className = 'seg-list';
      blobs.forEach((blob, i) => {
        list.appendChild(buildSegItem(`第 ${i + 1} / ${blobs.length} 段`, blob, dotName(meta.name, '-' + (i + 1))));
      });
      $('wrap').appendChild(list);
      Edit.setHasMain(true);
      currentBlob = blobs[0];
      addNote('整图超出浏览器画布限制,已按分段展示;点选一段,右下角面板即可编辑/复制/下载');
    }
  }

  /** 分卷/分段/上传条目:说明行 + 图(P012 起条目不再自带按钮,点图选中,右下面板统一操作) */
  function buildSegItem(label, blob, filename) {
    const item = document.createElement('div');
    item.className = 'seg-item';
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = label;
    const img = new Image();
    img.title = '点击选中,用右下角面板编辑/复制/下载';
    img.src = URL.createObjectURL(blob);
    img.onload = () => {
      blobOf.set(img, blob);
      Edit.mount(img, blob, filename);
      scales.set(img, Math.min(1, fitScaleOf(img))); // 初始适应容器,小图不放大
      applyImg(img);
      if (!activeImg) selectImg(img);
    };
    img.addEventListener('click', () => { if (Edit.mode !== 'edit') selectImg(img); });
    item.appendChild(cap); item.appendChild(img);
    return item;
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

  /* ---------------- 缩放 ---------------- */
  /** 把 img 的缩放比落到样式(明确宽度后须摘掉 max-width:100%,否则放大不生效) */
  function applyImg(img) {
    const dpr = window.devicePixelRatio || 1;
    img.style.maxWidth = 'none';
    img.style.width = Math.round(img.naturalWidth / dpr * (scales.get(img) || 1)) + 'px';
  }
  function curScale() { return scales.get(activeImg) || 1; }
  function fitScaleOf(img) {
    const dpr = window.devicePixelRatio || 1;
    return ($('stage').clientWidth - 32) / (img.naturalWidth / dpr);
  }
  function applyScale() {
    if (!activeImg || !activeImg.naturalWidth) return;
    applyImg(activeImg);
    $('zoom-label').textContent = Math.round(curScale() * 100) + '%';
    Edit.redraw();
  }
  function setScale(img, s) {
    if (!img || !img.naturalWidth) return;
    scales.set(img, s);
    if (img === activeImg) applyScale();
    else { applyImg(img); Edit.redraw(); }
  }
  $('zoom-in').addEventListener('click', () => setScale(activeImg, Math.min(4, curScale() * 1.25)));
  $('zoom-out').addEventListener('click', () => setScale(activeImg, Math.max(0.05, curScale() / 1.25)));
  $('zoom-100').addEventListener('click', () => setScale(activeImg, 1));
  $('zoom-fit').addEventListener('click', () => setScale(activeImg, fitScaleOf(activeImg)));
  $('stage').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setScale(activeImg, Math.max(0.05, Math.min(4, curScale() * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
  }, { passive: false });

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
  window.addEventListener('resize', () => { if (dlgCtx) renderCropBox(); });

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

  /** 指定图的当前呈现:有标注→全分辨率合成 PNG;无标注→原始 blob(零回归) */
  async function displayBlobFor(img) {
    const t = img && Edit.targetOf(img);
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
    const { blob, name } = await displayBlobFor(activeImg);
    if (!blob) return;
    openExport(blob, name);
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
    const { blob } = await displayBlobFor(activeImg);
    if (blob) copyPng(blob);
  }

  $('btn-download').addEventListener('click', doDownload);
  $('btn-copy').addEventListener('click', doCopy);
  $('btn-edit').addEventListener('click', () => Edit.setMode('edit'));
  // 编辑态工具栏里的 复制/下载 复用同一出口(作用于选中图,见 edit.js mainTarget)
  Edit._emit = (kind) => { if (kind === 'copy') doCopy(); else if (kind === 'download') doDownload(); };

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
