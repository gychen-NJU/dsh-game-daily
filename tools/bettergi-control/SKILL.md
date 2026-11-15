---
name: bettergi-control
description: 用自然语言指挥本机 BetterGI（更好的原神）完成自动化：启动原神与截图器、跑「一条龙」日常、跑配置组、采集材料、打秘境、改配置与队伍、查任务进度与失败原因。当用户说"启动原神""跑日常/一条龙""采集 XX 材料""打 XX 秘境""帮我改 BetterGI 配置/队伍/树脂""看看今天任务跑成没/为什么失败"等，或提到 BetterGI、更好的原神、自动秘境、自动采集、自动拾取、自动剧情时使用。本机已安装 0.66.0 于 D:\software\BetterGI，配套指南见工作区 docs\BetterGI-Agent-使用指南.md。
---

# BetterGI 指挥台（本机已装好并跑通）

**本机实证**（2026-10-15）：BetterGI **0.66.0** 免安装版装在 `D:\software\BetterGI`；一条龙配置 `日常`（领取邮件 → 合成树脂 → 领取每日奖励 → 自动秘境）已跑通（19:57–20:07 那次完整成功：合成树脂 ✓、秘境命中「万能战斗策略（萌新推荐）」刷 4 轮 ✓、每日奖励「今日奖励已领取」✓）；Windows 计划任务 `BetterGI 日常一条龙` 每天 **08:00** 自动跑，DSH 每天 **08:40** 汇报结果。
本 skill 的 16 个脚本均已实机验证：语法/BOM（UTF-8 带 BOM，PS 5.1）、只读路径全部退出码 0、`-DryRun` 不产生副作用、验收前后 `User\config.json` 与 `User\OneDragon\日常.json` 哈希不变。
**完整文档**（5266 行，第 10 章配方 / 第 11 章排障 / 第 12 章速查）：`<dsh-betterGI 工作区>\docs\BetterGI-Agent-使用指南.md`

---

## §0 开工三件事（每次动手前都做）

1. **看状态**：`bgi-status.ps1`（只读）。
   - BetterGI **正在运行** → **任何写配置/写配置组/写一条龙的操作都必须先请用户退出**（运行中它会把自己内存里的配置**回写覆盖**你的修改，本会话实测踩过）。
   - 原神**正在运行**但用户要求"启动游戏" → 先问清楚是不是要重启。
2. **看前置**：脚本会报告 4 个阻断项 —— 进程状态、窗口是否 16:9 且 ≥1920×1080（自动秘境/自动寻路硬要求）、`autoPickConfig.pickKey` 是否 F（BetterGI 只认 **E/F/G/L** 四个带模板图的键）、截图方式是否 `BitLlt`→`BitBlt`。
   **分辨率这一项能自愈**（2026-10-26 起）：`bgi-close.ps1 -Target both` → `bgi-set-resolution.ps1 -Apply -StartGame -Verify`（改 `HKCU\Software\miHoYo\原神` 的 Screenmanager 三键 + 补 `HIGHDPIAWARE` DPI 覆盖，带备份/回滚/实测复核）。复核 exit 0 再跑任务，别让用户自己去点设置。**无人值守可用**：写注册表不需提权；启动未提权时自动走「BetterGI 按需执行」计划任务，不弹 UAC（详见 §4-9）。
3. **看意图**：是要**执行**（触发任务）还是**改配置**（写文件）还是**排错**（读日志）。三者顺序不同，见 §2。

## §1 能力边界（先认清，别承诺做不到的事）

