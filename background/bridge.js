'use strict';
/**
 * Agent 桥接(P001):SW 内的 WebSocket 客户端,连本地 relay(bridge/relay.mjs)。
 * 收到命令 → 复用 pipeline 静默作业 → 从 imagestore 分块回传 → relay 落盘。
 * 保活:relay 每 20s 发文本 {t:'ping'},SW 收到/回复即重置空闲计时器(官方文档);
 * 断线指数退避重连 + chrome.alarms 'bridge-heart'(30s)兜住 SW 休眠后的唤醒。
 */
globalThis.ClipShot = globalThis.ClipShot || {};
(function (CS) {
  const { ERR } = CS;
  const DEFAULT_PORT = 8790;

  let ws = null;
  let cfg = { enabled: false, port: DEFAULT_PORT, token: '' };
  let backoff = 1000;
  let reconnectTimer = null;
  let status = { connected: false, helloAck: false, since: null, lastError: null };

  const bridge = {};

  async function loadCfg() {
    const o = await chrome.storage.sync.get(['bridgeEnabled', 'bridgePort', 'bridgeToken']);
    cfg = {
      enabled: !!o.bridgeEnabled,
      port: (o.bridgePort | 0) > 0 ? (o.bridgePort | 0) : DEFAULT_PORT,
      token: String(o.bridgeToken || '')
    };
  }

  function send(obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* onclose 统一接管 */ }
  }

  function schedule() {
    if (reconnectTimer || !cfg.enabled || !cfg.token) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, 15000);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
  }

  function connect() {
    if (!cfg.enabled || !cfg.token || ws) return;
    let sock;
    try { sock = new WebSocket(`ws://127.0.0.1:${cfg.port}/bridge`); }
    catch (e) { status.lastError = '无法连接 relay:' + ((e && e.message) || e); schedule(); return; }
    ws = sock;
    sock.onopen = () => send({ t: 'hello', token: cfg.token, version: CS.EXT_VER });
    sock.onmessage = (ev) => {
      backoff = 1000;
      let m = null;
      try { m = JSON.parse(String(ev.data)); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      handle(m).catch((e) => console.warn('[ClipShot bridge]', e));
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      const wasConnected = status.helloAck;
      ws = null;
      status.connected = false; status.helloAck = false;
      if (wasConnected) status.lastError = '与 relay 的连接断开';
      schedule();
    };
    sock.onerror = () => { /* onclose 随后必到,统一处理 */ };
  }

  async function handle(m) {
    switch (m.t) {
      case 'hello-ack':
        status.connected = true;
        status.helloAck = !!m.ok;
        status.since = m.ok ? Date.now() : null;
        if (!m.ok) {
          status.lastError = m.reason === 'auth' ? 'token 不匹配(设置页粘贴 relay 启动时打印的令牌)' : 'relay 拒绝了握手';
          try { ws.close(); } catch (e) { /* noop */ } // 保留 close→schedule 的退避节奏,防 token 错误时刷屏
        } else {
          status.lastError = null;
        }
        break;
      case 'ping': send({ t: 'pong' }); break;
      case 'cmd': await runCmd(m); break;
    }
  }

  function replyOk(id, payload) { send(Object.assign({ t: 'reply', id, ok: true }, payload || {})); }
  function replyErr(id, code, message) {
    send({ t: 'reply', id, ok: false, error: code || ERR.UNKNOWN, message: message || CS.errText(code) });
  }

  /** target: number tabId | {urlContains} | 'active'(默认) */
  async function resolveTarget(target) {
    const badUrl = (u) => !/^(https?|file):/.test(u || '');
    if (typeof target === 'number' && target > 0) return target;
    if (target && typeof target === 'object' && target.urlContains) {
      const tabs = await chrome.tabs.query({});
      const hit = tabs.find(t => !badUrl(t.url) && (t.url || '').includes(String(target.urlContains)));
      return hit ? hit.id : null;
    }
    const [t1] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (t1 && !badUrl(t1.url)) return t1.id;
    const actives = await chrome.tabs.query({ active: true });
    const t2 = actives.find(t => !badUrl(t.url));
    return t2 ? t2.id : null;
  }

  async function runCmd(m) {
    const id = m.id;
    try {
      if (m.cmd === 'health') return replyOk(id, { version: CS.EXT_VER });
      if (m.cmd === 'tabs') {
        const tabs = await chrome.tabs.query({});
        return replyOk(id, {
          tabs: tabs.filter(t => /^(https?|file):/.test(t.url || ''))
            .map(t => ({ tabId: t.id, url: t.url, title: t.title || '', active: !!t.active }))
        });
      }
      if (m.cmd === 'screenshot') {
        const a = m.args || {};
        if (!['full', 'visible', 'element'].includes(a.mode)) {
          return replyErr(id, ERR.UNKNOWN, 'mode 必须是 full | visible | element');
        }
        const tabId = await resolveTarget(a.target);
        if (tabId == null) return replyErr(id, ERR.NO_TARGET, '未找到可截取的标签页(target 缺省为当前活动页)');
        if (a.mode === 'element' && !a.selector) return replyErr(id, ERR.NO_TARGET, 'mode=element 需要提供 selector');
        const opts = { silent: true };
        if (a.selector) opts.selector = String(a.selector);
        if (a.format === 'png' || a.format === 'jpeg') opts.format = a.format;
        if (typeof a.hideFixed === 'boolean') opts.hideFixed = a.hideFixed;

        const r = await CS.pipeline.startJob(tabId, a.mode, opts);
        if (!r.ok) return replyErr(id, r.error);
        let res;
        try {
          r.promise.catch(() => {}); // relay 侧超时后,防静默作业的 reject 变成 unhandled
          res = await r.promise;
        } catch (e) {
          return replyErr(id, (e && e.error) || ERR.UNKNOWN, (e && e.message) || undefined);
        }
        const meta = CS.imagestore.meta(res.jobId);
        if (!meta || !meta.ok) return replyErr(id, ERR.STALE_JOB);
        send({
          t: 'result', id, ok: true,
          image: { name: meta.name, mime: meta.mime, widthPx: meta.widthPx, heightPx: meta.heightPx },
          notes: (res.notes && res.notes.length ? res.notes : meta.notes) || []
        });
        for (let i = 0; i < meta.chunkCount; i++) {
          const c = CS.imagestore.chunk(res.jobId, i);
          if (!c || !c.ok) { send({ t: 'upload', id, seq: i, error: true }); break; }
          // seg 段号必带:relay 按段分组落盘(P003 多段损坏 bug 的源头修复)
          send({ t: 'upload', id, seq: i, seg: c.seg | 0, b64: c.b64, last: i === meta.chunkCount - 1 });
        }
        CS.imagestore.done(res.jobId);
        return;
      }
      return replyErr(id, ERR.UNKNOWN, '未知命令: ' + m.cmd);
    } catch (e) {
      replyErr(id, ERR.UNKNOWN, String((e && e.message) || e));
    }
  }

  function closeSock() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.onclose = null; ws.onmessage = null; ws.onopen = null; ws.close(); } catch (e) { /* noop */ } ws = null; }
    status.connected = false; status.helloAck = false; status.since = null;
  }

  function ensureHeartAlarm() {
    if (cfg.enabled) chrome.alarms.create('bridge-heart', { periodInMinutes: 0.5 });
    else chrome.alarms.clear('bridge-heart');
  }

  bridge.init = async function () {
    await loadCfg();
    if (cfg.enabled && cfg.token) connect();
    ensureHeartAlarm();
  };

  /** 设置变更/安装/启动:带新配置重建连接 */
  bridge.reload = async function () {
    closeSock();
    await loadCfg();
    status.lastError = cfg.enabled && !cfg.token ? '未填写 token' : null;
    if (cfg.enabled && cfg.token) connect();
    else if (cfg.enabled) schedule();
    ensureHeartAlarm();
  };

  /** 'bridge-heart' alarm:唤醒休眠的 SW 并重连(本身也重置空闲计时) */
  bridge.tick = function () {
    if (!cfg.enabled) { chrome.alarms.clear('bridge-heart'); return; }
    if (!ws) { loadCfg().then(() => connect()); }
  };

  bridge.status = function () {
    return {
      enabled: cfg.enabled, port: cfg.port,
      connected: status.connected && status.helloAck,
      since: status.since, lastError: status.lastError,
      extVer: CS.EXT_VER
    };
  };

  CS.bridge = bridge;
})(globalThis.ClipShot);
