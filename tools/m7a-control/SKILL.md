---
name: m7a-control
description: 用自然语言指挥本机「三月七小助手 / March7thAssistant / M7A」完成崩坏：星穹铁道（星铁 / 崩铁 / 星穹铁道）自动化：查安装与状态、跑完整运行（日常+清体力）、每日实训、清体力、差分宇宙、货币战争、模拟宇宙、锄大地、混沌回忆/虚构叙事/末日幻影、兑换码、更新小助手，改 config.yaml，读运行记录与日志、排查失败。当用户说「清星铁日常 / 崩铁日常 / 每日实训 / 清体力 / 打差分 / 锄大地 / 领兑换码 / 小助手跑一下 / 三月七 / M7A / 自动化跑崩铁」时使用。本机已安装 v2026.10.31（路径以 doctor 的 root 为准）。游戏操作全部由小助手完成，agent 只负责安装/运行/改配置/读结果/排障。
---

# 三月七小助手指挥台（M7A / March7thAssistant）

**本机实证（2026-11-02）**：小助手 **v2026.10.31** 安装在 `E:\software\March7thAssistant`（安装登记与状态指针都指向它；当天早些时候由 `C:\Users\13676\Games\March7thAssistant` 整体迁移而来），
`m7a.exe` 可用、`--status --json` 正常、`game_path = E:\Star Rail\Game\StarRail.exe`、`first_run_completed = true`。
`scripts\m7a.ps1` 已在本机实测：未安装时返回 `M7A_NOT_INSTALLED`、已安装时 doctor 全绿、
`run / run -Detach / follow / control / logs` 与退出码 0/1/2/3/4/5/6 均已用假 m7a 夹具覆盖。

**分工**：M7A 负责在游戏里点；本技能负责「找到它、让它跑、改它的配置、读它的结果、失败时定位」。

---

## §0 开工三件事（每次动手前都做）

1. **看状态**（只读，2–3 秒）：
   ```powershell
   & "$env:USERPROFILE\.agents\skills\m7a-control\scripts\m7a.ps1" -Action doctor
   ```
   仓库内开发时用 `tools\m7a-control\scripts\m7a.ps1`。
   `blockers` 非空先解决 blocker，不要带着 blocker 起任务。
2. **分清意图**：**执行**（`run`）/ **改配置**（编辑 `config.yaml`）/ **排障**（读 `logs\runs\*.json` + 当天日志）。三者顺序不同，见 §2、§2.5。
3. **别重复起任务**：`status.active_run` 非空或 `gui_running: true` 且用户刚跑过 → 先确认再动。
   已有任务在跑时 `run` 会返回退出码 4，不要用 `-Force` 硬顶（M7A 自己是单实例锁）。

---

## §1 能力边界（先认清，别承诺做不到的事）

| 能做 | 怎么做 |
| --- | --- |
| 找安装、报版本/路径 | `m7a.ps1 -Action doctor`（`source` 说明从哪找到的） |
| 跑任务并拿真实退出码 | `-Action run -Task <id>`（前台等待，`--after-finish None --json`） |
| 起长任务后立刻返回 | `-Action run -Task <id> -Detach`，再用 `status` / `follow` / `logs` 轮询 |
| 跟随输出 / 读日志 | `-Action follow -Run latest`、`-Action logs [-Run latest]` |
| 暂停 / 继续 / 停止 | `-Action control -ActionName pause\|resume\|stop`（对 GUI 起的任务也有效） |
| 改配置 | 直接编辑 `<root>\config.yaml`（见 §2.5，先备份、只改需要的键） |
| 查失败原因 | `logs\runs\<runId>.json` 的 `status/reason/error/screenshot` + `logs\runs\<runId>.log` + `logs\<日期>.log` |

| 做不到（别硬试） | 原因 / 替代 |
| --- | --- |
| 替用户确认免责声明 | 退出码 3 / `first_run_required`，必须**用户本人**在 `March7th Launcher.exe` 里确认 |
| 替你点 UAC 弹窗 | 退出码 5；运行任务时会弹一次，无人值守请改用小助手自带定时任务 |
| 在游戏里做 M7A 任务表以外的操作 | 小助手只做它支持的任务；新玩法等它更新 |
| 通过 HTTP / API 控制 | 小助手没有服务端，只有命令行 |
| 运行中改配置并立即生效 | 正在跑的任务不读新值；等它结束或下次运行 |
| 无 UI 的确定性进度查询 | `--follow` 是输出流；程序化轮询请读 `logs\runs\<runId>.json` 的 `status` |

---

## §2 标准闭环（执行类）

```powershell
$m7a = "$env:USERPROFILE\.agents\skills\m7a-control\scripts\m7a.ps1"

& $m7a -Action doctor                                   # ① 体检：blockers 为空再继续
& $m7a -Action run -Task main -Detach                   # ② 起任务（长任务用 -Detach）
& $m7a -Action follow -Run latest -TimeoutSeconds 300   # ③ 跟一段输出（超时只是本次窗口到点）
& $m7a -Action status                                  # ④ 看 active_run + recent_runs
& $m7a -Action logs -Run latest -Lines 40              # ⑤ 读本次运行日志结尾
```

