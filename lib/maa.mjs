/**
 * lib/maa.mjs — 识宝小助手（Maa_bbb，MaaFramework）的最小控制层。
 *
 * 用途：
 *   - 依赖体检：找到安装目录、读 interface.json 版本、列出/读取 MFW 配置；
 *   - runner / prompt 里给出环境事实与运行入口（mab.exe --config-id <id> --direct-run）；
 *   - 读 debug/maafw.log 供 agent 值守判断进度。
 *
 * 这里不做任何画面识别与点击：全部交给 Maa_bbb 自己。
 */

import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const STATE_DIR_DEFAULT = path.join(os.homedir(), '.dsh', 'game-daily');
const IS_WIN = process.platform === 'win32';

export function stateDir() {
  return process.env.DSH_GAME_DAILY_STATE_DIR || STATE_DIR_DEFAULT;
}

/** 安装位置书签：装好后把根目录写这里，后续 maaRoot() 优先读它。 */
export function maaPointerPath() {
  return path.join(stateDir(), 'maa-root.txt');
}

const CANDIDATE_ROOTS = () => {
  const list = [];
  for (const key of ['DSH_GAME_DAILY_MAA_ROOT', 'MAA_BBB_ROOT']) {
    const v = process.env[key];
    if (v) list.push(v);
  }
  const pointer = maaPointerPath();
  try {
    if (fs.existsSync(pointer)) {
      const v = fs.readFileSync(pointer, 'utf8').replace(/^\uFEFF/, '').trim();
      if (v) list.push(v);
    }
  } catch { /* ignore */ }
  list.push('E:\\software\\Maa_bbb', 'D:\\software\\Maa_bbb', 'C:\\software\\Maa_bbb');
  list.push(path.join(os.homedir(), 'Maa_bbb'), path.join(os.homedir(), 'Desktop', 'Maa_bbb'));
  return list;
};

export function inspectMaaInstallRoot(root) {
  const info = { root: root || '', hasExe: false, hasInterface: false, version: '', configDir: '', debugDir: '', ok: false };
  if (!root) return info;
  try {
    info.hasExe = fs.existsSync(path.join(root, 'mab.exe'));
    const iface = path.join(root, 'interface.json');
    info.hasInterface = fs.existsSync(iface);
    if (info.hasInterface) {
      try {
        const parsed = JSON.parse(fs.readFileSync(iface, 'utf8').replace(/^\uFEFF/, ''));
        info.version = String(parsed.version || '');
      } catch { /* ignore */ }
    }
    info.configDir = path.join(root, 'config', 'configs');
    info.debugDir = path.join(root, 'debug');
    info.ok = info.hasExe && info.hasInterface;
  } catch { /* ignore */ }
  return info;
}

export function maaRoot() {
  for (const cand of CANDIDATE_ROOTS()) {
    if (!cand) continue;
    const info = inspectMaaInstallRoot(cand);
    if (info.ok) return cand;
  }
  return '';
}

