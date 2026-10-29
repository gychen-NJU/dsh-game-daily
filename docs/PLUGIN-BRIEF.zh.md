# dsh-game-daily 插件说明（供「简介视频」制作会话使用）

> 这份文档是给**新工作区里的另一个会话**看的：它没有本会话的历史。读完它，你应该能理解这个插件是什么、为什么存在、长什么样、怎么运行、哪些话可以讲、哪些话不能讲，并据此写分镜、口播稿、准备录屏。
>
> 文档里的所有事实均来自实现与实机验证（2026-10-24）。如果你需要最新细节，以仓库代码与 `README.md` 为准。

---

## 0. 一句话任务

请围绕一个 DSH（DeepSeek Harness）桌面端插件 **`dsh-game-daily`** 做一支 1–3 分钟的简介视频：它把《原神》《崩坏3》《崩坏：星穹铁道》的每日日常，收进 DSH 设置页的一个面板里——**开关默认关闭、开启后按每个游戏排班、到点自动执行、跑完通知你并开一个会话汇报结果**。

---

## 1. 电梯陈述（可直接当 30 秒口播底稿）

> 每天打开三个游戏，点同样的按钮、领同样的奖励，十分钟就没了。
> `dsh-game-daily` 把这件事变成一句话：在 DSH 设置里打开「游戏日常」，给每个游戏定一个时间，点「保存并应用」。
> 到点，Windows 计划任务会拉起一个 headless 的 DSH 会话，按游戏自己的技能把日常跑完，写一份带证据的报告；插件再把结果用通知和会话告诉你。
> 它不替你点付费礼包，也不会在你锁屏时假装成功——做不到的事，它会直接说。

---

## 2. 背景：为什么做这个

作者本机原本已经有两套能力，但都停在「需要人指挥」的阶段：

| 已有能力 | 能做什么 | 问题 |
| --- | --- | --- |
| `game-daily` / `game-daily-hi` / `game-daily-sr` 技能 | 崩坏3、星铁各 14 步日常，在真实游戏界面里点完 | 需要人开一个会话说「帮我清日常」，跑完也没有固定的汇报格式 |
| **随插件自带**的 `bettergi-control` 技能 + `bettergi-mcp`（29 个工具） | 原神一条龙（领邮件→合成树脂→秘境→每日奖励→尘歌壶→狗粮批发） | 同上，且窗口/分辨率等前置条件要自己查 |
| Windows 计划任务 | 到点触发 | 只能触发「一条死命令」，不会汇报、不会记录、不会失败重试 |

缺的是**产品化的那一层**：入口（设置页）、开关、排班、依赖体检、执行编排、结果留痕、向用户汇报。这就是这个插件。

---

## 3. 它做了什么（功能清单）

| 能力 | 说明 |
| --- | --- |
| 设置页入口 | DSH「设置」左侧导航新增「游戏日常」（`settings.section`，id `game-daily`，order 35，位于「用量统计」和「喵记忆」之间） |
| 顶部游戏切换 | 四个 tab：原神 / 崩坏3 / 崩坏：星穹铁道 / 绝区零（走 ZenlessZoneZero-OneDragon「一条龙」） |
| 逐游戏总开关 | **默认关闭**；关闭时只显示说明和「开启代理」，开启后才展开排班与执行设置 |
| 每游戏排班 | 每天时间 `HH:MM`、执行日（每天 / 指定星期 1–7）、超时 5–180 分钟、错过补跑、模式（真实执行 / 演练） |
| 依赖体检 | 逐项给出「就绪 / 可用但有风险 / 缺失 / 阻断」，每项可点「让 DSH 修这个」：能自动做的（装 bettergi-control 技能、下载 bettergi-mcp、注册 MCP 配置）一键完成并显示「处理中…」，需要多步或提权的才新开会话修 |
| 一键落地 | 「保存并应用」写入配置 → 生成 `automation/tasks.json` → 调提权脚本注册 Windows 计划任务（会弹一次 UAC） |
| 到点自动跑 | 计划任务 → `automation/run-headless.mjs` → `dsh --profile headless` 按技能执行 → 写 `report.json` |
| 结果汇报 | 插件每 60 秒 reconcile：记账、Windows 通知（toast）、按开关在 DSH 里开一个「游戏日常 · <游戏> 汇报」会话 |
| 前台守护 | 运行期间每秒检查一次，游戏被别的窗口抢走就用四级回退拉回前台（可在面板关掉） |
| 进程收尾 | 真实模式每轮跑完自动关闭游戏（原神连同 `BetterGI.exe`）；下一款开始前先关掉其它游戏，上一轮还在跑就等它收尾而不是抢窗口 |
| 手动控制 | 「立即运行一次」「停止」「关闭全部代理」；最近运行可点开看报告 JSON 与 stdout 尾部 |
| 演练模式 | `dry` 只做只读诊断并写报告，不动游戏；用于验证链路、排查前置条件 |

