// dsh-game-daily · Host 侧：设置页的数据与动作都走 /api/game-daily/*，这里是唯一真源。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { GAMES, GAME_IDS, gameById, taskNameFor, isWeekdays } from './lib/games.mjs';
import { Store, summarizeRun } from './lib/state.mjs';
import { probeDependencies, skillsRoot } from './lib/deps.mjs';
import {
  writeTasksConfig,
  startRegistration,
  readRegisterResult,
  queryTasks,
  refreshTaskInfo,
  computeNextRun,
  startTask,
  registerScriptPath,
  ensureRegisterScript,
} from './lib/tasks.mjs';
import { startRun, stopRun, readRunner, isRunning } from './lib/runner.mjs';
import { listRuns, readReport, metaPathOf, readJsonSafe } from './lib/report.mjs';
import { buildInstallPrompt, buildReportPrompt } from './lib/prompt.mjs';
import { openSession, appendSession, sessionExists } from './lib/install.mjs';
import { notify } from './lib/notify.mjs';
import { resolveBettergiMcp, fetchBettergiMcp } from './lib/bettergi-mcp.mjs';
import { installSkill, installSkillGroup, runCoverage } from './lib/skills.mjs';
import { registerBettergiMcp } from './lib/mcp-register.mjs';
import { resolveNodeExe } from './lib/nodeexe.mjs';
import { ensureZzzServer, installZzzOneDragon } from './lib/zzz.mjs';
import { checkForUpdate, applyUpdate, readLocalVersion } from './lib/update.mjs';

export const name = 'game-daily';
export const inject = ['webServer'];

const ROUTE_PREFIX = '/api/game-daily';
const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const RECONCILE_MS = 60_000;

