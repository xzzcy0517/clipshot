#!/usr/bin/env node
'use strict';
/**
 * ClipShot Agent 桥 relay(P001,零依赖 Node ≥18)。
 * 对 Agent 暴露 http://127.0.0.1:<port>(需 token),对扩展暴露 ws://127.0.0.1:<port>/bridge。
 * WS 服务器为手写最小 RFC6455 实现(握手 + 帧编解码),协议与 tests/ws-relay.test.mjs 锁死。
 *
 * 启动:node bridge/relay.mjs [--port 8790] [--out ~/clipshot-out]
 * v0.5.0 起零配置(P004):无 token、端口在 8790–8795 自动找。
 * 防滥用改由协议规则承担:只绑 127.0.0.1 + POST 强制 application/json
 * (浏览器跨源必触发 CORS 预检,而 relay 永不返回 CORS 头 → 预检失败,
 * 恶意网页发不进指令;本机进程本就无需设防)。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';

export const RELAY_VERSION = '0.5.0';
export const PORT_START = 8790;
export const PORT_SCAN = 6; // 8790–8795
const DEFAULT_PORT = PORT_START;
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

export function loadOrCreateConfig({ port, out } = {}) {
  // 仅存展示/排错用信息(v0.5.0 起无 token;旧文件里的 token 字段直接忽略)
  // CLIPSHOT_CONFIG_DIR / CLIPSHOT_OUT_DIR 仅供测试与便携部署覆盖,默认用户主目录
  const dir = process.env.CLIPSHOT_CONFIG_DIR || path.join(os.homedir(), '.clipshot');
  ensureDir(dir);
  const file = path.join(dir, 'relay.json');
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { cfg = {}; }
  delete cfg.token;
  cfg.port = port || cfg.port || DEFAULT_PORT;
  cfg.out = out || process.env.CLIPSHOT_OUT_DIR || cfg.out || path.join(os.homedir(), 'clipshot-out');
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

export function startRelay({ port = DEFAULT_PORT, outDir }) {
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

  // v0.5.0 起无 token(P004 §2):防线=只绑 127.0.0.1 + POST 强制 JSON 预检 +
  // 永不返回 CORS 头(relay 从不设置 Access-Control-*,浏览器跨源预检必败)。
  function wantsJson(req) {
    return /application\/json/i.test(String(req.headers['content-type'] || ''));
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
      const addr = httpServer.address();
      return json(res, 200, {
        ok: true,
        relay: { version: RELAY_VERSION, port: (addr && addr.port) || port, outDir, pending: pending.size },
        extension: {
          connected: extConnected(),
          version: ext && ext.version || null,
          since: ext && ext.hello && ext.since || null
        }
      });
    }
    // 协议闸门先于桥状态:POST 一律要求 JSON 体(浏览器跨源因此必过 CORS 预检,
    // 而 relay 永不发 CORS 头 → 恶意网页无法驱动桥;本机 curl -d JSON 自动带该头)
    if (req.method === 'POST' && !wantsJson(req)) {
      return json(res, 415, { ok: false, error: 'JSON_REQUIRED', message: 'POST 需 Content-Type: application/json(curl -d 传 JSON 即自动携带)' });
    }
    if (!extConnected()) {
      return json(res, 503, {
        ok: false, error: 'EXTENSION_OFFLINE',
        message: 'relay 已运行但浏览器扩展未连接:打开 ClipShot 设置页勾选「启用 Agent 桥接」;仍不行就重启 Chrome 或点一下扩展图标唤醒'
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
        // v0.5.0:无 token 校验(旧扩展 hello 带的 token 字段直接忽略)
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
        // P003 修复:chunk 按 seg 段号分组、逐段落盘。
        // (v0.3.0 之前把多段 base64 直连成一个文件 → 损坏,读图方只能解出第一段,
        //  即用户实测「Agent 长图丢了一大截」的真实原因。)
        p.chunks.set(m.seq, { seg: m.seg | 0, b64: m.b64 });
        if (!m.last) return;
        clearTimeout(p.timer); pending.delete(m.id);
        const groups = new Map(); // seg → b64(按 seq 升序拼接)
        for (const [, c] of [...p.chunks.entries()].sort((a, b) => a[0] - b[0])) {
          groups.set(c.seg, (groups.get(c.seg) || '') + c.b64);
        }
        const segIds = [...groups.keys()].sort((a, b) => a - b);
        const N = segIds.length;
        const baseName = safeName(p.meta.name);
        const dot = baseName.lastIndexOf('.');
        const paths = [];
        let totalBytes = 0;
        try {
          for (let i = 0; i < N; i++) {
            const buf = Buffer.from(groups.get(segIds[i]), 'base64');
            totalBytes += buf.length;
            const nm = N === 1 ? baseName
              : (dot > 0 ? baseName.slice(0, dot) + `_part${i + 1}of${N}` + baseName.slice(dot)
                         : baseName + `_part${i + 1}of${N}`);
            const file = uniquePath(outDir, nm);
            fs.writeFileSync(file, buf);
            paths.push(file);
          }
        } catch (e) {
          return json(p.res, 500, { ok: false, error: 'WRITE_FAILED', message: '写盘失败:' + (e.message || e) });
        }
        json(p.res, 200, {
          ok: true,
          image: {
            path: paths[0], paths, parts: N,
            sizeBytes: totalBytes,
            widthPx: p.meta.widthPx || null,
            heightPx: N === 1 ? (p.meta.heightPx || null) : null, // 多段时单文件高度不等于整图高,不谎报
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
    // v0.5.0 端口自扫:从 p||port 起试 PORT_SCAN 个,占用换下一个(EADDRINUSE 不再需要用户处理)
    async listen(p) {
      const start = p || port;
      let lastErr = null;
      for (let cand = start; cand < start + PORT_SCAN; cand++) {
        try {
          await new Promise((resolve, reject) => {
            httpServer.once('error', reject);
            httpServer.listen(cand, '127.0.0.1', () => {
              httpServer.removeListener('error', reject);
              resolve();
            });
          });
          return httpServer.address().port;
        } catch (e) {
          lastErr = e;
          if (!e || e.code !== 'EADDRINUSE') throw e;
        }
      }
      throw (lastErr && lastErr.code === 'EADDRINUSE')
        ? new Error(`端口 ${start}–${start + PORT_SCAN - 1} 全部被占用`)
        : lastErr;
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
  }
  return out;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  const cfg = loadOrCreateConfig(cli);
  const relay = startRelay({ port: cfg.port, outDir: cfg.out });
  const port = await relay.listen().catch((e) => {
    console.error('[ClipShot 桥] 启动失败:' + e.message);
    process.exit(1);
  });
  console.log('┌─────────────────────────────────────────────────────');
  console.log('│ ClipShot Agent 桥 v' + RELAY_VERSION + ' 已启动(零配置)');
  console.log('│ 地址        http://127.0.0.1:' + port);
  console.log('│ 截图输出    ' + cfg.out);
  console.log('│ 配置存于    ' + cfg.file);
  console.log('│ 扩展侧只需:设置页勾选「启用 Agent 桥接」(端口自动发现)');
  console.log('│ 用法与排错  docs/新机器部署指南.md');
  console.log('└─────────────────────────────────────────────────────');
  setInterval(async () => {
    try {
      const r = await fetch('http://127.0.0.1:' + port + '/v1/health');
      const j = await r.json();
      const mark = j.extension && j.extension.connected ? '● 扩展已连接' : '○ 等待扩展连接(设置页勾选启用)';
      process.stdout.write('\r' + mark + '  ' + new Date().toLocaleTimeString() + '   ');
    } catch (e) { /* ignore */ }
  }, 5000).unref();
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