---

## 4. 用户旅程（视频主线建议）

### 第一次配置（约 2 分钟）

1. DSH 设置 → 左侧「游戏日常」。
2. 顶部切到「原神」→ 看到开关默认关、说明文案。
3. 点「开启代理」→ 出现排班卡与按钮组。
4. 往下看「依赖体检」：dsh CLI、DSH 版本、headless 运行器、computer-use、技能、坐标校准、提权助手、BetterGI、bettergi-control 技能、bettergi-mcp 脚本、bettergi-mcp 注册——全绿。
5. 设时间（例：11:00）→ 点「保存并应用」→ Windows 弹一次 UAC → 计划任务 `game-daily-genshin` 就绪。
6. 切到崩坏3 / 星铁，各自重复（它们用技能 + 提权助手或 computer-use，不走 BetterGI）。
7. 关掉设置页。之后每天到点自动发生。

### 某一轮自动运行（约 3 分钟，录屏重点）

1. 到点，Windows 计划任务启动 `run-headless.mjs`（可在任务计划程序里看到 Running）。
2. headless DSH 会话加载技能/MCP，开始截图、判断、操作游戏。
3. 结束后写 `runs/<game>/<runId>/report.json`（状态、步骤、证据、截图）。
4. 插件 reconcile：通知弹出（例：「原神 日常：部分完成 …」），并在侧边栏「游戏日常」工作区里**为该游戏复用同一个**汇报会话（首次创建、之后追加；会话被删则自动重建）。
5. 打开会话能看到结构化的结论与下一步建议；点「查看报告」能看原始 JSON。

---

## 5. 界面细节（录制与解说时的准确文案）

- 面板标题：**游戏日常**；副标题：`为每个游戏设定每日自动执行时间，到点自动跑日常，跑完向你汇报。`
- tab 名称：`原神` / `崩坏3` / `崩坏：星穹铁道` / `绝区零`。
- 原神卡片（未开启时）：标题「原神」、状态「已关闭」、说明「默认关闭。打开后才会出现排班与执行设置；所有改动点『保存并应用』才生效。」、按钮「开启代理」。
- 开启后：状态「已开启」、徽章「有改动，待应用」、按钮组「立即运行一次 / 保存并应用 / 关闭全部代理」。
- 排班卡字段与默认值：
  - 每天时间 `11:00`（原神）；崩坏3 `10:00`；星铁默认 `10:00`（本机当前设为 `10:30`）。
  - 执行日：每天（可选周一…周日）。
  - 超时（分钟）：原神默认 150、崩坏3/星铁 45（均可 5–180）；计划任务系统时限自动设为「超时 + 10 分钟」。
  - 看门狗：到「超时 − 5 分钟」时插件主动停跑并写兜底报告（`status=timeout`），不会被系统强杀后毫无记录；若连兜底报告都没有，reconcile 也会在进程退出 3 分钟后补记一条 failed 并发通知。
  - 模式：真实执行 / 演练。
  - 开关：错过补跑（开机后补一次）、运行完成后开一个会话汇报结果、前台守护（游戏被抢走时自动拉回）。
  - 提示：真实模式本轮结束后自动关闭游戏；下一款开始前先确保上一款已退出。
  - 游戏路径（可选）：`D:\software\BetterGI\BetterGI.exe`。
  - 任务状态：尚未创建计划任务 / 下次运行时间 / 上次结果。
