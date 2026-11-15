#!/usr/bin/env node
/**
 * m7a-mcp.mjs — 「三月七小助手 / March7thAssistant / M7A」MCP stdio 服务端（dsh-game-daily 自带）
 *
 * 用途：把崩坏：星穹铁道的日常自动化交给小助手。智能体只做「查状态 → 选任务 → 发起 → 跟进 → 报结果」，
 *       不自己点游戏；所有动作都通过安装目录里的 m7a.exe（官方给脚本 / AI 用的命令行，无需管理员权限）执行。
 *
 * 传输：stdio，按行分帧的 JSON-RPC 2.0（MCP）。零第三方依赖，Node ≥20，ESM 单文件。
 * 注册：dsh-game-daily 的 headless overlay 里 serverName=m7a → 工具名形如 mcp__m7a__m7a_status
 *
 * 安装目录解析顺序（逐项验证目录里有 m7a.exe）：
 *   1. env DSH_GAME_DAILY_M7A_ROOT
 *   2. <stateDir>/m7a-root.txt（stateDir = env DSH_GAME_DAILY_STATE_DIR 或 %USERPROFILE%\.dsh\game-daily）
 *   3. %LOCALAPPDATA%\March7thAssistant\installs.json（容错：数组或 {installs:[]}；元素字段 path/install_path/root/dir）
 *   4. 常见候选：%USERPROFILE%\Games\March7thAssistant、D:\March7thAssistant、E:\software\March7thAssistant
 *
 * 官方事实（assets/docs/Agent.md 与 assets/agent/skills/march7th-assistant/SKILL.md）：
 *   - 查询：m7a.exe --status --json / --list --json
 *   - 运行：m7a.exe <taskId> --after-finish None [--json] [--detach]
 *   - 跟进：m7a.exe --follow latest|<runId>
 *   - 控制：m7a.exe --control current pause|resume|stop
 *   - 记录：logs\runs\<运行编号>.json / .log；当天日志 logs\yyyy-MM-dd.log
 *   - 退出码：0 成功 / 1 任务失败 / 2 参数错误 / 3 首次未确认（用户本人去 GUI 确认）/
 *             4 已有任务在跑 / 5 UAC 被取消 / 6 被停止指令中止
 *
 * 约定：
 *   - 运行类命令一律带 --after-finish None（防止用户配置的关机 / 睡眠被执行）；
 *   - 单次工具输出 < 8KB，日志只回末尾若干行；
 *   - 所有工具返回 {ok, ...}，失败带 error 与 hint，绝不以未捕获异常结束进程。
 */

import { spawn } from 'node:child_process';
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER_INFO = { name: 'm7a-mcp', version: '0.1.0' };
const PROTOCOL_VERSION = '2024-11-05';
/** 单次返回给客户端的文本上限（字节）。MCP 客户端与上下文都受不了大段日志。 */
const MAX_TEXT_BYTES = 7600;
/** 官方要求：AI 发起任务时默认不执行用户配置的「完成后操作」。 */
const AFTER_FINISH_SAFE = ['--after-finish', 'None'];

const EXIT_MEANINGS = {
  0: '成功',
  1: '任务失败',
  2: '参数错误',
  3: '首次使用尚未确认免责声明（必须由用户本人在图形界面里确认）',
  4: '已有任务在运行，本次未执行',
  5: '没有获得管理员权限（UAC 被取消）',
  6: '任务被停止指令中止',
};

const EXIT_HINTS = {
  1: '看运行记录的 error / screenshot，以及 logs\\runs\\<运行编号>.log 末尾；再按 March7thAssistant 的 troubleshooting 文档排查。',
  2: '参数不被 m7a.exe 接受，可能是版本较旧；先 `m7a.exe --help` 看可用参数，或在图形界面检查更新。',
  3: '请用户本人打开 March7th Launcher.exe（图形界面），阅读并确认免责声明；AI 不得代为确认，也不能改文件绕过。',
  4: '已有任务在操控游戏；用 m7a_status / m7a_follow latest 跟进，或等它结束后再发起。',
  5: '任务需要管理员权限：让用户在 UAC 弹窗点「是」；用户不在电脑前就改用小助手自己的定时任务（scheduled_tasks）。',
  6: '任务被停止指令中止；按用户意图决定是否重跑。',
};

/** m7a_config_set 只允许这些顶层键（都是官方 config.yaml 里的顶层键）。体力用途相关键用于落实「只刷培养角色的材料/遗器」。 */
const CONFIG_WRITE_KEYS = [
  'game_path',
  'after_finish',
  'daily_enable',
  'power_enable',
  'auto_set_resolution_enable',
  'auto_set_game_path_enable',
  'pause_after_success',
  'exit_after_failure',
  'instance_type',
  'activity_gardenofplenty_instance_type',
  'build_target_enable',
  'echo_of_war_enable',
  'power_plan_keep',
];
const CONFIG_WRITE_SET = new Set(CONFIG_WRITE_KEYS);
const CONFIG_BOOL_KEYS = new Set([
  'daily_enable',
  'power_enable',
  'auto_set_resolution_enable',
  'auto_set_game_path_enable',
  'pause_after_success',
  'exit_after_failure',
  'build_target_enable',
  'echo_of_war_enable',
  'power_plan_keep',
]);
/** m7a_config_get 不给 keys 时返回的默认子集（另加 scheduled_tasks 数量）。 */
const CONFIG_DEFAULT_KEYS = [
  'game_path',
  'after_finish',
  'daily_enable',
  'power_enable',
  'auto_set_resolution_enable',
  'auto_set_game_path_enable',
  'instance_type',
  'activity_gardenofplenty_instance_type',
  'build_target_enable',
  'echo_of_war_enable',
];
const AFTER_FINISH_VALUES = [
  'None',
  'Exit',
  'Loop',
  'Shutdown',
  'Sleep',
  'Hibernate',
  'Restart',
  'Logoff',
  'TurnOffDisplay',
  'RunScript',
];

const log = (...a) => process.stderr.write(`[m7a-mcp] ${a.map(String).join(' ')}\n`);
const errText = (e) => (e && e.message ? e.message : String(e));

// ─────────────────────────── 安装目录解析 ───────────────────────────

function stateDir() {
  return process.env.DSH_GAME_DAILY_STATE_DIR || path.join(os.homedir(), '.dsh', 'game-daily');
}

/** 允许用户把路径写成带引号的形式；如果直接指向 exe 就取所在目录。 */
function normalizeRootPath(input) {
  let p = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!p) return '';
  try {
    p = path.resolve(p);
  } catch {
    return '';
  }
  if (/\.exe$/i.test(p)) p = path.dirname(p);
  return p;
}

