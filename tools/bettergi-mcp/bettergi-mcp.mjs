#!/usr/bin/env node
/**
 * bettergi-mcp.mjs — BetterGI 的 MCP stdio 服务器
 *
 * 目标：让 agent 在对话里直接指挥本机 BetterGI，例如「帮我采集星螺」。
 * 设计：**不重复造轮子**——所有本机操作都转发给已验证的 skill 脚本
 *       （`~/.agents/skills/bettergi-control/scripts/*.ps1`，可用 BETTERGI_SKILL_DIR 覆盖），
 *       MCP 层只负责：参数校验、结构化返回、以及"官方路线仓库"的检索与下载。
 *
 * 传输：stdio，换行分隔的 JSON-RPC 2.0（MCP 规范），零第三方依赖（Node ≥18，本机 v24）。
 * 注册：~/.dsh/profiles/web/cordis.patch.yml 的 insert 段，serverName=bettergi
 *       → 工具名形如 mcp__bettergi__bgi_collect_material
 *
 * 环境变量（都可省略）：
 *   BETTERGI_ROOT      BetterGI 安装根，默认 D:\software\BetterGI
 *   BETTERGI_SKILL_DIR bettergi-control skill 的 scripts 目录
 *   BETTERGI_REPO_RAW  官方路线仓库 raw 前缀（默认 GitHub；CNB 在本机 DNS 失败）
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { evaluateRunGate, statusForGate } from './run-gate.mjs';

// ─────────────────────────── 常量与路径 ───────────────────────────
const BGI_ROOT = process.env.BETTERGI_ROOT || 'D:\\software\\BetterGI';
const SKILL_DIR =
  process.env.BETTERGI_SKILL_DIR || path.join(homedir(), '.agents', 'skills', 'bettergi-control', 'scripts');
const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const BOOTSTRAP = path.join(HERE, 'run-utf8.ps1');
const CACHE_DIR = path.join(HERE, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'repo.json');
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const REPO_RAW = process.env.BETTERGI_REPO_RAW || 'https://raw.githubusercontent.com/babalae/bettergi-scripts-list/refs/heads/main/';
const REPO_INDEX_URLS = [
  REPO_RAW + 'repo.json',
  'https://r2-script.bettergi.com/github_mirror/repo.json',
];
/** 仓库文件清单（git trees API，一次拿到全仓文件路径；repo.json 索引里 js/ 只有目录没有文件） */
const REPO_TREE_URL = 'https://api.github.com/repos/babalae/bettergi-scripts-list/git/trees/main?recursive=1';
const TREE_CACHE_FILE = path.join(CACHE_DIR, 'tree.json');
/** 官方仓库顶层目录 → 本机落地目录（源码 ScriptRepoUpdater.PathMapper） */
const REPO_MAP = {
  pathing: path.join(BGI_ROOT, 'User', 'AutoPathing'),
  js: path.join(BGI_ROOT, 'User', 'JsScript'),
  combat: path.join(BGI_ROOT, 'User', 'AutoFight'),
  tcg: path.join(BGI_ROOT, 'User', 'AutoGeniusInvokation'),
};

const SERVER_INFO = { name: 'bettergi-mcp', version: '1.0.0' };
const PROTOCOL_VERSION = '2024-11-05';
let payloadSeq = 0;

/**
 * 单次工具调用必须远小于 MCP 客户端的请求超时（本机约 60 秒），
 * 否则长任务会把整个调用掐断。所有"会等"的参数都按这个上限夹取，
 * 真长任务一律走"发起 → 轮询 bgi_watch"的模式。
 */
const MAX_WAIT_SECONDS = 50;
const clampWait = (v, def = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return def;
  return Math.min(Math.floor(n), MAX_WAIT_SECONDS);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 从混合输出里抠出第一个完整 JSON 对象（脚本会先打人读提示，再打 JSON） */
function extractJson(text) {
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

/** 读一次状态，供其它工具做前置检查（失败返回 null，不打断主流程） */
async function statusBrief() {
  const r = await callScript('bgi-status.ps1', ['-Json'], 60000);
  if (r.code !== 0) return null;
  return extractJson(r.stdout);
}

function preflightLines(st) {
  const out = [];
  if (!st) return out;
  if (st.bgiRunning) {
    out.push('⛔ BetterGI 正在运行：命令行触发会被单实例吞掉（只转发不执行）——请先退出 BetterGI，或用包装器 _daily_runner.ps1。');
  }
  for (const b of st.blockers || []) {
    if (!/BetterGI 正在运行/.test(b)) out.push(`⛔ ${b}`);
  }
  const gw = st.gameWindow;
  if (gw && !gw.foreground) {
    out.push(`⚠ 原神不在前台（当前前台窗口：${gw.foregroundTitle}）→ 自动化会立刻暂停在第一帧；先调 bgi_focus_game，或手动点一下游戏窗口。`);
  }
  for (const w of st.warnings || []) out.push(`⚠ ${w}`);
  if (out.some((l) => l.startsWith('⛔')) || (gw && !gw.readyForTask)) {
    out.push('ℹ 窗口类问题可先试 bgi_focus_game（还原最小化 + 尝试置前）；分辨率不足需在游戏内改（或关游戏后用注册表法）。');
  }
  return out;
}

// ─────────────────────────── 基础工具 ───────────────────────────
const log = (...a) => process.stderr.write('[bettergi-mcp] ' + a.join(' ') + '\n');

function callScript(scriptName, args = [], timeoutMs = 60000) {
  return new Promise((resolve) => {
    const scriptPath = path.join(SKILL_DIR, scriptName);
    if (!existsSync(scriptPath)) {
      resolve({ code: -2, stdout: '', stderr: `找不到脚本：${scriptPath}` });
      return;
    }
    // 参数经 JSON 载荷传递：子 PowerShell 里 `& $script @array` 只会按位置绑定，
    // 必须让启动器读载荷后按参数名建哈希表再 splat（见 run-utf8.ps1 顶部注释）。
    const payloadPath = path.join(tmpdir(), `bgi-mcp-${process.pid}-${++payloadSeq}.json`);
    try {
      writeFileSync(payloadPath, JSON.stringify({ script: scriptPath, args }), 'utf8');
    } catch (e) {
      resolve({ code: -3, stdout: '', stderr: `无法写入调用载荷：${e.message}` });
      return;
    }
    const cp = spawn(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BOOTSTRAP, payloadPath],
      { windowsHide: true },
    );
    let out = Buffer.alloc(0);
    let err = Buffer.alloc(0);
    let settled = false;
    const cleanup = () => { try { rmSync(payloadPath, { force: true }); } catch { /* ignore */ } };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { cp.kill(); } catch { /* ignore */ }
      cleanup();
      resolve({ code: -9, stdout: out.toString('utf8'), stderr: err.toString('utf8') + `\n[超时 ${timeoutMs}ms]` });
    }, timeoutMs);
    cp.stdout.on('data', (d) => { out = Buffer.concat([out, d]); });
    cp.stderr.on('data', (d) => { err = Buffer.concat([err, d]); });
    cp.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({ code: -1, stdout: '', stderr: String(e && e.message ? e.message : e) });
    });
    cp.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      resolve({ code, stdout: out.toString('utf8'), stderr: err.toString('utf8') });
    });
  });
}

