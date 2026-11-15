// bettergi-mcp 的「注册」：往当前 profile 的 cordis.patch.yml 追加一条 MCP client。
//
// 下载只解决「脚本在不在」，交互会话要能调到 bgi_* 工具，还需要 profile 里有这一行。
// 这里做最小侵入：没注册过才追加；追加前备份；写后回读校验；不改其它行。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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
  if (hasBettergiMcpRow(before)) return { ok: true, changed: false, path: file };

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
    '        command: node',
    '        args:',
    `          - ${yamlQuote(scriptPath)}`,
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