function inspectRoot(dir) {
  const root = normalizeRootPath(dir);
  if (!root) return null;
  const exe = path.join(root, 'm7a.exe');
  if (!existsSync(exe)) return null;
  return {
    root,
    source: null,
    exe,
    config: path.join(root, 'config.yaml'),
    runsDir: path.join(root, 'logs', 'runs'),
  };
}

/** installs.json 的元素可能是字符串，也可能是对象，字段名各版本略有差异。 */
function installEntries(data) {
  const out = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim()) {
      out.push(value.trim());
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const key of ['path', 'install_path', 'installPath', 'root', 'dir', 'directory', 'location', 'folder']) {
      const v = value[key];
      if (typeof v === 'string' && v.trim()) {
        out.push(v.trim());
        return;
      }
    }
  };
  if (Array.isArray(data)) {
    data.forEach(push);
    return out;
  }
  if (!data || typeof data !== 'object') return out;
  let list = null;
  for (const key of ['installs', 'installs_list', 'installations', 'items', 'list', 'paths', 'data']) {
    if (Array.isArray(data[key])) {
      list = data[key];
      break;
    }
  }
  if (!list) {
    for (const v of Object.values(data)) {
      if (Array.isArray(v)) {
        list = v;
        break;
      }
    }
  }
  if (list) list.forEach(push);
  else if (typeof data.path === 'string') push(data);
  return out;
}

function resolveRoot() {
  const searched = [];
  const withoutExe = [];

  const consider = (candidate, source) => {
    const found = inspectRoot(candidate);
    if (found) {
      found.source = source;
      return found;
    }
    const dir = normalizeRootPath(candidate);
    searched.push({ source, path: dir || String(candidate) });
    if (dir && existsSync(dir)) withoutExe.push(dir);
    return null;
  };

  // 1) 环境变量
  const fromEnv = process.env.DSH_GAME_DAILY_M7A_ROOT;
  if (fromEnv) {
    const found = consider(fromEnv, 'env:DSH_GAME_DAILY_M7A_ROOT');
    if (found) return { ok: true, ...found };
  } else {
    searched.push({ source: 'env:DSH_GAME_DAILY_M7A_ROOT', path: '(未设置)' });
  }

  // 2) 状态目录里的安装书签
  const pointerPath = path.join(stateDir(), 'm7a-root.txt');
  try {
    const pointer = readFileSync(pointerPath, 'utf8').trim();
    if (pointer) {
      const found = consider(pointer, `pointer:${pointerPath}`);
      if (found) return { ok: true, ...found };
    } else {
      searched.push({ source: `pointer:${pointerPath}`, path: '(空文件)' });
    }
  } catch {
    searched.push({ source: `pointer:${pointerPath}`, path: '(不存在)' });
  }

  // 3) 小助手自己登记的安装清单
  const installsPath = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'March7thAssistant', 'installs.json');
  try {
    const raw = readFileSync(installsPath, 'utf8').replace(/^\uFEFF/, '');
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      searched.push({ source: 'installs.json', path: installsPath });
    } else {
      const entries = installEntries(parsed);
      if (!entries.length) searched.push({ source: 'installs.json', path: installsPath });
      for (const entry of entries) {
        const found = consider(entry, 'installs.json');
        if (found) return { ok: true, ...found };
      }
    }
  } catch {
    searched.push({ source: 'installs.json', path: installsPath });
  }

  // 4) 常见候选
  const home = os.homedir();
  for (const candidate of [
    path.join(home, 'Games', 'March7thAssistant'),
    'D:\\March7thAssistant',
    'E:\\software\\March7thAssistant',
  ]) {
    const found = consider(candidate, 'candidate');
    if (found) return { ok: true, ...found };
  }

  const result = {
    ok: false,
    error: 'M7A_NOT_INSTALLED',
    searched,
    hint:
      '没找到带 m7a.exe 的三月七小助手安装目录。安装目录可通过环境变量 DSH_GAME_DAILY_M7A_ROOT 指定，' +
      '或写进 ' + pointerPath + '；先启动过一次 March7th Launcher.exe 也会自动登记。' +
      '另外：真的装了但没有 m7a.exe，说明版本较旧（AI 助手功能随 m7a.exe 一起加入），先在图形界面检查更新。',
  };
  if (withoutExe.length) result.found_without_m7a_exe = withoutExe.slice(0, 5);
  return result;
}

// ─────────────────────────── 进程与文本工具 ───────────────────────────

/**
 * 执行 m7a.exe。
 * timeout 时：默认 kill；leaveOnTimeout=true 时保留进程（官方说明「命令超时不会中断任务」）。
 */
function runExe(root, args, opts = {}) {
  const { timeoutMs = 30000, leaveOnTimeout = false, maxCaptured = 200000 } = opts;
  const exe = path.join(root, 'm7a.exe');
  if (!existsSync(exe)) {
    return Promise.resolve({ ok: false, error: 'M7A_EXE_MISSING', exe, args, stdout: '', stderr: '' });
  }
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(exe, args, { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, error: 'M7A_SPAWN_FAILED', spawnError: errText(e), exe, args, stdout: '', stderr: '' });
      return;
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const cap = (s, chunk) => (s.length >= maxCaptured ? s : s + chunk.slice(0, maxCaptured - s.length));
    child.stdout.on('data', (d) => {
      stdout = cap(stdout, d.toString('utf8'));
    });
    child.stderr.on('data', (d) => {
      stderr = cap(stderr, d.toString('utf8'));
    });
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      if (!leaveOnTimeout) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
      } else {
        try {
          child.unref();
        } catch {
          /* ignore */
        }
      }
      resolve({
        ok: false,
        timedOut: true,
        stillRunning: leaveOnTimeout,
        pid: child.pid,
        exe,
        args,
        stdout,
        stderr,
      });
    }, timeoutMs);
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: false, error: 'M7A_SPAWN_FAILED', spawnError: errText(e), exe, args, stdout, stderr });
    });
    child.on('close', (code, signal) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok: code === 0, exitCode: code, signal: signal || null, exe, args, stdout, stderr });
    });
  });
}

/** 从一段文本里抠出第一个平衡的 JSON 对象 / 数组（m7a 的 JSON 前后可能夹日志行）。 */
function extractBalanced(text, open, close) {
  const start = text.indexOf(open);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 继续尝试 */
  }
  const obj = extractBalanced(trimmed, '{', '}');
  if (obj !== null) return obj;
  const arr = extractBalanced(trimmed, '[', ']');
  if (arr !== null) return arr;
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 8; i -= 1) {
    try {
      return JSON.parse(lines[i].trim());
    } catch {
      /* ignore */
    }
  }
  return null;
}

