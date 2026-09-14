/**
 * relay WS 编解码单测 + 全链路集成测试(假扩展 WS 客户端 → /v1/screenshot 落盘)。
 * node tests/ws-relay.test.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { wsAccept, encodeFrame, encodeControl, decodeFrames, startRelay } from '../bridge/relay.mjs';

/* ---------------- 客户端侧:掩码帧编码(RFC 要求客户端必须掩码) ---------------- */
function encodeClientFrame(text) {
  const payload = Buffer.from(text, 'utf8');
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i++) masked[i] = payload[i] ^ mask[i & 3];
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = 0x80 | len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x81;
  return Buffer.concat([header, mask, masked]);
}

/* ---------------- 单元测试 ---------------- */
// RFC6457§1.3 握手示例向量
assert.equal(wsAccept('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');

// 三种长度头的编码 → 客户端解码器可还原
for (const text of ['hi', 'x'.repeat(200), 'y'.repeat(70000)]) {
  const frames = decodeFrames(encodeClientFrame(text), false).frames;
  assert.equal(frames.length, 1);
  assert.equal(frames[0].payload.toString('utf8'), text);
}
// 服务端编码帧可被宽容解析
assert.deepEqual(
  decodeFrames(encodeFrame('abc'), false).frames.map(f => f.payload.toString()), ['abc']);
// 半帧留在 rest,补齐后解出
const whole = encodeClientFrame('splitme');
let r = decodeFrames(whole.subarray(0, 5), false);
assert.equal(r.frames.length, 0);
r = decodeFrames(Buffer.concat([r.rest, whole.subarray(5)]), false);
assert.equal(r.frames[0].payload.toString(), 'splitme');
// 未掩码的“客户端”帧必须被拒
assert.throws(() => decodeFrames(encodeFrame('x'), true), /masked/);
// 控制帧
assert.equal(decodeFrames(encodeControl(8), false).frames[0].opcode, 8);

console.log('✔ WS 编解码/握手 单测');

/* ---------------- 集成测试 ---------------- */
const PNG1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TOKEN = 'test-token-123';
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshot-test-'));
// 失败/断言抛出也清理,避免断言失败泄漏 /tmp 目录(洁癖收尾发现的 hygiene 问题)
process.on('exit', () => { try { fs.rmSync(outDir, { recursive: true, force: true }); } catch (e) { /* noop */ } });
const relay = startRelay({ token: TOKEN, outDir });
const port = await relay.listen(0);

async function httpReq(method, urlPath, { body, token } = {}) {
  const res = await new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method,
        headers: Object.assign(
          { 'content-type': 'application/json' },
          token ? { 'x-clipshot-token': token } : {}) },
      resolve);
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
  let raw = '';
  for await (const c of res) raw += c;
  return { status: res.statusCode, json: JSON.parse(raw || '{}') };
}

// 1) health 无需 token
let h = await httpReq('GET', '/v1/health');
assert.equal(h.status, 200);
assert.equal(h.json.extension.connected, false);

// 2) 无 token → 401;扩展离线 → 503
assert.equal((await httpReq('POST', '/v1/screenshot', { body: { mode: 'visible' } })).status, 401);
assert.equal((await httpReq('POST', '/v1/screenshot', { token: TOKEN, body: { mode: 'visible' } })).json.error, 'EXTENSION_OFFLINE');

// 3) 假扩展:WS 握手 + hello
function extConnect(token) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1', port, path: '/bridge',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
    });
    req.on('error', reject);
    req.end();
    req.on('upgrade', (res, socket, head) => {
      assert.equal(res.headers['sec-websocket-accept'], wsAccept(key));
      let buf = head && head.length ? head : Buffer.alloc(0);
      const messages = [];
      const listeners = [];
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const r = decodeFrames(buf, false);
        buf = r.rest;
        for (const f of r.frames) {
          if (f.opcode === 1) {
            const m = JSON.parse(f.payload.toString());
            messages.push(m);
            for (const l of [...listeners]) l(m); // 副本遍历:监听器解析后会自摘
          }
        }
      });
      const api = {
        socket, messages, listeners,
        send: (obj) => socket.write(encodeClientFrame(JSON.stringify(obj))),
        waitMsg: (pred, ms = 5000) => new Promise((res2, rej) => {
          const t0 = Date.now();
          const poll = () => {
            const hit = messages.find(pred);
            if (hit) return res2(hit);
            if (Date.now() - t0 > ms) return rej(new Error('等待扩展侧消息超时'));
            setTimeout(poll, 20);
          };
          listeners.push((m) => { if (pred(m)) res2(m); });
          poll();
        }),
        close: () => socket.destroy()
      };
      if (token !== undefined) api.send({ t: 'hello', token, version: '0.3.0-test' });
      resolve(api);
    });
  });
}

// 错误 token 会被拒
let bad = await extConnect('wrong');
let ack = await bad.waitMsg((m) => m.t === 'hello-ack');
assert.equal(ack.ok, false);
bad.close();
await new Promise(r => setTimeout(r, 80));

// 正确 token → 连接 → health connected
const ext = await extConnect(TOKEN);
ack = await ext.waitMsg((m) => m.t === 'hello-ack');
assert.equal(ack.ok, true);
h = await httpReq('GET', '/v1/health');
assert.equal(h.json.extension.connected, true);

