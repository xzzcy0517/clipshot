/**
 * P002 MCP 直连全链路测试(服务器可跑,零依赖):
 * spawn 真实 mcp.mjs 子进程走 stdio JSON-RPC;假扩展 WS 客户端配合截图落盘;
 * 覆盖:协议握手/工具清单/健康/离线错误/截图端到端/tabs/端口占用降级/--install dry-run。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFrames } from '../bridge/relay.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP = path.join(ROOT, 'bridge/mcp.mjs');
const PNG1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TOKEN = 'mcp-test-token';
const PORT = 18800 + Math.floor(Math.random() * 800);

const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshot-mcp-cfg-'));
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshot-mcp-out-'));
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'clipshot-mcp-home-'));
// 失败/断言抛出也清理(洁癖收尾发现的 hygiene 问题)
process.on('exit', () => {
  for (const d of [cfgDir, outDir, fakeHome]) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) { /* noop */ }
  }
});
fs.writeFileSync(path.join(cfgDir, 'relay.json'), JSON.stringify({ token: TOKEN, port: PORT, out: outDir }));
const ENV = { ...process.env, CLIPSHOT_CONFIG_DIR: cfgDir, CLIPSHOT_OUT_DIR: outDir };

/* ---------------- MCP 子进程 harness ---------------- */
function spawnMcp(extraArgs = [], extraEnv = {}) {
  const child = spawn(process.execPath, [MCP, '--port', String(PORT), ...extraArgs],
    { stdio: ['pipe', 'pipe', 'pipe'], env: { ...ENV, ...extraEnv } });
  child.stdin.on('error', () => {}); // kill 后写入的 EPIPE 属预期
  child.on('error', () => {});
  const msgs = [];
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) { if (l.trim()) { try { msgs.push(JSON.parse(l)); } catch (e) { /* 协议外输出即测试失败点 */ } } }
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });
  return {
    child, msgs, get stderr() { return stderr; },
    send: (o) => child.stdin.write(JSON.stringify(o) + '\n'),
    wait: (pred, ms = 8000) => new Promise((res, rej) => {
      const t0 = Date.now();
      const poll = () => {
        const hit = msgs.find(pred);
        if (hit) return res(hit);
        if (Date.now() - t0 > ms) return rej(new Error('等待 MCP 响应超时: ' + JSON.stringify(msgs).slice(0, 300)));
        setTimeout(poll, 20);
      };
      poll();
    })
  };
}

/* ---------------- 假扩展 WS 客户端(掩码帧) ---------------- */
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

function extConnect(port, token) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const req = http.request({
      host: '127.0.0.1', port, path: '/bridge',
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13' }
    });
    req.on('error', reject);
    req.end();
    req.on('upgrade', (res, socket, head) => {
      let buf = head && head.length ? head : Buffer.alloc(0);
      const messages = [];
      const listeners = [];
      socket.on('error', () => {}); // 测试收尾 kill 进程时的 ECONNRESET 属预期
      socket.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        const r = decodeFrames(buf, false);
        buf = r.rest;
        for (const f of r.frames) {
          if (f.opcode === 1) {
            const m = JSON.parse(f.payload.toString());
            messages.push(m);
            for (const l of [...listeners]) l(m);
          }
        }
      });
      const api = {
        messages, listeners, socket,
        send: (o) => socket.write(encodeClientFrame(JSON.stringify(o))),
        close: () => socket.destroy(),
        waitMsg: (pred, ms = 5000) => new Promise((res2, rej) => {
          const t0 = Date.now();
          const hit = (m) => { if (pred(m)) { const i = listeners.indexOf(hit); if (i >= 0) listeners.splice(i, 1); res2(m); return true; } return false; };
          for (const m of messages) if (hit(m)) return;
          listeners.push(hit);
          setTimeout(() => rej(new Error('等扩展侧消息超时')), ms);
        })
      };
      api.send({ t: 'hello', token, version: 'test-ext' });
      resolve(api);
    });
  });
}

/* ---------------- 用例 ---------------- */
const handledCmds = new Set(); // 已被测试消费的命令 id(防 waitMsg 命中旧消息)
const mcp = spawnMcp();
let idc = 0;
const rpc = (method, params) => { const id = ++idc; mcp.send({ jsonrpc: '2.0', id, method, params }); return id; };

// 1) initialize
let id = rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } });
let r = await mcp.wait((m) => m.id === id);
assert.equal(r.result.serverInfo.name, 'clipshot');
assert.equal(r.result.protocolVersion, '2024-11-05');
assert.ok(r.result.capabilities.tools);
mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' });

