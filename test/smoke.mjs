// 冒烟测试：不碰游戏、不建计划任务，只验证模块能加载、纯函数与读操作正常。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { GAMES, GAME_IDS, gameById, taskNameFor, isWeekdays } from '../lib/games.mjs';
import { defaultState, defaultGameState, normalizeState, Store, summarizeRun, runStatusOf } from '../lib/state.mjs';
import { probeDependencies, resolveDsh } from '../lib/deps.mjs';
import { buildRunPrompt, buildInstallPrompt, buildReportPrompt } from '../lib/prompt.mjs';
import { newRunId, summaryOf, listRuns, writeJson, metaPathOf, reportPathOf } from '../lib/report.mjs';
import { queryTasks, taskStatus, refreshTaskInfo, readTaskDefinition, computeNextRun } from '../lib/tasks.mjs';
import { guardScriptPath, guardStatus, aliveFromError, readRunner, ensureOverlay } from '../lib/runner.mjs';
import { resolveBettergiMcp, vendorPath, bundledPath } from '../lib/bettergi-mcp.mjs';
import { SKILL_REPOS, inspectSkill, skillInstallPath, installSkill, bundledSkillPath, installSkillGroup, runCoverage } from '../lib/skills.mjs';
import { registerBettergiMcp, hasBettergiMcpRow, bettergiMcpPatchPath } from '../lib/mcp-register.mjs';
import { GAME_PROCESSES, runningGames, closeGame } from '../lib/gameproc.mjs';
import { inspectZzzInstall, zzzHealthSync, zzzBaseUrl, zzzInstallTargets, ensureZzzConfigs, detectZzzGamePath, inspectZzzInstallRoot, ZZZ_DISC_MISSION_TYPES, defaultZzzFallbackConfig, zzzFallbackConfig, findZzzChargePlanPath, buildZzzChargePlanScript } from '../lib/zzz.mjs';
import { compareVersions, readLocalVersion, readPackage } from '../lib/update.mjs';
import { appendSession } from '../lib/install.mjs';
import { inspectM7aInstallRoot, extractJson, m7aFacts, DEFAULT_M7A_TASK, exitMeaning } from '../lib/m7a.mjs';

const results = [];
// 后台刷新一次任务信息，验证异步 PowerShell 路径（真实环境里这一步由请求触发、不阻塞 UI）。
const refreshed = await refreshTaskInfo(['BetterGI 日常一条龙']).catch(() => false);
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: String((error && error.stack) || error) });
  }
}

async function checkAsync(name, fn) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail });
  } catch (error) {
    results.push({ name, ok: false, detail: String((error && error.stack) || error) });
  }
}

check('games registry', () => {
  if (GAMES.length !== 4) throw new Error(`期望 4 个游戏，实际 ${GAMES.length}`);
  if (!GAME_IDS.includes('genshin')) throw new Error('缺 genshin');
  if (taskNameFor('game-daily-', 'hi') !== 'game-daily-hi') throw new Error('taskNameFor 不对');
  if (!isWeekdays([1, 3, 7]) || isWeekdays([0, 2]) || isWeekdays([])) throw new Error('isWeekdays 判定不对');
  return GAMES.map((g) => `${g.id}:${g.engine}:${g.defaultTime}`).join(' ');
});

check('state normalize', () => {
  const bad = normalizeState({ ui: { lastGame: 'nope' }, games: { hi: { enabled: 'yes', timeoutMin: 999, schedule: { time: '25:99' } } } });
  if (bad.ui.lastGame !== 'genshin') throw new Error('非法 lastGame 未回落');
  if (bad.games.hi.enabled !== false) throw new Error('enabled 非 true 应视为 false');
  if (bad.games.hi.timeoutMin !== 180) throw new Error(`timeout 999 未夹到 180：${bad.games.hi.timeoutMin}`);
  const nan = normalizeState({ games: { hi: { timeoutMin: 'abc' } } });
  const hiDefault = defaultGameState(GAMES.find((g) => g.id === 'hi')).timeoutMin;
  if (nan.games.hi.timeoutMin !== hiDefault) {
    throw new Error(`非数字 timeout 未回落到该游戏默认值 ${hiDefault}：${nan.games.hi.timeoutMin}`);
  }
  const genDefault = defaultGameState(GAMES.find((g) => g.id === 'genshin')).timeoutMin;
  if (genDefault !== 150) throw new Error(`原神默认超时应为 150：${genDefault}`);
  if (bad.games.hi.schedule.time !== '10:00') throw new Error(`非法时间未回落默认：${bad.games.hi.schedule.time}`);
  const good = normalizeState({ games: { sr: { enabled: true, timeoutMin: 200, schedule: { time: '07:30', weekdays: [6, 7], catchUp: false } } } });
  if (good.games.sr.timeoutMin !== 180) throw new Error('timeout 未夹到 180');
  if (!isWeekdays(good.games.sr.schedule.weekdays)) throw new Error('weekdays 丢失');
  if (good.games.sr.schedule.catchUp !== false) throw new Error('catchUp 丢失');
  return 'fallbacks + clamps ok';
});