const stripAnsi = (s) => String(s || '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

/** 末尾 n 行，每行截断，避免把整份日志塞进上下文。 */
function tailText(text, n, perLine = 700) {
  const lines = stripAnsi(text).split(/\r\n|\r|\n/);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const picked = lines.slice(-Math.max(1, n));
  return picked.map((line) => (line.length > perLine ? `${line.slice(0, perLine)}…` : line));
}

/** 只读文件末尾一块（大日志也不整份读进内存）。 */
function readTailBytes(file, maxBytes = 256 * 1024) {
  const fd = openSync(file, 'r');
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - maxBytes);
    const length = size - start;
    if (length <= 0) return '';
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, start);
    let text = buf.toString('utf8');
    if (start > 0) {
      const nl = text.indexOf('\n');
      text = nl >= 0 ? text.slice(nl + 1) : '';
    }
    return text;
  } finally {
    closeSync(fd);
  }
}

function tailFile(file, n, perLine = 700) {
  return tailText(readTailBytes(file), n, perLine);
}

function readJsonLoose(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function clampInt(value, def, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-` +
    `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${p(d.getMilliseconds(), 3)}`
  );
}

function todayYmd() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const pick = (obj, keys) => {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
};

function asBool(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (/^(true|1|yes|on)$/i.test(value.trim())) return true;
    if (/^(false|0|no|off)$/i.test(value.trim())) return false;
  }
  if (typeof value === 'number') return value !== 0;
  return undefined;
}

function clipValue(value, max = 500) {
  if (value === undefined || value === null) return value;
  if (typeof value === 'string') return value.length > max ? `${value.slice(0, max)}…` : value;
  if (typeof value === 'object') {
    try {
      const s = JSON.stringify(value);
      return s.length > max ? `${s.slice(0, max)}…` : value;
    } catch {
      return String(value);
    }
  }
  return value;
}

function briefRun(rec) {
  if (!rec || typeof rec !== 'object') return clipValue(rec);
  const out = {
    run: pick(rec, ['run', 'id', 'run_id', 'runId', 'name']),
    task: pick(rec, ['task', 'task_id', 'taskId', 'task_name']),
    status: pick(rec, ['status', 'state']),
    reason: clipValue(pick(rec, ['reason', 'message']), 300),
    error: clipValue(pick(rec, ['error', 'error_message']), 400),
    exit_code: pick(rec, ['exit_code', 'exitCode']),
    started_at: pick(rec, ['started_at', 'startedAt', 'start_time', 'start']),
    finished_at: pick(rec, ['finished_at', 'finishedAt', 'end_time', 'end', 'ended_at']),
    screenshot: clipValue(pick(rec, ['screenshot', 'screenshot_path']), 300),
    invoker: clipValue(pick(rec, ['invoker']), 120),
  };
  for (const key of Object.keys(out)) if (out[key] === undefined) delete out[key];
  return out;
}

function exitMeaning(code) {
  if (code === null || code === undefined) return null;
  return EXIT_MEANINGS[code] || '未知退出码';
}

function exitHint(code) {
  return code === null || code === undefined ? undefined : EXIT_HINTS[code];
}

// ─────────────────────────── 运行编号 / 记录 ───────────────────────────

function isRunRef(value) {
  return typeof value === 'string' && /^[^\\/]+$/.test(value) && value !== '.' && value !== '..';
}

function isLatestRef(value) {
  return !value || /^(latest|current|last)$/i.test(String(value).trim());
}

/** 解析「运行编号」：latest 取 logs\runs 里最新的记录；也接受显式编号。 */
function resolveRunId(root, wanted) {
  const raw = typeof wanted === 'string' ? wanted.trim() : '';
  if (raw && !isLatestRef(raw)) {
    if (!isRunRef(raw)) return null;
    return raw.replace(/\.(json|log)$/i, '');
  }
  const runsDir = path.join(root, 'logs', 'runs');
  let files;
  try {
    files = readdirSync(runsDir);
  } catch {
    return null;
  }
  const jsonFiles = files.filter((f) => /\.json$/i.test(f));
  const pool = jsonFiles.length ? jsonFiles : files.filter((f) => /\.log$/i.test(f));
  if (!pool.length) return null;
  let best = pool[0];
  let bestMtime = -Infinity;
  for (const file of pool) {
    try {
      const mtime = statSync(path.join(runsDir, file)).mtimeMs;
      if (mtime > bestMtime) {
        bestMtime = mtime;
        best = file;
      }
    } catch {
      /* ignore */
    }
  }
  return best.replace(/\.(json|log)$/i, '');
}

function runPaths(root, runId) {
  const runsDir = path.join(root, 'logs', 'runs');
  return {
    runsDir,
    json: path.join(runsDir, `${runId}.json`),
    log: path.join(runsDir, `${runId}.log`),
    screenshot: pick(readJsonLoose(path.join(runsDir, `${runId}.json`)) || {}, ['screenshot', 'screenshot_path']),
  };
}

function runNotFound(run, root, extra = {}) {
  return {
    ok: false,
    error: 'RUN_NOT_FOUND',
    run,
    runs_dir: path.join(root, 'logs', 'runs'),
    hint: '还没跑过任务，或运行编号不对。先 m7a_run 发起一次，再用 m7a_status 的 recent_runs 找编号。',
    ...extra,
  };
}

// ─────────────────────────── config.yaml 读写 ───────────────────────────

/** 返回 { lines, entries: Map<key,{value,trailing,lineIndex,raw}> }，只收顶层键。 */
function scanConfig(text) {
  const lines = text.split(/\r?\n/);
  const entries = new Map();
  lines.forEach((line, index) => {
    if (!line || /^\s/.test(line) || line.trimStart().startsWith('#')) return;
    const m = /^([A-Za-z0-9_]+)\s*:\s*(.*)$/.exec(line);
    if (!m) return;
    const rest = m[2];
    const split = splitInlineComment(rest);
    entries.set(m[1], { value: split.value, trailing: split.trailing, lineIndex: index, raw: line });
  });
  return { lines, entries };
}

/** 拆出行内注释：只认引号外、前面是空白的 #。trailing 原样保留「值后面的空白 + 注释」。 */
function splitInlineComment(rest) {
  let inString = false;
  let quote = '';
  let escaped = false;
  const startIdx = rest.length - rest.trimStart().length;
  const endOfValue = (end) => {
    let idx = end;
    while (idx > startIdx && /\s/.test(rest[idx - 1])) idx -= 1;
    const value = rest.slice(startIdx, idx);
    let trailing = rest.slice(idx);
    if (trailing.startsWith('#')) trailing = ` ${trailing}`;
    return { value, trailing };
  };
  for (let i = 0; i < rest.length; i += 1) {
    const ch = rest[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(rest[i - 1]))) {
      return endOfValue(i);
    }
  }
  return endOfValue(rest.length);
}

function decodeScalar(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text);
    } catch {
      return text.slice(1, -1);
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  if (/^(true|false)$/i.test(text)) return text.toLowerCase() === 'true';
  if (/^(null|~)$/i.test(text)) return null;
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  return text;
}

/** 统计 scheduled_tasks 的条目数（块式列表按第一层 `- ` 计，流式列表按顶层逗号计）。 */
function countScheduledTasks(text) {
  const lines = text.split(/\r?\n/);
  const index = lines.findIndex((line) => /^scheduled_tasks\s*:/.test(line));
  if (index < 0) return null;
  const rest = lines[index].replace(/^scheduled_tasks\s*:/, '').trim();
  if (rest && !rest.startsWith('#')) {
    if (rest === '[]' || rest === '~' || rest === 'null') return 0;
    if (!rest.startsWith('[')) return 1;
    let depth = 0;
    let items = 0;
    let inString = false;
    let quote = '';
    let escaped = false;
    for (let i = 0; i < rest.length; i += 1) {
      const ch = rest[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === quote) inString = false;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inString = true;
        quote = ch;
      } else if (ch === '[' || ch === '{') depth += 1;
      else if (ch === ']' || ch === '}') depth -= 1;
      else if (ch === ',' && depth === 1) items += 1;
    }
    return rest.trim() === '[]' ? 0 : items + 1;
  }
  let itemIndent = -1;
  let count = 0;
  for (let i = index + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (!/^\s/.test(line)) break;
    const m = /^(\s*)-\s+/.exec(line);
    if (!m) continue;
    if (itemIndent < 0) itemIndent = m[1].length;
    if (m[1].length === itemIndent) count += 1;
  }
  return count;
}

function normalizeConfigValue(key, value) {
  if (CONFIG_BOOL_KEYS.has(key)) {
    const b = asBool(value);
    if (b === undefined) {
      return { ok: false, error: 'BAD_VALUE', hint: `${key} 只接受布尔值 true / false。`, got: clipValue(value) };
    }
    return { ok: true, text: b ? 'true' : 'false', value: b };
  }
  if (key === 'after_finish') {
    const text = String(value ?? '').trim();
    const canonical = AFTER_FINISH_VALUES.find((v) => v.toLowerCase() === text.toLowerCase());
    if (!canonical) {
      return {
        ok: false,
        error: 'BAD_VALUE',
        hint: `after_finish 只接受：${AFTER_FINISH_VALUES.join(' / ')}。`,
        got: clipValue(value),
      };
    }
    return { ok: true, text: canonical, value: canonical };
  }
  const text = String(value ?? '').trim();
  if (!text) return { ok: false, error: 'BAD_VALUE', hint: `${key} 不能为空。` };
  if (/[\r\n]/.test(text)) return { ok: false, error: 'BAD_VALUE', hint: `${key} 不能包含换行。` };
  if (text.length > 512) return { ok: false, error: 'BAD_VALUE', hint: `${key} 太长（>512 字符）。` };
  // YAML 里 # 前有空白会被当注释；含这种路径时用单引号（单引号内反斜杠不做转义）。
  const needsQuote = /(^#)|(\s#)/.test(text);
  const rendered = needsQuote ? `'${text.replace(/'/g, "''")}'` : text;
  return { ok: true, text: rendered, value: text };
}