// 2) tools/list
id = rpc('tools/list');
r = await mcp.wait((m) => m.id === id);
const names = r.result.tools.map(t => t.name).sort();
assert.deepEqual(names, ['clipshot_health', 'clipshot_screenshot', 'clipshot_tabs']);
const shot = r.result.tools.find(t => t.name === 'clipshot_screenshot');
assert.deepEqual(shot.inputSchema.properties.mode.enum, ['full', 'visible', 'element']);

// 3) health:扩展未连接
id = rpc('tools/call', { name: 'clipshot_health', arguments: {} });
r = await mcp.wait((m) => m.id === id);
assert.ok(r.result.content[0].text.includes('未连接'));

// 4) 无扩展时截图 → isError + EXTENSION_OFFLINE
id = rpc('tools/call', { name: 'clipshot_screenshot', arguments: { mode: 'visible' } });
r = await mcp.wait((m) => m.id === id);
assert.equal(r.result.isError, true);
assert.ok(r.result.content[0].text.includes('EXTENSION_OFFLINE'));

// 5) 假扩展上线
const ext = await extConnect(PORT, TOKEN);
const ack = await ext.waitMsg((m) => m.t === 'hello-ack');
assert.equal(ack.ok, true);

// 6) 截图端到端:cmd → result+upload → 文本含路径,文件字节一致
id = rpc('tools/call', { name: 'clipshot_screenshot', arguments: { mode: 'full', format: 'png' } });
const cmd = await ext.waitMsg((m) => m.cmd === 'screenshot' && !handledCmds.has(m.id));
handledCmds.add(cmd.id);
assert.equal(cmd.args.mode, 'full');
ext.send({ t: 'result', id: cmd.id, ok: true, image: { name: 'mcp_test.png', mime: 'image/png', widthPx: 1, heightPx: 1 }, notes: ['mcp 注记'] });
ext.send({ t: 'upload', id: cmd.id, seq: 0, b64: PNG1x1, last: true });
r = await mcp.wait((m) => m.id === id);
assert.ok(!r.result.isError, '截图应成功: ' + JSON.stringify(r.result));
const text = r.result.content[0].text;
assert.ok(text.includes('截图成功'));
const mPath = text.match(/文件: (\S+)/)[1];
assert.ok(mPath.startsWith(outDir));
assert.equal(fs.readFileSync(mPath).length, Buffer.from(PNG1x1, 'base64').length);
assert.ok(text.includes('mcp 注记'));

// 7) element 缺 selector → 工具级校验错误
id = rpc('tools/call', { name: 'clipshot_screenshot', arguments: { mode: 'element' } });
r = await mcp.wait((m) => m.id === id);
assert.equal(r.result.isError, true);
assert.ok(r.result.content[0].text.includes('selector'));

// 8) tabs 往返
id = rpc('tools/call', { name: 'clipshot_tabs', arguments: {} });
const cmdT = await ext.waitMsg((m) => m.cmd === 'tabs');
ext.send({ t: 'reply', id: cmdT.id, ok: true, tabs: [{ tabId: 42, url: 'https://e.com', title: '示例', active: true }] });
r = await mcp.wait((m) => m.id === id);
assert.ok(r.result.content[0].text.includes('42'));

// 8b) P003 多段:每段一个文件,文本块列出全部路径
id = rpc('tools/call', { name: 'clipshot_screenshot', arguments: { mode: 'visible' } });
const cmd2 = await ext.waitMsg((m) => m.cmd === 'screenshot' && !handledCmds.has(m.id));
handledCmds.add(cmd2.id);
ext.send({ t: 'result', id: cmd2.id, ok: true, image: { name: 'mcp_multi.png', mime: 'image/png', widthPx: 1 } });
ext.send({ t: 'upload', id: cmd2.id, seq: 0, seg: 0, b64: PNG1x1, last: false });
ext.send({ t: 'upload', id: cmd2.id, seq: 1, seg: 1, b64: PNG1x1, last: true });
r = await mcp.wait((m) => m.id === id);
const t2 = r.result.content[0].text;
assert.ok(!r.result.isError, '多段应成功: ' + t2);
assert.ok(t2.includes('已分为 2 个分段文件'), t2);
assert.ok(/mcp_multi_part1of2\.png/.test(t2) && /mcp_multi_part2of2\.png/.test(t2), t2);

