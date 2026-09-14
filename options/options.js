'use strict';
(function () {
  const CS = globalThis.ClipShot;
  const $ = (id) => document.getElementById(id);
  const FIELDS = ['format', 'jpegQuality', 'autoJpegForLong', 'autoJpegMinCssH',
    'hideFixed', 'scrollSpeed', 'splitThreshold', 'chunkHeight', 'maxScrollPx',
    'maxTotalCssH', 'maxPartDeviceH',
    'agentTtlSec', 'agentStepsCap', 'agentDangerMode', 'agentFollowNewTabs', 'agentDomainBlock'];

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

  /* ---------------- Agent 桥接设置(v0.5.0 零配置:只剩启用开关 + 状态) ---------------- */
  const BKEYS = ['bridgeEnabled'];

  async function initBridge() {
    const o = await chrome.storage.sync.get(BKEYS);
    $('bridgeEnabled').checked = !!o.bridgeEnabled;
    $('bridgeEnabled').addEventListener('change', () =>
      CS.saveSettings({ bridgeEnabled: $('bridgeEnabled').checked }));
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
        el.textContent = '● 已连接 relay(端口 ' + (r.port || '?') + (since ? ',' + since + ' 起' : '') + ')';
      } else {
        el.textContent = '○ 未连接 —— 请确认 Cursor 已启动(桥由它自动拉起),或按新机器部署指南跑 setup.sh';
      }
    } catch (e) {
      el.textContent = '查询失败:' + ((e && e.message) || e);
    }
  }

  init();
  bind();
  initBridge();
})();
