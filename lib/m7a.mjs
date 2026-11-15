/**
 * lib/m7a.mjs — 三月七小助手（March7thAssistant / M7A）的最小控制层。
 *
 * 用途：
 *   - 依赖体检：找到安装目录、读 m7a.exe --status、判断游戏路径与首次确认状态；
 *   - runner / prompt 里给出环境事实与运行入口（m7a.exe 的任务 id、退出码含义）；
 *   - 读运行记录 / 日志，供 agent 值守时判断成败与介入时机。
 *
 * 不在这里做任何游戏画面操作：识别与点击全部交给三月七小助手自己。
 * 唯一的外部契约来自 M7A 官方 agent skill（m7a.exe 命令行 + logs/runs 记录格式）。
 */

import { spawnSync } from 'node:child_process';
import fs, { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_DIR_DEFAULT = path.join(os.homedir(), '.dsh', 'game-daily');

/** 崩铁默认跑哪个 M7A 任务（可用环境变量覆盖；main = 完整运行 = 日常+清体力）。 */
export const DEFAULT_M7A_TASK = process.env.DSH_GAME_DAILY_SR_M7A_TASK || 'main';

/** 退出码 → 语义（M7A 官方约定）。 */
export const M7A_EXIT = {
  0: { status: 'success', label: '成功' },
  1: { status: 'failed', label: '任务失败' },
  2: { status: 'bad-args', label: '参数错误' },
  3: { status: 'first-run-required', label: '首次使用尚未确认（必须用户本人在图形界面确认免责声明）' },
  4: { status: 'busy', label: '已有任务在运行，本次未执行' },
  5: { status: 'no-uac', label: '没有获得管理员权限（UAC 被取消）' },
  6: { status: 'stopped', label: '任务被停止指令中止' },
};

export function exitMeaning(code) {
  return M7A_EXIT[code] || { status: 'unknown', label: `未知退出码 ${code}` };
}

export function stateDir() {
  return process.env.DSH_GAME_DAILY_STATE_DIR || STATE_DIR_DEFAULT;
}

/** 安装位置书签：安装/体检时把实际根目录写在这里，后续 m7aRoot() 优先读它。 */
export function m7aPointerPath() {
  return path.join(stateDir(), 'm7a-root.txt');
}

/** M7A 自己维护的安装登记表（GUI 每次启动都会写）。 */
export function m7aInstallsJsonPath() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  return path.join(local, 'March7thAssistant', 'installs.json');
}

const CONFIG_WHITELIST = [
  'game_path',
  'after_finish',
  'daily_enable',
  'power_enable',
  'auto_set_resolution_enable',
  'auto_set_game_path_enable',
  'pause_after_success',
  'exit_after_failure',
  'check_update',
  'cloud_game_enable',
  'start_game_timeout',
  // 体力用途（对齐用户口径：只刷培养角色的材料/遗器，不打信用点与角色经验）
  'instance_type',
  'activity_gardenofplenty_instance_type',
  'build_target_enable',
  'echo_of_war_enable',
  'power_plan_keep',
];

export function m7aConfigWhitelist() {
  return CONFIG_WHITELIST.slice();
}

/** 某个具体目录下的 M7A 是否完整（不用于探测候选，只做校验）。 */
export function inspectM7aInstallRoot(root) {
  const dir = String(root || '').trim();
  const file = (name) => path.join(dir, name);
  const exe = file('m7a.exe');
  const launcher = file('March7th Launcher.exe');
  const legacy = file('March7th Assistant.exe');
  const config = file('config.yaml');
  const exampleConfig = path.join(dir, 'assets', 'config', 'config.example.yaml');
  const versionFile = path.join(dir, 'assets', 'config', 'version.txt');
  const runsDir = path.join(dir, 'logs', 'runs');
  const hasExe = Boolean(dir) && existsSync(exe);
  const looksLikeRoot = Boolean(dir) && (existsSync(exampleConfig) || existsSync(launcher) || existsSync(legacy) || existsSync(config));
  let version = '';
  try {
    version = readFileSync(versionFile, 'utf8').trim().slice(0, 80);
  } catch {
    version = '';
  }
  return {
    root: dir,
    exe,
    launcher,
    legacy,
    config,
    exampleConfig,
    versionFile,
    runsDir,
    hasExe,
    looksLikeRoot,
    version,
    /** 旧版（没有 m7a.exe）也算「找到了安装」，但要提示升级。 */
    ok: hasExe && looksLikeRoot,
    legacyOnly: !hasExe && looksLikeRoot,
  };
}

