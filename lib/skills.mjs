// 技能安装：优先用插件自带的副本（tools/<技能名>），缺失时再从独立仓库拉 zip。
//
// 自带副本让「装好插件 = 自带技能」，不联网也能一键修复；
// 远程仓库只作为更新/兜底通道（见 SKILL_REPOS）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PS = path.join(
  process.env.SystemRoot || 'C:\\Windows',
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);

/** 插件根目录（兼容 link 安装：真实文件所在目录）。 */
function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** 插件随包携带的技能目录：<插件>/tools/<技能名>。 */
export function bundledSkillPath(name) {
  return path.join(pluginRoot(), 'tools', name);
}

/** 崩三 / 星铁技能族所在仓库（一个仓库三套技能，用 subdir 定位各自模块）。 */
const GAME_DAILY_ZIP = 'https://codeload.github.com/gychen-NJU/game-daily/zip/refs/heads/main';

/** 可自动安装的技能：自带副本优先，远程 zip 走 codeload。 */
export const SKILL_REPOS = {
  'bettergi-control': {
    repo: 'gychen-NJU/bettergi-control',
    branch: 'main',
    zip: 'https://codeload.github.com/gychen-NJU/bettergi-control/zip/refs/heads/main',
    required: ['SKILL.md', 'scripts'],
    minScripts: 10,
  },
  // 三套技能同一个 zip：装的时候只下载一次（见 installSkillGroup）。
  'game-daily': {
    repo: 'gychen-NJU/game-daily',
    branch: 'main',
    zip: GAME_DAILY_ZIP,
    subdir: 'game-daily',
    required: ['SKILL.md', 'scripts', 'engine'],
    minScripts: 8,
  },
  'game-daily-hi': {
    repo: 'gychen-NJU/game-daily',
    branch: 'main',
    zip: GAME_DAILY_ZIP,
    subdir: 'game-daily-hi',
    // 崩三模块的点击模板在 references/templates/，没有它就只能 fail-closed 停手。
    required: ['SKILL.md', 'references', 'manifest.yaml'],
    minFiles: 40,
  },
  'game-daily-sr': {
    repo: 'gychen-NJU/game-daily',
    branch: 'main',
    zip: GAME_DAILY_ZIP,
    subdir: 'game-daily-sr',
    required: ['SKILL.md', 'references', 'manifest.yaml'],
    minFiles: 15,
  },
};

export function skillSpec(name) {
  return SKILL_REPOS[name] || null;
}

export function skillInstallPath(root, name) {
  return path.join(root || '', name);
}

export function inspectSkill(root, name) {
  const dir = skillInstallPath(root, name);
  const skillMd = path.join(dir, 'SKILL.md');
  const installed = fs.existsSync(skillMd);
  let scripts = 0;
  try {
    scripts = fs.readdirSync(path.join(dir, 'scripts')).filter((file) => /\.(ps1|mjs)$/i.test(file)).length;
  } catch {
    scripts = 0;
  }
  return { dir, installed, skillMd, scripts };
}

function countFiles(dir) {
  let total = 0;
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(path.join(current, entry.name));
      else total += 1;
    }
  };
  walk(dir);
  return total;
}

function dirBytes(dir) {
  let total = 0;
  const walk = (current) => {
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* ignore */
        }
      }
    }
  };
  walk(dir);
  return total;
}

function countScripts(dir) {
  try {
    return fs.readdirSync(path.join(dir, 'scripts')).filter((file) => /\.(ps1|mjs)$/i.test(file)).length;
  } catch {
    return 0;
  }
}

/** 校验一个候选技能目录是否完整。 */
function validateDir(sourceDir, spec) {
  if (!fs.existsSync(sourceDir)) return { ok: false, error: `安装包里没有该技能目录：${sourceDir}` };
  for (const required of spec.required || []) {
    if (!fs.existsSync(path.join(sourceDir, required))) {
      return { ok: false, error: `安装包缺少 ${required}` };
    }
  }
  const scripts = countScripts(sourceDir);
  if (spec.minScripts && scripts < spec.minScripts) {
    return { ok: false, error: `脚本数量不足：${scripts} < ${spec.minScripts}` };
  }
  if (spec.minFiles) {
    const files = countFiles(sourceDir);
    if (files < spec.minFiles) return { ok: false, error: `文件数量不足：${files} < ${spec.minFiles}` };
  }
  return { ok: true, scripts };
}