// ─────────────────────────── 工具实现 ───────────────────────────

async function toolStatus() {
  const root = resolveRoot();
  if (!root.ok) return root;
  let res = await runExe(root.root, ['--status', '--json'], { timeoutMs: 25000 });
  let fallbackWithoutJson = false;
  // 旧版本的 m7a.exe 可能不认 --json；官方 --status 本身也输出 JSON，退回一次。
  if (res.exitCode === 2) {
    const retry = await runExe(root.root, ['--status'], { timeoutMs: 25000 });
    if (retry.ok || extractJson(retry.stdout)) {
      res = retry;
      fallbackWithoutJson = true;
    }
  }
  if (res.error) {
    return {
      ok: false,
      error: res.error,
      root: root.root,
      hint: '找不到或无法启动 m7a.exe；旧版本请先在图形界面检查更新。',
      searched: [root.root],
    };
  }
  if (res.timedOut) {
    return { ok: false, error: 'M7A_TIMEOUT', root: root.root, hint: 'm7a.exe --status 超时（25s）；检查是否被杀软拦截。' };
  }
  if (res.spawnError) {
    return {
      ok: false,
      error: 'M7A_SPAWN_FAILED',
      root: root.root,
      detail: res.spawnError,
      hint: '无法启动 m7a.exe；确认它不是被安全软件隔离，或改用 March7th Assistant.exe 排查。',
    };
  }

  let data = extractJson(res.stdout);
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const inner = data.data || data.result || data.status;
    const hasOwn = Boolean(pick(data, ['version', 'first_run_completed', 'active_run', 'recent_runs']));
    if (!hasOwn && inner && typeof inner === 'object') data = inner;
  }

  if (!data || typeof data !== 'object') {
    return {
      ok: false,
      error: 'M7A_BAD_OUTPUT',
      root: root.root,
      exit_code: res.exitCode,
      hint: '没从 --status 输出里解析出 JSON；旧版本请先在图形界面检查更新。',
      output_tail: tailText(res.stdout, 20, 400),
      stderr_tail: tailText(res.stderr, 10, 400),
    };
  }

  const recentRaw = pick(data, ['recent_runs', 'recentRuns', 'runs']);
  const recent = Array.isArray(recentRaw) ? recentRaw.slice(0, 5).map(briefRun) : [];
  const status = {
    ok: true,
    root: root.root,
    root_source: root.source,
    version: pick(data, ['version', 'app_version', 'appVersion']),
    first_run_completed: asBool(pick(data, ['first_run_completed', 'firstRunCompleted', 'confirmed'])),
    game_path_exists: asBool(pick(data, ['game_path_exists', 'gamePathExists'])),
    cloud_game_enable: asBool(pick(data, ['cloud_game_enable', 'cloudGameEnable'])),
    gui_running: asBool(pick(data, ['gui_running', 'guiRunning', 'launcher_running', 'launcherRunning'])),
    active_run: pick(data, ['active_run', 'activeRun', 'current_run', 'currentRun']) ?? null,
    recent_runs: recent,
    exit_code: res.exitCode,
  };

  const hints = [];
  if (status.first_run_completed === false) hints.push(EXIT_HINTS[3]);
  if (status.game_path_exists === false && status.cloud_game_enable !== true) {
    hints.push('game_path_exists=false 且没用云游戏：先改 config.yaml 的 game_path（指向 StarRail.exe）或让用户在图形界面里设置。');
  }
  if (status.active_run) hints.push('已有任务在运行（active_run 非空）：不要再发起第二个，用 m7a_follow latest 跟进。');
  if (!status.version && status.first_run_completed === undefined) {
    status.raw_status = clipValue(data, 1200);
  }
  if (fallbackWithoutJson) status.fallback_without_json = true;
  if (hints.length) status.hint = hints.join(' ');
  return status;
}

