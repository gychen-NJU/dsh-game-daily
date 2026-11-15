// 计划任务要跑的是 Node，而不是宿主进程本身。
//
// 插件经常运行在桌面端（Electron）里：此时 process.execPath 是 DeepSeek Harness.exe，
// 用它当计划任务的可执行文件，Windows 会去启动第二个桌面端实例 —— 单实例锁一挡，
// 进程立刻以 0 退出，任务看起来"跑了"，其实什么都没做（0x0 但不产生任何输出）。
// 所以这里优先解析真正的 node.exe，找不到才退回 process.execPath。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

function usableNode(file) {
  try {
    return Boolean(file) && fs.existsSync(file) && /node(\.exe)?$/i.test(file);
  } catch {
    return false;
  }
}

/** 找出机器上真实的 Node 可执行文件；解析不到时返回当前进程可执行文件。 */
export function resolveNodeExe() {
  const fromEnv = process.env.DSH_GAME_DAILY_NODE;
  if (usableNode(fromEnv)) return fromEnv;
  // 用 node 跑插件（web/headless/CLI）时，自己就是 Node。
  if (!process.versions.electron && usableNode(process.execPath)) return process.execPath;

  const candidates = [];
  try {
    const out = execFileSync('where.exe', ['node'], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    });
    for (const line of String(out || '').split(/\r?\n/)) {
      const file = line.trim();
      if (file) candidates.push(file);
    }
  } catch {
    /* PATH 里没有 node，继续看常见安装位置 */
  }

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  candidates.push(
    path.join(programFiles, 'nodejs', 'node.exe'),
    localAppData ? path.join(localAppData, 'Programs', 'nodejs', 'node.exe') : '',
    path.join(programFilesX86, 'nodejs', 'node.exe'),
  );

  for (const file of candidates) {
    if (usableNode(file)) return file;
  }
  return process.execPath;
}

/** 判断某个路径像不像 Node（用于体检/排错展示）。 */
export function isNodeExe(file) {
  return usableNode(file);
}

export default resolveNodeExe;