- 依赖体检：每项一行，左侧 badge（就绪 / 可用但有风险 / 缺失），右侧「让 DSH 修这个」；点下去按钮变「处理中…」；顶部有「重新体检」。
- 最近运行：列表（运行号、状态、时间），点开是报告弹层（JSON + stdout 尾部）。
- 底部提示（红色小字）：`立即运行使用已保存的设置；改完排班记得先「保存并应用」。`

---

## 6. 系统架构

```
┌──────────────────────────── DSH 桌面端（Electron，settings.section: game-daily）────────────────────────────┐
│  client.js  ── fetch /api/game-daily/* ──►  index.js（Host 插件）                                             │
│                                              │  state.json（原子写）                                         │
│                                              │  automation/tasks.json                                       │
│                                              │  automation/headless-overlay.yml                            │
│                                              │  60s reconcile（读 report / 记账 / toast / 汇报会话）          │
└──────────────────────────────────────────────┼──────────────────────────────────────────────────────────────┘
                                               │ 写配置 + 调提权脚本（一次 UAC）
                                               ▼
                                Windows 计划任务  game-daily-<game>
                                （RunLevel=Highest，每天 HH:MM，WakeToRun，错过补跑）
                                               │ 到点触发
                                               ▼
                        automation/run-headless.mjs  （纯 Node 入口）
                                               │ spawn
                                               ▼
                 dsh --profile headless --patch automation/headless-overlay.yml "<运行 prompt>"
                 环境：DSH_PERMISSION_MODE=danger-full-access
                                               │ 加载技能 / MCP
                                               ▼
        原神：bettergi-mcp（29 个 bgi_* 工具）→ BetterGI 一条龙
        崩3/星铁：game-daily-* 技能 → 提权助手（ps-helper）或 computer-use（wincu）
                                               │ 执行
                                               ▼
              runs/<game>/<runId>/{meta.json, report.json, stdout.log}
                                               │ 插件 reconcile（60s）
                                               ▼
                      Windows 通知 + DSH 汇报会话 + 面板「最近运行」
```

关键一点（适合入镜）：**插件本身不碰游戏**。它是「调度器 + 配置面板 + 报告台」，真正动手的是技能与 MCP；插件负责把它们串起来、并在缺失依赖时把问题指出来。

---

## 7. 三条执行链（逐个游戏的差异）

### 原神（engine = bettergi）

- 依赖：BetterGI（默认 `D:\software\BetterGI`）+ **随插件自带**的 bettergi-control 技能与 bettergi-mcp（MCP 服务器，29 个工具）。
- 流程：`bgi_doctor` → `bgi_status` → `bgi_focus_game`（还原窗口并置前）→ `bgi_run_one_dragon {config:"日常"}` → `bgi_watch` → `bgi_results`。
- 一条龙 6 个任务（来自 `User\OneDragon\日常.json` 的 TaskOrder）：
  1. 领取邮件
  2. 合成树脂
  3. 自动秘境
  4. 领取每日奖励
  5. 领取尘歌壶奖励
  6. AAA-Artifacts-Bulk-Supply（狗粮批发 JS）
- **不包含**：每日委托、地脉花、首领/幽境危战、七圣召唤、采集、深渊。
- 硬前提：原神**可见且前台**、客户区 **16:9 且 ≥1920×1080**；锁屏/黑屏会失败。

### 崩坏3 / 星穹铁道（engine = skill）