async function toolList() {
  const root = resolveRoot();
  if (!root.ok) return root;
  const res = await runExe(root.root, ['--list', '--json'], { timeoutMs: 25000 });
  if (res.error) {
    return { ok: false, error: res.error, root: root.root, hint: '找不到或无法启动 m7a.exe。' };
  }
  if (res.timedOut) {
    return { ok: false, error: 'M7A_TIMEOUT', root: root.root, hint: 'm7a.exe --list 超时（25s）。' };
  }
  if (res.spawnError) {
    return { ok: false, error: 'M7A_SPAWN_FAILED', root: root.root, detail: res.spawnError };
  }

  const data = extractJson(res.stdout);
  let tasks = [];
  if (Array.isArray(data)) {
    tasks = data;
  } else if (data && typeof data === 'object') {
    const list = data.tasks || data.data || data.items;
    if (Array.isArray(list)) {
      tasks = list;
    } else {
      const entries = Object.entries(data).filter(([key, value]) => typeof value === 'string' || (value && typeof value === 'object'));
      if (entries.length && !pick(data, ['version', 'ok'])) {
        tasks = entries.map(([key, value]) => ({ id: key, name: typeof value === 'string' ? value : value && value.name }));
      }
    }
  }

  const normalized = tasks
    .slice(0, 200)
    .map((task, index) => {
      if (typeof task === 'string') return { id: task, name: task };
      if (!task || typeof task !== 'object') return null;
      const id = pick(task, ['id', 'task_id', 'taskId', 'key', 'name']);
      const name = pick(task, ['name', 'title', 'description', 'label', 'display_name']);
      const item = { id: id === undefined ? `task_${index + 1}` : String(id), name: name === undefined ? String(id ?? '') : String(name) };
      const enabled = asBool(pick(task, ['enabled', 'enable']));
      if (enabled !== undefined) item.enabled = enabled;
      return item;
    })
    .filter(Boolean);

  const result = {
    ok: true,
    root: root.root,
    count: normalized.length,
    tasks: normalized,
    exit_code: res.exitCode,
  };
  if (!normalized.length) {
    result.parsed = false;
    result.output_tail = tailText(res.stdout, 30, 400);
    if (res.exitCode !== 0) {
      result.ok = false;
      result.error = 'M7A_LIST_FAILED';
      result.hint = exitHint(res.exitCode) || 'm7a.exe --list 失败；检查版本与参数。';
    }
  }
  return result;
}

function parseDetachedRunId(text) {
  const data = extractJson(text);
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const value = pick(data, ['run_id', 'runId', 'id', 'run']);
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  const labelled = /(?:运行编号|run[\s_-]?id)[^\w]*([A-Za-z0-9][A-Za-z0-9._:-]*)/i.exec(text || '');
  if (labelled) return labelled[1];
  const pattern = /\b\d{8}[-_]\d{6}(?:[-_]\d+)?\b/.exec(text || '');
  return pattern ? pattern[0] : null;
}

async function toolRun(args = {}) {
  const taskId = typeof args.taskId === 'string' ? args.taskId.trim() : '';
  if (!taskId) return { ok: false, error: 'BAD_TASK_ID', hint: 'taskId 必填，例如 main / daily / power；可用 m7a_list 查全部任务。' };
  if (/[\s\\/]/.test(taskId)) return { ok: false, error: 'BAD_TASK_ID', hint: `taskId 不合法：${clipValue(taskId, 80)}` };

  const root = resolveRoot();
  if (!root.ok) return root;
  const detach = args.detach === true;

  if (detach) {
    const res = await runExe(root.root, [taskId, ...AFTER_FINISH_SAFE, '--detach'], { timeoutMs: 30000 });
    if (res.error || res.spawnError) {
      return { ok: false, error: res.error || 'M7A_SPAWN_FAILED', root: root.root, detail: res.spawnError };
    }
    if (res.timedOut) {
      return { ok: false, error: 'M7A_TIMEOUT', root: root.root, taskId, hint: '--detach 30s 内没返回运行编号；用 m7a_status 看 active_run。' };
    }
    const runId = parseDetachedRunId(res.stdout);
    const result = {
      ok: res.exitCode === 0,
      taskId,
      detached: true,
      run: runId,
      exit_code: res.exitCode,
      exit_code_meaning: exitMeaning(res.exitCode),
      root: root.root,
    };
    if (res.exitCode !== 0) result.hint = exitHint(res.exitCode);
    if (!runId) result.output_tail = tailText(res.stdout, 15, 400);
    if (res.stderr) result.stderr_tail = tailText(res.stderr, 10, 400);
    return result;
  }

  // 不 detach：等结束，但受 MCP 单次调用时长约束（约 60s）。超时按官方说明「不会中断任务」，
  // 这里保留子进程继续跑，返回值提示用 m7a_follow / m7a_status 跟进。
  const res = await runExe(root.root, [taskId, ...AFTER_FINISH_SAFE, '--json'], {
    timeoutMs: 50000,
    leaveOnTimeout: true,
  });
  if (res.error || res.spawnError) {
    return { ok: false, error: res.error || 'M7A_SPAWN_FAILED', root: root.root, detail: res.spawnError };
  }
  if (res.timedOut) {
    return {
      ok: true,
      taskId,
      timedOut: true,
      still_running: true,
      pid: res.pid,
      root: root.root,
      hint:
        '命令等满 50s 仍未结束（长任务很正常）；官方说明「命令超时不会中断任务」，它会在后台继续。' +
        '用 m7a_follow latest 或 m7a_status 跟进，不要重复发起。',
      output_tail: tailText(res.stdout, 15, 400),
    };
  }

  const record = extractJson(res.stdout);
  const brief = record && typeof record === 'object' ? briefRun(record) : null;
  const result = {
    ok: res.exitCode === 0,
    taskId,
    exit_code: res.exitCode,
    exit_code_meaning: exitMeaning(res.exitCode),
    root: root.root,
  };
  if (brief) result.record = brief;
  const hint = exitHint(res.exitCode);
  if (hint) result.hint = hint;
  if (res.exitCode !== 0) {
    result.output_tail = tailText(res.stdout, 25, 400);
    if (res.stderr) result.stderr_tail = tailText(res.stderr, 15, 400);
    if (brief && brief.run) result.run_record_hint = `m7a_run_record {run:"${brief.run}"}`;
  }
  return result;
}

