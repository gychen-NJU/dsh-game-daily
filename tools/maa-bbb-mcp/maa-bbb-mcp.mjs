#!/usr/bin/env node
/**
 * maa-bbb-mcp.mjs — Maa_bbb「识宝小助手」MCP stdio 服务端（dsh-game-daily 随包，零依赖）
 *
 * Maa_bbb（识宝小助手 / MFW）是崩坏3的 MaaFramework 自动化工具。它的主程序 mab.exe 本身就是
 * 我们需要的命令行入口：GUI 配置持久化在 config/configs/<id>.json，用 --config-id + --direct-run
 * 就能直接跑某套配置。本服务把它包成 agent 可调用的 MCP 工具，覆盖「看状态 / 读配置 / 改开关与
 * 选项 / 克隆配置 / 跑配置 / 停进程 / 读日志」这一圈。
 *
 * 安装根解析顺序（先命中者胜）：
 *   1. 环境变量 DSH_GAME_DAILY_MAA_ROOT
 *   2. 环境变量 MAA_BBB_ROOT
 *   3. <stateDir>/maa-root.txt（stateDir = DSH_GAME_DAILY_STATE_DIR，默认 %USERPROFILE%\.dsh\game-daily）
 *   4. E:\software\Maa_bbb / D:\software\Maa_bbb / C:\software\Maa_bbb / %USERPROFILE%\Maa_bbb
 * 校验 mab.exe 与 interface.json 同时存在才算安装。未安装时所有工具都返回 MAA_NOT_INSTALLED，不崩。
 *
 * 关键的 Maa_bbb 数据事实（2026-11 实测于 v1.13.20）：
 *   - config/configs/<id>.json：4 空格缩进、CRLF、无末尾换行、无 BOM。{name,item_id,tasks,...}。
 *   - tasks 固定前缀 4 个伪任务：PreTask / Controller / Resource / Post-Action。Controller 伪任务的
 *     task_option.controller_type 决定桌面端/安卓端，Resource 伪任务的 task_option.resource 决定资源包。
 *   - 真实任务：{name, item_id:'t_<32hex>', is_checked, task_option}；task_option 每项形如
 *     {"键":{"value":值[,"branches":...]}}，另有一个 _speedrun_config 大对象。item_id 是 GUI 随机生成
 *     的、无法从任务名推导，因此 catalog 的 itemId 只能从已有配置反查，查不到就是 null。
 *   - config/multi_config.json：{curr_config_id, config_list:[...]}；新配置要登记进 config_list 才在
 *     GUI 里出现，curr_config_id 决定「当前配置」。该文件同样是 4 空格 + CRLF + 无末尾换行。
 *   - interface.json（interface_version 2）：controller/resource/group/preset/import 是权威来源；
 *     task 与 option 恒为空，任务定义散在 import 的 36 个 tasks/**.json 里，其中 8 个是带 // 注释的
 *     JSONC，必须容错解析。
 *
 * 安全约定：
 *   - 只写 config/configs/*.json 与 config/multi_config.json，且原子写（临时文件 + rename，UTF-8 无 BOM，
 *     保留原文件的 EOL 与「无末尾换行」风格）。写前备份 <file>.bak-maa-<ts>，写后回读校验。
 *   - 决不主动改 config/config.json（MFW 全局设置，只读）。
 *   - 改配置时如果 mab.exe 在跑，会给 warning：GUI 退出时可能回写覆盖，建议先 stop。
 *   - 进程检测不引第三方依赖：优先 PowerShell Get-Process，失败退回 tasklist。
 *
 * 协议：stdio JSON-RPC 2.0；stdout 只出 JSON-RPC，stderr 打 [maa-bbb-mcp] 日志；
 * initialize 固定返回 protocolVersion 2025-06-18、capabilities.tools、serverInfo maa-bbb-mcp@0.1.0。
 *
 * 已知限制：本机没有 adb 与 MuMu 模拟器，安卓端（往世乐土等）只能做配置面支持，不能实跑。
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SERVER_INFO = { name: 'maa-bbb-mcp', version: '0.1.0' };
const PROTOCOL_VERSION = '2025-06-18';
const MAX_TEXT_BYTES = 16000;
const LOG_MAX_BYTES = 512 * 1024;
const PSEUDO_TASKS = new Set(['PreTask', 'Controller', 'Resource', 'Post-Action']);
const LOG_KINDS = { maafw: 'maafw.log', gui: 'gui.log', crash: 'crash.log' };
const PS_LIST_MAB = `$ps=Get-Process -Name mab -ErrorAction SilentlyContinue | ForEach-Object { [pscustomobject]@{ Id=$_.Id; Path=$_.Path; Start=$(if($_.StartTime){$_.StartTime.ToString("o")} else {$null}) } }; if ($ps) { ConvertTo-Json -InputObject @($ps) -Compress -Depth 3 } else { "[]" }`;

/** stderr 日志；stdout 绝不能混入非 JSON-RPC 内容。 */
function log(...parts) {
  try { process.stderr.write(`[maa-bbb-mcp] ${parts.map((p) => (typeof p === 'string' ? p : errText(p))).join(' ')}\n`); } catch {}
}

/** 把任意 throw 值转成一段可读文本（保留 stack 便于 stderr 排查）。 */
function errText(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  if (error.stack) return String(error.stack);
  if (error.message) return String(error.message);
  return String(error);
}

function clampInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function byteSlice(text, maxBytes) {
  const buf = Buffer.from(String(text ?? ''), 'utf8');
  if (buf.length <= maxBytes) return buf.toString('utf8');
  return `${buf.subarray(0, Math.max(0, maxBytes)).toString('utf8')}\n…（已按 ${maxBytes} 字节截断）`;
}

function stateDir() {
  const custom = process.env.DSH_GAME_DAILY_STATE_DIR;
  if (custom && String(custom).trim()) return path.resolve(String(custom).trim());
  const home = process.env.USERPROFILE || os.homedir();
  return path.join(home, '.dsh', 'game-daily');
}

