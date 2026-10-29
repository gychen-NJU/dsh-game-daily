// 给 headless 一轮的 prompt。约束必须写死：安全红线、报告路径、失败也要写报告。
import { gameById } from './games.mjs';

function q(value) {
  return String(value == null ? '' : value);
}

/** 每游戏读哪套技能 / 用哪条执行通道。 */
export function engineBrief(game) {
  if (!game) return '';
  if (game.engine === 'bettergi') {
    return [
      '引擎：BetterGI（原神自动化）。优先用 mcp__bettergi__* 工具；看不到这些工具时退回技能自带脚本。',
      '推荐顺序：bgi_doctor → bgi_status →（窗口不可用时 bgi_focus_game）→ bgi_run_one_dragon {config:"日常"} → 反复 bgi_watch 直到收尾 → bgi_results 取战果。',
      'BetterGI 运行中不要改它的配置（会被回写覆盖）；需要改配置时先 bgi_close 退出。',
      '窗口不是 16:9 或 <1920×1080 时不要硬跑（一条龙会连续报「游戏窗口分辨率不是 16:9」，合成树脂/自动秘境/每日奖励/采集会全废）：先 bgi_close {target:"both",confirm:true}，再跑技能脚本 scripts\\bgi-set-resolution.ps1 -Apply -StartGame -Verify（改 HKCU 注册表 Screenmanager 三键 + 补 HIGHDPIAWARE，实测复核 exit 0），然后才 bgi_run_one_dragon。无人值守要点：-Apply 不需提权；-StartGame 未提权时会自动走「BetterGI 按需执行」计划任务（免 UAC，-StartMode 可强制）；夜间 agent 若由计划任务拉起则本身已提权，直接启动也不会弹框。',
    ].join('\n');
  }
  if (game.engine === 'zzz-od') {
    return [
      '引擎：ZenlessZoneZero-OneDragon（绝区零「一条龙」）。所有画面识别与点击都由它完成，你只负责调度与判断。',
      '用 mcp__zzz-od__* 工具（看不到时说明 MCP 没起来，报告里如实写并停止）。',
      '推荐顺序：zzz_server {action:"status"} →（不可达时 zzz_server {action:"start"}；会弹一次 UAC，跳过并记进报告也可以）→ zzz_health → zzz_window →（窗口无效时才 zzz_enter {block:true}）→ zzz_run_one_dragon {} → 反复 zzz_wait {timeout_seconds:40} 直到 running=false → zzz_status 取最终状态。',
      '已知坑 1：游戏停在标题界面时直接跑一条龙，第一个应用（邮件）会报「未能识别当前画面」；先用 zzz_enter 进到「大世界-普通」。',
      '已知坑 2：zzz_enter 在「已经在大世界」时可能一直返回未知画面直到超时；截图确认已在大世界后，调 zzz_stop 结束这次 enter 再继续，不要反复重试 enter。',
      '已知坑 3：一条龙对同一天已完成的应用会直接标「应用已完成」并跳步；run 几秒就报「全部结束」不等于没做事，要读日志里每个应用的返回状态再下结论。',
      '不要点付费/删除/重置按钮，不要改一条龙配置；真实运行结束后插件会自己关游戏。',
    ].join('\n');
  }
  return [
    `引擎：game-daily 技能族（${game.skillModule}）。先读 ${q(game.skillModule)} 的 SKILL.md，按里面的步骤表执行。`,
    '本机没有 wincu computer-use 时，用技能自带的 ps-helper 通道（scripts/run-step.mjs --ps --locate）；提权助手没在跑就先按 manifest 里的 helper_ps1 启动它。',
    '',
    '【点击铁律 R1–R9：先定位、有证据才点】（细节见 game-daily/SKILL.md §2.2，违者按停手处理）',
    '• R1 每步先截图存证；R2 认屏看文案（expect/verify 的 any/all），不要凭"看起来像"；',
    '• R3 点击位置只能来自视觉定位（scripts/locate.mjs + references/templates/<id>.png），默认阈值 0.72；分数不够 / exit 2 → 停手，绝不按坐标兜底；',
    '• R4 坐标表（*coords.json）与 layout 先验只当搜索窗，不能直接 click；',
    '• R5 本机绝对坐标必须带分辨率标签，换分辨率不混用；',
    '• R6 证据落 state/shots/evidence/ + state/runs/<date>.json；R7 低置信、遮挡、抢前台失败一律停；',
    '• R8 所有坐标是客户区坐标（原点=客户区左上，不是屏幕/窗口）；',
    '• R9 行内按钮随当日内容漂移时用锚点+偏移（templates/anchors.json）或紧搜索窗（templates/regions.json），不要死磕单点。',
    '',
    '【三种消歧手段，按顺序用】① templates/index.json 多外观变体（同一按钮不同弹窗外观）→ ② anchors.json 锚点+offset（位置漂移但文案唯一）→ ③ regions.json 紧搜索窗（同页多行像素级同形）。全屏命中但 ambiguous=true 说明有同形干扰，配 ③ 或按要求停手。',
    '',
    '【分辨率指纹（每次开场自动跑）】scripts/resolution.mjs 会按客户区尺寸记 <stateDir>/resolution.json：',
    '• 分辨率未变 → 复用该分辨率下上次**命中**过的位置当搜索窗（pad 随高度等比放大），只收窄窗口、仍然必须模板命中过阈值；',
    '• 分辨率变了 → 旧分辨率先验作废，按新尺寸重新定位（跨分辨率命中会自动按比例放大模板，实测 1080p 模板在 2560×1600 以 scale≈1.33 命中，分数会掉到 0.73~0.79，属正常）。',
    '开场看一行 `[分辨率指纹] …` 就知道走的是哪条；不要手工改 resolution.json 去伪造先验。',
    '',
    '【执行与自检】',
    '• 真点：`node <skills>\\game-daily\\scripts\\run-step.mjs --game <hi|sr> --step N --ps --locate`（exit 0 成功 / exit 2 有目标定位不到 / exit 3 已 fail-closed 停手）；',
    '• 只看不点：加 `--probe`（打印每步 via/score/scale/client/region/shot，方便判断是"模板坏"还是"界面状态不对"）；',
    '• 跑前先自检模板覆盖率：`node <skills>\\game-daily\\scripts\\coverage.mjs <技能模块目录>`，缺模板的 id 本轮一律视为不可执行（不许用坐标补）。',
  ].join('\n');
}

