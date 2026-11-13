# 排障：症状 → 检查 → 修复

> 排障原则：先看**脚本 JSON**（doctor / status / logs），再看**日志**，最后才动游戏与配置。
> 不要靠“再跑一次试试”排障；每次重试前先确认上一次的 mab.exe 已经退出。

## 0. 三分钟判定树

```powershell
$s = "E:\GalaxyC\DSH\PLUGINS\dsh-game-daily\tools\maa-bbb-control\scripts\maa-bbb.ps1"
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action doctor
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action status
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action logs -Kind gui -Lines 60 -Filter "ERROR|WARNING|Traceback"
```

- `doctor.ok=false` 且 `error=MAA_NOT_INSTALLED` → 安装根问题，看 §1。
- `doctor.ok=true` 但 `warnings` 含 `MAA_ADB_MISSING` / `MAA_MUMU_MISSING` → 只影响往世乐土，日常照跑，看 §5。
- `status.running=true` 但 `maafw.log` 的 `lastWrite` 不更新 → 卡在“找窗口/分辨率/权限”，看 §3。
- `crash.log` 非 0 字节 → 看 §7。

## 1. 脚本错误码

| 错误码 | 退出码 | 含义 | 修复 |
|---|---|---|---|
| `MAA_NOT_INSTALLED` | 2 | 所有候选根都没有 `mab.exe` + `interface.json` | 用 `-Root` 指到真实安装根，或写 `maa-root.txt`（见 commands-and-paths §2） |
| `MAA_BAD_ROOT` | 2 | 显式 `-Root` 不是 Maa_bbb 安装根 | 检查该目录是否同时有 `mab.exe` 与 `interface.json`；两个都要 |
| `MAA_CONFIG_ID_REQUIRED` | 1 | `run`/`get` 没给 `-ConfigId` | 先 `-Action configs` 拿 id |
| `MAA_CONFIG_NOT_FOUND` | 2 | id 或前缀匹配不到 | 用完整 id；`available` 里有全部可用 id |
| `MAA_CONFIG_DIR_MISSING` | 2 | `config\configs` 不存在 | 安装不完整或被移动，重新解压/更新 |
| `MAA_CONFIG_UNREADABLE` | 2 | 配置 JSON 读不了（权限/损坏） | 用 GUI 打开该配置验证；必要时重装，**不要手改** |
| `MAA_ALREADY_RUNNING` | 2 | 已有 `mab.exe` 进程 | 先 `-Action stop`，或等它跑完；不要开第二个实例 |
| `MAA_LOG_MISSING` | 2 | `debug\<kind>.log` 不存在 | 先跑一次 Maa_bbb 让日志生成；确认 `-Root` 对 |
| `MAA_BAD_FILTER` | 1 | `-Filter` 不是合法正则 | 转义 `[`、`(`、`|` 等；如 `\[ERR\]` |
| `MAA_BAD_ARGS` | 1 | action / kind / 行数非法 | 看 `-Action help` 的合法值 |
| `MAA_SPAWN_FAILED` | 1 | `Start-Process` 失败 | 权限（UAC）、杀软拦截、路径被占用，看 §3.3 |
| `MAA_STOP_FAILED` | 1 | 进程杀不掉 | 管理员权限不足；手动 `taskkill /F /IM mab.exe` |

## 2. 环境类故障

### 2.1 “找不到游戏窗口” / 截图全黑 / 识别不到任何东西

| 检查 | 命令/位置 | 修复 |
|---|---|---|
| 游戏是否在跑、是否在前台 | 任务管理器 / `Get-Process -Name BH3` | 先手动启动游戏到**主界面**（不是启动器、不是登录页） |
| 是否 16:9 | 游戏设置 → 显示 | 用 1920×1080 窗口或全屏；**非 16:9 会整体错位** |
| 是否管理员启动 mab.exe | `doctor.isAdmin`、任务管理器“已提升”列 | 右键 mab.exe → 以管理员身份运行；从计划任务跑要勾“使用最高特权执行” |
| 游戏内菜单提示 | 游戏 → 设置 → 辅助 | 关闭「显示菜单提示」（鼠标划过会弹出遮挡识别） |
| 窗口是否被最小化 | 屏幕 | 还原到前台；Windows 10/11 的“窗口化优化”也可能干扰，尽量前台跑 |
| 多显示器/缩放 | 显示设置 | 缩放 100% 最稳；跨屏时把游戏窗口放在主屏 |