// 取「下一条未处理过」的命令帧(防 messages.find 命中旧消息)
const handledCmds = new Set();
function nextCmd(name) {
  return new Promise((res, rej) => {
    const hit = (m) => {
      if (m && m.cmd === name && !handledCmds.has(m.id)) {
        handledCmds.add(m.id);
        const i = ext.listeners.indexOf(hit);
        if (i >= 0) ext.listeners.splice(i, 1); // 解析即摘除,防止劫持后续新消息
        res(m);
        return true;
      }
      return false;
    };
    for (const m of ext.messages) if (hit(m)) return;
    ext.listeners.push(hit);
    setTimeout(() => {
      const i = ext.listeners.indexOf(hit);
      if (i >= 0) ext.listeners.splice(i, 1);
      rej(new Error('等待命令超时: ' + name));
    }, 5000);
  });
}

// 4) /v1/tabs 往返
nextCmd('tabs').then((cmd) => {
  ext.send({ t: 'reply', id: cmd.id, ok: true, tabs: [{ tabId: 7, url: 'https://e.com', active: true }] });
});
const tabs = await httpReq('GET', '/v1/tabs', { token: TOKEN });
assert.equal(tabs.json.ok, true);
assert.equal(tabs.json.tabs[0].tabId, 7);

// 5) /v1/screenshot 全链路:result + upload → 落盘且字节一致
nextCmd('screenshot').then((cmd) => {
  assert.equal(cmd.args.mode, 'full');
  ext.send({ t: 'result', id: cmd.id, ok: true, image: { name: 'shot_test.png', mime: 'image/png', widthPx: 1, heightPx: 1 }, notes: ['测试注记'] });
  ext.send({ t: 'upload', id: cmd.id, seq: 0, b64: PNG1x1, last: true });
});
const shot = await httpReq('POST', '/v1/screenshot', { token: TOKEN, body: { mode: 'full' } });
assert.equal(shot.json.ok, true);
assert.equal(shot.json.notes[0], '测试注记');
const written = fs.readFileSync(shot.json.image.path);
assert.equal(written.length, Buffer.from(PNG1x1, 'base64').length);
assert.ok(shot.json.image.path.startsWith(outDir));

// 6) 同名文件不覆盖(追加 -2)
nextCmd('screenshot').then((cmd) => {
  ext.send({ t: 'result', id: cmd.id, ok: true, image: { name: 'shot_test.png', mime: 'image/png' } });
  ext.send({ t: 'upload', id: cmd.id, seq: 0, b64: PNG1x1, last: true });
});
const shot2 = await httpReq('POST', '/v1/screenshot', { token: TOKEN, body: { mode: 'full' } });
assert.equal(shot2.json.ok, true);
assert.ok(/shot_test-2\.png$/.test(shot2.json.image.path), '应生成不重名文件,实际: ' + shot2.json.image.path);

// 6b) P003 多段回传:按 seg 分组、逐段落盘,响应 parts/paths(旧版直连 base64 损坏 bug 的回归)
nextCmd('screenshot').then((cmd) => {
  ext.send({ t: 'result', id: cmd.id, ok: true, image: { name: 'multi_test.png', mime: 'image/png', widthPx: 1, heightPx: 2 } });
  ext.send({ t: 'upload', id: cmd.id, seq: 0, seg: 0, b64: PNG1x1, last: false });
  ext.send({ t: 'upload', id: cmd.id, seq: 1, seg: 1, b64: PNG1x1, last: true });
});
const multi = await httpReq('POST', '/v1/screenshot', { token: TOKEN, body: { mode: 'full' } });
assert.equal(multi.json.ok, true);
assert.equal(multi.json.image.parts, 2);
assert.equal(multi.json.image.paths.length, 2);
assert.ok(/multi_test_part1of2\.png$/.test(multi.json.image.paths[0]), multi.json.image.paths[0]);
assert.ok(/multi_test_part2of2\.png$/.test(multi.json.image.paths[1]), multi.json.image.paths[1]);
for (const p of multi.json.image.paths) {
  assert.equal(fs.readFileSync(p).length, Buffer.from(PNG1x1, 'base64').length, '每个分段都必须是完整可读的图片');
}
assert.equal(multi.json.image.heightPx, null, '多段时 heightPx 不谎报整图高');
assert.equal(multi.json.image.path, multi.json.image.paths[0], 'path 向后兼容=第一分段');

// 7) 扩展断开 → 进行中请求收到 EXTENSION_OFFLINE,后续 503
const inFlight = httpReq('POST', '/v1/screenshot', { token: TOKEN, body: { mode: 'full' } });
await nextCmd('screenshot');
ext.close();
const failRes = await inFlight;
assert.equal(failRes.json.error, 'EXTENSION_OFFLINE');
assert.equal((await httpReq('GET', '/v1/tabs', { token: TOKEN })).json.error, 'EXTENSION_OFFLINE');

relay.close();
fs.rmSync(outDir, { recursive: true, force: true });
console.log('✔ relay 集成测试(握手/token/tabs/screenshot 落盘/断开处理)');
process.exit(0);
