'use strict';
/**
 * Agent 桥接(P001-P1;P004/v0.5.0 起零配置):SW 内的 WebSocket 客户端,连本机 relay。
 * - 无 token、无端口设置:在 8790–8795 轮询探测(relay 侧同样自动挑空闲端口);
 *   设置页只剩一个「启用」勾选框。
 * - 保活:relay 每 20s 文本 {t:'ping'},SW 收/发即重置空闲计时(官方语义);
 *   断线指数退避重连(每次换下一个端口)+ 'bridge-heart' alarm 30s 唤醒。
 * - 收到命令 → pipeline 静默作业 → 从 imagestore 分块回传 → relay 落盘。
 */
globalThis.ClipShot = globalThis.ClipShot || {};
(function (CS) {
  const { ERR } = CS;
  const PORT_START = 8790;
  const PORT_SCAN = 6;

  let ws = null;
  let cfg = { enabled: false };
  let scanIdx = 0;
  let connectedPort = 0;
  let backoff = 1000;
  let reconnectTimer = null;
  let status = { connected: false, helloAck: false, since: null, lastError: null };

  const bridge = {};

  async function loadCfg() {
    const o = await chrome.storage.sync.get(['bridgeEnabled']);
    cfg = { enabled: !!o.bridgeEnabled }; // 旧版本残留的 bridgeToken/bridgePort 键不再读取
  }

  function send(obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* onclose 统一接管 */ }
  }

  function schedule() {
    if (reconnectTimer || !cfg.enabled) return;
    const wait = backoff;
    backoff = Math.min(backoff * 2, 15000);
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, wait);
  }

  function connect() {
    if (!cfg.enabled || ws) return;
    const port = PORT_START + (scanIdx % PORT_SCAN);
    scanIdx++; // 每次尝试换一个端口,一轮扫完自动回到起点
    let sock;
    try { sock = new WebSocket(`ws://127.0.0.1:${port}/bridge`); }
    catch (e) { status.lastError = '无法连接 relay(端口 ' + port + ')'; schedule(); return; }
    ws = sock;
    sock.onopen = () => send({ t: 'hello', version: CS.EXT_VER });
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
      status.connected = false; status.helloAck = false; connectedPort = 0;
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
        if (m.ok) {
          status.since = Date.now();
          status.lastError = null;
          connectedPort = PORT_START + ((scanIdx - 1 + PORT_SCAN * 4) % PORT_SCAN); // 本次握手用的端口
        } else {
          status.lastError = 'relay 拒绝了握手(版本过旧?重启桥后重试)';
          try { ws.close(); } catch (e) { /* noop */ }
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
        await uploadChunks(id, res.jobId);
        return;
      }
      // P005 「手」命令组:全部要求先 control(on) —— agent.js 内部校验
      if (['control', 'snapshot', 'act', 'events'].includes(m.cmd)) {
        const r = await CS.agent[m.cmd]((m.args || {}));
        if (m.cmd === 'act' && r && r._captureJob) {
          const jobId = r._captureJob;
          delete r._captureJob;
          if (r.after && r.after.capture && r.after.capture.pending) delete r.after.capture.pending;
          await uploadChunks(id, jobId); // result + upload 帧先行,reply 殿后(relay 把落盘 paths 并入 after.capture)
        }
        send(Object.assign({ t: 'reply', id, ok: !!(r && r.ok) }, r && r.ok ? { data: r } : { error: r && r.error, message: r && r.message }));
        return;
      }
      return replyErr(id, ERR.UNKNOWN, '未知命令: ' + m.cmd);
    } catch (e) {
      replyErr(id, ERR.UNKNOWN, String((e && e.message) || e));
    }
  }

  /** imagestore → relay 分块回传。seg 段号必带(P003:relay 按段分组落盘)。 */
  async function uploadChunks(id, jobId) {
    const meta = CS.imagestore.meta(jobId);
    if (!meta || !meta.ok) { send({ t: 'reply', id, ok: false, error: ERR.STALE_JOB }); return; }
    send({
      t: 'result', id, ok: true,
      image: { name: meta.name, mime: meta.mime, widthPx: meta.widthPx, heightPx: meta.heightPx },
      notes: meta.notes || []
    });
    for (let i = 0; i < meta.chunkCount; i++) {
      const c = CS.imagestore.chunk(jobId, i);
      if (!c || !c.ok) { send({ t: 'upload', id, seq: i, error: true }); break; }
      send({ t: 'upload', id, seq: i, seg: c.seg | 0, b64: c.b64, last: i === meta.chunkCount - 1 });
    }
    CS.imagestore.done(jobId);
  }

  function closeSock() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (ws) { try { ws.onclose = null; ws.onmessage = null; ws.onopen = null; ws.close(); } catch (e) { /* noop */ } ws = null; }
    status.connected = false; status.helloAck = false; status.since = null; connectedPort = 0;
  }

  function ensureHeartAlarm() {
    if (cfg.enabled) chrome.alarms.create('bridge-heart', { periodInMinutes: 0.5 });
    else chrome.alarms.clear('bridge-heart');
  }

  bridge.init = async function () {
    await loadCfg();
    if (cfg.enabled) connect();
    ensureHeartAlarm();
  };

  /** 设置变更/安装/启动:按新配置重建连接 */
  bridge.reload = async function () {
    closeSock();
    await loadCfg();
    status.lastError = null;
    if (cfg.enabled) connect(); // 未启用则静默,等设置变更再 reload
    ensureHeartAlarm();
  };

  /** 'bridge-heart' alarm:唤醒休眠的 SW 并重连(本身也重置空闲计时) */
  bridge.tick = function () {
    if (!cfg.enabled) { chrome.alarms.clear('bridge-heart'); return; }
    if (!ws) { loadCfg().then(() => connect()); }
  };

  bridge.status = function () {
    return {
      enabled: cfg.enabled,
      connected: status.connected && status.helloAck,
      port: connectedPort || null,
      since: status.since, lastError: status.lastError,
      extVer: CS.EXT_VER
    };
  };
  // P005:agent.js 复用目标解析与带超时消息通道
  bridge.resolveTarget = resolveTarget;
  bridge.sendToTab = sendToTab;

  CS.bridge = bridge;
})(globalThis.ClipShot);