export function maaInstallInfo() {
  const root = maaRoot();
  if (!root) {
    return {
      ok: false,
      root: '',
      version: '',
      configDir: '',
      debugDir: '',
      ok_count: 0,
      error: 'MAA_NOT_INSTALLED',
      hint: MAA_MISSING_HINT,
      searched: CANDIDATE_ROOTS(),
    };
  }
  const info = inspectMaaInstallRoot(root);
  const configs = maaConfigList(root);
  const adb = (() => {
    const r = spawnSync('where', ['adb'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    return r.status === 0 && String(r.stdout || '').trim().length > 0;
  })();
  return {
    ok: true,
    root,
    version: info.version,
    configDir: info.configDir,
    debugDir: info.debugDir,
    configCount: configs.length,
    configs,
    currentConfig: maaCurrentConfigId(root),
    running: maaIsRunning(),
    adbAvailable: adb,
    searches: CANDIDATE_ROOTS(),
  };
}

export const MAA_MISSING_HINT =
  'Maa_bbb 未安装或安装目录不正确。安装前先问用户要装到哪个目录（默认不装 C 盘，解压后约 1.2GB；推荐 E:\\software\\Maa_bbb）：' +
  '下载 https://github.com/miaojiuqing/Maa_bbb/releases 的 Maa_bbb-win-x86_64-<ver>.zip → 解压到目标目录 → ' +
  '确认 mab.exe 与 interface.json 就在该目录下 → 把该目录写进 %USERPROFILE%\\.dsh\\game-daily\\maa-root.txt（或设 DSH_GAME_DAILY_MAA_ROOT）。' +
  '首次运行 mab.exe 会自动生成 config/ 与三个预设配置（日常简化版/完整版/单独运行）。';

export function writeMaaPointer(root) {
  const dir = stateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(maaPointerPath(), String(root || ''), { encoding: 'utf8' });
  return maaPointerPath();
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 列 config/configs/*.json 摘要。 */
export function maaConfigList(rootInput) {
  const root = rootInput || maaRoot();
  if (!root) return [];
  const dir = path.join(root, 'config', 'configs');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.toLowerCase().endsWith('.json')); } catch { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const cfg = readJson(file);
    if (!cfg) continue;
    const tasks = Array.isArray(cfg.tasks) ? cfg.tasks : [];
    const controllerTask = tasks.find((t) => t && t.item_id === 'Controller');
    const enabled = tasks.filter((t) => t && t.is_checked && t.item_id && !/^(PreTask|Controller|Resource)$/.test(t.item_id)).map((t) => t.name);
    out.push({
      id: cfg.item_id || path.basename(name, '.json'),
      name: cfg.name || '',
      file,
      controller: controllerTask && controllerTask.task_option ? String(controllerTask.task_option.controller_type || '') : '',
      checkedCount: enabled.length,
      enabledTasks: enabled,
    });
  }
  return out.sort((a, b) => String(a.name).localeCompare(String(b.name), 'zh'));
}

export function maaReadConfig(rootInput, configId) {
  const root = rootInput || maaRoot();
  if (!root || !configId) return null;
  const file = path.join(root, 'config', 'configs', `${configId}.json`);
  return readJson(file);
}

export function maaCurrentConfigId(rootInput) {
  const root = rootInput || maaRoot();
  if (!root) return '';
  const multi = readJson(path.join(root, 'config', 'multi_config.json'));
  return multi && multi.curr_config_id ? String(multi.curr_config_id) : '';
}

/** 找一个用于「每日日常」的配置：优先名字含「日常」且勾选最多的。 */
export function maaDailyConfig(rootInput) {
  const list = maaConfigList(rootInput);
  const preferred = list.filter((c) => /日常/.test(c.name));
  const pool = preferred.length ? preferred : list;
  if (!pool.length) return null;
  let adb = false;
  try { adb = Boolean(maaInstallInfo(rootInput).adbAvailable); } catch (err) { adb = false; }
  // 有 ADB 才选任务更多的那份（含往世乐土）；没有 ADB 就选最精简的，避免乐土任务把整轮拖挂。
  const sorted = pool.slice().sort((a, b) => (adb ? b.checkedCount - a.checkedCount : a.checkedCount - b.checkedCount));
  const picked = sorted[0];
  let hasLeyline = false;
  try {
    const cfg = maaReadConfig(rootInput, picked.id);
    const tasks = Array.isArray(cfg && cfg.tasks) ? cfg.tasks : [];
    hasLeyline = tasks.some((t) => t && t.is_checked && /往世乐土/.test(String(t.name || '')));
  } catch (err) { hasLeyline = false; }
  return { ...picked, hasLeyline, adbAvailable: adb };
}

export function maaLeylineConfig(rootInput) {
  // 往世乐土只能走安卓端（MuMu + ADB）：优先找名字带「乐土」且控制器是安卓端的配置。
  const list = maaConfigList(rootInput);
  const named = list.filter((c) => /乐土/.test(String(c.name || '')));
  const android = list.filter((c) => /安卓|adb/i.test(String(c.controller || '')));
  const pool = named.length ? named : android;
  if (!pool.length) return null;
  const adb = Boolean(maaInstallInfo(rootInput).adbAvailable);
  const picked = pool[0];
  let hasTask = false;
  try {
    const cfg = maaReadConfig(rootInput, picked.id);
    const tasks = Array.isArray(cfg && cfg.tasks) ? cfg.tasks : [];
    hasTask = tasks.some((t) => t && t.is_checked && /乐土/.test(String(t.name || '')));
  } catch (err) { hasTask = false; }
  return { ...picked, adbAvailable: adb, hasLeylineTask: hasTask };
}

export function maaIsRunning() {
  if (!IS_WIN) return false;
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq mab.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
  const text = String(r.stdout || '');
  return /"mab\.exe"/i.test(text);
}

export function maaStopSync({ timeoutMs = 15000 } = {}) {
  if (!IS_WIN) return { ok: false, error: '仅支持 Windows' };
  const r = spawnSync('taskkill', ['/IM', 'mab.exe', '/F', '/T'], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
  const ok = !/找不到|not found|没有运行/i.test(out) || /成功|SUCCESS/i.test(out);
  return { ok, alreadyStopped: !ok, output: out, running: maaIsRunning() };
}

export function maaLogTail(rootInput, { kind = 'maafw', lines = 40, filter = '' } = {}) {
  const root = rootInput || maaRoot();
  if (!root) return { ok: false, error: 'MAA_NOT_INSTALLED' };
  const file = path.join(root, 'debug', `${kind}.log`);
  try {
    if (!fs.existsSync(file)) return { ok: false, error: '日志不存在', file };
    const raw = fs.readFileSync(file, 'utf8');
    let arr = raw.split(/\r?\n/);
    if (filter) arr = arr.filter((l) => l.includes(filter));
    const tail = arr.slice(-Math.max(1, lines));
    return { ok: true, file, totalLines: arr.length, lines: tail };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err), file };
  }
}