async function toolFollow(args = {}) {
  const root = resolveRoot();
  if (!root.ok) return root;
  const wanted = typeof args.run === 'string' && args.run.trim() ? args.run.trim() : 'latest';
  const lines = clampInt(args.tail, 80, 1, 500);
  const runId = resolveRunId(root.root, wanted);
  if (!runId) {
    return {
      ok: false,
      error: 'NO_RUNS',
      root: root.root,
      runs_dir: path.join(root.root, 'logs', 'runs'),
      hint: 'logs\\runs 里还没有运行记录；先 m7a_run 发起一次任务。',
    };
  }
  const paths = runPaths(root.root, runId);
  const record = readJsonLoose(paths.json);
  const status = String((record && pick(record, ['status', 'state'])) || '').toLowerCase();
  const running = status === 'running' || status === 'running_task';

  // 已结束：直接读 <run>.log 末尾（快、稳，不用真去 follow 一整段）。
  if (!running && existsSync(paths.log)) {
    return {
      ok: true,
      root: root.root,
      source: 'log',
      run: runId,
      status: record ? pick(record, ['status', 'state']) : null,
      record: briefRun(record),
      lines,
      tail: tailFile(paths.log, lines),
    };
  }

  // 运行中或没有日志：真去 --follow（限制 20s，避免占满 MCP 单次调用）。
  const res = await runExe(root.root, ['--follow', runId], { timeoutMs: 20000, leaveOnTimeout: true });
  if (res.error || res.spawnError) {
    if (existsSync(paths.log)) {
      return { ok: true, root: root.root, source: 'log', run: runId, record: briefRun(record), lines, tail: tailFile(paths.log, lines) };
    }
    return { ok: false, error: res.error || 'M7A_SPAWN_FAILED', root: root.root, run: runId, detail: res.spawnError };
  }
  const result = {
    ok: res.timedOut ? true : res.exitCode === 0,
    root: root.root,
    source: 'follow',
    run: runId,
    still_running: Boolean(res.timedOut) || running,
    status: record ? pick(record, ['status', 'state']) : null,
    record: briefRun(record),
    lines,
    tail: tailText(res.stdout, lines),
  };
  if (res.timedOut) {
    result.hint = '任务仍在运行：稍后再次调用 m7a_follow 即可继续拿输出。';
  } else if (res.exitCode !== 0) {
    result.exit_code = res.exitCode;
    result.exit_code_meaning = exitMeaning(res.exitCode);
    result.hint = exitHint(res.exitCode);
  }
  if (res.stderr) result.stderr_tail = tailText(res.stderr, 10, 400);
  return result;
}

async function toolControl(args = {}) {
  const action = typeof args.action === 'string' ? args.action.trim().toLowerCase() : '';
  const allowed = ['pause', 'resume', 'stop'];
  if (!allowed.includes(action)) {
    return { ok: false, error: 'BAD_ACTION', hint: `action 只接受 ${allowed.join(' / ')}。`, got: clipValue(args.action) };
  }
  const root = resolveRoot();
  if (!root.ok) return root;
  const res = await runExe(root.root, ['--control', 'current', action], { timeoutMs: 20000 });
  if (res.error || res.spawnError) {
    return { ok: false, error: res.error || 'M7A_SPAWN_FAILED', root: root.root, action, detail: res.spawnError };
  }
  if (res.timedOut) {
    return { ok: false, error: 'M7A_TIMEOUT', root: root.root, action, hint: 'm7a.exe --control 超时（20s）。' };
  }
  const result = {
    ok: res.exitCode === 0,
    root: root.root,
    action,
    exit_code: res.exitCode,
    exit_code_meaning: exitMeaning(res.exitCode),
  };
  const output = stripAnsi(res.stdout).trim();
  if (output) result.output_tail = tailText(output, 10, 400);
  if (res.stderr.trim()) result.stderr_tail = tailText(res.stderr, 10, 400);
  if (res.exitCode !== 0) result.hint = exitHint(res.exitCode) || '控制指令没成功；先用 m7a_status 确认有 active_run。';
  return result;
}

async function toolRunRecord(args = {}) {
  const root = resolveRoot();
  if (!root.ok) return root;
  const wanted = typeof args.run === 'string' && args.run.trim() ? args.run.trim() : 'latest';
  const runId = resolveRunId(root.root, wanted);
  if (!runId) return runNotFound(wanted, root.root);
  const paths = runPaths(root.root, runId);
  const record = readJsonLoose(paths.json);
  if (!record || typeof record !== 'object') {
    return runNotFound(runId, root.root, {
      record_path: paths.json,
      hint: '这条运行还没有 .json 记录（可能正在运行，记录结束后才落盘）；用 m7a_follow 看输出。',
    });
  }
  const result = {
    ok: true,
    root: root.root,
    run: runId,
    record_path: paths.json,
    log_path: existsSync(paths.log) ? paths.log : null,
    status: pick(record, ['status', 'state']),
    reason: clipValue(pick(record, ['reason']), 500),
    error: clipValue(pick(record, ['error']), 800),
    exit_code: pick(record, ['exit_code', 'exitCode']),
    exit_code_meaning: exitMeaning(pick(record, ['exit_code', 'exitCode'])),
    screenshot: clipValue(pick(record, ['screenshot', 'screenshot_path']), 300),
    invoker: clipValue(pick(record, ['invoker']), 200),
    lock: clipValue(pick(record, ['lock']), 200),
    task: pick(record, ['task', 'task_id', 'taskId']),
    started_at: pick(record, ['started_at', 'startedAt', 'start_time', 'start']),
    finished_at: pick(record, ['finished_at', 'finishedAt', 'end_time', 'end', 'ended_at']),
    record,
  };
  const shot = pick(record, ['screenshot', 'screenshot_path']);
  if (typeof shot === 'string' && shot) {
    const absolute = path.isAbsolute(shot) ? shot : path.join(root.root, shot);
    if (existsSync(absolute)) result.screenshot_path = absolute;
  }
  const status = String(result.status || '').toLowerCase();
  if (status && status !== 'success' && status !== 'running') {
    result.hint = '任务不是 success：先看 error / screenshot，再 m7a_follow 看完整输出末尾；对照官方 troubleshooting。';
  }
  return result;
}

async function toolLogTail(args = {}) {
  const root = resolveRoot();
  if (!root.ok) return root;
  const lines = clampInt(args.lines, 100, 1, 500);
  const date = todayYmd();
  const file = path.join(root.root, 'logs', `${date}.log`);
  if (!existsSync(file)) {
    return {
      ok: false,
      error: 'LOG_NOT_FOUND',
      root: root.root,
      date,
      path: file,
      hint: '今天还没有日志（可能没运行过）。想看某次运行的输出用 m7a_follow / m7a_run_record。',
    };
  }
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    /* ignore */
  }
  return {
    ok: true,
    root: root.root,
    date,
    path: file,
    size_bytes: size,
    lines,
    tail: tailFile(file, lines),
  };
}