| 能做 | 怎么做到 |
| --- | --- |
| 启动原神 + 截图器 | `BetterGI.exe start`（`linkedStartEnabled`/`autoEnterGameEnabled` 已开，会自动拉起游戏并进游戏） |
| 跑「一条龙」 | `BetterGI.exe startOneDragon <配置名>`（本机配置名：`日常`） |
| 跑配置组（可编排任意任务） | 写 `User\ScriptGroup\<组>.json` → `BetterGI.exe --startGroups <组名>` |
| 采集/锄地/挖矿 | 本质是**地图追踪路径**：`User\AutoPathing\*.json` + 配置组（type=Pathing）或 JS `pathingScript.runFileFromUser(...)` |
| 打秘境/地脉/首领/七圣召唤/音游 | 通过配置组 + JS `dispatcher.runXxxTask(...)`，或改一条龙配置后用 `startOneDragon` |
| 改配置/队伍/树脂/任务顺序 | 退出 BetterGI 后改 `User\config.json` 或 `User\OneDragon\*.json`（脚本自动备份、校验、回读） |
| 查进度与失败原因 | `log\better-genshin-impact<yyyyMMdd>.log` + `log\task_progress\*.json` + `log\ExecutionRecords\*.json` |
| **修正窗口分辨率（16:9 且 ≥1920×1080）** | `bgi-set-resolution.ps1`：写 `HKCU\Software\miHoYo\原神` 的 Screenmanager 三键（宽/高/全屏=0）+ 补 `HIGHDPIAWARE` DPI 覆盖；要求游戏与 BetterGI 先退出；`-Apply` 自动备份、`-Restore` 回滚、`-Verify` 用 GetClientRect+GetDpiForWindow 实测客户区 |

| **做不到（别硬承诺）** | 原因 |
| --- | --- |
| 通过 HTTP/API 调用任何东西 | BetterGI **没有服务端**（`HttpListener/TcpListener/Kestrel` 全库 0 命中） |
| 命令行直接启动**单个独立任务** | 命令行只有 5 个动作，只能拉起"一条龙"或"配置组"；单任务必须包成配置组/JS |
| 暂停 / 继续 / 取消任务 | 无外部接口；只能靠游戏内快捷键（`cancelTaskHotkey` 默认**空**，建议让用户绑一个） |
| 运行中改配置生效 | 无文件监听 + 会回写覆盖 → 必须退出后改 |
| 凭空生成一条采集路线 | 路径是录制出来的游戏内坐标序列；没有路径文件就只能给获取/录制指引 |
| 用 `task.cancel` 判断失败 | 它的显示名是"任务启动"，**正常结束也会发**；判失败用 `task.error` |

## §2 标准闭环（执行类）

```
① bgi-status.ps1                       # 状态 + 前置检查
② 需要改配置？→ 请用户退出 BetterGI → bgi-config.ps1 / bgi-group.ps1（自动备份）
③ bgi-run.ps1 -Mode oneDragon|groups -Name <名>     # 触发（立即返回；已运行实例会拒绝）
④ bgi-watch.ps1 -Mode oneDragon|groups -TimeoutMinutes 60   # 观测到结束
⑤ 汇报：结论 + 证据行（日志原文/进度字段）+ 失败时的下一步
```

**关键判定**：`bgi-watch.ps1` 的退出码 **0=成功 / 1=失败 / 2=超时未完成**；汇报时必须带日志证据行，不要只说"跑完了"。

## §2.5 首选路径：直接用 MCP 工具（对话原生调用）

本机已注册 BetterGI 的 MCP 服务器（`tools/bettergi-mcp/bettergi-mcp.mjs`，13 个工具）。
**如果工具列表里能看到 `mcp__bettergi__*`，优先用它们**——比手敲脚本更稳（参数校验 + 结构化返回）：

