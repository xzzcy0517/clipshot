'use strict';
(function () {
  const CS = globalThis.ClipShot;
  const $ = (id) => document.getElementById(id);
  const FIELDS = ['format', 'jpegQuality', 'autoJpegForLong', 'autoJpegMinCssH',
    'hideFixed', 'scrollSpeed', 'splitThreshold', 'chunkHeight', 'maxScrollPx'];

  async function init() {
    $('ver').textContent = CS.EXT_VER;
    const s = await CS.loadSettings();
    for (const f of FIELDS) {
      const el = $(f);
      if (el.type === 'checkbox') el.checked = !!s[f];
      else el.value = s[f];
    }
    $('quality-val').textContent = s.jpegQuality;
  }

  function bind() {
    for (const f of FIELDS) {
      const el = $(f);
      const ev = (el.tagName === 'SELECT' || el.type === 'checkbox' || el.type === 'number') ? 'change' : 'input';
      el.addEventListener(ev, async () => {
        let v = el.type === 'checkbox' ? el.checked : el.value;
        if (el.type === 'number' || el.type === 'range') v = Number(v);
        if (el.type === 'range') $('quality-val').textContent = v;
        await CS.saveSettings({ [f]: v });
      });
    }
  }

  /* ---------------- Agent 桥接设置 ---------------- */
  const BKEYS = ['bridgeEnabled', 'bridgePort', 'bridgeToken'];

  async function initBridge() {
    const o = await chrome.storage.sync.get(BKEYS);
    $('bridgeEnabled').checked = !!o.bridgeEnabled;
    $('bridgePort').value = (o.bridgePort | 0) || 8790;
    $('bridgeToken').value = o.bridgeToken || '';
    $('bridgeEnabled').addEventListener('change', () =>
      CS.saveSettings({ bridgeEnabled: $('bridgeEnabled').checked }));
    $('bridgePort').addEventListener('change', () =>
      CS.saveSettings({ bridgePort: Number($('bridgePort').value) || 8790 }));
    $('bridgeToken').addEventListener('change', () =>
      CS.saveSettings({ bridgeToken: $('bridgeToken').value.trim() }));
    $('bridge-refresh').addEventListener('click', refreshBridge);
    refreshBridge();
    setInterval(refreshBridge, 2500);
  }

  async function refreshBridge() {
    const el = $('bridge-status');
    try {
      const r = await chrome.runtime.sendMessage({ type: CS.MSG.BRIDGE_STATE });
      if (!r || !r.ok) { el.textContent = '查询失败(扩展后台是否在运行?)'; return; }
      if (!r.enabled) { el.textContent = '未启用'; return; }
      if (r.connected) {
        const since = r.since ? new Date(r.since).toLocaleTimeString() : '';
        el.textContent = '● 已连接 relay(端口 ' + r.port + (since ? ',' + since + ' 起' : '') + ')';
      } else {
        el.textContent = '○ 未连接' + (r.lastError ? ':' + r.lastError : ' —— 先启动 relay 再检查 token');
      }
    } catch (e) {
      el.textContent = '查询失败:' + ((e && e.message) || e);
    }
  }

  init();
  bind();
  initBridge();
})();
