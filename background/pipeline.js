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
  const TOTAL_TIMEOUT = 300000;   // 单作业最长 5 分钟(v0.4.5:15+ 段的超长文档需要)
  const MARQUEE_WINDOW = 30000;   // 框选等待窗口
  const SCROLL_TIMEOUT = 75000;   // 滚动阶段兜底超时(content 侧自身 60s)

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
    // v0.7.1:可视区截图对任何页面都合法(captureVisibleTab 不区分页面类型);
    // 整页/元素/框选需要注入或调试器,内部页仍拦截
    if (mode !== 'visible') {
      try { assertUsable(tab); } catch (e) { return { ok: false, error: codeOf(e) }; }
    }
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
    const cm = await sendToTab(job.tabId, { type: MSG.METRICS }, 4000).catch(() => ({ dpr: 1 }));

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

      // v0.4.5:预判是否会走分段——会,则把自动滚动放在「拍摄视口」下预热。
      // 飞书类虚拟列表的块高估算随视口配置变化:在 934px 视口预热、却到 4000px
      // 视口拍摄,高度不收敛 → 相邻段内容涌动 → 重复拼接(用户实测)。
      // 预热视口=拍摄视口后,懒加载触发、高度收敛、内容预渲染一次完成,步数还更少。
      const dpr = Math.max(1, Math.min(3, (cm && cm.dpr) || 1));
      const AREA_CAP = 60 * 1024 * 1024; // 单次仿真视口最大设备像素面积
      let preWarmed = false;
      let scrollInfo;
      if (s.prescrolled) {
        // P015 手动预热模式:用户已自行把虚拟滚动内容全部滚出(高度在进入捕获前
        // 真收敛),加载与拍摄解耦——跳过预热仿真与自动滚动;其后的收敛门控、
        // 三段捕获路径与 P008 段间锚点全部保留,作「没滚完」情形的保险丝
        phase(job, 'scroll', 15);
        toast(job, '手动预热模式:跳过自动滚动');
        scrollInfo = { fullyScrolled: true, infinite: false, stoppedBy: 'manual', scroller: 'document' };
      } else {
        const capW0 = Math.max(1, Math.round((cm && cm.vw) || 1));
        const capH0 = Math.max(1, Math.round(
          (cm && cm.scroller === 'internal' && cm.scrollerH > 0) ? cm.scrollerH : ((cm && cm.docH) || 1)));
        if (CS.geom.pickEmulationScale(capW0, capH0, dpr, AREA_CAP) === 0) {
          const baseH = Math.max(500, Math.min(s.chunkHeight, Math.floor(s.maxPartDeviceH / dpr)));
          try {
            await CS.cdp.call(job.tabId, 'Emulation.setDeviceMetricsOverride', {
              width: capW0, height: baseH, deviceScaleFactor: dpr, mobile: false
            }, 5000);
            preWarmed = true;
          } catch (e) { /* 预热失败不阻断,runSegmented 会自做暖机遍历 */ }
        }

        phase(job, 'scroll', 15);
        abortCheck(job);
        scrollInfo = await runAutoScroll(job, s);
      }

      // P008 方案一:高度收敛门控。飞书类虚拟列表的总高在滚动结束后仍会随
      // 「估算块高 → 实测块高」替换而继续增长(用户实测:滚动中进度条越滚越长);
      // 不收敛就拍 → capH 失真 + 捕获中内容漂移 → 段间重复。
      phase(job, 'scroll', 50);
      toast(job, '等待页面高度收敛');
      const heightConverged = await waitHeightConverged(job);

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

      // 重新取滚动后的页面度量(飞书文档类虚拟滚动 SPA 的高度在滚动中动态变化;
      // 内部滚动容器页 document 高度只有约一屏,真实高度在容器 scrollHeight 里)
      const m2 = await sendToTab(job.tabId, { type: MSG.METRICS }, 4000).catch(() => null);
      const isInternal = !!(m2 && m2.scroller === 'internal' && m2.scrollerH > 0);
      // P015:记录捕获前内容高,拍完对账(见 deliver 前)——期间仍在长说明加载未竟
      const hBefore = (s.prescrolled && m2) ? (isInternal ? m2.scrollerH : m2.docH) : null;
      // 仿真宽度用 innerWidth:与当前布局宽度一致,避免滚动条消失/出现引发
      // 文本重排——重排正是分段拼接缝错位的根源之一
      const capW = Math.max(1, Math.round((m2 && m2.vw) || css.cssW));
      // v0.7.4:内部容器页的整幅仿真高度 = 内容高 + 容器顶部偏移(看板/后台页容器上方
      // 常有标签/筛选头部,容器实高=视口−头部,不算进去底部必缺一截)+ 16px 余量
      let capH = Math.max(1, Math.round(
        isInternal ? m2.scrollerH + Math.max(0, m2.scrollerTop | 0) + 16
                   : Math.max(css.cssH, (m2 && m2.docH) || 0)));

      // ── P003 治理:注记降噪(过程不逐条喊,最终一条路径说明)+ 三层上限
      const notes = [];
      if (s.prescrolled) notes.push('手动预热模式:已跳过自动滚动,仅包含已加载的内容');
      if (scrollInfo.infinite) notes.push('检测到无限滚动,仅包含已加载部分');
      if (!heightConverged) {
        notes.push(s.prescrolled
          ? '页面高度仍在增长:请先从头缓慢滚动至文档最底部(滚动条不再变长)再点开始,否则中段可能重复'
          : '页面高度未完全收敛,如中段有重复请重试一次');
      }
      if (isInternal) notes.push('检测到内部滚动容器(飞书/Notion 类文档),已按容器高度捕获');
      if (scrollInfo.stoppedBy === 'none') notes.push('未检测到可滚动内容,结果可能不完整');
      // ① 总长闸门:截断取前段并明示,绝不无限截碎图串
      const totalCap = CS.geom.clampTotal(capH, s.maxTotalCssH);
      if (totalCap.truncated) {
        notes.push(`页面超过总长上限,已截取前 ${totalCap.h}px,尾部约 ${Math.round(totalCap.dropped)}px 未截取(可在设置页调大「总长上限」)`);
      }
      capH = totalCap.h;
      if (s.autoJpegForLong && s.format === 'png' && capH > s.autoJpegMinCssH) {
        s.format = 'jpeg';
        notes.push('页面较长,已自动改用 JPEG 控制体积');
      }

      // 滚动归零:仿真视口拍的是 [scrollTop, scrollTop+H],不归零会缺头部
      try { await sendToTab(job.tabId, { type: MSG.SCROLL_TO, y: 0 }, 4000); } catch (e) { /* noop */ }

      phase(job, 'capture', 70);
      abortCheck(job);
      let segments = null;
      let pathNote = '';

      // ② 整幅优先(P003):面积超上限时先自动降尺度整幅(下限 1×,不再直接跳分段)。
      //    「一张完整图」优先于「最多清晰度」——对识图与预览都是正确取舍。
      //    机制仍是 DevTools「Capture full size screenshot」同款(仿真视口+普通截图);
      //    v0.1.x 实测教训:captureBeyondViewport 在该内核只渲染第一屏,彻底不依赖。
      let emuScale = CS.geom.pickEmulationScale(capW, capH, dpr, AREA_CAP);
      if (emuScale > 0) {
        try {
          await CS.cdp.call(job.tabId, 'Emulation.setDeviceMetricsOverride', {
            width: capW, height: capH, deviceScaleFactor: emuScale, mobile: false
          }, 5000);
          await CS.util.sleep(250);
          // 视口放大会触发一批 IntersectionObserver 懒加载 + 虚拟列表全量重渲染,
          // 双等待:网络空闲 + DOM/渲染稳定(后者是飞书文档类页面的关键)
          await CS.network.waitForIdle(job.tabId, 500, 3000);
          let rs = await sendToTab(job.tabId, { type: MSG.RENDER_STABLE, timeoutMs: 4000 }, 8000).catch(() => null);
          // 固定高度容器(聊天面板类)不随视口拉伸,仿真无效 → 明确报错而非静默出残图。
          // v0.7.4:对照「容器内容高」而非仿真高——仿真高含头部偏移,用它会误伤
          // 正常看板页(clientH = docH − 头部,可能低于 capH*0.9 却完全正常)
          const contentH = rs && rs.docH > 0 ? rs.docH : capH;
          if (isInternal && rs && rs.clientH > 0 && rs.clientH < contentH * 0.9) {
            throw mkErr(ERR.FIXED_CONTAINER);
          }
          // 放大后重排可能让内容更高(占位块换真实内容):再放大一次(仍守面积上限与总长闸门)
          if (rs && rs.docH > capH + 4) {
            const again = CS.geom.clampTotal(Math.round(rs.docH), s.maxTotalCssH);
            const s2 = CS.geom.pickEmulationScale(capW, again.h, dpr, AREA_CAP);
            if (s2 > 0) {
              capH = again.h;
              emuScale = s2;
              await CS.cdp.call(job.tabId, 'Emulation.setDeviceMetricsOverride', {
                width: capW, height: capH, deviceScaleFactor: emuScale, mobile: false
              }, 5000);
              await CS.util.sleep(200);
              rs = await sendToTab(job.tabId, { type: MSG.RENDER_STABLE, timeoutMs: 4000 }, 8000).catch(() => null);
            }
          }
          // P003.1:截图前重新归零(仿真 resize/重渲染可能把滚动位置漂走,漂了就缺头部)
          try { await sendToTab(job.tabId, { type: MSG.SCROLL_TO, y: 0 }, 3000); } catch (e) { /* noop */ }
          abortCheck(job);
          const b64 = await capturePageScreenshot(job.tabId, captureOpts(s), 60000);
          const complete = !rs || rs.docH <= capH + 4;
          if (complete && CS.geom.aspectOk(sizeFromB64(b64), capW, capH)) {
            segments = [{ b64 }];
            pathNote = '已单张完整截取';
            if (rs && !rs.stable) notes.push('页面渲染未完全稳定,如有区块缺失请重试或在设置中调慢滚动速度');
          }
        } catch (e) {
          if (e.clipshotCode === ERR.FIXED_CONTAINER || e.clipshotCode === ERR.USER_CANCELED_BANNER || job.abortCode) throw e;
          /* 整幅失败静默转下一级,由 pathNote 说明最终路径 */
        } finally {
          await clearViewportEmulation(job.tabId);
        }
      }

      // ③ 兼容兜底:clip + captureBeyondViewport(旧版 Chrome 的可靠写法)
      if (!segments && !isInternal && css.cssH <= s.splitThreshold) {
        for (const scale of [1, 0.5]) {
          // 单边物理上限同样约束兜底路径(超限输出尺寸对但内容回绕,v0.4.2 教训)
          if (css.cssH * scale * dpr > CS.geom.MAX_CAPTURE_DIM) continue;
          try {
            const b64 = await capturePageScreenshot(job.tabId, captureParams(s, {
              clip: { x: 0, y: 0, width: css.cssW, height: css.cssH, scale }
            }), 60000);
            if (CS.geom.aspectOk(sizeFromB64(b64), css.cssW, css.cssH)) {
              segments = [{ b64 }];
              pathNote = scale === 0.5 ? '已单张完整截取(兼容模式,1/2 分辨率)' : '已单张完整截取(兼容模式)';
              break;
            }
          } catch (e) {
            if (e.clipshotCode === ERR.USER_CANCELED_BANNER || job.abortCode) throw e;
          }
        }
      }

      // ④ 分段兜底:段高受单图上限(maxPartDeviceH)自动收敛;总长受 capH 闸门约束
      if (!segments) {
        segments = await runSegmented(job, capW, capH, dpr, s, preWarmed);
        pathNote = `页面超出浏览器单张捕获上限,已分 ${segments.length} 段拍摄;预览与下载为合成后的单张长图`;
      }
      if (pathNote) notes.unshift(pathNote);

      // P015 高度对账:捕获窗口内内容仍在长 → 中段重复高危,给可见信号
      if (hBefore > 0) {
        const m3 = await sendToTab(job.tabId, { type: MSG.METRICS }, 4000).catch(() => null);
        const hAfter = m3 ? (isInternal ? m3.scrollerH : m3.docH) : 0;
        if (hAfter > hBefore + 8) {
          notes.push(`捕获期间页面仍在增长(${Math.round(hBefore)}→${Math.round(hAfter)}px),中段可能有重复,请缓慢滚到底后重截`);
        }
      }

      await deliver(job, { mime: 'image/' + s.format, notes, segments });
    } finally {
      // 四层防泄漏:finally 必做 detach;清视口仿真;restore 固定元素;停网络监听
      await clearViewportEmulation(job.tabId);
      await CS.network.disable(job.tabId);
      if (job.hideFixedApplied) {
        try { await sendToTab(job.tabId, { type: MSG.RESTORE_FIXED }, 3000); } catch (e) { /* 页面可能已刷新 */ }
      }
      await CS.cdp.detach(job.tabId);
    }
  }

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

  /**
   * P008 方案一:等虚拟列表总高收敛——连续两轮 RENDER_STABLE 等高才算完;
   * 长高则回底再滚一轮逼出剩余懒加载;6 轮不收敛降级继续(调用方加提示注记)。
   * 结束时回顶,不影响后续捕获流程。
   */
  async function waitHeightConverged(job) {
    let lastH = -1, converged = false;
    for (let round = 0; round < 6 && !converged; round++) {
      abortCheck(job);
      const rs = await sendToTab(job.tabId, { type: MSG.RENDER_STABLE, timeoutMs: 3000 }, 8000).catch(() => null);
      const h = rs && rs.docH > 0 ? Math.round(rs.docH) : -1;
      if (h > 0 && h === lastH) { converged = true; break; }
      if (h > 0 && lastH > 0 && h > lastH + 2) {
        await sendToTab(job.tabId, { type: MSG.SCROLL_TO, y: h }, 4000).catch(() => null);
        await CS.util.sleep(500);
        await CS.network.waitForIdle(job.tabId, 300, 1500).catch(() => {});
      }
      if (h > 0) lastH = h;
    }
    try { await sendToTab(job.tabId, { type: MSG.SCROLL_TO, y: 0 }, 4000); } catch (e) { /* noop */ }
    return converged;
  }

  /** 幂等清除视口仿真(即使从未 set 也不抛)。 */
  async function clearViewportEmulation(tabId) {
    try { await CS.cdp.call(tabId, 'Emulation.clearDeviceMetricsOverride', {}, 3000); } catch (e) { /* noop */ }
  }

  /**
   * 自适应分段捕获(v0.2.1):
   * - 每轮先重测内容总高(虚拟滚动页面在捕获中高度会变,一次性预切分会错缝);
   * - 每段「先仿真视口=段高,再滚动定位」——反序会让 resize 重排把 scrollTop
   *   钳制/漂移,带与带错位,正是拼接重复/缺行的主因;
   * - 滚动后校验 applied 与目标一致,钳制(触底)时收缩段高防与前段重叠;
   * - 每段截图前等渲染稳定(飞书文档类虚拟列表渲染新窗口需要时间)。
   */
  async function runSegmented(job, capW, limitH, dpr, s, preWarmed) {
    // 分段模式强制隐藏固定元素,否则每段重复绘制 fixed/sticky
    if (!job.hideFixedApplied) {
      phase(job, 'hideFixed', 65);
      await hideFixedRound(job);
    }
    phase(job, 'stitch', 70);
    const segments = [];
    // P003 单图上限:段高收敛到 maxPartDeviceH/dpr,保证每段远低于画布/纹理限制
    const baseH = Math.max(500, Math.min(s.chunkHeight, Math.floor(s.maxPartDeviceH / dpr)));

    // v0.4.5 关键:仿真视口贯穿整个分段流程,探测/滚动/拍摄同一配置。
    // 逐段「清除→重建」会让虚拟列表反复重排(934↔4000 横跳),内容在固定
    // scrollTop 下涌动 → 相邻段重叠 → 用户实测的「中间重复拼接好几次」。
    let emuKey = '';
    const setEmu = async (hCss, k) => {
      const height = Math.max(1, Math.round(hCss * k));
      const key = height + '@' + k;
      if (key === emuKey) return; // 同配置不重复 resize,避免无谓重排
      await CS.cdp.call(job.tabId, 'Emulation.setDeviceMetricsOverride', {
        width: capW, height, deviceScaleFactor: dpr * k, mobile: false
      }, 5000);
      emuKey = key;
    };

    // 暖机遍历(仅当调用方未预热):在拍摄视口下走一遍全文,让虚拟列表把
    // 估算高度全部换成实测高度(收敛),再回顶开始正式分段
    if (!preWarmed) {
      try {
        await setEmu(baseH, 1);
        let y = 0;
        for (let g = 0; g < 100; g++) {
          abortCheck(job);
          const rs = await sendToTab(job.tabId, { type: MSG.RENDER_STABLE, timeoutMs: 1500 }, 5000).catch(() => null);
          const H = rs && rs.docH > 0 ? rs.docH : limitH;
          if (y >= H) break;
          await sendToTab(job.tabId, { type: MSG.SCROLL_TO, y }, 4000).catch(() => {});
          await CS.util.sleep(120);
          y += baseH;
        }
        await sendToTab(job.tabId, { type: MSG.SCROLL_TO, y: 0 }, 4000).catch(() => {});
        await sendToTab(job.tabId, { type: MSG.RENDER_STABLE, timeoutMs: 2000 }, 5000).catch(() => {});
      } catch (e) {
        if (job.abortCode) throw mkErr(job.abortCode);
      }
    }

    let pos = 0, totalH = Infinity, iter = 0, consecutiveFail = 0;
    // P008 方案二:段间内容锚点 {id, margin}。margin = 打标时锚块到段底缝口的
    // 内容距离(内容相对量,不随上方漂移变化);下一段按锚块当前偏移重算起点,
    // 定位基准从「scrollTop 数值」变成「内容」,已截区域长高不再造成段间重复。
    let anchor = null;
    while (iter++ < 200) {
      abortCheck(job);
      // 探测在当前仿真配置下进行(与拍摄同视口,高度口径一致)
      const probe = await sendToTab(job.tabId, { type: MSG.RENDER_STABLE, timeoutMs: 2500 }, 6000).catch(() => null);
      if (probe && probe.docH > 0) totalH = probe.docH;
      // 锚点校正:锚块被虚拟列表回收(found:false)时降级为数值推进
      if (anchor) {
        const af = await sendToTab(job.tabId, { type: MSG.ANCHOR_FIND, id: anchor.id }, 3000).catch(() => null);
        if (af && af.found && typeof af.top === 'number') {
          pos = Math.max(0, Math.round(af.top + anchor.margin));
        }
        anchor = null;
      }
      const stopAt = Math.min(totalH, limitH); // 总长闸门同样约束分段
      if (!(pos < stopAt - 2)) break;
      let h = Math.min(baseH, Math.ceil(stopAt - pos));
      let b64 = null, applied = pos;
      for (let attempt = 0; attempt < 2 && !b64; attempt++) {
        const k = attempt === 0 ? 1 : 0.5; // 重试降分辨率
        try {
          await setEmu(h, k);
          const st = await sendToTab(job.tabId, { type: MSG.SCROLL_TO, y: pos }, 4000);
          applied = st && typeof st.applied === 'number' ? st.applied : pos;
          // 触底钳制保护:实际可滚位置不足时,把段高收缩到剩余内容,防与前段重叠
          if (totalH !== Infinity && applied + h > totalH + 2) {
            h = Math.max(1, Math.ceil(totalH - applied));
            await setEmu(h, k);
          }
          await CS.util.sleep(120);
          await CS.network.waitForIdle(job.tabId, 250, 1500);
          // 等虚拟列表把本段窗口渲染完(占位块 → 真实内容)
          await sendToTab(job.tabId, { type: MSG.RENDER_STABLE, timeoutMs: 2500 }, 6000).catch(() => {});
          // v0.4.1 截图前复核滚动位置:前跳(丢内容)重试;回缩(布局收缩)收缩段高防重叠
          const ra = await sendToTab(job.tabId, { type: MSG.SCROLL_TO, y: applied }, 4000).catch(() => null);
          const finalApplied = ra && typeof ra.applied === 'number' ? ra.applied : applied;
          if (finalApplied > applied + 4) {
            throw mkErr(ERR.SCROLL_FAILED); // 向前漂移,重试本段
          }
          if (finalApplied < applied - 2) {
            const probe2 = await sendToTab(job.tabId, { type: MSG.RENDER_STABLE, timeoutMs: 1200 }, 4000).catch(() => null);
            const freshH = probe2 && probe2.docH > 0 ? probe2.docH : totalH;
            h = Math.max(1, Math.min(h, Math.ceil(freshH - finalApplied)));
            await setEmu(h, k);
            await CS.util.sleep(100);
            if (freshH !== Infinity) totalH = freshH; // 采信最新实测总高
          }
          applied = finalApplied;
          // P008:拍摄前在段底缝口打内容锚点,供下一段校正起点
          const am = await sendToTab(job.tabId, { type: MSG.ANCHOR_MARK }, 3000).catch(() => null);
          if (am && am.ok && am.id) anchor = { id: am.id, margin: Math.max(2, Math.round(am.bottom - am.top)) };
          const cand = await capturePageScreenshot(job.tabId, captureOpts(s), 30000);
          if (CS.geom.aspectOk(sizeFromB64(cand), capW, h, 0.08)) b64 = cand;
        } catch (e) {
          if (e.clipshotCode === ERR.USER_CANCELED_BANNER || job.abortCode) throw e;
        }
        if (!b64) await CS.util.sleep(400);
      }
      if (!b64) {
        consecutiveFail++;
        if (consecutiveFail >= 2) throw mkErr(ERR.CAPTURE_TIMEOUT);
        pos = applied + h; // 失败也推进,避免死循环
        anchor = null;     // 本段未拍到,锚点失效,下段走数值推进
        continue;
      }
      consecutiveFail = 0;
      segments.push({ b64 });
      pos = applied + h; // 以实际滚动位置推进,吸收钳制/重排漂移
      phase(job, 'stitch', totalH === Infinity ? 80 : 70 + Math.min(25, Math.round((pos / totalH) * 25)));
    }
    if (segments.length === 0) throw mkErr(ERR.CAPTURE_TIMEOUT);
    // 总内存保护
    const total = segments.reduce((n, x) => n + x.b64.length, 0);
    if (total > 200 * 1024 * 1024) throw mkErr(ERR.MEMORY_LIMIT);
    await clearViewportEmulation(job.tabId); // 循环结束才统一清除(不再逐段清除/重建)
    emuKey = '';
    try { await sendToTab(job.tabId, { type: MSG.SCROLL_TO, y: 0 }, 4000); } catch (e) { /* noop */ }
    return segments;
  }

  /* ---------------------------------------------------------- visible 模式 */

  async function runVisible(job) {
    const tab = await chrome.tabs.get(job.tabId);
    if (tab.discarded) throw mkErr(ERR.CONTENT_DEAD); // 休眠页无渲染可截
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

  /** 可视区捕获 + 按 CSS px 矩形裁剪;按设置可选隐藏固定元素(截完恢复)。
      隐藏 fixed/sticky 不改变文档流,已测得的 rect 仍然有效。 */
  async function shootVisibleRect(job, tab, s, dpr, rectCss) {
    let hid = false;
    try {
      if (s.hideFixed) {
        const r = await sendToTab(job.tabId, { type: MSG.HIDE_FIXED }, 8000).catch(() => null);
        hid = !!(r && r.ok);
        if (hid) await CS.util.sleep(80);
      }
      const dataUrl = await CS.cdp.withTimeout(
        chrome.tabs.captureVisibleTab(tab.windowId, captureOpts(s)), 15000, ERR.CAPTURE_TIMEOUT
      );
      return await cropDataUrl(dataUrl, rectCss, dpr, s);
    } finally {
      if (hid) {
        try { await sendToTab(job.tabId, { type: MSG.RESTORE_FIXED }, 3000); } catch (e) { /* noop */ }
      }
    }
  }

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
    if (!pick || !pick.ok || !pick.rectDoc) throw mkErr(pick && pick.error ? pick.error : ERR.ELEMENT_GONE);
    const s = job.settings;
    const m = await sendToTab(job.tabId, { type: MSG.METRICS }, 4000).catch(() => null);
    const dpr = Math.max(1, Math.min(3, (m && m.dpr) || 1));

    // 1) 元素完整落在当前视口内 → captureVisibleTab + 裁剪,零横幅零调试会话
    const rv = pick.rectVp;
    if (m && rv && rv.x >= -1 && rv.y >= -1 &&
        rv.x + rv.width <= m.vw + 1 && rv.y + rv.height <= m.vh + 1) {
      phase(job, 'capture', 50);
      const b64 = await shootVisibleRect(job, tab, s, dpr,
        { x: Math.max(0, rv.x), y: Math.max(0, rv.y), w: rv.width, h: rv.height });
      await deliver(job, { mime: 'image/' + s.format, notes: [], segments: [{ b64 }] });
      return;
    }

    // 2) 元素在视口外:原生 scrollIntoView 滚到元素,再走可视区捕获(仍零横幅;
    //    且对内部滚动容器页面天然正确——不依赖任何文档坐标换算)
    phase(job, 'capture', 40);
    const siv = await sendToTab(job.tabId, { type: MSG.SCROLL_INTO_VIEW }, 5000).catch(() => null);
    if (siv && siv.ok && siv.fits && siv.rectVp) {
      try {
        const b64 = await shootVisibleRect(job, tab, s, dpr,
          { x: Math.max(0, siv.rectVp.x), y: Math.max(0, siv.rectVp.y), w: siv.rectVp.width, h: siv.rectVp.height });
        await deliver(job, { mime: 'image/' + s.format, notes: [], segments: [{ b64 }] });
        return;
      } finally {
        if (typeof siv.prevY === 'number') {
          sendToTab(job.tabId, { type: MSG.SCROLL_TO, y: siv.prevY }, 3000).catch(() => {});
        }
      }
    }

    // 3) 超高元素(放不进一屏):调试会话 + 仿真视口缩到元素尺寸条带
    phase(job, 'attach', 55);
    const notes = [];
    const b64 = await withDebuggerSession(job, async () => {
      const raw = await CS.cdp.call(job.tabId, 'Page.getLayoutMetrics', {}, 5000);
      const css = CS.geom.normalizeMetrics(raw);
      // rectDoc 在活动滚动容器坐标系:内部容器页面(飞书类)document 高度只有一屏,
      // 钳制边界必须用容器内容高度,否则 y 会被错误截断
      const boundW = Math.max(1, Math.round((m && m.vw) || css.cssW));
      const boundH = Math.max(1, Math.round(
        (m && m.scroller === 'internal' && m.scrollerH > 0) ? m.scrollerH : Math.max(css.cssH, (m && m.docH) || 0)
      ));
      const rect = CS.geom.clampClip(pick.rectDoc, boundW, boundH);
      if (rect.width < 4 || rect.height < 4) throw mkErr(ERR.ELEMENT_GONE);
      abortCheck(job);
      phase(job, 'capture', 70);
      const AREA_CAP = 60 * 1024 * 1024;
      // 仿真宽度取测量 rect 时的视口宽,保证布局不重排(rect 与像素一一对应)
      const bandW = Math.max(1, Math.round((m && m.vw) || css.cssW));
      if (css.cssW * dpr * rect.height * dpr > AREA_CAP ||
          rect.height * dpr > CS.geom.MAX_CAPTURE_DIM ||
          bandW * dpr > CS.geom.MAX_CAPTURE_DIM) {
        // 超大元素(面积或单边超限):退回 clip + captureBeyondViewport(尽力而为)
        const b = await capturePageScreenshot(job.tabId, captureParams(s, {
          clip: { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 }
        }), 15000);
        if (!CS.geom.aspectOk(sizeFromB64(b), rect.width, rect.height, 0.1)) {
          throw mkErr(ERR.PAGE_TOO_LARGE);
        }
        return b;
      }
      let prevY = 0;
      try {
        // 先仿真后滚动(反序会被 resize 重排钳制/漂移 scrollTop,同分段模式的教训)
        await CS.cdp.call(job.tabId, 'Emulation.setDeviceMetricsOverride', {
          width: bandW, height: Math.round(rect.height),
          deviceScaleFactor: dpr, mobile: false
        }, 5000);
        const st = await sendToTab(job.tabId, { type: MSG.SCROLL_TO, y: rect.y }, 4000);
        if (st && st.ok && typeof st.prev === 'number') prevY = st.prev;
        await CS.util.sleep(150);
        await CS.network.waitForIdle(job.tabId, 250, 1500);
        const rs = await sendToTab(job.tabId, { type: MSG.RENDER_STABLE, timeoutMs: 2000 }, 5000).catch(() => null);
        // 固定高度容器不随视口拉伸 → 条带截图必然残缺,明确报错
        if (m && m.scroller === 'internal' && rs && rs.clientH > 0 && rs.clientH < rect.height * 0.9) {
          throw mkErr(ERR.FIXED_CONTAINER);
        }
        // P003.1:截图前重锁元素位置(重渲染可能漂移滚动)
        await sendToTab(job.tabId, { type: MSG.SCROLL_TO, y: rect.y }, 3000).catch(() => {});
        const band = await capturePageScreenshot(job.tabId, captureOpts(s), 15000);
        // 条带截图 = 整页宽 × 元素高,按元素 x 偏移裁出精确区域
        const dataUrl = 'data:image/' + (s.format === 'jpeg' ? 'jpeg' : 'png') + ';base64,' + band;
        return await cropDataUrl(dataUrl,
          { x: rect.x, y: 0, w: rect.width, h: rect.height }, dpr, s);
      } finally {
        await clearViewportEmulation(job.tabId);
        try { await sendToTab(job.tabId, { type: MSG.SCROLL_TO, y: prevY }, 3000); } catch (e) { /* noop */ }
      }
    });
    await deliver(job, { mime: 'image/' + s.format, notes, segments: [{ b64 }] });
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
    // 诊断也要建调试会话:若该页正在截图,attach 会冲突,直接报 BUSY
    if (jobsByTab.has(tabId)) return { ok: false, error: ERR.BUSY };
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
        // page:页面侧 METRICS(v0.4.5 起随诊断输出)——getLayoutMetrics 只看得到
        // document(飞书类页面恒为一屏 934px),虚拟滚动容器的真实高度在这里
        return { ok: true, raw, metrics: CS.geom.normalizeMetrics(raw), dpr: cm && cm.dpr, page: cm };
      } finally {
        await CS.cdp.detach(tabId);
      }
    } catch (e) {
      return { ok: false, error: codeOf(e) };
    }
  };

  CS.pipeline = pipeline;
})(globalThis.ClipShot);