| 想做什么 | 调哪个工具 |
| --- | --- |
| **开跑前体检** | `bgi_doctor`（安装/配置、窗口就绪、显示与 DPI、资源分辨率、路线资产、**配置组→文件完整性（含 JS 的 manifest）**、**资产版本门禁**、**JS 图片资产魔数**、一条龙、闭环件） |
| **一句话采集（一步到位）** | `bgi_collect_now {material:"星螺", confirm:true}`（先 `dry_run:true` 预览；会准备路线+窗口、触发、轮询到"真的开始跑了"） |
| **免 UAC 触发**（可选一次性安装） | `D:\software\BetterGI\_setup_ondemand_task.ps1`（装最高权限「BetterGI 按需执行」任务）→ 之后 `bgi-run.ps1` 自动走"写 `_run_request.json` + `Start-ScheduledTask`"，**不再弹 UAC**；未安装时它会明确提示"会弹一次 UAC" |
| **确认真的跑起来了** | `bgi_wait_milestone {milestone:"domain_entered"}`（capturer_ready / group_started / script_finished / finished / any_error…） |
| **查"为什么失败"** | `bgi_log_search {levels:["ERR"]}` / `{pattern:"未匹配到任何战斗脚本", task:"自动秘境"}`（条件之间是 AND） |
| **查"跑成没、采了多少"** | `bgi_results`（每条路线成败+耗时+失败清单；`{material:"星螺"}` 只看某材料） |
| **查调度** | `bgi_schedule_info`（下次几点跑、上次返回码、今天跑没跑、配置组接进流程没有） |
| **断点续跑** | `bgi_run_task_progress {name:"采集-星螺"}`（或 latest） |
| 看状态 | `bgi_status`（含 `gameWindow.readyForTask`：可见+前台+16:9≥1080P） |
| 让游戏可见/在前台 | `bgi_focus_game`（还原最小化 + 置前；`no_focus` 只还原） |
| 启动原神 | `bgi_start_game` |
| **关掉游戏 / BetterGI** | `bgi_close {target:'game'|'both', confirm:true}`（改配置前必须先退出 BetterGI） |
| 跑某个官方 JS 脚本（自动委托/树脂/纪行…） | `bgi_list_js_scripts` → `bgi_run_js {name, run:true}` → `bgi_js_settings {name, set:{...}}` 配参数 |
| 把配置组接进每日一条龙 | `bgi_add_group_to_onedragon {group, confirm:true}` |
| **新建一条龙配置**（复制现有配置改任务顺序） | `bgi_create_onedragon {config, from:'日常', tasks:[...]}`（按 Name 判重，重名直接拒绝） |
| 跑日常一条龙 | `bgi_run_one_dragon {config:"日常"}` |
| 采集某材料（**一句话闭环**） | `bgi_collect_material {material:"星螺"}` → `bgi_run_groups {groups:["采集-星螺"]}` → `bgi_watch {mode:"groups"}` |
| 看/改配置 | `bgi_list_strategies` · `bgi_set_config {changes:[{path,value}], dry_run:true}` · **`bgi_set_onedragon`（改秘境/队伍/地区/收工动作/任务顺序）** |
| 找路线/浏览仓库 | `bgi_find_routes {material}` · `bgi_repo_index {kind:"pathing"}` |

**注意**：MCP 工具名里的 `mcp__bettergi__` 前缀说明它在 DSH 启动时已加载；若看不到，说明 DSH 还没重启（profile 配置只在启动时读），此时退回 §3 的脚本路径，效果等价。

**长任务一律"发起 → 轮询"**：本机 MCP 单次请求约 60 秒上限，所以会等的参数都被夹在 50 秒内。
`bgi_run_groups` / `bgi_run_one_dragon` / `bgi_start_game` 都是**立即返回**（"已发起"），
成败靠反复调 `bgi_watch`（默认立即返回；`wait_seconds:50` 可在单次调用内轮询 50 秒）。
`verdict: incomplete` 表示"还没收尾"，**不是失败**——隔一会儿再调一次；只有 `failed` 才是失败。

