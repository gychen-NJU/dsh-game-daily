# 三月七小助手：命令行 / 任务表 / 路径 / JSON 字段速查

> 依据：本机 March7thAssistant **v2026.10.31**（`E:\software\March7thAssistant`，2026-11-02 迁移自 `C:\Users\13676\Games\March7thAssistant`）实测
> + 官方自带 agent 文档 `<root>\assets\agent\skills\march7th-assistant\`（2026-11-02）。
> 版本升级后以 `m7a.exe --help`、`m7a.exe --list --json` 的实际输出为准。
>
> 同一套安装定位与退出码在插件里由 `lib/m7a.mjs` 实现（`tools/m7a-mcp/` 是对话用的 MCP 封装）；
> 本脚本自包含、不依赖两者，行为与 `lib/m7a.mjs` 保持一致。

## 1. m7a.exe 命令行（直接调用）

在**安装目录**里执行（`m7a.exe` 不需要管理员；运行任务时会弹一次 UAC，由用户点「是」）：

| 命令 | 作用 | 备注 |
| --- | --- | --- |
| `.\m7a.exe --status --json` | 版本、首次确认、游戏路径、GUI 是否在跑、正在运行的任务、最近运行 | 只读；输出 JSON |
| `.\m7a.exe --list --json` | 全部任务 id 与名称 | 只读；**以本机输出为准** |
| `.\m7a.exe <taskId> --after-finish None` | 运行任务并等待结束（输出实时转回终端），返回真实退出码 | 长任务别前台等，用 `--detach` |
| `.\m7a.exe <taskId> --after-finish None --json` | 同上，最后一行输出完整运行记录 JSON | 脚本用这个 |
| `.\m7a.exe <taskId> --after-finish None --detach` | 启动后立即返回运行编号，不等待 | 长任务首选 |
| `.\m7a.exe --follow latest` | 跟随最近一次运行的输出直到结束 | 也可写运行编号 |
| `.\m7a.exe --control current pause\|resume\|stop` | 暂停 / 继续 / 停止当前任务 | GUI 起的任务也有效 |
| `.\m7a.exe --workflow-name "流程名称"` | 运行用户在「流程编排」里建好的流程 | `--list-workflows` 查看名称 |
| `.\m7a.exe notify` | 测试消息推送 | 只发通知，不碰游戏 |
| `.\m7a.exe --help` | 参数总览 | 新版本可能加参数 |

- 所有 JSON 输出**只含 ASCII**，中文以 `\uXXXX` 转义。
- PowerShell 读中文输出前先 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`。
- 已有任务在跑时默认拒绝（退出码 4）；`--force` 可强行并发，**不要用**（小助手靠单实例锁保证只有一个在操控游戏）。

## 2. 脚本封装（`scripts\m7a.ps1`）

| `-Action` | 实际调用的 m7a 命令 | 额外输出 |
| --- | --- | --- |
| `doctor` | `--status --json`（失败也继续，报告可诊断项） | files / config / todayLog / recentRuns / checks / blockers / warnings / deepCheck |
| `status` | `--status --json`；`-Tasks` 时再跑 `--list --json` | `activeRun`、`tasks[]` |
| `run` | `<taskId> --after-finish <mode> --json`（`-Detach` 换成 `--detach`） | `meaning`、`record`、`outputTail`（detach）/ `m7aProcessId`（超时） |
| `follow` | `--follow <run>`（`-FromLog` 时改读 `logs\runs\<run>.log`） | `lines[]`、`count` |
| `control` | `--control current <pause\|resume\|stop>` | `meaning`、`outputTail` |
| `logs` | 读 `logs\<yyyy-MM-dd>.log`（`-Run` 时读 `logs\runs\<run>.log`） | `lines[]`、`count`、`file` |

`run` 的前置检查（不加 `-Force` 时）：`--status` 不可解析 → 脚本退出 2；`first_run_completed=false` → 3（透传 M7A 语义）；
`game_path_exists=false` → 2；`active_run` 非空 → 4。

## 3. 任务 id（本机 v2026.10.31 实测 27 个）