function pluginEnv() {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const devMode = /^(1|true|yes|on)$/i.test(String(process.env.DSH_GAME_DAILY_DEV || ''));
  const stateDir =
    process.env.DSH_GAME_DAILY_STATE_DIR || path.join(home, 'game-daily', devMode ? 'dev' : '');
  const taskPrefix = process.env.DSH_GAME_DAILY_TASK_PREFIX || (devMode ? 'game-daily-dev-' : 'game-daily-');
  return {
    devMode,
    home,
    stateDir,
    taskPrefix,
    profile: process.env.DSH_PROFILE || 'desktop',
    headlessProfile: process.env.DSH_GAME_DAILY_HEADLESS_PROFILE || 'headless',
    skillsRoot: skillsRoot(),
  };
}

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    });
  } catch {
    /* headers 已发就只写 body */
  }
  res.end(body);
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${String((error && error.message) || error)}`));
      }
    });
    req.on('error', reject);
  });
}

function clampTimeout(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(180, Math.max(5, Math.round(num)));
}

/** 只接受白名单字段，别把前端传来的东西原样写进 state。 */
function sanitizeGamesPatch(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const gameId of GAME_IDS) {
    const src = raw[gameId];
    if (!src || typeof src !== 'object') continue;
    const patch = {};
    if (typeof src.enabled === 'boolean') patch.enabled = src.enabled;
    if (src.mode === 'real' || src.mode === 'dry') patch.mode = src.mode;
    if (src.schedule && typeof src.schedule === 'object') {
      const schedule = {};
      if (TIME_RE.test(String(src.schedule.time || ''))) schedule.time = String(src.schedule.time);
      if (src.schedule.weekdays === 'daily' || isWeekdays(src.schedule.weekdays)) schedule.weekdays = src.schedule.weekdays;
      if (typeof src.schedule.catchUp === 'boolean') schedule.catchUp = src.schedule.catchUp;
      if (Object.keys(schedule).length) patch.schedule = schedule;
    }
    if (src.timeoutMin !== undefined) patch.timeoutMin = clampTimeout(src.timeoutMin, 90);
    if (typeof src.gamePath === 'string') patch.gamePath = src.gamePath.slice(0, 400);
    if (Object.keys(patch).length) out[gameId] = patch;
  }
  return out;
}

function tasksConfigGames(store, env) {
  const state = store.get();
  return GAMES.filter((game) => game.canRun).map((game) => {
    const settings = state.games[game.id];
    const taskName = taskNameFor(env.taskPrefix, game.id);
    return {
      id: game.id,
      title: game.title,
      taskName,
      enabled: settings.enabled === true,
      mode: settings.mode === 'dry' ? 'dry' : 'real',
      schedule: settings.schedule,
      timeoutMin: settings.timeoutMin,
    };
  });
}

function makeLogger(ctx) {
  let base = null;
  try {
    const raw = ctx && ctx.logger;
    base = typeof raw === 'function' ? raw('game-daily') : raw;
  } catch {
    base = null;
  }
  const pick = (method) =>
    base && typeof base[method] === 'function' ? base[method].bind(base) : (typeof console[method] === 'function' ? console[method].bind(console) : () => {});
  return {
    log: pick('info'),
    info: pick('info'),
    warn: pick('warn'),
    error: pick('error'),
  };
}

/**
 * 汇报投递的落盘日志（`<stateDir>/automation/report.log`）。
 * Host logger 不落盘，出问题时无从查证——投递路径的每一步都写这里。
 */
function deliveryLog(stateDir, line) {
  try {
    const dir = path.join(stateDir, 'automation');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'report.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8');
  } catch {
    /* 日志写不进去不影响投递 */
  }
}

export function apply(ctx) {
  const env = pluginEnv();
  const store = new Store({ dir: env.stateDir, taskPrefix: env.taskPrefix });
  const ready = store.load().catch(() => store.get());
  const logger = makeLogger(ctx);

  const tasksView = () => {
    const names = GAMES.map((game) => taskNameFor(env.taskPrefix, game.id));
    const rows = queryTasks(names);
    // Get-ScheduledTask 很慢（本机 10s+）——只后台刷新缓存，请求路径上永不等待它。
    Promise.resolve()
      .then(() => refreshTaskInfo(names))
      .catch(() => {});
    const state = store.get();
    const out = {};
    for (const game of GAMES) {
      const name = taskNameFor(env.taskPrefix, game.id);
      const row = rows[name] || { exists: false };
      const settings = state.games[game.id];
      out[game.id] = {
        taskName: name,
        exists: row.exists === true,
        state: row.state || '',
        nextRunTime: row.nextRunTime || (row.exists === true ? computeNextRun(settings.schedule) : ''),
        lastRunTime: row.lastRunTime || '',
        lastTaskResult: row.lastTaskResult === undefined ? null : row.lastTaskResult,
        runLevel: row.runLevel || '',
        command: row.command || '',
        arguments: row.arguments || '',
        triggers: Array.isArray(row.triggers) ? row.triggers : [],
        actions: Array.isArray(row.actions) ? row.actions : [],
        startWhenAvailable: row.startWhenAvailable === true,
      };
    }
    return out;
  };

  const runsView = () => {
    const out = {};
    for (const game of GAMES) out[game.id] = listRuns(env.stateDir, game.id, { limit: 5 });
    return out;
  };

  const buildState = () => {
    const state = store.get();
    const tasks = tasksView();
    const runs = runsView();
    return {
      ok: true,
      now: new Date().toISOString(),
      version: readLocalVersion(),
      profile: env.profile,
      dev: { devMode: env.devMode, stateDir: env.stateDir, taskPrefix: env.taskPrefix, pluginRoot: PLUGIN_ROOT },
      skillsRoot: env.skillsRoot,
      automation: {
        ...state.automation,
        taskPrefix: env.taskPrefix,
        registerScript: registerScriptPath(env.stateDir),
        lastRegisterResult: readRegisterResult(env.stateDir),
      },
      ui: {
        lastGame: state.ui.lastGame,
        reportSessions: state.ui.reportSessions !== false,
        foregroundGuard: state.ui.foregroundGuard !== false,
      },
      games: GAMES.map((game) => {
        const settings = state.games[game.id];
        const task = tasks[game.id];
        const runner = readRunner(env.stateDir, game.id);
        return {
          id: game.id,
          title: game.title,
          engine: game.engine,
          canRun: game.canRun === true,
          note: game.note || '',
          enabled: settings.enabled === true,
          mode: settings.mode,
          schedule: settings.schedule,
          timeoutMin: settings.timeoutMin,
          gamePath: settings.gamePath,
          taskName: taskNameFor(env.taskPrefix, game.id),
          task,
          running: runner ? { running: runner.running, pid: runner.pid, runId: runner.runId, startedAt: runner.startedAt } : null,
          lastRunId: settings.lastRunId,
          lastStatus: settings.lastStatus,
          runs: runs[game.id] || [],
        };
      }),
      lastError: store.lastError || '',
      reportSessionIds: { ...(state.reportSessionIds || {}) },
    };
  };

  /** 把已经收尾、但还没记进 state 的运行算出来：记 state、发通知、按需开汇报会话。 */
  async function reconcile() {
    const state = store.get();
    const done = [];
    for (const game of GAMES) {
      if (!game.canRun) continue;
      const runs = listRuns(env.stateDir, game.id, { limit: 3 });
      for (const run of runs) {
        if (!run.hasReport || !run.summary) continue;
        const known = (state.runs[game.id] || []).find((row) => row.runId === run.runId);
        if (known) continue;
        const meta = readJsonSafe(metaPathOf(env.stateDir, game.id, run.runId)) || {};
        const summary = summarizeRun(run.runId, meta, { status: run.summary.status, mode: run.summary.mode });
        store.recordRun(game.id, { ...summary, mode: run.summary.mode || summary.mode });
        done.push({ game, run, summary });
      }
    }
    // 兜底：进程被外部终止（例如被计划任务强杀）时不会有 report.json，
    // 以前这种情况完全静默。这里补一条失败记录，让用户至少收到通知与历史。
    const now = Date.now();
    for (const game of GAMES) {
      if (!game.canRun) continue;
      if (isRunning(env.stateDir, game.id)) continue;
      const runs = listRuns(env.stateDir, game.id, { limit: 3 });
      for (const run of runs) {
        if (run.hasReport) continue;
        const meta = readJsonSafe(metaPathOf(env.stateDir, game.id, run.runId)) || {};
        const startedAt = Date.parse(meta.startedAt || '');
        if (!Number.isFinite(startedAt) || now - startedAt < 3 * 60 * 1000) continue;
        const known = (state.runs[game.id] || []).find((row) => row.runId === run.runId);
        if (known) continue;
        const summary = summarizeRun(run.runId, meta, { status: 'failed', mode: meta.mode || 'real' });
        store.recordRun(game.id, { ...summary, mode: meta.mode || summary.mode });
        done.push({
          game,
          run,
          summary,
          missingReport: true,
          report: {
            status: 'failed',
            notes: '进程被终止或崩溃，未写 report.json（可能超过执行时限或被手动结束）',
          },
        });
      }
    }
    for (const item of done) {
      const { game, run, summary } = item;
      const report = item.report || readReport(env.stateDir, game.id, run.runId) || {};
      const statusText = reportStatusText(summary.status);
      try {
        notify({
          stateDir: env.stateDir,
          title: `${game.title} 日常：${statusText}`,
          body: report.notes || `runId ${run.runId} · 详见设置页「游戏日常」`,
        });
      } catch {
        /* 通知失败不影响记账 */
      }
      if (store.get().ui.reportSessions !== false) {
        try {
          const prompt = buildReportPrompt({
            game,
            runId: run.runId,
            report,
            reportPath: path.join(run.dir, 'report.json'),
          });
          const title = `游戏日常 · ${game.title} 汇报`;
          const saved = store.get().reportSessionIds?.[game.id] || '';
          // 每个游戏只保留一个汇报会话：有旧的就往里追加，旧会话被删/不可用才新建。
          const alive = saved ? await sessionExists(ctx, saved) : false;
          deliveryLog(env.stateDir, `${game.id}/${run.runId} saved=${saved || '(空)'} alive=${alive}`);
          let result = saved && alive ? await appendSession(ctx, { sessionId: saved, prompt }) : null;
          if (!result || !result.ok) {
            if (saved) {
              const why = result ? result.error : alive ? '未知（未投递）' : '旧汇报会话已不存在（可能被删了）';
              deliveryLog(env.stateDir, `${game.id}/${run.runId} 复用失败：${why}；改为新建`);
              logger.log(`复用汇报会话失败（${saved}）：${why}；改为新建`);
            }
            result = await openSession(ctx, {
              title,
              cwd: env.stateDir,
              prompt,
            });
            deliveryLog(env.stateDir, `${game.id}/${run.runId} 新建会话 ok=${result.ok} id=${result.sessionId || ''} err=${result.error || ''}`);
          } else {
            deliveryLog(env.stateDir, `${game.id}/${run.runId} 已追加到 ${result.sessionId}`);
          }
          if (result.ok) {
            if (result.sessionId !== saved) {
              store.mutate((current) => {
                current.reportSessionIds = { ...(current.reportSessionIds || {}), [game.id]: result.sessionId };
              });
            }
          } else {
            logger.log(`汇报会话创建失败：${result.error}`);
            deliveryLog(env.stateDir, `${game.id}/${run.runId} 汇报会话创建失败：${result.error}`);
          }
        } catch (error) {
          logger.log(`汇报会话异常：${String((error && error.message) || error)}`);
          deliveryLog(env.stateDir, `${game.id}/${run.runId} 汇报会话异常：${String((error && error.message) || error)}`);
        }
      }
      store.mutate((current) => {
        const list = current.runs[game.id] || [];
        const row = list.find((entry) => entry.runId === run.runId);
        if (row) row.delivered = true;
      });
    }

    const result = readRegisterResult(env.stateDir);
    if (result && typeof result.at === 'string' && result.at !== store.get().automation.registeredAt) {
      store.mutate((current) => {
        current.automation.registeredAt = result.at;
        current.automation.tasksRegistered = result.ok === true;
        current.automation.lastResult = result;
      });
    }
    return done.length;
  }

  function reportStatusText(status) {
    return (
      {
        success: '已完成',
        partial: '部分完成',
        failed: '失败',
        aborted: '已中止',
        timeout: '超时',
        unknown: '状态未知',
      }[status] || '状态未知'
    );
  }

  const routes = {
    'GET /state': async () => {
      await ready;
      return buildState();
    },

    'GET /probe': async (req, url) => {
      await ready;
      const raw = String(url.searchParams.get('games') || '').trim();
      const ids = raw ? raw.split(',').map((x) => x.trim()).filter((id) => GAME_IDS.includes(id)) : GAME_IDS;
      const probe = probeDependencies(ids.length ? ids : GAME_IDS, { stateDir: env.stateDir });
      return { ok: true, ...probe, games: ids, tasks: tasksView() };
    },

    'POST /ui': async (req) => {
      await ready;
      const body = await readBody(req);
      store.mutate((state) => {
        if (typeof body.lastGame === 'string' && GAME_IDS.includes(body.lastGame)) state.ui.lastGame = body.lastGame;
        if (typeof body.reportSessions === 'boolean') state.ui.reportSessions = body.reportSessions;
        if (typeof body.foregroundGuard === 'boolean') state.ui.foregroundGuard = body.foregroundGuard;
      });
      return { ok: true, ui: buildState().ui };
    },

    'POST /apply': async (req) => {
      await ready;
      const body = await readBody(req);
      const patch = sanitizeGamesPatch(body.games);
      store.mutate((state) => {
        for (const [gameId, values] of Object.entries(patch)) {
          const target = state.games[gameId];
          if (!target) continue;
          if (values.enabled !== undefined) target.enabled = values.enabled;
          if (values.mode) target.mode = values.mode;
          if (values.schedule) target.schedule = { ...target.schedule, ...values.schedule };
          if (values.timeoutMin !== undefined) target.timeoutMin = values.timeoutMin;
          if (values.gamePath !== undefined) target.gamePath = values.gamePath;
          target.taskName = taskNameFor(env.taskPrefix, gameId);
        }
      });
      const games = tasksConfigGames(store.get ? store : { get: () => store.state }, env);
      const scriptSync = ensureRegisterScript(env.stateDir);
      const configPath = writeTasksConfig(env.stateDir, {
        taskPrefix: env.taskPrefix,
        games,
        runnerScript: path.join(PLUGIN_ROOT, 'automation', 'run-headless.mjs'),
        scriptPath: registerScriptPath(env.stateDir),
        nodeExe: resolveNodeExe(),
        profile: env.headlessProfile,
        skillsRoot: env.skillsRoot,
      });
      const started = startRegistration({ stateDir: env.stateDir, dryRun: body.dryRun === true });
      // 原神启用时顺手补齐 bettergi-mcp（单文件，从独立仓库下载）并注册到当前 profile；失败不阻断排班。
      let bettergiMcp = null;
      let bettergiMcpRegistration = null;
      if (store.get().games.genshin?.enabled && !resolveBettergiMcp({ stateDir: env.stateDir })) {
        bettergiMcp = await fetchBettergiMcp({ stateDir: env.stateDir });
        if (bettergiMcp.ok) {
          store.mutate((state) => {
            state.deps = { ...(state.deps || {}), bettergiMcpPath: bettergiMcp.path };
          });
        }
      }
      if (store.get().games.genshin?.enabled) {
        const mcpScript = resolveBettergiMcp({ stateDir: env.stateDir });
        if (mcpScript) {
          bettergiMcpRegistration = registerBettergiMcp({ profile: env.profile, scriptPath: mcpScript, home: env.home });
        }
      }
      return {
        ok: started.ok !== false,
        applied: Object.keys(patch),
        dryRun: body.dryRun === true,
        tasksConfig: configPath,
        scriptSync,
        registration: started,
        bettergiMcp,
        bettergiMcpRegistration,
        note: body.dryRun === true
          ? '已写入排班并做了注册预演（未真正创建计划任务）。'
          : started.ok
            ? `已写入排班并开始注册计划任务；需要管理员权限时会弹一次 UAC，稍后刷新看结果。${bettergiMcp && bettergiMcp.ok ? ' 已顺带下载 bettergi-mcp。' : ''}${bettergiMcpRegistration && bettergiMcpRegistration.changed ? ' 已注册 bettergi MCP（重启 DSH 后生效）。' : ''}`
            : started.error,
      };
    },

    'POST /disable': async () => {
      await ready;
      store.mutate((state) => {
        for (const game of GAMES) state.games[game.id].enabled = false;
        state.automation.tasksRegistered = false;
      });
      ensureRegisterScript(env.stateDir);
      const started = startRegistration({ stateDir: env.stateDir, removeAll: true });
      return { ok: started.ok !== false, registration: started };
    },

    'POST /run': async (req) => {
      await ready;
      const body = await readBody(req);
      const gameId = body.game;
      if (!GAME_IDS.includes(gameId)) return { ok: false, error: `未知游戏：${gameId}` };
      const game = gameById(gameId);
      if (!game.canRun) return { ok: false, error: `${game.title} 目前不支持自动代理` };
      const settings = store.get().games[gameId];
      const mode = body.mode === 'dry' || body.mode === 'real' ? body.mode : settings.mode;
      const started = await startRun({
        gameId,
        mode,
        stateDir: env.stateDir,
        profile: env.headlessProfile,
        trigger: body.trigger === 'schedule' ? 'schedule' : 'manual',
        skillsRoot: env.skillsRoot,
        timeoutMin: settings.timeoutMin,
        guard: store.get().ui.foregroundGuard !== false,
      });
      if (!started.ok) return { ok: false, error: started.error };
      store.mutate((state) => {
        state.games[gameId].lastRunId = started.runId;
      });
      return { ok: true, runId: started.runId, pid: started.pid, runDir: started.runDir };
    },

    'POST /stop': async (req) => {
      await ready;
      const body = await readBody(req);
      const gameId = body.game;
      if (!GAME_IDS.includes(gameId)) return { ok: false, error: `未知游戏：${gameId}` };
      return stopRun({ stateDir: env.stateDir, gameId });
    },

    'POST /run-task': async (req) => {
      await ready;
      const body = await readBody(req);
      const gameId = body.game;
      if (!GAME_IDS.includes(gameId)) return { ok: false, error: `未知游戏：${gameId}` };
      const taskName = taskNameFor(env.taskPrefix, gameId);
      const result = await startTask(taskName);
      return { ok: result.ok === true, taskName, ...result };
    },

    'POST /install': async (req) => {
      await ready;
      const body = await readBody(req);
      // 纯下载/安装类动作不需要开会话：直接从 GitHub 取（技能 zip / MCP 单文件）。
      if (body.action === 'install-bettergi-skill') {
        const installed = await installSkill('bettergi-control', { root: env.skillsRoot });
        return {
          ok: installed.ok === true,
          action: body.action,
          skill: installed,
          note: installed.ok
            ? `bettergi-control 已安装到 ${installed.path}${installed.scripts ? `（${installed.scripts} 个脚本）` : ''}${
                installed.source === 'bundled' ? '，来自插件自带副本（未联网）' : '，来自 GitHub'
              }。`
            : installed.error,
        };
      }
      if (body.action === 'install-game-daily-skills' || body.action === 'install-skills') {
        // 崩三 / 星铁技能族：game-daily（公共层）+ game-daily-hi + game-daily-sr 共用一个仓库 zip。
        // 三套只下载一次，装完立刻跑 coverage 自检（模板/锚点/变体是否齐）。
        const group = await installSkillGroup(['game-daily', 'game-daily-hi', 'game-daily-sr'], {
          root: env.skillsRoot,
        });
        const done = (group.results || []).filter((item) => item.ok === true);
        const failed = (group.results || []).filter((item) => item.ok !== true);
        const parts = [];
        if (done.length) {
          parts.push(
            `已安装 ${done.map((item) => `${item.name}（${item.files} 文件，来自${item.source === 'bundled' ? '插件自带副本' : ' GitHub'}）`).join('、')}`
          );
        }
        if (failed.length) parts.push(`失败：${failed.map((item) => `${item.name}：${item.error}`).join('；')}`);
        const coverage = runCoverage(env.skillsRoot, ['game-daily-hi', 'game-daily-sr']);
        if (coverage.length) parts.push(coverage.join('；'));
        return {
          ok: group.ok === true,
          action: body.action,
          group,
          coverage,
          note: parts.join('；') || '没有安装任何技能',
        };
      }
      if (body.action === 'start-zzz-server') {
        const result = await ensureZzzServer({ timeoutSeconds: 45 });
        return {
          ok: result.ok === true,
          action: body.action,
          server: result,
          note: result.ok
            ? `一条龙后端已就绪（${result.alreadyRunning ? '本来就在跑' : '刚刚启动'}）`
            : `启动一条龙后端失败：${result.error || (result.script && result.script.error) || '未知原因'}`,
        };
      }
      if (body.action === 'install-zzz-od') {
        // 一键安装一条龙：clone（或 zip）+ uv sync + 基础配置；默认落在 D 盘。
        // 这一步可能跑几分钟，面板会一直显示「处理中…」。
        const installed = await installZzzOneDragon();
        if (installed.ok) {
          store.mutate((state) => {
            state.deps = { ...(state.deps || {}), zzzRoot: installed.root };
          });
        }
        return {
          ok: installed.ok === true,
          action: body.action,
          install: installed,
          note: installed.ok
            ? `一条龙已安装到 ${installed.root}${installed.alreadyInstalled ? '（本来就已安装）' : ''}。下一步：点「启动一条龙后端」。`
            : `安装一条龙失败：${installed.error || '请查看安装步骤里的输出'}`,
        };
      }
      if (body.action === 'install-bettergi-mcp' || body.action === 'fix-bettergi-mcp') {
        let fetched = null;
        // 插件自带 tools/bettergi-mcp/bettergi-mcp.mjs：正常情况下直接注册，不联网。
        // 只有自带副本缺失（安装不完整）时才去 GitHub 取单文件兜底。
        if (!resolveBettergiMcp({ stateDir: env.stateDir })) {
          fetched = await fetchBettergiMcp({ stateDir: env.stateDir });
          if (fetched.ok) {
            store.mutate((state) => {
              state.deps = { ...(state.deps || {}), bettergiMcpPath: fetched.path };
            });
          }
        }
        const script = resolveBettergiMcp({ stateDir: env.stateDir });
        let registered = { ok: false, error: '没找到 bettergi-mcp 脚本（插件自带副本缺失，且下载失败）' };
        if (script) registered = registerBettergiMcp({ profile: env.profile, scriptPath: script, home: env.home });
        const parts = [];
        if (fetched && fetched.ok) parts.push(`已从 GitHub 补下 bettergi-mcp（${Math.round(fetched.bytes / 1024)} KB）`);
        else if (!fetched && script) parts.push('使用插件自带 bettergi-mcp（未联网）');
        if (registered.ok) {
          parts.push(registered.changed ? `已写入 ${registered.path}，重启 DSH 后生效` : '当前 profile 已注册 bettergi MCP');
        } else {
          parts.push(registered.error || '注册失败');
        }
        return {
          ok: (fetched ? fetched.ok === true : true) && registered.ok === true,
          action: body.action,
          fetched,
          registered,
          script,
          restartRequired: registered.changed === true,
          note: parts.join('；'),
        };
      }
      const gameId = GAME_IDS.includes(body.game) ? body.game : '';
      const prompt = body.prompt || buildInstallPrompt({
        action: body.action || '',
        gameId,
        checkId: body.checkId || '',
        checkDetail: body.checkDetail || '',
      });
      const title = body.title || '游戏日常 · 依赖修复';
      const result = await openSession(ctx, { prompt, title, cwd: env.stateDir });
      return { ok: result.ok === true, sessionId: result.sessionId || '', error: result.error };
    },

    'GET /runs': async (req, url) => {
      await ready;
      const gameId = url.searchParams.get('game');
      if (gameId && GAME_IDS.includes(gameId)) return { ok: true, game: gameId, runs: listRuns(env.stateDir, gameId, { limit: 20 }) };
      const out = {};
      for (const game of GAMES) out[game.id] = listRuns(env.stateDir, game.id, { limit: 10 });
      return { ok: true, runs: out };
    },

    'GET /run': async (req, url) => {
      await ready;
      const gameId = url.searchParams.get('game');
      const runId = url.searchParams.get('runId');
      if (!GAME_IDS.includes(gameId) || !runId || !/^[\w-]{4,40}$/.test(runId)) {
        return { ok: false, error: '参数不合法' };
      }
      const report = readReport(env.stateDir, gameId, runId);
      const meta = readJsonSafe(metaPathOf(env.stateDir, gameId, runId));
      const dir = path.join(env.stateDir, 'runs', gameId, runId);
      let stdoutTail = '';
      try {
        stdoutTail = fs.readFileSync(path.join(dir, 'stdout.log'), 'utf8').split('\n').slice(-120).join('\n');
      } catch {
        stdoutTail = '';
      }
      return { ok: true, game: gameId, runId, dir, report, meta, stdoutTail };
    },

    'GET /update': async (req, url) => {
      await ready;
      const force = url.searchParams.get('force') === '1' || url.searchParams.get('force') === 'true';
      return checkForUpdate({ force });
    },

    'POST /update': async () => {
      await ready;
      const result = await applyUpdate({ pluginRoot: PLUGIN_ROOT });
      logger.log(`更新插件：${result.ok ? '成功' : '失败'} ${result.from || ''}→${result.to || ''}${result.error ? ` (${result.error})` : ''}`);
      return result;
    },

    'POST /reconcile': async () => {
      await ready;
      const count = await reconcile();
      return { ok: true, reconciled: count };
    },
  };

  const webServer = ctx.webServer || null;
  if (webServer && typeof webServer.register === 'function') {
    ctx.effect(
      () =>
        webServer.register({
          kind: 'prefix',
          path: ROUTE_PREFIX,
          handler: async (req, res) => {
            const url = new URL(req.url, 'http://127.0.0.1');
            const sub = url.pathname.slice(ROUTE_PREFIX.length) || '/';
            const key = `${req.method} ${sub}`;
            const route = routes[key];
            try {
              if (!route) {
                sendJson(res, 404, { ok: false, error: `未知接口：${key}` });
                return;
              }
              const value = await route(req, url);
              sendJson(res, value && value.ok === false ? 400 : 200, value);
            } catch (error) {
              sendJson(res, 500, { ok: false, error: String((error && error.message) || error) });
            }
          },
        }),
      'game-daily: /api/game-daily 路由'
    );
  } else {
    logger.log('webServer 不可用：设置页将拿不到数据');
  }

  ctx.effect(() => {
    const timer = setInterval(() => {
      // 定时器回调必须自己兜住所有异常，否则会把宿主带走。
      Promise.resolve()
        .then(() => ready)
        .then(() => reconcile())
        .catch((error) => logger.log(`reconcile 失败：${String((error && error.message) || error)}`));
    }, RECONCILE_MS);
    const kick = setTimeout(() => {
      Promise.resolve().then(() => ready).then(() => reconcile()).catch(() => {});
    }, 4000);
    return () => {
      clearInterval(timer);
      clearTimeout(kick);
    };
  }, 'game-daily: 运行收尾轮询');

  if (env.devMode) logger.log(`dev 模式：stateDir=${env.stateDir} taskPrefix=${env.taskPrefix}`);
  logger.log(`game-daily 已加载（state=${env.stateDir}，tasks=${env.taskPrefix}*）`);
}

export default { name, inject, apply };
