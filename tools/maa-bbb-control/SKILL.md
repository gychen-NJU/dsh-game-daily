---
name: maa-bbb-control
description: 用 Maa_bbb（识宝小助手，MFW-ChainFlow Assistant）的 mab.exe 跑崩坏3每日与往世乐土——自检环境、列出/读取配置、启动指定配置、看日志、停止进程。当用户说“帮我跑崩三日常 / 一条龙 / 用识宝跑崩坏3 / 跑往世乐土 / 看看 Maa_bbb 跑到哪了、为什么失败”，或提到 mab.exe、Maa_bbb、识宝小助手、MaaFramework、MFW 时使用。
---

# Maa_bbb 控制（崩坏3 日常与往世乐土）

> 这个技能只负责“调 Maa_bbb”：把 `mab.exe` 的配置、启动、日志、停止变成可脚本化的 JSON 动作。
> 判断依据是**日志 + 配置内容**，不是猜测；不替代游戏内手动操作，也不修改用户的现有配置。

## 0. 开工三件事

1. **doctor**：确认安装根、版本、配置数（adb / MuMu 只是可选信息，不影响任何游戏能不能跑）。
2. **status + configs**：确认没有别的 `mab.exe` 在跑，并选定 `-ConfigId`。
3. **run 之后必须值守**：用 `logs` 每 30–60 秒看一次，直到收尾或确认卡死，不能启动完就离开。

```powershell
$s = "E:\GalaxyC\DSH\PLUGINS\dsh-game-daily\tools\maa-bbb-control\scripts\maa-bbb.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action doctor
```

## 1. 能力边界

| 能做 | 做不到 |
|---|---|
| 检查安装 / 日志 / 配置是否就绪（doctor） | 安装 Maa_bbb、补下载 `resource/` |
| 列出配置、读取配置全文、列出 preset 任务 | 修改配置里的勾选状态（`config/` 只读，请用 GUI 改） |
| 用指定配置启动一次 `--direct-run` | 运行中切换配置、暂停/跳过某个子任务 |
| 读 `maafw` / `gui` / `crash` 日志尾部并按正则过滤 | 识别游戏画面、替玩家做游戏内决策 |
| 结束 `mab.exe` 进程（含子进程） | 直接控制游戏（那是 MaaFramework 的任务） |
| 说明 adb / MuMu 状态（只影响安卓端专属可选项，如战前增益同步） | 安装 MuMu、给用户开 ADB |

## 2. 五步标准流程

### 第 1 步：doctor

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action doctor
```

看四件事：`ok`、`root`、`configCount`、`blockers`。

- `ok:true` + `blockers:[]` → 可继续。
- `warnings` 里的 `MAA_ADB_MISSING` / `MAA_MUMU_MISSING` 只影响**安卓端专属可选项**（例如乐土的战前增益同步），日常与桌面端乐土照跑。
- `ok:false` → 先按 `error` 处理（见 §9），不要硬跑。

### 第 2 步：status + configs，选定配置

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action status
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action configs
```

- `status.running` 必须为 `false`。若为 `true`：要么等它跑完，要么在确认可以中断后 `-Action stop`。**不要开第二个实例。**
- 从 `configs.configs[]` 选 `id`（`c_` 开头 32 位十六进制）。`isCurrent` 只是 GUI 当前选中的配置，和 `-ConfigId` 无关。
- 想核对勾选项：`-Action get -ConfigId <id>`，读 `config.tasks[].is_checked`。

### 第 3 步：run

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action run `
  -ConfigId c_cd0c4fa2a4d14330bac904139dfa5d2f -WaitSeconds 10
```

实际执行 `mab.exe --config-id <id> --direct-run`，返回 `pid` 与首段 `logTail`。

- 已有 `mab.exe` → `MAA_ALREADY_RUNNING`（exit 2），先 stop。
- `-WaitSeconds` 只让脚本多观测一会儿，**不会**在超时后杀进程。
- 非管理员也能启动成功，但可能截不到游戏画面；PC 端日常请以管理员运行 mab。