function moveDir(from, to) {
  try {
    fs.renameSync(from, to);
  } catch {
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** 备份旧目录并换上新的。失败不动旧版本。 */
function swapIn(sourceDir, target, stamp) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  let backup = '';
  if (fs.existsSync(target)) {
    backup = `${target}.bak-${stamp}`;
    fs.renameSync(target, backup);
  }
  moveDir(sourceDir, target);
  if (!fs.existsSync(path.join(target, 'SKILL.md'))) {
    return { ok: false, error: '安装后回读 SKILL.md 失败', backup };
  }
  return { ok: true, backup };
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 一次解压出来的仓库树，可以在同一个进程里被多套技能复用（崩三族共用一个 zip）。 */
const treeCache = new Map();

/** 下载并解压一个仓库 zip，返回 { ok, root, workDir, bytes }；失败返回 { ok:false, error }。 */
async function fetchTree(spec, tag, timeoutMs) {
  const cached = treeCache.get(spec.zip);
  if (cached && Date.now() - cached.at < 10 * 60 * 1000 && cached.root && fs.existsSync(cached.root)) {
    return { ...cached, cached: true };
  }
  const zipFile = path.join(os.tmpdir(), `gd-${tag}.zip`);
  const workDir = path.join(os.tmpdir(), `gd-${tag}`);
  try {
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    let response;
    try {
      response = await fetch(spec.zip, {
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.max(10000, Number(timeoutMs) || 90000)),
        headers: { 'user-agent': 'dsh-game-daily' },
      });
    } catch (error) {
      return { ok: false, error: `下载失败：${String((error && error.message) || error)}` };
    }
    if (!response.ok) return { ok: false, error: `下载失败：HTTP ${response.status} ${spec.zip}` };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 5000) return { ok: false, error: `下载内容过小：${buffer.length} 字节` };
    fs.writeFileSync(zipFile, buffer);

    const script = `$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath ${psQuote(zipFile)} -DestinationPath ${psQuote(workDir)} -Force; Write-Output 'ok'`;
    try {
      execFileSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        encoding: 'utf8',
        timeout: 120000,
        windowsHide: true,
      });
    } catch (error) {
      return { ok: false, error: `解压失败：${String((error && error.message) || error)}` };
    }

    const dirs = fs.readdirSync(workDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const root = dirs.length === 1 ? path.join(workDir, dirs[0].name) : workDir;
    const tree = { ok: true, root, workDir, bytes: buffer.length, at: Date.now() };
    treeCache.set(spec.zip, tree);
    return tree;
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  } finally {
    try {
      fs.rmSync(zipFile, { force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 从解压好的仓库树里把某个技能装到 target。 */
function installFromTree(treeRoot, spec, target, stamp, bytes) {
  let sourceDir = '';
  if (spec.subdir) {
    sourceDir = path.join(treeRoot, spec.subdir);
  } else if (fs.existsSync(path.join(treeRoot, 'SKILL.md'))) {
    sourceDir = treeRoot;
  } else {
    const dirs = fs.readdirSync(treeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    const inner = dirs.find((entry) => fs.existsSync(path.join(treeRoot, entry.name, 'SKILL.md')));
    if (inner) sourceDir = path.join(treeRoot, inner.name);
  }
  if (!sourceDir || !fs.existsSync(path.join(sourceDir, 'SKILL.md'))) {
    return { ok: false, error: `压缩包里没有 ${spec.subdir || 'SKILL.md'}` };
  }
  const checked = validateDir(sourceDir, spec);
  if (!checked.ok) return { ok: false, error: checked.error };

  const stage = path.join(os.tmpdir(), `gd-stage-${stamp}-${Math.random().toString(36).slice(2, 8)}`);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.cpSync(sourceDir, stage, { recursive: true });
  const swapped = swapIn(stage, target, stamp);
  if (!swapped.ok) return { ok: false, error: swapped.error, backup: swapped.backup };
  return {
    ok: true,
    path: target,
    backup: swapped.backup,
    scripts: checked.scripts,
    files: countFiles(target),
    bytes: bytes || 0,
    repo: spec.repo,
    source: 'remote',
  };
}

async function installFromRemote(name, spec, { target, stamp, timeoutMs }) {
  const tree = await fetchTree(spec, `${name}-${stamp}`, timeoutMs);
  if (!tree.ok) return tree;
  try {
    return installFromTree(tree.root, spec, target, stamp, tree.bytes);
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

/** 释放缓存下来的解压目录（批量安装结束后调用）。 */
export function clearTreeCache() {
  for (const tree of treeCache.values()) {
    try {
      fs.rmSync(tree.workDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  treeCache.clear();
}

/**
 * 一次安装同一仓库的多套技能（崩三族：game-daily / game-daily-hi / game-daily-sr）。
 * 共用一个 zip 时只下载一次；各自失败不影响其它模块。
 */
export async function installSkillGroup(names, { root, timeoutMs = 90000, source = 'auto' } = {}) {
  if (!root) return { ok: false, error: '缺少技能根目录（skillsRoot）', results: [] };
  const pending = [];
  const results = [];
  for (const name of names) {
    const spec = skillSpec(name);
    if (!spec) return { ok: false, error: `未知技能：${name}`, results };
    if (source !== 'remote') {
      const bundled = bundledSkillPath(name);
      if (fs.existsSync(path.join(bundled, 'SKILL.md'))) {
        results.push({ name, ...(await installSkill(name, { root, timeoutMs, source: 'bundled' })) });
        continue;
      }
      if (source === 'bundled') {
        results.push({ name, ok: false, error: '插件里没有自带该技能' });
        continue;
      }
    }
    pending.push({ name, spec });
  }
  try {
    for (const item of pending) {
      const target = skillInstallPath(root, item.name);
      const stamp = Date.now();
      results.push({ name: item.name, ...(await installFromRemote(item.name, item.spec, { target, stamp, timeoutMs })) });
    }
  } finally {
    clearTreeCache();
  }
  const ok = results.length > 0 && results.every((item) => item.ok === true);
  return { ok, results };
}

/**
 * 跑技能自带的覆盖率自检（`game-daily/scripts/coverage.mjs <模块目录>`），
 * 返回每个模块一句话结论，用于安装后立刻告诉用户模板/锚点/变体齐不齐。
 */
export function runCoverage(skillsRoot, modules = ['game-daily-hi', 'game-daily-sr']) {
  const script = path.join(skillsRoot, 'game-daily', 'scripts', 'coverage.mjs');
  if (!fs.existsSync(script)) return [];
  const out = [];
  for (const mod of modules) {
    const dir = path.join(skillsRoot, mod);
    if (!fs.existsSync(dir)) continue;
    try {
      const text = execFileSync(process.execPath, [script, dir], { encoding: 'utf8', timeout: 30000, windowsHide: true });
      const lines = String(text).trim().split(/\r?\n/);
      out.push(`${mod} 覆盖率：${lines[lines.length - 1] || '通过'}`);
    } catch (error) {
      const stdout = String((error && error.stdout) || '');
      const last = stdout.trim().split(/\r?\n/).pop();
      out.push(`${mod} 覆盖率自检未通过：${last || String((error && error.message) || error).split('\n')[0]}`);
    }
  }
  return out;
}

/**
 * 安装一个技能。
 * source: 'auto'（默认，自带副本优先）| 'bundled'（只用自带）| 'remote'（只用远程）。
 * 自带安装 = 纯本地目录拷贝，不联网；远程安装 = 下载 zip、解压、校验。
 * 失败不会破坏旧版本（旧目录只在最后一步才改名备份）。
 */
export async function installSkill(name, { root, timeoutMs = 90000, source = 'auto' } = {}) {
  const spec = skillSpec(name);
  if (!spec) return { ok: false, error: `未知技能：${name}` };
  if (!root) return { ok: false, error: '缺少技能根目录（skillsRoot）' };

  const target = skillInstallPath(root, name);
  const stamp = Date.now();

  if (source !== 'remote') {
    const bundled = bundledSkillPath(name);
    if (fs.existsSync(path.join(bundled, 'SKILL.md'))) {
      const checked = validateDir(bundled, spec);
      if (!checked.ok) return { ok: false, error: `自带副本不完整：${checked.error}` };
      try {
        fs.mkdirSync(root, { recursive: true });
        const stage = path.join(os.tmpdir(), `gd-${name}-${stamp}-bundle`);
        fs.rmSync(stage, { recursive: true, force: true });
        fs.cpSync(bundled, stage, { recursive: true });
        const swapped = swapIn(stage, target, stamp);
        if (!swapped.ok) return { ok: false, error: swapped.error, backup: swapped.backup };
        return {
          ok: true,
          path: target,
          backup: swapped.backup,
          scripts: checked.scripts,
          files: countFiles(target),
          bytes: dirBytes(bundled),
          repo: spec.repo,
          source: 'bundled',
        };
      } catch (error) {
        return { ok: false, error: `安装自带副本失败：${String((error && error.message) || error)}` };
      }
    }
    if (source === 'bundled') return { ok: false, error: '插件里没有自带该技能' };
  }

  return installFromRemote(name, spec, { target, stamp, timeoutMs });
}
