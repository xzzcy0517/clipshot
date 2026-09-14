/**
 * SW 冷启动冒烟测试:用 chrome.* 桩按真实 importScripts 链求值整个 service worker。
 * 存在的意义:v0.6.0 曾因 bridge.js 顶层引用未定义的 sendToTab 导致
 * 「Service worker registration failed, status 15」——node --check 查不出这类
 * 求值期 ReferenceError,只有把顶层代码真跑一遍才行。
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const addL = { addListener: () => {} };
const asyncEmpty = async () => ({});
global.chrome = {
  runtime: { onMessage: addL, onInstalled: addL, onStartup: addL, onConnect: addL,
    sendMessage: async () => ({}), getURL: x => x },
  tabs: { query: async () => [], onRemoved: addL, onUpdated: addL, onCreated: addL,
    get: async () => null, update: async () => ({}), create: async () => ({}), sendMessage: async () => ({}) },
  alarms: { create: () => {}, clear: () => {}, onAlarm: addL },
  storage: { sync: { get: asyncEmpty, set: async () => {} }, session: { get: asyncEmpty, set: async () => {} }, onChanged: { addListener: () => {} } },
  contextMenus: { create: () => {}, removeAll: cb => cb && cb(), onClicked: addL },
  debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async () => ({}), onDetach: addL, onEvent: addL },
  scripting: { executeScript: async () => [], insertCSS: async () => {} },
  action: { setBadgeText: () => {}, setBadgeBackgroundColor: () => {} }
};

const loaded = [];
let bootError = null;
global.importScripts = (...files) => {
  for (const f of files) {
    const p = path.join(ROOT, f.replace(/^\//, ''));
    assert.ok(fs.existsSync(p), `importScripts 目标文件不存在: ${f}`);
    loaded.push(f);
    (0, eval)(fs.readFileSync(p, 'utf8')); // 求值错误直接向上抛(= 测试失败)
  }
};

// 同步求值错误:显式捕获并非零退出(uncaughtException 桩只兜异步漏网)
try {
  (0, eval)(fs.readFileSync(path.join(ROOT, 'background/sw.js'), 'utf8'));
} catch (e) {
  console.error('✘ SW 顶层求值失败:', (e && e.stack) || e);
  process.exit(1);
}
process.on('uncaughtException', (e) => { bootError = e; });
process.on('unhandledRejection', (e) => { bootError = bootError || e; });

assert.ok(loaded.length >= 9, `importScripts 链异常,仅加载 ${loaded.length} 个文件`);
const CS = globalThis.ClipShot;
for (const mod of ['pipeline', 'bridge', 'agent', 'imagestore', 'cdp', 'network', 'geom', 'MSG', 'broadcast']) {
  assert.ok(CS[mod], `CS.${mod} 未挂载(SW 顶层求值被中断?)`);
}
assert.equal(typeof CS.bridge.sendToTab, 'function', 'bridge.sendToTab 缺失');
assert.equal(typeof CS.bridge.resolveTarget, 'function', 'bridge.resolveTarget 缺失');

await new Promise(r => setTimeout(r, 80)); // 给微任务期异常冒出来的机会
if (bootError) throw bootError;
console.log('✔ sw-boot.test.mjs(SW 冷启动求值通过,' + loaded.length + ' 个模块)');
process.exit(0);
