#!/usr/bin/env node
'use strict';
/**
 * ClipShot MCP 服务器(P002,零依赖 Node ≥18)。
 * - 内嵌 relay(复用 relay.mjs 的 startRelay):宿主(Cursor/Claude Code…)spawn 本进程
 *   即自动获得 HTTP+WS 桥,无需手动常驻终端;端口被占时自动降级为「纯客户端」,
 *   经 HTTP 调已存在的 relay(token 读自配置),多宿主共存不打架。
 * - MCP stdio 传输:换行分隔的 JSON-RPC 2.0;stdout 只走协议,日志一律 stderr。
 * - 工具(克制三件套,仅回文件路径不内联图片——用户决策):
 *   clipshot_screenshot / clipshot_health / clipshot_tabs
 * - 一键安装:node bridge/mcp.mjs --install [--dry-run]
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { startRelay, loadOrCreateConfig, RELAY_VERSION } from './relay.mjs';

const MCP_PATH = fileURLToPath(import.meta.url);
const PROTOCOL_VERSION_FALLBACK = '2024-11-05';
const log = (...a) => console.error('[clipshot-mcp]', ...a);

/* ================= 工具面定义 ================= */

const TOOLS = [
  {
    name: 'clipshot_screenshot',
    description: '用 ClipShot 浏览器扩展截取网页。mode=full 整页滚动长截图(默认推荐,自动滚动触发懒加载,能拍到滚动区域外的全部内容);visible 仅当前一屏;element 按 CSS 选择器截单个元素(需 selector)。返回文本:图片落盘路径+尺寸等元信息(不内联图片,需要看图时直接读返回的文件路径)。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['full', 'visible', 'element'], description: '截图模式,默认 full' },
        selector: { type: 'string', description: 'mode=element 时必填:CSS 选择器,如 "#article" 或 ".doc-content"' },
        target: {
          description: '目标标签页:"active"(默认,当前活动页)、数字 tabId、或 {"urlContains":"关键字"} 按网址匹配',
          anyOf: [
            { type: 'string' },
            { type: 'integer' },
            { type: 'object', properties: { urlContains: { type: 'string' } }, required: ['urlContains'] }
          ]
        },
        format: { type: 'string', enum: ['png', 'jpeg'], description: '图片格式,默认 png;超长页可用 jpeg 减小体积' },
        hideFixed: { type: 'boolean', description: '是否隐藏 sticky 顶栏/悬浮窗等固定元素(默认沿用扩展设置)' }
      },
      required: ['mode']
    }
  },
  {
    name: 'clipshot_health',
    description: '查询 ClipShot 桥状态:relay 是否在跑、浏览器扩展是否已连接、版本与截图输出目录。调用截图工具前可先用它确认链路。',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'clipshot_tabs',
    description: '列出当前浏览器中可截图的标签页(tabId/网址/标题/是否活动),用于选择截图目标。',
    inputSchema: { type: 'object', properties: {} }
  }
];

/* ================= relay 后端(自嵌或客户端降级) ================= */

async function setupBackend(cli) {
  const cfg = loadOrCreateConfig({ port: cli.port });
  const base = `http://127.0.0.1:${cfg.port}`;
  try {
    const relay = startRelay({ port: cfg.port, token: cfg.token, outDir: cfg.out });
    await relay.listen(cfg.port);
    log(`relay 已内嵌启动: ${base}(输出目录 ${cfg.out})`);
    return { mode: 'relay', base, token: cfg.token, outDir: cfg.out, cfg, relay };
  } catch (e) {
    if (e && e.code !== 'EADDRINUSE') throw e;
    // 端口被占:可能是手动 relay 或另一宿主的 mcp → 探测后降级为客户端
    try {
      const r = await fetch(base + '/v1/health', { signal: AbortSignal.timeout(3000) });
      const j = await r.json();
      if (j && j.ok) {
        log(`端口 ${cfg.port} 已有 relay 在跑(版本 ${j.relay && j.relay.version}),本进程降级为客户端模式`);
        return { mode: 'client', base, token: cfg.token, outDir: cfg.out, cfg, relay: null };
      }
    } catch (e2) { /* 探测失败,落到下面报错 */ }
    throw new Error(`端口 ${cfg.port} 被占用,且不是一个 ClipShot relay。请关闭占用进程或 --port 换端口`);
  }
}

