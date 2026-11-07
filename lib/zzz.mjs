/**
 * lib/zzz.mjs — 绝区零「一条龙」(ZenlessZoneZero-OneDragon) 后端的最小控制层。
 *
 * 用途：
 *   - 依赖体检：后端是否可达、一条龙是否装在预期位置；
 *   - runner 起跑前确保后端在跑（必要时弹一次 UAC 启动）；
 *   - prompt 里给出的环境事实。
 *
 * 不在这里做任何游戏画面操作：画面识别/点击全部交给一条龙自己。
 */

import { execFile, execFileSync } from 'node:child_process';
import fs, { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');

export const DEFAULT_ZZZ_ROOT = 'D:\\software\\ZenlessZoneZero-OneDragon';
const ZZZ_REPO_URL = 'https://github.com/OneDragon-Anything/ZenlessZoneZero-OneDragon.git';
const ZZZ_REPO_ZIP = 'https://codeload.github.com/OneDragon-Anything/ZenlessZoneZero-OneDragon/zip/refs/heads/main';
const ZZZ_STATE_DIR_DEFAULT = path.join(os.homedir(), '.dsh', 'game-daily');
const ZZZ_GAME_CANDIDATES = [
  'E:\\miHoYo Launcher\\games\\ZenlessZoneZero Game\\ZenlessZoneZero.exe',
  'D:\\miHoYo Launcher\\games\\ZenlessZoneZero Game\\ZenlessZoneZero.exe',
  'C:\\Program Files\\miHoYo Launcher\\games\\ZenlessZoneZero Game\\ZenlessZoneZero.exe',
  'D:\\ZenlessZoneZero Game\\ZenlessZoneZero.exe',
  'E:\\ZenlessZoneZero Game\\ZenlessZoneZero.exe',
];

function zzzStateDir() {
  return process.env.DSH_GAME_DAILY_STATE_DIR || ZZZ_STATE_DIR_DEFAULT;
}

/** 安装位置的“书签”：安装器把实际根目录写在这里，后续 zzzRoot() 优先读它。 */
export function zzzRootPointerPath() {
  return path.join(zzzStateDir(), 'zzz-root.txt');
}

/** 某个具体目录下的一条龙是否完整（不等同于 zzzRoot()，后者会做候选发现）。 */
export function inspectZzzInstallRoot(root) {
  const python = path.join(root, '.venv', 'Scripts', 'python.exe');
  const src = path.join(root, 'src', 'zzz_od');
  const pyproject = path.join(root, 'pyproject.toml');
  const hasPython = existsSync(python);
  const hasSrc = existsSync(src);
  const hasPyproject = existsSync(pyproject);
  return { root, python, hasPython, hasSrc, hasPyproject, ok: hasPython && hasSrc };
}

export function zzzRoot() {
  const fromEnv = process.env.DSH_GAME_DAILY_ZZZ_ROOT || process.env.ZZZ_OD_ROOT;
  if (fromEnv && inspectZzzInstallRoot(fromEnv).ok) return fromEnv;
  try {
    const pointer = fs.readFileSync(zzzRootPointerPath(), 'utf8').trim();
    if (pointer && inspectZzzInstallRoot(pointer).ok) return pointer;
  } catch { /* 没有书签就继续探测 */ }
  const candidates = [
    DEFAULT_ZZZ_ROOT,
    'E:\\software\\ZenlessZoneZero-OneDragon',
    'D:\\ZenlessZoneZero-OneDragon',
    path.resolve(PLUGIN_ROOT, '..', 'ZenlessZoneZero-OneDragon'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, '.venv', 'Scripts', 'python.exe'))) return dir;
  }
  return DEFAULT_ZZZ_ROOT;
}

export function zzzBaseUrl() {
  return (process.env.DSH_GAME_DAILY_ZZZ_URL || 'http://127.0.0.1:23001').replace(/\/+$/, '');
}

export function zzzServerScript() {
  return path.join(PLUGIN_ROOT, 'automation', 'zzz-server.ps1');
}

