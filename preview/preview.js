'use strict';
/**
 * 预览页:通过 meta → chunk 分块拉取 SW 内存暂存的截图,
 * 多段时按各段实际解码高度堆叠拼接;提供缩放/下载/复制剪贴板。
 */
(function () {
  const CS = globalThis.ClipShot;
  const $ = (id) => document.getElementById(id);
  const jobId = new URLSearchParams(location.search).get('job');

  let meta = null;
  let currentBlob = null;   // 最终展示/下载用的 blob
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
    };
    $('wrap').appendChild(imgEl);
  }

  /**
   * 多段合成(P003 分卷):先按各段实际解码高度做装箱(每卷累计 ≤30000 设备 px),
   * 一卷能装下全部 → 单张合成长图;否则每卷一张(按序即整图),人可逐卷下载查看。
   * 装箱/合成仍失败(单段超限等)→ 退化为逐段列表(原兜底保留)。
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
        const item = document.createElement('div');
        item.className = 'seg-item';
        const cap = document.createElement('div');
        cap.className = 'cap';
        cap.textContent = `第 ${vi + 1} / ${vols.length} 卷(${v.count} 段,${v.height} px)`;
        const dl = document.createElement('button');
        dl.textContent = '下载本卷';
        dl.addEventListener('click', () => downloadBlob(blob, dotName(meta.name, `-vol${vi + 1}`)));
        cap.appendChild(dl);
        const img = new Image();
        img.src = URL.createObjectURL(blob);
        item.appendChild(cap); item.appendChild(img);
        list.appendChild(item);
      }
      $('wrap').appendChild(list);
      addNote('整图超出浏览器画布上限,已自动分 ' + vols.length + ' 卷,每卷一张完整长图;按卷序排列即整页');
    } catch (e) {
      // 回退:分段展示 + 逐段下载
      $('info').textContent = '图片超出画布上限,按分段展示';
      const list = document.createElement('div');
      list.className = 'seg-list';
      blobs.forEach((blob, i) => {
        const item = document.createElement('div');
        item.className = 'seg-item';
        const cap = document.createElement('div');
        cap.className = 'cap';
        cap.textContent = `第 ${i + 1} / ${blobs.length} 段 `;
        const dl = document.createElement('button');
        dl.textContent = '下载本段';
        dl.addEventListener('click', () => downloadBlob(blob, dotName(meta.name, '-' + (i + 1))));
        cap.appendChild(dl);
        const img = new Image();
        img.src = URL.createObjectURL(blob);
        item.appendChild(cap); item.appendChild(img);
        list.appendChild(item);
      });
      $('wrap').appendChild(list);
      currentBlob = blobs[0];
      addNote('整图超出浏览器画布限制,无法合成单张长图,已提供逐段下载');
    }
  }

  function dotName(name, suffix) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(0, i) + suffix + name.slice(i) : name + suffix;
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

  /* ---------------- 下载 / 复制 ---------------- */
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
  $('btn-download').addEventListener('click', () => {
    if (currentBlob) downloadBlob(currentBlob, meta.name);
  });

  $('btn-copy').addEventListener('click', async () => {
    if (!currentBlob) return;
    try {
      let blob = currentBlob;
      if (blob.type !== 'image/png') {
        // 剪贴板图片仅 PNG:JPEG 经 canvas 重编码
        const bmp = await createImageBitmap(blob);
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        c.getContext('2d').drawImage(bmp, 0, 0);
        blob = await new Promise(res => c.toBlob(res, 'image/png'));
      }
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      flash('已复制到剪贴板');
    } catch (e) {
      flash('复制失败,请使用下载或在图片上右键复制');
    }
  });

  function flash(text) {
    const s = $('status');
    s.textContent = text;
    s.classList.remove('hidden');
    setTimeout(() => s.classList.add('hidden'), 2500);
  }

  init();
})();
