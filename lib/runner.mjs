// 起一轮 headless 运行（计划任务与「立即运行一次」共用同一条路）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDsh, dshHome } from './deps.mjs';
import { resolveNodeExe } from './nodeexe.mjs';
import { gameById } from './games.mjs';
import { buildRunPrompt } from './prompt.mjs';
import { resolveBettergiMcp } from './bettergi-mcp.mjs';
import { m7aInstallInfo } from './m7a.mjs';
import { maaInstallInfo, maaDailyConfig, ensureBh3Running, ensureBh3Aspect, isBh3Running, ensureMaaExitTask, maaStopSync } from './maa.mjs';
import { ensureZzzServer, stopZzzServer, zzzCloseGame, zzzRoot, zzzBaseUrl, ensureZzzChargePlanFallback } from './zzz.mjs';
import { closeGame, closeOtherGames, runningGames, GAME_PROCESSES } from './gameproc.mjs';
import {
  newRunId,
  runDirOf,
  metaPathOf,
  reportPathOf,
  stdoutPathOf,
  readJsonSafe,
  writeJson,
} from './report.mjs';

export function overlayPath(stateDir) {
  return path.join(stateDir, 'automation', 'headless-overlay.yml');
}

/** 同步等待（计划任务串行等待上一轮时用；不要放在 HTTP 请求路径上）。 */
function sleepSync(ms) {
  const wait = Math.max(0, Number(ms) || 0);
  if (!wait) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  } catch {
    /* ignore */
  }
}

/** 插件根目录（判断 automation/ 里随包脚本的位置，兼容 link 安装）。 */
function pluginRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
}

export function guardScriptPath() {
  return path.join(pluginRoot(), 'automation', 'keep-foreground.ps1');
}

// 每个游戏同时最多一个守护进程；key=gameId
const guards = new Map();

/** 运行期间盯前台：游戏被别的窗口抢走就 1 秒内拉回。守护脚本随包分发。 */
export function startForegroundGuard({ stateDir, game, maxMinutes = 150, intervalMs = 1000 }) {
  const script = guardScriptPath();
  if (!fs.existsSync(script)) return { ok: false, error: `前台守护脚本缺失：${script}` };
  const processName = game.guardProcess || String(game.process[0] || '').replace(/\.exe$/i, '');
  if (!processName) return { ok: false, error: '无法确定游戏进程名' };
  const stopFile = path.join(stateDir, 'automation', `guard-${game.id}.stop`);
  const logFile = path.join(stateDir, 'automation', `guard-${game.id}.log`);
  try {
    fs.rmSync(stopFile, { force: true });
    fs.mkdirSync(path.dirname(stopFile), { recursive: true });
  } catch {
    /* ignore */
  }
  const args = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-GameProcessName',
    processName,
    '-IntervalMs',
    String(Math.max(500, Number(intervalMs) || 1000)),
    '-MaxMinutes',
    String(Math.max(5, Number(maxMinutes) || 150)),
    '-StopFile',
    stopFile,
    '-LogPath',
    logFile,
    '-Quiet',
  ];
  try {
    const child = spawn('powershell.exe', args, { windowsHide: true, stdio: 'ignore' });
    guards.set(game.id, { child, stopFile, logFile, pid: child.pid, startedAt: new Date().toISOString() });
    child.on('exit', () => {
      const current = guards.get(game.id);
      if (current && current.child === child) guards.delete(game.id);
    });
    return { ok: true, pid: child.pid, logFile, stopFile };
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
}

export function stopForegroundGuard(stateDir, gameId) {
  const entry = guards.get(gameId);
  if (!entry) return { ok: true, stopped: false };
  try {
    fs.writeFileSync(entry.stopFile, 'stop\n', 'utf8');
  } catch {
    /* ignore */
  }
  try {
    entry.child.kill();
  } catch {
    /* ignore */
  }
  guards.delete(gameId);
  return { ok: true, stopped: true, pid: entry.pid };
}

export function guardStatus(gameId) {
  const entry = guards.get(gameId);
  if (!entry) return { running: false };
  return { running: alive(entry.pid), pid: entry.pid, logFile: entry.logFile };
}

function pidPath(stateDir, gameId) {
  return path.join(stateDir, 'automation', `runner-${gameId}.pid`);
}

