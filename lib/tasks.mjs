// Windows 计划任务：查询 / 启动 / 注册（注册走提权脚本，结果异步落到 result 文件）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveNodeExe } from './nodeexe.mjs';

const PS = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
const TASKS_DIR = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'Tasks') : 'C:\\Windows\\System32\\Tasks';
const QUERY_TTL_MS = 8000;
/** Get-ScheduledTask 单次 10s+，绝不能挡在 HTTP 请求路径上：只做后台刷新，请求读缓存。 */
const INFO_TTL_MS = 60000;
let queryCache = new Map();
let infoCache = new Map();
let infoRefresh = null;

function wrapperPrefix() {
  // PS 5.1 默认按控制台代码页（本机 936）输出中文 → Node 按 UTF-8 解码会乱码，必须强转。
  return `$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
`;
}
function wrappedPowerShell(script) {
  return wrapperPrefix() + script;
}

function runPowerShell(script, { timeout = 20000 } = {}) {
  const wrapped = wrappedPowerShell(script);
  try {
    const stdout = execFileSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapped], {
      encoding: 'utf8',
      windowsHide: true,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ok: true, stdout: String(stdout || '').replace(/^\uFEFF/, '').trim() };
  } catch (error) {
    const stderr = error && error.stderr ? String(error.stderr) : String((error && error.message) || error);
    return { ok: false, error: stderr.trim() };
  }
}

function psQuote(value) {
  return `'${String(value == null ? '' : value).replace(/'/g, "''")}'`;
}

/**
 * 直接读 `%SystemRoot%\System32\Tasks\<name>`（UTF-16LE XML）拿到任务定义。
 * 比 Get-ScheduledTask 快两个数量级（毫秒级），且不需要管理员权限。
 * 拿不到「下次运行 / 上次结果」——那部分由 refreshTaskInfo() 在后台补。
 */
export function readTaskDefinition(taskName) {
  const name = String(taskName || '').replace(/^\\+/, '');
  if (!name) return { exists: false };
  const file = path.join(TASKS_DIR, name);
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return { exists: false };
  }
  let text;
  try {
    text = raw[0] === 0xff && raw[1] === 0xfe ? raw.toString('utf16le') : raw.toString('utf8').replace(/^\uFEFF/, '');
  } catch {
    return { exists: false };
  }
  const blockOf = (tag) => {
    const m = text.match(new RegExp(`<${tag}\\b[\\s\\S]*?</${tag}>`));
    return m ? m[0] : '';
  };
  const first = (source, re) => {
    const m = source.match(re);
    return m ? m[1] : '';
  };
  const settings = blockOf('Settings');
  const triggers = blockOf('Triggers');
  const actions = blockOf('Actions');
  const principals = blockOf('Principals');
  const enabled = first(settings, /<Enabled>(true|false)<\/Enabled>/) !== 'false';
  const startBoundary = first(triggers, /<StartBoundary>([^<]+)<\/StartBoundary>/);
  const daysInterval = Number(first(triggers, /<DaysInterval>(\d+)<\/DaysInterval>/) || 1);
  const daysOfWeek = (triggers.match(/<DaysOfWeek>([^<]+)<\/DaysOfWeek>/) || [])[1] || '';
  const triggerKind = triggers.includes('<ScheduleByWeek')
    ? 'weekly'
    : triggers.includes('<ScheduleByDay')
      ? 'daily'
      : triggers.includes('<TimeTrigger') || triggers.includes('<CalendarTrigger')
        ? 'calendar'
        : triggers.includes('<BootTrigger>')
          ? 'boot'
          : 'unknown';
  return {
    exists: true,
    state: enabled ? 'Registered' : 'Disabled',
    enabled,
    runLevel: first(principals, /<RunLevel>([^<]+)<\/RunLevel>/),
    userId: first(principals, /<UserId>([^<]+)<\/UserId>/),
    actions: actions ? [[first(actions, /<Command>([^<]*)<\/Command>/), first(actions, /<Arguments>([^<]*)<\/Arguments>/)].join('|')] : [],
    command: first(actions, /<Command>([^<]*)<\/Command>/),
    arguments: first(actions, /<Arguments>([^<]*)<\/Arguments>/),
    workingDirectory: first(actions, /<WorkingDirectory>([^<]*)<\/WorkingDirectory>/),
    triggers: triggerKind === 'unknown' ? [] : [triggerKind],
    trigger: { kind: triggerKind, startBoundary, daysInterval, daysOfWeek },
    startWhenAvailable: first(settings, /<StartWhenAvailable>(true|false)<\/StartWhenAvailable>/) === 'true',
    executionTimeLimit: first(settings, /<ExecutionTimeLimit>([^<]+)<\/ExecutionTimeLimit>/),
  };
}

