# 命令、路径与输出字段

> 所有命令都在 Windows PowerShell 5.1 下验证。脚本默认输出**单个 JSON 对象**（stdout），stderr 只留 PowerShell 自身错误。

## 1. 脚本位置与调用

```powershell
$s = "E:\GalaxyC\DSH\PLUGINS\dsh-game-daily\tools\maa-bbb-control\scripts\maa-bbb.ps1"

# 推荐：显式 bypass，避免执行策略拦截
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action doctor
```

| 参数 | 默认 | 说明 |
|---|---|---|
| `-Action` | 必填 | `doctor` / `status` / `configs` / `get` / `run` / `stop` / `logs` / `presets` / `help` |
| `-ConfigId` | 空 | `get` / `run` 必填；接受完整 id、去掉 `c_` 的 id、**唯一前缀**（如 `c_cd0c4fa2`）、配置显示名，或 `current`（GUI 当前配置） |
| `-Root` | 空 | 显式指定安装根（优先于环境变量） |
| `-WaitSeconds` | 0 | `run` 启动后最多等多少秒（0–600），只用于观测，不会杀进程 |
| `-Lines` | `logs` 40 / `status` 20 | 返回行数（1–2000） |
| `-Kind` | `maafw` | `logs` 的日志类型：`maafw` / `gui` / `crash` |
| `-Filter` | 空 | `logs` 的正则过滤（忽略大小写，如 `ERR|WRN`） |
| `-Json` | 开关 | 兼容用；不加也输出 JSON |

## 2. 安装根解析顺序

| 优先级 | 来源 | 说明 |
|---|---|---|
| 1 | `-Root <path>` | 显式指定；无效时直接报 `MAA_BAD_ROOT`，不再回退 |
| 2 | `$env:DSH_GAME_DAILY_MAA_ROOT` | 会话级覆盖 |
| 3 | `$env:MAA_BBB_ROOT` | 通用覆盖 |
| 4 | `<$DSH_GAME_DAILY_STATE_DIR 或 %USERPROFILE%\.dsh\game-daily>\maa-root.txt` | 文件内容为一行路径 |
| 5 | `E:\software\Maa_bbb` | 本机实际位置 |
| 6 | `D:\software\Maa_bbb` | 常见备选 |
| 7 | `%USERPROFILE%\Maa_bbb` | 用户目录安装 |

校验条件：目录下同时存在 **`mab.exe`** 与 **`interface.json`**。全部不满足 → `MAA_NOT_INSTALLED`（exit 2），`searched` 列出所有尝试过的路径；`doctor` 例外，仍返回完整报告（`ok:false` + `checks`）。

把安装根写进状态文件（跨会话生效）：

```powershell
$state = if ($env:DSH_GAME_DAILY_STATE_DIR) { $env:DSH_GAME_DAILY_STATE_DIR } else { Join-Path $env:USERPROFILE ".dsh\game-daily" }
New-Item -ItemType Directory -Force -Path $state | Out-Null
[System.IO.File]::WriteAllText((Join-Path $state "maa-root.txt"), "E:\software\Maa_bbb", (New-Object System.Text.UTF8Encoding($false)))
```

## 3. 路径表

| 用途 | 路径 |
|---|---|
| 安装根 | `E:\software\Maa_bbb` |
| 主程序 | `E:\software\Maa_bbb\mab.exe`（FileVersion 4.10.4.0，MFW-ChainFlow Assistant） |
| 接口描述 | `E:\software\Maa_bbb\interface.json`（`interface_version: 2`，版本 `v1.13.20`） |
| 配置目录 | `E:\software\Maa_bbb\config\configs\c_<32hex>.json` |
| 配置索引 | `E:\software\Maa_bbb\config\multi_config.json`（`curr_config_id` + `config_list`） |
| 任务定义 | `E:\software\Maa_bbb\tasks\{日常,周常,周期性,工具,活动}\*.json`、`tasks\游戏启动.json` |
| 资源 | `E:\software\Maa_bbb\resource\{base,resource_win32,resource_bilibili,...}` |
| 运行日志 | `E:\software\Maa_bbb\debug\maafw.log` |
| GUI 日志 | `E:\software\Maa_bbb\debug\gui.log` |
| 崩溃日志 | `E:\software\Maa_bbb\debug\crash.log`（正常为 0 字节） |

