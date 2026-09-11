#!/usr/bin/env node
'use strict';
/**
 * ClipShot Agent 桥 relay(P001,零依赖 Node ≥18)。
 * 对 Agent 暴露 http://127.0.0.1:<port>(需 token),对扩展暴露 ws://127.0.0.1:<port>/bridge。
 * WS 服务器为手写最小 RFC6455 实现(握手 + 帧编解码),协议与 tests/ws-relay.test.mjs 锁死。
 *
 * 启动:node bridge/relay.mjs [--port 8790] [--out ~/clipshot-out] [--reset-token]
 * 首次启动生成随机 token,存 ~/.clipshot/relay.json;把它填进扩展设置页「Agent 桥接」。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

export const RELAY_VERSION = '0.3.0';
const DEFAULT_PORT = 8790;
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PING_INTERVAL_MS = 20000;
const CMD_TIMEOUT_SIMPLE = 15000;

/* ================= WS 帧编解码(RFC 6455 最小子集) ================= */

export function wsAccept(secKey) {
  return crypto.createHash('sha1').update(secKey + GUID).digest('base64');
}

/** 服务端 → 客户端:不掩码的文本帧 */
export function encodeFrame(text, opcode = 1) {
  const payload = Buffer.from(text, 'utf8');
  const len = payload.length;
  let header;
  if (len < 126) { header = Buffer.alloc(2); header[1] = len; }
  else if (len < 65536) { header = Buffer.alloc(4); header[1] = 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2); }
  header[0] = 0x80 | opcode; // 恒为单帧(FIN=1)
  return Buffer.concat([header, payload]);
}

export function encodeControl(opcode, payload = Buffer.alloc(0)) {
  const h = Buffer.alloc(2);
  h[0] = 0x80 | opcode;
  h[1] = payload.length;
  return Buffer.concat([h, payload]);
}

/**
 * 解出缓冲区里所有完整帧。requireMask:服务端对客户端必须 true(RFC 要求掩码)。
 * 返回 { frames:[{fin,opcode,payload}], rest }。不完整帧留到下次。
 */
export function decodeFrames(buf, requireMask = true) {
  const frames = [];
  let off = 0;
  for (;;) {
    if (buf.length - off < 2) break;
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0;
    const opcode = b0 & 0x0f;
    const masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f;
    let p = off + 2;
    if (len === 126) {
      if (buf.length - p < 2) break;
      len = buf.readUInt16BE(p); p += 2;
    } else if (len === 127) {
      if (buf.length - p < 8) break;
      const big = buf.readBigUInt64BE(p);
      if (big > 0x7fffffff00n) throw new Error('frame too large');
      len = Number(big); p += 8;
    }
    if (requireMask && !masked) throw new Error('client frames must be masked');
    const maskLen = masked ? 4 : 0;
    if (buf.length - p < maskLen + len) break;
    let payload;
    if (masked) {
      const mask = buf.subarray(p, p + 4); p += 4;
      payload = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) payload[i] = buf[p + i] ^ mask[i & 3];
    } else {
      payload = buf.subarray(p, p + len);
    }
    p += len;
    frames.push({ fin, opcode, payload });
    off = p;
  }
  return { frames, rest: buf.subarray(off) };
}

/* ================= 配置/落盘 ================= */

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

