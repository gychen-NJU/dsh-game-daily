// bettergi-mcp：路径解析与按需更新。
//
// 插件自带一份 bettergi-mcp.mjs（tools/bettergi-mcp/），装好即可用、不联网；
// 需要升级时再从 https://github.com/gychen-NJU/bettergi-mcp 下载单文件到
// <stateDir>/vendor/bettergi-mcp/（优先级高于自带副本，等于“本地覆盖”）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const BETTERGI_MCP_REPO = 'gychen-NJU/bettergi-mcp';
export const BETTERGI_MCP_RAW = `https://raw.githubusercontent.com/${BETTERGI_MCP_REPO}/main/bettergi-mcp.mjs`;

/** 插件根目录（兼容 link 安装：真实文件所在目录）。 */
function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

/** 插件随包携带的副本。 */
export function bundledPath() {
  return path.join(pluginRoot(), 'tools', 'bettergi-mcp', 'bettergi-mcp.mjs');
}

/** 下载/更新副本的固定位置。 */
export function vendorPath(stateDir) {
  return path.join(stateDir, 'vendor', 'bettergi-mcp', 'bettergi-mcp.mjs');
}

/** 没有环境变量 / 下载副本时，看看常见的同机位置（自带副本优先，装好即用）。 */
function fallbackCandidates() {
  return [
    bundledPath(),
    // 与本插件同级的 dsh-betterGI 工作区（本机常见布局，作为旧副本兜底）
    path.resolve(pluginRoot(), '..', 'dsh-betterGI', 'tools', 'bettergi-mcp', 'bettergi-mcp.mjs'),
    path.resolve(pluginRoot(), 'vendor', 'bettergi-mcp', 'bettergi-mcp.mjs'),
  ];
}

/**
 * 解析 bettergi-mcp 服务器脚本路径。
 * 顺序：DSH_GAME_DAILY_BETTERGI_MCP → <stateDir>/vendor → 同级工作区 → 插件自带副本。
 * 自带副本保证“装好就有”，不需要再联网拉取。
 */
export function resolveBettergiMcp({ stateDir } = {}) {
  const fromEnv = process.env.DSH_GAME_DAILY_BETTERGI_MCP;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  const candidates = [];
  if (stateDir) candidates.push(vendorPath(stateDir));
  candidates.push(...fallbackCandidates());
  if (!candidates.includes(bundledPath())) candidates.push(bundledPath());
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) return file;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * 从 GitHub 下载 bettergi-mcp.mjs 到 <stateDir>/vendor/bettergi-mcp/。
 * 只取单文件（服务器零依赖、单文件分发），原子写，失败不动旧副本。
 */
export async function fetchBettergiMcp({ stateDir, url = BETTERGI_MCP_RAW, timeoutMs = 30000 } = {}) {
  if (!stateDir) return { ok: false, error: '缺少 stateDir' };
  const target = vendorPath(stateDir);
  let text;
  try {
    const response = await fetch(url, {
      redirect: 'follow',
      signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || 30000)),
    });
    if (!response.ok) return { ok: false, error: `下载失败：HTTP ${response.status} ${url}` };
    text = await response.text();
  } catch (error) {
    return { ok: false, error: `下载失败：${String((error && error.message) || error)}` };
  }
  if (!text || text.length < 10000 || !/MCP|mcp/.test(text)) {
    return { ok: false, error: '下载内容不像 bettergi-mcp.mjs（长度或内容校验失败）' };
  }
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, text, 'utf8');
    fs.renameSync(tmp, target);
  } catch (error) {
    return { ok: false, error: `写入失败：${String((error && error.message) || error)}` };
  }
  return { ok: true, path: target, bytes: Buffer.byteLength(text), url, repo: BETTERGI_MCP_REPO };
}