对应日志关键字（实测）：`gui.log` 里的 `Win32 控制器未匹配窗口且未配置启动程序`、`设备连接失败`、`任务流程执行异常`、`Runtime <id> failed`；`maafw.log` 里 `ControllerAgent` 随后会出现 `stopping, ignore new post`。看到这条链基本就是“没连上游戏窗口”，先解决窗口/分辨率/管理员，不要重装。

### 2.2 分辨率 / 黑边导致奖励领不到

- 现象：任务能跑到“领取奖励”，但点击位置偏、或提示“未找到按钮”。
- 原因：窗口不是 16:9，或全屏与窗口模式切换后画面有黑边。
- 修复：改成标准 16:9（1920×1080 优先），重启游戏与 mab.exe；不要用 21:9 或带鱼屏拉伸。

### 2.3 权限不足 / 双击没反应 / 启动后立刻退出

1. 确认 mab.exe 不是以普通权限启动：`doctor.isAdmin=false` 时就可能截不到游戏。
2. 关掉“以兼容模式运行”和“以管理员身份运行”的冲突设置（只保留管理员）。
3. 杀软/Defender 拦截 `mab.exe` 或 `resource\` 里的 DLL → 加白名单。
4. 从计划任务启动时，必须勾“使用最高权限运行”，否则会话 0 里没有桌面。

### 2.4 自动战斗时弹出一堆快捷键窗口

- 原因：自动化期间按了 `Win` / `Ctrl` / `Alt`（尤其 `Win` 会弹开始菜单、`Ctrl+Alt` 会触发游戏快捷键）。
- 修复：运行期间不要碰键盘鼠标；必须操作时先 `stop` 并等游戏回到主界面。

## 3. 任务跑不动 / 卡住

### 3.1 进程在，日志不更新

按顺序查：

1. `status.debug.maafwLog.lastWrite` 是否在最近 2 分钟内。
2. `gui.log` 末尾是否有 `等待`、`未找到`、`截图失败`、`资源加载失败`。
3. 游戏是否停在：登录页、更新页、公告弹窗、网络错误弹窗、战斗中。
4. 是否游戏窗口被其他窗口完全遮住（部分截图方式要求可见）。

### 3.2 卡在某个任务反复重试

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action logs -Kind maafw -Lines 120 -Filter "Tasker|post_task|ControllerAgent|设备连接失败"
```

- 看最后一个 `next` 指向的任务名；对照 `tasks\<分类>\<任务>.json` 的节点。
- 常见原因：UI 改版、活动界面变化、角色/装备不在预期页、体力不足、网络慢。
- 修复顺序：手动把游戏切回主界面 → 重新 `run`；仍失败则跳过该任务（GUI 取消勾选）而不是反复重跑。
- **不要**在任务进行中直接 `stop`（见 §6）。

### 3.3 启动失败（MAA_SPAWN_FAILED）

- 路径含空格/中文没问题，但 `-WorkingDirectory` 必须是安装根；脚本已处理。
- 被 UAC 拦住：脚本不会自动提权；用管理员 PowerShell 跑脚本，或先手动以管理员启动一次。
- 已有实例占用单实例锁：先 `stop`。
- 磁盘满 / 文件被杀软隔离：看 `doctor.files.exe.exists`。

## 4. 日志里的“假错误”

以下在 `gui.log` 里反复出现，**属良性**，不要据此判断失败：

| 关键字 | 含义 |
|---|---|
| `[WARNING][i18n_service.py][L80][load_translations_from_interface] \| 未找到语言 zh_cn 的翻译文件配置` | 界面缺中文翻译文件，不影响任务 |
| `[WARNING][task_service.py][L319][init_config_from_preset] \| preset 引用 interface 中不存在的任务，已跳过: 记忆战场` | 旧 preset 引用了已删任务，加载时跳过 |
| `_should_show_by_resource ... 没有 resource 字段，显示（所有资源可用）` | 任务未限定资源，正常 |
| `[WRN][GpuOptionWin32.cpp] adapter has less than 2GB video memory, skip` / `software adapter, skip` | 集显/虚拟显卡被跳过，MaaFramework 会退回可用 GPU，不影响运行 |
| `[WRN][PipelineResMgr.cpp] entry is not *.json or *.jsonc, skip` | `resource/` 下有非 JSON 的目录/文件，加载时跳过 |
| `[ERR][ControllerAgent.cpp] ... stopping, ignore new post` | 停止/切换控制器时的收尾竞态，出现在任务结束前后，属良性 |

