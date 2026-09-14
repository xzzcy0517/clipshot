'use strict';
/**
 * P005「浏览器之手」SW 侧编排:接管会话 / 快照 / 动作 / 事件流。
 * 单大脑架构(用户拍板):本模块不含任何模型调用——只负责
 * 「执行 + 观察 + 回报」,决策全在宿主 Agent(Cursor 等)。
 * 安全(用户拍板:更松):危险动作默认只「标记」不拦截(dangerMode=mark,可切 block);
 * 域名黑名单默认空;ttl 300s;60 步/会话;徽标+Esc 夺回是硬底线,不可关。
 */
globalThis.ClipShot = globalThis.ClipShot || {};
(function (CS) {
  const { MSG, ERR } = CS;
  const now = () => Date.now();

  let session = null; // {id,tabId,windowId,expiresAt,steps,lastActAt,follow}
  const consoleBuf = []; // {tabId,msg,at}
  const tabEvents = [];  // {type,...,at}
  const CAP = 200;

  const agent = {};

  function pushEv(arr, item) { arr.push(item); if (arr.length > CAP) arr.shift(); }
  async function notify(tabId, msg) { try { await chrome.tabs.sendMessage(tabId, msg); } catch (e) { /* 页面未注入,忽略 */ } }

  async function cfg() {
    const o = await chrome.storage.sync.get(
      ['agentTtlSec', 'agentStepsCap', 'agentDangerMode', 'agentDomainBlock', 'agentFollowNewTabs', 'agentDangerWords']);
    const num = (v, lo, hi, d) => (typeof v === 'number' && v >= lo && v <= hi) ? v : d;
    return {
      ttlSec: num(o.agentTtlSec, 30, 1800, 300),
      stepsCap: num(o.agentStepsCap, 5, 500, 60),
      dangerMode: o.agentDangerMode === 'block' ? 'block' : 'mark',
      domainBlock: String(o.agentDomainBlock || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
      followNewTabs: o.agentFollowNewTabs !== false,
      dangerWords: Array.isArray(o.agentDangerWords) && o.agentDangerWords.length ? o.agentDangerWords : undefined
    };
  }

  /* ---------------- console 探针(MAIN world 注入,接管期才挂) ---------------- */
  function consoleProbeFn(eventName) {
    if (window.__clipshotConsoleHooked) return;
    window.__clipshotConsoleHooked = true;
    const entries = [];
    const safe = (a) => { try { return typeof a === 'object' ? JSON.stringify(a).slice(0, 300) : String(a); } catch (e) { return String(a); } };
    ['error', 'warn'].forEach((lvl) => {
      const orig = console[lvl];
      console[lvl] = function (...args) {
        try { entries.push({ msg: ('[' + lvl + '] ' + args.map(safe).join(' ')).slice(0, 400), at: Date.now() }); } catch (e) { /* noop */ }
        return orig ? orig.apply(this, args) : undefined;
      };
    });
    window.addEventListener('error', (e) => entries.push({ msg: ('[onerror] ' + (e.message || e.error || '')).slice(0, 400), at: Date.now() }), true);
    window.addEventListener('unhandledrejection', (e) => entries.push({ msg: ('[reject] ' + (e && e.reason)).slice(0, 400), at: Date.now() }), true);
    setInterval(() => {
      if (!entries.length) return;
      const batch = entries.splice(0, entries.length);
      try { document.dispatchEvent(new CustomEvent(eventName, { detail: { entries: batch } })); } catch (e) { /* noop */ }
    }, 500);
  }
  async function ensureConsoleHook(tabId) {
    try {
      await chrome.scripting.executeScript({ target: { tabId, allFrames: false }, world: 'MAIN', func: consoleProbeFn, args: [MSG.CONSOLE_IN] });
    } catch (e) { /* 特权页/受限页面忽略 */ }
  }

  /* ---------------- 接管开关 ---------------- */
  function release(reason) {
    if (!session) return { ok: true, wasActive: false };
    const old = session;
    session = null;
    notify(old.tabId, { type: MSG.CONTROL_OFF, reason }).catch(() => {});
    pushEv(tabEvents, { type: 'control-off', tabId: old.tabId, reason, at: now() });
    return { ok: true, wasActive: true };
  }

  agent.control = async function (args) {
    const c = await cfg();
    if (args && args.on === false) {
      const r = release('closed-by-agent');
      chrome.alarms.clear('agent-ttl');
      return r;
    }
    const tabId = await CS.bridge.resolveTarget(args && args.target);
    if (tabId == null) return { ok: false, error: ERR.NO_TARGET, message: '未找到接管目标页' };
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) return { ok: false, error: ERR.NO_TARGET };
    const host = String(tab.url || '').replace(/^https?:\/\//, '').split('/')[0];
    const hit = c.domainBlock.find(d => host === d || host.endsWith('.' + d));
    if (hit) return { ok: false, error: 'DOMAIN_BLOCKED', message: '该域名在接管黑名单里(' + hit + '),可在设置页调整' };
    if (session) release('replaced');
    session = {
      id: crypto.randomUUID(), tabId, windowId: tab.windowId,
      expiresAt: now() + Math.min((args && args.ttlSec) || c.ttlSec, 1800) * 1000,
      steps: 0, lastActAt: 0,
      follow: args && args.followNewTabs !== undefined ? !!args.followNewTabs : c.followNewTabs
    };
    await ensureConsoleHook(tabId);
    await notify(tabId, { type: MSG.CONTROL_ON });
    chrome.alarms.create('agent-ttl', { periodInMinutes: 0.5 });
    pushEv(tabEvents, { type: 'control-on', tabId, url: tab.url, at: now() });
    return { ok: true, sessionId: session.id, tabId, expiresAt: session.expiresAt };
  };

  agent.release = function (reason) { chrome.alarms.clear('agent-ttl'); return release(reason || 'released'); };

  function check() {
    if (!session) return { ok: false, error: 'NOT_CONTROLLING', message: '未在接管状态:先 POST /v1/control {"on":true}' };
    if (now() > session.expiresAt) { release('ttl-expired'); return { ok: false, error: 'SESSION_EXPIRED', message: '接管超时已自动交还;需要更久请调大 ttl' }; }
    return null;
  }

  /* ---------------- 快照 ---------------- */
  agent.snapshot = async function () {
    const bad = check(); if (bad) return bad;
    try {
      const snap = await CS.bridge.sendToTab(session.tabId, { type: MSG.SNAP }, 8000);
      return Object.assign({ ok: true, tabId: session.tabId }, snap);
    } catch (e) {
      return { ok: false, error: (e && e.clipshotCode) || ERR.CONTENT_DEAD, message: '读不到目标页(刷新后重试,或它不是普通网页)' };
    }
  };

  /* ---------------- 动作 + 等待 + 观察 ---------------- */
  agent.act = async function (args) {
    const bad = check(); if (bad) return bad;
    const c = await cfg();
    if (session.steps >= c.stepsCap) {
      return { ok: false, error: 'STEPS_LIMIT', message: '本会话已执行 ' + session.steps + ' 步(上限 ' + c.stepsCap + '),防打转;确认继续请重新 control' };
    }
    const since = now() - session.lastActAt;
    if (since < 400) await CS.util.sleep(400 - since);
    session.steps++; session.lastActAt = now();
    session.expiresAt = now() + c.ttlSec * 1000;

    const conMark = consoleBuf.length, evMark = tabEvents.length;
    const wait = (args && args.wait) || {};
    let run;
    try {
      run = await CS.bridge.sendToTab(session.tabId, {
        type: MSG.ACT_RUN,
        actions: ((args && args.actions) || []).slice(0, 20),
        rev: args && args.rev, dangerMode: c.dangerMode, dangerWords: c.dangerWords, quietMs: wait.quietMs
      }, 25000);
    } catch (e) {
      return { ok: false, error: (e && e.clipshotCode) || ERR.CONTENT_DEAD, message: '动作执行失败(页面可能已跳转,请重新 snapshot)' };
    }
    if (!run || run.ok === false) {
      if (run && run.error === 'STALE_SNAPSHOT') {
        return { ok: false, error: 'STALE_SNAPSHOT', message: '页面结构已变化,请重新 snapshot 后按新编号执行', rev: run.rev };
      }
      return Object.assign({ ok: false, message: '动作执行出错' }, run || {});
    }
    const wants = Array.isArray(wait.until) ? wait.until : [];
    const budget = Math.min((wait.timeoutMs | 0) || 4000, 12000);
    // 跨 origin 跳转/新开标签:内容端感知不到的,用标签页事件与 URL 轮询补齐
    const t0 = now();
    for (;;) {
      const t = await chrome.tabs.get(session ? session.tabId : -1).catch(() => null);
      if (t && t.url && t.url !== run.url) { run.urlChanged = true; run.url = t.url; }
      const doneNav = !wants.includes('urlChange') || run.urlChanged;
      const doneTab = !wants.includes('newTab') || tabEvents.length > evMark;
      const doneErr = !wants.includes('consoleError') || consoleBuf.length > conMark;
      if ((doneNav && doneTab && doneErr) || now() - t0 > budget) break;
      await CS.util.sleep(250);
    }
    const changed = ['renderQuiet'];
    if (run.urlChanged) changed.push('urlChange');
    if (consoleBuf.length > conMark) changed.push('consoleError');
    const evNew = tabEvents.slice(evMark);
    if (evNew.some(e => e.type === 'tab-created')) changed.push('newTab');
    const after = {
      url: run.url || null,
      tabEvents: evNew,
      consoleErrors: consoleBuf.slice(conMark).filter(e => e.tabId === (session && session.tabId)),
      changed
    };
    let captureJobId = null;
    if (args && args.capture) {
      const mode = args.capture === 'full' ? 'full' : 'visible';
      const r = await CS.pipeline.startJob(session ? session.tabId : null, mode, { silent: true });
      if (r.ok) { captureJobId = r.jobId; after.capture = { pending: true }; }
      else after.capture = { error: r.error };
    }
    return { ok: true, results: run.results || [], rev: run.rev, after, _captureJob: captureJobId };
  };

  /* ---------------- 事件流 ---------------- */
  agent.events = async function (args) {
    const since = (args && args.sinceMs) || 0;
    return {
      ok: true,
      controlling: !!session,
      tabEvents: tabEvents.filter(e => e.at > since),
      consoleErrors: consoleBuf.filter(e => e.at > since)
    };
  };

  agent.status = function () {
    return session && now() <= session.expiresAt
      ? { active: true, tabId: session.tabId, steps: session.steps, expiresAt: session.expiresAt }
      : { active: false };
  };

  /* ---------------- 标签页事件 / TTL / 跟进 ---------------- */
  agent.onAlarm = function (name) {
    if (name !== 'agent-ttl') return;
    if (!session) { chrome.alarms.clear('agent-ttl'); return; }
    if (now() > session.expiresAt) release('ttl-expired');
  };
  agent.pushConsole = function (entries, tabId) {
    for (const e of (entries || [])) pushEv(consoleBuf, Object.assign({ tabId }, e));
  };
  agent.onTabClosed = function (tabId) {
    if (session && tabId === session.tabId) release('session-tab-closed');
  };
  agent.attach = function () {
    chrome.tabs.onCreated.addListener((tab) => {
      if (!session) return;
      pushEv(tabEvents, { type: 'tab-created', tabId: tab.id, openerTabId: tab.openerTabId || null, url: tab.url || '', at: now() });
      if (session.follow && tab.id && tab.openerTabId === session.tabId) followTab(tab.id, tab.url);
    });
    chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
      if (!session) return;
      if (change.status === 'complete' && tabId === session.tabId) ensureConsoleHook(tabId); // SPA/整页加载后重挂探针
    });
  };
  async function followTab(newTabId, url) {
    const old = session.tabId;
    session.tabId = newTabId;
    const t = await chrome.tabs.get(newTabId).catch(() => null);
    if (t) session.windowId = t.windowId;
    notify(old, { type: MSG.CONTROL_OFF, reason: 'followed-new-tab' });
    pushEv(tabEvents, { type: 'session-followed', fromTab: old, toTab: newTabId, url: url || '', at: now() });
    await CS.util.sleep(800);
    await ensureConsoleHook(newTabId);
    await notify(newTabId, { type: MSG.CONTROL_ON });
  }

  CS.agent = agent;
})(globalThis.ClipShot);
