#!/usr/bin/env node
/**
 * zzz-od-mcp.mjs — 绝区零「一条龙」MCP stdio 服务器（dsh-game-daily 自带）
 *
 * 设计：不碰游戏进程，不截图不点鼠标；所有动作都转发给本机
 *       ZenlessZoneZero-OneDragon 后端的 HTTP 接口（默认 http://127.0.0.1:23001）。
 *       这样智能体只做「判断与调度」，画面识别交给一条龙自己的识别器。
 *
 * 传输：stdio，换行分隔 JSON-RPC 2.0（MCP 规范），零第三方依赖（Node ≥18）。
 * 注册：dsh-game-daily 的 headless overlay 里 serverName=zzz-od
 *       → 工具名形如 mcp__zzz-od__zzz_run_one_dragon
 *
 * 环境变量（都可省略）：
 *   ZZZ_OD_ROOT  一条龙安装根，默认 E:\software\ZenlessZoneZero-OneDragon
 *   ZZZ_OD_URL   后端地址，默认 http://127.0.0.1:23001
 *   ZZZ_OD_SCRIPT_DIR  zzz-server.ps1 所在目录（默认插件根/automation）
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..', '..');
const ROOT = process.env.ZZZ_OD_ROOT || 'D:\\software\\ZenlessZoneZero-OneDragon';
const BASE = (process.env.ZZZ_OD_URL || 'http://127.0.0.1:23001').replace(/\/+$/, '');
const SCRIPT_DIR = process.env.ZZZ_OD_SCRIPT_DIR || path.join(PLUGIN_ROOT, 'automation');
const SERVER_SCRIPT = path.join(SCRIPT_DIR, 'zzz-server.ps1');
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

const SERVER_INFO = { name: 'zzz-od-mcp', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';
/** 单次调用必须远小于 MCP 客户端超时（约 60s），长任务一律「发起 → 轮询」。 */
const MAX_WAIT_SECONDS = 50;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => process.stderr.write(`[zzz-od-mcp] ${a.map(String).join(' ')}\n`);

function clampWait(v, def = 0) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(Math.floor(n), MAX_WAIT_SECONDS);
}

async function request(method, urlPath, body, timeoutMs = 60000) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${urlPath}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 2000) };
  }
  return { status: res.status, ok: res.ok, data };
}

const get = (p, t) => request('GET', p, undefined, t);
const post = (p, body = {}, t) => request('POST', p, body, t);

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}
const bad = (message) => ({ content: [{ type: 'text', text: `错误：${message}` }], isError: true });

async function waitIdle({ timeoutSeconds = 30, pollSeconds = 2 } = {}) {
  const deadline = Date.now() + clampWait(timeoutSeconds, 30) * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const s = await get('/game/status');
    last = s.data;
    const running = s.data && s.data.running === true;
    if (!running) return { ok: true, status: s.data };
    await sleep(Math.max(1000, Number(pollSeconds) || 2) * 1000);
  }
  return { ok: false, timedOut: true, status: last };
}