- 依赖：`~/.agents/skills/game-daily*` 技能族 + 提权助手（`state/helper.pid` 存活）或 DSH 的 computer-use 插件。
- 流程：读对应 `SKILL.md` → 按 14 步逐屏「截图→认屏→**定位**→点击→复检」。**点击位置只能来自视觉定位**（`scripts/locate.mjs` + `<模块>/references/templates/<id>.png`，默认阈值 0.72）；`*coords.json` 与 layout 先验只当搜索窗，不允许退化成按坐标盲点。
- 消歧三档：`templates/index.json` 多外观变体 → `anchors.json` 锚点+offset（位置漂移、文案唯一）→ `regions.json` 紧搜索窗（同页多行同形）。全屏命中但 `ambiguous=true` 必须停手或配紧窗。
- 分辨率：`scripts/resolution.mjs` 按客户区尺寸记 `<stateDir>/resolution.json`——**分辨率未变时复用上次命中位置收窄搜索窗（更快），变了就让旧先验作废、按新尺寸重新定位**；跨分辨率命中会自动缩放模板（实测 1080p 模板在 2560×1600 以 scale≈1.33 命中，分数 0.73~0.79 属正常）。
- 崩3 约 10–12 分钟；星铁 14 步（列车补给、F4 指南、刷本、活跃度 500 礼盒、F2 无名勋礼）。
- 没有 computer-use 时走脚本 + 提权助手（`run-step.mjs --ps --locate`）；只看不点用 `--probe`；跑前用 `scripts/coverage.mjs <模块目录>` 自检模板覆盖率，缺模板的步骤一律 fail-closed 停手。合成鼠标被游戏过滤时按技能说明改用 computer-use。

### 绝区零（engine = zzz-od）

- 键鼠注入被 ACE 拦截，插件只保留占位 tab，标注「暂停」，不提供自动代理。**不要**在视频里把它说成可用。

---

## 8. 数据与文件（讲解「可审计」时用）

状态目录：`$DSH_HOME/game-daily/`（默认 `%USERPROFILE%\.dsh\game-daily`）

| 路径 | 内容 |
| --- | --- |
| `state.json` | 唯一真源：`ui{lastGame,reportSessions,foregroundGuard}`、`automation{taskPrefix,tasksRegistered,registeredAt}`、`games{<id>{enabled,mode,schedule,timeoutMin,gamePath,taskName,lastRunId,lastStatus}}`、`runs{}`（最近 10 条摘要） |
| `runs/<game>/<runId>/meta.json` | `runId / trigger / mode / startedAt / finishedAt / exitCode / pid` |
| `runs/<game>/<runId>/report.json` | `schemaVersion / runId / game / mode / status / startedAt / endedAt / steps[] / evidence[] / screenshots[] / notes` |
| `runs/<game>/<runId>/stdout.log` | headless 会话 stdout/stderr |
| `automation/tasks.json` | 交给注册脚本的任务定义 |
| `automation/game-daily-register.ps1` | 提权注册/删除计划任务（自动从插件包复制到状态目录） |
| `automation/register-result.json` | 注册结果（created / updated / removed / dryRun） |
| `automation/headless-overlay.yml` | 运行时 overlay（原神注入 bettergi MCP） |
| `automation/run-headless.log` | 计划任务侧日志 |
| `automation/guard-<game>.log` / `.stop` | 前台守护日志与停止旗标 |
| `tools/bettergi-mcp/bettergi-mcp.mjs` | 随包自带的 MCP 服务器（原神 `bgi_*`，29 个工具） |
| `tools/bettergi-control/` | 随包自带的 bettergi-control 技能（`SKILL.md` + 15 个脚本） |
| `vendor/bettergi-mcp/bettergi-mcp.mjs` | 可选：手动更新/覆盖用的副本（优先级高于自带） |
| `notifications.log` | 通知记录 |

`state.json` 用 **tmp + fsync + rename** 原子写；坏文件会被重命名为 `state.json.bad-<时间戳>` 并继续用默认值。

---

## 9. HTTP API（技术向观众/实现讲解）