// 9) 端口占用 → 第二个 mcp 进程自动降级为客户端,仍能 health/tabs
const mcp2 = spawnMcp();
await new Promise(res => setTimeout(res, 800));
assert.ok(mcp2.stderr.includes('降级'), '应打印降级日志,实际: ' + mcp2.stderr.slice(0, 200));
let id2c = 1;
mcp2.send({ jsonrpc: '2.0', id: id2c, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't2', version: '1' } } });
let r2 = await mcp2.wait((m) => m.id === id2c);
assert.equal(r2.result.serverInfo.name, 'clipshot');
mcp2.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'clipshot_health', arguments: {} } });
r2 = await mcp2.wait((m) => m.id === 2);
assert.ok(r2.result.content[0].text.includes('已连接'), '客户端模式应看到同一 relay 的扩展连接状态');
assert.ok(r2.result.content[0].text.includes('客户端降级'));
mcp2.child.kill();

// 10) --install --dry-run:只打印,不落盘
const inst = spawn(process.execPath, [MCP, '--install', '--dry-run', '--port', String(PORT + 1)],
  { stdio: ['pipe', 'pipe', 'pipe'], env: { ...ENV, HOME: fakeHome } });
let instOut = '';
inst.stdout.on('data', (d) => { instOut += d; });
const instCode = await new Promise(res => inst.on('close', res));
assert.equal(instCode, 0);
assert.ok(instOut.includes('claude mcp add clipshot'), '应给出 Claude Code 注册命令');
assert.ok(instOut.includes('[dry-run]'), 'dry-run 应有标记');
assert.ok(instOut.includes('mcp_servers.clipshot'), '应打印 Codex 片段');
assert.ok(!fs.existsSync(path.join(fakeHome, '.cursor', 'mcp.json')), 'dry-run 不得写盘');

// 11) --install(非 dry)遇 Cursor 空 mcp.json:视为无配置,正常写入(用户实测暴露的 bug)
fs.mkdirSync(path.join(fakeHome, '.cursor'), { recursive: true });
fs.writeFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), '  '); // Cursor 设置界面创建的空文件
const inst2 = spawn(process.execPath, [MCP, '--install', '--port', String(PORT + 2)],
  { stdio: ['pipe', 'pipe', 'pipe'], env: { ...ENV, HOME: fakeHome, CLIPSHOT_SKIP_CLAUDE: '1' } });
let inst2Out = '';
inst2.stdout.on('data', (d) => { inst2Out += d; });
inst2.stderr.on('data', () => {});
const inst2Code = await new Promise(res => inst2.on('close', res));
assert.equal(inst2Code, 0);
assert.ok(inst2Out.includes('视为无已有配置'), '空文件应被识别,实际输出:\n' + inst2Out);
assert.ok(inst2Out.includes('✔ 自检通过'));
const writtenCfg = JSON.parse(fs.readFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'));
assert.ok(writtenCfg.mcpServers.clipshot.command);
assert.ok(writtenCfg.mcpServers.clipshot.args[0].endsWith('bridge/mcp.mjs'));
assert.ok(fs.existsSync(path.join(fakeHome, '.cursor', 'mcp.json.bak')));
// 再跑一次:非空合法 JSON → 合并且保留既有 server
fs.writeFileSync(path.join(fakeHome, '.cursor', 'mcp.json'),
  JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
const inst3 = spawn(process.execPath, [MCP, '--install', '--port', String(PORT + 3)],
  { stdio: ['pipe', 'pipe', 'pipe'], env: { ...ENV, HOME: fakeHome, CLIPSHOT_SKIP_CLAUDE: '1' } });
inst3.stdout.resume(); inst3.stderr.resume();
await new Promise(res => inst3.on('close', res));
const merged = JSON.parse(fs.readFileSync(path.join(fakeHome, '.cursor', 'mcp.json'), 'utf8'));
assert.ok(merged.mcpServers.other, '已有其它 MCP 服务器必须保留');
assert.ok(merged.mcpServers.clipshot, 'clipshot 条目应已合并写入');

/* ---------------- 清理 ---------------- */
ext.close();
mcp.child.kill();
await new Promise(res => setTimeout(res, 200));
fs.rmSync(cfgDir, { recursive: true, force: true });
fs.rmSync(outDir, { recursive: true, force: true });
fs.rmSync(fakeHome, { recursive: true, force: true });
console.log('✔ mcp.test.mjs(协议/工具/截图端到端/降级/install dry-run)');
process.exit(0);