// ─────────────────────────── 工具定义 ───────────────────────────
const TOOLS = [
  {
    name: 'zzz_health',
    description: '检查绝区零一条龙后端是否可用（GET /health）。任何动作前先调它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'zzz_status',
    description: '当前运行状态（GET /game/status）：是否在跑、跑的是哪个应用/操作。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'zzz_window',
    description: '游戏窗口状态（GET /game/window）：标题、坐标、尺寸、是否前台。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'zzz_applications',
    description: '列出一条龙的日常应用与启用状态（GET /game/applications）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'zzz_operations',
    description: '列出可单独运行的操作（GET /game/operations），例如「打开并登录游戏」。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'zzz_enter',
    description: '打开并登录游戏（POST /game/enter）。block=false 时只发起，之后用 zzz_wait 等待。',
    inputSchema: {
      type: 'object',
      properties: {
        block: { type: 'boolean', description: 'true=等到窗口就绪（受 timeout_seconds 限制）' },
        timeout_seconds: { type: 'number', description: '最多等多久（≤50）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'zzz_run_one_dragon',
    description: '按一条龙配置执行全部日常应用（POST /game/run/one-dragon）。默认异步，之后用 zzz_wait 轮询。',
    inputSchema: {
      type: 'object',
      properties: {
        block: { type: 'boolean', description: 'true=单次调用内等到结束（≤50 秒，通常不够）' },
        timeout_seconds: { type: 'number' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'zzz_run_app',
    description: '只跑某个日常应用（POST /game/run/standalone），app_id 来自 zzz_applications。',
    inputSchema: {
      type: 'object',
      properties: { app_id: { type: 'string' }, block: { type: 'boolean' }, timeout_seconds: { type: 'number' } },
      required: ['app_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'zzz_wait',
    description: '轮询 /game/status 直到空闲（或超时）。每轮最多 50 秒，循环调用直到结束。',
    inputSchema: {
      type: 'object',
      properties: { timeout_seconds: { type: 'number' }, poll_seconds: { type: 'number' } },
      additionalProperties: false,
    },
  },
  {
    name: 'zzz_stop',
    description: '停止当前一条龙/应用运行（POST /game/stop）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'zzz_close_game',
    description: '关闭绝区零游戏（POST /game/close）。日常跑完后用，释放内存。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'zzz_server',
    description: '管理一条龙后端进程：status 只查；start 需要时弹一次 UAC 启动；stop 终止。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['status', 'start', 'stop'] },
        timeout_seconds: { type: 'number', description: '等待后端就绪/退出的秒数（≤50）' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
];

function runServerScript(action, timeoutSeconds) {
  return new Promise((resolve) => {
    if (!existsSync(SERVER_SCRIPT)) {
      resolve({ ok: false, error: `找不到后端管理脚本：${SERVER_SCRIPT}` });
      return;
    }
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      SERVER_SCRIPT,
      '-Action',
      action,
      '-Root',
      ROOT,
      '-WaitSeconds',
      String(clampWait(timeoutSeconds, 40)),
    ];
    const child = spawn(PS, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => {
      const text = out.trim();
      let data = null;
      const i = text.lastIndexOf('{');
      if (i >= 0) {
        try {
          data = JSON.parse(text.slice(i));
        } catch {
          data = null;
        }
      }
      resolve(data || { ok: code === 0, code, stdout: text.slice(-2000), stderr: err.slice(-2000) });
    });
    child.on('error', (e) => resolve({ ok: false, error: String(e && e.message ? e.message : e) }));
  });
}

// ─────────────────────────── 处理器 ───────────────────────────
const HANDLERS = {
  async zzz_health() {
    const r = await get('/health', 15000);
    return textResult({ ok: r.ok, status: r.status, data: r.data });
  },
  async zzz_status() {
    return textResult((await get('/game/status')).data);
  },
  async zzz_window() {
    return textResult((await get('/game/window')).data);
  },
  async zzz_applications() {
    const r = await get('/game/applications');
    const list = Array.isArray(r.data) ? r.data : r.data && Array.isArray(r.data.applications) ? r.data.applications : null;
    if (!list) return textResult(r.data);
    return textResult(
      list.map((a) => ({
        app_id: a.app_id || a.id,
        name: a.app_name || a.name || a.title,
        enabled: a.enabled,
        status: a.status,
      })),
    );
  },
  async zzz_operations() {
    const r = await get('/game/operations');
    const list = Array.isArray(r.data) ? r.data : r.data && Array.isArray(r.data.operations) ? r.data.operations : null;
    if (!list) return textResult(r.data);
    return textResult(list.map((o) => ({ op_id: o.op_id || o.id, name: o.name || o.title })));
  },
  async zzz_enter(args) {
    const block = args.block !== false;
    const r = await post('/game/enter', { block }, 45000);
    if (!r.ok || (r.data && r.data.started === false)) return textResult(r.data || r);
    if (!block) return textResult(r.data);
    const idle = await waitIdle({ timeoutSeconds: clampWait(args.timeout_seconds, 40) - 5, pollSeconds: 2 });
    const w = await get('/game/window');
    return textResult({ enter: r.data, idle: idle.status, window: w.data });
  },
  async zzz_run_one_dragon(args) {
    const block = args.block === true;
    const r = await post('/game/run/one-dragon', { block }, block ? 50000 : 20000);
    if (!r.ok) return textResult({ status: r.status, data: r.data });
    if (!block) return textResult(r.data);
    const idle = await waitIdle({ timeoutSeconds: clampWait(args.timeout_seconds, 40), pollSeconds: 2 });
    return textResult({ started: r.data, idle: idle.status, timedOut: idle.timedOut === true });
  },
  async zzz_run_app(args) {
    const block = args.block === true;
    const r = await post('/game/run/standalone', { app_id: args.app_id, block }, block ? 50000 : 20000);
    if (!r.ok) return textResult({ status: r.status, data: r.data });
    if (!block) return textResult(r.data);
    const idle = await waitIdle({ timeoutSeconds: clampWait(args.timeout_seconds, 40), pollSeconds: 2 });
    return textResult({ started: r.data, idle: idle.status, timedOut: idle.timedOut === true });
  },
  async zzz_wait(args) {
    const idle = await waitIdle({ timeoutSeconds: clampWait(args.timeout_seconds, 40), pollSeconds: args.poll_seconds || 2 });
    return textResult(idle);
  },
  async zzz_stop() {
    const r = await post('/game/stop', {}, 20000);
    return textResult({ status: r.status, data: r.data });
  },
  async zzz_close_game() {
    const r = await post('/game/close', {}, 20000);
    return textResult({ status: r.status, data: r.data });
  },
  async zzz_server(args) {
    const action = args.action || 'status';
    const health = await get('/health', 5000).catch(() => null);
    const reachable = Boolean(health && health.ok);
    if (action === 'status') return textResult({ reachable, url: BASE, root: ROOT, health: health ? health.data : null });
    const result = await runServerScript(action, args.timeout_seconds);
    const after = action === 'stop' ? null : await get('/health', 5000).catch(() => null);
    return textResult({ reachable, action, result, after: after ? after.data : null });
  },
};

// ─────────────────────────── MCP 传输 ───────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}
function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  if (method === 'initialize') {
    sendResult(id, {
      protocolVersion: (params && params.protocolVersion) || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') return sendResult(id, {});
  if (method === 'tools/list') return sendResult(id, { tools: TOOLS });
  if (method === 'resources/list') return sendResult(id, { resources: [] });
  if (method === 'resources/templates/list') return sendResult(id, { resourceTemplates: [] });
  if (method === 'prompts/list') return sendResult(id, { prompts: [] });
  if (method === 'logging/setLevel') return sendResult(id, {});
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const fn = HANDLERS[name];
    if (!fn) return sendError(id, -32602, `未知工具：${name}`);
    try {
      sendResult(id, await fn(args));
    } catch (e) {
      log('tool error', name, e && e.stack ? e.stack : String(e));
      sendResult(id, bad(`工具 ${name} 执行异常：${e && e.message ? e.message : String(e)}`));
    }
    return;
  }
  if (isNotification) return;
  sendError(id, -32601, `未实现的方法：${method}`);
}

let buffer = '';
let pending = 0;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      log('无法解析输入行：', line.slice(0, 200));
      continue;
    }
    pending += 1;
    handle(msg)
      .catch((e) => log('handle error', String(e)))
      .finally(() => {
        pending -= 1;
      });
  }
});
process.stdin.on('end', async () => {
  // 用文件/管道喂输入时，stdin 会在应答发完之前就 EOF；等未完成的调用收尾再退出。
  const deadline = Date.now() + 15000;
  while (pending > 0 && Date.now() < deadline) await sleep(50);
  process.exit(0);
});
log(`已启动：root=${ROOT} url=${BASE} tools=${TOOLS.length}`);