前缀 `/api/game-daily`（同源、需登录态）：

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| GET | `/state` | 面板全量状态（games 是**数组**，含 task 的下次运行/状态） |
| GET | `/probe?games=genshin,hi` | 依赖体检（含逐项 fix 动作） |
| POST | `/ui` | 保存 UI 级设置（lastGame / reportSessions / foregroundGuard） |
| POST | `/apply` | 保存排班 + 写 tasks.json + 开始注册（支持 `dryRun`）；原神启用时顺手确认 bettergi-mcp（自带即用，缺才下载）并注册 MCP 行 |
| POST | `/disable` | 关闭全部代理并删除计划任务（一次 UAC） |
| POST | `/run` | 立即运行一次 `{game, mode?, trigger?}` |
| POST | `/stop` | 停止某游戏的在跑实例（停守护 + taskkill） |
| POST | `/run-task` | 直接触发已注册的 Windows 计划任务 |
| POST | `/install` | 一键修复：`install-bettergi-skill`（从自带副本本地安装）、`install-bettergi-mcp`（确认自带副本并注册，缺失才下载）、`fix-bettergi-mcp`（只注册）；其它 action 开修复会话 |
| GET | `/runs?game=` | 运行历史列表 |
| GET | `/run?game=&runId=` | 单轮报告 + stdout 尾部 |
| GET | `/update` | 检查更新（30 分钟缓存，`?force=1` 强制）：读远端 `package.json` 的 version，与本地比对，返回 `{current, latest, hasUpdate, releases}` |
| POST | `/update` | 立即更新：有 `.git` 走 `git pull --ff-only`，没有则下载 zip 覆盖插件文件（保留 `node_modules` 与用户数据），返回 `{from, to, method, restartRequired}` |
| POST | `/reconcile` | 手动触发一次对账（调试用） |

---

## 10. 设计与取舍（视频里「为什么这么做」的素材）

1. **为什么用 Windows 计划任务，而不是 DSH 原生日程？** DSH 的 schedule 绑定 GUI 会话，DSH 关掉就不跑；计划任务还能配置 `WakeToRun`、`StartWhenAvailable`（错过补跑）。代价是注册需要一次 UAC。
2. **为什么 headless 而不是桌面会话？** 不占用界面、可无人值守；靠 `--patch` overlay 给原神注入 bettergi MCP；靠 `DSH_PERMISSION_MODE=danger-full-access` 让审批不打断。风险由此而来，所以安全红线写进 prompt（不点付费礼包、不删除/重置、只对目标窗口发输入、同坐标两次无变化就停）。
3. **为什么不改 BetterGI 配置？** BetterGI 运行中会把内存里的配置回写覆盖；插件只调用 `bgi_*` 工具/CLI，不写它的配置文件。
4. **为什么 bettergi-mcp 要单独发仓库、按需下载？** 它是可复用的独立服务器（92KB 单文件、零依赖），塞进插件包会让两边升级互相拖累。插件按 `env → vendor 下载副本 → 同级工作区` 解析，缺失时按钮一键补。

5. **为什么 bettergi-control 技能也单独发仓库？** 同一个理由：技能是用户自己的、也会独立演进（15 个脚本）；插件只负责「缺了就从 GitHub 装」，不把 19 个文件复制进插件包。安装走 zip 下载 + 校验 + 原子替换，旧版本自动备份。
5. **为什么没人值守还要能「停」？** 计划任务是 `InteractiveToken + RunLevel Highest`；插件进程非提权杀不掉提权子进程，所以停止走「写标志 + 计划任务侧 taskkill」。
6. **为什么有「演练模式」？** 第一次配置时最需要验证的是链路（headless 能不能起来、MCP 有没有、窗口够不够大），不是游戏本身；dry 只读诊断、照常写报告。
7. **为什么默认关闭？** 这是会操作游戏、要弹 UAC、有封号话题的功能，默认必须是关的，用户点开才生效。

---