### 第 4 步：值守（30–60 秒一轮）

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action logs -Kind maafw -Lines 30
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action logs -Kind gui -Lines 60 -Filter "ERROR|WARNING|Traceback"
```

每轮确认三件事：

1. `maafw.log` 的 `lastWrite` 在更新（流程真的在动）。
2. 没有新的 `[ERR]` / `Traceback` / `未找到` / `截图失败`。
3. `status.running` 仍为 `true`；变 `false` 说明程序已退出，读日志确认是正常收尾还是崩溃。

发现卡在同一节点：先把游戏切回主界面再决定是否重跑；**不要在战斗中直接 stop**（见 §7）。

### 第 5 步：汇报与收尾

汇报至少包含：配置名 / id、起止时间、pid、日志里完成到哪一步、最终 `running` 状态、有无错误行。
若流程已结束（`running:false`），不需要再 stop；若用户要求中断，确认游戏不在战斗/结算中后再：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action stop
```

## 3. 配置与 preset 怎么选

本机现有配置（以 `-Action configs` 的实时输出为准；GUI 可能新增/改名）：

| 配置 | id | 勾选情况 | 适合 |
|---|---|---|---|
| 日常(每天都能做的任务) | `c_cd0c4fa2a4d14330bac904139dfa5d2f` | 14 个已勾选（见下） | **每天第一次跑** |
| 日常(包含周期性任务) | `c_f28349bb8c1e40caa8a5d587e4cd1a30` | 21 个已勾选 | 周一/周常日 |
| 单独运行 | `c_6b2e154a1e3f40bf9db700bcd53f3e2e` | 仅「克莱茵在线乐土打灰」「往世乐土」 | 乐土专项（桌面端可直接跑，见 §4） |

**日常(每天都能做的任务)** 已勾选：崩坏三 启动！、家园资源领取、日常奖励领取-第一次、材料远征、家园远征派遣、家园打工、舰团每日委托、舰团每周活跃奖励、模拟作战室-减负、后勤终端物品购买、日常奖励领取-第二次、日常活跃专领、凭证奖励尝试领取、领取邮箱奖励。

**日常(包含周期性任务)** 在此基础上多勾：冒险委托-减负、万象虚境、拓境战幕-减负、每周分享、每周吼姆秘宝、每周答题-减负、每周虚境商店1星石的90张虚境挑战卷；**未勾**：超弦空间(深渊)、乐土每周商店购买、往世乐土、舰团保税仓库委托申请、每日40晶体核心、退出/关闭游戏。

三个 preset 只是 GUI 的任务清单模板，真正跑什么由配置里的 `is_checked` 决定：

| preset | 任务数 | 备注 |
|---|---|---|
| 日常-简化版 | 17 | 对应“日常(每天都能做的任务)”的模板 |
| 日常-完整版 | 28 | 含记忆战场、往世乐土、超弦空间等，按需勾选 |
| 建议单独运行 | 7 | 乐土/洗词缀/自动战斗等，不宜和日常混跑 |

选配置的经验：

- 只要日常 → 简化版配置；周常日 → 完整版配置。
- 想单独打某项（乐土、自动战斗、洗词缀）→ “单独运行”配置，**不要**和日常同时跑。
- 用户临时要求“只跑某几个任务”时，不要改配置；直接告诉用户需要在 GUI 里改勾选，或者选最接近的现有配置。

## 4. 往世乐土：怎么跑（重要）

