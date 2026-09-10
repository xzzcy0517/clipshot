'use strict';
/** 下载文件名生成。依赖 messages.js 命名空间。 */
globalThis.ClipShot = globalThis.ClipShot || {};
(function (CS) {
  function pad(n) { return String(n).padStart(2, '0'); }

  /** mode: full|visible|region|element;mime: image/png|image/jpeg */
  CS.genName = function (mode, mime, date) {
    const d = date || new Date();
    const ext = mime === 'image/jpeg' ? 'jpg' : 'png';
    const stamp = d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '_' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
    return 'ClipShot_' + stamp + '_' + (mode || 'shot') + '.' + ext;
  };
})(globalThis.ClipShot);