## 4. 动作与示例

### doctor

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action doctor
```

返回：`ok, action, root, source, searched, version, title, interfaceVersion, presetCount, hasExe, hasInterface, isAdmin, running, runningPids, configCount, configDir, currentConfigId, currentConfigName, adbAvailable, adbPath, mumuAvailable, mumuPath, checks[7], blockers, warnings, files{exe,interface,configDir,debugDir,maafwLog,guiLog,crashLog}`。

7 项 `checks` 的 `id`：`installed` / `exe` / `interface` / `configs` / `logs` / `adb` / `mumu`，`status` 为 `pass` / `warn` / `fail`。**adb、mumu 缺失只记 warn**，不阻断日常；`blockers` 只收真正阻断项。

### status

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action status
```

返回：`ok, action, root, version, title, isAdmin, running, runningPids, configCount, currentConfigId, currentConfigName, currentController, currentResource, logFile, logLines, logError, debug{maafwLog,guiLog,crashLog}`；每个日志项含 `path / exists / sizeBytes / lastWrite`。

### configs

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action configs
```

返回：`ok, action, root, configDir, count, currentConfigId, configs[]`。每项：

| 字段 | 含义 |
|---|---|
| `id` | 配置 id（= 文件名去扩展名，`-ConfigId` 用它） |
| `name` | 配置名（中文） |
| `controller` | `桌面端` / `安卓端` |
| `resource` | 如 `键鼠操作` |
| `taskCount` | 任务总数（含 4 个伪任务） |
| `checked` | `is_checked=true` 的数量 |
| `enabledTasks` | 已勾选的真实任务名数组 |
| `isCurrent` | 是否为 `multi_config.json` 里的当前配置 |
| `error` | 解析失败时的错误信息，正常为 `null` |

### get

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action get -ConfigId c_cd0c4fa2
```

返回：`ok, action, root, configId, name, file, config{name,item_id,tasks[],know_task,global_options,bundle,interface_task_list_materialized}`。`-Lines` 对本动作无意义。原始 JSON 可直接给 agent 读勾选与 `task_option`。

### run

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action run -ConfigId c_cd0c4fa2a4d14330bac904139dfa5d2f -WaitSeconds 8
```

实际执行：

```text
Start-Process "E:\software\Maa_bbb\mab.exe" -ArgumentList "--config-id","<id>","--direct-run" -WorkingDirectory "E:\software\Maa_bbb"
```

返回：`ok, action, root, configId, configName, args[], pid, startedAt, waitedSeconds, stillRunning, exitCode, logFile, logTail[]`。

- 已有 `mab.exe` 在跑 → `MAA_ALREADY_RUNNING`（exit 2），`runningPids` 给出进程号；本脚本**不加** `--reuse-existing`。
- `-WaitSeconds` 只影响本次观测（最多 600 秒），超时后进程继续跑，需要后续 `logs` / `stop`。
- 启动后 GUI 窗口可能出现；`mab.exe` 是 GUI 子系统程序，`--help` 也没有 stdout，不要用输出判断成败，**看日志与进程**。

### stop

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action stop
```

返回：`ok, action, root, killed[], remaining[], failed[]`。先 `taskkill /PID <pid> /T /F`，再 `Stop-Process` 兜底；没有进程时 `ok:true, killed:[]`。

### logs

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action logs -Kind maafw -Lines 20
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action logs -Kind gui -Lines 40 -Filter "ERR|WRN|Traceback"
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action logs -Kind crash -Lines 10
```

返回：`ok, action, root, kind, file, filter, count, lines[], sizeBytes, lastWrite`。读文件用 `FileShare.ReadWrite`，所以 mab 正在写也能读；只读取尾部约 4 MB，空行会丢弃。

### presets

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File $s -Action presets
```

返回：`ok, action, root, interface, version, interfaceVersion, count, presets[], controllers[]`；每个 preset 含 `name / label / taskCount / tasks[]`（任务名字符串数组）。

本机 3 个 preset：