/** 按游戏引擎生成 overlay：只有原神需要把 bettergi MCP 注入 headless。 */
export function ensureOverlay({ stateDir, game }) {
  // 容错：允许直接传游戏 id（字符串），并拒绝彻底缺参，避免静默生成空 overlay。
  if (typeof game === 'string') return ensureOverlay({ stateDir, game: gameById(game) });
  if (!game || !game.id) return { ok: false, error: 'ensureOverlay 需要游戏对象或游戏 id' };
  const file = overlayPath(stateDir);
  const mcpScript = resolveBettergiMcp({ stateDir });
  const lines = ['# 由 dsh-game-daily 自动生成（每次运行前重写，勿手改）'];
  let hasMcp = false;
  if (game && game.engine === 'bettergi' && mcpScript) {
    hasMcp = true;
    const nodeCmd = resolveNodeExe();
    const mcpCwd = path.dirname(mcpScript);
    lines.push(
      '- insert:',
      '    - id: mcp-game-daily-bettergi',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: bettergi',
      '        transport: stdio',
      `        command: '${nodeCmd.replace(/\\/g, '/')}'`,
      '        args:',
      `          - '${mcpScript}'`,
      `        cwd: '${mcpCwd.replace(/\\/g, '/')}'`,
      '        failOnStartupError: false',
    );
  } else if (game && game.engine === 'zzz-od') {
    // 绝区零：注入插件自带的 zzz-od-mcp（stdin/stdout 直连一条龙后端）。
    const zzzScript = path.join(pluginRoot(), 'tools', 'zzz-od-mcp', 'zzz-od-mcp.mjs');
    if (!fs.existsSync(zzzScript)) return { ok: false, error: `zzz-od MCP 脚本缺失：${zzzScript}` };
    hasMcp = true;
    const nodeCmd = resolveNodeExe();
    lines.push(
      '- insert:',
      '    - id: mcp-game-daily-zzz',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: zzz-od',
      '        transport: stdio',
      `        command: '${nodeCmd.replace(/\\/g, '/')}'`,
      '        args:',
      `          - '${zzzScript.replace(/\\/g, '/')}'`,
      `        cwd: '${path.dirname(zzzScript).replace(/\\/g, '/')}'`,
      '        env:',
      `          ZZZ_OD_ROOT: '${zzzRoot().replace(/\\/g, '/')}'`,
      `          ZZZ_OD_URL: '${zzzBaseUrl()}'`,
      '        failOnStartupError: false',
    );
  } else if (game && game.engine === 'm7a') {
    // 星铁：注入插件自带的 m7a-mcp（直接调用 m7a.exe，stdin/stdout）。
    const m7aScript = path.join(pluginRoot(), 'tools', 'm7a-mcp', 'm7a-mcp.mjs');
    if (!fs.existsSync(m7aScript)) return { ok: false, error: `m7a MCP 脚本缺失：${m7aScript}` };
    const root = m7aInstallInfo();
    hasMcp = true;
    const nodeCmd = resolveNodeExe();
    lines.push(
      '- insert:',
      '    - id: mcp-game-daily-m7a',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: m7a',
      '        transport: stdio',
      `        command: '${nodeCmd.replace(/\\/g, '/')}'`,
      '        args:',
      `          - '${m7aScript.replace(/\\/g, '/')}'`,
      `        cwd: '${path.dirname(m7aScript).replace(/\\/g, '/')}'`,
      '        env:',
      `          M7A_ROOT: '${root.ok && root.root ? root.root.replace(/\\/g, '/') : ''}'`,
      `          DSH_GAME_DAILY_STATE_DIR: '${stateDir.replace(/\\/g, '/')}'`,
      '        failOnStartupError: false',
    );
  } else if (game && game.engine === 'maa-bbb') {
    // 崩坏3：注入插件自带的 maa-bbb-mcp（直接调用 mab.exe，stdin/stdout）。
    const maaScript = path.join(pluginRoot(), 'tools', 'maa-bbb-mcp', 'maa-bbb-mcp.mjs');
    if (!fs.existsSync(maaScript)) return { ok: false, error: `maa-bbb MCP 脚本缺失：${maaScript}` };
    const root = maaInstallInfo();
    hasMcp = true;
    const nodeCmd = resolveNodeExe();
    lines.push(
      '- insert:',
      '    - id: mcp-game-daily-maa-bbb',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: maa-bbb',
      '        transport: stdio',
      `        command: '${nodeCmd.replace(/\\/g, '/')}'`,
      '        args:',
      `          - '${maaScript.replace(/\\/g, '/')}'`,
      `        cwd: '${path.dirname(maaScript).replace(/\\/g, '/')}'`,
      '        env:',
      `          MAA_BBB_ROOT: '${root.ok && root.root ? root.root.replace(/\\/g, '/') : ''}'`,
      `          DSH_GAME_DAILY_STATE_DIR: '${stateDir.replace(/\\/g, '/')}'`,
      '        failOnStartupError: false',
    );
  } else {
    // dsh 要求 overlay 顶层是 YAML 数组：没有要注入的条目时必须显式写 `[]`，
    // 否则「只有一行注释」会被判为非法 patch 并直接启动失败。
    lines.push('[]');
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  return { ok: true, file, hasMcp };
}

/** 探活时抛出的错误是否代表「进程还活着」：Windows 跨完整性级别只会给 EPERM。 */
export function aliveFromError(error) {
  return Boolean(error && error.code === 'EPERM');
}

function alive(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  try {
    process.kill(value, 0);
    return true;
  } catch (error) {
    // 早先这里一律当成「进程不存在」，于是提权的计划任务轮次会被 reconcile 误判 failed。
    return aliveFromError(error);
  }
}

export function readRunner(stateDir, gameId) {
  const info = readJsonSafe(pidPath(stateDir, gameId));
  if (!info) return null;
  return { ...info, running: alive(info.pid) };
}

export function isRunning(stateDir, gameId) {
  const info = readRunner(stateDir, gameId);
  return Boolean(info && info.running);
}

function appendLog(file, text) {
  try {
    fs.appendFileSync(file, text, 'utf8');
  } catch {
    /* 日志写不进去不能杀宿主 */
  }
}

/**
 * 找"这一轮之后写过的 session 文件"（$DSH_HOME/sessions/<工作区>/<会话>/session.jsonl[.zstd]）。
 * 兜底报告里带上它，用户才能直接翻到 agent 到底卡在哪一步 —— 只报一句 exit 1 等于没证据（#5）。
 */
function latestSessionAfter(startMs) {
  const root = path.join(dshHome(), 'sessions');
  let best = null;
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!/^session\.jsonl(\.zstd)?$/.test(entry.name)) continue;
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs + 5000 < startMs) continue; // 5s 容差：进程刚起来时文件可能还没落盘
        if (!best || stat.mtimeMs > best.mtimeMs) best = { file: full, mtimeMs: stat.mtimeMs };
      } catch {
        /* 单个文件读不到不影响其它候选 */
      }
    }
  };
  walk(root, 0);
  return best ? best.file : '';
}

