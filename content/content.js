'use strict';
/**
 * ClipShot content script:自动滚动(port)、fixed/sticky 隐藏/恢复、
 * contextmenu 元素记录、框选 marquee 覆盖层、metrics。
 * 协议常量来自 common/messages.js;工具来自 common/geom.js(manifest 保证加载顺序)。
 */
(function () {
  const CS = globalThis.ClipShot;
  const { MSG, ERR } = CS;
  const sleep = CS.util.sleep;

  /* ---------------------------------------------------------- metrics */

  function describe(el) {
    if (!el || el === document.documentElement || el === document.scrollingElement) return 'document';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.className && typeof el.className === 'string') s += '.' + el.className.trim().split(/\s+/)[0];
    return s;
  }

  function findScroller() {
    const de = document.scrollingElement || document.documentElement;
    if (de.scrollHeight - de.clientHeight > 8) return { el: de, kind: 'document' };
    let best = null, bestSpan = 0;
    const vh = window.innerHeight || 400;
    const els = document.getElementsByTagName('*');
    for (const el of els) {
      if (el.scrollHeight > el.clientHeight + 8 && el.clientHeight >= vh * 0.5) {
        const cs = getComputedStyle(el);
        const oy = cs.overflowY;
        if (oy === 'auto' || oy === 'scroll') {
          const span = el.scrollHeight - el.clientHeight;
          if (span > bestSpan) { bestSpan = span; best = el; }
        }
      }
    }
    if (best) return { el: best, kind: 'internal' };
    return { el: de, kind: 'none' };
  }

  function metrics() {
    const de = document.documentElement;
    const body = document.body;
    const docW = Math.max(de.scrollWidth, body ? body.scrollWidth : 0, window.innerWidth);
    const docH = Math.max(de.scrollHeight, body ? body.scrollHeight : 0, window.innerHeight);
    const sc = findScroller();
    return {
      ok: true, docW, docH,
      vw: window.innerWidth, vh: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      scroller: sc.kind, scrollerPath: describe(sc.el),
      // 内部滚动容器(飞书文档类 SPA)的真实内容尺寸:
      // getLayoutMetrics 只能看到 document 高度(≈一屏),必须用容器 scrollHeight
      scrollerW: sc.kind === 'internal' ? sc.el.clientWidth : null,
      scrollerH: sc.kind === 'internal' ? sc.el.scrollHeight : null
    };
  }

  /**
   * 渲染稳定门控:轮询 scrollHeight + DOM 节点数,连续两次采样不变即认为
   * 虚拟列表(飞书/Notion 类)已完成当前窗口的渲染。视口仿真放大后、
   * 每段滚动定位后都要等它,否则截到半渲染的空白块。
   */
  async function renderStable(timeoutMs) {
    const t0 = Date.now();
    const timeout = Math.min(Math.max(timeoutMs || 3000, 500), 8000);
    let lastH = -1, lastN = -1, streak = 0;
    for (;;) {
      const sc = findScroller();
      const h = sc.el.scrollHeight;
      const n = document.getElementsByTagName('*').length;
      if (h === lastH && n === lastN) {
        if (++streak >= 2) return { ok: true, stable: true, docH: h, nodes: n, clientH: sc.el.clientHeight, waitedMs: Date.now() - t0 };
      } else {
        streak = 0;
      }
      lastH = h; lastN = n;
      if (Date.now() - t0 > timeout) {
        return { ok: true, stable: false, docH: lastH, nodes: lastN, clientH: sc.el.clientHeight, waitedMs: Date.now() - t0 };
      }
      await sleep(200);
    }
  }

  /* --------------------------------------------------- fixed/sticky 隐藏 */

  let hiddenList = null; // [{el, prop, prev, prevPri}]
  const hiddenSeen = new WeakSet();

  function scanAndHide() {
    const first = !hiddenList;
    if (first) hiddenList = [];
    let fixed = 0, sticky = 0;
    const els = document.getElementsByTagName('*');
    for (const el of els) {
      if (!first && hiddenSeen.has(el)) continue; // 第二轮只补收新出现的
      let pos;
      try { pos = getComputedStyle(el).position; } catch (e) { continue; }
      if (pos !== 'fixed' && pos !== 'sticky') continue;
      // 区别对待:fixed 不在流中 → display:none 安全;sticky 占流空间 → 只能 visibility:hidden(保留布局盒)
      const prop = pos === 'fixed' ? 'display' : 'visibility';
      const val = pos === 'fixed' ? 'none' : 'hidden';
      hiddenList.push({
        el, prop,
        prev: el.style.getPropertyValue(prop),
        prevPri: el.style.getPropertyPriority(prop)
      });
      el.style.setProperty(prop, val, 'important');
      hiddenSeen.add(el);
      if (pos === 'fixed') fixed++; else sticky++;
    }
    return { fixedCount: fixed, stickyCount: sticky };
  }

  function hideFixed() {
    const r = scanAndHide();
    return { ok: true, fixedCount: r.fixedCount, stickyCount: r.stickyCount };
  }

  function restoreFixed() {
    if (!hiddenList) return { ok: true, restored: 0 };
    let n = 0;
    for (const item of hiddenList) {
      try {
        if (item.prev === '' && item.prevPri === '') item.el.style.removeProperty(item.prop);
        else item.el.style.setProperty(item.prop, item.prev, item.prevPri);
        n++;
      } catch (e) { /* 节点可能已被移除 */ }
    }
    hiddenList = null;
    return { ok: true, restored: n };
  }

  /* ------------------------------------------------------- 自动滚动 */

  let scrollState = null;

  function startScroll(cfg) {
    if (scrollState) { try { scrollState.port.disconnect(); } catch (e) { /* noop */ } }
    const port = chrome.runtime.connect({ name: CS.SCROLL_PORT });
    scrollState = { port, cfg, stopped: false, proceedResolve: null };
    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.cmd === 'stop') scrollState.stopped = true;
      else if (msg.cmd === 'proceed' && scrollState.proceedResolve) scrollState.proceedResolve();
    });
    port.onDisconnect.addListener(() => { if (scrollState) scrollState.stopped = true; });
    runScrollLoop(port, cfg, scrollState);
    return { ok: true };
  }

  function post(port, obj) { try { port.postMessage(obj); } catch (e) { /* 已断开 */ } }

  function waitProceed(st, maxMs) {
    return new Promise((res) => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(t); st.proceedResolve = null; res(); } };
      st.proceedResolve = finish;
      const t = setTimeout(finish, maxMs);
    });
  }

  async function waitForImages(scrollerEl, maxMs) {
    const t0 = Date.now();
    const root = scrollerEl === document.documentElement || scrollerEl === document.body ? document : scrollerEl;
    for (;;) {
      let pending = 0;
      const imgs = root.getElementsByTagName('img');
      const vh = window.innerHeight;
      for (const img of imgs) {
        if (img.complete) continue;
        const r = img.getBoundingClientRect();
        if (r.bottom > -vh * 0.5 && r.top < vh * 2.5) { pending++; }
      }
      if (!pending || Date.now() - t0 > maxMs) return;
      await sleep(150);
    }
  }

  async function runScrollLoop(port, cfg, st) {
    let hb = null;
    const sc = findScroller();
    const el = sc.el;
    const initialTop = el.scrollTop;
    let finished = false;
    try {
      hb = setInterval(() => post(port, { ev: 'heartbeat' }), 4000);
      if (sc.kind !== 'none') {
        const vh = el.clientHeight || window.innerHeight;
        let lastH = el.scrollHeight, growCount = 0;
        let infinite = false, stoppedBy = 'bottom';
        const t0 = Date.now();
        let steps = 0;
        for (;;) {
          if (st.stopped) { stoppedBy = 'stopped'; break; }
          if (Date.now() - t0 > cfg.totalTimeoutMs) { stoppedBy = 'timeout'; break; }
          if (++steps > 5000) { stoppedBy = 'maxHeight'; break; }
          const pos = el.scrollTop;
          const max = el.scrollHeight - el.clientHeight;
          if (pos >= max - 2) {
            let grew = false;
            for (let k = 0; k < 2; k++) {
              await sleep(600);
              if (el.scrollHeight > lastH + 2) grew = true;
              lastH = el.scrollHeight;
            }
            if (!grew) { stoppedBy = 'bottom'; break; }
            growCount++;
            if (el.scrollHeight > cfg.maxScrollPx || growCount > 20) { infinite = true; stoppedBy = 'maxHeight'; break; }
            continue; // 继续滚动新加载出的部分
          }
          el.scrollTop = Math.min(pos + vh * cfg.stepRatio, el.scrollHeight);
          await sleep(cfg.settleMs);
          await waitForImages(el, cfg.imgWaitMaxMs);
          if (st.stopped) { stoppedBy = 'stopped'; break; }
          post(port, {
            ev: 'progress', scrollTop: el.scrollTop, docH: el.scrollHeight,
            pct: el.scrollTop / Math.max(1, el.scrollHeight - el.clientHeight)
          });
          post(port, { ev: 'stepSettled', scrollTop: el.scrollTop, docH: el.scrollHeight });
          await waitProceed(st, 2000);
        }
        // 回到顶部(CDP 整页捕获从文档原点开始,回顶避免视口状态干扰)
        el.scrollTop = initialTop > 0 ? initialTop : 0;
        await sleep(250);
        post(port, { ev: 'atTopDone', scrollTop: el.scrollTop });
        finished = true;
        post(port, { ev: 'done', fullyScrolled: !infinite && stoppedBy === 'bottom', infinite, stoppedBy });
      } else {
        post(port, { ev: 'atTopDone', scrollTop: 0 });
        finished = true;
        post(port, { ev: 'done', fullyScrolled: false, infinite: false, stoppedBy: 'none' });
      }
    } catch (e) {
      try { el.scrollTop = initialTop; } catch (e2) { /* noop */ }
      post(port, { ev: 'error', code: ERR.SCROLL_FAILED, msg: String((e && e.message) || e) });
    } finally {
      if (hb) clearInterval(hb);
      if (scrollState === st) scrollState = null;
      if (finished) { try { port.disconnect(); } catch (e) { /* noop */ } }
    }
  }

  function stopScroll(reason) {
    if (scrollState) scrollState.stopped = true;
    return { ok: true, reason };
  }

  /* ------------------------------------------------- 右键元素现场记录 */

  let pickRecord = null;
  document.addEventListener('contextmenu', (e) => {
    pickRecord = { el: e.target, at: Date.now() };
  }, true);

  /**
   * 视口 → 文档坐标换算只发生在这里(坐标系纪律)。
   * 内部滚动容器页面(飞书文档类)window 不滚动,坐标必须换算到
   * 「活动滚动容器的内容空间」,与 SCROLL_TO 的坐标系保持一致。
   */
  function rectOf(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return { ok: false, error: ERR.ELEMENT_GONE };
    const sc = findScroller();
    let rectDoc;
    if (sc.kind === 'internal') {
      const cr = sc.el.getBoundingClientRect();
      rectDoc = {
        x: r.x - cr.left + sc.el.scrollLeft,
        y: r.y - cr.top + sc.el.scrollTop,
        width: r.width, height: r.height
      };
    } else {
      rectDoc = { x: r.x + window.scrollX, y: r.y + window.scrollY, width: r.width, height: r.height };
    }
    return {
      ok: true,
      rectDoc,
      rectVp: { x: r.x, y: r.y, width: r.width, height: r.height }, // 视口坐标,用于「元素已在视口内」的零横幅判断
      tag: describe(el)
    };
  }

  function pickGet(maxAgeMs) {
    if (!pickRecord || Date.now() - pickRecord.at > (maxAgeMs || 30000)) {
      return { ok: false, error: ERR.ELEMENT_GONE };
    }
    const el = pickRecord.el;
    if (!el || !el.isConnected) return { ok: false, error: ERR.ELEMENT_GONE };
    return rectOf(el);
  }

  /** Agent 桥接:按 CSS 选择器定位元素(比右键拾取更适合程序调用) */
  function queryRect(selector) {
    if (!selector || typeof selector !== 'string') return { ok: false, error: ERR.NO_TARGET };
    let el = null;
    try { el = document.querySelector(selector); } catch (e) { return { ok: false, error: ERR.NO_TARGET }; }
    if (!el) return { ok: false, error: ERR.NO_TARGET };
    return rectOf(el);
  }

  /** 把右键记录的元素原生滚入视野,返回新鲜视口 rect(嵌套滚动容器由浏览器处理) */
  async function scrollIntoViewPick() {
    if (!pickRecord || Date.now() - pickRecord.at > 30000) return { ok: false, error: ERR.ELEMENT_GONE };
    const el = pickRecord.el;
    if (!el || !el.isConnected) return { ok: false, error: ERR.ELEMENT_GONE };
    const sc = findScroller();
    const prevY = sc.el.scrollTop;
    el.scrollIntoView({ block: 'start', inline: 'nearest' });
    await sleep(200);
    const r = el.getBoundingClientRect();
    return {
      ok: true, prevY,
      rectVp: { x: r.x, y: r.y, width: r.width, height: r.height },
      fits: r.x >= -1 && r.y >= -1 &&
        r.width <= window.innerWidth - 2 && r.height <= window.innerHeight - 2
    };
  }

  /** 分段/元素捕获的滚动定位(文档 CSS px) */
  async function scrollTo(y) {
    const sc = findScroller();
    const el = sc.el;
    const prev = el.scrollTop;
    el.scrollTop = Math.max(0, y);
    await sleep(60); // 让一帧渲染落地
    return { ok: true, prev, applied: el.scrollTop };
  }

  /* ------------------------------------------------------- 框选 marquee */

  let mq = null;

  const MQ_HTML = `
<style>
  :host{all:unset}
  .root{position:fixed;inset:0;overflow:hidden}
  .hole{position:absolute;display:none;border:1.5px dashed #4f8cff;background:rgba(79,140,255,.06);box-shadow:0 0 0 200000px rgba(0,0,0,.35)}
  .tip{position:fixed;top:16px;left:50%;transform:translateX(-50%);background:rgba(20,24,32,.85);color:#fff;font:13px/1.6 system-ui,sans-serif;padding:6px 14px;border-radius:6px;pointer-events:none;white-space:nowrap}
  .size{position:absolute;font:12px/1.4 system-ui,sans-serif;color:#fff;background:rgba(20,24,32,.85);padding:2px 8px;border-radius:4px;pointer-events:none;display:none;white-space:nowrap}
</style>
<div class="root"><div class="hole"></div><div class="size"></div><div class="tip">按住鼠标拖拽框选 · Esc 取消</div></div>`;

  function marqueeBegin() {
    marqueeTeardown();
    const host = document.createElement('div');
    host.setAttribute('data-clipshot', '');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.04)';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = MQ_HTML;
    const hole = shadow.querySelector('.hole');
    const size = shadow.querySelector('.size');
    const tip = shadow.querySelector('.tip');
    document.documentElement.appendChild(host);

    const listeners = [];
    const on = (t, ev, fn, opt) => { t.addEventListener(ev, fn, opt); listeners.push([t, ev, fn, opt]); };

    const teardown = () => marqueeTeardown();
    const state = { host, shadow, hole, size, listeners, dragging: false, x0: 0, y0: 0 };
    mq = state;

    on(window, 'wheel', (e) => e.preventDefault(), { passive: false, capture: true }); // 锁定滚动
    on(window, 'keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel('esc'); }
      if ([' ', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(e.key)) e.preventDefault();
    }, true);
    on(host, 'contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); cancel('rightclick'); }, true);
    on(host, 'mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      state.dragging = true; state.x0 = e.clientX; state.y0 = e.clientY;
      hole.style.display = 'block'; size.style.display = 'block';
      tip.style.display = 'none';
    }, true);
    on(host, 'mousemove', (e) => {
      if (!state.dragging) return;
      e.preventDefault();
      const x = Math.min(state.x0, e.clientX), y = Math.min(state.y0, e.clientY);
      const w = Math.abs(e.clientX - state.x0), h = Math.abs(e.clientY - state.y0);
      hole.style.left = x + 'px'; hole.style.top = y + 'px';
      hole.style.width = w + 'px'; hole.style.height = h + 'px';
      size.textContent = w + ' × ' + h;
      size.style.left = (x + 6) + 'px'; size.style.top = Math.max(0, y - 24) + 'px';
    }, true);
    on(host, 'mouseup', (e) => {
      if (!state.dragging) return;
      e.preventDefault(); e.stopPropagation();
      state.dragging = false;
      const x = Math.min(state.x0, e.clientX), y = Math.min(state.y0, e.clientY);
      const w = Math.abs(e.clientX - state.x0), h = Math.abs(e.clientY - state.y0);
      if (w < 4 || h < 4) { // 误触:留在 ARMED
        hole.style.display = 'none'; size.style.display = 'none'; tip.style.display = 'block';
        return;
      }
      // 先隐藏遮罩再发结果,避免把暗化遮罩截进图里(WYSIWYG 的反例要防)
      host.style.display = 'none';
      chrome.runtime.sendMessage({ type: MSG.MARQUEE_RESULT, x, y, w, h }).catch(() => {});
      // 保持监听直到 sw 发 MARQUEE_CLEAR
    }, true);

    function cancel(reason) {
      chrome.runtime.sendMessage({ type: MSG.MARQUEE_CANCEL, reason }).catch(() => {});
      teardown();
    }
    return { ok: true };
  }

  function marqueeTeardown() {
    if (!mq) return;
    for (const [t, ev, fn, opt] of mq.listeners) {
      try { t.removeEventListener(ev, fn, opt); } catch (e) { /* noop */ }
    }
    try { mq.host.remove(); } catch (e) { /* noop */ }
    mq = null;
  }

  /* ================= P005 Agent 操作:快照 / 动作 / 徽标 / console ================= */

  // ── console 转发接收(agent.js 向 MAIN world 注入探针,探针以 CustomEvent 送进来) ──
  document.addEventListener(MSG.CONSOLE_IN, (e) => {
    try {
      chrome.runtime.sendMessage({ type: MSG.CONSOLE, entries: (e && e.detail && e.detail.entries) || [] }).catch(() => {});
    } catch (err) { /* noop */ }
  });

  // ── 接管徽标 + Esc 夺回 ──
  let badge = null;
  const onEsc = (e) => {
    if (e.key === 'Escape' && badge) {
      chrome.runtime.sendMessage({ type: MSG.RELEASE, reason: 'user-esc' }).catch(() => {});
    }
  };
  function badgeOn() {
    if (badge) return;
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483646';
    const sh = host.attachShadow({ mode: 'closed' });
    sh.innerHTML = '<style>.b{background:#14331f;color:#aef0bd;font:12px/1.6 system-ui,sans-serif;padding:6px 12px;border-radius:8px;border:1px solid #2f8f4f;box-shadow:0 2px 10px rgba(0,0,0,.45);white-space:nowrap}</style><div class="b">🤖 Agent 控制中 · 按 Esc 交还</div>';
    document.documentElement.appendChild(host);
    badge = { host };
    window.addEventListener('keydown', onEsc, true);
  }
  function badgeOff() {
    if (!badge) return;
    window.removeEventListener('keydown', onEsc, true);
    try { badge.host.remove(); } catch (e) { /* noop */ }
    badge = null;
  }

  // ── 快照:结构变动防抖升 rev(旧编号过期,防“页面变了还按旧快照点”) ──
  let snapRev = 1;
  let snapEls = [];
  let revTimer = null;
  function startRevTracking() {
    if (revTimer !== null || typeof MutationObserver === 'undefined') return;
    new MutationObserver((ms) => {
      if (!ms.some(m => m.type === 'childList')) return;
      clearTimeout(revTimer);
      revTimer = setTimeout(() => { snapRev++; revTimer = 0; }, 400);
    }).observe(document.documentElement, { childList: true, subtree: true });
    revTimer = 0;
  }

  const SNAP_SELECTOR = 'a[href],button,input,select,textarea,summary,[role],[onclick],[tabindex]:not([tabindex="-1"]),' +
    'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],iframe[src*="geetest"],iframe[src*="captcha"]';
  function roleOf(el) {
    const r = el.getAttribute && el.getAttribute('role');
    if (r) return r;
    const t = el.tagName;
    if (t === 'A') return 'link';
    if (t === 'BUTTON') return 'button';
    if (t === 'SELECT') return 'combobox';
    if (t === 'TEXTAREA') return 'textbox';
    if (t === 'IFRAME') return 'captcha-frame';
    if (t === 'INPUT') return ({ text: 'textbox', search: 'searchbox', email: 'textbox', url: 'textbox', tel: 'textbox',
      number: 'spinbutton', checkbox: 'checkbox', radio: 'radio', range: 'slider', file: 'button', password: 'textbox' }[el.type] || el.type);
    return (el.onclick || (el.tabIndex >= 0)) ? 'button' : t.toLowerCase();
  }
  function textOf(el) {
    const t = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') ||
      el.getAttribute('title') || el.getAttribute('alt') || '').trim().replace(/\s+/g, ' ');
    return t.slice(0, 60);
  }
  function selOf(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    const path = [];
    let n = el;
    while (n && n.nodeType === 1 && path.length < 4) {
      let s = n.tagName.toLowerCase();
      if (n.id) { path.unshift('#' + CSS.escape(n.id)); break; }
      const parent = n.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === n.tagName);
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(n) + 1) + ')';
      }
      path.unshift(s);
      n = parent;
    }
    return path.join(' > ');
  }
  function querySnapshot() {
    startRevTracking();
    const vw = window.innerWidth, vh = window.innerHeight;
    const all = Array.from(document.querySelectorAll(SNAP_SELECTOR));
    const inView = [], offView = [];
    for (const el of all) {
      if (el.getAttribute && (el.getAttribute('role') === 'presentation' || el.getAttribute('aria-hidden') === 'true')) continue;
      let r;
      try { r = el.getBoundingClientRect(); } catch (e) { continue; }
      if (r.width < 1 || r.height < 1) continue;
      if (!el.getClientRects().length) continue;
      const visible = r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
      (visible ? inView : offView).push(el);
      if (inView.length > 120 && offView.length > 40) break;
    }
    const chosen = inView.slice(0, 120).concat(offView.slice(0, 40));
    chosen.sort((a, b) => a.compareDocumentPosition(b) & 2 ? 1 : -1); // 文档序(2=preceding)
    snapEls = [null, ...chosen]; // idx 从 1 起
    const elements = chosen.map((el, i) => {
      const r = el.getBoundingClientRect();
      const item = {
        idx: i + 1,
        role: roleOf(el),
        text: textOf(el),
        sel: selOf(el),
        rectVp: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
        disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true')
      };
      if (r.bottom < 0 || r.top > vh) item.offscreen = true;
      if (item.role === 'captcha-frame') item.captcha = true;
      return item;
    });
    const sc = findScroller();
    return {
      ok: true, rev: snapRev,
      page: { url: location.href, title: document.title || '' },
      viewport: { w: vw, h: vh },
      scroll: { y: Math.round(sc.el.scrollTop), max: Math.round(sc.el.scrollHeight) },
      elements,
      captcha: elements.some(e => e.captcha)
    };
  }

  // ── 动作执行 ──
  function resolveTarget(a) {
    let el = null;
    if (a.idx != null) el = snapEls[a.idx] || null;
    else if (a.sel) { try { el = document.querySelector(a.sel); } catch (e) { el = null; } }
    if (!el) { const err = new Error('target not found'); err.code = 'NO_TARGET'; throw err; }
    return el;
  }
  const DANGER_DEFAULTS = ['支付', '付款', '转账', '提现', '删除', '解绑', '退出登录', 'unsubscribe', 'delete', 'transfer'];
  function dangerHit(el, words) {
    if (el.tagName === 'INPUT' && el.type === 'password') return 'password field';
    const hay = (textOf(el) + ' ' + (el.className && el.className.toString ? el.className.toString() : '')).toLowerCase();
    for (const w of (words || DANGER_DEFAULTS)) { if (w && hay.includes(String(w).toLowerCase())) return String(w); }
    return null;
  }
  function firePointer(el, type, opts) {
    const Ctor = type.startsWith('pointer') ? (window.PointerEvent || MouseEvent) : MouseEvent;
    el.dispatchEvent(new Ctor(type, Object.assign({ bubbles: true, composed: true, cancelable: true }, opts)));
  }
  async function doClick(el, a) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await sleep(60);
    const r = el.getBoundingClientRect();
    const base = { clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2), button: 0 };
    firePointer(el, 'pointerover', base); firePointer(el, 'mouseover', base);
    firePointer(el, 'pointerdown', base); firePointer(el, 'mousedown', base);
    firePointer(el, 'pointerup', base); firePointer(el, 'mouseup', base);
    firePointer(el, 'click', base);
  }
  function doInput(el, a) {
    el.focus();
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype :
      (el.tagName === 'INPUT' ? HTMLInputElement.prototype : el.constructor.prototype);
    const d = Object.getOwnPropertyDescriptor(proto, 'value');
    if (d && d.set) d.set.call(el, String(a.text == null ? '' : a.text)); else el.value = String(a.text || '');
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function actRun(msg) {
    startRevTracking();
    if (msg.rev != null && msg.rev !== snapRev) return { ok: false, error: 'STALE_SNAPSHOT', rev: snapRev };
    const words = msg.dangerWords || DANGER_DEFAULTS;
    const results = [];
    const urlBefore = location.href;
    for (const a of (msg.actions || [])) {
      const entry = { action: String(a.do || '') };
      try {
        if (a.do === 'navigate') { results.push((entry.applied = true, entry)); location.assign(String(a.url)); await sleep(400); continue; }
        if (a.do === 'back') { results.push((entry.applied = true, entry)); history.back(); await sleep(400); continue; }
        const el = resolveTarget(a);
        entry.target = (textOf(el) || el.tagName.toLowerCase()).slice(0, 40);
        const danger = dangerHit(el, words);
        if (danger) { entry.danger = danger; }
        if (danger && msg.dangerMode === 'block' && !a.confirm) {
          entry.applied = false; entry.error = 'CONFIRM_REQUIRED';
          results.push(entry); continue;
        }
        switch (a.do) {
          case 'click': await doClick(el, a); break;
          case 'input': doInput(el, a); break;
          case 'select':
            el.focus(); el.value = String(a.value != null ? a.value : el.value);
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          case 'keys': {
            const t = document.activeElement || document.body;
            const key = String(a.keys || 'Enter');
            t.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, composed: true }));
            t.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, composed: true }));
            break;
          }
          case 'hover': {
            const r = el.getBoundingClientRect();
            firePointer(el, 'pointerover', { clientX: r.x + 2, clientY: r.y + 2 });
            firePointer(el, 'mouseover', { clientX: r.x + 2, clientY: r.y + 2 });
            firePointer(el, 'pointermove', { clientX: r.x + 2, clientY: r.y + 2 });
            firePointer(el, 'mousemove', { clientX: r.x + 2, clientY: r.y + 2 });
            break;
          }
          case 'scroll': {
            const sc = findScroller();
            if (a.idx != null) snapEls[a.idx] && snapEls[a.idx].scrollIntoView({ block: 'start' });
            else if (a.to === 'bottom') sc.el.scrollTop = sc.el.scrollHeight;
            else if (a.to === 'top') sc.el.scrollTop = 0;
            else sc.el.scrollTop = Math.max(0, a.y | 0);
            break;
          }
          case 'clickAt': {
            const el2 = document.elementFromPoint(a.x | 0, a.y | 0);
            if (!el2) { entry.applied = false; entry.error = 'NO_TARGET'; break; }
            await doClick(el2, a);
            break;
          }
          default: entry.applied = false; entry.error = 'unknown action: ' + a.do; break;
        }
        if (entry.applied !== false) entry.applied = true;
      } catch (e) {
        entry.applied = false;
        entry.error = (e && e.code) || String((e && e.message) || e);
      }
      results.push(entry);
      await sleep(60);
    }
    // 等本窗口渲染稳定(复用渲染稳定门控;虚拟列表/SPA 跳转后尤其必要)
    await renderStable(2500).catch(() => {});
    return { ok: true, results, url: location.href, urlChanged: location.href !== urlBefore, rev: snapRev };
  }

  /* --------------------------------------------------------- 消息入口 */

  async function handle(m) {
    switch (m.type) {
      case MSG.PING: return { ok: true, ver: CS.EXT_VER };
      case MSG.METRICS: return metrics();
      case MSG.SCROLL_START: return startScroll(m.cfg);
      case MSG.SCROLL_STOP: return stopScroll(m.reason);
      case MSG.SCROLL_TO: return scrollTo(m.y);
      case MSG.SCROLL_INTO_VIEW: return scrollIntoViewPick();
      case MSG.RENDER_STABLE: return renderStable(m.timeoutMs);
      case MSG.HIDE_FIXED: return hideFixed();
      case MSG.RESTORE_FIXED: return restoreFixed();
      case MSG.PICK_GET: return pickGet(m.maxAgeMs);
      case MSG.PICK_QUERY: return queryRect(m.selector);
      case MSG.SNAP: return querySnapshot();
      case MSG.ACT_RUN: return actRun(m);
      case MSG.CONTROL_ON: badgeOn(); return { ok: true };
      case MSG.CONTROL_OFF: badgeOff(); return { ok: true };
      case MSG.MARQUEE_BEGIN: return marqueeBegin();
      case MSG.MARQUEE_CLEAR: marqueeTeardown(); return { ok: true };
      default: return { ok: false, error: ERR.UNKNOWN };
    }
  }

  chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
    if (!m || !m.type || !m.type.startsWith('cs/')) return;
    Promise.resolve().then(() => handle(m)).then(sendResponse, (err) => {
      sendResponse({ ok: false, error: (err && err.clipshotCode) || ERR.UNKNOWN });
    });
    return true; // 异步响应
  });
})();