- **不需要 MuMu**：Maa_bbb **v1.13.22 起桌面端与安卓端都支持**乐土。`tasks\周常\往世乐土.json` 的选项 `往世乐土-关内角色` / `往世乐土-禁用刻印` 明确写了 `"controller": ["桌面端","安卓端"]`；桌面端链路有专门适配（`agent\custom\utils\DesktopInput.py` 按住 Alt 拖视角、`MoveInput.py` 用 WASD 代替摇杆，`resource\resource_win32\pipeline\往世乐土\乐土导航.json` 补了 F 键「打开快速出击」）。
- 所以 `configs` 里三个 `controller=桌面端` 的配置，只要勾了「往世乐土」，直接 `run` 就会进乐土流程；**`adbAvailable=false` 不是跳过乐土的理由**。
- MuMu / ADB 只影响**安卓端专属的可选项**：例如战前增益同步（`ElysianBuffSync`）只在 MuMu 下生效。想用安卓端才需要 MuMu + `adb connect`。
- 上游 README 的「往世乐土-周常通关（开发中，目前仅导航至乐土箱庭）」是**旧版**状态；本 Fork 已接全自动（适配 窈窕谍影·华裳 / 神·寻梦者 / 浮生·渡尘之羽）。实际能否通关**以日志为准**，不要向用户保证。
- 乐土相关配置项（在 `get` 的 `task_option` 里）：关内角色=窈窕谍影、流派=往世乐土-深层序列-窈窕谍影-华裳、战前增益全 Yes、商店处理=绕过商店不购买（安卓=自动购买）、刻印优先级自选=Yes、门的选择优先级=No。
- 乐土是**周常**（单轮约 14 分钟）：插件默认让「日常」配置跳过它，别把乐土塞进每日流程；单跑请用「单独运行」配置。要连乐土一起跑，让用户设 `DSH_GAME_DAILY_MAA_LEYLINE=1`。
- 安卓端才需要 MuMu adb 路径：旧版 `{MuMu安装目录}\shell\adb.exe`；MuMu 5.0 `{安装目录}\nx_main\adb.exe`；模拟器主程序 `{安装目录}\nx_device\12.0\shell\MuMuNxDevice.exe`。模拟器分辨率要自行设成 16:9。
- 需要改控制器/资源/勾选时，**让用户在 GUI 里改**，本技能不写 `config/`。

## 5. 脚本动作速查

| Action | 关键参数 | 返回要点 |
|---|---|---|
| `doctor` | — | `ok`、7 项 `checks`、`blockers`、`warnings`、`isAdmin` |
| `status` | — | `running`、`runningPids`、当前配置、三个日志的 `lastWrite` |
| `configs` | — | 每个配置的 `id` / `name` / `controller` / `checked` / `enabledTasks` |
| `get` | `-ConfigId`（完整 id / 唯一前缀 / 配置名 / `current`） | 完整配置 JSON |
| `run` | `-ConfigId`、`-WaitSeconds` | `pid`、`stillRunning`、`logTail` |
| `stop` | — | `killed[]`、`remaining[]` |
| `logs` | `-Kind`、`-Lines`、`-Filter` | `lines[]`、`sizeBytes`、`lastWrite` |
| `presets` | — | 3 个 preset 的任务名数组 |

退出码：`0` 成功；`1` 参数/启动/内部错误；`2` 未安装、根无效、配置不存在、已在运行、日志缺失。
完整字段与示例见 `references/commands-and-paths.md`；排障见 `references/troubleshooting.md`。

## 6. 常用配方

```powershell
# 跑每日
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action run -ConfigId c_cd0c4fa2a4d14330bac904139dfa5d2f -WaitSeconds 10
# 等 60 秒看进度
Start-Sleep -Seconds 60
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action logs -Kind maafw -Lines 40
# 看有没有报错
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action logs -Kind maafw -Lines 200 -Filter "\[ERR\]|\[WRN\]"
# 确认进程状态
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action status
# 中断
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action stop
```

```powershell
# 周常：先确认游戏已回主界面，再用完整版配置
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action run -ConfigId c_f28349bb8c1e40caa8a5d587e4cd1a30 -WaitSeconds 10
```

## 7. 安全红线