/** 从 installs.json 里容错地读出所有登记过的安装路径。 */
export function readInstallBookmarks() {
  const file = m7aInstallsJsonPath();
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return { file, paths: [], error: 'missing' };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { file, paths: [], error: 'bad-json' };
  }
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data && data.installs)
      ? data.installs
      : Array.isArray(data && data.data)
        ? data.data
        : [];
  const paths = [];
  for (const item of list) {
    if (typeof item === 'string') {
      paths.push(item);
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const candidate =
      item.path || item.install_path || item.installPath || item.root || item.dir || item.directory || item.location;
    if (candidate) paths.push(String(candidate));
  }
  if (!paths.length && data && typeof data === 'object') {
    for (const value of Object.values(data)) {
      if (typeof value === 'string' && /[\\/]/.test(value)) paths.push(value);
    }
  }
  return { file, paths, error: '' };
}

function candidateRoots() {
  const home = os.homedir();
  const list = [
    path.join(home, 'Games', 'March7thAssistant'),
    'D:\\March7thAssistant',
    'E:\\software\\March7thAssistant',
    'D:\\software\\March7thAssistant',
    path.join(home, 'March7thAssistant'),
  ];
  const unique = [];
  for (const dir of list) if (dir && !unique.includes(dir)) unique.push(dir);
  return unique;
}

/** 找到可用的 M7A 根目录；找不到返回 ''（调用方负责给用户可执行的提示）。 */
export function m7aRoot() {
  const fromEnv = (process.env.DSH_GAME_DAILY_M7A_ROOT || process.env.M7A_ROOT || '').trim();
  if (fromEnv && inspectM7aInstallRoot(fromEnv).ok) return fromEnv;
  try {
    const pointer = readFileSync(m7aPointerPath(), 'utf8').trim();
    if (pointer && inspectM7aInstallRoot(pointer).ok) return pointer;
  } catch {
    /* 没有书签就继续探测 */
  }
  const bookmarks = readInstallBookmarks();
  for (const dir of bookmarks.paths) {
    if (inspectM7aInstallRoot(dir).ok) return dir;
  }
  for (const dir of candidateRoots()) {
    if (inspectM7aInstallRoot(dir).ok) return dir;
  }
  return '';
}

export function m7aInstallInfo() {
  const root = m7aRoot();
  if (root) {
    return { ok: true, root, install: inspectM7aInstallRoot(root), bookmarks: readInstallBookmarks() };
  }
  const bookmarks = readInstallBookmarks();
  const legacy = [...bookmarks.paths, ...candidateRoots()]
    .map((dir) => inspectM7aInstallRoot(dir))
    .find((info) => info.legacyOnly);
  return {
    ok: false,
    root: '',
    error: 'M7A_NOT_INSTALLED',
    hint: M7A_MISSING_HINT,
    bookmarks,
    legacyOnly: Boolean(legacy),
    legacyRoot: legacy ? legacy.root : '',
    searched: [...bookmarks.paths, ...candidateRoots()].filter(Boolean).slice(0, 8),
  };
}

export const M7A_MISSING_HINT =
  '未找到三月七小助手（m7a.exe）。装法：GitHub Releases 下载 March7thAssistant_full.zip → 解压到 %USERPROFILE%\\Games\\March7thAssistant（别装 C:\\Program Files）→ 打开 March7th Launcher.exe 由用户本人确认免责声明 → 在图形界面确认游戏路径。也可点本插件的「修复」让 DSH 协助安装与配置。';

