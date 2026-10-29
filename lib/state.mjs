// state.json：唯一配置真源。Atomic write（tmp → fsync → rename），坏文件先改名再回落默认值。
import fs from 'node:fs';
import path from 'node:path';
import { GAMES, GAME_IDS, isWeekdays, taskNameFor } from './games.mjs';

export const SCHEMA_VERSION = 1;
export const RUN_HISTORY_LIMIT = 10;

const MODES = new Set(['real', 'dry']);
const STATUSES = new Set(['success', 'partial', 'failed', 'aborted', 'timeout', 'unknown']);

export function defaultGameState(game) {
  return {
    enabled: false,
    mode: 'real',
    schedule: { time: game.defaultTime || '09:00', weekdays: 'daily', catchUp: true },
    timeoutMin: Number(game.defaultTimeoutMin) > 0 ? Number(game.defaultTimeoutMin) : 90,
    gamePath: '',
    taskName: '',
    lastRunId: '',
    lastStatus: '',
  };
}

export function defaultState(taskPrefix = 'game-daily-') {
  const games = {};
  for (const game of GAMES) games[game.id] = defaultGameState(game);
  return {
    schemaVersion: SCHEMA_VERSION,
    ui: { lastGame: 'genshin', reportSessions: true, foregroundGuard: true },
    automation: { tasksRegistered: false, registeredAt: '', taskPrefix },
    games,
    runs: {},
    // 每个游戏固定的汇报会话（游戏 id → sessionId）。有就复用，会话被删了再新建。
    reportSessionIds: {},
  };
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function normalizeSchedule(raw, fallback) {
  const schedule = { ...fallback, ...(raw && typeof raw === 'object' ? raw : {}) };
  if (!TIME_RE.test(String(schedule.time || ''))) schedule.time = fallback.time;
  schedule.weekdays = schedule.weekdays === 'daily' || isWeekdays(schedule.weekdays) ? schedule.weekdays : 'daily';
  schedule.catchUp = schedule.catchUp !== false;
  return schedule;
}

function normalizeRun(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const runId = typeof raw.runId === 'string' && raw.runId ? raw.runId : '';
  if (!runId) return null;
  return {
    runId,
    trigger: typeof raw.trigger === 'string' ? raw.trigger : 'manual',
    mode: MODES.has(raw.mode) ? raw.mode : 'real',
    status: STATUSES.has(raw.status) ? raw.status : 'unknown',
    startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : '',
    endedAt: typeof raw.endedAt === 'string' ? raw.endedAt : '',
    delivered: raw.delivered === true,
  };
}

/** 任意输入 → 合法 state（不抛异常；未知字段丢弃，缺失字段补默认）。 */
export function normalizeState(raw, taskPrefix = 'game-daily-') {
  const base = defaultState(taskPrefix);
  if (!raw || typeof raw !== 'object') return base;
  const state = base;
  state.schemaVersion = SCHEMA_VERSION;
  const lastGame = raw.ui && typeof raw.ui.lastGame === 'string' ? raw.ui.lastGame : '';
  if (GAME_IDS.includes(lastGame)) state.ui.lastGame = lastGame;
  if (raw.ui && typeof raw.ui.reportSessions === 'boolean') state.ui.reportSessions = raw.ui.reportSessions;
  if (raw.ui && typeof raw.ui.foregroundGuard === 'boolean') state.ui.foregroundGuard = raw.ui.foregroundGuard;

  if (raw.automation && typeof raw.automation === 'object') {
    state.automation.tasksRegistered = raw.automation.tasksRegistered === true;
    state.automation.registeredAt = typeof raw.automation.registeredAt === 'string' ? raw.automation.registeredAt : '';
    if (typeof raw.automation.taskPrefix === 'string' && raw.automation.taskPrefix) {
      state.automation.taskPrefix = raw.automation.taskPrefix;
    }
  }

  const games = raw.games && typeof raw.games === 'object' ? raw.games : {};
  for (const game of GAMES) {
    const fallback = defaultGameState(game);
    const src = games[game.id] && typeof games[game.id] === 'object' ? games[game.id] : {};
    const target = { ...fallback };
    target.enabled = src.enabled === true;
    target.mode = MODES.has(src.mode) ? src.mode : fallback.mode;
    target.schedule = normalizeSchedule(src.schedule, fallback.schedule);
    const timeout = Number(src.timeoutMin);
    target.timeoutMin = Number.isFinite(timeout) ? Math.min(180, Math.max(5, Math.round(timeout))) : fallback.timeoutMin;
    target.gamePath = typeof src.gamePath === 'string' ? src.gamePath : '';
    target.taskName = typeof src.taskName === 'string' ? src.taskName : '';
    target.lastRunId = typeof src.lastRunId === 'string' ? src.lastRunId : '';
    target.lastStatus = STATUSES.has(src.lastStatus) ? src.lastStatus : '';
    state.games[game.id] = target;
  }

  const runs = raw.runs && typeof raw.runs === 'object' ? raw.runs : {};
  for (const gameId of GAME_IDS) {
    const list = Array.isArray(runs[gameId]) ? runs[gameId].map(normalizeRun).filter(Boolean) : [];
    list.sort((a, b) => String(b.startedAt || '').localeCompare(String(a.startedAt || '')));
    state.runs[gameId] = list.slice(0, RUN_HISTORY_LIMIT);
  }

  const pinned = raw.reportSessionIds && typeof raw.reportSessionIds === 'object' ? raw.reportSessionIds : {};
  for (const gameId of GAME_IDS) {
    const sessionId = pinned[gameId];
    if (typeof sessionId === 'string' && /^session-[\w-]+$/.test(sessionId)) {
      state.reportSessionIds[gameId] = sessionId;
    }
  }
  return state;
}

export function runStatusOf(reportStatus) {
  return STATUSES.has(reportStatus) ? reportStatus : 'unknown';
}

/** 从运行目录读回已完成运行的状态（供 reconcile 使用）。 */
export function summarizeRun(runId, meta, report) {
  return {
    runId,
    trigger: meta && typeof meta.trigger === 'string' ? meta.trigger : 'manual',
    mode: meta && MODES.has(meta.mode) ? meta.mode : 'real',
    status: runStatusOf(report && report.status),
    startedAt: (meta && meta.startedAt) || '',
    endedAt: (meta && meta.endedAt) || '',
  };
}

export class Store {
  constructor({ dir, taskPrefix = 'game-daily-' }) {
    this.dir = dir;
    this.file = path.join(dir, 'state.json');
    this.taskPrefix = taskPrefix;
    this.state = defaultState(taskPrefix);
    this.writeQueue = Promise.resolve();
  }

  async load() {
    fs.mkdirSync(this.dir, { recursive: true });
    try {
      const text = fs.readFileSync(this.file, 'utf8');
      this.state = normalizeState(JSON.parse(text), this.taskPrefix);
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        const bad = `${this.file}.bad-${Date.now()}`;
        try {
          fs.renameSync(this.file, bad);
          this.lastError = `state.json 无法解析，已改名为 ${path.basename(bad)}，本次使用默认设置。`;
        } catch {
          this.lastError = 'state.json 无法解析且改名失败，本次使用默认设置。';
        }
      }
      this.state = defaultState(this.taskPrefix);
      await this.save();
    }
    return this.state;
  }

  get() {
    return this.state;
  }

  game(gameId) {
    return this.state.games[gameId] || null;
  }

  /** 同步改 state 并落盘（串行化，避免并发写坏文件）。 */
  mutate(fn) {
    const result = fn(this.state);
    this.writeQueue = this.writeQueue.then(() => this.save()).catch(() => {});
    return result;
  }

  async save() {
    const text = `${JSON.stringify(this.state, null, 2)}\n`;
    const tmp = `${this.file}.tmp-${process.pid}`;
    const handle = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(handle, text, 'utf8');
      try {
        fs.fsyncSync(handle);
      } catch {
        /* 某些 FS 不支持 fsync，降级即可 */
      }
    } finally {
      fs.closeSync(handle);
    }
    fs.renameSync(tmp, this.file);
  }

  /** 记录一次运行的摘要（最近的在前，最多 RUN_HISTORY_LIMIT 条）。 */
  recordRun(gameId, summary) {
    this.mutate((state) => {
      const list = state.runs[gameId] || (state.runs[gameId] = []);
      const index = list.findIndex((item) => item.runId === summary.runId);
      const row = { ...(index >= 0 ? list[index] : {}), ...summary };
      if (index >= 0) list.splice(index, 1);
      list.unshift(row);
      state.runs[gameId] = list.slice(0, RUN_HISTORY_LIMIT);
      const game = state.games[gameId];
      if (game) {
        game.lastRunId = row.runId;
        game.lastStatus = row.status;
      }
    });
  }
}

export { taskNameFor };