/** 生成某一轮日常的 prompt。 */
export function buildRunPrompt({ game, mode, runId, runDir, reportPath, skillsRoot, stateDir }) {
  const title = game ? game.title : '未知游戏';
  const dry = mode === 'dry';
  const skills = game && Array.isArray(game.skills) ? game.skills.map((s) => `${skillsRoot}\\${s}`).join('、') : '';
  const skillsLine =
    game && game.engine === 'zzz-od'
      ? '本轮的技能说明已内置在插件里（skills/zzz-od-control/SKILL.md），不需要从外部安装技能；直接按下面的「引擎」说明操作。'
      : `先用 skill 工具加载技能：${skills || '（见 skillsRoot）'}。`;
  return [
    `【游戏日常 · ${title}】这是一次${dry ? '演练（只诊断，不点画面）' : '真实代理'}运行，runId=${runId}。`,
    '',
    skillsLine,
    `技能根目录：${skillsRoot}；本机状态目录：${stateDir}。`,
    '',
    engineBrief(game),
    '',
    '安全红线（违反任何一条立刻停手并如实写进报告）：',
    '1. 绝不点付费礼包、删除角色/存档、重置、解绑这类按钮；',
    '2. 只对目标游戏窗口发输入，每批点击前确认前台标题是目标游戏；',
    '3. 定位分数不到阈值、或同一目标连点两次画面无变化 → 停手，不要硬刷、更不要改用坐标盲点；',
    '4. UAC 不在本轮弹；需要提权的动作跳过并记进报告；',
    '5. 不修改游戏文件、不读写游戏内存。',
    '',
    dry
      ? '演练模式：只允许跑 probe / 状态检查 / 截图，不允许点击、按键或触发任何游戏内操作。'
      : '真实模式：按技能步骤完整做完当天日常；某一步失败就把后续步骤标 skipped，整体状态记 partial。',
    dry
      ? ''
      : '收尾：本轮结束后插件会自动关闭游戏进程（原神还会一起关掉 BetterGI），你不需要在游戏里点退出，也不要在报告里把它当成失败。',
    '',
    '完成后必须写报告（这是唯一交付物，报告不存在就视为失败）：',
    `报告路径：${reportPath}`,
    '报告 JSON 字段：',
    '{',
    '  "schemaVersion": 1,',
    '  "status": "success" | "partial" | "failed" | "aborted",',
    `  "mode": "${mode}",`,
    '  "startedAt": "ISO 时间", "endedAt": "ISO 时间",',
    '  "steps": [{ "id": "步骤id", "name": "步骤名", "ok": true, "note": "" }],',
    '  "evidence": ["关键日志行 / 截图路径 / 工具返回摘要"],',
    '  "notes": "给用户看的一句话结论"',
    '}',
    '',
    `运行目录：${runDir}（截图、日志都放这里；报告就用上面的路径）。`,
    '写报告前回读一次 JSON 是否可解析。最后用一句话回复：状态 + 完成到第几步 + 证据。',
  ].join('\n');
}

