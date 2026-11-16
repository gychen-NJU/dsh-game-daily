// 安装路径解析：把「这个软件/游戏装在哪」收敛成一套约定，别每个模块各写死一个盘符。
//
// 背景（issue #7）：BetterGI / 一条龙 / Maa_bbb / 崩坏3、原神 都可能被装在任意盘符任意目录
// （D:\\Games、E:\\software、%LOCALAPPDATA%\\Programs ...）。以前每个模块各写死一个默认路径
// 加一份候选表，结果「装在非默认目录」= 体检报缺失 + MCP 工具全挂。
//
// 解析顺序（先命中先用）：
//   1. 环境变量（多个别名按顺序取第一个真实的）
//   2. <stateDir>/<kind>-root.txt 书签（安装器 / 面板把实际目录写进去）
//   3. 常见目录探测（候选由各 kind 提供，用探针确认「这目录真的是这个软件」）
//   4. 出厂默认值（保持老用户行为不变）
//
// 探针很重要：候选目录里可能有同名空目录，只有探到标志文件才算命中。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 探测用盘符：只做 existsSync，代价很小；够覆盖绝大多数装机习惯。 */
const PROBE_DRIVES = ['C:', 'D:', 'E:', 'F:', 'G:', 'H:'];

const DEFAULT_STATE_DIR = path.join(os.homedir(), '.dsh', 'game-daily');

export function stateDir() {
  return process.env.DSH_GAME_DAILY_STATE_DIR || DEFAULT_STATE_DIR;
}

/** 书签路径：安装器把实际根目录写这里，后续解析优先读它。 */
export function pointerPath(kind) {
  return path.join(stateDir(), `${kind}-root.txt`);
}

export function readPointer(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim();
    return raw || '';
  } catch {
    return '';
  }
}

