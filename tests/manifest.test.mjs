import { readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const m = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));

assert.equal(m.manifest_version, 3, '必须为 MV3');
assert.ok(m.name && m.version, '需要 name/version');
assert.ok(m.description, '需要 description');
assert.equal(m.minimum_chrome_version, '126', '最低 Chrome 126');

const REQUIRED_PERMS = ['debugger', 'activeTab', 'scripting', 'contextMenus', 'storage', 'downloads', 'clipboardWrite', 'alarms'];
const ALLOWED_PERMS = new Set([...REQUIRED_PERMS, 'notifications', 'tabGroups']);
for (const p of REQUIRED_PERMS) assert.ok(m.permissions.includes(p), `缺少权限 ${p}`);
for (const p of m.permissions) assert.ok(ALLOWED_PERMS.has(p), `意外的权限 ${p}`);
assert.deepEqual(m.host_permissions, ['<all_urls>'], 'host_permissions 应为 <all_urls>');

assert.equal(m.background.service_worker, 'background/sw.js');
assert.ok(m.action.default_popup.endsWith('popup/popup.html'));
assert.ok(m.options_page.endsWith('options/options.html'));

// 引用的文件必须存在
const files = [
  m.background.service_worker, m.action.default_popup, m.options_page,
  ...m.content_scripts[0].js, ...m.content_scripts[0].css,
  ...Object.values(m.icons)
];
for (const f of files) assert.ok(existsSync(join(ROOT, f)), `文件不存在: ${f}`);

assert.equal(m.content_scripts[0].all_frames, false, '不注入 iframe(已知限制)');
assert.deepEqual(m.content_scripts[0].js.slice(0, 2), ['common/messages.js', 'common/geom.js'], '协议常量必须最先注入');

// P004:快捷键已全删——截图入口只有面板按钮与右键菜单
assert.equal(m.commands, undefined, 'v0.5.0 起不应再有 commands 声明');

// ── 版本一致性闸门(防腐烂的机械手段,见 CLAUDE.md 纪律#2)
// manifest version === CS.EXT_VER === 开发日志的 vX.Y.Z 条目
(0, eval)(readFileSync(join(ROOT, 'common/messages.js'), 'utf8'));
assert.equal(globalThis.ClipShot.EXT_VER, m.version,
  'CS.EXT_VER 与 manifest.json version 不一致:三处版本号必须同步 bump');
const log = readFileSync(join(ROOT, 'docs/路线图与开发日志.md'), 'utf8');
assert.ok(log.includes('v' + m.version),
  `开发日志中找不到 v${m.version} 条目:发布新版本必须先写日志条目(本测试会拦截)`);

console.log('✔ manifest.test.mjs');
