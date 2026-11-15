# BetterGI 配方集（10 个，可直接照抄）

> 约定：`$S = %USERPROFILE%\.agents\skills\bettergi-control\scripts`；`<BGI> = D:\software\BetterGI`。
> 每个配方都**先跑前置检查**：`pwsh -File $S\bgi-status.ps1`（只读）。
> 需要改文件的配方：**先让用户从托盘退出 BetterGI**（运行中会被回写覆盖）。

---

## R1 启动原神 + 截图器（最常用）

**目标**：把游戏拉起来、截图链路就绪，但不跑任何任务。
**前置**：BetterGI 未运行；游戏未运行（或已运行也行）；不锁屏。
**命令**
```powershell
pwsh -File $S\bgi-run.ps1 -Mode start -Wait
```
**成功判据**：日志出现 `遮罩窗口已启动，游戏大小1920x1080`（尺寸应 ≥1920×1080 且 16:9）。
**失败处置**：UAC 无人点 → 提示用户确认；游戏没起来 → 检查 `genshinStartConfig.linkedStartEnabled` 与 `installPath`。
**红线**：不要用 `-Verb RunAs` 自己提权（BetterGI 会自提权，原进程 553 是正常）。

## R2 跑今日「一条龙」（日常）

**目标**：一条龙配置 `日常` 跑完整套（本机 = 领取邮件 → 合成树脂 → 领取每日奖励 → 自动秘境）。
**前置**：无实例在跑；包里**有晶核**（浓缩树脂用）；游戏内交互键 = F。
**命令**
```powershell
pwsh -File $S\bgi-run.ps1 -Mode oneDragon -Name 日常 -Wait
pwsh -File $S\bgi-watch.ps1 -Mode oneDragon -TimeoutMinutes 60
```
**成功判据**：日志出现 `一条龙和配置组任务结束`，且此前有 `合成"浓缩树脂"` / `匹配到战斗脚本：<名>` / `自动秘境：<树脂> 刷取 x/y`；无 `[ERR]`。
**失败处置**：见 `references\troubleshooting.md`；秘境失败不会影响已提前的"领取每日奖励"。
**红线**：`-Mode oneDragon` **不要**用 `task_progress` 文件判断成败（一条龙不写）。

## R3 跑一个配置组

**目标**：执行 `User\ScriptGroup\<组名>.json`（可含 JS/路径/键鼠/Shell 混合项）。
**前置**：组文件存在且 `status` 恰为 `Enabled`。
**命令**
```powershell
pwsh -File $S\bgi-group.ps1 -List                     # 先看有哪些组
pwsh -File $S\bgi-run.ps1 -Mode groups -Name '采集-星螺'
pwsh -File $S\bgi-watch.ps1 -Mode groups -TimeoutMinutes 60
```
**成功判据**：日志 `开始连续执行选中配置组:<组名>` + `log\task_progress\<14位>.json` 出现且最终 `endTime` 被填上（**注意**：有连续失败时 `endTime` 不写，看 `history[].status` 1成功/2失败）。
**失败处置**：`需要执行的配置组为空` = 组名写错（精确匹配）或 `status` 不是 `Enabled`。

## R4 续跑上一次没跑完的配置组

**命令**
```powershell
pwsh -File $S\bgi-run.ps1 -Mode progress -Name latest
```
**成功判据**：日志出现断点续跑的组名；`task_progress` 里 `next` 字段被消费后清空。

## R5 采集某种材料（现在可以一句话跑通）

**目标**：跑一条采集路线。
**前置**：`User\AutoPathing\` 下已存在该材料的路径文件——**没有也没关系**：用 MCP 的
`bgi_collect_material` 或下面的"找路线"命令，从官方仓库现拉（2026-10-16 起可用）。

**首选（MCP 工具，需 DSH 已加载 bettergi-mcp）**
```
bgi_collect_material {material:"星螺"}            # 官方仓库找路线 → 下载 → 生成配置组「采集-星螺」
bgi_run_groups {groups:["采集-星螺"]}             # 触发
bgi_watch {mode:"groups", timeout_minutes:60}     # 等收尾并判定
```

**脚本路径（等价，MCP 不可用时）**
```powershell
pwsh -File $S\bgi-collect.ps1 -List                      # 看本机已有路径
pwsh -File $S\bgi-collect.ps1 -Material 星螺 -Run        # 命中 → 生成 Pathing 配置组并触发
```
**路线从哪来**（官方仓库 `babalae/bettergi-scripts-list`）：
```
索引：https://raw.githubusercontent.com/babalae/bettergi-scripts-list/refs/heads/main/repo.json   （约 4.4 MB 目录树）
文件：<同一前缀>/repo/pathing/<分区>/<材料名>/<NN-…>.json       ← 注意文件在 repo/ 之下
落地：User\AutoPathing\<分区>\<材料名>\<文件名>.json（保持子目录）
```
实测：`星螺` → `pathing/地方特产/璃月/星螺/` 下 5 条（瑶光滩 17/12、归离原 14/4、孤云阁 9，共 56 个采集点）。
**成功判据**：日志出现路径执行与移动；`log\ExecutionRecords\<日期>.json` 里该 Pathing 项 `is_successful: true`（**这是 `is_successful` 唯一有真实含义的 type**）。
**失败处置**：官方仓库没有该材料（新版本）→ ① 用 BetterGI 的「路径记录」自己录一条（小地图锁定"锁定方向"、分辨率 ≥1080P、截图方式 BitBlt）；② 别人分享的路径文件直接拷进 `User\AutoPathing\`，或用 `-ExtraDirs` 指向它所在目录。
**红线**：**不要凭空生成路径 JSON**（坐标是录出来的，编的必错）。

## R6 写一个 JS 脚本并挂进配置组

**前置**：BetterGI 退出（要写 `User\JsScript\`）。
**步骤**
1. 建 `User\JsScript\<脚本名>\manifest.json`：
```json
{ "name": "自定义日常", "version": "1.0", "main": "main.js" }
```
2. 建 `User\JsScript\<脚本名>\main.js`（示例，API 详见指南第 7 章）：
```js
// 采集：跑 User\AutoPathing 下的路径
pathingScript.runFileFromUser("星螺.json");