async function toolConfigGet(args = {}) {
  const root = resolveRoot();
  if (!root.ok) return root;
  const configPath = path.join(root.root, 'config.yaml');
  if (!existsSync(configPath)) {
    return {
      ok: false,
      error: 'CONFIG_NOT_FOUND',
      root: root.root,
      config_path: configPath,
      hint: '安装目录里没有 config.yaml：先启动一次 March7th Launcher.exe 让程序生成默认配置。',
    };
  }
  const text = readFileSync(configPath, 'utf8').replace(/^\uFEFF/, '');
  const { entries } = scanConfig(text);
  const requested = Array.isArray(args.keys) && args.keys.length
    ? args.keys.map((k) => String(k).trim()).filter(Boolean).slice(0, 40)
    : CONFIG_DEFAULT_KEYS.slice();

  const values = {};
  const missing = [];
  for (const key of requested) {
    if (key === 'scheduled_tasks') {
      const count = countScheduledTasks(text);
      if (count === null) missing.push(key);
      else values[key] = count;
      continue;
    }
    const entry = entries.get(key);
    if (!entry) {
      missing.push(key);
      continue;
    }
    values[key] = clipValue(decodeScalar(entry.value), 300);
  }

  const result = {
    ok: true,
    root: root.root,
    config_path: configPath,
    values,
  };
  if (requested.includes('scheduled_tasks') || !Array.isArray(args.keys) || !args.keys.length) {
    const count = countScheduledTasks(text);
    if (count !== null && values.scheduled_tasks === undefined) values.scheduled_tasks = count;
  }
  if (missing.length) result.missing = missing;
  if (!Array.isArray(args.keys) || !args.keys.length) {
    result.hint = '只读白名单子集；要读其它顶层键，传 keys: ["notify_enable", ...]。';
  }
  return result;
}

async function toolConfigSet(args = {}) {
  const key = typeof args.key === 'string' ? args.key.trim() : '';
  if (!CONFIG_WRITE_SET.has(key)) {
    return {
      ok: false,
      error: 'KEY_NOT_ALLOWED',
      allowed: CONFIG_WRITE_KEYS,
      hint: 'm7a_config_set 只改这 8 个白名单键；其它配置请让用户在图形界面里改（或先用 m7a_config_get 读）。',
      got: clipValue(args.key),
    };
  }
  if (args.value === undefined) {
    return { ok: false, error: 'BAD_VALUE', hint: `${key} 需要一个 value。` };
  }
  const normalized = normalizeConfigValue(key, args.value);
  if (!normalized.ok) return normalized;

  const root = resolveRoot();
  if (!root.ok) return root;
  const configPath = path.join(root.root, 'config.yaml');
  if (!existsSync(configPath)) {
    return {
      ok: false,
      error: 'CONFIG_NOT_FOUND',
      root: root.root,
      config_path: configPath,
      hint: '安装目录里没有 config.yaml：先启动一次 March7th Launcher.exe 生成默认配置。',
    };
  }

  const raw = readFileSync(configPath, 'utf8');
  const text = raw.replace(/^\uFEFF/, '');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const { lines, entries } = scanConfig(text);
  const entry = entries.get(key);
  if (!entry) {
    return {
      ok: false,
      error: 'KEY_NOT_FOUND',
      root: root.root,
      config_path: configPath,
      hint: `config.yaml 里没有顶层键 ${key}：版本可能较旧，先在图形界面保存一次配置或手动添加。`,
    };
  }

  const newLine = `${key}: ${normalized.text}${entry.trailing || ''}`;
  const nextLines = lines.slice();
  nextLines[entry.lineIndex] = newLine;
  let nextText = nextLines.join(eol);
  // split 会保留文件末尾的空行；join 后长度应一致，保险起见按原文件是否以换行结尾补齐。
  if (/\r?\n$/.test(text) && !nextText.endsWith(eol)) nextText += eol;
  if (nextText === text) {
    return {
      ok: true,
      root: root.root,
      key,
      value: normalized.value,
      changed: false,
      config_path: configPath,
      hint: '值没有变化，未写文件。',
    };
  }

  const backupPath = `${configPath}.bak-m7a-${stamp()}`;
  try {
    copyFileSync(configPath, backupPath);
    writeFileSync(configPath, nextText, 'utf8');
  } catch (e) {
    return {
      ok: false,
      error: 'CONFIG_WRITE_FAILED',
      root: root.root,
      config_path: configPath,
      detail: errText(e),
      hint: '写入失败（文件被占用或权限不足）；如果图形界面正开着，它可能会回写覆盖外部修改，建议关掉再改。',
    };
  }

  return {
    ok: true,
    root: root.root,
    key,
    old: clipValue(decodeScalar(entry.value), 200),
    value: normalized.value,
    changed: true,
    config_path: configPath,
    backup_path: backupPath,
    line: newLine,
    hint: '只替换了这一行、保留了注释；正在运行的任务下次运行生效。',
  };
}

// ─────────────────────────── 工具定义 ───────────────────────────

