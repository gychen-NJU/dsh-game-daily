// bettergi-mcp 的「注册」：往当前 profile 的 cordis.patch.yml 追加一条 MCP client。
//
// 下载只解决「脚本在不在」，交互会话要能调到 bgi_* 工具，还需要 profile 里有这一行。
// 这里做最小侵入：没注册过才追加；追加前备份；写后回读校验；不改其它行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveNodeExe } from './nodeexe.mjs';

export function dshHomeOf(home) {
  return home || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

export function profileDirOf(profile, home) {
  const name = profile || process.env.DSH_PROFILE || 'desktop';
  return path.join(dshHomeOf(home), 'profiles', name);
}

export function bettergiMcpPatchPath(profile, home) {
  return path.join(profileDirOf(profile, home), 'cordis.patch.yml');
}

export function hasBettergiMcpRow(text) {
  const value = String(text || '');
  return /serverName:\s*['"]?bettergi['"]?/m.test(value) || /bettergi-mcp/m.test(value);
}

function yamlQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function yamlScalar(value) {
  return String(value).trim().replace(/^(['"])(.*)\1$/, '$2');
}

function existsFile(target) {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

/**
 * 就地修补已存在的 bettergi-mcp 条目（#5 的存量场景：早先注册时写的是裸 `node`，
 * PATH 里没有 node 的那台机器升级后不会自己变好）。
 * 只改两处：`command:` 若是裸 node / 已失效的旧路径，改成 resolveNodeExe() 的绝对路径；
 * `args:` 里 .mjs 脚本若指向已不存在的位置，换成本次的 scriptPath。
 * 返回 null 表示没找到可修补的块或无需改动。
 */
export function rewriteBettergiMcpRecipe(text, nodeCommand, scriptPath) {
  const lines = String(text || '').split(/\r?\n/);
  const idIndex = lines.findIndex((line) => /^\s*-\s*(id|name):\s*['"]?bettergi-mcp['"]?\s*$/.test(line));
  if (idIndex < 0) return null;
  let end = lines.length;
  for (let i = idIndex + 1; i < lines.length; i += 1) {
    if (/^-\s*(insert|id|remove|replace|patch)\b/.test(lines[i])) {
      end = i;
      break;
    }
  }
  let changed = false;
  let argsIndent = '';
  for (let i = idIndex + 1; i < end; i += 1) {
    const line = lines[i];
    const cmd = line.match(/^(\s*)command:\s*(.*)$/);
    if (cmd) {
      const current = yamlScalar(cmd[2]);
      if (/^node(\.exe)?$/i.test(current) || !existsFile(current)) {
        const next = `${cmd[1]}command: ${yamlQuote(nodeCommand)}`;
        if (next !== line) {
          lines[i] = next;
          changed = true;
        }
      }
      continue;
    }
    const args = line.match(/^(\s*)args:\s*$/);
    if (args) {
      argsIndent = args[1];
      continue;
    }
    if (!argsIndent) continue;
    const item = line.match(/^(\s*)-\s*(.*)$/);
    if (!item || item[1].length <= argsIndent.length) {
      argsIndent = '';
      continue;
    }
    const current = yamlScalar(item[2]);
    if (/\.mjs$/i.test(current) && !existsFile(current)) {
      const next = `${item[1]}- ${yamlQuote(String(scriptPath).replace(/\\/g, '/'))}`;
      if (next !== line) {
        lines[i] = next;
        changed = true;
      }
    }
    argsIndent = '';
  }
  return changed ? lines.join('\n') : null;
}

/**
 * 确保当前 profile 的补丁里有 bettergi MCP 行。
 * 返回 { ok, changed, path, backup? }：changed=true 表示这次真的写了文件（需要重启 DSH 才生效）。
 */
export function registerBettergiMcp({ profile, scriptPath, home } = {}) {
  if (!scriptPath) return { ok: false, error: '缺少 bettergi-mcp 脚本路径（先下载它再注册）' };
  const file = bettergiMcpPatchPath(profile, home);
  let before;
  try {
    before = fs.readFileSync(file, 'utf8');
  } catch (error) {
    return { ok: false, error: `找不到 profile 补丁文件：${file}` };
  }
  // 命令写 node 的绝对路径：PATH 里没有 node 时（#5），`command: node` 会让 MCP 直接起不来。
  const nodeCommand = resolveNodeExe().replace(/\\/g, '/');
  if (hasBettergiMcpRow(before)) {
    // 存量条目：早先注册的可能是裸 `node`（或脚本已跟着搬走），升到本版后不会自己变好 —— 就地修补。
    const patched = rewriteBettergiMcpRecipe(before, nodeCommand, scriptPath);
    if (!patched || patched === before) return { ok: true, changed: false, path: file };
    const backup = `${file}.bak-gd-${Date.now()}`;
    try {
      fs.copyFileSync(file, backup);
    } catch (error) {
      return { ok: false, error: `备份补丁文件失败：${String((error && error.message) || error)}` };
    }
    try {
      fs.writeFileSync(file, patched, 'utf8');
    } catch (error) {
      return { ok: false, error: `修补补丁文件失败：${String((error && error.message) || error)}`, backup };
    }
    if (!hasBettergiMcpRow(fs.readFileSync(file, 'utf8'))) {
      return { ok: false, error: '修补后回读未找到 bettergi MCP 行', backup };
    }
    return { ok: true, changed: true, rewritten: true, path: file, backup };
  }

  const backup = `${file}.bak-gd-${Date.now()}`;
  try {
    fs.copyFileSync(file, backup);
  } catch (error) {
    return { ok: false, error: `备份补丁文件失败：${String((error && error.message) || error)}` };
  }
  const block = [
    '',
    '# dsh-game-daily: BetterGI MCP（原神的 bgi_* 工具；删掉这一段即可停用）',
    '- insert:',
    '    - id: bettergi-mcp',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: bettergi',
    '        transport: stdio',
    `        command: ${yamlQuote(nodeCommand)}`,
    '        args:',
    `          - ${yamlQuote(String(scriptPath).replace(/\\/g, '/'))}`,
    '        failOnStartupError: false',
    '',
  ].join('\n');

  try {
    const tail = before.endsWith('\n') ? '' : '\n';
    fs.writeFileSync(file, `${before}${tail}${block}`, 'utf8');
  } catch (error) {
    return { ok: false, error: `写入补丁文件失败：${String((error && error.message) || error)}`, backup };
  }

  let after;
  try {
    after = fs.readFileSync(file, 'utf8');
  } catch {
    after = '';
  }
  if (!hasBettergiMcpRow(after)) {
    return { ok: false, error: '写入后回读未找到 bettergi MCP 行', backup };
  }
  return { ok: true, changed: true, path: file, backup };
}