export function loadOrCreateConfig({ port, out, resetToken }) {
  const dir = path.join(os.homedir(), '.clipshot');
  ensureDir(dir);
  const file = path.join(dir, 'relay.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { cfg = {}; }
  if (resetToken || !cfg.token) cfg.token = crypto.randomBytes(16).toString('hex');
  cfg.port = port || cfg.port || DEFAULT_PORT;
  cfg.out = out || cfg.out || path.join(os.homedir(), 'clipshot-out');
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  return { file, ...cfg };
}

function safeName(name) {
  const base = path.basename(String(name || ''));
  if (/^[\w.\- ]{1,120}\.(png|jpg|jpeg)$/i.test(base)) return base;
  return 'ClipShot_' + Date.now() + '.png';
}

function uniquePath(dir, name) {
  let p = path.join(dir, name);
  if (!fs.existsSync(p)) return p;
  const dot = name.lastIndexOf('.');
  for (let i = 2; i < 1000; i++) {
    const n = dot > 0 ? name.slice(0, dot) + '-' + i + name.slice(dot) : name + '-' + i;
    p = path.join(dir, n);
    if (!fs.existsSync(p)) return p;
  }
  return path.join(dir, Date.now() + '.png');
}

/* ================= relay 主体 ================= */

export function startRelay({ port = DEFAULT_PORT, token, outDir }) {
  ensureDir(outDir);
  const pending = new Map(); // cmdId → {res, kind, timer, chunks, meta, notes}
  let ext = null; // {sock, conn, hello, version, since}

  const httpServer = http.createServer((req, res) => handleHttp(req, res).catch((e) => {
    json(res, 500, { ok: false, error: 'RELAY_INTERNAL', message: String((e && e.message) || e) });
  }));

  httpServer.on('upgrade', onUpgrade);

  function json(res, code, obj) {
    if (res.writableEnded) return;
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  async function readBody(req, limit = 2 * 1024 * 1024) {
    let size = 0;
    const parts = [];
    for await (const c of req) {
      size += c.length;
      if (size > limit) throw new Error('请求体过大');
      parts.push(c);
    }
    return Buffer.concat(parts).toString('utf8');
  }

  function safeEq(a, b) {
    const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
  }

  function tokenOk(req) {
    const got = req.headers['x-clipshot-token'] ||
      (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
      new URL(req.url, 'http://x').searchParams.get('token');
    return typeof got === 'string' && got.length > 0 && safeEq(got, token);
  }

  function extConnected() { return !!(ext && ext.hello); }

  function failPendingAll(reason) {
    for (const [id, p] of [...pending]) {
      clearTimeout(p.timer);
      pending.delete(id);
      json(p.res, 503, { ok: false, error: 'EXTENSION_OFFLINE', message: reason });
    }
  }

  async function handleHttp(req, res) {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/v1/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        relay: { version: RELAY_VERSION, port, outDir, pending: pending.size },
        extension: {
          connected: extConnected(),
          version: ext && ext.version || null,
          since: ext && ext.hello && ext.since || null
        }
      });
    }
    if (!tokenOk(req)) {
      return json(res, 401, { ok: false, error: 'BAD_TOKEN', message: '缺少或错误的 X-ClipShot-Token(relay 启动时打印的令牌)' });
    }
    if (!extConnected()) {
      return json(res, 503, {
        ok: false, error: 'EXTENSION_OFFLINE',
        message: 'relay 已运行但浏览器扩展未连接:打开 ClipShot 设置页启用「Agent 桥接」、确认 token 一致;仍不行就重启 Chrome 或点一下扩展图标唤醒'
      });
    }

    if (u.pathname === '/v1/tabs' && req.method === 'GET') {
      const id = crypto.randomUUID();
      return dispatch(id, { res, kind: 'simple' }, { t: 'cmd', id, cmd: 'tabs' }, CMD_TIMEOUT_SIMPLE);
    }
    if (u.pathname === '/v1/screenshot' && req.method === 'POST') {
      let args;
      try { args = JSON.parse(await readBody(req) || '{}'); }
      catch (e) { return json(res, 400, { ok: false, error: 'BAD_REQUEST', message: String(e.message || e) }); }
      const id = crypto.randomUUID();
      const timeout = Math.min(Math.max((args.timeoutMs | 0) || 240000, 5000), 240000);
      delete args.timeoutMs;
      dispatch(id, { res, kind: 'shot', chunks: new Map(), meta: null, notes: [] },
        { t: 'cmd', id, cmd: 'screenshot', args }, timeout);
      return;
    }
    return json(res, 404, { ok: false, error: 'NOT_FOUND', message: '端点:/v1/health /v1/tabs /v1/screenshot(见 docs/Agent接入指南.md)' });
  }

  function dispatch(id, entry, cmdMsg, timeoutMs) {
    entry.timer = setTimeout(() => {
      pending.delete(id);
      json(entry.res, 504, { ok: false, error: 'TIMEOUT', message: '扩展侧 ' + Math.round(timeoutMs / 1000) + ' 秒内未完成(页面过大或已被关闭);可带 "format":"jpeg" 或换 target 重试' });
    }, timeoutMs);
    pending.set(id, entry);
    ext.conn.sendText(JSON.stringify(cmdMsg));
  }

  /* ---------- 来自扩展的消息 ---------- */
  function onExtMessage(text) {
    let m;
    try { m = JSON.parse(text); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    switch (m.t) {
      case 'hello':
        if (m.token !== token) {
          ext.hello = false;
          ext.conn.sendText(JSON.stringify({ t: 'hello-ack', ok: false, reason: 'auth' }));
          setTimeout(() => ext && ext.sock.destroy(), 500);
          return;
        }
        ext.hello = true;
        ext.version = m.version || null;
        ext.since = Date.now();
        ext.conn.sendText(JSON.stringify({ t: 'hello-ack', ok: true }));
        break;
      case 'pong':
        ext.alive = true;
        break;
      case 'reply': {
        const p = pending.get(m.id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(m.id);
        if (p.kind === 'simple') return json(p.res, 200, m);
        if (!m.ok) return json(p.res, 200, m); // 截图失败也把错误体原样回给 Agent
        break;
      }
      case 'result': {
        const p = pending.get(m.id);
        if (p && p.kind === 'shot') { p.meta = m.image || {}; p.notes = m.notes || []; }
        break;
      }
      case 'upload': {
        const p = pending.get(m.id);
        if (!p || p.kind !== 'shot') return;
        if (m.error) {
          clearTimeout(p.timer); pending.delete(m.id);
          return json(p.res, 500, { ok: false, error: 'UPLOAD_FAILED', message: '扩展侧读取图片数据失败' });
        }
        p.chunks.set(m.seq, m.b64);
        if (!m.last) return;
        clearTimeout(p.timer); pending.delete(m.id);
        // 按序拼接 base64 → 二进制 → 落盘
        const seqs = [...p.chunks.keys()].sort((a, b) => a - b);
        let b64 = '';
        for (const s of seqs) b64 += p.chunks.get(s);
        const buf = Buffer.from(b64, 'base64');
        const file = uniquePath(outDir, safeName(p.meta.name));
        try { fs.writeFileSync(file, buf); }
        catch (e) {
          return json(p.res, 500, { ok: false, error: 'WRITE_FAILED', message: '写盘失败:' + (e.message || e) });
        }
        json(p.res, 200, {
          ok: true,
          image: {
            path: file, sizeBytes: buf.length,
            widthPx: p.meta.widthPx || null, heightPx: p.meta.heightPx || null,
            mime: p.meta.mime || 'image/png'
          },
          notes: p.notes
        });
        break;
      }
    }
  }

  /* ---------- WS 接入 ---------- */
  function onUpgrade(req, socket) {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname !== '/bridge') { socket.destroy(); return; }
    const key = req.headers['sec-websocket-key'];
    if (!key || req.headers.upgrade == null || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); socket.destroy(); return;
    }
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + wsAccept(key) + '\r\n\r\n'
    );
    socket.setNoDelay(true);
    // 单连接策略:新扩展实例顶掉旧连接
    if (ext) { try { ext.conn.close(); } catch (e) {} failPendingAll('扩展连接被新实例替换'); }

    let buf = Buffer.alloc(0);
    let frag = null;
    const entry = { sock: socket, hello: false, version: null, since: null, alive: true, conn: null };
    entry.conn = {
      sendText: (s) => { try { socket.write(encodeFrame(s)); } catch (e) {} },
      close: () => { try { socket.write(encodeControl(8)); socket.end(); } catch (e) {} }
    };
    ext = entry;

    socket.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      let r;
      try { r = decodeFrames(buf, true); } catch (e) { socket.destroy(); return; }
      buf = r.rest;
      for (const f of r.frames) {
        if (f.opcode === 8) { socket.destroy(); return; }
        if (f.opcode === 9) { try { socket.write(encodeControl(10, f.payload)); } catch (e) {} continue; }
        if (f.opcode === 10) continue;
        if (f.opcode === 1 || f.opcode === 0) {
          if (f.opcode === 0) { if (frag) frag.parts.push(f.payload); else continue; }
          else frag = { parts: [f.payload] };
          if (f.fin) {
            const msg = Buffer.concat(frag.parts).toString('utf8');
            frag = null;
            onExtMessage(msg);
          }
        }
      }
    });
    const cleanup = () => {
      if (ext !== entry) return;
      ext = null;
      failPendingAll('扩展连接断开(浏览器重启/扩展重载?)');
    };
    socket.on('close', cleanup);
    socket.on('error', cleanup);
  }

  // 应用层心跳:每 20s 文本 ping;连续两次无 pong 判定假死
  const pingTimer = setInterval(() => {
    if (!ext) return;
    if (!ext.alive) { ext.sock.destroy(); return; }
    ext.alive = false;
    ext.conn.sendText(JSON.stringify({ t: 'ping' }));
  }, PING_INTERVAL_MS);
  if (pingTimer.unref) pingTimer.unref();

  return {
    listen(p) {
      return new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(p || port, '127.0.0.1', () => {
          httpServer.removeListener('error', reject);
          resolve(httpServer.address().port);
        });
      });
    },
    close() {
      clearInterval(pingTimer);
      if (ext) { try { ext.conn.close(); } catch (e) {} }
      httpServer.close();
    },
    get port() { return httpServer.address() && httpServer.address().port; },
    get extConnected() { return extConnected(); }
  };
}