`bgi_collect_material` 的工作方式：在官方仓库 `babalae/bettergi-scripts-list` 的 `repo.json` 索引里找
**位于同名目录下**的路线（如 `pathing/地方特产/璃月/星螺/*.json`），下载到 `User\AutoPathing\`（保持子目录，
文件名实际在仓库的 `repo/` 之下），逐个校验 `info`+`positions` 后生成配置组 `采集-<材料>`。
`run=true` 才会真的触发，且会先做前置检查（BetterGI 在运行 → 直接给指引而不是白跑）。

**没有 MCP 时的等价链路**（skill 自足，任意会话可用）：
```
pwsh -File $S\bgi-fetch-route.ps1 -Material 星螺 -Download   # 官方仓库检索 + 下载 + 校验路径点
pwsh -File $S\bgi-collect.ps1 -Material 星螺 -Run            # 生成配置组「采集-星螺」并触发
pwsh -File $S\bgi-watch.ps1 -Mode groups -TimeoutMinutes 60  # 观察判定
```

## §3 脚本清单（都在 `scripts\`，PS 5.1，UTF-8 带 BOM）

| 脚本 | 用途 | 主要参数 | 退出码 |
| --- | --- | --- | --- |
| `bgi-status.ps1` | **只读**状态总览：进程/窗口/config 关键值/一条龙配置/最新日志尾部/进度文件 | `-Root` `-Json` `-Raw` `-TailLines 20` | 0=正常，2=安装根缺失 |
| `bgi-run.ps1` | 触发：`start` / `oneDragon` / `groups` / `progress` | `-Mode` `-Name` `-Wait` `-DryRun` | 0=已发起，2=前置不满足（含"已有实例在运行"），1=启动失败 |
| `bgi-watch.ps1` | 观测并判定成败（只认**本次运行**的 ERR；更早的 ERR 单独列出不计入） | `-Mode oneDragon\|groups` `-TimeoutMinutes 60` `-DryRun` `-SinceMinutes 180` `-Json` | 0=成功，1=失败，2=超时/未结束。**⚠ 不带 `-DryRun` 会一直阻塞到跑完（默认最多 60 分钟）**——只想"看一眼现在什么情况"务必加 `-DryRun`；在 agent 里优先用 MCP 的 `bgi_watch`（默认立即返回） |
| `bgi-config.ps1` | 安全改 `User\config.json` | `-Set 'a.b.c=值','d.e=值'`（**数组语法，不能重复写 -Set**）`-DryRun` | 0=已改并回读一致，2=程序在运行/路径不存在，1=写失败 |
| `bgi-group.ps1` | 生成/列出配置组 | `-Name` `-Type Javascript\|Pathing\|KeyMouse\|Shell` `-Target` `-Add` `-List` `-DryRun` | 0=成功，2=前置不满足 |
| `bgi-strategy.ps1` | 战斗策略：列出/预测选中/语法校验 | `-List` `-Simulate -Team a,b,c` `-Validate <file>` | 0=通过，1=校验失败 |
| `bgi-collect.ps1` | 材料 → **本机**路径索引（+可选触发采集） | `-Material 名` `-List` `-ExtraDirs` `-Run` `-DryRun` | 0=命中，1=未命中，2=前置不满足 |
| `bgi-fetch-route.ps1` | 材料 → **官方仓库**检索/下载路线（MCP 不可用时的替代） | `-Material 名` `-Kind pathing\|js\|combat\|tcg` `-Download` `-All` `-Overwrite` `-RefreshIndex` | 0=命中，1=未命中，2=参数/网络问题 |
| `bgi-focus-game.ps1` | **跑自动化前的窗口准备**：还原最小化 + 置前 + 回报尺寸/前台 | `-ProcessName YuanShen` `-NoFocus` `-Json` | 0=可跑（可见+前台+16:9≥1080P），1=未完全就绪，2=游戏没窗口 |
| `bgi-set-resolution.ps1` | **分辨率自愈**：把游戏写成 16:9 ≥1080P（注册表三键 + DPI 覆盖），带备份/回滚/实测复核；未提权时自动走按需计划任务启动（免 UAC） | `-Width 1920` `-Height 1080` `-Fullscreen 0` `-Apply` `-Restore` `-StartGame` `-DirectStart` `-StartMode Auto` `-Verify` `-DryRun` `-Json` `-WaitSeconds 150` | 0=已达成/已写入并复核通过，1=前置不满足（游戏或 BetterGI 在跑/注册表键缺失/exe 找不到/无备份），2=写入或复核失败 |
| `bgi-doctor.ps1` | **开跑前体检**（只读，一次性审完能不能跑） | `-Root` `-Json` `-Material 星螺` | 0=就绪，1=有警告，2=有阻断 |
| `bgi-log.ps1` | **日志定向检索**（按级别/正则/时间窗/任务过滤，带行号与正文） | `-Pattern` `-Level ERR,WRN` `-SinceMinutes` `-Tail` `-Task` `-Json` | 0=有命中，1=无命中，2=日志不存在 |
| `bgi-schedule.ps1` | **调度总览**（计划任务/包装器日志/一条龙/配置组/最近收尾） | `-Root` `-Runs 5` `-Json` | 0=正常，1=有提示 |
| `bgi-wait.ps1` | **等里程碑**（确认任务真的跑起来，而非只是"已发起"） | `-Milestone capturer_ready\|group_started\|domain_entered\|finished\|any_error` `-Pattern` `-TimeoutSeconds ≤50` `-SinceMinutes` `-Json` | 0=等到，1=超时，2=日志不存在 |
| `bgi-close.ps1` | **关闭原神 / BetterGI**（先优雅、必要时强制；权限不足会明说） | `-Target game\|bettergi\|both` `-Force` `-DryRun` `-GraceSeconds` `-Json` | 0=已全部关掉，1=仍有存活（权限不足） |
| `bgi-results.ps1` | **战果统计**（每条路线成败/耗时/失败清单 + 刷取统计 + 续跑进度） | `-Date today\|yesterday\|yyyyMMdd` `-Days N` `-Group` `-Material` `-Json` | 0=有记录，1=无记录，2=日期非法 |

所有脚本统一：**先检查进程**；`-Json` 出机器可读结果。
**中文参数**（组名/配置名/队伍名/材料名）调用时用单引号包住，例如：`bgi-run.ps1 -Mode groups -Name '采集-星螺'`。
索引缓存：`$env:TEMP\bgi-repo-cache.json`（6 小时；`-RefreshIndex` 强制重拉）。

## §4 常用配方（详见 `references\recipes.md`）

1. 启动原神并进游戏 → `bgi-run.ps1 -Mode start -Wait`
2. 跑今日日常 → `bgi-run.ps1 -Mode oneDragon -Name 日常 -Wait` + `bgi-watch.ps1 -Mode oneDragon`
3. 跑某配置组 → `bgi-run.ps1 -Mode groups -Name '<组名>'`
4. 采集某材料 → 先 `bgi-collect.ps1 -Material 星螺 -DryRun` 预览，再 `bgi-collect.ps1 -Material 星螺 -Run`
5. 换秘境/换队伍/改树脂次数 → `bgi-config.ps1`（`autoDomainConfig.*`）+ `User\OneDragon\*.json`
6. 写 JS 脚本并挂进配置组 → `User\JsScript\<名>\`(manifest+main) + `bgi-group.ps1 -Add`
7. 查今天跑成没 / 为什么失败 → `bgi-watch.ps1` + `references\troubleshooting.md`
8. 换一套战斗策略 → `bgi-strategy.ps1 -List/-Simulate/-Validate`
9. **分辨率不对（非 16:9 / <1080P）→ 自愈**：`bgi-close.ps1 -Target both` → `bgi-set-resolution.ps1 -Apply -StartGame -Verify`（`-Verify` 输出 `窗口实测：1920x1080（原始 1280x720，DPI 144）` 且 exit 0 才算过）。
   **无人值守链路（睡觉跑日常就是这条）**：`-Apply` 只写 HKCU，不需要提权；`-StartGame` 在未提权上下文会自动改走 `RunLevel=Highest` 的「BetterGI 按需执行」计划任务（请求文件 `_run_request.json` + `Start-ScheduledTask`），**由任务计划服务提权、不弹 UAC**；`-StartMode Auto|Process|Task` 可强制指定。`bgi-close.ps1` 遇到 `Access is denied` 也会自动落到该任务的 `{mode:"stop"}`（同样无 UAC）。而夜间由 `game-daily-genshin` 计划任务（RunLevel=Highest）拉起 agent 时，agent 自己就是提权上下文，直接 `Start-Process` 也不弹框——全链路零人工。

## §5 红线（违反会白跑或伤账号）

1. **不改游戏文件、不读写游戏内存**；不手改路径里的 `bgi_version` 绕过校验。
2. **运行中不改配置**（会被覆盖）——先让用户从托盘退出。
3. **不跑未审计的第三方脚本**（脚本仓库来源可能是别人的私服/外挂逻辑）。
4. **别承诺"后台挂机"**：本机客户端必须保持原神**可见且前台**（其他窗口抢焦点 → `当前获取焦点的窗口为: X，不是原神，暂停`）；锁屏会导致截图黑屏。窗口准备用 `bgi-focus-game.ps1` / MCP 的 `bgi_focus_game`（内部用 **`SwitchToThisWindow`**——实测 `ShowWindow(SW_RESTORE)`/`SetWindowPlacement`/`ShowWindowAsync` **对原神窗口全部无效**；分辨率不足或非 16:9 用 `bgi-set-resolution.ps1` 自愈—— `-Apply` 改注册表三键 + 补 DPI 覆盖，`-StartGame` 拉起，`-Verify` 实测客户区；别再让用户自己去点设置）。
5. 日志与截图可能含账号隐私（UID、昵称、游戏画面）——外发前先确认。
6. **账号风险由使用方式决定**：官方用户条款把第三方软件/模拟操作列为封号理由之一，低调使用。

## §6 现实约束（本机已核实，写在这里省得每次重查）

- `User\AutoPathing` **已有内容**（2026-10-16 起）：`地方特产\璃月\星螺\*.json` 5 条路线由
  `bgi_collect_material` 从官方仓库下载（瑶光滩 17/12、归离原 14/4、孤云阁 9，共 56 个采集点），
  配置组 `采集-星螺` 已就绪；其他材料同理可用该工具现场拉取。`User\ScriptGroup` 同样不再为空。
- 官方仓库结构：`repo.json`（约 4.4 MB 的目录树索引）在仓库根，**文件实际在 `repo/<分区>/…`**
  （分区：pathing / js / combat / tcg）；落地映射（源码 `ScriptRepoUpdater.PathMapper`）：
  `pathing→User\AutoPathing`、`js→User\JsScript`、`combat→User\AutoFight`、`tcg→User\AutoGeniusInvokation`。
  CNB 镜像（cnb.cool）在本机 DNS 失败 → 走 GitHub raw。
  **注意**：`repo.json` 索引里 **`js/` 只有目录、没有文件条目**（实测 0 个 file），要装 JS 脚本得用
  git trees API（`/git/trees/main?recursive=1`，一次拿全仓文件路径，缓存 6h）。
- **JS 脚本是能力最强的扩展面**：官方仓库有 144 个（`AutoCommission` 自动每日委托、
  **`使用历练点完成每日委托`（已装，2026-10-16）**、`AutoRefinedCondensationResin`、纪行周常、尘歌壶一条龙…）。
- **配置组与一条龙的关系**（源码 `OneDragonFlowViewModel.cs:672-675`）：一条龙运行配置组任务时读
  `User\ScriptGroup\<任务名>.json` 再 `RunMulti(GetNextProjects(group))`；任务必须登记在
  `TaskEnabledList`（`TaskDefinitions` 给 GUID→名字，`TaskOrder` 给顺序）里才会跑——
  **没登记的配置组（如按需的 `采集-星螺`）不会污染每日流程**。
- 采集路线是**录制出来的游戏内坐标序列**，不能凭空生成；官方仓库没有的材料（新版本）要自己录。
- 内置 `GameTask\AutoLeyLineOutcrop\Assets\pathing\**`（632 个 json）是**地脉花点位**，不是采集路线。
- 一条龙**不写** `log\task_progress\`（只有调度器/`--startGroups`/`--TaskProgress` 路径写），所以 `-Mode oneDragon` 的判定只看日志与通知。
- 计划任务 `BetterGI 日常一条龙`（**09:00**，最高权限 + 唤醒，动作＝包装器 `_daily_runner.ps1`）与 DSH **09:40** 汇报已在运行——**改动它们要先问用户**。
- 桌面快捷方式 `日常一条龙.lnk` 仍是裸调用（挂着 BetterGI 时点它无效）；要"忘关也能跑"用包装器。

## §7 版本自检（长期维护用）

1. `(Get-Item 'D:\software\BetterGI\BetterGI.exe').VersionInfo.ProductVersion` 应为 `0.66.x`。
2. `User\config.json` 顶层键与本 skill 提到的键做差集；出现未知键或缺失键 → 先复核本 skill 与指南。
3. 任一处不符：先跑 `bgi-status.ps1` 与 `bgi-strategy.ps1 -List` 看结构是否变化，再决定是否更新脚本，不要凭猜改配置。
