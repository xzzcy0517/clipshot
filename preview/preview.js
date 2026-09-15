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
  let scale = 1;            // 1 = 页面的 CSS 尺寸(设备像素 / dpr)
  let imgEl = null;
  let naturalW = 0, naturalH = 0; // 设备像素

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
    if (!jobId) return fail('缺少任务参数,请从截图操作打开本页');
    const m = await send({ type: CS.MSG.IMG_META, jobId });
    if (!m || !m.ok) return fail(CS.errText((m && m.error) || CS.ERR.STALE_JOB));
    meta = m;

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

  function showBlob(blob) {
    currentBlob = blob;
    const url = URL.createObjectURL(blob);
    imgEl = new Image();
    imgEl.src = url;
    imgEl.onload = () => {
      naturalW = imgEl.naturalWidth; naturalH = imgEl.naturalHeight;
      renderInfo();
      zoomFit();
      Edit.mount(imgEl, blob, meta.name);
      Edit.setHasMain(true);
    };
    $('wrap').appendChild(imgEl);
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
      addNote('整图超出浏览器画布上限,已分 ' + vols.length + ' 卷;每卷可独立「编辑」,按卷序排列即整页');
    } catch (e) {
      // 回退:分段展示 + 逐段下载
      $('info').textContent = '图片超出画布上限,按分段展示';
      const list = document.createElement('div');
      list.className = 'seg-list';
      blobs.forEach((blob, i) => {
        list.appendChild(buildSegItem(`第 ${i + 1} / ${blobs.length} 段`, blob, dotName(meta.name, '-' + (i + 1))));
      });
      $('wrap').appendChild(list);
      currentBlob = blobs[0];
      addNote('整图超出浏览器画布限制,已按分段展示;每段可独立「编辑」与下载');
    }
  }

  /** 分卷/分段条目:缩略说明 + 编辑该卷 + 下载本卷(导出所见即所得) */
  function buildSegItem(label, blob, filename) {
    const item = document.createElement('div');
    item.className = 'seg-item';
    const cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = label + ' ';
    const eb = document.createElement('button');
    eb.textContent = '编辑本卷';
    eb.addEventListener('click', () => Edit.setMode('edit'));
    const dl = document.createElement('button');
    dl.textContent = '下载本卷';
    dl.addEventListener('click', async () => {
      const img = item.querySelector('img');
      const edited = await Edit.exportBlob(img);
      downloadBlob(edited || blob, edited ? asPng(dotName(filename, '-标注')) : filename);
    });
    cap.appendChild(eb); cap.appendChild(dl);
    const img = new Image();
    img.src = URL.createObjectURL(blob);
    img.onload = () => Edit.mount(img, blob, filename);
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
    d.textContent = text;
    $('notes').appendChild(d);
  }

  /* ---------------- 缩放 ---------------- */
  function applyScale() {
    if (!imgEl) return;
    const dpr = window.devicePixelRatio || 1;
    imgEl.style.width = Math.round(naturalW / dpr * scale) + 'px';
    $('zoom-label').textContent = Math.round(scale * 100) + '%';
    Edit.redraw();
  }
  function zoomFit() { scale = ($('stage').clientWidth - 32) / (naturalW / (window.devicePixelRatio || 1)); applyScale(); }
  $('zoom-in').addEventListener('click', () => { scale = Math.min(4, scale * 1.25); applyScale(); });
  $('zoom-out').addEventListener('click', () => { scale = Math.max(0.05, scale / 1.25); applyScale(); });
  $('zoom-100').addEventListener('click', () => { scale = 1; applyScale(); });
  $('zoom-fit').addEventListener('click', zoomFit);
  $('stage').addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    scale = Math.max(0.05, Math.min(4, scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    applyScale();
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

  /** 当前呈现的 blob:有标注→全分辨率合成 PNG;无标注→原始 blob(零回归) */
  async function displayBlob() {
    try {
      const edited = await Edit.exportBlob();
      if (edited) return { blob: edited, name: asPng(meta.name) };
    } catch (e) { /* 合成失败退回原图 */ }
    return { blob: currentBlob, name: meta.name };
  }

  async function doDownload() {
    const { blob, name } = await displayBlob();
    if (blob) downloadBlob(blob, name);
  }
  async function doCopy() {
    const { blob } = await displayBlob();
    if (!blob) return;
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
      flash('已复制到剪贴板');
    } catch (e) {
      flash('复制失败,请使用下载或在图片上右键复制');
    }
  }

  $('btn-download').addEventListener('click', doDownload);
  $('btn-copy').addEventListener('click', doCopy);
  $('btn-edit').addEventListener('click', () => Edit.setMode('edit'));
  // 编辑态工具栏里的 复制/下载 复用同一出口
  Edit._emit = (kind) => { if (kind === 'copy') doCopy(); else if (kind === 'download') doDownload(); };

  function flash(text) {
    const s = $('status');
    s.textContent = text;
    s.classList.remove('hidden');
    setTimeout(() => s.classList.add('hidden'), 2500);
  }

  init();
})();