const FIX_HINTS = {
  'fix-headless-credentials': '在 headless profile 的 cordis.patch.yml 里补回车 credentials 启用行（`- id: credentials / disabled: false`），否则 headless 每轮都 MISSING_CREDENTIAL。',
  'fix-bettergi-mcp': '检查当前 profile 的 cordis.patch.yml 是否声明 bettergi MCP（serverName: bettergi）；需要时补一行。脚本用插件自带的 tools/bettergi-mcp/bettergi-mcp.mjs（独立仓库 https://github.com/gychen-NJU/bettergi-mcp 只是上游来源）；也可用环境变量 DSH_GAME_DAILY_BETTERGI_MCP 指定别的副本。',
  'install-bettergi-mcp': '插件自带 tools/bettergi-mcp/bettergi-mcp.mjs（约 100KB），正常情况下不需要联网下载；只有自带副本缺失时才从 https://github.com/gychen-NJU/bettergi-mcp 补单文件到 state 目录的 vendor/bettergi-mcp/ 下，或用 DSH_GAME_DAILY_BETTERGI_MCP 指向本机副本。面板的「修复」按钮会自动完成注册。',
  'install-bettergi-skill': '插件自带 bettergi-control 技能（tools/bettergi-control/），点修复会本地安装到 `%USERPROFILE%\\.agents\\skills\\bettergi-control`（可用 DSH_SKILLS_ROOT 覆盖），不联网；只有插件内的副本缺失时才从 https://github.com/gychen-NJU/bettergi-control 取 zip。',
  'start-elevation-helper': '按 game-daily-hi / game-daily-sr 技能的 §0 启动提权助手（会弹一次 UAC），并在 state/helper.pid 里确认 pid 存活。',
  'install-bettergi': '安装 BetterGI（默认目录 D:\\software\\BetterGI，可在面板里改），装完确认 BetterGI.exe 存在并跑一次 bgi_doctor。',
  'install-computer-use': '安装 dsh-computer-use-win 插件（profile 依赖 + bundle），装完确认设置页出现「电脑操作」项、工具 mcp__wincu__* 可调。',
  'install-skills': '恢复 game-daily 技能族到用户技能目录（默认 `%USERPROFILE%\\.agents\\skills`，可用 DSH_SKILLS_ROOT 覆盖）：game-daily、game-daily-hi、game-daily-sr、bettergi-control，补齐各自的 references/ 与 scripts/。面板的「修复」已内建自动安装（install-game-daily-skills 会从 https://github.com/gychen-NJU/game-daily 取 zip，一个包装三套，装完自动跑 coverage 自检），一般不需要开会话。',
  'install-game-daily-skills': '自动安装崩三 / 星铁技能族：一个 zip（https://codeload.github.com/gychen-NJU/game-daily/zip/refs/heads/main）里装 game-daily、game-daily-hi、game-daily-sr 三套到 `%USERPROFILE%\\.agents\\skills`（DSH_SKILLS_ROOT 可覆盖）；装完立刻跑 `node <skills>\\game-daily\\scripts\\coverage.mjs <模块目录>` 确认模板/锚点/变体齐全。自带副本优先，只有插件里没有该技能时才联网。',
  'calibrate-coords': '本机坐标已不再是主路径：崩三/星铁走"定位优先"（scripts/locate.mjs + references/templates/）。只有模板缺失且短时间补不上时才做坐标兜底，且必须带分辨率标签写进 state/coords.local.json，用 `node <skills>\\game-daily\\scripts\\coords.mjs set --game <hi|sr> --id <id> --x <x> --y <y>`。',
  'restore-locate-assets': '补齐"先找后点"的资产：`node <skills>\\game-daily\\scripts\\coverage.mjs <技能模块目录>` 会列出缺模板的 coord id；模板放 <模块>\\references\\templates\\<id>.png，多外观变体登记 index.json、锚点+偏移登记 anchors.json、紧搜索窗登记 regions.json；布局先验放 references/<game>-layout.json（崩三已有，可用 `node <skills>\\game-daily\\scripts\\layout.mjs check --layout <json>` 复核）。缺的步骤在补好前按 R3 停手，不要用坐标硬点。',
  'install-zzz-od': '安装 ZenlessZoneZero-OneDragon（一条龙）：从 https://github.com/OneDragon-Anything/ZenlessZoneZero-OneDragon clone（本机没有 git 就下 codeload zip）到非系统盘（默认 D:\\software\\ZenlessZoneZero-OneDragon，禁止装进 C 盘；可用 DSH_GAME_DAILY_ZZZ_ROOT 覆盖），在该目录跑 `uv sync`，再写 config/01/game.yml 与 config/01/game_account.yml（game_path 指向绝区零 exe）。面板的「自动安装一条龙」按钮已内建这条链路，一般不需要开会话。',
  'start-zzz-server': '用插件的 automation/zzz-server.ps1 -Action start 启动一条龙后端（会弹一次 UAC）；绝区零以管理员权限运行，非提权的后端点不动窗口。',
};

