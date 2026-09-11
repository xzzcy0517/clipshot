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

  init();
  bind();
})();