function readJsonFile(p) {
  try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function writeJsonFile(p, obj) {
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
}

async function httpText(url, timeoutMs = 120000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ac.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ─────────────────────── 官方路线仓库：索引与下载 ───────────────────────
async function getRepoIndex({ force = false } = {}) {
  if (!force && existsSync(CACHE_FILE)) {
    const age = Date.now() - statSync(CACHE_FILE).mtimeMs;
    if (age < CACHE_TTL_MS) {
      const cached = readJsonFile(CACHE_FILE);
      if (cached) return { index: cached, cached: true, ageMinutes: Math.round(age / 60000) };
    }
  }
  let lastErr = null;
  for (const u of REPO_INDEX_URLS) {
    try {
      const text = await httpText(u, 180000);
      const json = JSON.parse(text);
      writeJsonFile(CACHE_FILE, json);
      return { index: json, cached: false, source: u };
    } catch (e) { lastErr = e; }
  }
  const stale = readJsonFile(CACHE_FILE);
  if (stale) return { index: stale, cached: true, stale: true, error: String(lastErr) };
  throw new Error(`拉取官方仓库索引失败：${lastErr}`);
}

/**
 * 仓库文件清单：git trees API 一次拿到全仓路径。
 * 为什么需要：repo.json 索引里 `js/` 只列了目录、**没有文件**（实测 0 个 file 条目），
 * 而安装一个 JS 脚本必须知道它有哪些文件（manifest.json / main.js / 资源）。
 */
async function getRepoTree({ force = false } = {}) {
  if (!force && existsSync(TREE_CACHE_FILE)) {
    const age = Date.now() - statSync(TREE_CACHE_FILE).mtimeMs;
    if (age < CACHE_TTL_MS) {
      const cached = readJsonFile(TREE_CACHE_FILE);
      if (cached && Array.isArray(cached.tree)) return { tree: cached.tree, cached: true, ageMinutes: Math.round(age / 60000) };
    }
  }
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 180000);
  try {
    const res = await fetch(REPO_TREE_URL, {
      headers: { 'User-Agent': 'bettergi-mcp', Accept: 'application/vnd.github+json' },
      signal: ac.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const json = await res.json();
    const tree = (json.tree || []).map((e) => ({ path: e.path, type: e.type, size: e.size || 0 }));
    if (!tree.length) throw new Error('tree 为空');
    writeJsonFile(TREE_CACHE_FILE, { tree, fetchedAt: new Date().toISOString() });
    return { tree, cached: false };
  } finally {
    clearTimeout(t);
  }
}

/** 列出仓库某个目录下的所有文件（相对仓库根的路径） */
function listRepoFiles(tree, prefix) {
  const p = prefix.endsWith('/') ? prefix : prefix + '/';
  return tree.filter((e) => e.type === 'blob' && e.path.startsWith(p)).map((e) => ({ path: e.path, size: e.size }));
}

/** 把仓库里的一个文件夹整体下载到本机目标目录 */
async function installRepoFolder(relFolder, destFolder, { overwrite = false } = {}) {
  const { tree, cached } = await getRepoTree();
  const files = listRepoFiles(tree, relFolder);
  if (!files.length) throw new Error(`仓库里找不到 ${relFolder} 下的文件（或该脚本不存在）`);
  const results = [];
  const prefix = relFolder.endsWith('/') ? relFolder : relFolder + '/';
  for (const f of files) {
    // 去掉仓库前缀：按**字符串前缀**截断，不能按段数/字符数（2026-10-16 踩过）
    const rel = f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path;
    const dest = path.join(destFolder, ...rel.split('/'));
    if (existsSync(dest) && !overwrite) { results.push({ ...f, dest, skipped: true }); continue; }
    mkdirSync(path.dirname(dest), { recursive: true });
    // 一律按二进制写：JS 脚本带 png/ico 资源，走文本会把图片写坏（2026-10-16 真踩到，
    // 15 张识别图全变成 EF BF BD 开头，图样匹配永远失败）
    const res = await fetch(REPO_RAW + encodeRepoPath(f.path), { headers: { 'User-Agent': 'bettergi-mcp/1.0' } });
    if (!res.ok) throw new Error(`下载 ${f.path} 失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    writeFileSync(dest, buf);
    results.push({ ...f, dest, skipped: false, size: buf.length, integrity: checkAssetIntegrity(rel, buf) });
  }
  return { files: results, cached };
}

/** 对落地资产做最轻量的完整性校验：PNG/ICO 看魔数，JSON 看能否解析（返回 '' 表示不适用/通过） */
function checkAssetIntegrity(rel, buf) {
  const lower = rel.toLowerCase();
  if (lower.endsWith('.png')) {
    return (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) ? '' : 'PNG 魔数不对';
  }
  if (lower.endsWith('.ico')) {
    return (buf[0] === 0 && buf[1] === 0 && buf[2] === 1 && buf[3] === 0) ? '' : 'ICO 魔数不对';
  }
  if (lower.endsWith('.json') || lower.endsWith('.json5')) {
    try { JSON.parse(buf.toString('utf8').replace(/^\uFEFF/, '')); return ''; } catch (e) { return `JSON 解析失败：${e.message}`; }
  }
  return '';
}

/** 把 indexes 树摊平成 [{type, name, path}] */
function walkIndex(nodes, prefix = '', out = []) {
  for (const n of nodes || []) {
    if (!n || !n.name) continue;
    const p = prefix ? `${prefix}/${n.name}` : n.name;
    out.push({ type: n.type || 'unknown', name: n.name, path: p });
    if (Array.isArray(n.children)) walkIndex(n.children, p, out);
  }
  return out;
}

function encodeRepoPath(relPath) {
  return relPath.split('/').map(encodeURIComponent).join('/');
}

/** 在官方仓库里找路径文件：主命中＝位于同名目录下，次命中＝文件名含关键词 */
function findRoutes(flat, material) {
  const key = material.trim();
  const pathingFiles = flat.filter((n) => n.type === 'file' && n.path.startsWith('pathing/') && n.name.toLowerCase().endsWith('.json'));
  const primary = pathingFiles.filter((n) => n.path.includes(`/${key}/`));
  const secondary = pathingFiles.filter((n) => !primary.includes(n) && n.name.includes(key));
  // 目录级候选（帮助用户在没命中时发现相近名字）
  const dirs = flat.filter((n) => n.type === 'directory' && n.name.includes(key));
  return { primary, secondary, dirs };
}

const BINARY_EXT = new Set(['.png', '.ico', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.zip', '.7z', '.dll', '.exe', '.onnx', '.bin']);

async function downloadRepoFile(relPath, { overwrite = false } = {}) {
  // 防御性：即便当前只有 pathing/combat/tcg（都是文本），也按扩展名判一次二进制，
  // 避免将来仓库里出现图片等资源时重演"文本下载写坏二进制"（2026-10-16 在 JS 脚本上真踩到）
  const ext = path.extname(relPath).toLowerCase();
  if (BINARY_EXT.has(ext)) return downloadRepoBinary(relPath, { overwrite });
  const top = relPath.split('/')[0];
  const destRoot = REPO_MAP[top];
  if (!destRoot) throw new Error(`未知的仓库顶层目录：${top}`);
  const dest = path.join(destRoot, ...relPath.split('/').slice(1));
  if (existsSync(dest) && !overwrite) return { dest, skipped: true };
  // 索引里的路径是仓库**内**的分区名（pathing/...），而文件实际位于 repo/ 之下（实测 2026-10-16）
  const text = await httpText(REPO_RAW + encodeRepoPath('repo/' + relPath));
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, text, 'utf8');
  return { dest, skipped: false, bytes: Buffer.byteLength(text, 'utf8') };
}

// 二进制安全下载：icon.ico / png 这类附属文件不能走文本路径（会被 UTF-8 解码写坏）
async function downloadRepoBinary(relPath, { overwrite = false } = {}) {
  const top = relPath.split('/')[0];
  const destRoot = REPO_MAP[top];
  if (!destRoot) throw new Error(`未知的仓库顶层目录：${top}`);
  const dest = path.join(destRoot, ...relPath.split('/').slice(1));
  if (existsSync(dest) && !overwrite) return { dest, skipped: true, size: statSync(dest).size };
  const res = await fetch(REPO_RAW + encodeRepoPath('repo/' + relPath), {
    headers: { 'User-Agent': 'bettergi-mcp/1.0' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, buf);
  return { dest, skipped: false, size: buf.length };
}

// ─────────────────────────── 配置组读写 ───────────────────────────
function groupPath(name) {
  return path.join(BGI_ROOT, 'User', 'ScriptGroup', `${name}.json`);
}

function writeGroup(name, projects, { merge = true } = {}) {
  const p = groupPath(name);
  let group = merge ? readJsonFile(p) : null;
  if (!group || !Array.isArray(group.projects)) group = { name, projects: [] };
  const existing = new Set(group.projects.map((x) => `${x.type}|${x.folderName}|${x.name}`));
  for (const it of projects) {
    const k = `${it.type}|${it.folderName}|${it.name}`;
    if (!existing.has(k)) { group.projects.push(it); existing.add(k); }
  }
  writeJsonFile(p, group);
  return { path: p, count: group.projects.length, projects: group.projects };
}

// ─────────────────────────── 工具定义 ───────────────────────────
const TOOLS = [
  {
    name: 'bgi_status',
    description: 'BetterGI 只读状态总览：进程/窗口/关键配置/一条龙配置/最新日志尾部/进度文件。任何操作前先调用它确认状态。',
    inputSchema: { type: 'object', properties: { json: { type: 'boolean', description: '返回机器可读 JSON（默认 true）' } } },
  },
  {
    name: 'bgi_start_game',
    description: '启动原神与 BetterGI 截图器（等价于 BetterGI.exe start），会联动启动游戏并自动进游戏。注意：游戏真正进到可操作状态要 1-2 分钟，超出单次调用上限（本机 MCP 约 60 秒）时会返回「仍在启动中」——这不算失败，随后用 bgi_status 复查即可。',
    inputSchema: {
      type: 'object',
      properties: {
        wait_seconds: { type: 'number', description: '最多等多久找就绪证据（默认 40，上限 50）' },
        dry_run: { type: 'boolean', description: '只打印命令不启动进程（默认 false）' },
      },
    },
  },
  {
    name: 'bgi_run_one_dragon',
    description: '跑「一条龙」日常配置（本机配置名：日常 = 领取邮件→合成树脂→领取每日奖励→自动秘境）。要求 BetterGI 未在运行（单实例会吞掉参数）；干完就返回，成败用 bgi_watch 轮询。',
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'string', description: '一条龙配置名，默认「日常」' },
        wait_seconds: { type: 'number', description: '可选：等待截图器就绪的最长秒数（默认 0=立即返回，上限 50）' },
        dry_run: { type: 'boolean', description: '只打印将执行的命令（默认 false）' },
        force: { type: 'boolean', description: '无视前置阻断强行发起（默认 false；窗口不可用时基本白跑）' },
      },
    },
  },
  {
    name: 'bgi_run_groups',
    description: '按顺序执行一个或多个「配置组」（User\\ScriptGroup\\<名>.json）——采集/锄地/自定义脚本编排都走这里。立即返回；执行过程与成败用 bgi_watch 轮询。',
    inputSchema: {
      type: 'object',
      properties: {
        groups: { type: 'array', items: { type: 'string' }, description: '配置组名列表，按顺序执行' },
        wait_seconds: { type: 'number', description: '可选：等待截图器就绪的最长秒数（默认 0=立即返回，上限 50）' },
        dry_run: { type: 'boolean', description: '只打印命令不启动进程（默认 false）' },
        force: { type: 'boolean', description: '无视前置阻断强行发起（默认 false；窗口不可用时基本白跑）' },
      },
      required: ['groups'],
    },
  },
  {
    name: 'bgi_log_search',
    description: '在当天 BetterGI 日志里定向检索（诊断"为什么失败"的取证工具）：按级别/正则/时间窗/任务关键字过滤，返回带行号、时间戳、类名与消息正文的命中行。比 bgi_status 的日志尾部强得多。',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则（匹配消息正文或类名），如 "未匹配到任何战斗脚本|切换队伍失败"' },
        levels: { type: 'array', items: { type: 'string', enum: ['ERR', 'WRN', 'INF', 'DBG'] }, description: '级别过滤' },
        since_minutes: { type: 'number', description: '只看最近 N 分钟' },
        tail: { type: 'number', description: '最多返回多少条（默认 40）' },
        task: { type: 'string', description: '只看含该关键字的段落，如 自动秘境' },
      },
    },
  },
  {
    name: 'bgi_schedule_info',
    description: '调度与运行一览（只读）：计划任务的触发时间/下次/上次/返回码/RunLevel、包装器日志尾部与今天是否已触发、一条龙配置与任务顺序、每个配置组是否已接进一条龙、最近几次运行的收尾时间。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bgi_run_task_progress',
    description: '从上次中断处**续跑**配置组（等价 BetterGI.exe --TaskProgress <组名|latest>）——采集/长任务被打断后用。要求 BetterGI 未在运行。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '配置组名，或 latest（默认，表示最近一次）' },
        force: { type: 'boolean', description: '无视前置阻断强行续跑（默认 false）' },
      },
    },
  },
  {
    name: 'bgi_js_settings',
    description: '读写官方 JS 脚本的设置（它们**不落盘到脚本目录**，而是存在配置组项目的 jsScriptSettingsObject 里）。不带 set 时列出全部可配置项与当前值；带 set 时先按 settings.json 的 schema 校验（select 必须在 options 内、checkbox 转布尔）再写回配置组并自动备份。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '脚本目录名（= User\\JsScript\\<名>，也是配置组名）' },
        set: { type: 'object', description: '要写入的设置，例：{"adventurePath":"枫丹","notDoublePoints":true}' },
      },
      required: ['name'],
    },
  },
  {
    name: 'bgi_set_onedragon',
    description: '改「一条龙」配置（User\\OneDragon\\<名>.json）：秘境/队伍/每日奖励队伍/合成台地区/冒险家协会地区/收工动作/保留原粹/按星期换秘境/任务顺序与启停。要求 BetterGI 未运行（它会把文件回写覆盖）；自动备份并回显改动前后。dry_run=true 只预览。',
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'string', description: '一条龙配置名，默认「日常」' },
        party_name: { type: 'string', description: '秘境队伍名（= 游戏内队伍名）' },
        domain_name: { type: 'string', description: '秘境名（如 荒坠的圣迹）' },
        daily_reward_party_name: { type: 'string', description: '领每日奖励时切换的队伍' },
        crafting_bench_country: { type: 'string', description: '合成台地区（蒙德/璃月/稻妻/须弥/枫丹/纳塔/挪德卡莱/至冬）' },
        adventurers_guild_country: { type: 'string', description: '冒险家协会地区' },
        completion_action: { type: 'string', enum: ['无', '关闭游戏', '关闭软件', '关闭游戏和软件', '关机'], description: '跑完后的动作' },
        min_resin_to_keep: { type: 'number', description: '合成树脂时保留的原粹树脂数量' },
        weekly_domain_enabled: { type: 'boolean', description: '启用「按星期使用不同秘境/队伍」' },
        weekday_domains: { type: 'object', description: '按星期指定秘境，如 {"Monday":"荒坠的圣迹"}' },
        weekday_parties: { type: 'object', description: '按星期指定队伍' },
        tasks: { type: 'array', items: { type: 'string' }, description: '要启用的任务名（顺序即执行顺序；未列出的会被停用）。合法名：领取邮件/合成树脂/自动秘境/自动首领讨伐/自动幽境危战/自动地脉花/领取每日奖励/领取尘歌壶奖励，或 User\\ScriptGroup 里的配置组名' },
        dry_run: { type: 'boolean', description: '只预览不写入（默认 false）' },
      },
    },
  },
  {
    name: 'bgi_wait_milestone',
    description: '等待日志出现某个里程碑（确认"真的跑起来了"，而不只是"已发起"）：capturer_ready（截图器就绪）/ dragon_started / group_started / task_started / domain_entered（真进秘境）/ combat_matched / script_finished / finished（整体收尾）/ any_error。单次最多等 50 秒，超时就再调一次。',
    inputSchema: {
      type: 'object',
      properties: {
        milestone: { type: 'string', enum: ['capturer_ready', 'dragon_started', 'group_started', 'task_started', 'domain_entered', 'combat_matched', 'script_finished', 'finished', 'any_error'], description: '默认 finished' },
        pattern: { type: 'string', description: '自定义正则（给了就忽略 milestone）' },
        wait_seconds: { type: 'number', description: '最多等多少秒（默认 45，上限 50）' },
        since_minutes: { type: 'number', description: '只看最近 N 分钟的日志行（避免命中昨天的）' },
      },
    },
  },
  {
    name: 'bgi_collect_now',
    description: '「说一句就采集」的一步到位入口：确保路线与配置组就绪 → 检查/准备游戏窗口（最小化或不在前台时尝试还原并置前）→ 触发配置组 → 轮询到"真的开始跑了"（里程碑）。会真正启动 BetterGI 并接管游戏操作，需 confirm=true。dry_run=true 只做准备与汇报。',
    inputSchema: {
      type: 'object',
      properties: {
        material: { type: 'string', description: '材料名，例如 星螺' },
        confirm: { type: 'boolean', description: '必须显式 true 才会真正触发' },
        dry_run: { type: 'boolean', description: '只做准备（下载路线/建组/窗口检查），不触发' },
        overwrite: { type: 'boolean', description: '重新下载路线文件（默认 false）' },
        force: { type: 'boolean', description: '无视前置阻断强行触发（默认 false；窗口 <1080p/最小化时基本白跑）' },
      },
      required: ['material'],
    },
  },
  {
    name: 'bgi_results',
    description: '战果统计（只读）：某天/最近几天配置组里每条路线跑成没、各自花了多久、成功/失败计数与失败清单，并附刷取统计（FarmingPlan 小怪/精英数）与断点续跑进度（task_progress）。注意：**一条龙不写执行记录**，只有配置组任务 / --startGroups / --TaskProgress 会写。',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'today（默认）/ yesterday / yyyyMMdd / yyyy-MM-dd' },
        days: { type: 'number', description: '汇总最近 N 天（默认 1）' },
        group: { type: 'string', description: '只看某配置组（模糊匹配）' },
        material: { type: 'string', description: '只看项目名/文件夹名含该关键字（例：星螺）' },
      },
    },
  },
  {
    name: 'bgi_close',
    description: '关闭原神 / BetterGI（先优雅关闭、必要时强制），并如实报告是否真的关掉。**改 User\\config.json 或 User\\OneDragon\\*.json 之前必须先退出 BetterGI**（它运行中会整份回写覆盖）。BetterGI 若以管理员权限运行，普通权限关不掉——会明确报告权限不足并给出替代路径。需 confirm:true（或用 dry_run 预览）。',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['game', 'bettergi', 'both'], description: '默认 game（只关原神）' },
        force: { type: 'boolean', description: '跳过优雅关闭，直接强制结束' },
        dry_run: { type: 'boolean', description: '只报告将关闭哪些进程（默认 false）' },
        confirm: { type: 'boolean', description: '真正关闭必须显式 true' },
      },
    },
  },
  {
    name: 'bgi_create_onedragon',
    description: '新建一个「一条龙」配置（复制现有配置或从空模板），并可选设置任务顺序。注意：命令行 `startOneDragon <名>` **按 JSON 里的 Name 字段匹配**（Ordinal 精确比较），不是按文件名 → 本工具会同时把文件名与 Name 设成同一个名字，并在发现重名时拒绝（重名会让 BetterGI 随机命中其中一个）。',
    inputSchema: {
      type: 'object',
      properties: {
        config: { type: 'string', description: '新配置名（同时作为文件名与 Name 字段）' },
        from: { type: 'string', description: '以哪个现有配置为模板（默认「日常」）' },
        tasks: { type: 'array', items: { type: 'string' }, description: '可选：直接指定任务顺序（合法名同 bgi_set_onedragon）' },
        overwrite: { type: 'boolean', description: '已存在时覆盖（默认 false，会拒绝）' },
        dry_run: { type: 'boolean', description: '只预览（默认 false）' },
      },
      required: ['config'],
    },
  },
  {
    name: 'bgi_doctor',
    description: '开跑前体检（只读，不启动任何进程）：安装与关键配置、进程/窗口就绪（可见+前台+16:9≥1080P）、显示分辨率与 DPI 能否容纳 1920×1080、安装包识别资源分辨率、路线资产、**配置组里每个 Pathing 项目对应的文件是否真的存在**（缺失会被静默跳过）、一条龙配置与收工动作、MCP/包装器等闭环件。跑采集或秘境前先调它。',
    inputSchema: {
      type: 'object',
      properties: {
        material: { type: 'string', description: '可选：额外检查某材料的路线是否已装（例：星螺）' },
      },
    },
  },
  {
    name: 'bgi_focus_game',
    description: '跑自动化前的窗口准备（会改变你当前焦点）：把原神从最小化还原并尝试切到前台，回报客户区尺寸、是否 16:9、是否 ≥1080P、是否在前台。采集/秘境要求「可见 + 前台 + 16:9 ≥1920×1080」，不满足时自动化会失败或暂停。',
    inputSchema: {
      type: 'object',
      properties: {
        no_focus: { type: 'boolean', description: '只还原（取消最小化），不抢前台（默认 false）' },
      },
    },
  },
  {
    name: 'bgi_watch',
    description: '观察并判定成败（只读，可反复调用）。默认立即返回当前判定；verdict=incomplete 表示还没收尾，隔一会儿再调一次（或用 wait_seconds 在单次调用内最多轮询 50 秒）。只把「本次运行」的 ERR 计入失败，更早运行的 ERR 单独列出。',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['oneDragon', 'groups'], description: '默认 oneDragon' },
        since_minutes: { type: 'number', description: '回看多少分钟（默认 180）' },
        wait_seconds: { type: 'number', description: '在单次调用内最多轮询多少秒（默认 0，上限 50）' },
      },
    },
  },
  {
    name: 'bgi_set_config',
    description: '安全修改 User\\config.json（父.子=值）。要求 BetterGI 已退出；会自动备份并回读校验。dry_run=true 只预览。',
    inputSchema: {
      type: 'object',
      properties: {
        changes: {
          type: 'array',
          description: '形如 [{path:"autoDomainConfig.condensedResinUseCount", value:"5"}]',
          items: {
            type: 'object',
            properties: { path: { type: 'string' }, value: {} },
            required: ['path', 'value'],
          },
        },
        dry_run: { type: 'boolean', description: '只预览不写入（默认 false）' },
      },
      required: ['changes'],
    },
  },
  {
    name: 'bgi_list_strategies',
    description: '列出本机战斗策略（User\\AutoFight\\**\\*.txt），并可按队伍预测「根据队伍自动选择」会选中哪一份。',
    inputSchema: {
      type: 'object',
      properties: { team: { type: 'string', description: '逗号分隔的队伍角色名，例如 "莉奈娅,哥伦比娅,千织,兹白"' } },
    },
  },
  {
    name: 'bgi_list_groups',
    description: '列出所有配置组及其项目（名字/类型/状态）。',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'bgi_create_group',
    description: '新建或向既有配置组追加项目。Pathing 项目的 target 用「子目录/文件名.json」或「文件名」。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '配置组名（= 文件名）' },
        type: { type: 'string', enum: ['Pathing', 'Javascript', 'KeyMouse', 'Shell'], description: '默认 Pathing' },
        targets: { type: 'array', items: { type: 'string' }, description: '项目目标列表' },
        folder: { type: 'string', description: 'Pathing 的公共子目录（可选）' },
      },
      required: ['name', 'targets'],
    },
  },
  {
    name: 'bgi_list_pathing',
    description: '列出本机已安装的地图追踪路径（User\\AutoPathing\\**\\*.json），可按关键词过滤。',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '只看名字含该关键词的路径' },
        extra_dirs: { type: 'array', items: { type: 'string' }, description: '额外扫描目录' },
      },
    },
  },
  {
    name: 'bgi_find_routes',
    description: '在官方脚本仓库（babalae/bettergi-scripts-list）里检索地图追踪路线，例如「星螺」→ 5 条璃月路线。download=true 时下载到 User\\AutoPathing。',
    inputSchema: {
      type: 'object',
      properties: {
        material: { type: 'string', description: '材料/怪物/矿物名，例如 星螺' },
        kind: { type: 'string', enum: ['pathing', 'js', 'combat', 'tcg'], description: '仓库分区，默认 pathing' },
        download: { type: 'boolean', description: '下载命中文件（默认 false）' },
        overwrite: { type: 'boolean', description: '覆盖已存在文件（默认 false）' },
      },
      required: ['material'],
    },
  },
  {
    name: 'bgi_repo_index',
    description: '浏览官方脚本仓库目录树（用于发现可用的路线/JS 脚本/战斗策略）。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['pathing', 'js', 'combat', 'tcg'], description: '分区，默认 pathing' },
        filter: { type: 'string', description: '只显示路径含该关键词的条目' },
        limit: { type: 'number', description: '最多返回多少条（默认 80）' },
      },
    },
  },
  {
    name: 'bgi_list_js_scripts',
    description: '列出官方仓库里的 JS 脚本（js/ 分区，本机 2026-10-16 实测有 144 个，例如 AutoCommission 自动每日委托、使用历练点完成每日委托、AutoRefinedCondensationResin 自动合成浓缩树脂）。detail=true 时会拉该脚本的 manifest.json 显示名称/说明/版本。',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string', description: '只看名字含该关键词的脚本（如 委托 / 树脂 / 纪行）' },
        detail: { type: 'string', description: '填脚本目录名则额外拉它的 manifest.json' },
      },
    },
  },
  {
    name: 'bgi_install_js',
    description: '把官方仓库的一个 JS 脚本整目录安装到 User\\JsScript\\<名字>\\（含 manifest.json、main.js 与资源）。装完可用 bgi_run_js 建组执行，或用 bgi_add_group_to_onedragon 接进每日一条龙。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '仓库 js/ 下的目录名，例如 AutoCommission' },
        overwrite: { type: 'boolean', description: '覆盖已存在文件（默认 false）' },
      },
      required: ['name'],
    },
  },
  {
    name: 'bgi_run_js',
    description: '一键跑官方 JS 脚本：确保已安装 → 生成同名配置组（单个 Javascript 项目）→（run=true 时）触发执行。JS 脚本是 BetterGI 能力最强的扩展面（自动委托、树脂、纪行、尘歌壶、抽卡兑换等）。',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '仓库 js/ 下的目录名' },
        run: { type: 'boolean', description: '建组后立即触发（默认 false）' },
        overwrite: { type: 'boolean', description: '重新下载脚本文件（默认 false）' },
      },
      required: ['name'],
    },
  },
  {
    name: 'bgi_add_group_to_onedragon',
    description: '把一个配置组接入「一条龙」每日流程（离线改 User\\OneDragon\\<配置>.json：新增 GUID 条目到 TaskDefinitions/TaskEnabledList/TaskOrder）。**会改变每日自动化内容**，需 confirm=true；会自动备份。',
    inputSchema: {
      type: 'object',
      properties: {
        group: { type: 'string', description: '配置组名（= User\\ScriptGroup\\<名>.json）' },
        config: { type: 'string', description: '一条龙配置名，默认「日常」' },
        position: { type: 'string', description: 'end（默认，排在最后）或 before:<任务名>（如 before:自动秘境）' },
        confirm: { type: 'boolean', description: '必须显式 true 才会写入' },
      },
      required: ['group'],
    },
  },
  {
    name: 'bgi_collect_material',
    description: '一键采集材料（旗舰工具）：在官方仓库找到该材料的路线 → 缺则下载到 User\\AutoPathing → 生成配置组「采集-<材料>」→（run=true 时）立即触发执行。',
    inputSchema: {
      type: 'object',
      properties: {
        material: { type: 'string', description: '材料名，例如 星螺' },
        run: { type: 'boolean', description: '下载/建组后立即触发（默认 false，先给用户确认）' },
        include_related: { type: 'boolean', description: '同时纳入"顺路采集"的相邻路线（默认 false）' },
        overwrite: { type: 'boolean', description: '重新下载已存在的文件（默认 false）' },
      },
      required: ['material'],
    },
  },
];

// ─────────────────────────── 工具实现 ───────────────────────────
const ok = (text) => ({ content: [{ type: 'text', text }] });
const bad = (text) => ({ content: [{ type: 'text', text }], isError: true });

/** 把前置检查（进程/窗口/阻断项）插到工具输出最前面，尾注放最后 */
function withPreflight(result, lines, tailNote) {
  const body = (result.content && result.content[0] && result.content[0].text) || '';
  const head = lines && lines.length ? '— 前置检查 —\n' + lines.join('\n') + '\n\n' : '';
  const tail = tailNote ? '\n\n' + tailNote : '';
  return { content: [{ type: 'text', text: head + body + tail }], isError: !!result.isError };
}

async function runScriptOrReport(label, script, args, timeoutMs, { pendingOnWaitTimeout = false } = {}) {
  const r = await callScript(script, args, timeoutMs);
  const body = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
  if (r.code !== 0) {
    // 「等就绪证据超时」不是失败：游戏/截图器要 1-2 分钟才起来，而单次调用只有 ~60 秒预算
    if (pendingOnWaitTimeout && /等待超时|未看到『遮罩窗口已启动』/.test(body)) {
      return ok(`【${label}】已发起，但没在限时内看到就绪证据——**这不算失败**（游戏进到可操作状态通常要 1-2 分钟）。\n${body}\n\n下一步：用 bgi_status 复查进程与日志尾部；或直接开始轮询 bgi_watch。`);
    }
    const hint = r.code === 2 ? '\n\n（退出码 2 = 前置条件不满足：通常是 BetterGI 正在运行，或参数/路径问题）' : '';
    return bad(`【${label}】失败（退出码 ${r.code}）${hint}\n${body}`);
  }
  return ok(body || `【${label}】完成（无输出）`);
}

const HANDLERS = {
  async bgi_status(args) {
    const useJson = args.json !== false;
    const r = await callScript('bgi-status.ps1', useJson ? ['-Json'] : ['-TailLines', '15'], 90000);
    if (r.code !== 0) return bad(`读取状态失败（退出码 ${r.code}）：\n${r.stderr || r.stdout}`);
    return ok(r.stdout.trim());
  },

  async bgi_start_game(args) {
    if (args.dry_run) return runScriptOrReport('启动原神/截图器', 'bgi-run.ps1', ['-Mode', 'start', '-DryRun'], 60000);
    const wait = clampWait(args.wait_seconds, 40);
    const a = ['-Mode', 'start'];
    if (wait > 0) a.push('-Wait', '-WaitSeconds', String(wait));
    const res = await runScriptOrReport('启动原神/截图器', 'bgi-run.ps1', a, (wait + 40) * 1000, { pendingOnWaitTimeout: true });
    return withPreflight(res, null, '接着可以用 bgi_status 复查进程/日志（游戏进到可操作用 1-2 分钟是常态）。');
  },

  async bgi_run_one_dragon(args) {
    const name = args.config || '日常';
    if (args.dry_run) {
      const st0 = await statusBrief();
      const gate = evaluateRunGate(statusForGate(st0), { force: !!args.force });
      const res0 = await runScriptOrReport(`一条龙「${name}」`, 'bgi-run.ps1', ['-Mode', 'oneDragon', '-Name', name, '-DryRun'], 60000);
      return withPreflight(res0, gate.lines);
    }
    const st = await statusBrief();
    const gate = evaluateRunGate(statusForGate(st), { force: !!args.force });
    if (!gate.canRun) {
      return bad(`${gate.lines.join('\n')}\n\n` +
        `先把上面的阻断项解决（分辨率/最小化用 bgi_focus_game 或重启游戏、BetterGI 占用用 bgi_close 或包装器）；\n` +
        `确实要无视这些风险强行跑，请带 force:true —— 但结果基本是白跑一场。`);
    }
    const wait = clampWait(args.wait_seconds, 0);
    const a = ['-Mode', 'oneDragon', '-Name', name];
    if (wait > 0) a.push('-Wait', '-WaitSeconds', String(wait));
    const res = await runScriptOrReport(`一条龙「${name}」`, 'bgi-run.ps1', a, (wait + 40) * 1000, { pendingOnWaitTimeout: true });
    return withPreflight(res, gate.lines, '下一步：bgi_watch {mode:"oneDragon"} 观察结果（可 wait_seconds:50 轮询）。');
  },

  async bgi_run_groups(args) {
    const groups = Array.isArray(args.groups) ? args.groups : [args.groups];
    if (!groups.length) return bad('groups 不能为空');
    const label = `配置组 ${groups.join(' → ')}`;
    if (args.dry_run) {
      const st0 = await statusBrief();
      const gate = evaluateRunGate(statusForGate(st0), { force: !!args.force });
      const res0 = await runScriptOrReport(label, 'bgi-run.ps1', ['-Mode', 'groups', '-Name', groups.join(','), '-DryRun'], 60000);
      return withPreflight(res0, gate.lines);
    }
    const st = await statusBrief();
    const gate = evaluateRunGate(statusForGate(st), { force: !!args.force });
    if (!gate.canRun) {
      return bad(`${gate.lines.join('\n')}\n\n` +
        `先把上面的阻断项解决（分辨率/最小化用 bgi_focus_game 或重启游戏、BetterGI 占用用 bgi_close 或包装器）；\n` +
        `确实要无视这些风险强行跑，请带 force:true —— 但结果基本是白跑一场。`);
    }
    const wait = clampWait(args.wait_seconds, 0);
    const a = ['-Mode', 'groups', '-Name', groups.join(',')];
    if (wait > 0) a.push('-Wait', '-WaitSeconds', String(wait));
    const res = await runScriptOrReport(label, 'bgi-run.ps1', a, (wait + 40) * 1000, { pendingOnWaitTimeout: true });
    return withPreflight(res, gate.lines, '下一步：bgi_watch {mode:"groups"} 观察结果（可 wait_seconds:50 轮询）。');
  },

  async bgi_log_search(args) {
    const a = [];
    if (args.pattern) a.push('-Pattern', String(args.pattern));
    if (Array.isArray(args.levels) && args.levels.length) a.push('-Level', args.levels.map((x) => String(x)));
    if (args.since_minutes) a.push('-SinceMinutes', String(args.since_minutes));
    a.push('-Tail', String(args.tail || 40));
    if (args.task) a.push('-Task', String(args.task));
    const r = await callScript('bgi-log.ps1', a, 90000);
    const body = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
    if (r.code === 0) return ok(body);
    if (r.code === 1) return ok(`（没有命中——可放宽 pattern / 去掉 since_minutes 再试）\n${body}`);
    return bad(body || '日志检索失败（退出码 2：日志不存在？）');
  },

  async bgi_schedule_info() {
    const r = await callScript('bgi-schedule.ps1', [], 120000);
    const body = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
    return r.code === 0 ? ok(body) : ok(`⚠ 调度检查有提示（退出码 ${r.code}）：\n${body}`);
  },

  async bgi_run_task_progress(args) {
    const name = args.name || 'latest';
    const st = await statusBrief();
    const gate = evaluateRunGate(statusForGate(st), { force: !!args.force });
    if (!gate.canRun) {
      return bad(`${gate.lines.join('\n')}\n\n续跑同样需要窗口可用；确实要强行跑请带 force:true。`);
    }
    const res = await runScriptOrReport(`续跑 ${name}`, 'bgi-run.ps1', ['-Mode', 'progress', '-Name', name], 60000);
    return withPreflight(res, gate.lines, '下一步：bgi_watch {mode:"groups"} 观察结果。');
  },

  async bgi_js_settings(args) {
    const name = String(args.name || '').trim();
    if (!name) return bad('name 不能为空');
    const schemaPath = path.join(BGI_ROOT, 'User', 'JsScript', name, 'settings.json');
    if (!existsSync(schemaPath)) return bad(`该脚本没有 settings.json（无需配置或脚本不存在）：${schemaPath}`);
    let schema;
    try { schema = JSON.parse(readFileSync(schemaPath, 'utf8').replace(/^\uFEFF/, '')); } catch (e) { return bad(`settings.json 解析失败：${e.message}`); }
    if (!Array.isArray(schema)) return bad('settings.json 结构不是数组（无法识别设置项）');
    // 源码 SettingsItem：type 只有 separator / input-text / select / checkbox 四种。
    // separator 只是视觉分隔条（ToControl 里不写任何默认值、不参与绑定）→ 必须排除，否则会被当成空设置项。
    const items = schema.filter((x) => x && x.name && x.type !== 'separator');
    const types = {}; const defaults = {}; const options = {}; const hasDefault = {};
    for (const it of items) {
      types[it.name] = it.type;
      if (Array.isArray(it.options)) options[it.name] = it.options;
      if (it.default !== undefined) { defaults[it.name] = it.default; hasDefault[it.name] = true; }
      else if (it.type === 'checkbox') { defaults[it.name] = false; hasDefault[it.name] = false; }   // 源码：Default 为 null 时不写入上下文
      else if (it.type === 'select' && Array.isArray(it.options) && it.options.length) { defaults[it.name] = it.options[0]; hasDefault[it.name] = false; }
      else { defaults[it.name] = ''; hasDefault[it.name] = false; }
    }

    const gp = groupPath(name);
    const group = existsSync(gp) ? readJsonFile(gp) : null;
    if (!group) return bad(`还没有配置组「${name}」——先 bgi_run_js {name:"${name}"} 建组（设置存放在配置组项目里）`);
    const proj = (group.projects || []).find((p) => p.type === 'Javascript' && p.folderName === name);
    if (!proj) return bad(`配置组「${name}」里没有 folderName=${name} 的 Javascript 项目`);
    const persisted = (proj.jsScriptSettingsObject && typeof proj.jsScriptSettingsObject === 'object' && !Array.isArray(proj.jsScriptSettingsObject))
      ? proj.jsScriptSettingsObject : {};
    const effective = { ...defaults, ...persisted };

    if (!args.set) {
      const lines = [`JS 脚本「${name}」的可配置项（${items.length} 个）`, `配置组：${gp}`];
      for (const it of items) {
        const cur = effective[it.name];
        const isDefault = JSON.stringify(cur) === JSON.stringify(defaults[it.name]);
        const mark = !hasDefault[it.name] && cur === '' ? '（schema 未给默认值）' : (isDefault ? '（默认）' : '（已改）');
        const optTxt = options[it.name] ? `　可选：${options[it.name].join(' / ')}` : '';
        const label = String(it.label || '').split('\n')[0];
        lines.push(`  ${it.name} [${it.type}] = ${JSON.stringify(cur)}${mark}${optTxt}`);
        if (label) lines.push(`      ${label}`);
      }
      lines.push(`\n写入示例：bgi_js_settings {name:"${name}", set:{"adventurePath":"枫丹"}}`);
      return ok(lines.join('\n'));
    }

    const changes = [];
    for (const [k, v] of Object.entries(args.set)) {
      if (!(k in types)) return bad(`未知设置项「${k}」。可用项：${items.map((i) => i.name).join(', ')}`);
      let val;
      if (types[k] === 'checkbox') {
        val = (v === true || v === 'true' || v === 1 || v === '1');
      } else if (types[k] === 'select') {
        const opts = options[k] || [];
        if (!opts.includes(String(v))) return bad(`「${k}」只能取：${opts.join(' / ')}（收到 ${JSON.stringify(v)}）`);
        val = String(v);
      } else {
        val = String(v ?? '');
      }
      changes.push([k, val]);
    }
    const next = { ...effective };
    for (const [k, v] of changes) next[k] = v;
    // 只持久化"与默认值不同"或"本次显式指定"的项，保持配置组文件干净
    const toStore = {};
    for (const k of Object.keys(next)) {
      const explicitlySet = changes.some((c) => c[0] === k);
      if (explicitlySet || JSON.stringify(next[k]) !== JSON.stringify(defaults[k])) toStore[k] = next[k];
    }

    const bkDir = path.join(BGI_ROOT, `_backup_${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_')}`);
    mkdirSync(bkDir, { recursive: true });
    writeFileSync(path.join(bkDir, `${name}.json`), JSON.stringify(group, null, 2), 'utf8');

    if (Object.keys(toStore).length) proj.jsScriptSettingsObject = toStore;
    else delete proj.jsScriptSettingsObject;
    writeJsonFile(gp, group);

    const lines = [`✓ 已更新「${name}」的设置（备份：${bkDir}\\${name}.json）`];
    for (const [k, v] of changes) lines.push(`  ${k}: ${JSON.stringify(effective[k])} → ${JSON.stringify(v)}`);
    lines.push(`\n持久化的项：${Object.keys(toStore).length ? JSON.stringify(toStore) : '（全部为默认值）'}`);
    lines.push('注意：BetterGI 运行中会回写配置组文件——改设置前请确保它未运行。');
    return ok(lines.join('\n'));
  },

  async bgi_wait_milestone(args) {
    const a = [];
    if (args.pattern) a.push('-Pattern', String(args.pattern));
    else a.push('-Milestone', String(args.milestone || 'finished'));
    a.push('-TimeoutSeconds', String(Math.min(Number(args.wait_seconds) || 45, 50)));
    if (args.since_minutes) a.push('-SinceMinutes', String(args.since_minutes));
    const r = await callScript('bgi-wait.ps1', a, 70000);
    const body = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
    if (r.code === 0) return ok(body);
    if (r.code === 1) return ok(`（本轮等待没等到——可以再调一次继续等，或先用 bgi_log_search 看发生了什么）\n${body}`);
    return bad(body || '等待失败（日志不存在？）');
  },

  async bgi_collect_now(args) {
    const material = String(args.material || '').trim();
    if (!material) return bad('material 不能为空');
    const groupName = `采集-${material}`;
    const out = [];

    // ① 路线与配置组：复用 bgi_collect_material 的准备逻辑（不触发）
    const prep = HANDLERS.bgi_collect_material;
    const prepRes = await prep({ material, run: false, overwrite: !!args.overwrite });
    out.push('【准备】');
    out.push((prepRes.content && prepRes.content[0] && prepRes.content[0].text) || '');
    if (prepRes.isError) return bad(out.join('\n'));

    // ② 前置检查（进程/窗口）——用统一判定，硬阻断一律不放行（除非 force）
    const st = await statusBrief();
    let gate = evaluateRunGate(statusForGate(st), { force: !!args.force });
    if (!gate.canRun && !args.dry_run) {
      return bad(`【准备】\n${(prepRes.content && prepRes.content[0] && prepRes.content[0].text) || ''}\n\n${gate.lines.join('\n')}\n\n` +
        `先把上面的阻断项解决（分辨率/最小化用 bgi_focus_game 或重启游戏、BetterGI 占用用 bgi_close 或包装器）；\n` +
        `确实要无视风险强行跑，请带 force:true。`);
    }
    // ③ 窗口准备：最小化/不在前台时尝试还原+置前
    //    注意：dry_run 只**报告**窗口状态，不动你的前台（抢焦点是有副作用的动作）
    const gw = st && st.gameWindow;
    const needFocus = !!(gw && (!gw.foreground || gw.minimized));
    if (args.dry_run) {
      out.push('【判定】');
      out.push(gate.lines.join('\n'));
      if (needFocus) {
        out.push('【窗口准备（dry_run 未执行）】');
        out.push(`  当前：最小化=${gw.minimized} 前台=${gw.foreground}（前台窗口：${gw.foregroundTitle}）`);
        out.push('  真正执行时我会先调 bgi_focus_game 还原并置前，然后**重新判定一次**再决定是否触发。');
      }
      out.push('\n【dry_run】未触发。真正执行请带 confirm:true。');
      return ok(out.join('\n'));
    }
    if (needFocus) {
      const f = await callScript('bgi-focus-game.ps1', ['-ProcessName', 'YuanShen'], 60000);
      out.push('【窗口准备】');
      out.push((f.stdout || f.stderr).trim());
      // focus 之后重新判定：置前成功会把"不在前台"这条软警告消掉
      const st2 = await statusBrief();
      gate = evaluateRunGate(statusForGate(st2), { force: !!args.force });
      if (!gate.canRun) {
        return bad(`${out.join('\n')}\n\n【重新判定】\n${gate.lines.join('\n')}\n\n窗口准备没能解决阻断项——先处理它，或用 force:true 强行跑。`);
      }
    }

    if (args.confirm !== true) {
      return ok(`${out.join('\n')}\n\n【判定】\n${gate.lines.join('\n')}\n\n⚠ 这会真正启动 BetterGI 并接管游戏操作（鼠标键盘会自动操作游戏）。确认后请带 confirm:true 重新调用。`);
    }

    // ④ 触发
    out.push('【触发】');
    const rr = await callScript('bgi-run.ps1', ['-Mode', 'groups', '-Name', groupName], 60000);
    const rtxt = (rr.stdout + rr.stderr).trim();
    out.push(rtxt);
    if (rr.code !== 0) return bad(out.join('\n'));

    // ⑤ 轮询到"真的开始跑了"：先等截图器就绪，再等配置组开始执行
    const waitFor = async (milestone, secs) => {
      const w = await callScript('bgi-wait.ps1', ['-Milestone', milestone, '-TimeoutSeconds', String(secs), '-SinceMinutes', '5'], 70000);
      return { code: w.code, text: (w.stdout || w.stderr).trim() };
    };
    out.push('\n【确认已开始】');
    const m1 = await waitFor('capturer_ready', 30);
    out.push(`截图器：${m1.code === 0 ? '✓ 就绪' : '… 尚未就绪（可能还在进游戏）'}`);
    if (m1.code === 0) {
      const m2 = await waitFor('group_started', 20);
      out.push(`配置组开始执行：${m2.code === 0 ? '✓' : '… 还没看到（可能在等待截图器/加载脚本）'}`);
      if (m2.code !== 0) out.push(m2.text);
    }
    out.push('\n下一步：用 bgi_watch {mode:"groups", wait_seconds:50} 反复轮询到收尾；期间请保持原神可见且在前台。');
    return ok(out.join('\n'));
  },

  async bgi_results(args) {
    const a = [];
    if (args.date) a.push('-Date', String(args.date));
    if (args.days) a.push('-Days', String(args.days));
    if (args.group) a.push('-Group', String(args.group));
    if (args.material) a.push('-Material', String(args.material));
    const r = await callScript('bgi-results.ps1', a, 90000);
    const body = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
    if (r.code === 0) return ok(body);
    if (r.code === 1) return ok(body);   // 没记录不是错误，说明清楚即可
    return bad(body || '统计失败（退出码 2）');
  },

  async bgi_close(args) {
    const target = args.target || 'game';
    const a = ['-Target', String(target)];
    if (args.force) a.push('-Force');
    if (args.dry_run) {
      a.push('-DryRun');
    } else if (args.confirm !== true) {
      const st = await statusBrief();
      return bad(`⚠ 这会真的关闭进程（${target}）。确认后请带 confirm:true 重新调用，或先用 dry_run:true 预览。\n` +
        `当前：BetterGI=${st?.bgiRunning ? '运行中' : '未运行'}${st?.gamePid ? `  原神=运行中 PID ${st.gamePid}` : '  原神=未运行'}`);
    }
    const r = await callScript('bgi-close.ps1', a, 90000);
    const body = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
    if (r.code === 0) return ok(body);
    return ok(`⚠ 有目标没关掉（多半是权限不足）——按下面提示处理：\n${body}`);
  },

  async bgi_doctor(args) {
    const a = [];
    if (args.material) a.push('-Material', String(args.material));
    const r = await callScript('bgi-doctor.ps1', a, 90000);
    const body = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
    if (r.code === 0) return ok(`✅ 体检通过\n${body}`);
    if (r.code === 1) return ok(`⚠️ 体检有警告（能跑但有风险）\n${body}`);
    return ok(`⛔ 体检有**阻断项**——现在跑会失败，先按下面的说明处理：\n${body}`);
  },

  async bgi_focus_game(args) {
    const a = ['-ProcessName', 'YuanShen'];
    if (args.no_focus) a.push('-NoFocus');
    const r = await callScript('bgi-focus-game.ps1', a, 60000);
    const body = [r.stdout.trim(), r.stderr.trim()].filter(Boolean).join('\n');
    // 环境状态（最小化 / 分辨率不足 / 没窗口）不是"工具失败"，一律作为报告返回，避免调用方误判成崩溃
    if (r.code === 0) return ok(`✓ 窗口已就绪（可见 + 前台 + 16:9 ≥1080P），可以开始跑自动化。\n${body}`);
    if (r.code === 1) return ok(`⚠ 窗口已可见但**还没完全就绪**（多半是未取得前台，或分辨率不足）——按下面提示处理后再跑：\n${body}`);
    return ok(`⛔ 窗口尚不可用（游戏没窗口，或还原后仍是最小化）——自动化现在跑会失败：\n${body}`);
  },

  async bgi_watch(args) {
    const mode = args.mode || 'oneDragon';
    const since = String(args.since_minutes ?? 180);
    const budget = clampWait(args.wait_seconds, 0);
    const start = Date.now();
    const deadline = start + budget * 1000;
    let parsed = null;
    let raw = '';
    for (;;) {
      const r = await callScript('bgi-watch.ps1', ['-Mode', mode, '-Json', '-DryRun', '-SinceMinutes', since], 60000);
      raw = (r.stdout || r.stderr || '').trim();
      parsed = extractJson(raw);
      const v = parsed?.verdict;
      if (v === 'success' || v === 'failed') break;
      if (Date.now() >= deadline) break;
      await sleep(Math.min(5000, Math.max(500, deadline - Date.now())));
    }
    if (!parsed) return bad(`无法解析 bgi-watch.ps1 的输出：\n${raw.slice(0, 800)}`);

    const events = Array.isArray(parsed.events) ? parsed.events : [];
    const errors = Array.isArray(parsed.errors) ? parsed.errors : [];
    const errsBefore = Array.isArray(parsed.errorsBefore) ? parsed.errorsBefore : [];
    const waited = Math.round((Date.now() - start) / 1000);
    const lines = [];
    lines.push(parsed.verdict === 'success'
      ? '结论: ✓ 成功（已收尾，本次运行无 ERR）'
      : parsed.verdict === 'failed'
        ? '结论: ✗ 失败（本次运行有 ERR）'
        : '结论: … 未收尾（还在跑，或压根没启动）');
    if (parsed.lastEndTime) lines.push(`收尾标记: 已出现「一条龙和配置组任务结束」@ ${parsed.lastEndTime}`);
    if (parsed.progress && Array.isArray(parsed.progress) && parsed.progress.length) {
      lines.push('task_progress:');
      for (const p of parsed.progress.slice(0, 5)) lines.push(`  ${p.name}  endTime=${p.endTime}  失败项=${p.failedItems}`);
    }
    if (events.length) {
      lines.push('最近关键事件:');
      for (const e of events.slice(-8)) lines.push(`  [${e.time}] ${e.level} ${e.key} → ${e.message}`);
    }
    if (errors.length) {
      lines.push('失败证据（本次运行内的 ERR）:');
      for (const e of errors) lines.push(`  [${e.time}] ${e.key} → ${e.message}`);
    }
    if (errsBefore.length) lines.push(`（另有 ${errsBefore.length} 条更早运行留下的 ERR，未计入判定）`);
    if (parsed.verdict === 'incomplete') {
      lines.push(budget > 0
        ? `已在单次调用内轮询 ${waited} 秒仍未收尾——隔一会儿再调一次 bgi_watch。`
        : '下一步：隔一会儿再调一次 bgi_watch 继续观察（长任务本就该"发起 → 轮询"）。');
    }
    const text = lines.join('\n');
    return parsed.verdict === 'failed' ? bad(text) : ok(text);
  },

  async bgi_set_onedragon(args) {
    const cfgName = args.config || '日常';
    const cfgPath = path.join(BGI_ROOT, 'User', 'OneDragon', `${cfgName}.json`);
    if (!existsSync(cfgPath)) {
      const dir = path.join(BGI_ROOT, 'User', 'OneDragon');
      const names = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : [];
      return bad(`找不到一条龙配置「${cfgName}」。现有：${names.join(', ') || '（无）'}`);
    }
    const cfg = readJsonFile(cfgPath);
    if (!cfg) return bad(`配置解析失败：${cfgPath}`);
    // 改动前的快照：备份必须写"原状态"，否则回滚就是空谈（2026-10-16 踩过）
    const original = JSON.parse(JSON.stringify(cfg));

    const LEGAL_TASKS = ['领取邮件', '合成树脂', '自动秘境', '自动首领讨伐', '自动幽境危战', '自动地脉花', '领取每日奖励', '领取尘歌壶奖励'];
    const groupsDir = path.join(BGI_ROOT, 'User', 'ScriptGroup');
    const groupNames = existsSync(groupsDir) ? readdirSync(groupsDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : [];
    const LEGAL_ACTIONS = ['无', '关闭游戏', '关闭软件', '关闭游戏和软件', '关机'];
    const COUNTRIES = ['蒙德', '璃月', '稻妻', '须弥', '枫丹', '纳塔', '挪德卡莱', '至冬'];
    const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

    const before = {
      PartyName: cfg.PartyName, DomainName: cfg.DomainName, DailyRewardPartyName: cfg.DailyRewardPartyName,
      CraftingBenchCountry: cfg.CraftingBenchCountry, AdventurersGuildCountry: cfg.AdventurersGuildCountry,
      CompletionAction: cfg.CompletionAction, MinResinToKeep: cfg.MinResinToKeep,
      WeeklyDomainEnabled: cfg.WeeklyDomainEnabled,
      tasks: (cfg.TaskOrder || []).map((id) => (cfg.TaskDefinitions && cfg.TaskDefinitions[id]) || id),
    };
    const changes = [];
    const set = (key, val) => { cfg[key] = val; changes.push(`${key}: ${JSON.stringify(before[key])} → ${JSON.stringify(val)}`); };

    if (args.party_name !== undefined) set('PartyName', String(args.party_name));
    if (args.domain_name !== undefined) set('DomainName', String(args.domain_name));
    if (args.daily_reward_party_name !== undefined) set('DailyRewardPartyName', String(args.daily_reward_party_name));
    if (args.min_resin_to_keep !== undefined) set('MinResinToKeep', Number(args.min_resin_to_keep));
    for (const [k, key] of [['crafting_bench_country', 'CraftingBenchCountry'], ['adventurers_guild_country', 'AdventurersGuildCountry']]) {
      const v = args[k];
      if (v !== undefined) {
        if (!COUNTRIES.includes(String(v))) return bad(`「${k}」只能是：${COUNTRIES.join('/')}（收到 ${JSON.stringify(v)}）`);
        set(key, String(v));
      }
    }
    if (args.completion_action !== undefined) {
      const v = String(args.completion_action);
      if (!LEGAL_ACTIONS.includes(v)) return bad(`completion_action 只能是：${LEGAL_ACTIONS.join(' / ')}（收到 ${JSON.stringify(v)}）`);
      set('CompletionAction', v);
    }
    if (args.weekly_domain_enabled !== undefined) set('WeeklyDomainEnabled', !!args.weekly_domain_enabled);
    for (const [argKey, suffix] of [['weekday_domains', 'DomainName'], ['weekday_parties', 'PartyName']]) {
      const obj = args[argKey];
      if (obj) {
        for (const [day, val] of Object.entries(obj)) {
          if (!WEEKDAYS.includes(day)) return bad(`「${argKey}」的键必须是 ${WEEKDAYS.join('/')}（收到 ${day}）`);
          set(`${day}${suffix}`, String(val));
        }
      }
    }
    if (Array.isArray(args.tasks) && args.tasks.length) {
      const wanted = args.tasks.map((x) => String(x));
      const unknown = wanted.filter((t) => !LEGAL_TASKS.includes(t) && !groupNames.includes(t));
      if (unknown.length) {
        return bad(`不认识的任务名：${unknown.join('、')}\n合法的一条龙任务：${LEGAL_TASKS.join(' / ')}\n现有的配置组任务：${groupNames.join(' / ') || '（无）'}`);
      }
      cfg.TaskDefinitions = cfg.TaskDefinitions || {};
      cfg.TaskEnabledList = cfg.TaskEnabledList || {};
      const nameToId = {};
      for (const [id, name] of Object.entries(cfg.TaskDefinitions)) nameToId[name] = id;
      const genId = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
      const newOrder = [];
      for (const t of wanted) {
        let id = nameToId[t];
        if (!id) { id = genId(); cfg.TaskDefinitions[id] = t; nameToId[t] = id; }
        newOrder.push(id);
      }
      for (const id of Object.keys(cfg.TaskEnabledList)) cfg.TaskEnabledList[id] = newOrder.includes(id);
      for (const id of newOrder) cfg.TaskEnabledList[id] = true;
      cfg.TaskOrder = newOrder;
      changes.push(`任务顺序: [${before.tasks.join(' → ')}] → [${wanted.join(' → ')}]`);
    }

    if (!changes.length) return ok(`没有需要修改的项目。当前：\n  任务顺序：${before.tasks.join(' → ')}\n  秘境：${before.PartyName} / ${before.DomainName}\n  合成台：${before.CraftingBenchCountry}  冒险家协会：${before.AdventurersGuildCountry}\n  收工：${before.CompletionAction}`);

    if (args.dry_run) return ok(`（dry_run，未写入）将修改 ${cfgPath}：\n${changes.map((c) => '  ' + c).join('\n')}`);

    const st = await statusBrief();
    if ((st?.blockers || []).some((b) => /BetterGI 正在运行/.test(b))) {
      return bad('⛔ BetterGI 正在运行：它会把一条龙配置回写覆盖你的改动。请先退出 BetterGI（或加 dry_run 只预览）。');
    }
    const bkDir = path.join(BGI_ROOT, `_backup_${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_')}`);
    mkdirSync(bkDir, { recursive: true });
    writeFileSync(path.join(bkDir, `${cfgName}.json`), JSON.stringify(original, null, 2), 'utf8');
    writeJsonFile(cfgPath, cfg);

    const after = readJsonFile(cfgPath);
    const order = (after.TaskOrder || []).map((id) => (after.TaskDefinitions && after.TaskDefinitions[id]) || id);
    return ok(`✓ 已更新一条龙「${cfgName}」（备份：${bkDir}\\${cfgName}.json）\n${changes.map((c) => '  ' + c).join('\n')}\n\n` +
      `当前：\n  任务顺序：${order.join(' → ')}\n  秘境队伍/秘境：${after.PartyName} / ${after.DomainName}\n  合成台：${after.CraftingBenchCountry}  冒险家协会：${after.AdventurersGuildCountry}  收工：${after.CompletionAction}`);
  },

  async bgi_create_onedragon(args) {
    const name = String(args.config || '').trim();
    const from = String(args.from || '日常').trim();
    if (!name) return bad('config 不能为空');
    const dir = path.join(BGI_ROOT, 'User', 'OneDragon');
    const newPath = path.join(dir, `${name}.json`);
    const srcPath = path.join(dir, `${from}.json`);
    const existing = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, '')) : [];

    if (!existsSync(srcPath)) return bad(`模板配置不存在：${srcPath}（现有：${existing.join(', ') || '（无）'}）`);
    const dup = existing.find((n) => {
      if (n === name && existsSync(newPath)) return true;
      try { return String(readJsonFile(path.join(dir, `${n}.json`))?.Name || '') === name; } catch { return false; }
    });
    if (dup && !(dup === name && args.overwrite)) {
      return bad(`已有一个配置的 Name 等于「${name}」（文件 ${dup}.json）。命令行按 Name 精确匹配，重名会让 BetterGI 随机命中其一。\n` +
        `换个名字，或带 overwrite:true 覆盖 ${name}.json（仅当重名者就是它自己时才安全）。`);
    }

    const src = readJsonFile(srcPath);
    if (!src) return bad(`模板配置解析失败：${srcPath}`);
    const blank = { ...src };
    // 目标文件：复制模板但清掉任务表之外的运行痕迹（NextTaskId 与逐步完成计数）
    blank.Name = name;
    blank.NextTaskId = '';
    if (typeof blank.AutoBossCompletedRunCount === 'number') blank.AutoBossCompletedRunCount = 0;

    const changes = [`Name: ${JSON.stringify(src.Name)} → ${JSON.stringify(name)}`, `文件: ${name}.json（模板 ${from}.json）`];
    if (Array.isArray(args.tasks) && args.tasks.length) changes.push(`任务顺序: [${(src.TaskOrder || []).map((id) => (src.TaskDefinitions && src.TaskDefinitions[id]) || id).join(' → ')}] → [${args.tasks.join(' → ')}]`);

    if (args.dry_run) return ok(`（dry_run，未写入）将创建 ${newPath}：\n${changes.map((c) => '  ' + c).join('\n')}`);

    const bkDir = path.join(BGI_ROOT, `_backup_${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_')}`);
    mkdirSync(bkDir, { recursive: true });
    writeFileSync(path.join(bkDir, `${name}.json`), JSON.stringify(existsSync(newPath) ? readJsonFile(newPath) : null, null, 2), 'utf8');
    writeJsonFile(newPath, blank);
    const after = readJsonFile(newPath);
    const order = (after.TaskOrder || []).map((id) => (after.TaskDefinitions && after.TaskDefinitions[id]) || id);

    const lines = [`✓ 已创建一条龙配置「${name}」`, `  文件：${newPath}`, `  Name 字段：${after.Name}（命令行按它匹配）`, `  当前任务：${order.join(' → ')}`];

    // 需要设置任务顺序时，直接复用 bgi_set_onedragon（同一套校验与备份逻辑）
    if (Array.isArray(args.tasks) && args.tasks.length) {
      lines.push('', `  正在按指定顺序设置任务…`);
      const r = await HANDLERS.bgi_set_onedragon({ config: name, tasks: args.tasks });
      const txt = (r.content && r.content[0] && r.content[0].text) || '';
      lines.push(txt);
      if (r.isError) return bad(lines.join('\n'));
    }
    lines.push('', `触发：bgi_run_one_dragon {config:"${name}"}（或 BetterGI.exe startOneDragon ${name}）`);
    lines.push(`切换每天 09:00 的计划任务到它：把包装器参数改成 -ConfigName ${name}（或让我帮你改计划任务动作）。`);
    return ok(lines.join('\n'));
  },

  async bgi_set_config(args) {
    const list = Array.isArray(args.changes) ? args.changes : [];
    if (!list.length) return bad('changes 不能为空');
    for (const c of list) {
      if (!c || typeof c.path !== 'string' || !c.path.includes('.') || c.value === undefined) {
        return bad(`changes 项需要 {path:"父.子", value:...}，收到：${JSON.stringify(c)}`);
      }
    }
    // 注意：bgi-config.ps1 的 -Set 是 [string[]]，脚本按**数组元素**逐个解析 `父.子=值`。
    // 早期这里用 join(',') 拼成一个字符串 → 多改动调用会被脚本判为"格式错误"（2026-10-16 修）。
    const sets = list.map((c) => `${c.path.trim()}=${c.value}`);
    const a = ['-Set', sets];
    if (args.dry_run) a.push('-DryRun');
    return runScriptOrReport(args.dry_run ? '预览配置修改' : '写入配置', 'bgi-config.ps1', a, 90000);
  },

  async bgi_list_strategies(args) {
    const a = args.team ? ['-Simulate', args.team] : ['-List'];
    return runScriptOrReport('战斗策略', 'bgi-strategy.ps1', a, 90000);
  },

  async bgi_list_groups() {
    return runScriptOrReport('配置组列表', 'bgi-group.ps1', ['-List'], 60000);
  },

  async bgi_create_group(args) {
    const type = args.type || 'Pathing';
    const out = [];
    for (const t of args.targets) {
      let target = String(t);
      if (type === 'Pathing' && args.folder && !target.includes('/') && !target.includes('\\')) {
        target = `${args.folder}/${target}`;
      }
      const r = await callScript('bgi-group.ps1', ['-Name', args.name, '-Type', type, '-Target', target, '-Add'], 60000);
      out.push(`· ${target} → ${r.code === 0 ? 'OK' : `失败(${r.code})`}\n${(r.stdout + r.stderr).trim()}`);
    }
    return ok(`配置组「${args.name}」处理完成：\n${out.join('\n')}`);
  },

  async bgi_list_pathing(args) {
    const a = ['-List'];
    if (args.filter) a.push('-Material', args.filter);
    if (Array.isArray(args.extra_dirs) && args.extra_dirs.length) a.push('-ExtraDirs', args.extra_dirs.join(','));
    return runScriptOrReport('本机路径索引', 'bgi-collect.ps1', a, 90000);
  },

  async bgi_find_routes(args) {
    const kind = args.kind || 'pathing';
    const { index, cached, source } = await getRepoIndex();
    const flat = walkIndex(index.indexes).filter((n) => n.path.startsWith(kind + '/'));
    const { primary, secondary, dirs } = findRoutes(flat, args.material);
    const lines = [`官方仓库检索「${args.material}」（分区 ${kind}，索引${cached ? '来自缓存' : '刚拉取'}${source ? ' ' + source : ''}）`];
    if (primary.length) {
      lines.push(`\n主命中 ${primary.length} 条（位于同名目录下）：`);
      for (const p of primary) lines.push(`  · ${p.path}`);
    }
    if (secondary.length) {
      lines.push(`\n顺路/相关 ${secondary.length} 条（文件名含关键词）：`);
      for (const p of secondary.slice(0, 20)) lines.push(`  · ${p.path}`);
    }
    if (dirs.length) {
      lines.push(`\n相关目录 ${dirs.length} 个：`);
      for (const d of dirs.slice(0, 20)) lines.push(`  · ${d.path}`);
    }
    if (!primary.length && !secondary.length && !dirs.length) lines.push('\n没有找到匹配项——试试更短的关键词，或用 bgi_repo_index 浏览目录。');

    if (args.download && primary.length) {
      lines.push('\n下载结果：');
      let done = 0;
      for (const p of primary) {
        try {
          const r = await downloadRepoFile(p.path, { overwrite: !!args.overwrite });
          lines.push(`  ${r.skipped ? '已存在' : '已下载'} → ${r.dest}`);
          if (!r.skipped) done++;
        } catch (e) { lines.push(`  失败 ${p.path}：${e.message}`); }
      }
      lines.push(`（新下载 ${done} 个文件；BetterGI 会从 User\\AutoPathing 直接读取）`);
    }
    return ok(lines.join('\n'));
  },

  async bgi_repo_index(args) {
    const kind = args.kind || 'pathing';
    const limit = Number(args.limit ?? 80);
    const { index, cached } = await getRepoIndex();
    let flat = walkIndex(index.indexes).filter((n) => n.path.startsWith(kind + '/'));
    if (args.filter) flat = flat.filter((n) => n.path.includes(args.filter));
    const dirs = flat.filter((n) => n.type === 'directory');
    const files = flat.filter((n) => n.type === 'file');
    const out = [`官方仓库分区 ${kind}：目录 ${dirs.length} 个 / 文件 ${files.length} 个（索引${cached ? '来自缓存' : '刚拉取'}）`];
    if (args.filter) {
      out.push('\n目录：');
      for (const d of dirs.slice(0, limit)) out.push(`  · ${d.path}`);
      out.push('文件：');
      for (const f of files.slice(0, limit)) out.push(`  · ${f.path}`);
    } else {
      out.push('\n顶层目录：');
      for (const d of flat.filter((n) => n.path.split('/').length === 2 && n.type === 'directory')) out.push(`  · ${d.name}`);
      out.push('\n（加 filter 参数可按关键词深入查看）');
    }
    return ok(out.join('\n'));
  },

  async bgi_list_js_scripts(args) {
    const { index, cached } = await getRepoIndex();
    const flat = walkIndex(index.indexes).filter((n) => n.path.startsWith('js/') && n.type === 'directory');
    const top = flat.filter((n) => n.path.split('/').length === 2);
    let list = top;
    if (args.filter) list = top.filter((n) => n.path.includes(args.filter));
    const out = [`官方仓库 JS 脚本：${top.length} 个（索引${cached ? '来自缓存' : '刚拉取'}）${args.filter ? `，关键词「${args.filter}」命中 ${list.length} 个` : ''}`];
    for (const n of list.slice(0, 60)) out.push(`  · ${n.path.replace('js/', '')}`);
    if (list.length > 60) out.push(`  …… 还有 ${list.length - 60} 个，请加 filter 缩小范围`);
    if (args.detail) {
      const name = String(args.detail);
      try {
        const txt = await httpText(REPO_RAW + encodeRepoPath(`repo/js/${name}/manifest.json`));
        const m = JSON.parse(txt);
        out.push(`\n【${name}】manifest.json：`);
        out.push(`  名称: ${m.name || ''}`);
        out.push(`  作者: ${m.author || ''}   版本: ${m.version || ''}`);
        out.push(`  说明: ${m.description || ''}`);
        if (m.tags) out.push(`  标签: ${Array.isArray(m.tags) ? m.tags.join(',') : m.tags}`);
      } catch (e) {
        out.push(`\n⚠ 拉取 ${name}/manifest.json 失败：${e.message}`);
      }
    } else {
      out.push('\n（加 detail:"<脚本名>" 可看它的名称与说明）');
    }
    return ok(out.join('\n'));
  },

  async bgi_install_js(args) {
    const name = String(args.name || '').trim();
    if (!name) return bad('name 不能为空');
    const destRoot = path.join(BGI_ROOT, 'User', 'JsScript', name);
    let res;
    try {
      res = await installRepoFolder(`repo/js/${name}`, destRoot, { overwrite: !!args.overwrite });
    } catch (e) {
      return bad(`安装失败：${e.message}\n（可用 bgi_list_js_scripts 查看确切的目录名）`);
    }
    const manifest = path.join(destRoot, 'manifest.json');
    const lines = [`JS 脚本「${name}」→ ${destRoot}`];
    for (const f of res.files) lines.push(`  ${f.skipped ? '已存在' : '已下载'}  ${f.path.replace(`repo/js/${name}/`, '')}  (${f.size} B)`);
    lines.push(existsSync(manifest) ? `✓ manifest.json 就位（BetterGI 靠它识别 JS 脚本）` : `✗ 缺 manifest.json —— 该目录可能不是标准 JS 脚本`);
    lines.push(`下一步：bgi_run_js {name:"${name}"}（建组并可选执行）`);
    return ok(lines.join('\n'));
  },

  async bgi_run_js(args) {
    const name = String(args.name || '').trim();
    if (!name) return bad('name 不能为空');
    const destRoot = path.join(BGI_ROOT, 'User', 'JsScript', name);
    const manifest = path.join(destRoot, 'manifest.json');
    const out = [];
    if (!existsSync(manifest)) {
      try {
        const res = await installRepoFolder(`repo/js/${name}`, destRoot, { overwrite: !!args.overwrite });
        out.push(`已安装 ${res.files.filter((f) => !f.skipped).length}/${res.files.length} 个文件 → ${destRoot}`);
      } catch (e) {
        return bad(`脚本未安装且下载失败：${e.message}`);
      }
    } else {
      out.push(`脚本已就位：${destRoot}`);
    }
    if (!existsSync(manifest)) return bad(`仍然缺少 manifest.json —— 目录名可能不对（用 bgi_list_js_scripts 查）`);

    // JS 项目：folderName = User\JsScript 下的目录名；name 仅作显示（源码 ScriptProject(folderName) 会去读该目录的 manifest.json）
    const proj = { name, folderName: name, type: 'Javascript', status: 'Enabled', schedule: 'Daily', runNum: 1, allowJsNotification: true };
    const g = writeGroup(name, [proj], { merge: true });
    out.push(`配置组「${name}」已就绪（${g.count} 个项目）：${g.path}`);

    if (args.run) {
      const st = await statusBrief();
      if ((st?.blockers || []).some((b) => /BetterGI 正在运行/.test(b))) {
        out.push('⛔ 未触发：BetterGI 已在运行（--startGroups 只会被转发）。请先退出 BetterGI。');
      } else {
        const r = await callScript('bgi-run.ps1', ['-Mode', 'groups', '-Name', name], 60000);
        const body = (r.stdout + r.stderr).trim();
        out.push(r.code === 0 ? `✓ 已触发：\n${body}` : `✗ 触发失败（${r.code}）：\n${body}`);
        out.push('下一步：bgi_watch {mode:"groups"} 观察（可 wait_seconds:50 轮询）。');
      }
      return withPreflight(ok(out.join('\n')), preflightLines(st));
    }
    out.push(`触发命令：bgi_run_groups {groups:["${name}"]}`);
    out.push(`接进每日流程：bgi_add_group_to_onedragon {group:"${name}", confirm:true}（需用户同意）`);
    return ok(out.join('\n'));
  },

  async bgi_add_group_to_onedragon(args) {
    const group = String(args.group || '').trim();
    if (!group) return bad('group 不能为空');
    if (args.confirm !== true) {
      return bad('⚠ 这会改变每日一条龙的执行内容。确认后请带 confirm:true 重新调用。\n' +
        `（要加入的配置组：${group}；配置：${args.config || '日常'}；位置：${args.position || 'end'}）`);
    }
    const cfgName = args.config || '日常';
    const cfgPath = path.join(BGI_ROOT, 'User', 'OneDragon', `${cfgName}.json`);
    const groupFile = path.join(BGI_ROOT, 'User', 'ScriptGroup', `${group}.json`);
    if (!existsSync(cfgPath)) return bad(`找不到一条龙配置：${cfgPath}`);
    if (!existsSync(groupFile)) return bad(`找不到配置组：${groupFile}`);
    const cfg = readJsonFile(cfgPath);
    if (!cfg) return bad(`一条龙配置解析失败：${cfgPath}`);

    // 备份
    const bkDir = path.join(BGI_ROOT, `_backup_${new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '_')}`);
    mkdirSync(bkDir, { recursive: true });
    writeFileSync(path.join(bkDir, `${cfgName}.json`), JSON.stringify(cfg, null, 2), 'utf8');

    cfg.TaskDefinitions = cfg.TaskDefinitions || {};
    cfg.TaskEnabledList = cfg.TaskEnabledList || {};
    cfg.TaskOrder = Array.isArray(cfg.TaskOrder) ? cfg.TaskOrder : [];
    const existing = Object.entries(cfg.TaskDefinitions).find(([, v]) => v === group);
    let guid = existing ? existing[0] : null;
    if (!guid) {
      guid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        const v = c === 'x' ? r : (r & 0x3) | 0x8;
        return v.toString(16);
      });
      cfg.TaskDefinitions[guid] = group;
      cfg.TaskEnabledList[guid] = true;
      const pos = String(args.position || 'end');
      if (pos.startsWith('before:')) {
        const target = pos.slice(7).trim();
        const idx = cfg.TaskOrder.findIndex((id) => cfg.TaskDefinitions[id] === target);
        if (idx >= 0) cfg.TaskOrder.splice(idx, 0, guid);
        else cfg.TaskOrder.push(guid);
      } else {
        cfg.TaskOrder.push(guid);
      }
    } else if (cfg.TaskEnabledList[guid] !== true) {
      cfg.TaskEnabledList[guid] = true;
      if (!cfg.TaskOrder.includes(guid)) cfg.TaskOrder.push(guid);
    } else {
      return ok(`配置组「${group}」已经在一条龙「${cfgName}」里了，未改动。`);
    }
    writeJsonFile(cfgPath, cfg);
    const order = cfg.TaskOrder.map((id) => cfg.TaskDefinitions[id] || id);
    return ok(`✓ 已把配置组「${group}」接入一条龙「${cfgName}」\n  备份：${bkDir}\\${cfgName}.json\n  新顺序：${order.join(' → ')}\n` +
      `⚠ 该文件会被运行中的 BetterGI 回写覆盖——请确保当时 BetterGI 未运行（本次已确认）。\n` +
      `撤销：把备份覆盖回去，或在界面里取消勾选。`);
  },

  async bgi_collect_material(args) {
    const material = String(args.material || '').trim();
    if (!material) return bad('material 不能为空');
    const { index, cached } = await getRepoIndex();
    const flat = walkIndex(index.indexes);
    const { primary, secondary } = findRoutes(flat, material);
    if (!primary.length) {
      return bad(
        `官方仓库里没有位于「${material}」同名目录下的路线。` +
        (secondary.length ? `\n顺路命中（文件名含该关键词）${secondary.length} 条：\n` + secondary.slice(0, 10).map((p) => '  · ' + p.path).join('\n') : '') +
        `\n\n可用 bgi_repo_index / bgi_find_routes 换关键词再试；也可以自己录制路线（游戏内「路径记录」）。`,
      );
    }

    const lines = [`材料「${material}」：命中 ${primary.length} 条路线（索引${cached ? '来自缓存' : '刚拉取'}）`];
    let totalPoints = 0;
    let invalid = 0;
    for (const p of primary) {
      try {
        const r = await downloadRepoFile(p.path, { overwrite: !!args.overwrite });
        // 落地后立刻校验：必须是带 info + positions 的合法地图追踪文件
        let points = 0;
        let okFile = false;
        try {
          const j = JSON.parse(readFileSync(r.dest, 'utf8').replace(/^\uFEFF/, ''));
          points = Array.isArray(j.positions) ? j.positions.length : 0;
          okFile = !!(j.info && points > 0);
        } catch { okFile = false; }
        if (okFile) totalPoints += points; else invalid++;
        lines.push(`  ${r.skipped ? '已存在' : '已下载'}  ${p.name}　${okFile ? `✓ ${points} 个路径点` : '✗ 文件结构异常'}`);
      } catch (e) {
        invalid++;
        lines.push(`  失败 ${p.path}：${e.message}`);
      }
    }
    if (invalid) lines.push(`⚠ 有 ${invalid} 条未能就绪，采集可能不完整。`);
    else lines.push(`✓ 全部就绪，合计 ${totalPoints} 个路径点。`);

    // 目录里的非 JSON 附属文件（官方目录通常带 icon.ico；个别目录带 control.json5 —— 同目录控制文件会被
    // JsonMerger.getMergePathingJson 合并进路线参数，缺了就丢覆盖规则）。这里一并补齐，desktop.ini 跳过。
    try {
      const tree = await getRepoTree();
      const segs0 = primary[0].path.split('/');            // 索引路径不带 repo/ 前缀（如 pathing/地方特产/…/星螺/x.json）
      const folderIdx = segs0.slice(0, segs0.length - 1).join('/');
      const folderRepo = folderIdx.startsWith('repo/') ? folderIdx : `repo/${folderIdx}`;  // 而树路径带 repo/ 前缀
      const siblings = (tree.tree || [])
        .filter((t) => t.type === 'blob' && (t.path.startsWith(folderRepo + '/')))
        .map((t) => t.path.slice(folderRepo.length + 1))
        .filter((n) => !n.includes('/') && !n.toLowerCase().endsWith('.json') && n.toLowerCase() !== 'desktop.ini');
      if (siblings.length) {
        const extra = [];
        for (const n of siblings) {
          try {
            // 用索引风格路径（pathing/…）→ 目的地映射由 REPO_MAP 决定；二进制走 downloadRepoBinary
            const r = await downloadRepoBinary(`${folderIdx}/${n}`, { overwrite: !!args.overwrite });
            extra.push(`${r.skipped ? '已存在' : '已下载'} ${n}（${r.size} B）`);
          } catch (e) { extra.push(`失败 ${n}：${e.message}`); }
        }
        lines.push(`  附属文件：${extra.join('；')}`);
      }
    } catch { /* 附属文件拿不到不影响主流程 */ }

    const projects = primary.map((p) => {
      const segs = p.path.split('/');
      const fileName = segs[segs.length - 1];
      const folderName = segs.slice(1, segs.length - 1).join('\\'); // 去掉顶层 pathing
      return { name: fileName, folderName, type: 'Pathing', status: 'Enabled', schedule: 'Daily', runNum: 1 };
    });
    const groupName = `采集-${material}`;
    const g = writeGroup(groupName, projects, { merge: true });
    lines.push(`\n配置组「${groupName}」已就绪（${g.count} 个项目）：${g.path}`);

    if (args.run) {
      const st = await statusBrief();
      if ((st?.blockers || []).some((b) => /BetterGI 正在运行/.test(b))) {
        lines.push('\n⛔ 未触发：BetterGI 已在运行，`--startGroups` 只会被转发、不会执行。请先退出 BetterGI，或用包装器 _daily_runner.ps1。');
      } else {
        const r = await callScript('bgi-run.ps1', ['-Mode', 'groups', '-Name', groupName], 60000);
        const body = (r.stdout + r.stderr).trim();
        if (r.code === 0) lines.push(`\n✓ 已触发执行：\n${body}`);
        else lines.push(`\n✗ 触发失败（退出码 ${r.code}）：\n${body}`);
        lines.push('下一步：bgi_watch {mode:"groups"} 观察结果（可 wait_seconds:50 轮询）。');
      }
      return withPreflight(ok(lines.join('\n')), preflightLines(st));
    }
    lines.push(`\n触发命令：bgi_run_groups(["${groupName}"])（或本工具 run=true 一步到位）`);
    lines.push('（执行期间请保持原神窗口可见且前台，勿锁屏）');
    return ok(lines.join('\n'));
  },
};

// ─────────────────────────── JSON-RPC / stdio ───────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function sendResult(id, result) { send({ jsonrpc: '2.0', id, result }); }
function sendError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

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
  if (method === 'ping') { sendResult(id, {}); return; }
  if (method === 'tools/list') { sendResult(id, { tools: TOOLS }); return; }
  // 未声明的能力也给出空列表而非错误：部分客户端会主动探测，报错会污染日志
  if (method === 'resources/list') { sendResult(id, { resources: [] }); return; }
  if (method === 'resources/templates/list') { sendResult(id, { resourceTemplates: [] }); return; }
  if (method === 'prompts/list') { sendResult(id, { prompts: [] }); return; }
  if (method === 'logging/setLevel') { sendResult(id, {}); return; }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const fn = HANDLERS[name];
    if (!fn) { sendError(id, -32602, `未知工具：${name}`); return; }
    try {
      const result = await fn(args);
      sendResult(id, result);
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
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch (e) { log('无法解析输入行：', line.slice(0, 200)); continue; }
    handle(msg).catch((e) => log('handle error', String(e)));
  }
});
process.stdin.on('end', () => process.exit(0));
log(`已启动：root=${BGI_ROOT} skill=${SKILL_DIR} tools=${TOOLS.length}`);