async function api(backend, urlPath, { method = 'GET', body, timeoutMs = 250000 } = {}) {
  const res = await fetch(backend.base + urlPath, {
    method,
    headers: { 'content-type': 'application/json', 'x-clipshot-token': backend.token },
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  });
  return res.json();
}

function fmtBytes(b) {
  if (b == null) return '?';
  return b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.round(b / 1024) + ' KB';
}

async function callTool(backend, name, args) {
  if (name === 'clipshot_health') {
    const j = await api(backend, '/v1/health', { timeoutMs: 8000 });
    const ext = j.extension || {};
    const lines = [
      j.ok ? 'ClipShot 桥正常 ✔' : 'ClipShot 桥异常 ✘',
      `relay: v${j.relay && j.relay.version}(本进程:${backend.mode === 'relay' ? '内嵌' : '客户端降级'})`,
      `扩展: ${ext.connected ? '已连接' : '未连接'}${ext.version ? '(扩展版本 ' + ext.version + ')' : ''}`,
      `截图输出目录: ${backend.outDir}`
    ];
    if (!ext.connected) lines.push('提示: 打开 Chrome → ClipShot 设置页启用「Agent 桥接」并核对 token;详见 docs/Agent接入指南.md 排错表');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  if (name === 'clipshot_tabs') {
    const j = await api(backend, '/v1/tabs', { timeoutMs: 10000 });
    if (!j.ok) return toolError(j);
    const lines = (j.tabs || []).map(t => `${t.active ? '→' : ' '} [${t.tabId}] ${t.title}\n    ${t.url}`);
    return { content: [{ type: 'text', text: lines.length ? '可截图标签页:\n' + lines.join('\n') : '(没有可截图的标签页)' }] };
  }
  if (name === 'clipshot_screenshot') {
    const mode = args.mode || 'full';
    const body = { mode };
    if (args.selector != null) body.selector = String(args.selector);
    if (args.target != null) body.target = args.target;
    if (args.format) body.format = args.format;
    if (typeof args.hideFixed === 'boolean') body.hideFixed = args.hideFixed;
    if (mode === 'element' && !body.selector) {
      return { isError: true, content: [{ type: 'text', text: 'mode=element 需要提供 selector(CSS 选择器)' }] };
    }
    const j = await api(backend, '/v1/screenshot', { method: 'POST', body });
    if (!j.ok) return toolError(j);
    const img = j.image || {};
    const lines = ['截图成功 ✔'];
    if (img.parts > 1) {
      lines.push(`整页过长,已分为 ${img.parts} 个分段文件(按序排列即完整长图,请逐个读取):`);
      (img.paths || [img.path]).forEach((p, i) => lines.push(`  ${i + 1}. ${p}`));
    } else {
      lines.push(`文件: ${img.path}`);
    }
    lines.push(
      `规格: ${img.widthPx || '?'}×${img.heightPx || (img.parts > 1 ? '分段' : '?')} px · ` +
      `${img.mime || 'image/png'} · 共 ${fmtBytes(img.sizeBytes)}`
    );
    if (j.notes && j.notes.length) lines.push('备注: ' + j.notes.join(';'));
    lines.push('需要查看内容时,直接用你的读图能力打开上面的文件路径。');
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
  return { isError: true, content: [{ type: 'text', text: '未知工具: ' + name }] };
}

function toolError(j) {
  return {
    isError: true,
    content: [{ type: 'text', text: `截图失败 [${j.error || 'UNKNOWN'}] ${j.message || ''}`.trim() }]
  };
}

/* ================= MCP stdio(JSON-RPC 2.0,换行分隔) ================= */

function runMcp(backend) {
  const send = (msg) => { process.stdout.write(JSON.stringify(msg) + '\n'); };
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const replyErr = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    line = line.trim();
    if (!line) return;
    let m;
    try { m = JSON.parse(line); } catch (e) { log('收到非法 JSON,已忽略'); return; }
    const { id, method, params } = m;
    try {
      switch (method) {
        case 'initialize':
          reply(id, {
            protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION_FALLBACK,
            capabilities: { tools: {} },
            serverInfo: { name: 'clipshot', version: RELAY_VERSION }
          });
          break;
        case 'notifications/initialized':
        case 'initialized':
          break; // 通知,无需响应
        case 'ping':
          reply(id, {});
          break;
        case 'tools/list':
          reply(id, { tools: TOOLS });
          break;
        case 'tools/call': {
          const name = params && params.name;
          const args = (params && params.arguments) || {};
          try {
            reply(id, await callTool(backend, name, args));
          } catch (e) {
            reply(id, { isError: true, content: [{ type: 'text', text: '调用异常: ' + ((e && e.message) || e) }] });
          }
          break;
        }
        default:
          if (id != null) replyErr(id, -32601, '不支持的方法: ' + method);
      }
    } catch (e) {
      log('处理消息出错:', e && e.stack || e);
      if (id != null) replyErr(id, -32603, String((e && e.message) || e));
    }
  });
  rl.on('close', () => { log('stdin 关闭,退出'); shutdown(backend, 0); });
  process.on('SIGTERM', () => shutdown(backend, 0));
  process.on('SIGINT', () => shutdown(backend, 0));
}