/** 生成「让 DSH 帮我把依赖装好/修好」的会话 prompt。 */
export function buildInstallPrompt({ action, gameId, checkId, checkDetail }) {
  const game = gameById(gameId);
  const title = game ? game.title : '游戏日常';
  const hint = FIX_HINTS[action] || (action ? `按体检项 ${action} 的修复办法处理。` : '');
  return [
    `【游戏日常 · 依赖修复】请直接动手把下面这一项的依赖修好，不要只给步骤。`,
    '',
    `游戏：${title}（${gameId || '全部'}）`,
    `体检项：${checkId || action || '未知'}`,
    checkDetail ? `体检结果：${checkDetail.split('\n').join('；')}` : '',
    hint ? `修复线索：${hint}` : '',
    '',
    '要求：',
    '1. 先复核体检结论（读文件 / 跑命令），确认问题真实存在；',
    '2. 动手修复，改任何配置前先备份原文件并保留回滚命令；',
    '3. 修完回读验证：把关键命令输出、文件是否存在、版本号这些证据贴出来；',
    '4. 最后用一段话说清：改了什么、验证证据、还剩什么风险。',
    '5. 这是「游戏日常」插件的依赖修复会话，修完后用户会回到设置页刷新体检。',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 一轮运行失败/成功后的汇报 prompt（投给该游戏的汇报会话）。 */
export function buildReportPrompt({ game, runId, report, reportPath }) {
  const title = game ? game.title : '游戏日常';
  const status = report && report.status ? report.status : 'unknown';
  const steps = report && Array.isArray(report.steps) ? report.steps : [];
  const lines = steps.map((s) => `- ${s && s.id ? s.id : '?'} ${s && s.name ? s.name : ''}：${s && s.ok ? 'OK' : '未完成'}${s && s.note ? `（${s.note}）` : ''}`);
  return [
    `【游戏日常 · 结果汇报】${title} 的日常代理跑完了，runId=${runId}，状态=${status}。`,
    '',
    `报告文件：${reportPath}`,
    lines.length ? `步骤：\n${lines.join('\n')}` : '报告里没有步骤明细。',
    '',
    '请做三件事：',
    '1. 读报告，用一句话给结论（成没成、到第几步、卡在哪）；',
    '2. 把证据贴出来（关键日志行 / 截图路径 / 工具返回），不要只说“应该没问题”；',
    '3. 如果是 partial / failed，给出下一步动作（重跑哪一步、要不要人工介入）。',
    '不要重新跑游戏，只汇报。',
  ].join('\n');
}