真正的错误看：`[ERR]`、`[ERROR]`、`Traceback`、`Exception`、`failed`、`未找到`、`超时`、`adb` 相关行。

## 5. ADB / MuMu / 往世乐土

| 症状 | 检查 | 修复 |
|---|---|---|
| `doctor` 报 `MAA_ADB_MISSING` | `where adb`、`adb devices` | 装 platform-tools 或直接用 MuMu 自带 adb |
| MuMu 已开但 `adb devices` 为空 | MuMu 设置里 ADB 是否开启；端口 | MuMu 多开器 → ADB 端口；`adb connect 127.0.0.1:<端口>` |
| `adb devices` 显示 `unauthorized` | 模拟器内是否弹过授权 | 在模拟器里点“允许”，或重启 adb server |
| `offline` | adb 版本/端口冲突 | `adb kill-server` 后重连；只用一份 adb |
| MuMu adb 路径 | MuMu 安装目录 | 旧版 `{安装目录}\shell\adb.exe`；MuMu 5.0 `{安装目录}\nx_main\adb.exe`；模拟器主程序 `nx_device\12.0\shell\MuMuNxDevice.exe` |
| 乐土只走到“箱庭”就停 | `tasks\周常\往世乐土.json` 是否为完整版 | 上游 README 标注乐土“开发中，目前仅导航至乐土箱庭”；本 Fork 声称接入 MuMu 全自动乐土（适配 窈窕谍影·华裳 / 神·寻梦者 / 浮生·渡尘之羽），若仍只到箱庭，按“未适配当前角色/流派”处理，不要硬跑 |
| 乐土配置是桌面端 | `configs` 的 `controller` | 乐土需要**安卓端 + MuMu + ADB**；在 GUI 里把控制器切到安卓端、选对 resource，并确认模拟器 16:9 |

> 本机现状（2026-11-14）：**未安装 MuMu，PATH 里也没有 adb**。因此往世乐土只能给配置与说明，不能实跑；日常/周常走桌面端。

## 6. 停止与进程残留

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action stop
Get-Process -Name mab -ErrorAction SilentlyContinue
```

- `stop` 是**强制结束**，不是暂停。任务进行中调用可能让游戏停在战斗/结算界面，下次启动需要手动收拾。
- 正确时机：日志显示本轮已收尾、或明确卡死且不介意中断时。
- `remaining` 非空：管理员权限不足，手动 `taskkill /F /IM mab.exe`，再用任务管理器确认。
- 不要用 `--force-restart` 去抢别人的实例；本脚本的 `run` 遇到已运行会直接拒绝。

## 7. crash.log 非空 / mab 闪退

1. 读尾部：`-Action logs -Kind crash -Lines 50`。
2. 记录 `Exception` / 模块名 / 偏移；常见为显卡驱动、覆盖层（Discord/Steam/NVIDIA）、杀软注入。
3. 关掉游戏内覆盖层与录屏软件，更新显卡驱动，重试。
4. 仍闪退：备份 `config/` 后重装 Maa_bbb（不要删 `config/`，否则配置丢失）。
5. 把 `debug\crash.log` 与 `debug\gui.log` 一起留档，再上报。

## 8. 资源加载失败 / 任务配置缺失

- 上游 README 的处理：删掉 `config` 以外的文件夹后重新下载资源（**会重下数百 MB**；先备份 `config/`，不要连配置一起删）。
- 单个任务提示“配置不存在”：`interface.json` 或 `tasks/` 与配置版本不匹配 → 用 GUI 重新套用 preset 生成配置，或升级到配套版本。
- 不要手改 `config/configs/*.json` 的 `item_id`；它们与 `tasks/*.json` 的节点绑定。

## 9. 何时停手

出现以下情况不要继续自动重试，直接向用户报告：

- 游戏客户端正在更新/维护，或登录需要验证码/扫码。
- 连续两次在同一任务同一节点失败。
- `crash.log` 在重试后继续增长。
- 需要改分辨率、改角色装备、改游戏设置才能继续（这些超出本技能边界，且会影响用户的游戏状态）。
