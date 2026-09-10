'use strict';
/**
 * 捕获流水线:full / visible / region / element 四种模式 + 作业状态机 + 防重入。
 * 坐标系纪律:跨边界只传「文档 CSS px」;clip 换算只发生在本文件,经 geom.clampClip 钳制。
 */
globalThis.ClipShot = globalThis.ClipShot || {};
(function (CS) {
  const { MSG, ERR } = CS;
  const mkErr = CS.cdp.mkErr;
  const codeOf = CS.cdp.codeOf;

  /** tabId → job */
  const jobsByTab = new Map();
  /** tabId → resolve(port) — content 侧 connect 到来时交付 */
  const scrollWaiters = new Map();
  /** jobId → {resolve,reject} 框选结果等待 */
  const marqueeWaiters = new Map();

  const MAX_CONCURRENT = 3;
  const TOTAL_TIMEOUT = 180000;   // 单作业最长 3 分钟
  const MARQUEE_WINDOW = 30000;   // 框选等待窗口
  const SCROLL_TIMEOUT = 75000;   // 滚动阶段兜底超时(content 侧自身 60s)
  const CANVAS_MAX_PX = 32767;    // 浏览器 canvas 单边上限(近似)

  const pipeline = {};

  /* ---------------------------------------------------------------- 工具 */

  function jobById(id) {
    for (const j of jobsByTab.values()) if (j.id === id) return j;
    return null;
  }

  function phase(job, p, pct) {
    if (job.phase === 'failed') return;
    job.phase = p;
    if (pct != null) job.pct = pct;
    CS.broadcast({
      type: MSG.JOB_EVENT, jobId: job.id, tabId: job.tabId, mode: job.mode,
      phase: p, pct: job.pct, text: CS.PHASE_TEXT[p] || p
    });
  }

  function toast(job, text) {
    CS.broadcast({
      type: MSG.JOB_EVENT, jobId: job.id, tabId: job.tabId, mode: job.mode,
      phase: job.phase, pct: job.pct, text
    });
  }

  function failJob(job, code) {
    job.phase = 'failed';
    CS.broadcast({
      type: MSG.JOB_EVENT, jobId: job.id, tabId: job.tabId, mode: job.mode,
      phase: 'failed', pct: 100, text: CS.errText(code)
    });
  }

  function abortCheck(job) {
    if (job.abortCode) throw mkErr(job.abortCode);
  }

  async function sendToTab(tabId, msg, ms) {
    try {
      return await CS.cdp.withTimeout(chrome.tabs.sendMessage(tabId, msg), ms || 5000, ERR.CONTENT_DEAD);
    } catch (e) {
      if (e && e.clipshotCode && e.clipshotCode !== ERR.CONTENT_DEAD) {
        // content 明确回了 {ok:false,error}
        if (e.ok === false) throw mkErr(e.error);
        throw e;
      }
      throw mkErr(ERR.CONTENT_DEAD);
    }
  }

  const BAD_SCHEMES = /^(chrome|edge|devtools|view-source|chrome-extension|chromewebstore|about|brave):/i;
  function assertUsable(tab) {
    const url = tab.url || tab.pendingUrl || '';
    if (BAD_SCHEMES.test(url)) throw mkErr(ERR.PAGE_NOT_ALLOWED);
    if (tab.discarded) throw mkErr(ERR.CONTENT_DEAD);
    return url;
  }

  async function ensureContent(tabId) {
    try { await sendToTab(tabId, { type: MSG.PING }, 2000); return; } catch (e) { /* 未注入,补注入 */ }
    try {
      await chrome.scripting.executeScript({
        target: { tabId }, files: ['common/messages.js', 'common/geom.js', 'content/content.js']
      });
      await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/content.css'] });
    } catch (e) {
      throw mkErr(ERR.PAGE_NOT_ALLOWED);
    }
    try { await sendToTab(tabId, { type: MSG.PING }, 2000); }
    catch (e) { throw mkErr(ERR.CONTENT_DEAD); }
  }

  /** 从 base64 头部解析真实像素尺寸(分段/校验用)。 */
  function sizeFromB64(b64) {
    for (const n of [4096, 65536, b64.length]) {
      const sz = CS.geom.parseImageSize(CS.util.b64Decode(b64.slice(0, Math.min(n, b64.length) & ~3)));
      if (sz) return sz;
      if (n >= b64.length) break;
    }
    return null;
  }

  /* ---------------------------------------------------------- 作业入口 */

  pipeline.state = function () {
    return [...jobsByTab.values()].map(j => ({ tabId: j.tabId, mode: j.mode, phase: j.phase, pct: j.pct }));
  };

  pipeline.startJob = async function (tabId, mode, opts) {
    if (!['full', 'visible', 'region', 'element'].includes(mode)) return { ok: false, error: ERR.UNKNOWN };
    if (jobsByTab.has(tabId)) return { ok: false, error: ERR.BUSY };
    if (jobsByTab.size >= MAX_CONCURRENT) return { ok: false, error: ERR.BUSY };
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { ok: false, error: ERR.NO_TARGET };
    try { assertUsable(tab); } catch (e) { return { ok: false, error: codeOf(e) }; }
    const job = {
      id: crypto.randomUUID(), tabId, mode, opts: opts || {},
      phase: 'check', pct: 0, startedAt: Date.now(),
      settings: null, hideFixedApplied: false, aborted: false, abortCode: null
    };
    jobsByTab.set(tabId, job);
    chrome.alarms.create('watchdog-' + job.id, { periodInMinutes: 1 });
    runJob(job); // 内部消化错误并做清理
    return { ok: true, jobId: job.id };
  };

  pipeline.cancel = function (tabId) {
    const job = jobsByTab.get(tabId);
    if (!job) return { ok: true };
    job.abortCode = ERR.USER_CANCELED_BANNER;
    if (job.mode === 'full') {
      chrome.tabs.sendMessage(tabId, { type: MSG.SCROLL_STOP, reason: 'user' }).catch(() => {});
      const port = job.scrollPort;
      if (port) { try { port.postMessage({ cmd: 'stop' }); } catch (e) { /* noop */ } }
    }
    if (job.marqueeAlarm) {
      chrome.alarms.clear(job.marqueeAlarm);
      const w = marqueeWaiters.get(job.id);
      if (w) { w.resolve(null); marqueeWaiters.delete(job.id); }
    }
    return { ok: true };
  };

  pipeline.onTabClosed = function (tabId) {
    const job = jobsByTab.get(tabId);
    if (job) { job.abortCode = ERR.SCROLL_FAILED; }
    jobsByTab.delete(tabId);
    scrollWaiters.delete(tabId);
    CS.network.reset(tabId);
  };

  async function runJob(job) {
    try {
      const settings = await CS.loadSettings();
      job.settings = Object.assign(settings, job.opts || {});
      if (job.mode === 'full') await runFull(job);
      else if (job.mode === 'visible') await runVisible(job);
      else if (job.mode === 'region') await runRegion(job);
      else if (job.mode === 'element') await runElement(job);
    } catch (e) {
      failJob(job, codeOf(e));
      if (!(e && e.clipshotCode)) console.error('[ClipShot]', job.mode, e);
    } finally {
      jobsByTab.delete(job.tabId);
      scrollWaiters.delete(job.tabId);
      marqueeWaiters.delete(job.id);
      if (job.marqueeAlarm) chrome.alarms.clear(job.marqueeAlarm);
      chrome.alarms.clear('watchdog-' + job.id);
    }
  }

  pipeline.onAlarm = function (name) {
    if (name.startsWith('watchdog-')) {
      const job = jobById(name.slice(9));
      if (job && Date.now() - job.startedAt > TOTAL_TIMEOUT) {
        job.abortCode = ERR.CAPTURE_TIMEOUT;
        if (job.scrollPort) { try { job.scrollPort.postMessage({ cmd: 'stop' }); } catch (e) { /* noop */ } }
      }
    } else if (name.startsWith('marquee-')) {
      const id = name.slice(8);
      const w = marqueeWaiters.get(id);
      if (w) { w.resolve(null); marqueeWaiters.delete(id); }
    }
  };

  /* ------------------------------------------------------- 交付 → preview */

  async function deliver(job, data) {
    // data: { mime, notes:[], segments:[{b64}] } — 单段时 segments 长度 1
    const first = data.segments[0].b64;
    const sz = sizeFromB64(first);
    const notes = (data.notes || []).slice();
    if (!sz) notes.push('无法解析图片尺寸头,预览页将按解码结果展示');
    CS.imagestore.put(job.id, {
      mime: data.mime,
      name: CS.genName(job.mode, data.mime),
      notes,
      widthPx: sz ? sz.width : null,
      heightPx: sz ? sz.height : null,
      segments: data.segments
    });
    phase(job, 'done', 100);
    toast(job, '截图完成,正在打开预览页');
    await chrome.tabs.create({ url: chrome.runtime.getURL('preview/preview.html') + '?job=' + job.id });
  }

  /* ------------------------------------------------------- 通用 debugger 路径 */

  async function capturePageScreenshot(tabId, params, ms) {
    const res = await CS.cdp.call(tabId, 'Page.captureScreenshot', params, ms);
    if (!res || typeof res.data !== 'string' || res.data.length < 32) {
      const e = mkErr(ERR.CAPTURE_TIMEOUT); e.captureEmpty = true; throw e;
    }
    return res.data;
  }

  function captureParams(settings, extra) {
    const p = { format: settings.format, captureBeyondViewport: true };
    if (settings.format === 'jpeg') p.quality = Math.max(40, Math.min(100, settings.jpegQuality | 0));
    return Object.assign(p, extra || {});
  }

  async function withDebuggerSession(job, fn) {
    await CS.cdp.attach(job.tabId, job.id);
    try {
      abortCheck(job);
      await CS.cdp.call(job.tabId, 'Page.enable', {}, 5000);
      return await fn();
    } finally {
      await CS.cdp.detach(job.tabId);
    }
  }

  /* ------------------------------------------------------------- full 模式 */

  async function runFull(job) {
    const tab = await chrome.tabs.get(job.tabId);
    assertUsable(tab);
    phase(job, 'inject', 5);
    abortCheck(job);
    await ensureContent(job.tabId);

    phase(job, 'metrics', 8);
    abortCheck(job);
    const cm = await sendToTab(job.tabId, { type: MSG.METRICS }, 4000);

    phase(job, 'attach', 10);
    // 尽早 attach:活跃的 debugger 会话让 SW 保活(Chrome 116+),滚动阶段叠加 port 心跳
    await CS.cdp.attach(job.tabId, job.id);
    try {
      await CS.cdp.call(job.tabId, 'Page.enable', {}, 5000);
      await CS.network.enable(job.tabId);

      const s = job.settings;
      if (s.hideFixed) {
        phase(job, 'hideFixed', 12);
        await hideFixedRound(job);
      }

      phase(job, 'scroll', 15);
      abortCheck(job);
      const scrollInfo = await runAutoScroll(job, s);

      phase(job, 'backToTop', 55);
      if (s.hideFixed) {
        // 第二轮:收编滚动过程中新出现的 fixed/sticky
        phase(job, 'hideFixed', 56);
        await hideFixedRound(job);
      }
      await CS.util.sleep(150); // 等一次重绘稳定

      phase(job, 'metrics', 60);
      const raw = await CS.cdp.call(job.tabId, 'Page.getLayoutMetrics', {}, 5000);
      const css = CS.geom.normalizeMetrics(raw);
      job.css = css;
      if (css.cssW > 6000) throw mkErr(ERR.PAGE_TOO_LARGE); // 横向溢出不做二维分段

      // 超长页自动降体积:PNG 且超过阈值 → JPEG
      const notes = [];
      if (s.autoJpegForLong && s.format === 'png' && css.cssH > s.autoJpegMinCssH) {
        s.format = 'jpeg';
        notes.push(`页面较长(${Math.round(css.cssH)}px),已自动改用 JPEG 以控制体积`);
      }
      if (scrollInfo.infinite) notes.push('检测到无限滚动,仅包含已加载部分');
      if (scrollInfo.scroller === 'internal') notes.push('检测到 SPA 内部滚动容器,已按该容器滚动');
      if (scrollInfo.stoppedBy === 'none') notes.push('未检测到可滚动内容,结果可能不完整');

      phase(job, 'capture', 70);
      abortCheck(job);
      const expectedW = Math.round(css.cssW * (cm.dpr || 1));
      const expectedH = Math.round(css.cssH * (cm.dpr || 1));

      let segments = null;
      // 1) 整幅一次捕获
      if (css.cssH <= s.splitThreshold) {
        try {
          const b64 = await capturePageScreenshot(job.tabId, captureParams(s), 60000);
          abortCheck(job);
          const sz = sizeFromB64(b64);
          if (!sz || closeEnough(sz.width, expectedW) && closeEnough(sz.height, expectedH)) {
            segments = [{ b64 }];
          } else {
            notes.push('整幅捕获尺寸与预期不符,已自动改用分段捕获');
          }
        } catch (e) {
          if (e.clipshotCode === ERR.USER_CANCELED_BANNER || job.abortCode) throw e;
          notes.push('整幅捕获失败,已自动改用分段捕获');
        }
      }
      // 2) 整幅降分辨率重试一次(高分屏/超长页省内存)
      if (!segments) {
        try {
          const b64 = await capturePageScreenshot(job.tabId, captureParams(s, {
            clip: { x: 0, y: 0, width: css.cssW, height: css.cssH, scale: 0.5 }
          }), 60000);
          const sz = sizeFromB64(b64);
          if (sz && sz.width >= expectedW * 0.25 && sz.height >= expectedH * 0.25) {
            segments = [{ b64 }];
            notes.push('已按 1/2 分辨率捕获以适配页面尺寸');
          }
        } catch (e) {
          if (job.abortCode) throw e;
        }
      }
      // 3) 分段兜底
      if (!segments) segments = await runSegmented(job, css, notes);

      await deliver(job, { mime: 'image/' + s.format, notes, segments });
    } catch (e) {
      // 用户取消横幅等 onDetach 已标记 abortCode 时给出准确文案
      if (e && e.clipshotCode) throw e;
      throw e;
    } finally {
      // 四层防泄漏:finally 必做 detach;restore 固定元素;停网络监听
      await CS.network.disable(job.tabId);
      if (job.hideFixedApplied) {
        try { await sendToTab(job.tabId, { type: MSG.RESTORE_FIXED }, 3000); } catch (e) { /* 页面可能已刷新 */ }
      }
      await CS.cdp.detach(job.tabId);
    }
  }

  function closeEnough(a, b) { return Math.abs(a - b) <= Math.max(2, b * 0.02); }

  async function hideFixedRound(job) {
    try {
      const r = await sendToTab(job.tabId, { type: MSG.HIDE_FIXED }, 8000);
      if (r && r.ok) job.hideFixedApplied = true;
    } catch (e) { /* 隐藏失败不阻断截图,继续 */ }
  }

  async function runAutoScroll(job, s) {
    const ratio = CS.SCROLL_SPEED_RATIO[s.scrollSpeed] || 0.75;
    const cfg = {
      stepRatio: ratio, settleMs: 350, imgWaitMaxMs: 1200,
      maxScrollPx: s.maxScrollPx, totalTimeoutMs: SCROLL_TIMEOUT - 10000
    };
    let info = { fullyScrolled: true, infinite: false, stoppedBy: 'bottom', scroller: 'document' };
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(mkErr(ERR.SCROLL_FAILED)), SCROLL_TIMEOUT);
      scrollWaiters.set(job.tabId, (p) => { clearTimeout(timer); resolve(p); });
      sendToTab(job.tabId, { type: MSG.SCROLL_START, cfg }, 5000).catch((e) => {
        clearTimeout(timer); scrollWaiters.delete(job.tabId); reject(e.clipshotCode ? e : mkErr(ERR.SCROLL_FAILED));
      });
    });
    job.scrollPort = port;
    try {
      const outcome = await new Promise((resolve, reject) => {
        let settled = false;
        const done = (fn, arg) => { if (!settled) { settled = true; fn(arg); } };
        port.onMessage.addListener((m) => {
          if (!m || !m.ev) return;
          if (m.ev === 'progress') {
            const pct = 15 + Math.max(0, Math.min(75, (m.pct || 0) * 40));
            phase(job, 'scroll', pct);
            info.docH = m.docH;
          } else if (m.ev === 'stepSettled') {
            // 网络空闲门控后放行下一步
            CS.network.waitForIdle(job.tabId, 300, 2000).finally(() => {
              try { port.postMessage({ cmd: 'proceed' }); } catch (e) { /* 已断开 */ }
            });
          } else if (m.ev === 'atTopDone') {
            // 已回顶;等待随后的 done
          } else if (m.ev === 'done') {
            info.fullyScrolled = m.fullyScrolled !== false;
            info.infinite = !!m.infinite;
            info.stoppedBy = m.stoppedBy || 'bottom';
            done(resolve, info);
          } else if (m.ev === 'error') {
            done(reject, mkErr(m.code || ERR.SCROLL_FAILED));
          }
        });
        port.onDisconnect.addListener(() => {
          if (!settled) {
            settled = true;
            if (job.abortCode) reject(mkErr(job.abortCode));
            else resolve(info); // 滚动基本完成但页面变化,放行捕获
          }
        });
      });
      return outcome;
    } finally {
      job.scrollPort = null;
      try { port.disconnect(); } catch (e) { /* noop */ }
    }
  }

  pipeline.handleScrollConnect = function (port) {
    const tabId = port.sender && port.sender.tab && port.sender.tab.id;
    const w = tabId != null ? scrollWaiters.get(tabId) : null;
    if (!w) { try { port.disconnect(); } catch (e) { /* noop */ } return; }
    scrollWaiters.delete(tabId);
    w(port);
  };

  async function runSegmented(job, css, notes) {
    const s = job.settings;
    notes.push('页面超出单幅上限,已自动分段捕获并拼接');
    // 分段模式强制隐藏固定元素,否则每段重复绘制 fixed
    if (!job.hideFixedApplied) {
      phase(job, 'hideFixed', 65);
      await hideFixedRound(job);
    }
    phase(job, 'stitch', 70);
    const ranges = CS.geom.splitRanges(css.cssH, s.chunkHeight);
    const segments = [];
    let consecutiveFail = 0;
    for (let i = 0; i < ranges.length; i++) {
      abortCheck(job);
      const [a, b] = ranges[i];
      let b64 = null;
      for (let attempt = 0; attempt < 2 && !b64; attempt++) {
        try {
          b64 = await capturePageScreenshot(job.tabId, captureParams(s, {
            clip: { x: 0, y: a, width: css.cssW, height: b - a, scale: attempt === 0 ? 1 : 0.5 }
          }), 30000);
        } catch (e) {
          if (e.clipshotCode === ERR.USER_CANCELED_BANNER || job.abortCode) throw e;
          await CS.util.sleep(400);
        }
      }
      if (!b64) {
        consecutiveFail++;
        if (consecutiveFail >= 2) throw mkErr(ERR.CAPTURE_TIMEOUT);
        continue;
      }
      consecutiveFail = 0;
      segments.push({ b64 });
      phase(job, 'stitch', 70 + Math.round((i + 1) / ranges.length * 25));
    }
    if (segments.length === 0) throw mkErr(ERR.CAPTURE_TIMEOUT);
    // 总内存保护
    const total = segments.reduce((n, x) => n + x.b64.length, 0);
    if (total > 200 * 1024 * 1024) throw mkErr(ERR.MEMORY_LIMIT);
    return segments;
  }

  /* ---------------------------------------------------------- visible 模式 */

  async function runVisible(job) {
    const tab = await chrome.tabs.get(job.tabId);
    assertUsable(tab);
    phase(job, 'capture', 50);
    const s = job.settings;
    const dataUrl = await CS.cdp.withTimeout(
      chrome.tabs.captureVisibleTab(tab.windowId, captureOpts(s)), 15000, ERR.CAPTURE_TIMEOUT
    );
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    await deliver(job, { mime: 'image/' + s.format, notes: [], segments: [{ b64 }] });
  }

  function captureOpts(s) {
    const o = { format: s.format };
    if (s.format === 'jpeg') o.quality = Math.max(40, Math.min(100, s.jpegQuality | 0));
    return o;
  }

  /* ----------------------------------------------------------- region 模式 */

  async function runRegion(job) {
    const tab = await chrome.tabs.get(job.tabId);
    assertUsable(tab);
    phase(job, 'inject', 5);
    await ensureContent(job.tabId);
    const cm = await sendToTab(job.tabId, { type: MSG.METRICS }, 4000);

    phase(job, 'capture', 10);
    toast(job, '请在页面上拖拽框选区域,Esc 取消');
    await sendToTab(job.tabId, { type: MSG.MARQUEE_BEGIN }, 4000);
    job.marqueeAlarm = 'marquee-' + job.id;
    chrome.alarms.create(job.marqueeAlarm, { delayInMinutes: MARQUEE_WINDOW / 60000 });
    const rect = await new Promise((resolve) => marqueeWaiters.set(job.id, { resolve }));
    marqueeWaiters.delete(job.id);
    chrome.alarms.clear(job.marqueeAlarm);
    job.marqueeAlarm = null;

    if (!rect) { // 取消或超时:静默收尾
      try { await sendToTab(job.tabId, { type: MSG.MARQUEE_CLEAR }, 3000); } catch (e) { /* noop */ }
      phase(job, 'done', 100);
      toast(job, '已取消框选');
      return;
    }

    const s = job.settings;
    const dataUrl = await CS.cdp.withTimeout(
      chrome.tabs.captureVisibleTab(tab.windowId, captureOpts(s)), 15000, ERR.CAPTURE_TIMEOUT
    );
    try { await sendToTab(job.tabId, { type: MSG.MARQUEE_CLEAR }, 3000); } catch (e) { /* noop */ }

    phase(job, 'capture', 80);
    const b64 = await cropDataUrl(dataUrl, rect, cm.dpr || 1, s);
    await deliver(job, { mime: 'image/' + s.format, notes: [], segments: [{ b64 }] });
  }

  /** OffscreenCanvas 按 dpr 从整视口图中裁剪出框选矩形(WYSIWYG)。 */
  async function cropDataUrl(dataUrl, rect, dpr, s) {
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    let sx = Math.round(rect.x * dpr);
    let sy = Math.round(rect.y * dpr);
    let sw = Math.round(rect.w * dpr);
    let sh = Math.round(rect.h * dpr);
    sx = Math.max(0, Math.min(sx, bmp.width - 1));
    sy = Math.max(0, Math.min(sy, bmp.height - 1));
    sw = Math.max(1, Math.min(sw, bmp.width - sx));
    sh = Math.max(1, Math.min(sh, bmp.height - sy));
    const c = new OffscreenCanvas(sw, sh);
    const ctx = c.getContext('2d');
    ctx.drawImage(bmp, sx, sy, sw, sh, 0, 0, sw, sh);
    const type = s.format === 'jpeg' ? 'image/jpeg' : 'image/png';
    const out = await c.convertToBlob({ type, quality: s.format === 'jpeg' ? s.jpegQuality / 100 : undefined });
    const buf = new Uint8Array(await out.arrayBuffer());
    return CS.util.b64Encode(buf);
  }

  pipeline.onMarqueeMessage = function (m, senderTabId) {
    const job = jobsByTab.get(senderTabId);
    if (!job || job.mode !== 'region') return;
    const w = marqueeWaiters.get(job.id);
    if (!w) return;
    if (m.type === MSG.MARQUEE_RESULT) {
      w.resolve({ x: m.x | 0, y: m.y | 0, w: Math.max(4, m.w | 0), h: Math.max(4, m.h | 0) });
    } else {
      w.resolve(null);
    }
    marqueeWaiters.delete(job.id);
  };

  /* ---------------------------------------------------------- element 模式 */

  async function runElement(job) {
    const tab = await chrome.tabs.get(job.tabId);
    assertUsable(tab);
    phase(job, 'inject', 10);
    await ensureContent(job.tabId);
    phase(job, 'check', 20);
    let pick;
    try {
      pick = await sendToTab(job.tabId, { type: MSG.PICK_GET, maxAgeMs: 30000 }, 4000);
    } catch (e) {
      throw mkErr(e.clipshotCode === ERR.CONTENT_DEAD ? ERR.CONTENT_DEAD : ERR.ELEMENT_GONE);
    }
    if (!pick || !pick.ok || !pick.rectDoc) throw mkErr(ERR.ELEMENT_GONE);

    phase(job, 'attach', 40);
    const s = job.settings;
    const b64 = await withDebuggerSession(job, async () => {
      const raw = await CS.cdp.call(job.tabId, 'Page.getLayoutMetrics', {}, 5000);
      const css = CS.geom.normalizeMetrics(raw);
      const rect = CS.geom.clampClip(pick.rectDoc, css.cssW, css.cssH);
      if (rect.width < 4 || rect.height < 4) throw mkErr(ERR.ELEMENT_GONE);
      abortCheck(job);
      phase(job, 'capture', 70);
      return capturePageScreenshot(job.tabId, captureParams(s, {
        clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }
      }), 15000);
    });
    await deliver(job, { mime: 'image/' + s.format, notes: [], segments: [{ b64 }] });
  }

  /* --------------------------------------------------------------- 事件路由 */

  pipeline.onDebuggerDetach = function (tabId, reason) {
    CS.network.reset(tabId);
    const job = jobsByTab.get(tabId);
    if (!job) return;
    if (reason === 'canceled_by_user') {
      job.abortCode = ERR.USER_CANCELED_BANNER;
      if (job.scrollPort) { try { job.scrollPort.postMessage({ cmd: 'stop' }); } catch (e) { /* noop */ } }
    } else if (reason === 'replaced_with_devtools') {
      job.abortCode = ERR.DEVTOOLS_CONFLICT;
    }
    // target_closed 由 tabs.onRemoved 清理
  };

  /* ---------------------------------------------------------------- 诊断 */

  pipeline.diag = async function (tabId) {
    try {
      await ensureContent(tabId);
    } catch (e) {
      return { ok: false, error: codeOf(e) };
    }
    let cm = null;
    try { cm = await sendToTab(tabId, { type: MSG.METRICS }, 4000); } catch (e) { /* 继续 */ }
    try {
      await CS.cdp.attach(tabId, 'diag');
      try {
        const raw = await CS.cdp.call(tabId, 'Page.getLayoutMetrics', {}, 5000);
        return { ok: true, raw, metrics: CS.geom.normalizeMetrics(raw), dpr: cm && cm.dpr };
      } finally {
        await CS.cdp.detach(tabId);
      }
    } catch (e) {
      return { ok: false, error: codeOf(e) };
    }
  };

  CS.pipeline = pipeline;
  CS.CANVAS_MAX_PX = CANVAS_MAX_PX;
})(globalThis.ClipShot);