/**
 * 启动一次运行。默认 detached 立即返回；waitSeconds>0 时最多等这么久再返回。
 */
export function maaRunSync(configId, { waitSeconds = 0, reuseExisting = true, forceRestart = false } = {}) {
  const root = maaRoot();
  if (!root) return { ok: false, error: 'MAA_NOT_INSTALLED', hint: MAA_MISSING_HINT };
  const cfg = maaReadConfig(root, configId);
  if (!cfg) return { ok: false, error: '配置不存在', configId, configDir: path.join(root, 'config', 'configs') };
  if (maaIsRunning() && !forceRestart && !reuseExisting) {
    return { ok: false, error: '已有 mab.exe 在运行', running: true };
  }
  const args = ['--config-id', String(configId), '--direct-run'];
  if (reuseExisting) args.push('--reuse-existing');
  if (forceRestart) args.push('--force-restart');
  const startedAt = new Date().toISOString();
  const child = spawn(path.join(root, 'mab.exe'), args, {
    cwd: root,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  const res = { ok: true, pid: child.pid, configId, configName: cfg.name || '', startedAt, args };
  if (waitSeconds > 0) {
    const deadline = Date.now() + Math.min(waitSeconds, 600) * 1000;
    while (Date.now() < deadline) {
      if (!maaIsRunning()) break;
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000); } catch { /* ignore */ }
    }
    res.running = maaIsRunning();
    res.logTail = maaLogTail(root, { lines: 15 });
  }
  return res;
}

/** 给 prompt 用：三五行本机事实。 */
export function maaFacts() {
  try {
    const info = maaInstallInfo();
    if (!info.ok) {
      return { ok: false, lines: ['Maa_bbb 未安装：' + MAA_MISSING_HINT] };
    }
    const daily = maaDailyConfig(info.root);
    const lines = [];
    lines.push(`安装目录：${info.root}（版本 ${info.version || '未知'}）`);
    lines.push(`配置数：${info.configCount}；当前配置：${info.currentConfig || '（无）'}${daily ? `；日常配置建议用：${daily.name}（${daily.id}，勾选 ${daily.checkedCount} 项）` : ''}`);
    lines.push(`运行中：${info.running ? '是（mab.exe 在跑）' : '否'}；ADB 可用：${info.adbAvailable ? '是' : '否（往世乐土需要安卓端 MuMu + ADB）'}`);
    const ley = maaLeylineConfig(info.root);
    lines.push(
      ley
        ? `往世乐土配置：${ley.name}（${ley.id}；安卓端 ${ley.adbAvailable ? '可用' : '不可用（缺 MuMu/ADB）'}；乐土任务${ley.hasLeylineTask ? '已勾选' : '未勾选'}）`
        : '往世乐土配置：无（需要新建一个「安卓端 + 往世乐土」的配置，并先装好 MuMu + ADB）',
    );
    lines.push(`日志：${path.join(info.root, 'debug', 'maafw.log')}`);
    return { ok: true, lines };
  } catch (err) {
    return { ok: false, lines: ['探测失败：' + (err && err.message ? err.message : String(err))] };
  }
}