/* ================= CLI ================= */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]) | 0;
    else if (argv[i] === '--out') out.out = path.resolve(argv[++i]);
    else if (argv[i] === '--reset-token') out.resetToken = true;
  }
  return out;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const cfg = loadOrCreateConfig(cli);
  const relay = startRelay({ port: cfg.port, token: cfg.token, outDir: cfg.out });
  const port = await relay.listen().catch((e) => {
    console.error('[ClipShot 桥] 启动失败:' + e.message + (e.code === 'EADDRINUSE'
      ? '\n  端口 ' + cfg.port + ' 被占用——先关掉旧的 relay 进程,或用 --port 换一个端口' : ''));
    process.exit(1);
  });
  console.log('┌─────────────────────────────────────────────────────');
  console.log('│ ClipShot Agent 桥 v' + RELAY_VERSION + ' 已启动');
  console.log('│ 地址        http://127.0.0.1:' + port);
  console.log('│ token       ' + cfg.token);
  console.log('│             ↑ 粘贴到 ClipShot 设置页「Agent 桥接」');
  console.log('│ 截图输出    ' + cfg.out);
  console.log('│ 配置存于    ' + cfg.file);
  console.log('│ 用法与排错  docs/Agent接入指南.md');
  console.log('└─────────────────────────────────────────────────────');
  if (cfg.token && relay) {
    setInterval(async () => {
      try {
        const r = await fetch('http://127.0.0.1:' + port + '/v1/health');
        const j = await r.json();
        const mark = j.extension && j.extension.connected ? '● 扩展已连接' : '○ 等待扩展连接(设置页启用桥接并核对 token)';
        process.stdout.write('\r' + mark + '  ' + new Date().toLocaleTimeString() + '   ');
      } catch (e) { /* ignore */ }
    }, 5000).unref();
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
