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

  /* ---------------- 诊断:导出当前标签页 layoutMetrics ---------------- */
  let diagText = '';
  /** options 页本身获得焦点时 active+lastFocusedWindow 会选错;
      取所有窗口中活动标签里第一个普通网页(http/https/file)。 */
  async function pickDiagTab() {
    const actives = await chrome.tabs.query({ active: true });
    return actives.find(t => /^(https?|file):/.test(t.url || '')) || null;
  }

  $('btn-diag').addEventListener('click', async () => {
    $('diag-out').value = '正在读取…(页面顶部会短暂出现调试提示条)';
    $('btn-copy-diag').disabled = true;
    const tab = await pickDiagTab();
    const r = await chrome.runtime.sendMessage({ type: CS.MSG.DIAG_METRICS, tabId: tab && tab.id });
    if (!r || !r.ok) {
      diagText = '';
      $('diag-out').value = '诊断失败:' + CS.errText((r && r.error) || CS.ERR.UNKNOWN) +
        '\n(本地文件页面需先在扩展详情页开启「允许访问文件网址」)';
      return;
    }
    diagText = JSON.stringify({ ua: navigator.userAgent, dpr: r.dpr, raw: r.raw, normalized: r.metrics }, null, 2);
    $('diag-out').value = diagText;
    $('btn-copy-diag').disabled = false;
  });
  $('btn-copy-diag').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(diagText); $('btn-copy-diag').textContent = '已复制 ✓'; }
    catch (e) { $('diag-out').select(); }
    setTimeout(() => { $('btn-copy-diag').textContent = '复制 JSON'; }, 1500);
  });

  init();
  bind();
})();
