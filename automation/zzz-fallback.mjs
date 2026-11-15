/**
 * automation/zzz-fallback.mjs — 手动查看/改写绝区零「清体力兜底」配置。
 *
 * 背景：「代理人方案培养」（特训目标）计划一旦结算出现「已达成」，一条龙会把它标记跳过，
 * 顺位执行后面的计划。这里把「区域巡防」（驱动盘本）挂在代理人计划后面，
 * 并把代理人计划的次数调大：材料没满时把电量刷完，材料满了就自动落到驱动盘本上。
 *
 * 用法：
 *   node automation/zzz-fallback.mjs                 # 立即确保（会改 charge_plan.yml）
 *   node automation/zzz-fallback.mjs --dry-run       # 只看会改什么
 *   node automation/zzz-fallback.mjs --list          # 列出可选的驱动盘副本
 *   node automation/zzz-fallback.mjs --mission 怪兽与怪客 --agent 12 --disc 4
 *   node automation/zzz-fallback.mjs --config        # 打印当前兜底配置与文件位置
 */
import {
  ZZZ_DISC_MISSION_TYPES,
  ensureZzzChargePlanFallback,
  findZzzChargePlanPath,
  zzzFallbackConfig,
  zzzFallbackPath,
  zzzRoot,
} from '../lib/zzz.mjs';

function argOf(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (process.argv.includes('--list')) {
  for (const item of ZZZ_DISC_MISSION_TYPES) {
    console.log(`${item.missionTypeName}\t${item.discs.join(' / ')}`);
  }
  process.exit(0);
}

if (process.argv.includes('--config')) {
  console.log(JSON.stringify({
    root: zzzRoot(),
    chargePlan: findZzzChargePlanPath(),
    fallbackFile: zzzFallbackPath(),
    config: zzzFallbackConfig(),
  }, null, 2));
  process.exit(0);
}

const overrides = {};
const mission = argOf('--mission');
if (mission) overrides.missionTypeName = mission;
const agent = argOf('--agent');
if (agent) overrides.agentPlanTimes = Number(agent);
const disc = argOf('--disc');
if (disc) overrides.discPlanTimes = Number(disc);

const dryRun = process.argv.includes('--dry-run');
const result = ensureZzzChargePlanFallback({
  dryRun,
  config: { ...zzzFallbackConfig(), ...overrides },
});
console.log(JSON.stringify(result, null, 2));
process.exit(result.ok ? 0 : 1);