function shutdown(backend, code) {
  try { if (backend.relay) backend.relay.close(); } catch (e) { /* noop */ }
  process.exit(code);
}

/* ================= --install 一键安装 ================= */

function cursorConfigPath() { return path.join(os.homedir(), '.cursor', 'mcp.json'); }

function install(cli) {
  const nodeBin = process.execPath;
  const dry = !!cli.dryRun;
  const say = (s) => process.stdout.write(s + '\n');
  say('ClipShot MCP 一键安装' + (dry ? '(--dry-run 只打印不落盘)' : ''));
  say(`  mcp 路径: ${MCP_PATH}`);
  say(`  node 路径: ${nodeBin}\n`);

  // 1) Claude Code:官方 CLI,幂等(测试环境用 CLIPSHOT_SKIP_CLAUDE 跳过,防真实改写用户配置)
  const claude = process.env.CLIPSHOT_SKIP_CLAUDE
    ? { status: -1 }
    : spawnSync('claude', ['--version'], { encoding: 'utf8', timeout: 8000 });
  if (claude.status === 0) {
    say('① 检测到 Claude Code CLI:');
    const cmds = [['mcp', 'remove', 'clipshot'], ['mcp', 'add', 'clipshot', '--', nodeBin, MCP_PATH]];
    for (const c of cmds) {
      say('   $ claude ' + c.join(' '));
      if (!dry) {
        const r = spawnSync('claude', c, { encoding: 'utf8', timeout: 15000 });
        if (c[1] === 'add' && r.status !== 0) say('   ⚠ 执行失败: ' + (r.stderr || r.stdout || '').trim().slice(0, 200));
      }
    }
    if (!dry) say('   ✔ 已注册(重启 Claude Code 生效)');
  } else {
    say('① 未检测到 Claude Code CLI,跳过(装好后执行: claude mcp add clipshot -- ' + nodeBin + ' ' + MCP_PATH + ')');
  }

  // 2) Cursor:合并写 ~/.cursor/mcp.json,先备份 .bak
  const cpath = cursorConfigPath();
  const hasCursor = fs.existsSync(path.join(os.homedir(), '.cursor'));
  say(`\n② Cursor 配置(${cpath}):`);
  const snippet = { command: nodeBin, args: [MCP_PATH] };
  if (hasCursor || dry) {
    if (dry) {
      say('   [dry-run] 将合并写入 mcpServers.clipshot = ' + JSON.stringify(snippet));
    } else {
      let cfg = {};
      if (fs.existsSync(cpath)) {
        const raw = fs.readFileSync(cpath, 'utf8');
        if (raw.trim() === '') {
          // Cursor 打开过 MCP 设置界面会创建空文件:视为「无已有配置」,正常写入
          say('   (检测到空文件,视为无已有配置)');
        } else {
          try { cfg = JSON.parse(raw); }
          catch (e) {
            fs.copyFileSync(cpath, cpath + '.bak');
            say('   ⚠ 现有配置不是合法 JSON(已备份为 .bak,但为安全不改写;修复后重跑 --install):' + e.message);
            cfg = null;
          }
        }
        if (cfg) fs.copyFileSync(cpath, cpath + '.bak');
      } else {
        fs.mkdirSync(path.dirname(cpath), { recursive: true });
      }
      if (cfg) {
        cfg.mcpServers = Object.assign({}, cfg.mcpServers, { clipshot: snippet });
        fs.writeFileSync(cpath, JSON.stringify(cfg, null, 2));
        say('   ✔ 已合并写入(原文件已备份为 .bak;重启 Cursor 生效)');
      }
    }
  } else {
    say('   未检测到 ~/.cursor,跳过');
  }

  // 3) Codex 与其他宿主:打印片段
  say('\n③ Codex CLI(~/.codex/config.toml)如使用请粘贴:');
  say('   [mcp_servers.clipshot]');
  say('   command = "' + nodeBin + '"');
  say('   args = ["' + MCP_PATH + '"]');
  say('\n④ 其他支持 MCP 的产品(豆包工作/WorkBuddy 等),通用 JSON 片段:');
  say('   {"mcpServers":{"clipshot":{"command":"' + nodeBin + '","args":["' + MCP_PATH + '"]}}}');
  say('   (不支持 MCP 的产品继续用 curl 通路,见 docs/Agent接入指南.md 第 4 步)');

  if (dry) { say('\n[dry-run] 完成,未做任何写入。'); return; }

  // 5) 自检:spawn 一个子进程走 initialize → tools/list → health
  say('\n⑤ 自检中…');
  const child = spawn(nodeBin, [MCP_PATH, '--port', String(cli.port || 8790)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buf = '';
  const timer = setTimeout(() => { child.kill(); say('   ⚠ 自检超时(15s)——不影响使用,可手动在 Agent 里试'); process.exit(0); }, 15000);
  child.stdout.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split('\n'); buf = lines.pop();
    for (const l of lines) {
      let m; try { m = JSON.parse(l); } catch (e) { continue; }
      if (m.id === 1 && m.result && m.result.serverInfo) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
      }
      if (m.id === 2 && m.result && Array.isArray(m.result.tools)) {
        clearTimeout(timer);
        say(`   ✔ 自检通过:serverInfo=clipshot v${RELAY_VERSION},工具 ${m.result.tools.length} 个`);
        child.kill();
        say('\n安装完成。重启你的 Agent(Cursor/Claude Code),在对话里说「把当前页面整页截下来」即可。');
        say('若提示扩展未连接:打开 Chrome → ClipShot 设置页 → 启用「Agent 桥接」并核对 token。');
        process.exit(0);
      }
    }
  });
  child.on('error', (e) => { clearTimeout(timer); say('   ⚠ 自检启动失败: ' + e.message); process.exit(0); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION_FALLBACK, capabilities: {}, clientInfo: { name: 'clipshot-installer', version: '1.0' } } }) + '\n');
}

/* ================= 入口 ================= */

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--port') out.port = Number(argv[++i]) | 0;
    else if (argv[i] === '--install') out.install = true;
    else if (argv[i] === '--dry-run') out.dryRun = true;
  }
  return out;
}

async function main() {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.install) { install(cli); return; }
  const backend = await setupBackend(cli);
  runMcp(backend);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main().catch((e) => { log('启动失败:', (e && e.stack) || e); process.exit(1); });