| preset | label | 任务数 | 说明 |
|---|---|---|---|
| `日常-简化版` | 日常(每天都能做的任务) | 17 | 日常清单模板（含启动、家园、远征、打工、舰团、减负、两次奖励、邮箱、退出） |
| `日常-完整版` | 日常(包含周期性任务) | 28 | 额外含冒险委托、万象虚境、拓境战幕、每周分享/吼姆/答题、超弦空间、记忆战场、往世乐土等 |
| `建议单独运行` | 单独运行 | 7 | 克莱茵打灰、往世乐土、洗词缀、自动战斗、自动战斗pro、自动跳过剧情、只是测试 |

> preset 只是**任务清单模板**；真正跑什么由配置里每个任务的 `is_checked` 决定。

## 5. 退出码

| 退出码 | 含义 | 典型错误码 |
|---|---|---|
| 0 | 成功 | `ok:true` |
| 1 | 参数错 / 启动失败 / 内部错误 | `MAA_BAD_ARGS`、`MAA_CONFIG_ID_REQUIRED`、`MAA_BAD_FILTER`、`MAA_SPAWN_FAILED`、`MAA_STOP_FAILED`、`MAA_SCRIPT_ERROR` |
| 2 | 前置不满足 | `MAA_NOT_INSTALLED`、`MAA_BAD_ROOT`、`MAA_CONFIG_NOT_FOUND`、`MAA_CONFIG_DIR_MISSING`、`MAA_CONFIG_UNREADABLE`、`MAA_INTERFACE_*`、`MAA_LOG_MISSING`、`MAA_ALREADY_RUNNING` |

## 6. 配置文件结构（只读）

`config/configs/c_<32hex>.json`：

```jsonc
{
  "name": "日常(每天都能做的任务)",
  "item_id": "c_cd0c4fa2...",
  "tasks": [
    { "name": "Controller", "item_id": "Controller", "is_checked": true, "task_option": { "controller_type": "桌面端" } },
    { "name": "崩坏三 启动！", "item_id": "t_80c1e5de...", "is_checked": true, "task_option": {} }
  ],
  "know_task": {},
  "global_options": {},
  "bundle": { "MAA_bbb": { "name": "MAA_bbb", "path": "./" } },
  "interface_task_list_materialized": true
}
```

- 伪任务：`PreTask` / `Controller` / `Resource` / `Post-Action`，不是游戏任务。
- 真实任务 `item_id` 形如 `t_<32hex>`；**同名任务在不同配置里的 item_id 不同**，所以只把 item_id 当“当前配置内的键”，跨配置请用任务名或 `-ConfigId`。
- 修改勾选请用 Maa_bbb GUI；本技能与脚本**不写** `config/`。

`config/multi_config.json` 保存 `curr_config_id` 与 `config_list`。Maa GUI / 并发运行会改写 `curr_config_id`，这不影响 `-ConfigId` 指定的运行。

## 7. 日志怎么读

`maafw.log` 行格式：

```text
[2026-11-14 00:21:53.421][DBG][Px74360][Tx5168][OptionMgr.cpp][L115][MaaNS::...] | message
```

`gui.log` 行格式：

```text
[2026-11-14 00:21:53,394][WARNING][i18n_service.py][L80][load_translations_from_interface] | message
```

常用过滤：

```powershell
# 只看错误与警告（两个日志都适用）
... -Action logs -Kind maafw -Lines 200 -Filter "\[ERR\]|\[WRN\]"
... -Action logs -Kind gui -Lines 200 -Filter "ERROR|WARNING|Traceback"

# 看任务推进（任务节点 / 控制器 / 连接失败）
... -Action logs -Kind maafw -Lines 200 -Filter "Tasker|post_task|ControllerAgent|设备连接失败"
```

判断流程是否真的在跑：`status` 的 `running=true` **且** `maafw.log` 的 `lastWrite` 在最近 1–2 分钟内更新；只有进程在、日志不动，通常是卡在等游戏窗口/分辨率/管理员权限。

常见失败链（窗口没匹配到时）：

```text
gui.log  [ERROR][task_flow.py] ... | Win32 控制器未匹配窗口且未配置启动程序
gui.log  [ERROR][task_flow.py] ... | 设备连接失败
gui.log  [ERROR][task_flow.py] ... | 任务流程执行异常
gui.log  Traceback ... TaskFlowExecutionError: 设备连接失败
gui.log  [ERROR][runtime_context.py] ... | Runtime c_xxxxxxxx failed
```