/** 记录安装位置（体检/修复成功后调用）。 */
export function writeM7aPointer(root) {
  try {
    fs.mkdirSync(path.dirname(m7aPointerPath()), { recursive: true });
    fs.writeFileSync(m7aPointerPath(), String(root || '').trim(), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** 从混合输出里抠出第一段 JSON（M7A 的 JSON 只含 ASCII，前后可能有日志行）。 */
export function extractJson(text) {
  const s = String(text || '');
  const starts = [];
  const objAt = s.indexOf('{');
  const arrAt = s.indexOf('[');
  if (objAt >= 0) starts.push({ at: objAt, close: '}' });
  if (arrAt >= 0) starts.push({ at: arrAt, close: ']' });
  if (!starts.length) return null;
  starts.sort((a, b) => a.at - b.at);
  const { at, close } = starts[0];
  const end = s.lastIndexOf(close);
  if (end <= at) return null;
  try {
    return JSON.parse(s.slice(at, end + 1));
  } catch {
    return null;
  }
}

function spawnM7a(root, args, { timeoutMs = 30000, maxBuffer = 4 * 1024 * 1024 } = {}) {
  const exe = path.join(root, 'm7a.exe');
  const result = spawnSync(exe, args, {
    cwd: root,
    timeout: timeoutMs,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
  });
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '');
  const timedOut = Boolean(result.error && result.error.code === 'ETIMEDOUT');
  return {
    ok: result.status === 0,
    code: typeof result.status === 'number' ? result.status : null,
    timedOut,
    stdout,
    stderr,
    error: result.error ? String(result.error.message || result.error) : '',
    args,
  };
}

/** m7a.exe --status --json 的同步封装（给依赖体检用）。 */
export function m7aStatusSync({ timeoutMs = 25000 } = {}) {
  const info = m7aInstallInfo();
  if (!info.ok) return { ok: false, ...info };
  const res = spawnM7a(info.root, ['--status', '--json'], { timeoutMs });
  const data = extractJson(res.stdout) || extractJson(res.stderr);
  if (!data) {
    return {
      ok: false,
      root: info.root,
      error: 'M7A_STATUS_UNPARSABLE',
      hint: 'm7a.exe --status --json 没有输出可解析的 JSON；旧版本可能没有 m7a.exe，请更新小助手。',
      exitCode: res.code,
      timedOut: res.timedOut,
      raw: (res.stdout || res.stderr || '').slice(0, 600),
    };
  }
  return {
    ok: true,
    root: info.root,
    install: info.install,
    version: data.version || info.install.version || '',
    exitCode: res.code,
    status: data,
  };
}

/** m7a.exe --list --json：任务 id 与名称。 */
export function m7aListSync({ timeoutMs = 25000 } = {}) {
  const info = m7aInstallInfo();
  if (!info.ok) return { ok: false, ...info };
  const res = spawnM7a(info.root, ['--list', '--json'], { timeoutMs });
  const data = extractJson(res.stdout) || extractJson(res.stderr);
  if (!data) {
    return { ok: false, root: info.root, error: 'M7A_LIST_UNPARSABLE', exitCode: res.code, raw: (res.stdout || '').slice(0, 400) };
  }
  return { ok: true, root: info.root, tasks: data, exitCode: res.code };
}

/** 读 config.yaml 的白名单键（行内 `key: value # comment` 形式）。 */
export function m7aReadConfig(rootInput) {
  const root = rootInput || m7aRoot();
  if (!root) return { ok: false, error: 'M7A_NOT_INSTALLED' };
  const file = path.join(root, 'config.yaml');
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, root, file, error: `读不到 config.yaml：${String((error && error.message) || error)}` };
  }
  const values = {};
  for (const key of CONFIG_WHITELIST) {
    const re = new RegExp(`^${key}\\s*:\\s*([^#\\r\\n]*)`, 'm');
    const m = re.exec(text);
    if (m) values[key] = m[1].trim();
  }
  const scheduled = /^scheduled_tasks\s*:\s*(.*)$/m.exec(text);
  return {
    ok: true,
    root,
    file,
    values,
    scheduledTasksInline: scheduled ? scheduled[1].trim() : '',
  };
}

/** 最近若干次运行记录（logs/runs/*.json，按修改时间倒序）。 */
export function m7aRecentRuns(rootInput, limit = 5) {
  const root = rootInput || m7aRoot();
  if (!root) return [];
  const dir = path.join(root, 'logs', 'runs');
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.toLowerCase().endsWith('.json'));
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    rows.push({ file, name, mtimeMs: st.mtimeMs });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const out = [];
  for (const row of rows.slice(0, Math.max(1, limit))) {
    let record = null;
    try {
      record = JSON.parse(readFileSync(row.file, 'utf8'));
    } catch {
      record = null;
    }
    out.push({ runId: row.name.replace(/\.json$/i, ''), file: row.file, mtime: new Date(row.mtimeMs).toISOString(), record });
  }
  return out;
}

/** 读单次运行记录；run 省略或 'latest' 时取最近一次。 */
export function m7aRunRecord(rootInput, run = 'latest') {
  const root = rootInput || m7aRoot();
  if (!root) return { ok: false, error: 'M7A_NOT_INSTALLED' };
  const dir = path.join(root, 'logs', 'runs');
  const wanted = String(run || 'latest');
  if (wanted === 'latest') {
    const recent = m7aRecentRuns(root, 1);
    if (!recent.length) return { ok: false, root, error: 'NO_RUNS' };
    return { ok: true, root, runId: recent[0].runId, file: recent[0].file, record: recent[0].record };
  }
  const file = path.join(dir, `${wanted.replace(/\.json$/i, '')}.json`);
  try {
    const record = JSON.parse(readFileSync(file, 'utf8'));
    return { ok: true, root, runId: wanted, file, record };
  } catch (error) {
    return { ok: false, root, error: `读不到运行记录：${String((error && error.message) || error)}`, file };
  }
}