results.push({ name: 'store roundtrip', ok: false, detail: 'pending' });

check('report helpers', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-report-'));
  const runId = newRunId(new Date('2026-10-24T01:23:45'));
  if (runId !== '20261024-012345') throw new Error(`runId 格式错：${runId}`);
  const report = { schemaVersion: 1, status: 'partial', mode: 'real', startedAt: 't0', endedAt: 't1', steps: [{ id: '1', name: 'a', ok: true }, { id: '2', name: 'b', ok: false }], notes: 'note' };
  writeJson(reportPathOf(dir, 'hi', runId), report);
  writeJson(metaPathOf(dir, 'hi', runId), { runId, trigger: 'schedule', mode: 'real', startedAt: 't0' });
  const runs = listRuns(dir, 'hi');
  if (runs.length !== 1 || !runs[0].hasReport) throw new Error('listRuns 未识别报告');
  const summary = summaryOf(report);
  if (summary.steps.ok !== 1 || summary.steps.total !== 2) throw new Error('summary 统计错');
  if (runStatusOf('weird') !== 'unknown') throw new Error('runStatusOf 应回落 unknown');
  const sum2 = summarizeRun(runId, { trigger: 'schedule', mode: 'real' }, { status: 'success' });
  if (sum2.status !== 'success' || sum2.trigger !== 'schedule') throw new Error('summarizeRun 错');
  fs.rmSync(dir, { recursive: true, force: true });
  return `${runId} report/list/summary ok`;
});

check('prompt builders', () => {
  const game = gameById('genshin');
  const p = buildRunPrompt({ game, mode: 'dry', runId: 'x', runDir: 'C:\\tmp\\x', reportPath: 'C:\\tmp\\x\\report.json', skillsRoot: 'C:\\skills', stateDir: 'C:\\state' });
  if (!p.includes('演练') || !p.includes('report.json')) throw new Error('run prompt 缺关键内容');
  if (p.length > 12000) throw new Error(`prompt 太长：${p.length}`);
  const g2 = buildInstallPrompt({ action: 'fix-headless-credentials', gameId: 'genshin', checkId: 'headless', checkDetail: '缺少 credentials' });
  if (!g2.includes('headless')) throw new Error('install prompt 缺上下文');
  const r = buildReportPrompt({ game, runId: 'x', report: { status: 'success', steps: [{ id: '1', name: '登录', ok: true }] }, reportPath: 'p' });
  if (!r.includes('登录')) throw new Error('report prompt 缺步骤');
  return `run=${p.length} install=${g2.length} report=${r.length}`;
});