## 11. 前置依赖与体检项（11 项，原神）

| id | 检查 | 缺失时 |
| --- | --- | --- |
| `dsh` | 全局 dsh CLI（`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\lib\bin.js`） | 阻断（装 DSH CLI） |
| `dsh-version` | ≥ 0.2.1-rc.2 | 警告（升级） |
| `headless` | headless profile 存在 + credentials 已启用 | 阻断（修 patch） |
| `computer-use` | `dsh-computer-use-win` 已装 | 警告（安装插件） |
| `skills` | `game-daily` / `game-daily-hi` / `game-daily-sr` 的 SKILL.md | 阻断（恢复技能） |
| `calibration` | 技能引擎游戏有 `state/coords.local.json` | 警告（校准） |
| `locate` | 定位资产：`scripts/{locate,layout,resolution,coverage}.mjs` + `<模块>/references/templates/`（含 index/anchors/regions）+ `<game>-layout.json` | 警告（补资产；缺模板的步骤 fail-closed 停手） |
| `helper` | 提权助手 `state/helper.pid` 存活 | 阻断（启动助手，一次 UAC） |
| `bettergi` | BetterGI 安装位置与版本 | 警告（安装/改路径） |
| `bettergi-skill` | bettergi-control 技能（`SKILL.md` + ≥10 个脚本） | 阻断（**一键安装自带技能**，不联网） |
| `bettergi-mcp` | MCP 服务器脚本是否就位 | 警告（**随包自带**，缺失才从 GitHub 补） |
| `bettergi-mcp-registered` | 当前 profile 是否声明 bettergi MCP | 警告（**一键写入 profile 补丁**，重启生效） |

崩3/星铁只检查前 7 项里适用的部分（不查 BetterGI 三项）。

---

## 12. 边界与限制（视频必须如实）

- **不能后台挂机**：原神必须可见且前台；锁屏、最小化、被别的窗口盖住都会失败。前台守护只是「被抢走时拉回来」，不等于可以在后台跑。
- **分辨率要求（现在能自愈）**：原神需要 16:9 且 ≥1920×1080，本机 2560×1600 独占全屏会被 BetterGI 判为硬阻断（作者第一次 dry-run 报 `partial` 就是这个原因）。2026-10-26 起技能自带 `scripts\bgi-set-resolution.ps1`：先关游戏与 BetterGI → `-Apply`（写 `HKCU\Software\miHoYo\原神` 的 Screenmanager 三键 1920×1080/窗口化 + 补 `HIGHDPIAWARE` DPI 覆盖，自动备份）→ `-StartGame` → `-Verify`（GetClientRect+GetDpiForWindow 实测客户区），exit 0 才算通过；`-Restore` 可回滚。agent 遇到分辨率阻断时应先自愈，而不是让用户自己点设置。
- **注册计划任务需要一次 UAC**：点「保存并应用」/「关闭全部代理」会弹；之后到点运行不再弹。
- **首次校准**：崩3/星铁换分辨率、窗口模式或 DPI 后要重新校准坐标。
- **绝区零**：走 ZenlessZoneZero-OneDragon 后端（需管理员权限）；一条龙本体可由插件一键自动安装（默认 D 盘、不会装进 C 盘，首次需下载几百 MB 并 uv sync，按钮会显示「处理中…」），装完记录在 `<stateDir>/zzz-root.txt`。
- **不覆盖的日常内容**：原神一条龙不含每日委托/地脉花/首领/七圣召唤/采集/深渊；崩3/星铁按技能里的 14 步，不含活动或深渊。
- **账号风险**：官方条款把第三方软件/模拟操作列为封号理由之一；插件自身不做注入、不改游戏文件，但使用方式仍需低调。
- **改代码要重启桌面端**：插件从 profile 的 junction 读源码，但运行中的 Electron 进程不会热更新。

---

## 13. 已完成的验证（可以当作「真做过」的证据）