/** 从排班配置算下一次运行（本地计算，不依赖 Windows 调度服务）。 */
export function computeNextRun(schedule, now = new Date()) {
  const time = schedule && typeof schedule.time === 'string' ? schedule.time : '';
  const m = /^(\d{2}):(\d{2})$/.exec(time);
  if (!m) return '';
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  const raw = schedule.weekdays;
  const days = raw === 'daily' || raw == null
    ? [0, 1, 2, 3, 4, 5, 6]
    : Array.isArray(raw)
      ? [...new Set(raw.map((d) => Number(d) % 7).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))]
      : [0, 1, 2, 3, 4, 5, 6];
  if (!days.length) return '';
  for (let i = 0; i <= 8; i += 1) {
    const d = new Date(now);
    d.setDate(now.getDate() + i);
    d.setHours(hh, mm, 0, 0);
    if (d.getTime() <= now.getTime()) continue;
    if (days.includes(d.getDay())) return d.toISOString();
  }
  return '';
}

/**
 * 同步查询（毫秒级）：只读任务 XML。`info` 字段来自后台缓存（可能为空）。
 * 返回值形状保持与旧版兼容：exists/state/nextRunTime/lastRunTime/lastTaskResult/runLevel/actions/triggers。
 */
export function queryTasks(names, { force = false } = {}) {
  const list = [...new Set((names || []).filter((n) => typeof n === 'string' && n))];
  const result = {};
  const now = Date.now();
  for (const name of list) {
    let base;
    const hit = queryCache.get(name);
    if (!force && hit && now - hit.at < QUERY_TTL_MS) {
      base = hit.value;
    } else {
      base = readTaskDefinition(name);
      queryCache.set(name, { at: now, value: base });
    }
    const info = infoCache.get(name);
    result[name] = {
      ...base,
      nextRunTime: (info && info.nextRunTime) || '',
      lastRunTime: (info && info.lastRunTime) || '',
      lastTaskResult: info && info.lastTaskResult !== undefined ? info.lastTaskResult : null,
      infoAt: info ? info.at : 0,
    };
  }
  return result;
}

/** 后台刷新 Get-ScheduledTaskInfo（下次运行 / 上次结果 / 真实 State），单飞 + 缓存 60s。 */
export function refreshTaskInfo(names, { force = false } = {}) {
  const list = [...new Set((names || []).filter((n) => typeof n === 'string' && n))];
  const now = Date.now();
  const stale = list.filter((name) => {
    const hit = infoCache.get(name);
    return force || !hit || now - hit.at > INFO_TTL_MS;
  });
  if (!stale.length) return Promise.resolve(false);
  if (infoRefresh) return infoRefresh;
  const script = `
$names = @(${stale.map(psQuote).join(',')})
$rows = @()
foreach ($n in $names) {
  $t = Get-ScheduledTask -TaskName $n -ErrorAction SilentlyContinue
  if ($null -eq $t) { $rows += @{ name = $n; exists = $false }; continue }
  $i = Get-ScheduledTaskInfo -TaskName $n -ErrorAction SilentlyContinue
  $next = ''; $last = ''; $code = $null
  if ($null -ne $i) {
    try { $next = [string]$i.NextRunTime.ToString('o') } catch { $next = '' }
    try { $last = [string]$i.LastRunTime.ToString('o') } catch { $last = '' }
    try { $code = $i.LastTaskResult } catch { $code = $null }
  }
  $rows += @{ name = $n; exists = $true; state = [string]$t.State; nextRunTime = $next; lastRunTime = $last; lastTaskResult = $code }
}
ConvertTo-Json -InputObject @($rows) -Compress -Depth 6
`.trim();
  infoRefresh = new Promise((resolve) => {
    execFile(
      PS,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrappedPowerShell(script)],
      { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        try {
          if (!error && stdout) {
            const parsed = JSON.parse(String(stdout).replace(/^\uFEFF/, '').trim() || '[]');
            const at = Date.now();
            for (const row of parsed) {
              if (!row || typeof row.name !== 'string') continue;
              infoCache.set(row.name, {
                at,
                nextRunTime: row.nextRunTime || '',
                lastRunTime: row.lastRunTime || '',
                lastTaskResult: row.lastTaskResult === undefined ? null : row.lastTaskResult,
                state: row.state || '',
                exists: row.exists !== false,
              });
            }
            for (const name of stale) {
              if (!infoCache.has(name)) infoCache.set(name, { at, nextRunTime: '', lastRunTime: '', lastTaskResult: null, state: '', exists: false });
            }
          }
        } catch {
          /* 解析失败就保持旧缓存 */
        }
        infoRefresh = null;
        resolve(true);
      },
    );
  });
  return infoRefresh;
}

function normalizeTaskRow(row) {
  if (!row) return { exists: false };
  return {
    exists: row.exists === true,
    state: row.state || '',
    nextRunTime: row.nextRunTime || '',
    lastRunTime: row.lastRunTime || '',
    lastTaskResult: row.lastTaskResult === null || row.lastTaskResult === undefined ? null : Number(row.lastTaskResult),
    runLevel: row.runLevel || '',
    userId: row.userId || '',
    command: row.command || '',
    arguments: row.arguments || '',
    workingDirectory: row.workingDirectory || '',
    trigger: row.trigger || null,
    startWhenAvailable: row.startWhenAvailable === true,
    actions: Array.isArray(row.actions) ? row.actions : [],
    triggers: Array.isArray(row.triggers) ? row.triggers : [],
    error: row.error || '',
  };
}