// ---- 崩坏3 进程：Maa_bbb 的桌面端控制器必须在「运行开始时」就能连上游戏窗口，
//      所以插件在起跑前先把游戏拉起来（2026-11-14 实测：游戏未开 -> 「设备连接失败」）。
export const BH3_EXE_CANDIDATES = [
  process.env.DSH_GAME_DAILY_BH3_EXE,
  'E:\\Honkai Impact 3\\Games\\BH3.exe',
  'D:\\Honkai Impact 3\\Games\\BH3.exe',
  'C:\\Program Files\\Honkai Impact 3\\Games\\BH3.exe',
].filter(Boolean);

export function bh3ExePath() {
  for (const p of BH3_EXE_CANDIDATES) {
    try { if (fs.existsSync(p)) return p; } catch (err) { /* ignore */ }
  }
  return null;
}

export function isElevated() {
  try {
    const r = spawnSync('net', ['session'], { encoding: 'utf8', windowsHide: true, timeout: 8000 });
    return r.status === 0;
  } catch (err) {
    return false;
  }
}

export function isBh3Running() {
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq BH3.exe', '/NH'], {
      encoding: 'utf8', timeout: 15000, windowsHide: true,
    });
    return /BH3\.exe/i.test(out || '');
  } catch (err) {
    return false;
  }
}

function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0)); } catch (err) { /* ignore */ }
}

// 确保崩坏3 在运行；已在跑直接返回，否则启动并等待窗口出现。
export function ensureBh3Running({ waitMs = 60000, pollMs = 1500 } = {}) {
  if (isBh3Running()) return { ok: true, already: true, waitedMs: 0 };
  const exe = bh3ExePath();
  if (!isElevated()) {
    return {
      ok: false,
      already: false,
      exe,
      needsElevation: true,
      error:
        '启动 BH3.exe 需要管理员权限：当前进程不是管理员。请以管理员身份运行 DSH，或把任务交给「计划任务」里的提权通道执行。',
    };
  }
  if (!exe) {
    return {
      ok: false,
      already: false,
      error: '找不到崩坏3 启动程序（BH3.exe）：请设置环境变量 DSH_GAME_DAILY_BH3_EXE 指向 BH3.exe',
    };
  }
  let spawnError = null;
  try {
    const child = spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: false });
    // 非管理员环境里 BH3.exe 会 EACCES；不挂 error 监听会让整个进程崩掉。
    child.on('error', (err) => { spawnError = err; });
    child.unref();
  } catch (err) {
    spawnError = err;
  }
  const started = Date.now();
  while (Date.now() - started < waitMs) {
    sleepSync(pollMs);
    if (isBh3Running()) return { ok: true, already: false, exe, waitedMs: Date.now() - started };
  }
  const waitedMs = Date.now() - started;
  if (spawnError) {
    const code = String((spawnError && spawnError.code) || '');
    const needsElevation = code === 'EACCES' || /EACCES|拒绝访问/i.test(String(spawnError && spawnError.message));
    return {
      ok: false,
      already: false,
      exe,
      waitedMs,
      needsElevation,
      error: needsElevation
        ? '启动 BH3.exe 需要管理员权限（EACCES）：请以管理员身份运行 DSH，或用「依赖体检 / 提权助手」通道启动'
        : '启动 BH3.exe 失败：' + (spawnError && spawnError.message ? spawnError.message : String(spawnError)),
    };
  }
  return { ok: false, already: false, exe, waitedMs, error: `BH3.exe 已启动但 ${Math.round(waitMs / 1000)} 秒内进程未就绪` };
}