/** 把解析到的根记成书签（面板「记录下来」/ 安装器收尾用）。 */
export function writePointer(kind, value) {
  const root = normalizeRoot(value);
  if (!root) return { ok: false, error: '路径为空，未写入书签' };
  const file = pointerPath(kind);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${root}\n`, 'utf8');
    return { ok: true, path: file, root };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error), path: file };
  }
}

function safeExists(file) {
  try {
    return !!file && fs.existsSync(file);
  } catch {
    return false;
  }
}

function safeReadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/**
 * 用户填的可能是 exe、可能带引号、可能带尾斜杠 —— 一律归一成目录。
 * exe 路径取它的父目录；这是「填 BetterGI.exe 也能用」的关键。
 */
export function normalizeRoot(value) {
  let v = String(value == null ? '' : value).trim();
  if (!v) return '';
  v = v.replace(/^["']+/, '').replace(/["']+$/, '').trim();
  v = v.replace(/[\\/]+$/, '');
  if (/\.exe$/i.test(v)) v = path.win32.dirname(v);
  return v;
}

/** 去重（Windows 路径大小写不敏感、尾斜杠等价），保留首次出现顺序。 */
export function dedupe(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const value = String(raw == null ? '' : raw).trim();
    if (!value) continue;
    const key = value.toLowerCase().replace(/[\\/]+$/, '');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// ─────────────────────────── BetterGI ───────────────────────────

export const BETTERGI_ROOT_ENV = ['DSH_GAME_DAILY_BETTERGI_ROOT', 'DSH_GAME_DAILY_BETTERGI', 'BETTERGI_ROOT'];
export const BETTERGI_ROOT_DEFAULT = 'D:\\software\\BetterGI';

/** 只看一个目录「是不是 BetterGI 的安装根」，不做任何搜索。 */
export function inspectBettergiRoot(root) {
  const info = { root: '', exe: '', userDir: '', version: '', ok: false };
  const dir = normalizeRoot(root);
  if (!dir) return info;
  info.root = dir;
  info.exe = path.join(dir, 'BetterGI.exe');
  info.userDir = path.join(dir, 'User');
  info.ok = safeExists(info.exe);
  if (info.ok) info.version = readBettergiVersion(dir);
  return info;
}

function readBettergiVersion(root) {
  const cfg = safeReadJson(path.join(root, 'User', 'config.json'));
  if (!cfg) return '';
  const candidates = [cfg.appVersion, cfg.version, cfg.Config && cfg.Config.appVersion];
  for (const value of candidates) {
    if (value) return String(value);
  }
  return '';
}

/** 探测候选目录（不含环境变量/书签，那些由 bettergiInfo 按优先级处理）。 */
export function bettergiProbeDirs() {
  const list = [];
  for (const drive of PROBE_DRIVES) {
    for (const mid of ['software', 'Games', 'Program Files', 'Tools']) list.push(`${drive}\\${mid}\\BetterGI`);
    list.push(`${drive}\\BetterGI`);
  }
  list.push(
    path.join(os.homedir(), 'BetterGI'),
    path.join(os.homedir(), 'Games', 'BetterGI'),
    path.join(os.homedir(), 'Desktop', 'BetterGI'),
  );
  if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'BetterGI'));
  list.push(BETTERGI_ROOT_DEFAULT);
  return dedupe(list.map(normalizeRoot));
}

/**
 * 解析 BetterGI 安装根：返回 { ok, root, exe, userDir, version, source, candidates }。
 * source ∈ env | pointer | probe | none，用于告诉用户「这个结果是怎么来的」。
 */
export function bettergiInfo() {
  const stages = [
    { source: 'env', values: BETTERGI_ROOT_ENV.map((name) => process.env[name]) },
    { source: 'pointer', values: [readPointer(pointerPath('bettergi'))] },
    { source: 'probe', values: bettergiProbeDirs() },
  ];
  const tried = [];
  for (const stage of stages) {
    for (const value of stage.values) {
      const dir = normalizeRoot(value);
      if (!dir || tried.some((item) => item.toLowerCase() === dir.toLowerCase())) continue;
      tried.push(dir);
      const info = inspectBettergiRoot(dir);
      if (info.ok) return { ...info, source: stage.source, candidates: tried };
    }
  }
  return { root: '', exe: '', userDir: '', version: '', ok: false, source: 'none', candidates: tried };
}

/** 兼容老调用方：拿不到就还给出厂默认值（调用方会拼 User\\... 路径，空串更糟）。 */
export function bettergiRoot() {
  const info = bettergiInfo();
  return info.ok ? info.root : BETTERGI_ROOT_DEFAULT;
}

/** 给报错文案用的「怎么改」提示。 */
export function bettergiFixHint() {
  return [
    '设环境变量 DSH_GAME_DAILY_BETTERGI_ROOT=<安装根>（或 BETTERGI_ROOT），指向 BetterGI.exe 所在目录，',
    `或把根目录写进 ${pointerPath('bettergi')}（一行纯文本）。`,
  ].join('');
}

// ─────────────────────────── 游戏 exe ───────────────────────────

const GAME_EXE_ENV = {
  genshin: ['DSH_GAME_DAILY_GENSHIN_EXE', 'GENSHIN_EXE', 'YUANSHEN_EXE'],
  hi: ['DSH_GAME_DAILY_BH3_EXE', 'BH3_EXE'],
  sr: ['DSH_GAME_DAILY_SR_EXE', 'STARRAIL_EXE'],
  zzz: ['DSH_GAME_DAILY_ZZZ_GAME', 'ZZZ_OD_GAME_PATH', 'DSH_GAME_DAILY_ZZZ_EXE'],
};

const GAME_EXE_LAYOUTS = {
  genshin: (drive) => [
    `${drive}\\miHoYo Launcher\\games\\Genshin Impact\\Genshin Impact Game\\YuanShen.exe`,
    `${drive}\\Games\\miHoYo Launcher\\games\\Genshin Impact\\Genshin Impact Game\\YuanShen.exe`,
    `${drive}\\Genshin Impact\\Genshin Impact Game\\YuanShen.exe`,
    `${drive}\\Program Files\\miHoYo Launcher\\games\\Genshin Impact\\Genshin Impact Game\\YuanShen.exe`,
  ],
  hi: (drive) => [
    `${drive}\\Honkai Impact 3\\Games\\BH3.exe`,
    `${drive}\\Games\\Honkai Impact 3\\Games\\BH3.exe`,
    `${drive}\\miHoYo Launcher\\games\\Honkai Impact 3\\Games\\BH3.exe`,
    `${drive}\\Games\\miHoYo Launcher\\games\\Honkai Impact 3\\Games\\BH3.exe`,
  ],
  sr: (drive) => [
    `${drive}\\miHoYo Launcher\\games\\Star Rail\\Game\\StarRail.exe`,
    `${drive}\\Games\\miHoYo Launcher\\games\\Star Rail\\Game\\StarRail.exe`,
    `${drive}\\Star Rail\\Game\\StarRail.exe`,
  ],
  zzz: (drive) => [
    `${drive}\\miHoYo Launcher\\games\\ZenlessZoneZero Game\\ZenlessZoneZero.exe`,
    `${drive}\\Games\\miHoYo Launcher\\games\\ZenlessZoneZero Game\\ZenlessZoneZero.exe`,
    `${drive}\\ZenlessZoneZero Game\\ZenlessZoneZero.exe`,
  ],
};

/**
 * 游戏 exe 候选：env 别名 → 书签 <id>-exe-root.txt → 调用方自带的 extra（各模块历史候选）→ 常见布局。
 * extra 放中间，是为了不改变老用户已经命中的那一条。
 */
export function gameExeCandidates(id, { extra = [] } = {}) {
  const list = [];
  for (const name of GAME_EXE_ENV[id] || []) {
    const value = process.env[name];
    if (value) list.push(value);
  }
  list.push(readPointer(pointerPath(`${id}-exe`)));
  list.push(...(extra || []));
  const layout = GAME_EXE_LAYOUTS[id];
  if (layout) for (const drive of PROBE_DRIVES) list.push(...layout(drive));
  return dedupe(list);
}

/** 第一个真实存在的候选；找不到返回 ''。 */
export function gameExe(id, options) {
  for (const candidate of gameExeCandidates(id, options)) {
    if (safeExists(candidate)) return candidate;
  }
  return '';
}