**判定**：`run` 的退出码即 M7A 的退出码（0 成功 / 1 失败 / 3 首次未确认 / 4 忙 / 5 UAC / 6 被停止）。
`-Detach` 后以 `logs\runs\<runId>.json` 的 `status` 为准（`success / failed / blocked / stopped / interrupted / running`）。

**汇报纪律**：结论 + 证据行（`runId`、`status`、`exit_code`、日志原文），失败时给出 `screenshot` 路径与下一步；
把「日志里看到的事实」和「推测」分开写。

---

## §2.5 改配置闭环

1. **备份**：`Copy-Item <root>\config.yaml <root>\config.yaml.bak-<yyyyMMdd-HHmmss>`。
2. **先查注释**：在 `<root>\assets\config\config.example.yaml` 找同名键，读它的中文注释与可选值；不要凭记忆猜键名。
3. **最小改动**：只改需要的键，保留缩进与其余内容/注释，**不要整份重写**（YAML 很容易写坏）。
4. **复核**：`& $m7a -Action doctor` 看 `config.values` 是否读回预期值；`config.ok=false` 说明 YAML 解析失败。
5. 正在运行的任务不会读新值；提示用户下次运行（或重启 GUI）生效。

常用键：`game_path`、`auto_set_game_path_enable`、`auto_set_resolution_enable`、`daily_enable`、`power_enable`、
`after_finish`、`pause_after_success`、`exit_after_failure`、`scheduled_tasks`。
更细的（体力计划 `power_plan`、推送、定时）见 `references/commands-and-paths.md` 与官方
`assets\agent\skills\march7th-assistant\references\config.md`。

**红线**：`after_finish` 不要擅自设成 `Shutdown/Sleep/Hibernate`；命令行发起的运行一律带 `--after-finish None`（脚本已内置）。
推送令牌 / CDK / 账号等敏感值**不要**在对话里显示；需要填写时请用户在图形界面输入。

---

## §3 脚本清单（单文件 `scripts\m7a.ps1`，PS 5.1，ASCII/UTF-8 无 BOM）

```
m7a.ps1 -Action doctor   [-Root <dir>]
m7a.ps1 -Action status   [-Tasks] [-Root <dir>]
m7a.ps1 -Action run      -Task <id> [-Detach] [-AfterFinish None] [-TimeoutMinutes 60] [-Force] [-Root <dir>]
m7a.ps1 -Action follow   -Run latest|<runId> [-FromLog] [-TimeoutSeconds 300] [-Lines 40] [-Root <dir>]
m7a.ps1 -Action control  -ActionName pause|resume|stop [-Root <dir>]
m7a.ps1 -Action logs     [-Run latest|<runId>] [-Lines 40] [-Root <dir>]
```

- 统一输出**一个 JSON 对象**（`ConvertTo-Json -Depth 6 -Compress`）；失败为 `{ ok:false, error, hint }`。
- 退出码：`0` 成功；`1` 内部错误 / 输出不可解析 / 启动失败 / 参数错误；`2` 未安装 / `-Root` 无效 / 前置条件不满足（含 run 超时）；
  `run` 额外**透传** m7a 的 0–6（前置失败时返回 2/3/4）。
- 定位顺序（与插件 `lib/m7a.mjs` 一致）：`-Root` → 环境变量 `DSH_GAME_DAILY_M7A_ROOT` / `M7A_ROOT` →
  `<stateDir>\m7a-root.txt` → `%LOCALAPPDATA%\March7thAssistant\installs.json` → 常见目录。**不做全盘搜索**。
  `doctor.root` + `doctor.source` 会告诉你是哪一路命中的；找不到时 `searched` 列出试过的路径。

各 action 的关键字段：

| action | 关键字段 |
| --- | --- |
| doctor | `ok root source exe version files{9} status statusExitCode config{ok,file,values,scheduledTasksBlock,error} todayLog{ok,file,lines,error} recentRuns[] checks[7] blockers[] warnings[] deepCheck{firstRunOk,gamePathOk,activeRun}` |
| status | `ok root version exitCode activeRun status{...原样 --status JSON...}`；`-Tasks` 追加 `tasks[]`、`tasksExitCode` |
| run | `ok taskId detach afterFinish exitCode timedOut durationSec meaning{status,label} record{...}`；`-Detach` 加 `outputTail`、`hint`；超时加 `m7aProcessId` |
| follow | `ok run mode(follow\|log) exitCode timedOut count lines[]` |
| control | `ok control exitCode meaning outputTail` |
| logs | `ok scope(today\|run) run file lines[] count` |

