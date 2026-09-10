'use strict';
/** CDP Network 域 in-flight 计数,作为自动滚动每一步的「网络稳定」门控。 */
globalThis.ClipShot = globalThis.ClipShot || {};
(function (CS) {
  /** tabId → { enabled:boolean, inflight:Set<requestId> } */
  const states = new Map();

  function st(tabId) {
    let s = states.get(tabId);
    if (!s) { s = { enabled: false, inflight: new Set() }; states.set(tabId, s); }
    return s;
  }

  CS.network = {
    /** sw 把 debugger.onEvent 的 Network.* 路由到这里 */
    handleEvent(tabId, method, params) {
      if (tabId == null) return;
      const s = states.get(tabId);
      if (!s || !s.enabled) return;
      const id = params && params.requestId;
      if (!id) return;
      if (method === 'Network.requestWillBeSent') s.inflight.add(id);
      else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') s.inflight.delete(id);
    },

    async enable(tabId) {
      const s = st(tabId);
      await CS.cdp.call(tabId, 'Network.enable', {}, 5000);
      s.enabled = true;
      s.inflight.clear();
    },

    async disable(tabId) {
      const s = states.get(tabId);
      if (s) { s.enabled = false; s.inflight.clear(); }
      try { await CS.cdp.call(tabId, 'Network.disable', {}, 3000); } catch (e) { /* 忽略 */ }
    },

    reset(tabId) { states.delete(tabId); },

    /** 等待 in-flight 归零并保持 quietMs;最长 maxMs 强制放行(防长轮询页永不放行)。 */
    async waitForIdle(tabId, quietMs, maxMs) {
      const s = states.get(tabId);
      if (!s || !s.enabled) return;
      quietMs = quietMs || 300;
      maxMs = maxMs || 2000;
      const t0 = Date.now();
      let idleSince = null;
      for (;;) {
        if (s.inflight.size === 0) {
          if (idleSince == null) idleSince = Date.now();
          else if (Date.now() - idleSince >= quietMs) return;
        } else {
          idleSince = null;
        }
        if (Date.now() - t0 >= maxMs) return;
        await CS.util.sleep(100);
      }
    }
  };
})(globalThis.ClipShot);