export function taskStatus(taskName, options) {
  const row = queryTasks([taskName], options)[taskName];
  return normalizeTaskRow(row);
}

export function nextRunAt(taskName) {
  const row = taskStatus(taskName);
  return row.exists && row.nextRunTime ? row.nextRunTime : '';
}

/** 立即启动一个任务（任务所有者在交互式会话中时无需管理员）。异步：不阻塞事件循环。 */
export function startTask(taskName) {
  const script = `
try { Start-ScheduledTask -TaskName ${psQuote(taskName)} -ErrorAction Stop; '{"ok":true}' }
catch { ConvertTo-Json -InputObject @{ ok = $false; error = [string]$_.Exception.Message } -Compress }
`.trim();
  return new Promise((resolve) => {
    execFile(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrappedPowerShell(script)], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 20000,
      maxBuffer: 2 * 1024 * 1024,
    }, (error, stdout) => {
      const text = String(stdout || '').replace(/^\uFEFF/, '').trim();
      if (!text) {
        resolve({ ok: false, error: String((error && error.message) || error || 'Start-ScheduledTask 无输出') });
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        resolve({ ok: false, error: `无法解析 Start-ScheduledTask 输出：${text.slice(0, 200)}` });
      }
    });
  });
}

/** 计划任务的注册动作（由 automation/game-daily-register.ps1 执行）。 */
export function automationDir(stateDir) {
  return path.join(stateDir, 'automation');
}

export function tasksConfigPath(stateDir) {
  return path.join(automationDir(stateDir), 'tasks.json');
}

export function registerScriptPath(stateDir) {
  return path.join(automationDir(stateDir), 'game-daily-register.ps1');
}

export function registerResultPath(stateDir) {
  return path.join(automationDir(stateDir), 'register-result.json');
}

/**
 * 把包内的注册脚本同步到 stateDir/automation/。
 * 计划任务动作里写的是 stateDir 中的副本：包目录可能被升级/卸载，stateDir 才是稳定落点。
 */
export function ensureRegisterScript(stateDir) {
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'automation', 'game-daily-register.ps1');
  const target = registerScriptPath(stateDir);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const wanted = fs.readFileSync(source);
    let current = null;
    try {
      current = fs.readFileSync(target);
    } catch {
      /* 目标还不存在 */
    }
    if (!current || !current.equals(wanted)) {
      fs.writeFileSync(target, wanted);
      return { ok: true, copied: true, path: target };
    }
    return { ok: true, copied: false, path: target };
  } catch (error) {
    return { ok: false, error: `同步注册脚本失败：${String(error?.message || error)}`, path: target };
  }
}

/** 生成 tasks.json（注册脚本的唯一输入）。 */
export function writeTasksConfig(stateDir, { taskPrefix, games, runnerScript, scriptPath, nodeExe, profile, skillsRoot }) {
  const dir = automationDir(stateDir);
  fs.mkdirSync(dir, { recursive: true });
  // 双重保险：桌面端里 process.execPath 是 Electron 而不是 node，拿它注册任务会静默空跑。
  const safeNode = nodeExe && /node(\.exe)?$/i.test(String(nodeExe)) ? nodeExe : resolveNodeExe();
  const payload = {
    schemaVersion: 1,
    taskPrefix,
    runnerScript,
    nodeExe: safeNode || process.execPath,
    profile: profile || 'headless',
    skillsRoot: skillsRoot || '',
    generateScript: scriptPath || '',
    stateDir,
    games: games.map((game) => ({
      id: game.id,
      title: game.title,
      taskName: game.taskName,
      time: game.schedule.time,
      weekdays: game.schedule.weekdays,
      catchUp: game.schedule.catchUp === true,
      timeoutMin: game.timeoutMin,
      mode: game.mode === 'dry' ? 'dry' : 'real',
      enabled: game.enabled === true,
    })),
    writtenAt: new Date().toISOString(),
  };
  const file = tasksConfigPath(stateDir);
  fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return file;
}

/**
 * 异步启动注册脚本。脚本自己判断是否需要提权（改计划任务需要管理员），
 * 结果写到 register-result.json，调用方靠轮询 state/文件拿结果。
 */
export function startRegistration({ stateDir, dryRun = false, removeAll = false, noElevate = false }) {
  const script = registerScriptPath(stateDir);
  if (!fs.existsSync(script)) return { ok: false, error: `注册脚本不存在：${script}` };
  try {
    fs.rmSync(registerResultPath(stateDir), { force: true });
  } catch {
    /* ignore */
  }
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-StateDir', stateDir];
  if (dryRun) args.push('-DryRun');
  if (removeAll) args.push('-Remove', '-All');
  if (noElevate) args.push('-NoElevate');
  const child = spawn(PS, args, { cwd: stateDir, windowsHide: true, stdio: 'ignore', detached: false });
  child.on('error', () => {
    /* 记日志由调用方轮询超时兜底 */
  });
  return { ok: true, pid: child.pid };
}

export function readRegisterResult(stateDir) {
  const file = registerResultPath(stateDir);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