> 配套（可选）：`tools/m7a-mcp/` 是同一能力的 MCP 封装，供对话里直接调用；本脚本不依赖它，命令行更稳、可脚本化。
> 插件「依赖体检」只认 `tools/m7a-control/SKILL.md` 是否存在（`lib/deps.mjs` 的 `checkM7aSkill`），与脚本无关。

退出码→含义（脚本内 `meaning.status` 同值）：`0 success`、`1 failed`、`2 bad-args`、`3 first-run-required`、
`4 busy`、`5 no-uac`、`6 stopped`。完整命令表与路径表见 `references/commands-and-paths.md`。

---

## §4 常用配方

1. **本机首跑（已确认免责声明后）**：`doctor` → 若 `blockers` 为空 → `run -Task main -Detach` → `follow -Run latest` → 收尾读 record。
2. **每日一条龙**：`run -Task main`（= 日常任务 + 奖励领取 + 清体力，具体受 `daily_enable` / `power_enable` 控制）。
   用户只要「清体力」→ `run -Task power`；只要「每日实训」→ `run -Task daily`。
3. **周常**：`divergent`（差分宇宙）、`currencywars`（货币战争）、`universe`（模拟宇宙）、`fight`（锄大地）、
   `forgottenhall` / `purefiction` / `apocalyptic`（三深渊）。
4. **兑换码**：`run -Task redemption`（兑换码来源由小助手配置决定，别代填账号）。
5. **更新小助手**：`run -Task app_update`；不要用完整包覆盖已有安装（会丢配置与登录态）。
6. **失败排障**：`logs -Run latest` → 没有结论再读 `logs\runs\<runId>.json` 的 `error`/`screenshot` 与当天 `logs\<日期>.log`，
   原因与修复见 `references/install-and-troubleshoot.md`。
7. **想停掉正在跑的任务**：`control -ActionName stop`（任务在下一次键鼠操作前结束，退出码 6；游戏保持打开）。
8. **换游戏路径**：改 `game_path`（§2.5），或打开 `March7th Launcher.exe` 用图形界面选；改完 `doctor` 确认 `gamePath` 通过。

---

## §5 红线（违反会白跑或伤账号）

- **不代确认免责声明**（退出码 3）：里面有账号风险提示，必须用户本人读并确认。
- **不在运行中改 `config.yaml` 并期待立即生效**；也不要同时用 GUI 和命令行起两个任务。
- **不把 `after_finish` 改成关机/睡眠**；agent 发起的运行固定 `--after-finish None`。
- **不把安装目录放进 `C:\Program Files`**（改配置要管理员权限）；不覆盖/删除已有安装目录。
- **不显示、不复述**推送令牌、Mirror酱 CDK、账号密码等敏感值。
- **不凭猜写任务 id**：用 `-Action status -Tasks` 拿当前版本的真实列表（本机 27 个，见 references）。
- **不把"跑完了"当结论**：退出码 0 也要有 record/日志证据；`running` 但进程不在 = aborted，不算完成。

---

## §6 现实约束（本机已核实，2026-11-02）

- 安装：`E:\software\March7thAssistant`（路径可迁移，以 `doctor.root` 为准），版本 `v2026.10.31`；`m7a.exe` 无需管理员，**运行任务时弹一次 UAC**。
- `March7th Launcher.exe` = 图形界面（会弹 UAC）；`March7th Assistant.exe` = 旧/管理员入口；`m7a.exe` = 给脚本与 agent 用。
- `gui_running` 可开可关（以 `-Action status` 为准）；改配置前最好让用户退出图形界面，避免它回写覆盖你改的键。
- `--list --json` 本机返回 **27 个任务 id**（含 `game_update`、`game_pre_download`、`currencywarsloop`、`divergentloop`、
  `universe_gui`、`fight_gui`、`notify`、`screen_test` 等）；任务表随版本变化，以 `status -Tasks` 为准。
- 真实失败样本：`20261102-221017-485f`（power）22:14 失败，`error = "无法切换到指定游戏界面"`，
  截图 `logs\screenshots\error_2026-11-02_22-14-09.png`；同一晚 `20261102-215736-276b`（main）被停止（退出码 6）。
  这类"切换界面失败"优先查：非 16:9 分辨率、全屏/滤镜/HDR、窗口被遮挡、游戏未真正进入主界面。
- 小助手自带 agent 文档：`<root>\assets\agent\skills\march7th-assistant\`（SKILL.md + references/{install,config,troubleshooting}.md），
  本机还有 `assets\docs\`（FAQ、任务表、Workflow.md）。深挖细节时先读它们，别猜。

---

## §7 版本自检（长期维护用）

1. `& $m7a -Action doctor` → `version` 与 `files` 是否齐全（`m7aExe/launcher/assistant/config/exampleConfig/versionFile/logsDir/runsDir/docsDir`）。
2. `& $m7a -Action status -Tasks` → 任务 id 是否与本文 §6 一致；不一致以输出为准并更新文档。
3. `m7a.exe --help` 看新参数（本脚本只封装了稳定子集；新能力优先加进 `references/commands-and-paths.md` 再考虑改脚本）。