| id | 名称 | id | 名称 |
| --- | --- | --- | --- |
| `main` | 完整运行（日常 + 奖励 + 体力） | `routine` | 日常 |
| `daily` | 每日实训 | `power` | 清体力 |
| `divergent` | 差分宇宙 | `divergentloop` | 差分宇宙循环 |
| `divergenttemp` | 差分宇宙中途接管 | `currencywars` | 货币战争 |
| `currencywarsloop` | 货币战争循环 | `currencywarstemp` | 货币战争中途接管 |
| `universe` | 模拟宇宙 | `universe_gui` | 模拟宇宙原生界面 |
| `universe_update` | 模拟宇宙更新 | `fight` | 锄大地 |
| `fight_gui` | 锄大地原生界面 | `fight_update` | 锄大地更新 |
| `forgottenhall` | 混沌回忆 | `purefiction` | 虚构叙事 |
| `apocalyptic` | 末日幻影 | `redemption` | 兑换码 |
| `game` | 启动游戏 | `game_update` | 更新游戏 |
| `game_pre_download` | 预下载游戏 | `app_update` | 更新三月七小助手 |
| `mobileui_update` | 触屏模式更新 | `notify` | 测试消息推送 |
| `screen_test` | 界面可切换性测试 | | |

**别硬编码**：任务表随版本变化，用 `-Action status -Tasks` 或 `m7a.exe --list --json` 取当前列表。
`main` 会按 `daily_enable` / `power_enable` 等开关决定实际做什么；`power_enable: false` 只影响完整运行/日常，单独跑 `power` 不受影响。

## 4. 退出码

| 码 | 含义 | agent 该做什么 |
| --- | --- | --- |
| 0 | 成功 | 汇报，附 record/日志证据 |
| 1 | 任务失败 | 读 `logs\runs\<runId>.json` 的 `error`/`screenshot` 与日志末尾 |
| 2 | 参数错误（或脚本层：未安装 / `-Root` 无效 / 前置不满足 / 超时） | 看 `error`/`hint` 修正；`-Action status -Tasks` 核对 id |
| 3 | 首次使用未确认（`first_run_required`） | 请用户本人开 `March7th Launcher.exe` 确认免责声明，**不代确认** |
| 4 | 已有任务在运行（`busy`） | 等结束或问用户；必要时 `control -ActionName stop` |
| 5 | UAC 被取消 / 无法提权 | 请用户在弹窗点「是」；无人值守改用定时任务 |
| 6 | 被停止指令中止（`stopped`） | 按用户意图决定是否重跑 |

脚本层另有：`1` 内部错误 / 输出不可解析 / 启动失败 / 参数错误；`2` 未安装 / `-Root` 无效 / 前置不满足 / 本地等待超时（`M7A_RUN_TIMEOUT`）。

## 5. `--status --json` 的字段（实测 schema 1）

```json
{
  "schema": 1, "version": "v2026.10.31", "install_dir": "...", "frozen": true,
  "platform": "win32", "is_admin": false,
  "entrypoints": { "gui": "...March7th Launcher.exe", "cli": "...March7th Assistant.exe", "agent_cli": "...m7a.exe" },
  "config_file": "...config.yaml", "config_exists": true, "config_writable": true,
  "config_reference": "...assets\\config\\config.example.yaml",
  "first_run_completed": true, "cloud_game_enable": false,
  "game_path": "E:\\Star Rail\\Game\\StarRail.exe", "game_path_exists": true,
  "after_finish": "None", "gui_running": true, "active_run": null,
  "recent_runs": [ { "run_id": "...", "task": "power", "exit_code": 1, "reason": null,
                     "error": "无法切换到指定游戏界面", "status": "failed",
                     "started_at": "...", "ended_at": "...", "screenshot": "logs\\screenshots\\...png" } ],
  "logs_dir": "...", "runs_dir": "...", "install_registry": "%LOCALAPPDATA%\\March7thAssistant\\installs.json",
  "agent_skill": "...assets\\agent\\skills\\march7th-assistant\\SKILL.md"
}
```

`active_run` 为 `null` 表示当前没有任务在跑；非空时是正在运行的任务/运行编号。

## 6. 运行记录 `logs\runs\<runId>.json`

| 字段 | 含义 |
| --- | --- |
| `run_id` / `task` / `invoker` | 运行编号 / 任务 id / 发起方（entry、gui、mcp…） |
| `status` | `success` / `failed` / `blocked` / `stopped` / `interrupted` / `running`；进程已不在却是 running → aborted，不算完成 |
| `exit_code` | 与退出码表一致 |
| `reason` | 结构化原因（如 `first_run_required`、`busy`） |
| `error` | 人类可读错误（如「无法切换到指定游戏界面」） |
| `started_at` / `ended_at` | ISO 时间 |
| `screenshot` | 失败截图（相对安装目录，如 `logs\screenshots\error_...png`） |
| `log_file` | 本次运行的完整输出（`.log`） |
| `lock` | `acquired` / `forced` / `busy` / `unavailable`（运行锁状态） |