function normalizeRootPath(input) {
  let value = String(input ?? '').trim();
  if (!value) return '';
  if (/^file:\/\//i.test(value)) {
    try { value = decodeURIComponent(value.replace(/^file:\/\//i, '')); } catch {}
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1).trim();
  value = value.replace(/[\\/]+$/, '');
  if (/^[A-Za-z]:$/.test(value)) value += '\\';
  if (!path.isAbsolute(value)) return '';
  return path.normalize(value);
}

function inspectRoot(input) {
  const dir = normalizeRootPath(input);
  if (!dir) return null;
  const exe = path.join(dir, 'mab.exe');
  const interfacePath = path.join(dir, 'interface.json');
  if (!existsSync(exe) || !existsSync(interfacePath)) return null;
  return {
    root: dir,
    exe,
    interfacePath,
    configDir: path.join(dir, 'config'),
    configsDir: path.join(dir, 'config', 'configs'),
    multiConfigPath: path.join(dir, 'config', 'multi_config.json'),
    debugDir: path.join(dir, 'debug'),
  };
}

/** 按「env → 指针文件 → 候选目录」解析安装根；未装时返回 MAA_NOT_INSTALLED 而非抛错。 */
function resolveRoot() {
  const searched = [];
  const consider = (candidate, source) => {
    const found = inspectRoot(candidate);
    if (found) return { ok: true, ...found, source };
    const dir = normalizeRootPath(candidate);
    searched.push({ source, path: dir || String(candidate ?? ''), exists: Boolean(dir && existsSync(dir)) });
    return null;
  };
  for (const key of ['DSH_GAME_DAILY_MAA_ROOT', 'MAA_BBB_ROOT']) {
    const value = process.env[key];
    if (value && String(value).trim()) {
      const found = consider(value, `env:${key}`);
      if (found) return found;
    } else {
      searched.push({ source: `env:${key}`, path: '(未设置)', exists: false });
    }
  }
  const pointerPath = path.join(stateDir(), 'maa-root.txt');
  try {
    const pointer = readFileSync(pointerPath, 'utf8').replace(/^\uFEFF/, '').trim();
    if (pointer) {
      const found = consider(pointer, `pointer:${pointerPath}`);
      if (found) return found;
    } else {
      searched.push({ source: `pointer:${pointerPath}`, path: '(空文件)', exists: false });
    }
  } catch {
    searched.push({ source: `pointer:${pointerPath}`, path: '(不存在)', exists: false });
  }
  const home = process.env.USERPROFILE || os.homedir();
  for (const candidate of [
    'E:\\software\\Maa_bbb', 'D:\\software\\Maa_bbb', 'C:\\software\\Maa_bbb',
    'D:\\Games\\Maa_bbb', 'E:\\Games\\Maa_bbb', 'C:\\Games\\Maa_bbb',
    path.join(home, 'Maa_bbb'), path.join(home, 'Games', 'Maa_bbb'),
  ]) {
    const found = consider(candidate, 'candidate');
    if (found) return found;
  }
  return {
    ok: false,
    error: 'MAA_NOT_INSTALLED',
    searched,
    hint: `没找到同时含 mab.exe 与 interface.json 的 MAA_bbb 安装目录。可用环境变量 DSH_GAME_DAILY_MAA_ROOT / MAA_BBB_ROOT 指定，或把绝对路径写进 ${pointerPath}。`,
  };
}

function notInstalled(root) {
  return { ok: false, error: root.error || 'MAA_NOT_INSTALLED', searched: root.searched, hint: root.hint };
}

function readText(file) { return readFileSync(file, 'utf8').replace(/^\uFEFF/, ''); }

/** JSONC 容错：去 // 与块注释（尊重字符串边界）。 */
function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) { if (ch === '\n') { inLine = false; out += ch; } continue; }
    if (inBlock) { if (ch === '*' && next === '/') { inBlock = false; i++; } continue; }
    if (inString) {
      out += ch;
      if (ch === '\\') { out += next ?? ''; i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === '/' && next === '/') { inLine = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i++; continue; }
    out += ch;
  }
  return out;
}

/** JSONC 容错：去掉对象/数组末尾的多余逗号（同样尊重字符串边界）。 */
function stripTrailingCommas(text) {
  let out = '';
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === '\\') { out += text[i + 1] ?? ''; i++; continue; }
      if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; out += ch; continue; }
    if (ch === ',') {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === '}' || text[j] === ']') continue;
    }
    out += ch;
  }
  return out;
}

function jsonErrorInfo(file, text, error) {
  const message = errText(error);
  let line = null;
  let column = null;
  const lc = /\(line\s+(\d+)\s+column\s+(\d+)\)/i.exec(message);
  if (lc) {
    line = Number(lc[1]);
    column = Number(lc[2]);
  } else {
    const pos = /at position (\d+)/i.exec(message);
    if (pos) {
      const before = String(text ?? '').slice(0, Number(pos[1]));
      const lines = before.split(/\r?\n/);
      line = lines.length;
      column = lines[lines.length - 1].length + 1;
    }
  }
  let snippet = null;
  const all = String(text ?? '').split(/\r?\n/);
  if (line && line <= all.length) {
    const from = Math.max(1, line - 2);
    const to = Math.min(all.length, line + 2);
    snippet = [];
    for (let i = from; i <= to; i++) {
      const raw = all[i - 1] ?? '';
      snippet.push(`${String(i).padStart(5)}| ${raw.length > 200 ? `${raw.slice(0, 200)}…` : raw}`);
    }
  }
  return { file: path.basename(file), message, line, column, snippet };
}

/** 先严格 JSON，再依次尝试去注释、去尾逗号；成功时返回 mode 便于诊断。 */
function parseJsonText(text, file) {
  const attempts = [
    { mode: 'json', body: text },
    { mode: 'jsonc-comments', body: stripJsonComments(text) },
    { mode: 'jsonc-commas', body: stripTrailingCommas(stripJsonComments(text)) },
  ];
  let firstError = null;
  for (const attempt of attempts) {
    try { return { ok: true, data: JSON.parse(attempt.body), mode: attempt.mode, file }; } catch (error) { if (!firstError) firstError = error; }
  }
  return { ok: false, error: 'JSON_PARSE_ERROR', mode: 'jsonc', file, ...jsonErrorInfo(file, text, firstError) };
}

function detectStyle(raw) {
  return { eol: String(raw).includes('\r\n') ? '\r\n' : '\n', trailingNewline: /(\r\n|\n)$/.test(String(raw)) };
}

function serializeJson(obj, style = {}) {
  let text = JSON.stringify(obj, null, 4);
  if (style.eol === '\r\n') text = text.replace(/\n/g, '\r\n');
  if (style.trailingNewline) text += style.eol || '\n';
  return text;
}

