/**
 * 深色模式层叠顺序闸门(防白底白字复发)。
 *
 * 背景:popup.css / options.css 都曾把 `@media (prefers-color-scheme: dark)` 覆写块
 * 写在浅色基础规则**之前**;选择器优先级相同时后者胜出,于是深色覆写被后面的浅色
 * 规则盖掉,只剩 body 变深,白底按钮承袭白字(Edge 深色模式实测,v0.10.3/v0.10.4)。
 * preview.css 修过同类问题并留了注释,但没人拦得住新文件再犯——故机械拦截。
 *
 * 判定:深色媒体块内每条声明,若同文件后面还有**选择器字面完全相同**的顶层基础规则
 * 声明了同一属性(或会重置它的简写),即判为失效覆写。
 * 保守口径:只比对选择器字面相同者,不做选择器重叠/优先级推导,避免误报。
 */
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DARK = 'prefers-color-scheme: dark';

/** 会重置这些长属性的简写(只列本项目用到的) */
const SHORTHANDS = {
  border: ['border-color', 'border-width', 'border-style', 'border-top', 'border-right', 'border-bottom', 'border-left'],
  background: ['background-color', 'background-image'],
  font: ['font-size', 'font-family', 'font-weight', 'line-height', 'font-style', 'color'],
  margin: ['margin-top', 'margin-right', 'margin-bottom', 'margin-left'],
  padding: ['padding-top', 'padding-right', 'padding-bottom', 'padding-left'],
  overflow: ['overflow-x', 'overflow-y'],
  flex: ['flex-grow', 'flex-shrink', 'flex-basis'],
  inset: ['top', 'right', 'bottom', 'left'],
  'border-radius': ['border-top-left-radius', 'border-top-right-radius', 'border-bottom-right-radius', 'border-bottom-left-radius'],
};
const affected = (prop) => [prop, ...(SHORTHANDS[prop] || [])];

const norm = (s) => s.replace(/\s+/g, ' ').trim();

function parseDecls(body) {
  const decls = [];
  for (const chunk of body.split(';')) {
    const c = chunk.indexOf(':');
    if (c < 0) continue;
    const prop = chunk.slice(0, c).trim().toLowerCase();
    const value = chunk.slice(c + 1).trim();
    if (prop) decls.push({ prop, value, important: /!important/i.test(value) });
  }
  return decls;
}

/** 解析一条规则列表:`sel, sel2 { a: b; }` → [{selector, decls}] (逗号选择器拆成多条) */
function parseRuleList(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const close = text.indexOf('}', open);
    if (close < 0) break;
    const decls = parseDecls(text.slice(open + 1, close));
    if (decls.length) {
      for (const sel of text.slice(i, open).split(',')) {
        const selector = norm(sel);
        if (selector) out.push({ selector, decls });
      }
    }
    i = close + 1;
  }
  return out;
}

/** 拆出顶层基础规则与深色媒体块,各带文档顺序 */
function parseSheet(css) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const base = [];
  const darks = [];
  let i = 0;
  let order = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i);
    if (open < 0) break;
    const header = norm(text.slice(i, open));
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === '{') depth++;
      else if (text[j] === '}') depth--;
      j++;
    }
    const body = text.slice(open + 1, j - 1);
    if (header.includes(DARK)) {
      darks.push({ order: order++, rules: parseRuleList(body) });
    } else if (!header.startsWith('@')) {
      for (const rule of parseRuleList(`${header}{${body}}`)) {
        base.push({ order: order++, selector: rule.selector, decls: rule.decls });
      }
    } else {
      order++; // 其他 @ 规则(如 @keyframes)不参与判定
    }
    i = j;
  }
  return { base, darks };
}