1. **不要在中途 stop 掉正在战斗/结算的流程。** `stop` 是强制杀进程，不是暂停；会让游戏卡在半场或结算界面。要么等日志收尾，要么先确认游戏已回到主界面。
2. **不要改游戏分辨率、窗口模式、角色装备、圣痕。** 识别与点击依赖 16:9 和固定 UI；改这些会连带影响用户的手动游戏状态。
3. **不要同时跑两个配置，也不要多开 mab.exe。** 同一时间只允许一个实例；`--force-restart` 会杀掉同目录其他实例，别用它抢跑。
4. **不要修改 `E:\software\Maa_bbb\config\`。** 本脚本只读；改勾选、改控制器都交给 GUI。
5. **自动战斗期间不要按 `Win` / `Ctrl` / `Alt`。** 会弹出快捷键窗口遮挡识别。
6. **PC 端请以管理员启动 mab.exe**，并在游戏内 设置→辅助 关闭「显示菜单提示」。
7. **不要在更新/维护/登录页跑日常**；先把游戏手动推进到主界面。
8. 不要向用户承诺“乐土一定能通关”；桌面端不需要 MuMu/ADB，也不要拿“缺 MuMu”当跳过的理由。

## 8. 现实约束

- 安装根：`E:\software\Maa_bbb`（`mab.exe` 4.10.4.0、`interface.json` 2 / v1.13.20、MaaFramework v5.14.3）。
- `mab.exe` 是 GUI 子系统程序：`--help` 没有 stdout，启动成功与否看进程与 `debug/maafw.log`，不要看命令输出。
- `gui.log` 里反复出现的 `未找到语言 zh_cn 的翻译文件配置`、`preset 引用 interface 中不存在的任务，已跳过: 记忆战场` 是**良性**，不是失败。
- 游戏未启动/非管理员时，`run` 仍会成功拉起进程，但 `maafw.log` 会停在框架初始化；这属于“已启动但没得跑”，不是脚本故障。
- GUI 或并发运行会改写 `multi_config.json` 的 `curr_config_id`；它不影响 `-ConfigId`，不要把它当运行状态。
- 本技能在 Windows PowerShell 5.1 下自测；脚本纯 ASCII、CRLF、UTF-8 无 BOM。

## 9. 排障速查

| 现象 | 先查 | 处理 |
|---|---|---|
| `MAA_NOT_INSTALLED` | `-Root`、`maa-root.txt` | 指到同时有 `mab.exe` + `interface.json` 的目录 |
| 找不到窗口 / 截图黑 | 游戏是否在跑、是否前台、是否 16:9、`doctor.isAdmin` | 启动游戏到主界面；改 16:9；以管理员跑 mab |
| 分辨率/黑边导致领奖失败 | 窗口比例 | 1920×1080 16:9，重启游戏与 mab |
| 权限不足 / 启动没反应 | UAC、杀软 | 管理员运行；加白名单；计划任务勾“最高权限” |
| ADB 未连接 | `adb devices`、MuMu ADB 开关 | 开 ADB、`adb connect`、允许授权 |
| 日志不动 | `status.debug.maafwLog.lastWrite` | 看游戏是否卡在登录/公告/战斗；切回主界面 |
| `设备连接失败` / `Win32 控制器未匹配窗口` | 游戏是否启动、窗口是否 16:9、`doctor.isAdmin` | 启动游戏到主界面并以管理员跑 mab；不是重装问题 |
| 任务反复重试 | `logs -Filter "Tasker\|next\|timeout"` | 手动回主界面再重跑；不要连着重试 |
| 进程杀不掉 | `stop.remaining` | 管理员 `taskkill /F /IM mab.exe` |
| crash.log 非空 | `logs -Kind crash` | 关覆盖层/更新驱动；留档后上报 |

更完整的症状→检查→修复表、日志关键字与假错误清单见 `references/troubleshooting.md`。

## 10. 版本自检

```powershell
(Get-Item "E:\software\Maa_bbb\mab.exe").VersionInfo.FileVersion   # 4.10.4.0
(Get-Content "E:\software\Maa_bbb\interface.json" -Raw | ConvertFrom-Json).version  # v1.13.20
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action doctor   # 7 checks
```

升级 Maa_bbb 后先跑 `doctor` 与 `presets`：`interface.json` 的任务/预设可能变，配置里的 `item_id` 也可能重新生成；出现解析失败时按 `references/troubleshooting.md` §8 处理。