let exitCode = 0;
Promise.resolve()
  .then(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-store-'));
    const store = new Store({ dir, taskPrefix: 'game-daily-test-' });
    await store.load();
    store.mutate((state) => {
      state.games.hi.enabled = true;
      state.games.hi.schedule.time = '06:15';
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const again = new Store({ dir, taskPrefix: 'game-daily-test-' });
    await again.load();
    if (again.get().games.hi.schedule.time !== '06:15') throw new Error('state 未持久化');
    again.recordRun('hi', { runId: 'r1', trigger: 'manual', mode: 'real', status: 'success', startedAt: '2026-10-24T01:00:00Z', endedAt: '2026-10-24T01:10:00Z' });
    if (again.get().runs.hi.length !== 1) throw new Error('recordRun 未写入');
    fs.rmSync(dir, { recursive: true, force: true });
    results[2].ok = true;
    results[2].detail = 'state.json 原子写 + 回读 ok';
  })
  .catch((error) => {
    if (results[2]) {
      results[2].ok = false;
      results[2].detail = String((error && error.stack) || error);
    }
  })
  .then(async () => {
    check('dsh resolve', () => {
      const dsh = resolveDsh();
      // GitHub-hosted runner 默认没有 dsh CLI：这属于环境差异，不算失败，只把结论写进 detail。
      if (!dsh) return '未安装 dsh CLI（CI 环境跳过）';
      return `${dsh.kind} ${dsh.bin}`;
    });
    check('dependencies probe', () => {
      const probe = probeDependencies(['hi', 'sr']);
      if (!Array.isArray(probe.checks) || probe.checks.length < 5) throw new Error('体检项太少');
      for (const item of probe.checks) {
        if (!item.id || !item.label || !item.status) throw new Error(`体检项字段缺失：${JSON.stringify(item)}`);
      }
      const blockers = probe.checks.filter((c) => c.blocker).length;
      return `checks=${probe.checks.length} blockers=${blockers} ok=${probe.summary.ok}`;
    });
    check('scheduled task query', () => {
      const def = readTaskDefinition('BetterGI 日常一条龙');
      if (def.exists) {
        if (def.trigger && def.trigger.kind !== 'daily') throw new Error(`应为 daily 触发器：${JSON.stringify(def.trigger)}`);
        if (def.runLevel && def.runLevel !== 'HighestAvailable') throw new Error(`RunLevel 异常：${def.runLevel}`);
        if (def.command && !/powershell\.exe/i.test(def.command)) throw new Error(`命令异常：${def.command}`);
      }
      const next = computeNextRun({ time: '10:00', weekdays: [1, 3] }, new Date('2026-10-24T08:00:00+08:00'));
      if (!next) throw new Error('computeNextRun 未算出下次运行');
      const plain = taskStatus('绝对不存在的任务-gd-smoke');
      if (plain.exists !== false) throw new Error('不存在的任务应 exists=false');
      const row = taskStatus('BetterGI 日常一条龙');
      return row.exists ? `BetterGI 日常一条龙: ${row.state} next=${row.nextRunTime || '(后台刷新中)'}` : '未安装该任务（可接受）';
    });
    check('foreground guard asset', () => {
      const script = guardScriptPath();
      if (!fs.existsSync(script)) throw new Error(`缺前台守护脚本：${script}`);
      const head = fs.readFileSync(script).subarray(0, 3);
      if (!(head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf)) {
        throw new Error('keep-foreground.ps1 缺 BOM（PS 5.1 中文会乱码）');
      }
      const state = guardStatus('genshin');
      if (state.running) throw new Error('冒烟测试期间不该有守护进程');
      return 'keep-foreground.ps1 就绪（BOM ok）';
    });
    check('runner alive 判定（EPERM 视为存活）', () => {
      // 回归：Windows 上 Medium 宿主探测提权进程只会拿到 EPERM，
      // 早先被当成「进程不存在」，导致计划任务轮次被 reconcile 在 +3 分钟误判 failed。
      const eperm = Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      const esrch = Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      if (aliveFromError(eperm) !== true) throw new Error('EPERM 必须视为进程仍存活');
      if (aliveFromError(esrch) !== false) throw new Error('ESRCH 应视为进程不存在');
      if (aliveFromError(null) !== false) throw new Error('空错误应为假');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-alive-'));
      try {
        fs.mkdirSync(path.join(dir, 'automation'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'automation', 'runner-probe.pid'), JSON.stringify({ pid: process.pid }), 'utf8');
        const self = readRunner(dir, 'probe');
        if (!self || self.running !== true) throw new Error('当前进程应判为存活');
        if (readRunner(dir, 'nope') !== null) throw new Error('没有 pid 文件时应返回 null');
        return `EPERM→存活、ESRCH→不存在；本进程 pid=${process.pid} 判为 running`;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
    check('zzz one-dragon integration', () => {
      const zzz = gameById('zzz');
      if (!zzz) throw new Error('缺少绝区零注册项');
      if (zzz.engine !== 'zzz-od') throw new Error(`绝区零引擎应为 zzz-od：${zzz.engine}`);
      if (zzz.canRun !== true) throw new Error('绝区零应当可以运行');
      if (!zzz.defaultTime) throw new Error('绝区零缺少默认时间');
      const realMcp = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'tools', 'zzz-od-mcp', 'zzz-od-mcp.mjs');
      if (!fs.existsSync(realMcp)) throw new Error(`缺 zzz-od-mcp 脚本：${realMcp}`);
      const text = fs.readFileSync(realMcp, 'utf8');
      for (const tool of ['zzz_run_one_dragon', 'zzz_enter', 'zzz_wait', 'zzz_server']) {
        if (!text.includes(`'${tool}'`) && !text.includes(`"${tool}"`)) throw new Error(`MCP 缺工具：${tool}`);
      }
      const serverPs = path.join(path.dirname(realMcp), '..', '..', 'automation', 'zzz-server.ps1');
      if (!fs.existsSync(serverPs)) throw new Error(`缺 zzz-server.ps1：${serverPs}`);
      const bytes = fs.readFileSync(serverPs);
      const nonAscii = bytes.filter((b) => b > 127).length;
      if (nonAscii > 0) throw new Error(`zzz-server.ps1 含 ${nonAscii} 个非 ASCII 字节（PS 5.1 会读坏）`);
      const info = inspectZzzInstall();
      if (typeof info.ok !== 'boolean' || !info.root) throw new Error('inspectZzzInstall 返回值异常');
      const health = zzzHealthSync({ timeoutMs: 1500 });
      if (typeof health.ok !== 'boolean') throw new Error('zzzHealthSync 返回值异常');
      return `zzz:${zzz.engine}:${zzz.defaultTime} mcp ok, server ps ascii ok, health=${health.ok ? 'up' : 'down'} (${zzzBaseUrl()})`;
    });
    check('game process helpers', () => {
      const keys = Object.keys(GAME_PROCESSES);
      if (keys.length !== 4) throw new Error(`进程映射应为 4 个游戏：${keys.join(',')}`);
      const running = runningGames();
      for (const id of keys) {
        if (typeof running[id] !== 'boolean') throw new Error(`runningGames().${id} 不是布尔`);
      }
      // 只对「确认没在运行」的游戏做一次空关闭，验证 taskkill 的成功判定逻辑。
      if (running.zzz === false) {
        const closed = closeGame('zzz');
        if (!closed || closed.ok !== true) throw new Error(`closeGame 空调用应成功：${JSON.stringify(closed)}`);
        if (Array.isArray(closed.closed) && closed.closed.length) throw new Error('没运行却报告关掉了进程');
      }
      return keys.map((id) => `${id}:${running[id] ? 'running' : 'idle'}`).join(' ');
    });
    await checkAsync('skill install helpers', async () => {
      const spec = SKILL_REPOS['bettergi-control'];
      if (!spec || !/^https:\/\/codeload\.github\.com\//.test(spec.zip)) throw new Error('缺少 bettergi-control 的 zip 地址');
      if (!spec.minScripts || spec.minScripts < 10) throw new Error('脚本数下限不合理');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-skill-'));
      try {
        const info = inspectSkill(root, 'bettergi-control');
        if (info.installed) throw new Error('空目录不应判定已安装');
        if (skillInstallPath(root, 'bettergi-control') !== info.dir) throw new Error('skillInstallPath 与 inspectSkill 不一致');
        const missing = await installSkill('bettergi-control', { root: '' });
        if (missing.ok !== false || !missing.error) throw new Error('缺 root 应返回错误');
        return `zip ok, inspect ok, guard ok`;
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    check('mcp register', () => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-home-'));
      try {
        const dir = path.join(home, 'profiles', 'test');
        fs.mkdirSync(dir, { recursive: true });
        const file = bettergiMcpPatchPath('test', home);
        fs.writeFileSync(file, '- insert: []\n', 'utf8');
        const fake = path.join(home, 'vendor', 'bettergi-mcp', 'bettergi-mcp.mjs');
        fs.mkdirSync(path.dirname(fake), { recursive: true });
        fs.writeFileSync(fake, '// stub\n', 'utf8');
        const first = registerBettergiMcp({ profile: 'test', scriptPath: fake, home });
        if (!first.ok || first.changed !== true) throw new Error(`首次注册应写入：${JSON.stringify(first)}`);
        const text = fs.readFileSync(file, 'utf8');
        if (!hasBettergiMcpRow(text)) throw new Error('写入后回读缺 bettergi MCP 行');
        if (!/serverName: bettergi/.test(text) || !/command: node/.test(text)) throw new Error('补丁内容不完整');
        if (first.backup && !fs.existsSync(first.backup)) throw new Error('缺少备份文件');
        const second = registerBettergiMcp({ profile: 'test', scriptPath: fake, home });
        if (!second.ok || second.changed !== false) throw new Error('重复注册不应再写');
        return 'patch append + idempotent + backup ok';
      } finally {
        fs.rmSync(home, { recursive: true, force: true });
      }
    });
    check('task info refresh', () => {
      if (refreshed !== true) return '未刷新（无任务或 PowerShell 不可用，容忍）';
      const row = taskStatus('BetterGI 日常一条龙');
      if (row.exists && !row.nextRunTime && !row.lastRunTime) throw new Error('刷新后仍无下次/上次运行时间');
      return `next=${row.nextRunTime || '-'} last=${row.lastRunTime || '-'}`;
    });
    check('bettergi-mcp resolver', () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-bgmcp-'));
      const vendor = vendorPath(tmp);
      if (!vendor.endsWith(path.join('vendor', 'bettergi-mcp', 'bettergi-mcp.mjs'))) throw new Error(`vendor 路径异常：${vendor}`);
      fs.mkdirSync(path.dirname(vendor), { recursive: true });
      fs.writeFileSync(vendor, '// smoke placeholder\n', 'utf8');
      const savedEnv = process.env.DSH_GAME_DAILY_BETTERGI_MCP;
      delete process.env.DSH_GAME_DAILY_BETTERGI_MCP;
      try {
        const hit = resolveBettergiMcp({ stateDir: tmp });
        if (hit !== vendor) throw new Error(`应命中 vendor，实际：${hit}`);
        const standalone = path.join(tmp, 'standalone.mjs');
        fs.writeFileSync(standalone, '// env placeholder\n', 'utf8');
        process.env.DSH_GAME_DAILY_BETTERGI_MCP = standalone;
        const fromEnv = resolveBettergiMcp({ stateDir: tmp });
        if (fromEnv !== standalone) throw new Error(`env 应优先，实际：${fromEnv}`);
      } finally {
        if (savedEnv === undefined) delete process.env.DSH_GAME_DAILY_BETTERGI_MCP;
        else process.env.DSH_GAME_DAILY_BETTERGI_MCP = savedEnv;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      return 'vendor 优先 / env 覆盖 ok';
    });
    check('zzz install helpers', () => {
      const targets = zzzInstallTargets();
      if (!targets.length) throw new Error('没有安装目标候选');
      const systemRoot = `${String(process.env.SystemDrive || 'C:').replace(/\\+$/, '')}\\`.toLowerCase();
      for (const dir of targets) {
        if (path.parse(path.resolve(dir)).root.toLowerCase() === systemRoot) throw new Error(`候选里出现了系统盘：${dir}`);
      }
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-zzz-'));
      const savedGame = process.env.DSH_GAME_DAILY_ZZZ_GAME;
      try {
        if (inspectZzzInstallRoot(tmp).ok) throw new Error('空目录不应判定为已安装');
        const fakeGame = path.join(tmp, 'ZenlessZoneZero.exe');
        fs.writeFileSync(fakeGame, 'stub', 'utf8');
        process.env.DSH_GAME_DAILY_ZZZ_GAME = fakeGame;
        const cfg = ensureZzzConfigs(tmp);
        if (!fs.existsSync(path.join(cfg.dir, 'game.yml'))) throw new Error('缺少 game.yml');
        const account = fs.readFileSync(path.join(cfg.dir, 'game_account.yml'), 'utf8');
        if (!account.includes(fakeGame)) throw new Error('game_account.yml 没写入游戏路径');
        const detected = detectZzzGamePath(path.join(cfg.dir, 'game_account.yml'));
        if (detected !== fakeGame) throw new Error(`detectZzzGamePath 读不回：${detected}`);
        return `targets=${targets.length} config steps=${cfg.steps.length} ok`;
      } finally {
        if (savedGame === undefined) delete process.env.DSH_GAME_DAILY_ZZZ_GAME;
        else process.env.DSH_GAME_DAILY_ZZZ_GAME = savedGame;
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    });
    check('zzz charge-plan disc fallback', () => {
      if (!Array.isArray(ZZZ_DISC_MISSION_TYPES) || ZZZ_DISC_MISSION_TYPES.length !== 15) {
        throw new Error(`驱动盘副本类型应为 15 个：${ZZZ_DISC_MISSION_TYPES.length}`);
      }
      const names = new Set();
      for (const item of ZZZ_DISC_MISSION_TYPES) {
        if (!item.missionTypeName) throw new Error('副本类型缺 missionTypeName');
        if (!Array.isArray(item.discs) || item.discs.length !== 2) throw new Error(`驱动盘对应关系异常：${item.missionTypeName}`);
        if (names.has(item.missionTypeName)) throw new Error(`副本类型重复：${item.missionTypeName}`);
        names.add(item.missionTypeName);
      }
      const def = defaultZzzFallbackConfig();
      if (def.enabled !== true) throw new Error('默认应启用兜底');
      if (def.agentPlanTimes !== 3) throw new Error(`代理人计划默认次数应为 3：${def.agentPlanTimes}`);
      if (String(def.agentCardNum) !== '5') throw new Error(`代理人计划默认应按 ×5 卡打：${def.agentCardNum}`);
      if (def.discPlanTimes !== 4) throw new Error(`驱动盘计划默认次数应为 4：${def.discPlanTimes}`);
      if (!names.has(def.missionTypeName)) throw new Error(`默认驱动盘类型不在表里：${def.missionTypeName}`);
      const merged = zzzFallbackConfig();
      if (!names.has(merged.missionTypeName)) throw new Error('zzzFallbackConfig 返回的 missionTypeName 非法');
      const yml = findZzzChargePlanPath('C:\\OD', 2);
      if (!yml.endsWith(path.join('config', '02', 'one_dragon', 'charge_plan.yml'))) throw new Error(`charge_plan 路径异常：${yml}`);
      const script = buildZzzChargePlanScript();
      for (const token of ['charge_plan.yml', '代理人方案培养', '区域巡防', 'yaml.dump', "newline='\\n'", 'agent.card_num']) {
        if (!script.includes(token)) throw new Error(`脚本缺少片段：${token}`);
      }
      return `types=${ZZZ_DISC_MISSION_TYPES.length} default=${def.missionTypeName} agent=${def.agentPlanTimes}x${def.agentCardNum} disc=${def.discPlanTimes}`;
    });
    check('manifest has no BOM', () => {
      // PowerShell 的 Set-Content -Encoding UTF8 会写 BOM；DSH 用 JSON.parse 读 bundle 清单，
      // 带 BOM 会让 bundle 变成 availability=missing、整插件不加载（设置页条目消失）。
      const file = new URL('../package.json', import.meta.url);
      const bytes = fs.readFileSync(file);
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error('package.json 带 UTF-8 BOM，DSH 会拒绝加载');
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (!manifest?.dsh?.bundle?.patch) throw new Error('package.json 缺 dsh.bundle.patch');
      return 'no BOM, bundle patch ' + manifest.dsh.bundle.patch;
    });    check('bettergi-mcp bundled', () => {
      const file = bundledPath();
      if (!fs.existsSync(file)) throw new Error(`插件没自带 bettergi-mcp：${file}`);
      const size = fs.statSync(file).size;
      if (size < 50000) throw new Error(`自带 bettergi-mcp 过小：${size} 字节`);
      const text = fs.readFileSync(file, 'utf8');
      for (const tool of ['bgi_status', 'bgi_run_one_dragon']) {
        if (!text.includes(`'${tool}'`) && !text.includes(`"${tool}"`)) throw new Error(`自带 MCP 缺工具：${tool}`);
      }
      const savedEnv = process.env.DSH_GAME_DAILY_BETTERGI_MCP;
      delete process.env.DSH_GAME_DAILY_BETTERGI_MCP;
      try {
        // 没有 stateDir / vendor 时，应直接命中插件自带副本（装好即用，不需要联网）。
        const resolved = resolveBettergiMcp({});
        if (resolved !== file) throw new Error(`无外部副本时应返回自带路径，实际：${resolved}`);
      } finally {
        if (savedEnv === undefined) delete process.env.DSH_GAME_DAILY_BETTERGI_MCP;
        else process.env.DSH_GAME_DAILY_BETTERGI_MCP = savedEnv;
      }
      return `${Math.round(size / 1024)} KB, bundled fallback ok`;
    });
    await checkAsync('bettergi-control bundled install', async () => {
      const dir = bundledSkillPath('bettergi-control');
      if (!fs.existsSync(path.join(dir, 'SKILL.md'))) throw new Error(`插件没自带技能：${dir}`);
      const scripts = fs.readdirSync(path.join(dir, 'scripts')).filter((f) => /\.ps1$/i.test(f)).length;
      if (scripts < 15) throw new Error(`自带技能脚本不足：${scripts}`);
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-skill-bundled-'));
      try {
        const info = await installSkill('bettergi-control', { root, source: 'bundled' });
        if (!info.ok) throw new Error(`本地安装失败：${info.error}`);
        if (info.source !== 'bundled') throw new Error(`应走自带副本：${info.source}`);
        if (!fs.existsSync(path.join(root, 'bettergi-control', 'SKILL.md'))) throw new Error('安装后缺 SKILL.md');
        const target = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-skill-remote-'));
        try {
          // source=remote 只做参数校验：不真的联网下载，避免 CI 依赖网络。
          if (!SKILL_REPOS['bettergi-control'].zip) throw new Error('缺远程 zip 地址');
        } finally {
          fs.rmSync(target, { recursive: true, force: true });
        }
        return `bundled scripts=${scripts} files=${info.files} -> temp root ok`;
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
    await checkAsync('update helpers', async () => {
      const cases = [
        ['0.2.0', '0.2.0', 0],
        ['0.3.0', '0.2.0', 1],
        ['0.2.9', '0.2.10', -1],
        ['v0.3.0', '0.3.0', 0],
        ['0.3.0-beta.1', '0.3.0', -1],
        ['0.3.0', '0.3.0-beta.2', 1],
      ];
      for (const [a, b, expected] of cases) {
        const actual = compareVersions(a, b);
        if (actual !== expected) throw new Error(`compareVersions(${a}, ${b}) = ${actual}，应为 ${expected}`);
      }
      const pkg = readPackage();
      if (!/^\d+\.\d+\.\d+/.test(String(pkg.version || ''))) throw new Error(`package.json 版本不合法：${pkg.version}`);
      const local = readLocalVersion();
      if (local !== pkg.version) throw new Error(`本地版本读取不一致：${local} vs ${pkg.version}`);
      if (compareVersions('9.9.9', local) <= 0) throw new Error('远端更高版本应判定为有更新');
      return `local=${local}`;
    });
    await checkAsync('game-daily 技能族自动安装', async () => {
      // 1) 三条注册项：同一个 zip、各自 subdir、required/minFiles 合法
      const family = ['game-daily', 'game-daily-hi', 'game-daily-sr'];
      const zips = new Set();
      for (const name of family) {
        const spec = SKILL_REPOS[name];
        if (!spec) throw new Error(`SKILL_REPOS 缺 ${name}`);
        if (spec.subdir !== name) throw new Error(`${name}.subdir 应为 ${name}，实际 ${spec.subdir}`);
        if (!Array.isArray(spec.required) || !spec.required.includes('SKILL.md')) throw new Error(`${name} 必须 required 含 SKILL.md`);
        if (!spec.zip || !/codeload\.github\.com/.test(spec.zip)) throw new Error(`${name} 缺 codeload zip`);
        zips.add(spec.zip);
      }
      if (zips.size !== 1) throw new Error(`三套技能应共用一个 zip，实际 ${zips.size} 个`);
      if (!/gychen-NJU\/game-daily/.test(SKILL_REPOS['game-daily'].repo)) throw new Error('repo 应为 gychen-NJU/game-daily');
      // 2) 未知技能 / 缺 root / bundled 缺失时的错误必须清晰（不联网）
      const unknown = await installSkill('nope-skill', { root: os.tmpdir() });
      if (unknown.ok !== false || !/未知技能/.test(unknown.error)) throw new Error('未知技能应报「未知技能」');
      const noRoot = await installSkill('game-daily', { root: '' });
      if (noRoot.ok !== false || !/技能根目录/.test(noRoot.error)) throw new Error('缺 root 应报技能根目录');
      const noBundle = await installSkill('game-daily-hi', { root: os.tmpdir(), source: 'bundled' });
      if (noBundle.ok !== false || !/没有自带/.test(noBundle.error)) throw new Error('插件没自带时应报「没有自带该技能」');
      // 3) coverage：技能不存在时安静返回空数组（不抛）
      const empty = runCoverage(path.join(os.tmpdir(), 'gd-no-such-skills-root'));
      if (!Array.isArray(empty) || empty.length !== 0) throw new Error('coverage 在缺技能时应返回空数组');
      return `family=3 zip=1 subdir ok, 错误文案与 coverage 兜底 ok`;
    });
    await checkAsync('report session reuse', async () => {
      const state = normalizeState({ reportSessionIds: { genshin: 'session-abc', hi: 'nope', sr: 'session-9' } });
      if (state.reportSessionIds.genshin !== 'session-abc') throw new Error('应保留合法 sessionId');
      if (state.reportSessionIds.hi) throw new Error('应丢弃非法 sessionId');
      if (state.reportSessionIds.sr !== 'session-9') throw new Error('应保留 session-9');
      const calls = [];
      const ctx = {
        get(key) {
          if (key !== 'sessionController') return undefined;
          return { prompt: async (req) => { calls.push(req); } };
        },
      };
      const ok = await appendSession(ctx, { sessionId: 'session-abc', prompt: 'hi' });
      if (!ok.ok || calls.length !== 1 || calls[0].sessionId !== 'session-abc') throw new Error('追加应调用 prompt');
      if (!Array.isArray(calls[0].content) || calls[0].content[0].text !== 'hi') throw new Error('prompt 内容不对');
      const bad = await appendSession(
        { get: () => ({ prompt: async () => { throw new Error('gone'); } }) },
        { sessionId: 'session-x', prompt: 'hi' },
      );
      if (bad.ok !== false) throw new Error('会话不可用时应返回 ok:false');
      const empty = await appendSession(ctx, { sessionId: '', prompt: 'hi' });
      if (empty.ok !== false) throw new Error('没有 sessionId 时应返回 ok:false');
      return 'reuse ok';
    });
check('三月七小助手（m7a）：注册 / 体检 / 提示词', () => {
  const sr = gameById('sr');
  if (sr.engine !== 'm7a') throw new Error(`星铁引擎应为 m7a，实际 ${sr.engine}`);
  if (sr.skillModule !== 'm7a-control') throw new Error(`星铁 skillModule 应为 m7a-control，实际 ${sr.skillModule}`);
  const deps = probeDependencies(['sr'], { stateDir: os.tmpdir() });
  const ids = deps.checks.map((c) => c.id);
  for (const id of ['m7a', 'm7a-skill', 'm7a-mcp']) {
    if (!ids.includes(id)) throw new Error(`星铁体检缺 ${id}（实际 ${ids.join(',')}）`);
  }
  const m7a = deps.checks.find((c) => c.id === 'm7a');
  if (m7a.status === 'missing') {
    if (!m7a.blocker) throw new Error('未安装 M7A 应标 blocker');
    if (!m7a.fix || m7a.fix.action !== 'install-m7a') throw new Error(`未安装时应给 install-m7a，实际 ${JSON.stringify(m7a.fix)}`);
  } else if (m7a.status === 'warn') {
    // warn 分两种：可修的（首次未确认/路径失效）必须带 fix；正在跑（active_run）属于正常值守状态，不需要 fix。
    if (m7a.fix) {
      if (!['install-m7a', 'setup-m7a'].includes(m7a.fix.action)) {
        throw new Error(`warn 的 fix 只能是 install-m7a/setup-m7a，实际 ${JSON.stringify(m7a.fix)}`);
      }
    } else if (!/运行中|正在运行|active_run|正在跑/.test(String(m7a.detail || ''))) {
      throw new Error(`warn 没有 fix 时必须在 detail 里说明原因（运行中），实际 ${JSON.stringify(m7a.detail)}`);
    }
  }
  const prompt = buildRunPrompt({ game: sr, mode: 'real', runId: 't', runDir: 'X:/r', reportPath: 'X:/r/report.json', skillsRoot: 'X:/s', stateDir: 'X:/st' });
  if (!prompt.includes('三月七小助手')) throw new Error('星铁 prompt 没提三月七小助手');
  if (prompt.includes('先用 skill 工具加载技能')) throw new Error('星铁 prompt 不该再要求外部技能');
  if (!prompt.includes('--after-finish None')) throw new Error('星铁 prompt 缺 --after-finish None 约束');
  if (!prompt.includes('培养目标') || !prompt.includes('拟造花萼（赤）')) {
    throw new Error('星铁 prompt 没写清体力用途口径（只刷培养目标、拟造花萼（赤））');
  }
  const installHint = buildInstallPrompt({ action: 'install-m7a', gameId: 'sr' });
  if (!installHint.includes('March7thAssistant')) throw new Error('install-m7a 的修复线索没写清楚');
  if (!installHint.includes('目录')) throw new Error('install-m7a 的修复线索没有要求先问安装目录');
  if (!installHint.includes('C 盘')) throw new Error('install-m7a 的修复线索没有说明默认不装 C 盘');
  return `${m7a.status}${m7a.fix ? '/' + m7a.fix.action : ''} · ${ids.filter((i) => i.startsWith('m7a')).join(',')}`;
});

check('三月七小助手（m7a）：安装目录识别与 JSON 容错', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'm7a-'));
  const okDir = path.join(tmp, 'full');
  fs.mkdirSync(okDir, { recursive: true });
  fs.writeFileSync(path.join(okDir, 'm7a.exe'), '');
  fs.writeFileSync(path.join(okDir, 'config.yaml'), 'game_path: D:/StarRail\n');
  const legacyDir = path.join(tmp, 'legacy');
  fs.mkdirSync(legacyDir, { recursive: true });
  fs.writeFileSync(path.join(legacyDir, 'March7th Assistant.exe'), '');
  const emptyDir = path.join(tmp, 'empty');
  fs.mkdirSync(emptyDir, { recursive: true });

  const ok = inspectM7aInstallRoot(okDir);
  if (!ok.hasExe || !ok.looksLikeRoot) throw new Error(`有 m7a.exe 应判为安装目录：${JSON.stringify(ok)}`);
  const legacy = inspectM7aInstallRoot(legacyDir);
  if (legacy.hasExe || !legacy.legacyOnly) throw new Error(`只有旧版 exe 应判 legacyOnly：${JSON.stringify(legacy)}`);
  const none = inspectM7aInstallRoot(emptyDir);
  if (none.hasExe || none.looksLikeRoot) throw new Error('空目录不该判为安装目录');
  const parsed = extractJson('log line\n{"status":"ok","reason":"\\u672a\\u5f00\\u59cb"}\ntail');
  if (!parsed || parsed.status !== 'ok' || !parsed.reason.includes('未')) throw new Error(`extractJson 没解析出中文：${JSON.stringify(parsed)}`);
  const facts = m7aFacts();
  const lines = typeof facts === 'string' ? facts : (facts.lines || []).join('\n');
  if (!lines.includes('三月七小助手')) throw new Error('m7aFacts 文案缺主体');
  if (exitMeaning(3) === exitMeaning(0)) throw new Error('exitMeaning 没有区分 0/3');
  if (DEFAULT_M7A_TASK !== 'main') throw new Error(`默认任务应为 main，实际 ${DEFAULT_M7A_TASK}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  return `ok/legacy/empty 三态正确 · extractJson 中文 ok · 默认 ${DEFAULT_M7A_TASK}`;
});
check('三月七小助手（m7a）：overlay / prompt 对字符串 game id 也生效', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-overlay-'));
  const ov = ensureOverlay({ stateDir: dir, game: 'sr' });
  if (!ov || ov.ok !== true || ov.hasMcp !== true) {
    throw new Error(`sr 的 overlay 没注入 m7a MCP：${JSON.stringify(ov)}`);
  }
  const prompt = buildRunPrompt({
    game: 'sr',
    mode: 'real',
    runId: 't-1',
    runDir: dir,
    reportPath: path.join(dir, 'report.json'),
    skillsRoot: 'C:\\skills',
    stateDir: dir,
  });
  if (!prompt.includes('三月七小助手')) throw new Error('字符串 game id 的 prompt 没走 M7A 分支');
  if (!/m7a_status|m7a_run/.test(prompt)) throw new Error('prompt 里没有 m7a 工具说明');
  let threw = false;
  try { buildRunPrompt({ game: null }); } catch { threw = true; }
  if (!threw) throw new Error('缺 game 时 buildRunPrompt 应当直接报错');
  const bad = ensureOverlay({ stateDir: dir, game: null });
  if (!bad || bad.ok !== false) throw new Error('缺 game 时 ensureOverlay 应当返回 ok:false');
});
    for (const item of results) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}  ${item.detail}`);
    exitCode = results.some((item) => !item.ok) ? 1 : 0;
    console.log(JSON.stringify({ ok: exitCode === 0, total: results.length, failed: results.filter((r) => !r.ok).length }));
    process.exit(exitCode);
  });
