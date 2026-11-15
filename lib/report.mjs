// 运行记录与报告：报告由 headless 那一轮的 agent 写，runner 只负责兜底。
import fs from 'node:fs';
import path from 'node:path';

export const REPORT_SCHEMA_VERSION = 1;

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 本地时间可读的 runId：20261024-013245 */
export function newRunId(date = new Date()) {
  const d = date;
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

export function runsRoot(stateDir) {
  return path.join(stateDir, 'runs');
}

export function gameRunsDir(stateDir, gameId) {
  return path.join(runsRoot(stateDir), gameId);
}

export function runDirOf(stateDir, gameId, runId) {
  return path.join(gameRunsDir(stateDir, gameId), runId);
}

export function reportPathOf(stateDir, gameId, runId) {
  return path.join(runDirOf(stateDir, gameId, runId), 'report.json');
}

export function metaPathOf(stateDir, gameId, runId) {
  return path.join(runDirOf(stateDir, gameId, runId), 'meta.json');
}

export function stdoutPathOf(stateDir, gameId, runId) {
  return path.join(runDirOf(stateDir, gameId, runId), 'stdout.log');
}

export function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

/** 从 report 提炼进 state 的摘要（缺字段就老实留空）。 */
export function summaryOf(report) {
  if (!report || typeof report !== 'object') return null;
  const steps = Array.isArray(report.steps) ? report.steps : [];
  const okSteps = steps.filter((s) => s && s.ok === true).length;
  return {
    status: typeof report.status === 'string' ? report.status : 'unknown',
    mode: typeof report.mode === 'string' ? report.mode : '',
    startedAt: typeof report.startedAt === 'string' ? report.startedAt : '',
    endedAt: typeof report.endedAt === 'string' ? report.endedAt : '',
    steps: { total: steps.length, ok: okSteps },
    notes: typeof report.notes === 'string' ? report.notes.slice(0, 500) : '',
  };
}

export function readReport(stateDir, gameId, runId) {
  return readJsonSafe(reportPathOf(stateDir, gameId, runId));
}

/** 列出某游戏的历史运行（新→旧），只读文件系统，不动 state。 */
export function listRuns(stateDir, gameId, { limit = 20 } = {}) {
  const dir = gameRunsDir(stateDir, gameId);
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
  names.sort().reverse();
  return names.slice(0, limit).map((runId) => {
    const meta = readJsonSafe(metaPathOf(stateDir, gameId, runId)) || {};
    const report = readJsonSafe(reportPathOf(stateDir, gameId, runId));
    return {
      runId,
      dir: runDirOf(stateDir, gameId, runId),
      meta,
      hasReport: Boolean(report),
      summary: summaryOf(report),
    };
  });
}

export function listAllRuns(stateDir, gameIds, { limitPerGame = 5 } = {}) {
  const out = {};
  for (const id of gameIds) out[id] = listRuns(stateDir, id, { limit: limitPerGame });
  return out;
}