- 插件版本 `0.3.0`，MIT；`node test/smoke.mjs` → **21/21 PASS**（含状态原子写回读、prompt 构造、dsh 解析、依赖体检、计划任务 XML 解析、前台守护资产 BOM、bettergi-mcp 解析、技能安装 guard、MCP 注册幂等、更新版本比较）。
- 真实注册：`/apply` 触发一次 UAC，`register-result.json` 返回 `created`；`Get-ScheduledTask 'game-daily-dev-genshin'` → `Ready`，触发器每天 11:00、`RunLevel Highest`、`WakeToRun`。
- 端到端：手动 `Start-ScheduledTask` → headless 会话真实执行 → `runs/genshin/20261024-022625/report.json`（`status:"partial"`，12 步 12 条证据，含截图）；任务结束 `LastTaskResult=0`；通知写出「原神 日常：部分完成 …」；`state.json` 记账。
- 桌面端：`plugin_manager install_bundle` 成功，设置页出现「游戏日常」，客户端 slot `{id:"game-daily", order:35, active:true}`。
- 依赖体检（本机）：11 项 0 阻断（崩3 坐标校准为 warn）。
- 本机当前排班：原神 11:00、崩坏3 10:00、星铁 10:30（均为每天、真实执行）；旧的 `BetterGI 日常一条龙` 已停用，DSH 原生「崩坏3+星铁 每日日常」日程已删除，避免重复执行。

---

## 14. 安装与使用（视频里演示安装时用）

- 仓库：<https://github.com/gychen-NJU/dsh-game-daily>（public，MIT）
- 安装（交给 agent 的一句话）：

  > 帮我把 https://github.com/gychen-NJU/dsh-game-daily 装进当前 DSH 桌面端：clone 到本地目录后用 plugin_manager install_bundle 指向该目录，装完确认「设置 → 游戏日常」出现并跑一次依赖体检，缺什么按提示修好。

- 手动：clone 后在 DSH 里 `plugin_manager install_bundle target=<目录>`；开发期可用 `dsh plugin --profile web add link:<目录>` 在 web 端联调。
- 装完**重启一次桌面端**（首次安装），之后设置页生效。

配套 MCP：<https://github.com/gychen-NJU/bettergi-mcp>（原神用；**随插件自带**，上游仓库只作为更新通道）。
配套技能：<https://github.com/gychen-NJU/bettergi-control>（原神日常执行用；**随插件自带**，可一键本地安装）。

---

## 15. 视频素材清单

**现状**：仓库里**没有**成品截图（开发期截图已清理），需要现场重录。以下是建议的镜头与对应操作：

| # | 画面 | 怎么拿到 |
| --- | --- | --- |
| 1 | 设置页「游戏日常」全貌 | DSH → 设置 → 游戏日常，截全窗口 |
| 2 | 开关默认关 → 点「开启代理」 | 点一下，录下状态从「已关闭」到「已开启」+ 排班展开 |
| 3 | 依赖体检 11 项 | 点「重新体检」，等进度完成 |
| 4 | 排班卡（时间/星期/超时/模式/补跑/汇报/前台守护/游戏路径/任务状态） | 滚到卡片，逐项 hover |
| 5 | 「保存并应用」+ UAC | 录 UAC 弹窗（注意遮挡用户名） |
| 6 | 任务计划程序里的 `game-daily-*` | `taskschd.msc`，点开「触发器/操作」 |
| 7 | 到点运行 / 手动「立即运行一次」 | 面板点按钮，或任务计划程序右键 Run |
| 8 | 运行中：headless 在跑 + 游戏画面 | 录一段游戏自动操作（原神一条龙或崩3点按钮） |
| 9 | 报告弹层 | 面板「最近运行」→「查看报告」 |
| 10 | Windows 通知 + 汇报会话 | 跑完等 toast；侧边栏「游戏日常」工作区里打开汇报会话 |
| 11 | 仓库 README / release 页 | 浏览器录 `github.com/gychen-NJU/dsh-game-daily` |

