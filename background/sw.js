'use strict';
/**
 * ClipShot service worker 入口:importScripts 共享 common/,注册监听,消息路由。
 * classic SW(非 module)是零构建下共享协议常量的前提。
 */
importScripts(
  '/common/messages.js',
  '/common/settings.js',
  '/common/geom.js',
  '/common/naming.js',
  '/background/cdp.js',
  '/background/networkidle.js',
  '/background/imagestore.js',
  '/background/pipeline.js'
);

const CS = globalThis.ClipShot;
const { MSG } = CS;

/** 向 popup 等扩展页广播;无接收方时静默。 */
CS.broadcast = function (msg) {
  try { chrome.runtime.sendMessage(msg).catch(() => {}); } catch (e) { /* noop */ }
};

/* ---------------- debugger 会话防泄漏:每次唤醒先清扫残留 ---------------- */
CS.cdp.sweepAttached();
chrome.runtime.onStartup.addListener(() => CS.cdp.sweepAttached());

/* ---------------- 安装/更新:重建右键菜单 ---------------- */
chrome.runtime.onInstalled.addListener(() => {
  CS.cdp.sweepAttached();
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'clipshot-element',
      title: 'ClipShot:截取此元素',
      contexts: ['all']
    });
  });
});

/* ---------------- 命令快捷键 ---------------- */
const COMMAND_MODES = {
  'capture-full': 'full',
  'capture-visible': 'visible',
  'capture-region': 'region'
};
chrome.commands.onCommand.addListener(async (command) => {
  const mode = COMMAND_MODES[command];
  if (!mode) return;
  const tab = await getActiveTab();
  if (!tab) return;
  const r = await CS.pipeline.startJob(tab.id, mode, {});
  if (!r.ok) CS.broadcast({ type: MSG.JOB_EVENT, jobId: null, tabId: tab.id, mode, phase: 'failed', pct: 100, text: CS.errText(r.error) });
});

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/* ---------------- 右键菜单:截取元素 ---------------- */
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'clipshot-element' || !tab || tab.id == null) return;
  const r = await CS.pipeline.startJob(tab.id, 'element', {});
  if (!r.ok) CS.broadcast({ type: MSG.JOB_EVENT, jobId: null, tabId: tab.id, mode: 'element', phase: 'failed', pct: 100, text: CS.errText(r.error) });
});

/* ---------------- runtime 消息路由 ---------------- */
chrome.runtime.onMessage.addListener((m, sender, sendResponse) => {
  (async () => {
    try {
      switch (m && m.type) {
        case MSG.STATE_GET:
          sendResponse({ ok: true, busyTabs: CS.pipeline.state() });
          return;
        case MSG.JOB_START: {
          const tabId = m.tabId != null ? m.tabId : (await getActiveTab() || {}).id;
          if (tabId == null) { sendResponse({ ok: false, error: CS.ERR.NO_TARGET }); return; }
          sendResponse(await CS.pipeline.startJob(tabId, m.mode, m.opts || {}));
          return;
        }
        case MSG.JOB_CANCEL:
          sendResponse(CS.pipeline.cancel(m.tabId));
          return;
        case MSG.IMG_META:
          sendResponse(CS.imagestore.meta(m.jobId));
          return;
        case MSG.IMG_CHUNK:
          sendResponse(CS.imagestore.chunk(m.jobId, m.index));
          return;
        case MSG.IMG_DONE:
          sendResponse(CS.imagestore.done(m.jobId));
          return;
        case MSG.MARQUEE_RESULT:
        case MSG.MARQUEE_CANCEL: {
          const tabId = sender.tab && sender.tab.id;
          if (tabId != null) CS.pipeline.onMarqueeMessage(m, tabId);
          sendResponse({ ok: true });
          return;
        }
        case MSG.DIAG_METRICS: {
          const tabId = m.tabId != null ? m.tabId : (await getActiveTab() || {}).id;
          sendResponse(tabId != null ? await CS.pipeline.diag(tabId) : { ok: false, error: CS.ERR.NO_TARGET });
          return;
        }
        default:
          sendResponse({ ok: false, error: CS.ERR.UNKNOWN });
      }
    } catch (e) {
      sendResponse({ ok: false, error: (e && e.clipshotCode) || CS.ERR.UNKNOWN });
    }
  })();
  return true; // 异步响应
});

/* ---------------- debugger 事件:Network 门控 + detach 处理 ---------------- */
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method.startsWith('Network.')) CS.network.handleEvent(source.tabId, method, params);
});
chrome.debugger.onDetach.addListener((source, reason) => {
  CS.pipeline.onDebuggerDetach(source.tabId, reason);
});

/* ---------------- 滚动 port ---------------- */
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === CS.SCROLL_PORT) CS.pipeline.handleScrollConnect(port);
});

/* ---------------- 标签页关闭 / alarm ---------------- */
chrome.tabs.onRemoved.addListener((tabId) => CS.pipeline.onTabClosed(tabId));
chrome.alarms.onAlarm.addListener((a) => CS.pipeline.onAlarm(a.name));