/** 返回失效覆写列表 { selector, prop, overriddenBy } */
function findShadowedOverrides(css) {
  const { base, darks } = parseSheet(css);
  const bad = [];
  const seen = new Set();
  for (const d of darks) {
    for (const rule of d.rules) {
      for (const decl of rule.decls) {
        if (decl.important) continue;
        for (const b of base) {
          if (b.order <= d.order || b.selector !== rule.selector) continue;
          const hit = b.decls.find((bd) => !bd.important &&
            affected(decl.prop).some((p) => affected(bd.prop).includes(p)));
          if (!hit) continue;
          const key = `${rule.selector}|${decl.prop}`;
          if (seen.has(key)) continue;
          seen.add(key);
          bad.push({ selector: rule.selector, prop: decl.prop, overriddenBy: `${hit.prop}: ${hit.value}` });
        }
      }
    }
  }
  return bad;
}

/* ---------- 1. 反例:必须被拦下 ---------- */
const BAD = `
:root { color-scheme: light dark; }
body { color: #1c2330; background: #f7f8fa; }
@media (prefers-color-scheme: dark) {
  body { background: #171a21; }
  .btns button { background: #232833; color: #dde3ee; }
}
.btns button { background: #fff; }
`;
let bad = findShadowedOverrides(BAD);
assert.ok(bad.some((x) => x.selector === '.btns button' && x.prop === 'background'),
  '深色块写在基础规则之前时必须报错(这正是 popup/options 的历史 bug)');
assert.ok(!bad.some((x) => x.selector === 'body'),
  '深色 body 之后没有同选择器 body 规则,不应误报');

/* 简写重置长属性也必须识别:深色设 border-color,后面基础规则用 border 简写盖掉 */
bad = findShadowedOverrides(`
@media (prefers-color-scheme: dark) { fieldset { border-color: #333a48; } }
fieldset { border: 1px solid #d6dbe4; }
`);
assert.deepEqual(bad.map((x) => x.prop), ['border-color'], 'border 简写重置 border-color 必须被识别');

/* 反向:深色设 background-color,后面基础规则用 background 简写盖掉 */
bad = findShadowedOverrides(`
@media (prefers-color-scheme: dark) { button { background-color: #232833; } }
button { background: #fff; }
`);
assert.deepEqual(bad.map((x) => x.prop), ['background-color'], 'background 简写重置 background-color 必须被识别');

/* 逗号选择器列表按项比对:深色 input,select,textarea 与基础 select 冲突 */
bad = findShadowedOverrides(`
@media (prefers-color-scheme: dark) { input, select, textarea { border-color: #3a4150; } }
select { border: 1px solid #ccd2dd; }
`);
assert.deepEqual(bad.map((x) => x.selector), ['select'], '逗号列表必须逐项比对');

/* ---------- 2. 正例:必须放行 ---------- */
assert.deepEqual(findShadowedOverrides(`
body { color: #1c2330; }
.btns button { background: #fff; }
@media (prefers-color-scheme: dark) {
  body { color: #dde3ee; }
  .btns button { background: #232833; }
}
`), [], '深色块在末尾应放行');

assert.deepEqual(findShadowedOverrides(`
button { background: #fff; }
@media (prefers-color-scheme: dark) { body { background: #101318; } }
button:hover { background: #eee; }
`), [], '深色块只覆写 body、后面无同选择器 body 声明时应放行(preview.css 现状)');

assert.deepEqual(findShadowedOverrides(`
@media (prefers-color-scheme: dark) { button { background: #232833 !important; } }
button { background: #fff; }
`), [], '!important 深色声明不算失效');

/* ---------- 3. 现役页面样式表必须干净 ---------- */
const SHEETS = ['popup/popup.css', 'options/options.css', 'preview/preview.css'];
let darkSheets = 0;
for (const f of SHEETS) {
  const css = readFileSync(join(ROOT, f), 'utf8');
  if (!css.includes(DARK)) continue;
  darkSheets++;
  const issues = findShadowedOverrides(css);
  assert.deepEqual(issues, [],
    `${f} 深色覆写被后面的浅色基础规则盖掉(白底白字根因):` +
    issues.map((x) => `${x.selector} { ${x.prop} } 被 ${x.overriddenBy} 覆盖`).join('; '));
}
assert.equal(darkSheets, SHEETS.length, '三个页面样式表都应声明深色模式适配');

console.log('✔ css-dark.test.mjs(深色覆写顺序 + 简写重置 + 三个页面样式表)');
