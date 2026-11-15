// 更新检测与在线升级：读远端 package.json 的 version，和本地对比；升级走 git pull，
// 没有 git 安装时退化为下载 zip 覆盖（保留用户配置，不需要重新安装）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = 'gychen-NJU/dsh-game-daily';
const BRANCH = 'main';
const RAW_PKG = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/package.json`;
const ZIP_URL = `https://codeload.github.com/${REPO}/zip/refs/heads/${BRANCH}`;
const CACHE_MS = 30 * 60 * 1000;

const cache = { at: 0, value: null };

export function pluginRoot() {
  return process.env.DSH_GAME_DAILY_ROOT || MODULE_ROOT;
}

export function readPackage(file) {
  const target = file || path.join(pluginRoot(), 'package.json');
  const text = fs.readFileSync(target, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

export function readLocalVersion() {
  try {
    return String(readPackage().version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

// semver 的简化比较：只支持 x.y.z(-pre)。返回 -1 / 0 / 1。
export function compareVersions(a, b) {
  const split = (value) => String(value || '0.0.0')
    .replace(/^\s*v/i, '')
    .split('+')[0]
    .split('-');
  const [coreA, preA] = split(a);
  const [coreB, preB] = split(b);
  const partsA = coreA.split('.').map((x) => Number.parseInt(x, 10) || 0);
  const partsB = coreB.split('.').map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const x = partsA[i] || 0;
    const y = partsB[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  // 有 prerelease 的版本比正式版小
  if (preA && !preB) return -1;
  if (!preA && preB) return 1;
  if (preA && preB) {
    const aParts = preA.split('.');
    const bParts = preB.split('.');
    const len = Math.max(aParts.length, bParts.length);
    for (let i = 0; i < len; i += 1) {
      const x = aParts[i];
      const y = bParts[i];
      if (x === undefined) return -1;
      if (y === undefined) return 1;
      const nx = /^\d+$/.test(x) ? Number(x) : x;
      const ny = /^\d+$/.test(y) ? Number(y) : y;
      if (typeof nx === 'number' && typeof ny === 'string') return -1;
      if (typeof nx === 'string' && typeof ny === 'number') return 1;
      if (nx !== ny) return nx > ny ? 1 : -1;
    }
  }
  return 0;
}

function fakeRemote() {
  const raw = String(process.env.DSH_GAME_DAILY_FAKE_REMOTE || '').trim();
  return raw || '';
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: 'application/json', 'user-agent': 'dsh-game-daily' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export async function checkForUpdate({ force = false, timeoutMs = 8000 } = {}) {
  const now = Date.now();
  if (!force && cache.value && now - cache.at < CACHE_MS) {
    return { ...cache.value, cached: true };
  }
  const current = readLocalVersion();
  const checkedAt = new Date().toISOString();
  try {
    const fake = fakeRemote();
    let latest = fake;
    let source = fake ? 'fake' : 'raw';
    if (!latest) {
      const pkg = await fetchJson(`${RAW_PKG}?t=${now}`, timeoutMs);
      latest = String(pkg.version || '').trim();
    }
    if (!latest) throw new Error('远端 package.json 没有 version 字段');
    const value = {
      ok: true,
      current,
      latest,
      hasUpdate: compareVersions(latest, current) > 0,
      source,
      repo: REPO,
      url: `https://github.com/${REPO}`,
      releases: `https://github.com/${REPO}/releases`,
      checkedAt,
    };
    cache.at = now;
    cache.value = value;
    return value;
  } catch (error) {
    const value = {
      ok: false,
      current,
      latest: '',
      hasUpdate: false,
      repo: REPO,
      url: `https://github.com/${REPO}`,
      checkedAt,
      error: String((error && error.message) || error),
    };
    return value;
  }
}

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { windowsHide: true, timeout: 120000, maxBuffer: 8 * 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error && typeof error.code === 'number' ? error.code : 0,
        stdout: String(stdout || '').trim(),
        stderr: String(stderr || '').trim(),
        error: error ? String(error.message || error) : '',
      });
    });
  });
}

function gitAvailable(root) {
  return fs.existsSync(path.join(root, '.git'));
}

async function applyViaGit(root) {
  const before = readLocalVersion();
  const result = await run('git', ['-C', root, 'pull', '--ff-only']);
  const after = readLocalVersion();
  return {
    ok: result.ok,
    method: 'git',
    from: before,
    to: after,
    output: [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 2000),
    error: result.ok ? '' : result.error,
    restartRequired: before !== after,
  };
}

async function applyViaZip(root) {
  const before = readLocalVersion();
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-update-'));
  const zipPath = path.join(tempDir, 'plugin.zip');
  const res = await fetch(ZIP_URL, { signal: AbortSignal.timeout(60000), headers: { 'user-agent': 'dsh-game-daily' } });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 10_000) throw new Error('下载内容过小，可能失败');
  fs.writeFileSync(zipPath, buffer);
  const extractDir = path.join(tempDir, 'extract');
  const unzip = await run('powershell.exe', [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${extractDir.replace(/'/g, "''")}' -Force`,
  ]);
  if (!unzip.ok) throw new Error(`解压失败：${unzip.error || unzip.stderr}`);
  const inner = fs.readdirSync(extractDir).find((name) => fs.existsSync(path.join(extractDir, name, 'package.json')));
  if (!inner) throw new Error('压缩包内没有 package.json');
  const source = path.join(extractDir, inner);
  // 只在同一个安装目录内覆盖，跳过用户数据/依赖目录
  fs.cpSync(source, root, {
    recursive: true,
    force: true,
    filter: (src) => !/node_modules|[\\/]\.git([\\/]|$)/.test(src),
  });
  const after = readLocalVersion();
  fs.rmSync(tempDir, { recursive: true, force: true });
  return {
    ok: true,
    method: 'zip',
    from: before,
    to: after,
    output: `下载 ${buffer.length} 字节并覆盖安装`,
    error: '',
    restartRequired: before !== after,
  };
}

export async function applyUpdate({ pluginRoot: root } = {}) {
  const target = root || pluginRoot();
  if (!fs.existsSync(path.join(target, 'package.json'))) {
    return { ok: false, error: `插件目录不存在或无 package.json：${target}` };
  }
  try {
    const result = gitAvailable(target) ? await applyViaGit(target) : await applyViaZip(target);
    cache.at = Date.now();
    cache.value = null;
    return { ...result, restartRequired: true, checkedAt: new Date().toISOString() };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

export default { checkForUpdate, applyUpdate, compareVersions, readLocalVersion, pluginRoot };
