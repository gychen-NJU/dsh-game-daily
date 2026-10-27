// 依赖体检：每项都必须带证据字段；没有证据一律 unknown，不谎报 ok。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GAMES, gameById } from './games.mjs';
import { taskStatus } from './tasks.mjs';
import { resolveBettergiMcp } from './bettergi-mcp.mjs';
import { inspectZzzInstall, zzzHealth, zzzHealthSync, zzzRoot, zzzBaseUrl } from './zzz.mjs';

export const MIN_DSH = '0.2.1-rc.2';

export function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function currentProfile() {
  return process.env.DSH_PROFILE || 'desktop';
}

export function profileDir(profile = currentProfile()) {
  return path.join(dshHome(), 'profiles', profile);
}

export function skillsRoot() {
  return process.env.DSH_SKILLS_ROOT || path.join(os.homedir(), '.agents', 'skills');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

function exists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

function pidAlive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    // 目标进程是管理员权限、我们不是时，Windows 会报 EPERM —— 那说明进程在，只是碰不得。
    if (error && error.code === 'EPERM') return true;
    return false;
  }
}

function cmpVersion(a, b) {
  const pa = String(a || '').split(/[.-]/).map((x) => parseInt(x, 10));
  const pb = String(b || '').split(/[.-]/).map((x) => parseInt(x, 10));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = Number.isFinite(pa[i]) ? pa[i] : 0;
    const y = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** 定位 dsh CLI：优先全局 npm 安装的 bin.js（桌面端 spawn 时用 node + bin.js 最稳）。 */
export function resolveDsh() {
  const explicit = process.env.DSH_GAME_DAILY_DSH_BIN;
  const candidates = [
    explicit,
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    '/usr/local/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    '/usr/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  ].filter(Boolean);
  for (const file of candidates) {
    if (exists(file)) return { kind: 'node', command: process.execPath, args: [file], bin: file };
  }
  const cmd = path.join(process.env.APPDATA || '', 'npm', 'dsh.cmd');
  if (exists(cmd)) return { kind: 'cmd', command: cmd, args: [], bin: cmd };
  return null;
}

function dshVersion(dsh) {
  if (!dsh) return '';
  const candidates = [];
  if (dsh.kind === 'node') {
    candidates.push(path.join(path.dirname(dsh.bin), '..', 'package.json'));
  }
  for (const file of candidates) {
    const pkg = readJson(path.resolve(file));
    if (pkg && typeof pkg.version === 'string') return pkg.version;
  }
  return '';
}

function checkHeadlessProfile() {
  const dir = profileDir('headless');
  const pkg = readJson(path.join(dir, 'package.json'));
  const patchText = readText(path.join(dir, 'cordis.patch.yml'));
  if (!exists(dir)) {
    return { status: 'missing', detail: `未找到 headless profile：${dir}`, blocker: true, fix: { kind: 'install', label: '让 DSH 创建 / 修复 headless profile' } };
  }
  const hasBundle = Boolean(pkg && Array.isArray(pkg.dsh?.profile?.bundles) && pkg.dsh.profile.bundles.includes('@deepseek-ai/dsh-headless'));
  const credentialsLine = /-\s*id:\s*credentials[\s\S]{0,80}?disabled:\s*false/.test(patchText);
  if (hasBundle && credentialsLine) {
    return { status: 'ok', detail: `headless profile 就绪 · credentials 已启用` };
  }
  const missing = [];
  if (!hasBundle) missing.push('dsh-headless bundle');
  if (!credentialsLine) missing.push('credentials 补丁行');
  return {
    status: 'missing',
    blocker: true,
    detail: `headless profile 缺：${missing.join('、')}（缺则每次运行都 MISSING_CREDENTIAL）`,
    fix: { kind: 'auto', label: '自动补上 credentials 补丁行', action: 'fix-headless-credentials' },
  };
}

function checkBettergi() {
  const exe = process.env.DSH_GAME_DAILY_BETTERGI || 'C:\\software\\BetterGI\\BetterGI.exe';
  if (!exists(exe)) {
    return {
      status: 'missing',
      blocker: true,
      detail: `未找到 BetterGI：${exe}`,
      fix: { kind: 'install', label: '让 DSH 安装 BetterGI' },
    };
  }
  const version = readJson(path.join(path.dirname(exe), 'User', 'config.json'))?.version || '';
  return { status: 'ok', detail: `BetterGI ${version || '已安装'}\n${exe}`, path: exe, version };
}

function checkBettergiMcpScript(stateDir) {
  const found = resolveBettergiMcp({ stateDir });
  if (found) {
    const bundled = /tools[\\/]bettergi-mcp[\\/]/.test(found) ? '（插件自带）' : '';
    return { status: 'ok', detail: `bettergi-mcp 已就位${bundled}\n${found}`, path: found };
  }
  return {
    status: 'warn',
    blocker: false,
    detail: '插件自带的 bettergi-mcp.mjs 缺失（安装似乎不完整），且本机也没有其它副本。点修复会从 GitHub 补下单文件服务器（约 100KB）。',
    fix: { kind: 'auto', label: '补下 bettergi-mcp（从 GitHub）', action: 'install-bettergi-mcp' },
  };
}

function checkBettergiSkill() {
  const dir = path.join(skillsRoot(), 'bettergi-control');
  const skill = path.join(dir, 'SKILL.md');
  if (!exists(skill)) {
    return {
      status: 'missing',
      blocker: true,
      detail: `缺少 bettergi-control 技能（${dir}）。原神日常靠它执行；插件自带这份技能，点修复直接本地安装（不联网）。`,
      fix: { kind: 'auto', label: '安装 bettergi-control（插件自带）', action: 'install-bettergi-skill' },
    };
  }
  let scripts = 0;
  try {
    scripts = fs.readdirSync(path.join(dir, 'scripts')).filter((file) => /\.ps1$/i.test(file)).length;
  } catch {
    scripts = 0;
  }
  return {
    status: scripts >= 10 ? 'ok' : 'warn',
    blocker: false,
    detail: `bettergi-control 就绪（${scripts} 个脚本）\n${dir}`,
    path: dir,
  };
}

function checkBettergiMcpRegistered() {
  const patchText = readText(path.join(profileDir(), 'cordis.patch.yml'));
  const has = /serverName:\s*['"]?bettergi['"]?/.test(patchText) || /bettergi-mcp/.test(patchText);
  if (has) return { status: 'ok', detail: `当前 profile（${currentProfile()}）已注册 bettergi MCP` };
  return {
    status: 'warn',
    blocker: false,
    detail: '当前 profile 没有 bettergi MCP 行；原神引擎跑 headless 时靠 overlay 注入，交互会话里则调不到 bgi_* 工具。点修复会自动写入补丁（备份后追加），重启 DSH 生效。',
    fix: { kind: 'auto', label: '注册 bettergi MCP（写入后重启 DSH）', action: 'fix-bettergi-mcp' },
  };
}

function checkComputerUse() {
  const pkg = readJson(path.join(profileDir(), 'package.json'));
  const deps = pkg && pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  const found = Object.keys(deps).find((name) => name === 'dsh-computer-use-win');
  if (found) return { status: 'ok', detail: `已安装 ${found}@${deps[found]}` };
  return {
    status: 'warn',
    detail: '未安装 dsh-computer-use-win；崩坏3 / 星铁在坐标点击失效时需要它接管。',
    fix: { kind: 'install', label: '让 DSH 安装 dsh-computer-use-win' },
  };
}

function checkSkills(gameIds) {
  const root = skillsRoot();
  const dirs = new Set(['game-daily']);
  for (const id of gameIds) {
    const game = gameById(id);
    if (game && game.engine === 'skill') dirs.add(game.skillModule);
  }
  const missing = [];
  for (const dir of dirs) {
    if (!exists(path.join(root, dir, 'SKILL.md'))) missing.push(dir);
  }
  if (!missing.length) return { status: 'ok', detail: `技能就绪：${[...dirs].join('、')}\n${root}` };
  return {
    status: 'missing',
    blocker: true,
    detail: `缺少技能：${missing.join('、')}（应在 ${root}）`,
    fix: { kind: 'install', label: '让 DSH 安装 / 恢复 game-daily 技能' },
  };
}

function checkCalibration(gameIds) {
  const root = skillsRoot();
  const issues = [];
  for (const id of gameIds) {
    const game = gameById(id);
    if (!game || game.engine !== 'skill') continue;
    const local = path.join(root, game.skillModule, 'state', 'coords.local.json');
    if (!exists(local)) issues.push({ id, reason: '本机坐标未校准（state/coords.local.json 不存在）' });
  }
  if (!issues.length) return { status: 'ok', detail: '本机坐标已校准' };
  return {
    status: 'warn',
    detail: issues.map((item) => `${gameById(item.id).title}：${item.reason}`).join('\n'),
    fix: { kind: 'install', label: '让 DSH 运行坐标校准' },
  };
}

function checkElevationHelper(gameIds) {
  const needHelper = gameIds.some((id) => {
    const game = gameById(id);
    return game && game.engine === 'skill';
  });
  if (!needHelper) return { status: 'ok', detail: '当前所选游戏不需要提权助手' };
  const root = skillsRoot();
  const pids = [];
  // 助手是共享的：任何一个技能模块的 pid 文件活着就算在跑。
  for (const game of GAMES) {
    if (!game.skillModule) continue;
    const file = path.join(root, game.skillModule, 'state', 'helper.pid');
    const text = readText(file).trim();
    if (text) pids.push({ file, pid: Number(text), module: game.skillModule });
  }
  const alive = pids.filter((item) => pidAlive(item.pid));
  if (alive.length) {
    return {
      status: 'ok',
      detail: `提权助手在运行（pid ${alive.map((x) => x.pid).join(', ')}，来源 ${alive.map((x) => x.module).join(', ')}）`,
    };
  }
  return {
    status: 'missing',
    blocker: true,
    detail: pids.length ? '提权助手 pid 文件存在但进程已退出' : '提权助手未启动（崩坏3 / 星铁需要它发送输入）',
    fix: { kind: 'auto', label: '启动提权助手（会弹一次 UAC）', action: 'start-elevation-helper' },
  };
}

/** 绝区零：一条龙安装是否完整（根目录 + venv python + 后端源码）。 */
function checkZzzOneDragon() {
  const info = inspectZzzInstall();
  if (info.ok) {
    return { status: 'ok', detail: `一条龙已安装\n${info.root}\npython: ${info.python}` };
  }
  return {
    status: 'missing',
    blocker: true,
    detail: `没有找到完整的 ZenlessZoneZero-OneDragon 安装（根目录 ${info.root}；venv ${info.hasPython ? '有' : '缺'}；源码 ${info.hasSrc ? '有' : '缺'}）`,
    fix: {
      kind: 'auto',
      label: '自动安装一条龙（默认装到 D 盘，不会装进 C 盘）',
      action: 'install-zzz-od',
    },
  };
}

/** 绝区零：一条龙后端是否在跑（不上游戏，只查 health）。 */
function checkZzzServer() {
  const health = zzzHealthSync();
  if (health.ok) {
    return { status: 'ok', detail: `一条龙后端在跑\n${zzzBaseUrl()}` };
  }
  return {
    status: 'warn',
    detail: `一条龙后端没在跑（${zzzBaseUrl()} 不可达）。真实运行前需要启动它；游戏是管理员权限，启动会弹一次 UAC。`,
    fix: { kind: 'auto', label: '启动一条龙后端（会弹一次 UAC）', action: 'start-zzz-server' },
  };
}

/** 汇总体检：返回逐项结果 + 计数。 */
export function probeDependencies(gameIds = GAMES.map((g) => g.id), { stateDir } = {}) {
  const dsh = resolveDsh();
  const version = dshVersion(dsh);
  const checks = [];

  checks.push({
    id: 'dsh',
    label: 'dsh CLI',
    status: dsh ? 'ok' : 'missing',
    blocker: !dsh,
    detail: dsh ? `dsh ${version || '(版本未知)'}\n${dsh.bin}` : '找不到 dsh（全局 npm 安装的 lib/bin.js 或 dsh.cmd）',
    fix: dsh ? null : { kind: 'install', label: '让 DSH 安装 dsh CLI' },
  });

  if (dsh && version) {
    const ok = cmpVersion(version, MIN_DSH) >= 0;
    checks.push({
      id: 'dsh-version',
      label: 'DSH 版本',
      status: ok ? 'ok' : 'warn',
      blocker: false,
      detail: `dsh ${version}（要求 ≥ ${MIN_DSH}）`,
      fix: ok ? null : { kind: 'install', label: '让 DSH 核对 / 升级版本' },
    });
  }

  checks.push({ id: 'headless', label: 'headless 运行器', ...checkHeadlessProfile() });
  checks.push({ id: 'computer-use', label: 'computer-use 插件', ...checkComputerUse() });
  checks.push({ id: 'skills', label: 'game-daily 技能', ...checkSkills(gameIds) });
  checks.push({ id: 'calibration', label: '坐标校准', ...checkCalibration(gameIds) });
  checks.push({ id: 'helper', label: '提权助手', ...checkElevationHelper(gameIds) });

  const wantsGenshin = gameIds.includes('genshin');
  if (wantsGenshin) {
    checks.push({ id: 'bettergi', label: 'BetterGI', ...checkBettergi() });
    checks.push({ id: 'bettergi-skill', label: 'bettergi-control 技能', ...checkBettergiSkill() });
    checks.push({ id: 'bettergi-mcp', label: 'bettergi-mcp 脚本', ...checkBettergiMcpScript(stateDir) });
    checks.push({ id: 'bettergi-mcp-registered', label: 'bettergi MCP 注册', ...checkBettergiMcpRegistered() });
  }

  const wantsZzz = gameIds.includes('zzz');
  if (wantsZzz) {
    checks.push({ id: 'zzz-od', label: '绝区零一条龙', ...checkZzzOneDragon() });
    checks.push({ id: 'zzz-server', label: '一条龙后端', ...checkZzzServer() });
  }

  const summary = {
    total: checks.length,
    ok: checks.filter((c) => c.status === 'ok').length,
    blockers: checks.filter((c) => c.blocker).length,
  };
  return { checks, summary };
}

export function checkGameTask(taskName) {
  if (!taskName) return { exists: false };
  return taskStatus(taskName);
}