/**
 * headless 没写报告时的兜底报告。除了退出码，还要留下"为什么退出"：
 * 信号（被 taskkill/超时清理/崩溃）、耗时、子进程日志与 session 指针 —— 否则只有一句 exit 1 无从排查（#5）。
 * 导出给 smoke 测试直接断言字段（正常流程只经 startRun 的 exit 回调调用）。
 */
export function fallbackReport({ gameId, mode, runId, exitCode, signal, durationMs, reason, logTail, logFile, runDir, startedMs }) {
  const code = Number.isFinite(Number(exitCode)) ? Number(exitCode) : -1;
  const namedSignal = typeof signal === 'string' && signal ? signal : '';
  const elapsed = Number.isFinite(Number(durationMs)) && Number(durationMs) >= 0 ? Math.round(Number(durationMs)) : null;
  const notes =
    reason ||
    (namedSignal
      ? `headless 被信号 ${namedSignal} 终止（常见于外部 taskkill、超时清理或进程崩溃），未写报告`
      : code === -1
        ? 'headless 子进程没有起来（spawn 失败），未写报告'
        : code === 0
          ? 'headless 正常退出但没有写报告，状态未知'
          : `headless 退出码 ${code}，未写报告`);
  const session = latestSessionAfter(Number(startedMs) || Date.now() - 30 * 60 * 1000);
  return {
    schemaVersion: 1,
    status: code === 0 ? 'unknown' : 'failed',
    mode,
    runId,
    game: gameId,
    startedAt: Number.isFinite(Number(startedMs)) ? new Date(Number(startedMs)).toISOString() : '',
    endedAt: new Date().toISOString(),
    steps: [],
    exit: { code, signal: namedSignal || null, durationMs: elapsed },
    evidence: [
      `exitCode=${code}`,
      `signal=${namedSignal || 'none'}`,
      ...(elapsed === null ? [] : [`elapsedMs=${elapsed}`]),
      ...(logFile ? [`log=${logFile}`] : []),
      ...(session ? [`session=${session}`] : []),
    ],
    notes,
    stdoutTail: logTail,
    logFile: logFile || '',
    runDir: runDir || '',
    sessionFile: session,
    generatedBy: 'runner-fallback',
  };
}