/** 原子写：临时文件 → rename；UTF-8 无 BOM；保留原文件 EOL / 尾换行风格。 */
function writeJsonAtomic(file, obj, style) {
  const text = serializeJson(obj, style || {});
  const tmp = `${file}.tmp-maa-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, text, { encoding: 'utf8' });
  try { renameSync(tmp, file); } catch (error) { try { unlinkSync(tmp); } catch {} throw error; }
  return { bytes: Buffer.byteLength(text, 'utf8'), eol: style?.eol ?? '\n', trailingNewline: Boolean(style?.trailingNewline) };
}

function backupFile(file) {
  const target = `${file}.bak-maa-${stamp()}`;
  writeFileSync(target, readFileSync(file));
  return target;
}

function readTailText(file, maxBytes = LOG_MAX_BYTES) {
  const size = statSync(file).size;
  const len = Math.min(size, maxBytes);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, 'r');
  try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
  return { size, text: buf.toString('utf8'), truncated: size > maxBytes };
}

function readLogLines(file) {
  const tail = readTailText(file);
  let lines = tail.text.split(/\r?\n/);
  if (tail.truncated) lines = lines.slice(1);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return { size: tail.size, mtime: statSync(file).mtime.toISOString(), lines, truncated: tail.truncated };
}

function readInterface(root) {
  const file = root.interfacePath;
  if (!existsSync(file)) return { ok: false, error: 'INTERFACE_NOT_FOUND', file };
  try {
    const text = readText(file);
    const parsed = parseJsonText(text, file);
    if (!parsed.ok) return { ...parsed, file };
    return { ok: true, file, data: parsed.data, mode: parsed.mode };
  } catch (error) {
    return { ok: false, error: 'INTERFACE_READ_ERROR', file, message: errText(error) };
  }
}

function configFiles(root) {
  try {
    return readdirSync(root.configsDir)
      .filter((name) => name.toLowerCase().endsWith('.json'))
      .sort()
      .map((name) => path.join(root.configsDir, name));
  } catch {
    return [];
  }
}

function listConfigIds(root) { return configFiles(root).map((file) => path.basename(file, '.json')); }

function normalizeConfigId(input) {
  const id = String(input ?? '').trim().replace(/^.*[\\/]/, '').replace(/\.json$/i, '');
  if (!id || id === '.' || id === '..' || id.length > 200 || /[<>:"|?*\u0000-\u001f]/.test(id)) return '';
  return id;
}

function findConfigFile(root, configId) {
  const id = normalizeConfigId(configId);
  if (!id) return { ok: false, error: 'INVALID_CONFIG_ID', configId: String(configId ?? ''), hint: 'configId 形如 c_<32hex>；用 maa_bbb_config_list 查看' };
  const direct = path.join(root.configsDir, `${id}.json`);
  if (existsSync(direct)) return { ok: true, id, file: direct };
  for (const file of configFiles(root)) {
    try {
      const cfg = JSON.parse(readText(file));
      if (cfg && cfg.item_id === id) return { ok: true, id: path.basename(file, '.json'), file };
    } catch {}
  }
  return { ok: false, error: 'CONFIG_NOT_FOUND', configId: id, available: listConfigIds(root), hint: '用 maa_bbb_config_list 查看可用配置 id' };
}

function loadConfig(root, configId) {
  const found = findConfigFile(root, configId);
  if (!found.ok) return found;
  try {
    const raw = readText(found.file);
    const parsed = parseJsonText(raw, found.file);
    if (!parsed.ok) return { ok: false, error: 'CONFIG_PARSE_ERROR', configId: found.id, ...parsed };
    return { ok: true, configId: found.id, file: found.file, raw, cfg: parsed.data, style: detectStyle(raw), bytes: statSync(found.file).size, mode: parsed.mode };
  } catch (error) {
    return { ok: false, error: 'CONFIG_READ_ERROR', configId: found.id, file: found.file, message: errText(error) };
  }
}

function multiInfo(root) {
  const file = root.multiConfigPath;
  if (!existsSync(file)) return { ok: false, error: 'MULTI_CONFIG_NOT_FOUND', file };
  try {
    const raw = readText(file);
    const parsed = parseJsonText(raw, file);
    if (!parsed.ok) return { ...parsed, file };
    return { ok: true, file, raw, data: parsed.data, style: detectStyle(raw) };
  } catch (error) {
    return { ok: false, error: 'MULTI_CONFIG_READ_ERROR', file, message: errText(error) };
  }
}

function summarizeConfig(cfg, id, file) {
  const tasks = Array.isArray(cfg?.tasks) ? cfg.tasks : [];
  const real = tasks.filter((task) => !PSEUDO_TASKS.has(task?.item_id || task?.name));
  const controllerTask = tasks.find((task) => (task?.item_id || task?.name) === 'Controller');
  const resourceTask = tasks.find((task) => (task?.item_id || task?.name) === 'Resource');
  const enabledTasks = real.filter((task) => task.is_checked !== false).map((task) => task.name);
  const disabledTasks = real.filter((task) => task.is_checked === false).map((task) => task.name);
  return {
    id,
    file: file ? path.basename(file) : undefined,
    name: cfg?.name ?? null,
    controller: controllerTask?.task_option?.controller_type ?? null,
    resource: resourceTask?.task_option?.resource ?? null,
    total: real.length,
    checked: enabledTasks.length,
    enabledTasks,
    disabledTasks,
  };
}

function listConfigs(root) {
  const out = [];
  for (const file of configFiles(root)) {
    const id = path.basename(file, '.json');
    try {
      const raw = readText(file);
      const parsed = parseJsonText(raw, file);
      if (!parsed.ok) {
        out.push({ id, file: path.basename(file), ok: false, error: parsed.error, message: parsed.message, line: parsed.line });
        continue;
      }
      out.push({ ...summarizeConfig(parsed.data, id, file), ok: true, bytes: statSync(file).size });
    } catch (error) {
      out.push({ id, file: path.basename(file), ok: false, error: 'CONFIG_READ_ERROR', message: errText(error) });
    }
  }
  return out;
}

function compactTask(task) {
  const option = task && typeof task.task_option === 'object' && task.task_option ? task.task_option : {};
  const optionKeys = Object.keys(option);
  const options = {};
  for (const key of optionKeys) {
    const value = option[key];
    if (key === '_speedrun_config') {
      if (value && typeof value === 'object' && value.enabled) options[key] = { enabled: true, ...(value.mode ? { mode: value.mode } : {}) };
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) options[key] = value.value;
    else options[key] = value;
  }
  return { name: task?.name ?? null, item_id: task?.item_id ?? null, is_checked: task?.is_checked !== false, optionKeys, options };
}

function tasksOfType(cfg, type) {
  const tasks = Array.isArray(cfg?.tasks) ? cfg.tasks : [];
  return tasks.find((task) => (task?.item_id || task?.name) === type) || null;
}

function psJson(script) {
  const full = `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); ${script}`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', full], {
    encoding: 'utf8', timeout: 20000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
  });
  return String(out || '').trim();
}

/** 枚举 mab.exe 进程；优先 PowerShell（带路径/启动时间），失败退回 tasklist，最后按安装根过滤。 */
function listMabProcesses(root) {
  let list = [];
  try {
    const raw = psJson(PS_LIST_MAB);
    const parsed = raw ? JSON.parse(raw) : [];
    list = (Array.isArray(parsed) ? parsed : [parsed]).filter(Boolean).map((p) => ({
      pid: Number(p.Id), path: p.Path || null, startedAt: p.Start || null,
    }));
  } catch (error) {
    log('PowerShell 进程枚举失败，退回 tasklist：', errText(error).split(/\r?\n/)[0]);
  }
  if (!list.length) {
    try {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq mab.exe', '/FO', 'CSV', '/NH'], {
        encoding: 'utf8', timeout: 10000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
      });
      for (const line of String(out).split(/\r?\n/)) {
        const match = /"mab\.exe","(\d+)"/i.exec(line);
        if (match) list.push({ pid: Number(match[1]), path: null, startedAt: null, pathUnknown: true });
      }
    } catch {}
  }
  const rootLc = root.toLowerCase();
  return list
    .filter((proc) => {
      if (!proc.path) return true;
      try { return path.dirname(path.resolve(proc.path)).toLowerCase() === rootLc; } catch { return false; }
    })
    .map((proc) => ({ pid: proc.pid, path: proc.path, startedAt: proc.startedAt, ...(proc.pathUnknown ? { pathUnknown: true } : {}) }));
}

function killPid(pid, force) {
  const cli = ['/PID', String(pid), '/T', ...(force ? ['/F'] : [])];
  try {
    execFileSync('taskkill', cli, { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    return { pid, ok: true, forced: force };
  } catch (error) {
    return { pid, ok: false, forced: force, exitCode: error.status ?? null, message: errText(error).split(/\r?\n/)[0] };
  }
}

function findExe(exe, candidates) {
  try {
    const out = execFileSync('where', [exe], { encoding: 'utf8', timeout: 6000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && existsSync(first)) return { path: first, source: 'PATH' };
  } catch {}
  for (const candidate of candidates) if (candidate && existsSync(candidate)) return { path: candidate, source: 'install-dir' };
  return { path: null, source: null };
}

const MUMU_DIRS = [
  'C:\\Program Files\\Netease\\MuMuPlayer-12.0',
  'C:\\Program Files\\Netease\\MuMuPlayerGlobal-12.0',
  'D:\\Program Files\\Netease\\MuMuPlayer-12.0',
  'E:\\software\\MuMuPlayer-12.0',
  'D:\\software\\MuMuPlayer-12.0',
];

function mumuInfo() {
  const env = process.env.MUMU_INSTALL_PATH || process.env.MUMU_ROOT || '';
  if (env && existsSync(env)) return { available: true, path: env, source: 'env' };
  for (const dir of MUMU_DIRS) if (existsSync(dir)) return { available: true, path: dir, source: 'candidate' };
  return { available: false, path: null, source: null };
}

function envInfo() {
  const mumu = mumuInfo();
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const adb = findExe('adb', [
    path.join(local, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    mumu.path ? path.join(mumu.path, 'shell', 'adb.exe') : null,
    mumu.path ? path.join(mumu.path, 'adb.exe') : null,
    'C:\\platform-tools\\adb.exe',
  ]);
  return { adb: { available: Boolean(adb.path), path: adb.path, source: adb.source }, mumu };
}

function walkTaskJsonFiles(root) {
  const out = [];
  const stack = [path.join(root, 'tasks')];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.json')) out.push(full);
    }
  }
  return out.sort();
}

/** name → item_id 只能从已有配置反查（item_id 是 GUI 随机生成的，无法由任务名推导）。 */
function collectItemIds(root) {
  const map = new Map();
  for (const file of configFiles(root)) {
    try {
      const cfg = JSON.parse(readText(file));
      for (const task of Array.isArray(cfg?.tasks) ? cfg.tasks : []) {
        if (!task?.name) continue;
        const id = task.item_id || task.name;
        if (!PSEUDO_TASKS.has(id) && !map.has(task.name)) map.set(task.name, id);
      }
    } catch {}
  }
  return map;
}

/** 汇总 interface.json 的 group + import 里的 tasks/**.json；JSONC 文件也能解析。 */
function loadTaskCatalog(root, iface) {
  const base = root.root;
  const warnings = [];
  let files = walkTaskJsonFiles(base);
  const imports = Array.isArray(iface?.import) ? iface.import : [];
  if (imports.length) {
    const wanted = new Set(imports.map((item) => path.resolve(base, String(item).split(/[\\/]/).join(path.sep)).toLowerCase()));
    const filtered = files.filter((file) => wanted.has(path.resolve(file).toLowerCase()));
    if (filtered.length) files = filtered;
  }
  const groups = new Map();
  for (const group of Array.isArray(iface?.group) ? iface.group : []) {
    groups.set(group.name, { name: group.name, defaultExpand: group.default_expand ?? null, tasks: [] });
  }
  const itemIds = collectItemIds(root);
  for (const file of files) {
    const rel = path.relative(base, file).split(path.sep).join('/');
    let text;
    try { text = readText(file); } catch (error) { warnings.push({ file: rel, error: 'TASK_READ_ERROR', message: errText(error) }); continue; }
    const parsed = parseJsonText(text, file);
    if (!parsed.ok) { warnings.push({ file: rel, error: parsed.error, line: parsed.line, message: parsed.message }); continue; }
    const data = parsed.data || {};
    const optionDefs = data.option && typeof data.option === 'object' ? data.option : {};
    for (const def of Array.isArray(data.task) ? data.task : []) {
      if (!def || !def.name) continue;
      const groupNames = Array.isArray(def.group) && def.group.length ? def.group : ['未分组'];
      const options = (Array.isArray(def.option) ? def.option : []).map((key) => {
        const meta = optionDefs[key] && typeof optionDefs[key] === 'object' ? optionDefs[key] : {};
        return {
          key,
          label: meta.label ?? null,
          type: meta.type ?? null,
          default: meta.default_case ?? null,
          cases: Array.isArray(meta.cases) ? meta.cases.map((c) => c?.name).filter(Boolean) : [],
        };
      });
      for (const groupName of groupNames) {
        if (!groups.has(groupName)) groups.set(groupName, { name: groupName, defaultExpand: null, tasks: [] });
        groups.get(groupName).tasks.push({
          name: def.name,
          label: def.label ?? null,
          itemId: itemIds.get(def.name) ?? null,
          entry: def.entry ?? null,
          defaultCheck: def.default_check ?? null,
          options,
        });
      }
    }
  }
  return { groups: [...groups.values()].filter((group) => group.tasks.length > 0), warnings, fileCount: files.length };
}

function toolStatus() {
  const root = resolveRoot();
  if (!root.ok) return notInstalled(root);
  const iface = readInterface(root);
  const multi = multiInfo(root);
  const processes = listMabProcesses(root.root);
  const env = envInfo();
  let logTail = [];
  try { logTail = readLogLines(path.join(root.debugDir, 'maafw.log')).lines.slice(-20); } catch {}
  return {
    ok: true,
    root: root.root,
    source: root.source,
    exe: root.exe,
    version: iface.ok ? iface.data.version ?? null : null,
    title: iface.ok ? iface.data.title ?? null : null,
    interfaceOk: iface.ok,
    interfaceError: iface.ok ? undefined : iface.message || iface.error,
    running: processes.length > 0,
    processes,
    currentConfig: multi.ok ? multi.data.curr_config_id ?? null : null,
    configs: listConfigs(root),
    adbAvailable: env.adb.available,
    adbPath: env.adb.path,
    mumuAvailable: env.mumu.available,
    mumuPath: env.mumu.path,
    logPath: path.join(root.debugDir, 'maafw.log'),
    logTail,
  };
}

function toolConfigList() {
  const root = resolveRoot();
  if (!root.ok) return notInstalled(root);
  const multi = multiInfo(root);
  const configs = listConfigs(root);
  return {
    ok: true,
    root: root.root,
    configsDir: root.configsDir,
    currentConfig: multi.ok ? multi.data.curr_config_id ?? null : null,
    registered: multi.ok && Array.isArray(multi.data.config_list) ? multi.data.config_list : [],
    count: configs.length,
    configs,
  };
}

function toolConfigGet(args = {}) {
  const root = resolveRoot();
  if (!root.ok) return notInstalled(root);
  const loaded = loadConfig(root, args.configId);
  if (!loaded.ok) return loaded;
  const cfg = loaded.cfg;
  const all = Array.isArray(cfg?.tasks) ? cfg.tasks : [];
  const maxTasks = clampInt(args.maxTasks, 60, 1, 2000);
  const full = args.full === true;
  const shown = all.slice(0, maxTasks).map((task) => (full ? task : compactTask(task)));
  const multi = multiInfo(root);
  const summary = summarizeConfig(cfg, loaded.configId, loaded.file);
  const { enabledTasks, disabledTasks, file: fileName, ...rest } = summary;
  return {
    ok: true,
    configId: loaded.configId,
    ...rest,
    file: loaded.file,
    fileName,
    current: Boolean(multi.ok && multi.data.curr_config_id === loaded.configId),
    count: { pseudo: all.length - summary.total, real: summary.total, checked: summary.checked },
    bundle: cfg?.bundle ?? null,
    interface_task_list_materialized: cfg?.interface_task_list_materialized ?? null,
    style: loaded.style,
    mode: loaded.mode,
    tasks: shown,
    tasksTruncated: all.length > shown.length,
    hint: full ? 'full=true：task_option 是原始结构（含 branches / _speedrun_config 全量），可能很大。' : 'task_option 已压成 optionKeys + options（只保留生效值）；要看原始结构传 full:true。',
  };
}

/** 改配置：只动指定字段；未知任务名 → 整体拒绝且不写盘。 */
function toolConfigUpdate(args = {}) {
  const root = resolveRoot();
  if (!root.ok) return notInstalled(root);
  const loaded = loadConfig(root, args.configId);
  if (!loaded.ok) return loaded;
  const cfg = loaded.cfg;
  const tasks = Array.isArray(cfg?.tasks) ? cfg.tasks : (cfg.tasks = []);
  const changes = [];
  const unknown = [];
  const findTask = (label) => {
    const byName = tasks.find((task) => task?.name === label);
    if (byName) return byName;
    const byId = tasks.find((task) => (task?.item_id || task?.name) === label);
    if (byId) return byId;
    unknown.push(String(label));
    return null;
  };

  for (const [list, flag] of [[args.enable, true], [args.disable, false]]) {
    if (list === undefined) continue;
    if (!Array.isArray(list)) return { ok: false, error: 'INVALID_ARGUMENT', message: 'enable/disable 必须是任务名数组' };
    for (const name of list) {
      const task = findTask(String(name));
      if (!task) continue;
      const from = task.is_checked !== false;
      if (from !== flag) {
        task.is_checked = flag;
        changes.push({ task: task.name, field: 'is_checked', from, to: flag });
      }
    }
  }

  if (args.controllerType !== undefined) {
    const iface = readInterface(root);
    const allowed = iface.ok ? (iface.data.controller || []).map((item) => item.name) : ['桌面端', '安卓端'];
    const value = String(args.controllerType);
    if (!allowed.includes(value)) return { ok: false, error: 'INVALID_CONTROLLER', value, allowed, hint: '取值来自 interface.json controller[].name' };
    const task = tasksOfType(cfg, 'Controller');
    if (!task) return { ok: false, error: 'CONTROLLER_TASK_MISSING', message: '配置里没有 Controller 伪任务，无法切换控制器' };
    if (!task.task_option || typeof task.task_option !== 'object') task.task_option = {};
    const from = task.task_option.controller_type ?? null;
    if (from !== value) {
      task.task_option.controller_type = value;
      changes.push({ task: 'Controller', field: 'controller_type', from, to: value });
    }
  }

  if (args.resource !== undefined) {
    const iface = readInterface(root);
    const allowed = iface.ok ? (iface.data.resource || []).map((item) => item.name) : [];
    const value = String(args.resource);
    if (allowed.length && !allowed.includes(value)) return { ok: false, error: 'INVALID_RESOURCE', value, allowed, hint: '取值来自 interface.json resource[].name' };
    const task = tasksOfType(cfg, 'Resource');
    if (!task) return { ok: false, error: 'RESOURCE_TASK_MISSING', message: '配置里没有 Resource 伪任务，无法切换资源包' };
    if (!task.task_option || typeof task.task_option !== 'object') task.task_option = {};
    const from = task.task_option.resource ?? null;
    if (from !== value) {
      task.task_option.resource = value;
      changes.push({ task: 'Resource', field: 'resource', from, to: value });
    }
  }

  if (args.taskOptions !== undefined) {
    if (!args.taskOptions || typeof args.taskOptions !== 'object' || Array.isArray(args.taskOptions)) {
      return { ok: false, error: 'INVALID_ARGUMENT', message: 'taskOptions 必须是 {任务名:{键:值}} 对象' };
    }
    for (const [taskName, opts] of Object.entries(args.taskOptions)) {
      const task = findTask(taskName);
      if (!task) continue;
      if (!opts || typeof opts !== 'object' || Array.isArray(opts)) return { ok: false, error: 'INVALID_ARGUMENT', message: `taskOptions.${taskName} 必须是对象` };
      if (!task.task_option || typeof task.task_option !== 'object') task.task_option = {};
      for (const [key, value] of Object.entries(opts)) {
        const entry = task.task_option[key];
        const isEntry = entry && typeof entry === 'object' && !Array.isArray(entry) && 'value' in entry;
        const from = isEntry ? entry.value : entry;
        if (value && typeof value === 'object' && !Array.isArray(value) && 'value' in value) task.task_option[key] = value;
        else if (isEntry) entry.value = value;
        else if (value && typeof value === 'object' && !Array.isArray(value)) task.task_option[key] = value;
        else task.task_option[key] = { value };
        const next = task.task_option[key];
        const to = next && typeof next === 'object' && !Array.isArray(next) && 'value' in next ? next.value : next;
        changes.push({ task: task.name, field: `task_option.${key}`, from, to });
      }
    }
  }

  if (unknown.length) return { ok: false, error: 'TASK_NOT_FOUND', tasks: [...new Set(unknown)], hint: '任务名要与配置里的 name 完全一致；用 maa_bbb_config_get 查看任务列表' };
  const setCurrent = args.setCurrent === true;
  if (!changes.length && !setCurrent) return { ok: true, configId: loaded.configId, file: loaded.file, changed: [], currentConfig: null, note: '没有产生改动（值已相同或未提供可改字段）' };

  let backup = null;
  let written = { bytes: loaded.bytes };
  if (changes.length) {
    try {
      backup = backupFile(loaded.file);
      written = writeJsonAtomic(loaded.file, cfg, loaded.style);
      JSON.parse(readText(loaded.file));
    } catch (error) {
      return { ok: false, error: 'CONFIG_WRITE_FAILED', file: loaded.file, message: errText(error), backup: backup || undefined };
    }
  }

  const processes = listMabProcesses(root.root);
  const multi = multiInfo(root);
  let currentConfig = multi.ok ? multi.data.curr_config_id ?? null : null;
  let multiBackup = null;
  if (setCurrent) {
    if (!multi.ok) return { ok: false, error: 'MULTI_CONFIG_UPDATE_FAILED', message: multi.message || multi.error, backup, note: changes.length ? '配置本身已写入，但 multi_config 不可用，未能设为当前配置' : 'multi_config 不可用，未能设为当前配置' };
    const data = multi.data;
    const list = Array.isArray(data.config_list) ? data.config_list : (data.config_list = []);
    if (!list.includes(loaded.configId)) list.push(loaded.configId);
    data.curr_config_id = loaded.configId;
    try {
      multiBackup = backupFile(multi.file);
      writeJsonAtomic(multi.file, data, multi.style);
      currentConfig = data.curr_config_id;
    } catch (error) {
      return { ok: false, error: 'MULTI_CONFIG_WRITE_FAILED', message: errText(error), backup, multiBackup: multiBackup || undefined, note: changes.length ? '配置本身已写入，但设为当前配置失败' : '设为当前配置失败' };
    }
  }
  return {
    ok: true,
    configId: loaded.configId,
    file: loaded.file,
    writtenBytes: written.bytes,
    style: loaded.style,
    backup,
    changed: changes,
    currentConfig,
    registered: multi.ok && Array.isArray(multi.data.config_list) ? multi.data.config_list.includes(loaded.configId) : null,
    multiBackup,
    running: processes.length > 0,
    warning: processes.length > 0 ? 'MAA_bbb 正在运行，它退出时可能回写配置覆盖本次修改；若要长期生效，建议先 maa_bbb_stop 再改。' : undefined,
  };
}

function toolConfigClone(args = {}) {
  const root = resolveRoot();
  if (!root.ok) return notInstalled(root);
  const loaded = loadConfig(root, args.fromConfigId);
  if (!loaded.ok) return loaded;
  const name = String(args.name ?? '').trim();
  if (!name) return { ok: false, error: 'INVALID_ARGUMENT', message: 'name 必填（新配置在 GUI 里显示的名字）' };
  const newId = args.newId
    ? String(args.newId).trim().replace(/\.json$/i, '')
    : `c_${randomBytes(16).toString('hex')}`;
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(newId) || newId === '.' || newId === '..') return { ok: false, error: 'INVALID_CONFIG_ID', newId, hint: 'id 只能由字母数字下划线连字符组成' };
  const dest = path.join(root.configsDir, `${newId}.json`);
  if (existsSync(dest)) return { ok: false, error: 'CONFIG_EXISTS', newConfigId: newId, file: dest };
  const multi = multiInfo(root);
  if (!multi.ok) return { ok: false, error: 'MULTI_CONFIG_UNREADABLE', file: multi.file || root.multiConfigPath, message: multi.message || multi.error };

  const clone = JSON.parse(JSON.stringify(loaded.cfg));
  clone.name = name;
  clone.item_id = newId;
  let written;
  try { written = writeJsonAtomic(dest, clone, loaded.style); } catch (error) { return { ok: false, error: 'CONFIG_WRITE_FAILED', file: dest, message: errText(error) }; }

  const data = multi.data;
  const list = Array.isArray(data.config_list) ? data.config_list : (data.config_list = []);
  if (!list.includes(newId)) list.push(newId);
  let multiBackup = null;
  try {
    multiBackup = backupFile(multi.file);
    writeJsonAtomic(multi.file, data, multi.style);
  } catch (error) {
    try { unlinkSync(dest); } catch {}
    return { ok: false, error: 'MULTI_CONFIG_WRITE_FAILED', message: errText(error), rolledBack: true, note: '新配置文件已回滚删除，避免出现未登记的孤儿配置' };
  }
  return {
    ok: true,
    newConfigId: newId,
    name,
    file: dest,
    bytes: written.bytes,
    registered: list.includes(newId),
    sourceConfigId: loaded.configId,
    currentConfig: data.curr_config_id ?? null,
    multiBackup,
  };
}

function toolPresets() {
  const root = resolveRoot();
  if (!root.ok) return notInstalled(root);
  const iface = readInterface(root);
  if (!iface.ok) return { ...iface };
  const presets = (Array.isArray(iface.data.preset) ? iface.data.preset : []).map((preset) => {
    const tasks = (Array.isArray(preset.task) ? preset.task : []).map((task) => ({ name: task.name, enabled: task.enabled !== false }));
    return { name: preset.name, label: preset.label ?? preset.name, taskCount: tasks.length, enabledCount: tasks.filter((task) => task.enabled).length, tasks };
  });
  return { ok: true, root: root.root, interfaceVersion: iface.data.interface_version ?? null, count: presets.length, presets };
}

async function toolRun(args = {}) {
  const root = resolveRoot();
  if (!root.ok) return notInstalled(root);
  const found = findConfigFile(root, args.configId);
  if (!found.ok) return found;
  const directRun = args.directRun !== false;
  const reuseExisting = args.reuseExisting === true;
  const forceRestart = args.forceRestart === true;
  const waitSeconds = clampInt(args.waitSeconds, 0, 0, 600);
  const cli = ['--config-id', found.id];
  if (directRun) cli.push('--direct-run');
  if (reuseExisting) cli.push('--reuse-existing');
  if (forceRestart) cli.push('--force-restart');
  let configName = null;
  try { configName = JSON.parse(readText(found.file)).name ?? null; } catch {}
  const before = listMabProcesses(root.root);
  let child;
  try {
    child = spawn(root.exe, cli, { cwd: root.root, detached: true, stdio: 'ignore', windowsHide: false });
  } catch (error) {
    return { ok: false, error: 'RUN_FAILED', message: errText(error), cli, root: root.root };
  }
  if (!child || !child.pid) return { ok: false, error: 'RUN_FAILED', message: 'spawn 未返回 pid', cli };
  child.on('error', (error) => log('mab.exe 启动失败：', errText(error)));
  child.unref();
  const startedAt = new Date().toISOString();
  let running = true;
  let waitedMs = 0;
  if (waitSeconds > 0) {
    await sleep(waitSeconds * 1000);
    waitedMs = waitSeconds * 1000;
    running = listMabProcesses(root.root).some((proc) => proc.pid === child.pid);
  }
  return {
    ok: true,
    pid: child.pid,
    configId: found.id,
    configName,
    cli,
    startedAt,
    directRun,
    reuseExisting,
    forceRestart,
    waitedMs,
    running,
    alreadyRunning: before.length > 0,
    ...(before.length > 0 && !forceRestart ? { warning: '启动前已有 mab.exe 在运行；新实例可能被转发或直接退出。需要强制重启时用 forceRestart:true，或先 maa_bbb_stop。' } : {}),
  };
}

async function toolStop(args = {}) {
  const root = resolveRoot();
  if (!root.ok) return notInstalled(root);
  const force = args.force === true;
  const before = listMabProcesses(root.root);
  if (!before.length) return { ok: true, root: root.root, found: [], killed: [], stillRunning: false, note: '没有找到在运行的 mab.exe' };
  const killed = before.map((proc) => killPid(proc.pid, force));
  let remaining = [];
  for (let i = 0; i < 10; i++) {
    await sleep(300);
    remaining = listMabProcesses(root.root);
    if (!remaining.length) break;
  }
  return {
    ok: remaining.length === 0,
    root: root.root,
    found: before.map((proc) => proc.pid),
    killed,
    stillRunning: remaining.length > 0,
    remaining,
    ...(remaining.length ? { hint: force ? '进程仍在：可能以管理员权限运行，需要用户手动结束（或提权后 taskkill /F）。' : '未加 force，进程仍在运行；确认要强制结束请用 force:true 重试。' } : {}),
  };
}

function toolLogTail(args = {}) {
  const root = resolveRoot();
  if (!root.ok) return notInstalled(root);
  const kind = String(args.kind ?? 'maafw').toLowerCase();
  const filename = LOG_KINDS[kind];
  if (!filename) return { ok: false, error: 'INVALID_KIND', kind, allowed: Object.keys(LOG_KINDS) };
  const file = path.join(root.debugDir, filename);
  const linesWanted = clampInt(args.lines, 80, 1, 1000);
  const filter = args.filter === undefined || args.filter === null ? '' : String(args.filter);
  let info;
  try {
    info = readLogLines(file);
  } catch (error) {
    return { ok: false, error: 'LOG_NOT_FOUND', kind, file, message: errText(error), hint: '该日志要等 MAA_bbb 跑过一次才会出现' };
  }
  const scanned = info.lines.length;
  let lines = scanned ? info.lines : [];
  let matched = lines.length;
  if (filter) {
    const needle = filter.toLowerCase();
    lines = lines.filter((line) => line.toLowerCase().includes(needle));
    matched = lines.length;
  }
  if (lines.length > linesWanted) lines = lines.slice(-linesWanted);
  return {
    ok: true,
    kind,
    file,
    size: info.size,
    mtime: info.mtime,
    truncated: info.truncated,
    scanned,
    filter: filter || null,
    matched,
    returned: lines.length,
    lines,
  };
}

function toolTaskCatalog(args = {}) {
  const root = resolveRoot();
  if (!root.ok) return notInstalled(root);
  const iface = readInterface(root);
  if (!iface.ok) return { ...iface };
  const catalog = loadTaskCatalog(root, iface.data);
  const group = args.group === undefined || args.group === null ? '' : String(args.group).trim();
  let groups = catalog.groups;
  if (group) {
    const needle = group.toLowerCase();
    groups = groups.filter((item) => item.name.toLowerCase().includes(needle));
    if (!groups.length) return { ok: false, error: 'GROUP_NOT_FOUND', group, available: catalog.groups.map((item) => item.name), hint: '组名支持模糊匹配；不传 group 看全部' };
  }
  const groupsOut = groups.map((item) => ({
    name: item.name,
    defaultExpand: item.defaultExpand,
    taskCount: item.tasks.length,
    tasks: item.tasks.map((task) => ({
      name: task.name,
      label: task.label,
      itemId: task.itemId,
      entry: task.entry,
      defaultCheck: task.defaultCheck,
      options: task.options.map((option) => option.key),
    })),
  }));
  const uniqueNames = new Set();
  let groupAssignments = 0;
  for (const item of groupsOut) for (const task of item.tasks) { uniqueNames.add(task.name); groupAssignments++; }
  return {
    ok: true,
    root: root.root,
    interfaceVersion: iface.data.interface_version ?? null,
    taskJsonFiles: catalog.fileCount,
    group: group || null,
    count: groupsOut.length,
    totalTasks: uniqueNames.size,
    groupAssignments,
    groups: groupsOut,
    warnings: catalog.warnings,
    note: 'itemId 从已有配置反查（GUI 随机生成、无法由任务名推导），查不到为 null；options 只给选项键，值域见任务的 option 定义。',
  };
}

const TOOLS = [
  {
    name: 'maa_bbb_status',
    description: 'MAA_bbb（识宝小助手）总览：安装根/版本、是否在运行、当前配置、全部配置摘要、adb/MuMu 可用性、maafw 日志尾部。未安装返回 MAA_NOT_INSTALLED。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'maa_bbb_config_list',
    description: '列出 config/configs/*.json 的摘要（名称、控制器、资源、已勾选任务、DISABLED 任务、当前配置）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'maa_bbb_config_get',
    description: '读取一个配置的完整 tasks（默认压缩 task_option，只保留生效值与选项键）。maxTasks 截断，full=true 看原始结构。',
    inputSchema: {
      type: 'object',
      properties: {
        configId: { type: 'string', description: '配置 id，如 c_cd0c4fa2a4d14330bac904139dfa5d2f' },
        maxTasks: { type: 'integer', minimum: 1, maximum: 2000, description: '最多返回多少个 task，默认 60' },
        full: { type: 'boolean', description: 'true = 返回原始 task_option（含 branches / _speedrun_config 全量）' },
      },
      required: ['configId'],
      additionalProperties: false,
    },
  },
  {
    name: 'maa_bbb_config_update',
    description: '只改指定字段：enable/disable 任务、controllerType（桌面端/安卓端）、resource、taskOptions（任务名→{选项键:值}）、setCurrent。原子写 + 备份。<br>注意：MAA_bbb 在运行时它退出可能回写覆盖，建议先 maa_bbb_stop。',
    inputSchema: {
      type: 'object',
      properties: {
        configId: { type: 'string' },
        enable: { type: 'array', items: { type: 'string' }, description: '要勾选的任务名数组' },
        disable: { type: 'array', items: { type: 'string' }, description: '要取消勾选的任务名数组' },
        controllerType: { type: 'string', enum: ['桌面端', '安卓端'] },
        resource: { type: 'string', description: '资源包名，如 键鼠操作 / 键鼠操作（繁中）' },
        taskOptions: { type: 'object', additionalProperties: { type: 'object' }, description: '{"任务名":{"选项键":值}}；保留原有 branches' },
        setCurrent: { type: 'boolean', description: '同时把该配置设为 multi_config.curr_config_id' },
      },
      required: ['configId'],
      additionalProperties: false,
    },
  },
  {
    name: 'maa_bbb_config_clone',
    description: '克隆一份配置（默认新 id = c_ + 32 位随机 hex），写 config/configs 并登记进 multi_config.config_list。',
    inputSchema: {
      type: 'object',
      properties: {
        fromConfigId: { type: 'string' },
        name: { type: 'string', description: '新配置的人类可读名（GUI 里显示）' },
        newId: { type: 'string', description: '可选：指定新 id，默认随机生成' },
      },
      required: ['fromConfigId', 'name'],
      additionalProperties: false,
    },
  },
  {
    name: 'maa_bbb_presets',
    description: '读 interface.json 的 3 个 preset（日常-简化版 / 日常-完整版 / 建议单独运行）及其任务启用清单。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'maa_bbb_run',
    description: '启动 mab.exe 跑配置：--config-id <id> --direct-run（默认开）。可加 --reuse-existing / --force-restart。waitSeconds>0 时等待并确认进程是否存活。会真的控制游戏窗口。',
    inputSchema: {
      type: 'object',
      properties: {
        configId: { type: 'string' },
        directRun: { type: 'boolean', description: '默认 true；false 时只启动 GUI 不跑任务' },
        reuseExisting: { type: 'boolean', description: '--reuse-existing：优先复用已运行实例（仅与 direct-run 同用才跑任务）' },
        forceRestart: { type: 'boolean', description: '--force-restart：请求已有实例停止并退出后再启动' },
        waitSeconds: { type: 'integer', minimum: 0, maximum: 600, description: '默认 0 = 立即返回；最多 600' },
      },
      required: ['configId'],
      additionalProperties: false,
    },
  },
  {
    name: 'maa_bbb_stop',
    description: '结束安装根下运行的 mab.exe（taskkill /PID /T；force=true 才加 /F）。返回 killed 与仍在跑的进程。',
    inputSchema: {
      type: 'object',
      properties: { force: { type: 'boolean', description: '默认 false；true 时强制结束' } },
      additionalProperties: false,
    },
  },
  {
    name: 'maa_bbb_log_tail',
    description: '读 <root>/debug/<kind>.log 尾部；filter 为不区分大小写的子串过滤，lines 为返回行数上限。',
    inputSchema: {
      type: 'object',
      properties: {
        lines: { type: 'integer', minimum: 1, maximum: 1000, description: '返回多少行，默认 80' },
        kind: { type: 'string', enum: ['maafw', 'gui', 'crash'], description: '默认 maafw' },
        filter: { type: 'string', description: '子串过滤（不区分大小写）' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'maa_bbb_task_catalog',
    description: '从 interface.json 的 group + tasks/**.json 汇总任务目录（36 个文件、39 个任务定义，JSONC 也能解析）。可按 group 模糊过滤。',
    inputSchema: {
      type: 'object',
      properties: { group: { type: 'string', description: '组名，如 日常 / 周常 / 商店；支持模糊匹配' } },
      additionalProperties: false,
    },
  },
];

const HANDLERS = {
  maa_bbb_status: toolStatus,
  maa_bbb_config_list: toolConfigList,
  maa_bbb_config_get: toolConfigGet,
  maa_bbb_config_update: toolConfigUpdate,
  maa_bbb_config_clone: toolConfigClone,
  maa_bbb_presets: toolPresets,
  maa_bbb_run: toolRun,
  maa_bbb_stop: toolStop,
  maa_bbb_log_tail: toolLogTail,
  maa_bbb_task_catalog: toolTaskCatalog,
};

/** 把工具普通对象包成 MCP content；超长时优先裁数组（旧→新只留最新），再兜底 preview。 */
function toolResult(payload) {
  const isError = Boolean(payload && payload.ok === false);
  const wrap = (text) => {
    const result = { content: [{ type: 'text', text }] };
    if (isError) result.isError = true;
    return result;
  };
  let text;
  try { text = JSON.stringify(payload, null, 2); } catch (error) { text = JSON.stringify({ ok: false, error: 'SERIALIZE_FAILED', message: errText(error) }, null, 2); }
  if (Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES) return wrap(text);
  let copy = null;
  try { copy = JSON.parse(text); } catch {}
  if (copy && typeof copy === 'object') {
    const arrays = [];
    (function walk(node) {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        arrays.push(node);
        for (const item of node) walk(item);
        return;
      }
      for (const value of Object.values(node)) walk(value);
    })(copy);
    const size = () => Buffer.byteLength(JSON.stringify(copy), 'utf8');
    let omitted = 0;
    while (size() > MAX_TEXT_BYTES - 600) {
      let dropped = false;
      for (const arr of arrays) {
        while (arr.length > 1 && size() > MAX_TEXT_BYTES - 600) {
          const drop = Math.max(1, Math.floor(arr.length / 2));
          arr.splice(0, drop);
          omitted += drop;
          dropped = true;
        }
      }
      if (!dropped) break;
    }
    if (omitted && size() <= MAX_TEXT_BYTES) {
      copy.truncated = true;
      copy.truncatedItems = omitted;
      copy.truncationNote = `输出过长，列表/日志已按「保留最新」省略前 ${omitted} 项；可缩小 lines / maxTasks 或分次读取。`;
      text = JSON.stringify(copy, null, 2);
      if (Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES) return wrap(text);
    }
  }
  const preview = JSON.stringify({
    ok: !isError,
    truncated: true,
    note: `输出超过 ${MAX_TEXT_BYTES} 字节，已截断；请缩小 lines / maxTasks / 加 filter。`,
    preview: byteSlice(text, MAX_TEXT_BYTES - 700),
  }, null, 2);
  return wrap(preview);
}

function send(message) {
  try { process.stdout.write(`${JSON.stringify(message)}\n`); } catch (error) { log('stdout 写失败：', errText(error)); }
}

function sendResult(id, result) { send({ jsonrpc: '2.0', id, result }); }
function sendError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handle(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  const { id, method, params } = message;
  const isNotification = id === undefined || id === null;
  if (typeof method !== 'string') {
    if (!isNotification) sendError(id, -32600, 'Invalid Request');
    return;
  }
  switch (method) {
    case 'initialize':
      sendResult(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
      return;
    case 'notifications/initialized':
    case 'notifications/cancelled':
    case 'logging/setLevel':
      return;
    case 'ping':
      sendResult(id, {});
      return;
    case 'tools/list':
      sendResult(id, { tools: TOOLS });
      return;
    case 'resources/list':
      sendResult(id, { resources: [] });
      return;
    case 'resources/templates/list':
      sendResult(id, { resourceTemplates: [] });
      return;
    case 'prompts/list':
      sendResult(id, { prompts: [] });
      return;
    case 'tools/call': {
      const name = params && typeof params.name === 'string' ? params.name : '';
      const args = params && params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const handler = HANDLERS[name];
      if (!handler) { sendError(id, -32602, `未知工具：${name || '(空)'}`); return; }
      try {
        const payload = await handler(args);
        sendResult(id, toolResult(payload));
      } catch (error) {
        log(`工具 ${name} 抛异常：`, errText(error));
        sendResult(id, toolResult({ ok: false, error: 'TOOL_EXCEPTION', tool: name, message: errText(error), hint: '工具内部异常已捕获；可重试，或先用 maa_bbb_status 确认环境。' }));
      }
      return;
    }
    default:
      if (!isNotification) sendError(id, -32601, `Method not found: ${method}`);
  }
}

let buffer = '';
let active = 0;
let stdinEnded = false;

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index).replace(/\r$/, '').trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      sendError(null, -32700, 'Parse error');
      continue;
    }
    active++;
    handle(message)
      .catch((error) => log('消息处理异常：', errText(error)))
      .finally(() => { active--; });
  }
});

process.stdin.on('end', () => {
  stdinEnded = true;
  const deadline = Date.now() + 30000;
  const timer = setInterval(() => {
    if (active === 0 || Date.now() > deadline) {
      clearInterval(timer);
      process.exit(0);
    }
  }, 100);
  timer.unref?.();
});

process.on('uncaughtException', (error) => log('uncaughtException：', errText(error)));
process.on('unhandledRejection', (error) => log('unhandledRejection：', errText(error)));

log(`启动 v${SERVER_INFO.version}；stateDir=${stateDir()}；stdin ${stdinEnded ? '已结束' : '就绪'}`);