/** 当天日志末尾若干行（logs/<yyyy-MM-dd>.log，UTF-8）。 */
export function m7aTodayLogTail(rootInput, lines = 40) {
  const root = rootInput || m7aRoot();
  if (!root) return { ok: false, error: 'M7A_NOT_INSTALLED' };
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const file = path.join(root, 'logs', `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.log`);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, root, file, error: `读不到当天日志：${String((error && error.message) || error)}` };
  }
  const all = text.split(/\r?\n/);
  const tail = all.slice(Math.max(0, all.length - Math.max(1, lines)));
  return { ok: true, root, file, lines: tail };
}

/** 运行一次任务（同步，适合短任务或 --status 类调用；长任务请在 agent 侧用 --detach）。 */
export function m7aRunSync(taskId, { timeoutMs = 45 * 60 * 1000, afterFinish = 'None', extraArgs = [] } = {}) {
  const info = m7aInstallInfo();
  if (!info.ok) return { ok: false, ...info };
  const args = [String(taskId || DEFAULT_M7A_TASK)];
  if (afterFinish) args.push('--after-finish', afterFinish);
  args.push('--json', ...extraArgs);
  const res = spawnM7a(info.root, args, { timeoutMs });
  const record = extractJson(res.stdout) || extractJson(res.stderr);
  const meaning = exitMeaning(res.code);
  return {
    ok: res.ok,
    root: info.root,
    taskId: args[0],
    exitCode: res.code,
    meaning,
    timedOut: res.timedOut,
    record,
    raw: res.ok ? '' : (res.stdout || res.stderr || '').slice(-1200),
  };
}

/** 控制正在运行的任务：pause / resume / stop。 */
export function m7aControlSync(action, { timeoutMs = 20000 } = {}) {
  const root = m7aRoot();
  if (!root) return { ok: false, error: 'M7A_NOT_INSTALLED' };
  const res = spawnM7a(root, ['--control', 'current', String(action)], { timeoutMs });
  const data = extractJson(res.stdout) || extractJson(res.stderr);
  return { ok: res.ok, root, action, exitCode: res.code, meaning: exitMeaning(res.code), data, raw: (res.stdout || res.stderr || '').slice(0, 800) };
}

/** 给 prompt 用的一段环境事实（找不到安装时也给明确指引）。 */
export function m7aFacts() {
  const info = m7aInstallInfo();
  if (!info.ok) {
    const lines = [
      '- 三月七小助手：**未安装**（没有找到 m7a.exe）',
      `- 影响：本轮无法用 M7A 代理；按 R7 停手并如实报告，不要改用坐标点击硬跑。`,
      `- 修复：${M7A_MISSING_HINT}`,
    ];
    if (info.legacyRoot) lines.push(`- 另发现旧版目录（只有 March7th Assistant.exe）：${info.legacyRoot}，建议让用户更新到带 m7a.exe 的新版。`);
    return { ok: false, lines };
  }
  const status = m7aStatusSync();
  const lines = [`- 三月七小助手：${info.root}${info.install.version ? `（版本 ${info.install.version}）` : ''}`];
  if (status.ok && status.status) {
    const s = status.status;
    lines.push(
      `- 状态：first_run_completed=${s.first_run_completed}；game_path_exists=${s.game_path_exists}；cloud_game_enable=${s.cloud_game_enable}；active_run=${
        s.active_run
          ? `${s.active_run.task || '?'}（${s.active_run.run_id || s.active_run.id || '?'}，pid ${s.active_run.pid || '?'}，始于 ${s.active_run.started_at || '?'}）`
          : '无'
      }`,
    );
    const recent = Array.isArray(s.recent_runs) ? s.recent_runs.slice(0, 3) : [];
    for (const run of recent) {
      lines.push(`  · 最近运行 ${run.run_id || run.id || '?'}：${run.status || '?'}${run.reason ? ` / ${run.reason}` : ''}`);
    }
  } else {
    lines.push(`- 状态：读取失败（${status.error || '未知'}）${status.hint ? `；${status.hint}` : ''}`);
  }
  const task = DEFAULT_M7A_TASK;
  lines.push(
    `- 运行入口：\`${path.join(info.root, 'm7a.exe')} ${task} --after-finish None --json\`（长任务用 --detach 再 --follow latest）`,
    '- 退出码：0 成功 / 1 任务失败 / 2 参数错 / 3 首次未确认（用户本人确认）/ 4 已有任务在跑 / 5 UAC 取消 / 6 被停止',
  );
  return { ok: true, lines, root: info.root, status: status.ok ? status.status : null, task };
}

export default { m7aRoot, m7aInstallInfo, m7aStatusSync, m7aFacts, DEFAULT_M7A_TASK };