const TOOLS = [
  {
    name: 'm7a_status',
    description:
      '三月七小助手状态（m7a.exe --status --json）：版本、首次使用是否已确认、游戏路径是否有效、云游戏开关、正在运行的任务、最近 5 次运行。任何动作前先调它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'm7a_list',
    description: '列出小助手全部任务 ID 与名称（m7a.exe --list --json）。运行任务前用它确认 taskId。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'm7a_run',
    description:
      '运行一个任务（自动加 --after-finish None，不会执行用户配置的关机/睡眠）。taskId 常用：main 完整运行、daily 每日实训、power 清体力、routine 日常、divergent 差分宇宙、currencywars 货币战争、universe 模拟宇宙、fight 锄大地、redemption 兑换码、game 启动游戏。detach=true 时立即返回运行编号；否则等结束（单次最多约 50s，长任务超时会在后台继续，用 m7a_follow 跟进）。',
    inputSchema: {
      type: 'object',
      properties: {
        taskId: { type: 'string', description: '任务 ID（见 m7a_list），例如 daily / power / main' },
        detach: { type: 'boolean', description: 'true=启动后立即返回运行编号（长任务推荐）；默认 false=等结束' },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'm7a_follow',
    description:
      '跟进一次运行的输出末尾：已结束的运行直接读 logs\\runs\\<运行编号>.log；仍在运行则用 m7a.exe --follow 抓最近输出（单次最多约 20s）。run 省略或写 latest 表示最近一次。',
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string', description: '运行编号，或 latest（默认）' },
        tail: { type: 'number', description: '返回末尾多少行（默认 80，1–500）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'm7a_control',
    description: '暂停 / 继续 / 停止当前正在运行的任务（m7a.exe --control current pause|resume|stop），图形界面启动的任务也适用。',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['pause', 'resume', 'stop'], description: 'pause 暂停 / resume 继续 / stop 停止' },
      },
      required: ['action'],
      additionalProperties: false,
    },
  },
  {
    name: 'm7a_run_record',
    description:
      '读一次运行的记录（logs\\runs\\<运行编号>.json）：status、reason、error、exit_code、失败截图、invoker、lock、起止时间。排查失败先看它。',
    inputSchema: {
      type: 'object',
      properties: {
        run: { type: 'string', description: '运行编号，或 latest（默认）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'm7a_log_tail',
    description: '读当天日志 logs\\<yyyy-MM-dd>.log 的末尾若干行（含图形界面启动的任务）。',
    inputSchema: {
      type: 'object',
      properties: {
        lines: { type: 'number', description: '返回末尾多少行（默认 100，1–500）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'm7a_config_get',
    description:
      '读安装目录 config.yaml 的顶层配置项。不给 keys 时返回白名单子集（game_path / after_finish / daily_enable / power_enable / auto_set_resolution_enable / auto_set_game_path_enable）与 scheduled_tasks 数量。',
    inputSchema: {
      type: 'object',
      properties: {
        keys: { type: 'array', items: { type: 'string' }, description: '要读的顶层键名，例如 ["game_path","notify_enable"]' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'm7a_config_set',
    description:
      '改 config.yaml 里一个白名单键（只替换该键那一行，保留注释与其它内容；改前自动备份 config.yaml.bak-m7a-<ts>）。白名单：game_path / after_finish / daily_enable / power_enable / auto_set_resolution_enable / auto_set_game_path_enable / pause_after_success / exit_after_failure。',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', enum: CONFIG_WRITE_KEYS, description: '要改的键（白名单）' },
        value: {
          type: ['string', 'boolean', 'number'],
          description: '新值：布尔键用 true/false；after_finish 用 None/Exit/Loop/Shutdown/Sleep/Hibernate/Restart/Logoff/TurnOffDisplay/RunScript；game_path 用字符串路径',
        },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
  },
];

const HANDLERS = {
  m7a_status: toolStatus,
  m7a_list: toolList,
  m7a_run: toolRun,
  m7a_follow: toolFollow,
  m7a_control: toolControl,
  m7a_run_record: toolRunRecord,
  m7a_log_tail: toolLogTail,
  m7a_config_get: toolConfigGet,
  m7a_config_set: toolConfigSet,
};

// ─────────────────────────── MCP 传输 ───────────────────────────

/** 统一出口：对象结果 → MCP text content；超 8KB 就换成截断包裹（仍是合法 JSON）。 */
function byteSlice(text, maxBytes) {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let out = '';
  let used = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (used + size > maxBytes) break;
    out += ch;
    used += size;
  }
  return out;
}

function toolResult(payload) {
  const isError = Boolean(payload && payload.ok === false);
  const wrap = (text) => {
    const result = { content: [{ type: 'text', text }] };
    if (isError) result.isError = true;
    return result;
  };
  let text = JSON.stringify(payload, null, 2);
  if (Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES) return wrap(text);

  // 超限时优先裁数组（日志行 / tail / output_tail）：只保留最近的若干行，其余字段照常返回。
  let copy = null;
  try {
    copy = JSON.parse(text);
  } catch {
    copy = null;
  }
  if (copy && typeof copy === 'object' && !Array.isArray(copy)) {
    const arrays = [];
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        arrays.push(node);
        node.forEach(walk);
        return;
      }
      for (const value of Object.values(node)) walk(value);
    })(copy);
    const size = () => Buffer.byteLength(JSON.stringify(copy), 'utf8');
    let omitted = 0;
    for (const arr of arrays) {
      while (size() > MAX_TEXT_BYTES - 400 && arr.length > 1) {
        const drop = Math.max(1, Math.floor(arr.length / 2));
        arr.splice(0, drop);
        omitted += drop;
      }
    }
    if (omitted > 0) {
      copy.truncated = true;
      copy.truncated_arrays = omitted;
      copy.note = `输出过长：日志/尾部行只保留最近内容（共省略 ${omitted} 行/项）。`;
      text = JSON.stringify(copy, null, 2);
      if (Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES) return wrap(text);
    }
  }

  // 兜底：单个长字符串仍塞不下时，换成截断包裹（预览按字节切，避免中文超限）。
  const note = `输出超过 ${MAX_TEXT_BYTES} 字节已截断；请用更小的 tail/lines 参数，或直接读日志文件。`;
  text = JSON.stringify(
    {
      ok: !isError,
      truncated: true,
      note,
      preview: byteSlice(text, MAX_TEXT_BYTES - 700),
    },
    null,
    2,
  );
  return wrap(text);
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}
function sendResult(id, result) {
  send({ jsonrpc: '2.0', id, result });
}
function sendError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(msg) {
  const { id, method, params } = msg || {};
  const isNotification = id === undefined || id === null;

  if (method === 'initialize') {
    const requested = params && typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    sendResult(id, {
      protocolVersion: requested,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') return;
  if (method === 'ping') {
    sendResult(id, {});
    return;
  }
  if (method === 'tools/list') {
    sendResult(id, { tools: TOOLS });
    return;
  }
  if (method === 'resources/list') {
    sendResult(id, { resources: [] });
    return;
  }
  if (method === 'resources/templates/list') {
    sendResult(id, { resourceTemplates: [] });
    return;
  }
  if (method === 'prompts/list') {
    sendResult(id, { prompts: [] });
    return;
  }
  if (method === 'logging/setLevel') {
    sendResult(id, {});
    return;
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    const fn = HANDLERS[name];
    if (!fn) {
      sendError(id, -32602, `未知工具：${name}`);
      return;
    }
    try {
      const payload = await fn(args);
      sendResult(id, toolResult(payload));
    } catch (e) {
      log('tool error', name, e && e.stack ? e.stack : String(e));
      sendResult(id, toolResult({ ok: false, error: 'TOOL_EXCEPTION', message: errText(e), hint: '工具内部异常，已捕获；可重试或改用 m7a_status。' }));
    }
    return;
  }

  if (isNotification) return;
  sendError(id, -32601, `未实现的方法：${method}`);
}

// ─────────────────────────── 入口 ───────────────────────────

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
  // 管道喂输入时 stdin 可能在应答发完前就 EOF；等未完成调用收尾再退出。
  const deadline = Date.now() + 20000;
  while (pending > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  process.exit(0);
});

process.on('uncaughtException', (e) => log('uncaughtException', e && e.stack ? e.stack : String(e)));
process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.stack ? e.stack : String(e)));

log(`已启动：工具 ${TOOLS.length} 个；stateDir=${stateDir()}`);