可选 B-roll：`report.json` 原文、`state.json`（遮住路径用户名）、`automation/run-headless.log`、任务计划程序的「上次运行结果 0x0」。

---

## 16. 叙事建议（给脚本作者）

**推荐结构（约 2 分钟）**

1. **痛点（15s）**：三个游戏、每天十分钟重复点击。
2. **亮相（15s）**：设置页多了一个「游戏日常」；顶部四个游戏，开关默认是关的。
3. **配置（30s）**：开启 → 体检 → 排班 → 保存并应用（UAC 一次）。
4. **自动运行（30s）**：到点，计划任务拉起 headless 会话；游戏自己在动；前台守护保证不被抢走。
5. **结果（20s）**：报告 + 通知 + 汇报会话；「做不到的事它会说」——分辨率不够就是硬阻断。
6. **边界与结束（10s）**：默认关闭、不点付费、不后台挂机；仓库地址与一句话安装。

**卖点排序**：① 统一入口 + 每游戏排班；② 依赖体检与一键修；③ 可审计的报告（JSON+证据+截图）；④ 默认关闭与安全红线；⑤ 开源、MIT、可扩展（加新游戏=加一个 skill 模块）。

**不要说的话**

- 不要说「全自动无人值守挂机」——需要游戏可见且前台。
- 绝区零已接入（一条龙 + 插件自带 zzz-od MCP/skill），一条龙本体可在体检里「让 DSH 修复」一键安装（默认 D 盘，避开 C 盘）。
- 不要说「包办所有日常」——原神只有一条龙 6 任务。
- 不要把「演练模式」说成「真的跑」；也不要把 `partial` 说成失败——它是「跑完了但有前置条件没满足」，报告里有明确原因。
- 不要展示未打码的 UID/账号信息。

---

## 17. 术语表（口播时避免堆词）

| 词 | 一句话解释 |
| --- | --- |
| DSH / DeepSeek Harness | 作者用的桌面端 AI Agent 工作台；插件跑在它的 Host 进程里，界面是它的设置页 |
| 插件（bundle） | 一个 npm 包 + `cordis.patch.yml`，装进 profile 后出现在设置页/工具列表 |
| `settings.section` | DSH 设置页左侧导航的插槽；本插件以 id `game-daily`、order 35 注册 |
| headless | 不打开界面的 DSH 运行模式：给一个任务，跑完退出，结果写文件/stdout |
| 技能（skill） | 一份 `SKILL.md` + 脚本，告诉 agent「这个游戏怎么点」 |
| MCP | Model Context Protocol；`bettergi-mcp` 通过它把 BetterGI 的 29 个能力暴露给 agent |
| 计划任务 | Windows Task Scheduler；插件用它做「到点触发」和「错过补跑」 |
| reconcile | 插件每 60 秒扫一次运行目录，把新报告记账、通知、写进该游戏固定的汇报会话 |
| UAC | Windows 管理员授权弹窗；注册/删除计划任务需要一次 |
| dry / 演练 | 只做只读诊断并写报告，不操作游戏 |

---

## 18. 速查卡（写脚本时直接引用）

- 插件：`dsh-game-daily` 0.1.0 · MIT · <https://github.com/gychen-NJU/dsh-game-daily>
- 配套 MCP：`bettergi-mcp` 1.0.0 · <https://github.com/gychen-NJU/bettergi-mcp>
- 配套技能：`bettergi-control` · <https://github.com/gychen-NJU/bettergi-control>
- 设置页位置：设置 → 游戏日常（「用量统计」与「喵记忆」之间）
- 状态目录：`%USERPROFILE%\.dsh\game-daily\`
- 计划任务名：`game-daily-genshin` / `game-daily-hi` / `game-daily-sr`
- 本机排班：原神 11:00 · 崩坏3 10:00 · 星铁 10:30（每天、真实执行）
- 验证口令：`node test/smoke.mjs` → 11/11
- 一句话安装：见 §14
