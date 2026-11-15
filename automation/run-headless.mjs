#!/usr/bin/env node
// 计划任务入口：起一轮 headless 日常，等它跑完，读出报告后决定任务退出码。
// 参数：--game <id> --state-dir <dir> [--profile headless] [--mode real|dry] [--timeout-min 120] [--skills-root <dir>]
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startRun, readRunner, isRunning, stopRun } from '../lib/runner.mjs';
import { readReport, reportPathOf, runDirOf, readJsonSafe, writeJson } from '../lib/report.mjs';
import { gameById } from '../lib/games.mjs';

/** 读 state.json 里的插件级 UI 开关（前台守护）与该游戏的超时设置。 */
function readPluginState(stateDir) {
  const raw = readJsonSafe(path.join(stateDir, 'state.json'));
  return raw && typeof raw === 'object' ? raw : {};
}

function parseArgs(argv) {
  const out = { mode: 'real', profile: 'headless', timeoutMin: 120 };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--game') out.game = argv[++i];
    else if (token === '--state-dir') out.stateDir = argv[++i];
    else if (token === '--profile') out.profile = argv[++i];
    else if (token === '--mode') out.mode = argv[++i];
    else if (token === '--timeout-min') out.timeoutMin = Number(argv[++i]) || 120;
    else if (token === '--skills-root') out.skillsRoot = argv[++i];
  }
  return out;
}

function defaultSkillsRoot() {
  return process.env.DSH_SKILLS_ROOT || path.join(os.homedir(), '.agents', 'skills');
}

function log(stateDir, text) {
  const line = `[${new Date().toISOString()}] ${text}\n`;
  process.stdout.write(line);
  try {
    fs.mkdirSync(path.join(stateDir, 'automation'), { recursive: true });
    fs.appendFileSync(path.join(stateDir, 'automation', 'run-headless.log'), line, 'utf8');
  } catch {
    /* ignore */
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.game || !args.stateDir) {
    console.error('usage: node run-headless.mjs --game <id> --state-dir <dir>');
    process.exit(2);
  }
  const stateDir = path.resolve(args.stateDir);
  const game = gameById(args.game);
  if (!game) {
    console.error(`未知游戏：${args.game}`);
    process.exit(2);
  }
  log(stateDir, `scheduled run start game=${args.game} mode=${args.mode} profile=${args.profile}`);
  const pluginState = readPluginState(stateDir);
  const guard = !pluginState.ui || pluginState.ui.foregroundGuard !== false;
  const gameState = pluginState.games && pluginState.games[args.game] ? pluginState.games[args.game] : {};
  const timeoutMin = Number.isFinite(Number(gameState.timeoutMin)) ? Number(gameState.timeoutMin) : args.timeoutMin;
  log(stateDir, `foreground guard=${guard ? 'on' : 'off'} timeoutMin=${timeoutMin}`);
  const started = await startRun({
    gameId: args.game,
    mode: args.mode,
    stateDir,
    profile: args.profile,
    trigger: 'schedule',
    skillsRoot: args.skillsRoot || defaultSkillsRoot(),
    timeoutMin,
    guard,
  });
  if (!started.ok) {
    log(stateDir, `start failed: ${started.error}`);
    process.exit(1);
  }
  log(stateDir, `headless spawned pid=${started.pid} runId=${started.runId}`);

  // 看门狗预算：比计划任务的执行时限少 5 分钟。到点由插件自己收尾（停 headless、
  // 写兜底报告），而不是等 Windows 把整个进程树杀掉——那样连报告都不会留下。
  const budgetMin = Math.max(5, Math.round(timeoutMin) - 5);
  const deadline = Date.now() + budgetMin * 60 * 1000;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  while (Date.now() < deadline) {
    await sleep(5000);
    if (!isRunning(stateDir, args.game)) break;
  }
  if (isRunning(stateDir, args.game)) {
    log(stateDir, `watchdog: ${budgetMin}min budget reached (timeoutMin=${timeoutMin}), stopping run`);
    try {
      stopRun({ stateDir, gameId: args.game });
    } catch (error) {
      log(stateDir, `watchdog: stopRun failed: ${String((error && error.message) || error)}`);
    }
    const stopDeadline = Date.now() + 60 * 1000;
    while (isRunning(stateDir, args.game) && Date.now() < stopDeadline) await sleep(2000);
    if (!readReport(stateDir, args.game, started.runId)) {
      try {
        writeJson(reportPathOf(stateDir, args.game, started.runId), {
          schemaVersion: 1,
          status: 'timeout',
          mode: args.mode,
          runId: started.runId,
          game: args.game,
          startedAt: new Date(Date.now() - budgetMin * 60 * 1000).toISOString(),
          endedAt: new Date().toISOString(),
          steps: [],
          evidence: [`watchdog=${budgetMin}min`, `timeoutMin=${timeoutMin}`],
          notes: `超过看门狗预算 ${budgetMin} 分钟，插件主动停止；未拿到 headless 报告。可调大排班超时，或检查是否有窗口频繁抢焦点导致反复暂停。`,
          generatedBy: 'run-headless-watchdog',
        });
      } catch {
        /* ignore */
      }
    }
    log(stateDir, `watchdog: stopped after ${budgetMin}min, report written`);
    process.exit(3);
  }
  const report = readReport(stateDir, args.game, started.runId);
  const reportFile = reportPathOf(stateDir, args.game, started.runId);
  if (!report) {
    log(stateDir, `no report at ${reportFile} (run dir ${runDirOf(stateDir, args.game, started.runId)})`);
    process.exit(1);
  }
  log(stateDir, `report status=${report.status || 'unknown'} file=${reportFile}`);
  process.exit(report.status === 'failed' ? 1 : 0);
}

main().catch((error) => {
  try {
    console.error(error && error.stack ? error.stack : String(error));
  } catch {
    /* ignore */
  }
  process.exit(1);
});
