'use strict';
/** chrome.debugger 封装:attach/detach/call + 防泄漏(storage.session 记录 + 复活清扫)。 */
globalThis.ClipShot = globalThis.ClipShot || {};
(function (CS) {
  const CDP_VER = '1.3';
  const cdp = {};

  cdp.mkErr = function (code) {
    const e = new Error(code);
    e.clipshotCode = code;
    return e;
  };
  cdp.codeOf = function (e) { return (e && e.clipshotCode) || CS.ERR.UNKNOWN; };

  cdp.withTimeout = function (promise, ms, errCode) {
    return Promise.race([
      promise,
      new Promise((_, rej) => setTimeout(() => rej(cdp.mkErr(errCode || CS.ERR.CAPTURE_TIMEOUT)), ms))
    ]);
  };

  async function readAttached() {
    const o = await chrome.storage.session.get('attachedTabs');
    return Array.isArray(o.attachedTabs) ? o.attachedTabs : [];
  }
  async function addAttached(tabId, who) {
    const list = (await readAttached()).filter(t => t.tabId !== tabId);
    list.push({ tabId, who, at: Date.now() });
    await chrome.storage.session.set({ attachedTabs: list });
  }
  async function removeAttached(tabId) {
    const list = (await readAttached()).filter(t => t.tabId !== tabId);
    await chrome.storage.session.set({ attachedTabs: list });
  }

  cdp.attach = async function (tabId, who) {
    try {
      await cdp.withTimeout(chrome.debugger.attach({ tabId }, CDP_VER), 5000, CS.ERR.ATTACH_FAIL);
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/already attached/i.test(msg)) throw cdp.mkErr(CS.ERR.DEVTOOLS_CONFLICT);
      if (/cannot access|cannot be scripted|cannot attach/i.test(msg)) throw cdp.mkErr(CS.ERR.PAGE_NOT_ALLOWED);
      throw cdp.mkErr(CS.ERR.ATTACH_FAIL);
    }
    // 会话记录是 debugger 保活之外防泄漏的关键(见 docs/架构说明.md)
    await addAttached(tabId, who);
  };

  /** 幂等 detach:无论当前是否 attached 都不会抛。 */
  cdp.detach = async function (tabId) {
    try { await chrome.debugger.detach({ tabId }); } catch (e) { /* 会话已不存在,视为干净 */ }
    try { await removeAttached(tabId); } catch (e) { /* storage 不可用时忽略 */ }
  };

  cdp.call = function (tabId, method, params, ms) {
    return cdp.withTimeout(
      chrome.debugger.sendCommand({ tabId }, method, params || {}),
      ms || 10000,
      CS.ERR.CAPTURE_TIMEOUT
    );
  };

  /** SW 每次唤醒/启动/安装时执行:对残留记录盲发 detach,防调试横幅常驻。 */
  cdp.sweepAttached = async function () {
    let list = [];
    try { list = await readAttached(); } catch (e) { return; }
    for (const t of list) {
      try { await chrome.debugger.detach({ tabId: t.tabId }); } catch (e) { /* 干净 */ }
    }
    try { await chrome.storage.session.set({ attachedTabs: [] }); } catch (e) { /* 忽略 */ }
  };

  CS.cdp = cdp;
})(globalThis.ClipShot);
