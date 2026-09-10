'use strict';
(function () {
  const CS = globalThis.ClipShot;
  const $ = (id) => document.getElementById(id);
  let activeTabId = null;

  async function init() {
    const s = await CS.loadSettings();
    $('format').value = s.format;
    $('hideFixed').checked = !!s.hideFixed;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabId = tab && tab.id;

    const st = await chrome.runtime.sendMessage({ type: CS.MSG.STATE_GET });
    if (st && st.ok) {
      const busy = st.busyTabs.find(t => t.tabId === activeTabId);
      if (busy) showProgress(busy.phase, busy.pct, '该标签页正在截图中');
    }
  }

  $('format').addEventListener('change', () => CS.saveSettings({ format: $('format').value }));
  $('hideFixed').addEventListener('change', () => CS.saveSettings({ hideFixed: $('hideFixed').checked }));
  $('open-options').addEventListener('click', (e) => { e.preventDefault(); chrome.runtime.openOptionsPage(); });
  $('btn-cancel').addEventListener('click', () => {
    if (activeTabId != null) chrome.runtime.sendMessage({ type: CS.MSG.JOB_CANCEL, tabId: activeTabId });
  });

  for (const [id, mode] of [['btn-full', 'full'], ['btn-visible', 'visible'], ['btn-region', 'region']]) {
    $(id).addEventListener('click', async () => {
      if (activeTabId == null) return notice('未找到当前标签页');
      showProgress('check', 0, '任务已提交…');
      const r = await chrome.runtime.sendMessage({ type: CS.MSG.JOB_START, tabId: activeTabId, mode });
      if (!r || !r.ok) hideProgress(noticeText(CS.errText((r && r.error) || CS.ERR.UNKNOWN)));
    });
  }

  function notice(text) { $('notice').textContent = text; $('notice').classList.remove('hidden'); }
  function noticeText(t) { return t; }

  function showProgress(phase, pct, text) {
    $('progress').classList.remove('hidden');
    $('barfill').style.width = (pct || 0) + '%';
    $('progresstext').textContent = text || (CS.PHASE_TEXT[phase] || phase);
  }
  function hideProgress() { $('progress').classList.add('hidden'); }

  // 进度广播:popup 开着时实时跟随;失败信息落到 notice
  chrome.runtime.onMessage.addListener((m) => {
    if (!m || m.type !== CS.MSG.JOB_EVENT || m.tabId !== activeTabId) return;
    if (m.phase === 'failed') { hideProgress(); notice(m.text || CS.ERR_TEXT.UNKNOWN); return; }
    if (m.phase === 'done') { showProgress('done', 100, m.text || '完成'); setTimeout(hideProgress, 1200); return; }
    showProgress(m.phase, m.pct, m.text);
    $('notice').classList.add('hidden');
  });

  init();
})();