// 或跑一个独立任务（示例：自动秘境）
// await dispatcher.runTask(new SoloTask("AutoDomain", { DomainName: "荒坠的圣迹", PartyName: "兹白月结晶" }));

// 或临时打开实时任务（只认这三个）
// dispatcher.addTrigger(new RealtimeTimer("AutoPick", { forceInteraction: false }));
```
3. 挂进配置组：
```powershell
pwsh -File $S\bgi-group.ps1 -Name '自定义日常' -Type Javascript -Target '<脚本名>' -Add
pwsh -File $S\bgi-run.ps1 -Mode groups -Name '自定义日常'
```
**坑**：脚本**运行期间实时触发器全部停用**（要拾取/剧情必须自己 `dispatcher.addTrigger`）；`file.*` 只能访问脚本目录内；`http` 需在配置组项里授权；脚本没有超时，跑飞只能靠停止快捷键。

## R7 换秘境 / 换队伍（改配置）

**前置**：BetterGI 退出。
```powershell
# 一条龙用的秘境与队伍（注意 -Set 用数组语法，不能重复写）
pwsh -File $S\bgi-config.ps1 -Set 'autoDomainConfig.partyName=兹白月结晶','autoDomainConfig.domainName=荒坠的圣迹' -DryRun
```
一条龙自己的队伍/秘境在 `User\OneDragon\<名>.json` 的 `PartyName` / `DomainName` / `DailyRewardPartyName`（`bgi-config.ps1` 只改 `config.json`；改一条龙文件请让 agent 用 edit 工具并**先退出程序**）。
**成功判据**：脚本回读校验通过（`-DryRun` 只显示将写什么）；下次跑时日志 `尝试切换至队伍: "<名>"` → `切换队伍成功`。
**失败处置**：`切换队伍失败` = 队伍名与游戏内不一致（按名字匹配，建议队伍名保持唯一、简洁）。

## R8 改树脂（例：只用浓缩，不用须臾/原粹/脆弱）

**前置**：BetterGI 退出。**注意 `-Set` 只能写一次**，多条用逗号连成数组（PowerShell 不允许重复参数）。
```powershell
pwsh -File $S\bgi-config.ps1 -Set `
  'autoDomainConfig.specifyResinUse=true', `
  'autoDomainConfig.condensedResinUseCount=5', `
  'autoDomainConfig.transientResinUseCount=0', `
  'autoDomainConfig.originalResinUseCount=0', `
  'autoDomainConfig.originalResin20UseCount=0', `
  'autoDomainConfig.originalResin40UseCount=0', `
  'autoDomainConfig.fragileResinUseCount=0'
```
**成功判据**：日志 `→ "自动秘境，" 指定使用树脂`，并按 `浓缩树脂 / 须臾树脂` 的顺序刷。
**失败处置**：出现 `用尽所有浓缩树脂和原粹树脂后结束` = 还在"用尽模式"（`specifyResinUse` 没生效/没重启）；出现 `刷取次数过多` = 次数 > 实际持有。**只想用浓缩**：只留 `condensedResinUseCount`，须臾/原粹/脆弱全置 0。

## R9 查"今天跑成没 / 为什么失败"

```powershell
pwsh -File $S\bgi-status.ps1 -TailLines 30          # 总览 + 日志尾巴
pwsh -File $S\bgi-watch.ps1 -Mode oneDragon -TimeoutMinutes 1   # 只读判定（不等则立即出结论）
# 或直接看：
#   <BGI>\log\better-genshin-impact<yyyyMMdd>.log 的 [ERR] 行（下一行是正文）
#   <BGI>\log\task_progress\*.json       （配置组路径才有）
#   <BGI>\log\ExecutionRecords\<日期>.json（Pathing 项目看 is_successful）
```
**判据口径**：成功 = 有收尾事件 + 无 `[ERR]` + 关键步骤日志齐全；**不要**用 `task.cancel` 判失败（正常结束也会发）。

## R10 备份与回滚

**命令**
```powershell
# 备份（agent 侧，任何写操作前）
$bk = "D:\software\BetterGI\_backup_$(Get-Date -Format yyyyMMdd_HHmmss)"
New-Item -ItemType Directory -Force -Path $bk | Out-Null
Copy-Item 'D:\software\BetterGI\User\config.json','D:\software\BetterGI\User\OneDragon\*.json' -Destination $bk -Force
# 回滚：先退出 BetterGI，再把备份覆盖回去
```
**红线**：`User\` 整个目录是用户数据（配置组/脚本/策略/队伍），**任何"重装"前先备份它**；`log\` 与 `User\` 是安装器保留目录。