function psPath() {
  return path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

async function httpJson(urlPath, { method = 'GET', body, timeoutMs = 8000 } = {}) {
  const init = { method, headers: {} };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(`${zzzBaseUrl()}${urlPath}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text.slice(0, 500) };
  }
  return { ok: res.ok, status: res.status, data };
}

export async function zzzHealth(timeoutMs = 3000) {
  try {
    const r = await httpJson('/health', { timeoutMs });
    return { ok: r.ok, data: r.data };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** 同步版 health（给同步的依赖体检用；curl.exe 本机自带，超时 2 秒）。 */
export function zzzHealthSync({ timeoutMs = 2000 } = {}) {
  const url = `${zzzBaseUrl()}/health`;
  try {
    const out = execFileSync('curl.exe', ['-s', '-S', '-m', String(Math.max(1, Math.round(timeoutMs / 1000))), url], {
      timeout: timeoutMs + 1500,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 512 * 1024,
    }).trim();
    let data = null;
    try {
      data = out ? JSON.parse(out) : null;
    } catch {
      data = { raw: out.slice(0, 300) };
    }
    return { ok: true, data };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error).slice(0, 300) };
  }
}

export async function zzzStatus() {
  try {
    const r = await httpJson('/game/status', { timeoutMs: 5000 });
    return r.data;
  } catch (error) {
    return { running: null, error: String((error && error.message) || error) };
  }
}

export async function zzzWindow() {
  try {
    const r = await httpJson('/game/window', { timeoutMs: 5000 });
    return r.data;
  } catch (error) {
    return { is_win_valid: false, error: String((error && error.message) || error) };
  }
}

/** 运行 zzz-server.ps1（start/stop/status）。start/stop 在非管理员下会让脚本自己弹一次 UAC。 */
export function runZzzServerScript(action, { timeoutSeconds = 45, stopFile = '' } = {}) {
  return new Promise((resolve) => {
    const script = zzzServerScript();
    if (!existsSync(script)) {
      resolve({ ok: false, error: `找不到后端管理脚本：${script}` });
      return;
    }
    const args = [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      '-Action',
      action,
      '-Root',
      zzzRoot(),
      '-Port',
      String(Number(new URL(zzzBaseUrl()).port) || 23001),
      '-WaitSeconds',
      String(Math.max(5, Math.min(120, timeoutSeconds))),
    ];
    if (stopFile) args.push('-StopFile', stopFile);
    execFile(psPath(), args, { timeout: (timeoutSeconds + 60) * 1000, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      const text = String(stdout || '').trim();
      let data = null;
      const i = text.lastIndexOf('{');
      if (i >= 0) {
        try {
          data = JSON.parse(text.slice(i));
        } catch {
          data = null;
        }
      }
      if (data) return resolve(data);
      resolve({ ok: false, error: String((error && error.message) || stderr || 'no result').slice(0, 500) });
    });
  });
}

/** 确保后端在跑：已健康直接返回；否则启动（可能弹一次 UAC）。
 *  stopFile 交给后端脚本：启动成功时它会顺带跑一个提权的 watch 助手，
 *  之后非提权的插件只要写这个文件就能关掉后端（不需要再弹 UAC）。 */
export async function ensureZzzServer({ timeoutSeconds = 45, stopFile = '' } = {}) {
  const before = await zzzHealth(2000);
  if (before.ok) return { ok: true, alreadyRunning: true, health: before.data, stopFile };
  const result = await runZzzServerScript('start', { timeoutSeconds, stopFile });
  const after = await zzzHealth(3000);
  return { ok: Boolean(after.ok), started: true, script: result, health: after.data, stopFile, error: after.ok ? undefined : result.error };
}

/** 关闭游戏：交给提权后的后端自己发关闭信号（普通权限杀不掉提权进程）。 */
export async function zzzCloseGame({ timeoutMs = 15000 } = {}) {
  try {
    const r = await httpJson('/game/close', { method: 'POST', body: {}, timeoutMs });
    return { ok: r.ok, data: r.data };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** 停止后端：优先写 stop 文件让提权的 watch 助手处理；没有再退回提权脚本（会弹 UAC）。 */
export async function stopZzzServer({ timeoutSeconds = 30, stateDir = '' } = {}) {
  const stopFile = stateDir ? path.join(stateDir, 'automation', 'zzz-server.stop') : '';
  if (stopFile) {
    try {
      fs.mkdirSync(path.dirname(stopFile), { recursive: true });
      fs.writeFileSync(stopFile, new Date().toISOString(), 'utf8');
    } catch { /* ignore */ }
    const limit = Date.now() + Math.max(5, timeoutSeconds) * 1000;
    while (Date.now() < limit) {
      const h = await zzzHealth(1500);
      if (!h.ok) return { ok: true, via: 'stop-file', stopFile };
      await new Promise((r) => setTimeout(r, 1000));
    }
    // 没有 watcher（例如后端是手动启的）时不要擅自弹 UAC，交给调用方决定。
    return { ok: false, via: 'stop-file', stopFile, reachable: true, error: '后端仍在运行：它可能不是由插件启动的（没有 watch 助手）。' };
  }
  const result = await runZzzServerScript('stop', { timeoutSeconds });
  const after = await zzzHealth(2000);
  return { ok: !after.ok, script: result, reachable: after.ok };
}

/** 依赖体检用：一条龙安装是否完整（根目录 + venv python + 后端源码）。 */
export function inspectZzzInstall() {
  const root = zzzRoot();
  const python = path.join(root, '.venv', 'Scripts', 'python.exe');
  const src = path.join(root, 'src', 'zzz_od');
  const hasPython = existsSync(python);
  const hasSrc = existsSync(src);
  return { root, python, hasPython, hasSrc, ok: hasPython && hasSrc };
}

// ---------------------------------------------------------------------------
// 自动安装：clone（或下 zip）+ uv sync + 基础配置
// 默认目标在 D 盘，**不会**装进系统盘（C:）。
// ---------------------------------------------------------------------------

function isSystemDrive(target) {
  const root = path.parse(path.resolve(target)).root.replace(/\\+$/, '').toLowerCase();
  const systemDrive = String(process.env.SystemDrive || 'C:').replace(/\\+$/, '').toLowerCase();
  return root === systemDrive;
}

/** 安装目标候选（按优先级），去掉重复项；系统盘一律不作为安装目标。 */
export function zzzInstallTargets() {
  const envRoot = process.env.DSH_GAME_DAILY_ZZZ_ROOT || process.env.ZZZ_OD_ROOT || '';
  const list = [];
  if (envRoot) list.push(path.resolve(envRoot));
  list.push(
    DEFAULT_ZZZ_ROOT,
    'E:\\software\\ZenlessZoneZero-OneDragon',
    'D:\\ZenlessZoneZero-OneDragon',
    path.resolve(PLUGIN_ROOT, '..', 'ZenlessZoneZero-OneDragon'),
  );
  const seen = new Set();
  return list.filter((dir) => {
    if (isSystemDrive(dir)) return false;
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 选安装位置：已有完整安装就直接用它；否则取第一个“所在盘存在”的候选目录。 */
export function pickZzzInstallTarget() {
  const targets = zzzInstallTargets();
  for (const dir of targets) {
    if (inspectZzzInstallRoot(dir).ok) return { root: dir, existing: true, targets };
  }
  for (const dir of targets) {
    const drive = path.parse(dir).root;
    if (existsSync(drive)) return { root: dir, existing: false, targets };
  }
  return { root: targets[0] || DEFAULT_ZZZ_ROOT, existing: false, targets };
}

function findExecutable(name, extraDirs = []) {
  const exts = ['.exe', '.cmd', '.bat', ''];
  const dirs = [
    ...extraDirs,
    ...String(process.env.PATH || '').split(path.delimiter).filter(Boolean),
  ];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      if (existsSync(file)) return file;
    }
  }
  return '';
}

function runTool(file, args, { cwd, timeoutMs = 600000, env } = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        env: env ? { ...process.env, ...env } : process.env,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error && typeof error.code === 'number' ? error.code : error ? 1 : 0,
          stdout: String(stdout || ''),
          stderr: String(stderr || ''),
          error: error ? String(error.message || error).slice(0, 800) : '',
        });
      },
    );
  });
}

/** 写一条龙的 01 配置（只补缺失文件，不覆盖用户已有配置）。 */
export function ensureZzzConfigs(root) {
  const dir = path.join(root, 'config', '01');
  const steps = [];
  fs.mkdirSync(dir, { recursive: true });

  const gameYml = path.join(dir, 'game.yml');
  if (!existsSync(gameYml)) {
    fs.writeFileSync(
      gameYml,
      [
        'screen_size: 1920x1080',
        "full_screen: '0'",
        'launch_argument: false',
        "launch_argument_advance: ''",
        'popup_window: false',
        "monitor: '1'",
        'type_input_way: clipboard',
        'hdr: false',
        'original_hdr_value: AutoHDREnable=2096;',
        '',
      ].join('\n'),
      'utf8',
    );
    steps.push({ name: 'config/game.yml', ok: true, detail: '已写入默认 1920x1080 窗口化配置' });
  } else {
    steps.push({ name: 'config/game.yml', ok: true, detail: '已存在，未改动' });
  }

  const accountYml = path.join(dir, 'game_account.yml');
  if (!existsSync(accountYml)) {
    const gamePath = detectZzzGamePath(accountYml);
    fs.writeFileSync(
      accountYml,
      [
        'platform: PC',
        'game_region: cn',
        'game_language: cn',
        `game_path: ${gamePath || ''}`,
        'use_custom_win_title: false',
        "custom_win_title: ''",
        "account: ''",
        "password: ''",
        '',
      ].join('\n'),
      'utf8',
    );
    steps.push({
      name: 'config/game_account.yml',
      ok: Boolean(gamePath),
      detail: gamePath ? `已写入游戏路径：${gamePath}` : '未找到绝区零可执行文件；需要在 config/01/game_account.yml 手动填 game_path（面板的体检会继续报错）',
    });
  } else {
    steps.push({ name: 'config/game_account.yml', ok: true, detail: '已存在，未改动' });
  }
  return { dir, steps };
}

/** 找绝区零 exe：环境变量 → 已有配置 → 常见安装位置。 */
export function detectZzzGamePath(accountYml = '') {
  const fromEnv = process.env.DSH_GAME_DAILY_ZZZ_GAME || process.env.ZZZ_OD_GAME_PATH || '';
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  if (accountYml && existsSync(accountYml)) {
    try {
      const match = /^\s*game_path\s*:\s*(.+)$/m.exec(fs.readFileSync(accountYml, 'utf8'));
      if (match) {
        const value = match[1].trim().replace(/^['"]|['"]$/g, '');
        if (value && existsSync(value)) return value;
      }
    } catch { /* 读不到就继续找 */ }
  }
  for (const file of ZZZ_GAME_CANDIDATES) {
    if (existsSync(file)) return file;
  }
  return '';
}

function moveDir(from, to) {
  try {
    fs.renameSync(from, to);
    return true;
  } catch {
    try {
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * 一键安装绝区零一条龙：clone（失败则下 zip）→ uv sync → 写基础配置。
 * 目标目录默认 D 盘（可用 DSH_GAME_DAILY_ZZZ_ROOT 覆盖，系统盘会被忽略）；
 * 传入 root 时强制用该目录（仍拒绝系统盘，便于测试或自定义位置）。
 */
export async function installZzzOneDragon({ timeoutMs = 1800000, root: explicitRoot = '' } = {}) {
  const steps = [];
  const push = (name, ok, detail) => {
    steps.push({ name, ok, detail: String(detail || '').slice(0, 600) });
    return ok;
  };

  const target = explicitRoot && !isSystemDrive(explicitRoot)
    ? { root: path.resolve(explicitRoot), existing: inspectZzzInstallRoot(explicitRoot).ok }
    : pickZzzInstallTarget();
  const root = target.root;
  if (inspectZzzInstallRoot(root).ok) {
    push('检查', true, `一条龙已安装，跳过下载：${root}`);
    return { ok: true, root, alreadyInstalled: true, steps };
  }

  // 半成品目录先挪走，避免 clone 到非空目录失败。
  if (existsSync(root) && !inspectZzzInstallRoot(root).ok) {
    const backup = `${root}.partial-${Date.now()}`;
    if (moveDir(root, backup)) push('清理', true, `已有不完整目录，已移到 ${backup}`);
  }
  const parent = path.dirname(root);
  if (parent && path.resolve(parent) !== path.resolve(path.parse(root).root)) {
    fs.mkdirSync(parent, { recursive: true });
  }

  const git = findExecutable('git', ['E:\\software\\Git\\cmd', 'C:\\Program Files\\Git\\cmd']);
  let cloned = false;
  if (git) {
    const clone = await runTool(git, ['-c', 'core.longpaths=true', 'clone', '--depth', '1', '--single-branch', ZZZ_REPO_URL, root], { timeoutMs });
    cloned = clone.ok && existsSync(path.join(root, 'pyproject.toml'));
    push('git clone', cloned, cloned ? `已克隆到 ${root}` : (clone.stderr || clone.error || '克隆失败'));
  } else {
    push('git clone', false, '本机没有找到 git，改用 zip 下载');
  }

  if (!cloned) {
    const stamp = Date.now();
    const zip = path.join(os.tmpdir(), `zzz-od-${stamp}.zip`);
    const unpack = path.join(os.tmpdir(), `zzz-od-${stamp}-unpack`);
    try {
      const response = await fetch(ZZZ_REPO_ZIP, { redirect: 'follow', signal: AbortSignal.timeout(Math.min(timeoutMs, 900000)) });
      if (!response.ok) throw new Error(`zip 下载失败：HTTP ${response.status}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(zip, buffer);
      const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const expand = await runTool(
        ps,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${unpack.replace(/'/g, "''")}' -Force`],
        { timeoutMs },
      );
      if (!expand.ok) throw new Error(expand.stderr || expand.error || '解压失败');
      const inner = fs.readdirSync(unpack).map((name) => path.join(unpack, name)).find((dir) => existsSync(path.join(dir, 'pyproject.toml')));
      if (!inner) throw new Error('解压后没找到 pyproject.toml');
      if (!moveDir(inner, root)) throw new Error(`无法移动到 ${root}`);
      cloned = existsSync(path.join(root, 'pyproject.toml'));
      push('zip 下载', cloned, cloned ? `已解压到 ${root}` : '解压/移动失败');
    } catch (error) {
      push('zip 下载', false, String((error && error.message) || error));
    } finally {
      try { fs.rmSync(zip, { force: true }); } catch { /* ignore */ }
      try { fs.rmSync(unpack, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  if (!cloned) {
    return { ok: false, root, steps, error: '一条龙源码没能下载下来（git 与 zip 都失败），请检查网络或代理后重试。' };
  }

  const uv = findExecutable('uv', [path.join(os.homedir(), '.local', 'bin'), path.join(process.env.APPDATA || '', 'Python', 'Scripts')]);
  if (!uv) {
    push('uv sync', false, '本机没有 uv。请先安装 uv（如 winget install astral-sh.uv）后重试；一条龙依赖 uv 管理 Python 环境。');
    return { ok: false, root, steps, error: '缺少 uv，无法创建 .venv。' };
  }
  const sync = await runTool(uv, ['sync'], {
    cwd: root,
    timeoutMs,
    env: { UV_HTTP_TIMEOUT: process.env.UV_HTTP_TIMEOUT || '300', UV_LINK_MODE: process.env.UV_LINK_MODE || 'copy' },
  });
  const synced = inspectZzzInstallRoot(root).ok;
  push('uv sync', synced, synced ? '依赖安装完成，.venv 已就绪' : (sync.stderr || sync.stdout || sync.error || 'uv sync 失败').slice(-600));
  if (!synced) {
    return { ok: false, root, steps, error: 'uv sync 没有产出可用的 .venv，请查看上面的输出。' };
  }

  const config = ensureZzzConfigs(root);
  for (const step of config.steps) steps.push(step);
  const gamePathFound = detectZzzGamePath(path.join(config.dir, 'game_account.yml'));
  if (!gamePathFound) steps.push({ name: '游戏路径', ok: false, detail: '没找到绝区零安装位置，请在 config/01/game_account.yml 里填 game_path。' });

  try {
    fs.mkdirSync(path.dirname(zzzRootPointerPath()), { recursive: true });
    fs.writeFileSync(zzzRootPointerPath(), root, 'utf8');
    push('记录安装位置', true, zzzRootPointerPath());
  } catch (error) {
    push('记录安装位置', false, String((error && error.message) || error));
  }

  return { ok: true, root, steps };
}


// ---------------------------------------------------------------------------
// 清体力兜底：特训目标已达成时改刷驱动盘（区域巡防）
//
// 一条龙的 charge_plan.yml 里，「代理人方案培养」计划只要结算页出现「特训目标已达成」，
// 就会被标记 skipped 并顺位执行列表里后面的计划。所以：把代理人计划的 plan_times 调大
// （材料没满时把电量刷完），再在它后面追加一条「区域巡防 = 驱动盘本」计划 —— 一旦材料够了，
// 剩余电量自然落在驱动盘本上。OD 每轮开跑前会重读配置（backend_context._refresh_runtime_config），
// 因此在 startRun 之前改写文件即可生效。
// ---------------------------------------------------------------------------

/** 区域巡防（驱动盘本）的 15 个副本类型 → 对应掉落的两套驱动盘。 */
export const ZZZ_DISC_MISSION_TYPES = [
  { missionTypeName: '怪兽与怪客', discs: ['摇摆爵士', '混沌重金属'] },
  { missionTypeName: '恶拳与凶枪', discs: ['激素朋克', '獠牙重金属'] },
  { missionTypeName: '猎人与忠犬', discs: ['震星迪斯科', '雷暴重金属'] },
  { missionTypeName: '高塔与巨炮', discs: ['啄木鸟电音', '灵魂摇滚'] },
  { missionTypeName: '疯子与追随者', discs: ['河豚电音', '炎狱重金属'] },
  { missionTypeName: '锐牙与钝斧', discs: ['自由蓝调', '极地重金属'] },
  { missionTypeName: '猎手与凶兽', discs: ['混沌爵士', '原始朋克'] },
  { missionTypeName: '怪兽二重奏', discs: ['折枝剑歌', '静听嘉音'] },
  { missionTypeName: '游侠与守卫', discs: ['如影相随', '法厄同之歌'] },
  { missionTypeName: '口舌与刀兵', discs: ['云岿如我', '山大王'] },
  { missionTypeName: '铁律与狂徒', discs: ['拂晓生花', '月光骑士颂'] },
  { missionTypeName: '诡步与重壁', discs: ['沧浪行歌', '流光咏叹'] },
  { missionTypeName: '伏龙与战车', discs: ['雪兔梦游仙境', '囚徒手记'] },
  { missionTypeName: '机师与叛甲', discs: ['呼啸沙龙', '拂晓行纪'] },
  { missionTypeName: '迅脊与裂爪', discs: ['谶羽之誓', '荆棘玫瑰'] },
];

/** 兜底配置的默认值（可被 <stateDir>/zzz-fallback.json 覆盖）。 */
export function defaultZzzFallbackConfig() {
  return {
    enabled: true,
    instanceIdx: 1,
    // 要改刷的驱动盘本（区域巡防副本类型，见 ZZZ_DISC_MISSION_TYPES）
    missionTypeName: '怪兽与怪客',
    tabName: '训练',
    level: '默认等级',
    autoBattleConfig: '全配队通用',
    cardNum: '默认数量',
    // 代理人计划的 plan_times 与每次「×N 卡」：默认 3 次 × 5 卡 = 300 电量（可由 zzz-fallback.json 覆盖）
    agentPlanTimes: 3,
    agentCardNum: '5',
    // 驱动盘计划的 plan_times：4 × 60 电量 = 240
    discPlanTimes: 4,
    // -1 = 跟随代理人计划的编队
    teamIdx: -1,
  };
}

export function zzzFallbackPath() {
  return path.join(zzzStateDir(), 'zzz-fallback.json');
}

/** 读用户覆盖配置（不存在就用默认值）。 */
export function zzzFallbackConfig() {
  const base = defaultZzzFallbackConfig();
  try {
    const raw = fs.readFileSync(zzzFallbackPath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return { ...base, ...parsed };
  } catch { /* 没配置或坏配置都退回默认值 */ }
  return base;
}

/** 定位某实例的 charge_plan.yml。 */
export function findZzzChargePlanPath(root = zzzRoot(), instanceIdx = 1) {
  const idx = String(Number(instanceIdx) || 1).padStart(2, '0');
  return path.join(root, 'config', idx, 'one_dragon', 'charge_plan.yml');
}

/** 生成改写 charge_plan.yml 的 Python 脚本（用 OD 自带 venv 跑，保证 YAML 格式与它自己一致）。 */
export function buildZzzChargePlanScript() {
  return `
import json, os, shutil, sys, time, uuid
import yaml

root = os.environ['ZZZ_OD_ROOT']
spec = json.loads(os.environ['ZZZ_OD_FALLBACK'])
idx = int(spec.get('instanceIdx') or 1)
path = os.path.join(root, 'config', '%02d' % idx, 'one_dragon', 'charge_plan.yml')
dry_run = str(os.environ.get('ZZZ_OD_DRY_RUN') or '') == '1'
result = {'ok': False, 'path': path, 'dryRun': dry_run, 'changed': [], 'plans': []}

if not os.path.isfile(path):
    result['error'] = 'charge_plan.yml 不存在'
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(2)

with open(path, 'r', encoding='utf-8') as f:
    data = yaml.safe_load(f) or {}
plans = data.get('plan_list') or []
agent_plans = [p for p in plans if p.get('mission_type_name') == '代理人方案培养']
if not agent_plans:
    result['error'] = '没找到「代理人方案培养」计划，已放弃改写'
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(3)

target_times = int(spec.get('agentPlanTimes') or 0)
want_card = spec.get('agentCardNum')
for plan in agent_plans:
    try:
        cur = int(plan.get('plan_times') or 0)
    except Exception:
        cur = 0
    if target_times > 0 and target_times != cur:
        prev = plan.get('plan_times')
        plan['plan_times'] = target_times
        result['changed'].append('agent.plan_times %s->%d' % (prev, target_times))
    if want_card and str(plan.get('card_num')) != str(want_card):
        prev_card = plan.get('card_num')
        plan['card_num'] = str(want_card)
        result['changed'].append('agent.card_num %s->%s' % (prev_card, want_card))

anchor = agent_plans[-1]
want = spec.get('missionTypeName')
disc_plans = [p for p in plans if p.get('category_name') == '区域巡防' and p.get('mission_type_name') == want]
if disc_plans:
    item = disc_plans[0]
    if plans.index(item) < plans.index(anchor):
        plans.remove(item)
        plans.insert(plans.index(anchor) + 1, item)
        result['changed'].append('disc.reorder')
else:
    team_idx = anchor.get('predefined_team_idx')
    if int(spec.get('teamIdx') or -1) >= 0:
        team_idx = int(spec['teamIdx'])
    item = {
        'tab_name': spec.get('tabName') or '训练',
        'category_name': '区域巡防',
        'mission_type_name': want,
        'mission_name': want,
        'level': spec.get('level') or '默认等级',
        'auto_battle_config': spec.get('autoBattleConfig') or '全配队通用',
        'run_times': 0,
        'plan_times': int(spec.get('discPlanTimes') or 4),
        'card_num': spec.get('cardNum') or '默认数量',
        'predefined_team_idx': int(team_idx if team_idx is not None else -1),
        'notorious_hunt_buff_num': int(anchor.get('notorious_hunt_buff_num') or 1),
        'plan_id': str(uuid.uuid4()),
    }
    plans.insert(plans.index(anchor) + 1, item)
    result['changed'].append('disc.append %s' % want)

want_disc_times = int(spec.get('discPlanTimes') or 0)
if int(item.get('plan_times') or 0) != want_disc_times and want_disc_times > 0:
    item['plan_times'] = want_disc_times
    result['changed'].append('disc.plan_times->%d' % want_disc_times)

data['plan_list'] = plans
if result['changed'] and not dry_run:
    backup = path + '.bak-gd-disc-' + time.strftime('%Y%m%d-%H%M%S')
    shutil.copyfile(path, backup)
    result['backup'] = backup
    with open(path, 'w', encoding='utf-8', newline='\\n') as f:
        yaml.dump(data, f, allow_unicode=True, sort_keys=False)

result['ok'] = True
result['plans'] = [
    {
        'category': p.get('category_name'),
        'missionType': p.get('mission_type_name'),
        'runTimes': p.get('run_times'),
        'planTimes': p.get('plan_times'),
    }
    for p in plans
]
print(json.dumps(result, ensure_ascii=False))
`;
}

/**
 * 确保 charge_plan.yml 已配置「代理人计划 + 驱动盘兜底计划」。
 * 幂等：已经是目标形态时 changed 为空、不写文件。
 */
export function ensureZzzChargePlanFallback({ root = zzzRoot(), dryRun = false, config = null } = {}) {
  const cfg = { ...defaultZzzFallbackConfig(), ...(config || {}) };
  if (!cfg.enabled) return { ok: true, skipped: true, reason: '配置里 enabled=false' };
  const install = inspectZzzInstallRoot(root);
  if (!install.ok) return { ok: false, root, error: '一条龙安装不完整（缺 .venv 或 src/zzz_od）' };

  const known = ZZZ_DISC_MISSION_TYPES.some((it) => it.missionTypeName === cfg.missionTypeName);
  if (!known) return { ok: false, root, error: `未知的驱动盘副本类型：${cfg.missionTypeName}` };

  const scriptPath = path.join(zzzStateDir(), 'automation', 'zzz-charge-plan-ensure.py');
  try {
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, buildZzzChargePlanScript(), 'utf8');
  } catch (error) {
    return { ok: false, root, error: `写脚本失败：${String((error && error.message) || error)}` };
  }

  const env = {
    ...process.env,
    PYTHONPATH: path.join(root, 'src'),
    ZZZ_OD_ROOT: root,
    ZZZ_OD_FALLBACK: JSON.stringify(cfg),
    ZZZ_OD_DRY_RUN: dryRun ? '1' : '0',
    PYTHONIOENCODING: 'utf-8',
  };
  let stdout = '';
  try {
    stdout = execFileSync(install.python, [scriptPath], {
      cwd: root,
      env,
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    });
  } catch (error) {
    const out = String((error && (error.stdout || error.message)) || error);
    return { ok: false, root, error: out.slice(-800) };
  }

  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : '';
  let parsed;
  try {
    parsed = JSON.parse(last);
  } catch {
    return { ok: false, root, error: `无法解析脚本输出：${stdout.slice(-400)}` };
  }
  return { ...parsed, root, python: install.python, config: cfg };
}