/**
 * 起一轮运行。立即返回 {runId, pid, runDir}；进程结束后的收尾（meta/兜底报告）在后台完成。
 */
export async function startRun({
  gameId,
  mode = 'real',
  stateDir,
  profile = 'headless',
  trigger = 'manual',
  skillsRoot,
  timeoutMin = 90,
  guard = true,
}) {
  const game = gameById(gameId);
  if (!game) return { ok: false, error: `未知游戏：${gameId}` };
  if (!game.canRun) return { ok: false, error: `${game.title} 目前不支持自动代理` };
  if (isRunning(stateDir, gameId)) {
    const current = readRunner(stateDir, gameId);
    return { ok: false, error: `${game.title} 已有一轮在跑（pid ${current.pid}，runId ${current.runId}）` };
  }
  // 上一款游戏还在跑时不要抢：计划任务会等它收尾（最长 20 分钟），手动运行直接报错。
  if (mode === 'real') {
    const busyNow = () =>
      Object.keys(GAME_PROCESSES).filter((otherId) => otherId !== gameId && isRunning(stateDir, otherId));
    let busy = busyNow();
    if (busy.length) {
      if (trigger !== 'schedule') {
        const titles = busy.map((id) => (gameById(id) || { title: id }).title).join('、');
        return { ok: false, error: `${titles} 的日常还在跑，等它结束再试` };
      }
      const waitMs = Math.max(0, Number(process.env.DSH_GAME_DAILY_WAIT_MS) || 20 * 60 * 1000);
      const deadline = Date.now() + waitMs;
      appendLog(
        path.join(stateDir, 'automation', 'wait.log'),
        `# ${new Date().toISOString()} ${gameId}: waiting for ${busy.join(',')} to finish (max ${Math.round(waitMs / 1000)}s)\n`,
      );
      while (busyNow().length && Date.now() < deadline) sleepSync(15000);
      busy = busyNow();
      if (busy.length) {
        const titles = busy.map((id) => (gameById(id) || { title: id }).title).join('、');
        return { ok: false, error: `${titles} 的日常超过等待上限还没结束，跳过本轮` };
      }
    }
  }
  const dsh = resolveDsh();
  if (!dsh) return { ok: false, error: '找不到 dsh CLI，无法起 headless 运行' };

  // 崩铁：M7A 未安装就别起 headless 了（既省 token，也避免 agent 乱点屏幕）。
  if (game && game.engine === 'm7a') {
    const m7a = m7aInstallInfo();
    if (!m7a.ok) {
      return {
        ok: false,
        error: m7a.legacyOnly
          ? `只找到旧版三月七小助手（${m7a.legacyRoot}，没有 m7a.exe），请先升级`
          : '三月七小助手未安装（m7a.exe 不存在），先在设置页「依赖体检」里点「让 DSH 协助安装」',
      };
    }
  }
  // 崩坏3：Maa_bbb 未安装（或没有可用配置）就别起 headless 了。
  let bh3Result = null;
  let maaExit = null;
  if (game && game.engine === 'maa-bbb') {
    const maa = maaInstallInfo();
    if (!maa.ok) {
      return {
        ok: false,
        error: 'Maa_bbb 未安装（mab.exe 不存在或安装目录未登记），先在设置页「依赖体检」里点「让 DSH 协助安装」',
      };
    }
    const daily = maaDailyConfig(maa.root);
    if (!daily) {
      return {
        ok: false,
        error: `Maa_bbb 已安装但没有任何配置：请先手动打开一次 ${maa.root}\\mab.exe，让它生成预设配置`,
      };
    }
    // 演练模式不碰游戏：不改配置、不改分辨率、不拉起游戏。
    if (mode === 'real') {
      // 用户要求：跑完顺手退出游戏。Maa_bbb 自带「退出/关闭游戏」任务，默认关着，这里每次起跑前补勾；
      // 想把游戏留着就设 DSH_GAME_DAILY_MAA_KEEP_GAME=1。
      maaExit = ensureMaaExitTask({ root: maa.root, configId: daily.id });

      // Maa_bbb 的 M9A 只认 16:9：16:10（如 2560x1600）会被直接判「分辨率比例不匹配」并停手。
      // 游戏没开时直接改注册表（下次启动生效）；已经在跑且不是 16:9 就只能先关游戏。
      const screenFix = ensureBh3Aspect({});
      if (!screenFix.ok) {
        const before = screenFix.before || {};
        const desc = before.ok ? `${before.width}x${before.height}（比例 ${before.ratio}）` : '未知';
        return {
          ok: false,
          error: `崩三窗口不是 16:9（当前 ${desc}），Maa_bbb 会直接停手。${isBh3Running() ? '请先关掉游戏再重跑，插件会自动改成 1280x720 窗口化。' : '自动改设置失败：' + (screenFix.reason || '')}`,
        };
      }
      // Maa_bbb 的桌面端控制器在运行开始时就要求游戏窗口已存在（否则「设备连接失败」）：
      // 先把崩坏3 拉起来再过一遍安装检查。
      bh3Result = ensureBh3Running({ waitMs: 90000 });
      if (bh3Result && typeof bh3Result === 'object') bh3Result.aspect = screenFix.after || screenFix.before;
      if (!bh3Result.ok) return { ok: false, error: '崩坏3 未就绪，Maa_bbb 无法连接设备：' + (bh3Result.error || '') };
    }
  }
  const runId = newRunId();
  const runDir = runDirOf(stateDir, gameId, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const overlay = ensureOverlay({ stateDir, game });
  const reportPath = reportPathOf(stateDir, gameId, runId);
  const prompt = buildRunPrompt({
    game,
    mode,
    runId,
    runDir,
    reportPath,
    skillsRoot,
    stateDir,
  });

  const meta = {
    runId,
    gameId,
    gameTitle: game.title,
    mode,
    trigger,
    profile,
    startedAt: new Date().toISOString(),
    promptChars: prompt.length,
    overlay: overlay.ok ? overlay.file : '',
    overlayError: overlay.ok ? '' : overlay.error,
  };
  writeJson(metaPathOf(stateDir, gameId, runId), meta);

  const args = [...dsh.args, '--profile', profile];
  if (overlay.ok) args.push('--patch', overlay.file);
  args.push(prompt);

  const logFile = stdoutPathOf(stateDir, gameId, runId);
  appendLog(logFile, `# ${new Date().toISOString()} start ${gameId} ${mode} pid=? promptChars=${prompt.length}\n`);

  if (bh3Result) {
    meta.bh3 = bh3Result;
  meta.maaExit = maaExit;
    appendLog(logFile, '# bh3: ' + JSON.stringify(bh3Result) + '\n');
    writeJson(metaPathOf(stateDir, gameId, runId), meta);
  }

  // 用户要求：进入下一个游戏的日常前，先确保上一个游戏已经退出（减少后台占用、避免抢窗口）。
  // 演练模式不碰游戏，也就不做清理。
  if (mode === 'real') {
    try {
      const closedBefore = closeOtherGames(gameId);
      meta.preCleanup = closedBefore;
      appendLog(logFile, `# pre-run cleanup: ${closedBefore.length ? JSON.stringify(closedBefore) : 'no other game running'}\n`);
    } catch (error) {
      appendLog(logFile, `# pre-run cleanup failed: ${String((error && error.message) || error)}\n`);
    }
    writeJson(metaPathOf(stateDir, gameId, runId), meta);
  }

  // 绝区零：清体力兜底——「特训目标已达成」时改刷驱动盘（改写一条龙的 charge_plan.yml）。
  // 一条龙每轮开跑前会重读配置，所以在起跑前把文件补成目标形态即可生效。
  if (mode === 'real' && game.engine === 'zzz-od') {
    try {
      const fallback = ensureZzzChargePlanFallback({});
      meta.zzzFallback = {
        ok: fallback.ok === true,
        skipped: fallback.skipped === true,
        changed: fallback.changed || [],
        path: fallback.path,
        missionType: fallback.config ? fallback.config.missionTypeName : '',
        error: fallback.error,
      };
      appendLog(logFile, `# zzz fallback: ${JSON.stringify(meta.zzzFallback)}\n`);
    } catch (error) {
      meta.zzzFallback = { ok: false, error: String((error && error.message) || error) };
      appendLog(logFile, `# zzz fallback failed: ${meta.zzzFallback.error}\n`);
    }
    writeJson(metaPathOf(stateDir, gameId, runId), meta);
  }

  // 绝区零走一条龙：真实运行前确保后端在跑（不在就启动，可能弹一次 UAC）。
  if (mode === 'real' && game.engine === 'zzz-od') {
    try {
      const server = await ensureZzzServer({ timeoutSeconds: 45, stopFile: path.join(stateDir, 'automation', 'zzz-server.stop') });
      meta.zzzServer = { ok: server.ok, alreadyRunning: server.alreadyRunning === true, error: server.error };
      appendLog(logFile, `# zzz server: ${JSON.stringify(meta.zzzServer)}\n`);
    } catch (error) {
      meta.zzzServer = { ok: false, error: String((error && error.message) || error) };
      appendLog(logFile, `# zzz server start failed: ${meta.zzzServer.error}\n`);
    }
    writeJson(metaPathOf(stateDir, gameId, runId), meta);
  }

  const env = {
    ...process.env,
    DSH_PERMISSION_MODE: 'danger-full-access',
    DSH_GAME_DAILY_STATE_DIR: stateDir,
  };
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';

  // 兜底报告要算耗时、找 session 文件，时间基准就是 meta 里的起跑时刻。
  const startedMs = Date.parse(meta.startedAt) || Date.now();

  let child;
  try {
    child = spawn(dsh.command, args, {
      cwd: stateDir,
      shell: dsh.kind === 'cmd',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
  } catch (error) {
    const message = String((error && error.message) || error);
    writeJson(
      reportPath,
      fallbackReport({
        gameId,
        mode,
        runId,
        exitCode: -1,
        reason: `headless 子进程没有起来（spawn 失败）：${message}`,
        logTail: message,
        logFile: stdoutPathOf(stateDir, gameId, runId),
        runDir,
        startedMs,
      }),
    );
    return { ok: false, error: message, runId };
  }

  const pid = child.pid;
  writeJson(pidPath(stateDir, gameId), {
    pid,
    runId,
    mode,
    trigger,
    startedAt: meta.startedAt,
    dshBin: dsh.bin,
  });
  appendLog(logFile, `# spawned pid=${pid} via ${dsh.kind} ${dsh.bin}\n`);

  // 顺手起前台守护：游戏被别的窗口抢走时 1 秒内拉回（可被 ui.foregroundGuard 关掉）。
  let guardInfo = { ok: false, skipped: true };
  if (guard) {
    guardInfo = startForegroundGuard({
      stateDir,
      game,
      maxMinutes: Math.max(5, Number(timeoutMin) || 90) + 10,
    });
    appendLog(
      logFile,
      `# foreground guard ${guardInfo.ok ? `started pid=${guardInfo.pid}` : `failed: ${guardInfo.error}`}\n`,
    );
  }

  child.stdout.on('data', (chunk) => appendLog(logFile, String(chunk)));
  child.stderr.on('data', (chunk) => appendLog(logFile, String(chunk)));
  child.on('error', (error) => {
    appendLog(logFile, `# spawn error: ${String((error && error.message) || error)}\n`);
  });
  child.on('exit', (code, signal) => {
    const exitLine = `code=${code} signal=${signal || 'none'} elapsed=${Math.round((Date.now() - startedMs) / 1000)}s`;
    appendLog(logFile, `# exit ${exitLine}\n`);
    stopForegroundGuard(stateDir, gameId);
    const finishedAt = new Date().toISOString();
    // 跑完就把游戏关掉（用户要求：日常做完退出游戏，减少后台占用）。演练模式不碰游戏。
    let cleanup = [];
    if (mode === 'real') {
      try {
        cleanup = closeGame(gameId).results;
        appendLog(logFile, `# close ${gameId}: ${JSON.stringify(cleanup)}\n`);
      } catch (error) {
        appendLog(logFile, `# close ${gameId} failed: ${String((error && error.message) || error)}\n`);
      }
      // 崩三：跑完把 Maa_bbb（mab.exe）一起关掉，下次起跑再拉起（用户要求：别常驻后台）。
      // DSH_GAME_DAILY_MAA_KEEP_APP=1 可保留它（手动调试/复用）。
      if (game.engine === 'maa-bbb' && !process.env.DSH_GAME_DAILY_MAA_KEEP_APP) {
        try {
          const stopped = maaStopSync();
          appendLog(logFile, `# maa stop: ${JSON.stringify(stopped)}\n`);
        } catch (error) {
          appendLog(logFile, `# maa stop failed: ${String((error && error.message) || error)}\n`);
        }
      }
    }
    // 绝区零：游戏是提权进程，普通权限杀不掉，交给提权后的后端自己关；随后再停后端。
    if (mode === 'real' && game.engine === 'zzz-od') {
      void (async () => {
        try {
          const closed = await zzzCloseGame({ timeoutMs: 15000 });
          appendLog(logFile, `# zzz close game via backend: ${JSON.stringify(closed)}\n`);
          const names = (GAME_PROCESSES.zzz || []).map((n) => n.toLowerCase());
          for (let i = 0; i < 12; i += 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            const running = runningGames().map((n) => String(n).toLowerCase());
            if (!running.some((n) => names.includes(n))) break;
          }
          const res = closeGame(gameId).results;
          appendLog(logFile, `# close ${gameId} after backend close: ${JSON.stringify(res)}\n`);
          try {
            const metaFile = metaPathOf(stateDir, gameId, runId);
            const current = readJsonSafe(metaFile) || meta;
            writeJson(metaFile, { ...current, cleanup: res });
          } catch { /* ignore */ }
        } catch (error) {
          appendLog(logFile, `# zzz close failed: ${String((error && error.message) || error)}\n`);
        }
        try {
          const stopped = await stopZzzServer({ stateDir, timeoutSeconds: 20 });
          appendLog(logFile, `# zzz server stop: ${JSON.stringify(stopped)}\n`);
        } catch (error) {
          appendLog(logFile, `# zzz server stop failed: ${String((error && error.message) || error)}\n`);
        }
      })();
    }
    try {
      const current = readJsonSafe(metaPathOf(stateDir, gameId, runId)) || meta;
      writeJson(metaPathOf(stateDir, gameId, runId), { ...current, finishedAt, exitCode: code, cleanup });
    } catch {
      /* ignore */
    }
    if (!fs.existsSync(reportPath)) {
      let tail = '';
      try {
        tail = fs.readFileSync(logFile, 'utf8').split('\n').slice(-40).join('\n');
      } catch {
        tail = '';
      }
      try {
        writeJson(
          reportPath,
          fallbackReport({
            gameId,
            mode,
            runId,
            exitCode: code,
            signal,
            durationMs: Date.now() - startedMs,
            logTail: tail,
            logFile,
            runDir,
            startedMs,
          }),
        );
      } catch {
        /* ignore */
      }
    }
    try {
      fs.rmSync(pidPath(stateDir, gameId), { force: true });
    } catch {
      /* ignore */
    }
  });

  return { ok: true, runId, pid, runDir, startedAt: meta.startedAt, guard: guardInfo };
}

/** 停止某游戏正在跑的一轮（taskkill /T /F，连同子进程）。 */
export function stopRun({ stateDir, gameId }) {
  stopForegroundGuard(stateDir, gameId);
  const info = readRunner(stateDir, gameId);
  if (!info) return { ok: false, error: '没有正在跑的运行' };
  if (!info.running) {
    try {
      fs.rmSync(pidPath(stateDir, gameId), { force: true });
    } catch {
      /* ignore */
    }
    return { ok: false, error: `记录的进程 ${info.pid} 已经退出` };
  }
  try {
    execFileSync('taskkill.exe', ['/PID', String(info.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
  } catch (error) {
    return { ok: false, error: String((error && error.message) || error) };
  }
  try {
    fs.rmSync(pidPath(stateDir, gameId), { force: true });
  } catch {
    /* ignore */
  }
  return { ok: true, killed: info.pid, runId: info.runId };
}