## 7. 路径表

| 用途 | 路径（相对安装根 `<root>`） |
| --- | --- |
| agent 用命令行 | `<root>\m7a.exe` |
| 图形界面 | `<root>\March7th Launcher.exe`（弹 UAC） |
| 旧/管理员命令行入口 | `<root>\March7th Assistant.exe` |
| 主配置 | `<root>\config.yaml`（YAML，改前先备份） |
| 配置参考（每键中文注释） | `<root>\assets\config\config.example.yaml` |
| 版本 | `<root>\assets\config\version.txt` |
| 运行记录 | `<root>\logs\runs\<runId>.json` / `.log` |
| 当天全部日志（含 GUI 任务） | `<root>\logs\<yyyy-MM-dd>.log` |
| 配置读写诊断 | `<root>\logs\config_diag.log` |
| 失败截图 | `<root>\logs\screenshots\*.png` |
| 安装登记（发现用） | `%LOCALAPPDATA%\March7thAssistant\installs.json` |
| 官方 agent 文档 | `<root>\assets\agent\skills\march7th-assistant\{SKILL.md,references\*}` |
| 官方教程 / FAQ / 任务表 | `<root>\assets\docs\` |
| 流程编排 | `<root>\config\workflows\<目录>\workflow.yaml` |

## 8. 关键配置键（`config.yaml`）

| 键 | 作用 |
| --- | --- |
| `game_path` | `StarRail.exe` 的完整路径；`game_path_exists=false` 时先改它 |
| `auto_set_game_path_enable` | 自动识别游戏路径（多盘/多客户端时建议 `true`） |
| `auto_set_resolution_enable` | 启动前自动把游戏调到自动化需要的分辨率（**16:9、≥1080p**） |
| `daily_enable` / `power_enable` | 完整运行/日常里是否做每日实训 / 清体力 |
| `after_finish` | 完成后操作：`None`、`Exit`、`Loop`、`Shutdown`、`Sleep`、`Hibernate`、`Restart`、`Logoff`、`TurnOffDisplay`、`RunScript` |
| `pause_after_success` / `exit_after_failure` | 结束后是否停在窗口等回车 / 失败后是否保留窗口（旧版 `March7th Assistant.exe` 尤其相关） |
| `scheduled_tasks` | 小助手自带定时（**由 GUI 执行，GUI 需保持运行/最小化到托盘**）；可设星期、链式、冲突策略 `scheduled_on_conflict: skip\|stop` |
| `power_plan` | 体力计划 `[["拟造花萼（金）","回忆之蕾",10], ...]`，按顺序执行；`power_plan_keep` 控制完成后是否保留 |
| `instance_type` / `instance_names` | 体力计划为空时用的默认副本类型与副本名 |
| `check_update` / `cloud_game_enable` | 启动检查更新 / 云·星穹铁道（无需本地游戏） |
| `notification_enable` / `notify_*_enable` | 消息推送总开关与各渠道开关（令牌敏感，别显示） |
| `weekly_divergent_*`、`currencywars_*`、`universe_*`、`fight_*` | 各周常玩法细项 |

副本名必须与 `<root>\assets\config\instance_names.json` 完全一致（该文件也写明掉落）。
`after_finish` 与命令行 `--after-finish None` 的关系：命令行参数只影响本次运行，不改配置。

## 9. 日志怎么读

1. `logs -Run latest` / `logs\runs\<runId>.log`：本次运行的完整输出（UTF-8）。
2. `logs\runs\<runId>.json`：结论（`status` / `exit_code` / `reason` / `error` / `screenshot`）。
3. `logs\<yyyy-MM-dd>.log`：当天所有运行的汇总（GUI 起的也在里面），格式 `时间 | 级别 | 消息`，如
   `2026-11-02 22:14:09,052 | ERROR | 发生错误 无法切换到指定游戏界面`。
4. `logs\config_diag.log`：配置文件读写/解析问题。
5. 汇报时引用原文行，不要只写「失败了」。
