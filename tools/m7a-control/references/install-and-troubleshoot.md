# 三月七小助手：安装 / 首次运行 / 排障

> 本文件按 **v2026.10.31** 的官方行为整理（官方自带文档在 `<root>\assets\agent\skills\march7th-assistant\references\`：
> `install.md`、`config.md`、`troubleshooting.md`；本机还有 `<root>\assets\docs\FAQ.md`）。
> 只给用户明确要求安装时才下载和写盘；只是问「怎么装」时给官方 Releases 链接与要点即可。

---

## 1. 先确认到底装没装

按顺序查，**不要全盘搜索**（脚本与插件 `lib/m7a.mjs` 用同一套候选，`doctor.source` 会显示命中的是哪一路）：

1. 用户给出的路径，或脚本 `-Root <dir>`。
2. 环境变量 `DSH_GAME_DAILY_M7A_ROOT` / `M7A_ROOT`；状态指针 `<stateDir>\m7a-root.txt`（插件记下的上次确认路径）。
3. `%LOCALAPPDATA%\March7thAssistant\installs.json`：小助手每次启动都会登记安装路径与版本，最近使用的排在最前（本机就是从这里发现的）。
4. 少数常见位置：`~\Games\March7thAssistant`、`D:\March7thAssistant`、`D:\software\March7thAssistant`、`E:\software\March7thAssistant`。

用脚本一次看全：

```powershell
& "$env:USERPROFILE\.agents\skills\m7a-control\scripts\m7a.ps1" -Action doctor
```

- `ok:true` → 已安装，`root` / `version` / `source` 直接可用；**不要重装**。
- `ok:false, error:"M7A_NOT_INSTALLED"` → 没找到，`searched` 是试过的路径，`legacyOnly:true` 表示只有旧版残留（见 §6 旧版本）。
- 源码目录（有 `main.py`、`app.py`）**不是成品包**；除非用户要求，不要为此装 Python/Git。

---

## 2. 全新安装

### 2.1 选包

- 从官方最新正式版取：`https://api.github.com/repos/moesnow/March7thAssistant/releases/latest`（不要猜版本号）。
- 全新安装下载 **`March7thAssistant_full.zip`**（约 719 MB，Windows 自带解压够用）；
  已有 7-Zip 且想省流量可选 `March7thAssistant_full.7z`（约 474 MB）。
- **`update.7z` 是更新包，不能用于全新安装**；GitHub 的 Source code 压缩包也不是成品。
- 下载前核对附件的 `digest`（`sha256:...`）与 `size`；下载后 `Get-FileHash -Algorithm SHA256` 比对，一致才解压。
- GitHub 下载困难时可以告诉用户有 [Mirror酱](https://mirrorchyan.com/zh/download?rid=March7thAssistant&os=&arch=&channel=stable&source=m7a-agent)
  这个可选付费加速渠道，**由用户自己决定**；不要索要、记录或在命令里写 CDK。

### 2.2 装到哪

- 默认 `%USERPROFILE%\Games\March7thAssistant`，当前用户可写、**目录尚不存在**。
- **不要装进 `C:\Program Files`**（之后改配置要管理员权限）；不要覆盖或删除已有目录。
- 解压后应看到：`m7a.exe`、`March7th Launcher.exe`、`March7th Assistant.exe`、`config.yaml`、
  `logs\`、`assets\config\config.example.yaml`、`assets\config\version.txt`、`assets\docs\`。

### 2.3 参考流程（只下载 / 校验 / 解压，不启动游戏）

```powershell
$ErrorActionPreference = 'Stop'
$target = Join-Path $env:USERPROFILE 'Games\March7thAssistant'   # 按用户指定修改
if (Test-Path -LiteralPath $target) { throw "目标目录已存在：$target（先核实或换目录）" }

$headers = @{ 'User-Agent' = 'March7thAssistant-Agent'; 'Accept' = 'application/vnd.github+json' }
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/moesnow/March7thAssistant/releases/latest' -Headers $headers -TimeoutSec 30
if ($release.draft -or $release.prerelease) { throw '接口返回的不是正式版' }
$asset = @($release.assets | Where-Object { $_.name -ceq 'March7thAssistant_full.zip' -and $_.state -eq 'uploaded' })[0]
if (-not $asset) { throw '正式版里没有唯一的完整 ZIP 附件' }
if ($asset.digest -notmatch '^sha256:([a-fA-F0-9]{64})$') { throw '缺少官方 SHA-256，改用手动下载' }
$expected = $Matches[1].ToLowerInvariant()

$parent = Split-Path $target -Parent
New-Item -ItemType Directory -Path $parent -Force | Out-Null
$work = Join-Path $parent ('.m7a-install-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
$archive = Join-Path $work 'full.zip'
$unpacked = Join-Path $work 'unpacked'
$ok = $false
try {
    Invoke-WebRequest -Uri $asset.browser_download_url -Headers @{ 'User-Agent' = 'March7thAssistant-Agent' } -OutFile $archive -UseBasicParsing
    if ((Get-Item -LiteralPath $archive).Length -ne [long]$asset.size) { throw '下载大小与官方附件不一致' }
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected) { throw 'SHA-256 校验失败，不要解压或运行' }
    Expand-Archive -LiteralPath $archive -DestinationPath $unpacked
    $roots = @(Get-ChildItem -LiteralPath $unpacked -File -Recurse -Filter 'March7th Launcher.exe' |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'assets\config\config.example.yaml') })
    if ($roots.Count -ne 1) { throw '解压后没有找到唯一的程序目录' }
    if (Test-Path -LiteralPath $target) { throw '目标目录在安装过程中出现，拒绝覆盖' }
    Move-Item -LiteralPath $roots[0].DirectoryName -Destination $target
    $ok = $true
    "安装目录：$target"
    "版本：$($release.tag_name)（SHA-256 已校验）"
} finally {
    if ($ok) { Remove-Item -LiteralPath $work -Recurse -Force }
    else { Write-Warning "安装未完成，临时文件保留在：$work" }
}
```

### 2.4 安装后（第一次运行前）

1. 运行 `March7th Launcher.exe`（会弹 UAC），首次启动显示**免责声明（含账号风险提示）——必须用户本人阅读并确认**，agent 不代点。
2. 在图形界面里确认游戏路径（多数情况自动识别），或改用云游戏。
3. 回到 agent：

   ```powershell
   & $m7a -Action doctor            # 期望 blockers 为空、files 全 true、firstRun/gamePath 通过
   & $m7a -Action status -Tasks     # 拿到本机真实任务表
   & $m7a -Action run -Task power -Detach   # 想先试一个短任务
   ```

汇报时区分：已有安装 / 已下载 / 已校验 / 已解压 / 已打开图形界面 / 用户已完成首次确认——没亲自验证的如实说明。

---

## 3. doctor 输出怎么读（排障第一站）

```powershell
& $m7a -Action doctor
```

| 字段 | 含义 |
| --- | --- |
| `ok` / `blockers[]` / `warnings[]` | `ok:false` 时 `error` = 第一个 blocker；blocker 必须先解决 |
| `root` / `source` / `version` | 安装目录、发现来源（`root` / `env:...` / `state-pointer` / `installs.json` / `default-candidates`）、版本 |
| `files{9}` | `m7aExe/launcher/assistant/config/exampleConfig/versionFile/logsDir/runsDir/docsDir` 是否存在 |
| `status` / `statusExitCode` | `--status --json` 的原始结果与退出码 |
| `config.values` | 白名单键（`game_path` 等）读回值；`config.error` 非空说明 YAML 读不到 |
| `todayLog.lines` | 当天日志末尾（没有运行过时为空，不是错误） |
| `recentRuns[]` | 最近 3 次运行（`runId/status/exit_code/error/screenshot`） |
| `checks[7]` | `installed/status/firstRun/gamePath/activeRun/config/todayLog` |
| `deepCheck` | `firstRunOk` / `gamePathOk` / `activeRun` 三个最关键的判定 |

**blocker 对照**

| blocker | 原因 | 修法 |
| --- | --- | --- |
| `M7A_STATUS_UNPARSABLE` | `m7a.exe --status --json` 没输出可解析 JSON | 手动跑一次看报错；被杀软拦截 / 安装损坏 → 见 §6 |
| `M7A_FIRST_RUN_NOT_COMPLETED` | `first_run_completed=false` | 用户本人开 `March7th Launcher.exe` 确认免责声明（exit 3 同源） |
| `M7A_GAME_PATH_MISSING` | `game_path_exists=false` | 改 `config.yaml` 的 `game_path` 或让 GUI 自动识别；再跑 doctor |

**warning 对照**：`M7A_ACTIVE_RUN`（已有任务在跑，别重复起）、`M7A_CONFIG_GAME_PATH_EMPTY`（配置里 game_path 空）、
`M7A_CONFIG_UNREADABLE`（YAML 解析失败——你刚改坏过就回滚备份）、`M7A_TODAY_LOG_MISSING`（今天还没跑过，正常）。

---

## 4. 退出码与对应处理

| 码 | 触发 | 处理 |
| --- | --- | --- |
| 3 | 首次免责声明未确认（`first_run_required`） | 让用户开 GUI 本人确认；**不要**改文件绕过 |
| 4 | 已有任务在跑（`busy`） | `status` 看 `active_run`，`follow -Run latest` 等它结束；确需中断用 `control stop` |
| 5 | UAC 被取消 / 无法提权 | 让用户在弹窗点「是」；无人值守改用小助手自带定时任务 |
| 6 | 被 `--control current stop` 中止 | 任务未完成；确认用户意图后重跑 |
| 1 | 任务失败 | 读 `logs\runs\<runId>.json` 的 `error`/`screenshot` + 日志末尾，按 §5 定位 |
| 2 | 参数错误 / 脚本层前置不满足 | 看 `error`/`hint`；任务 id 用 `status -Tasks` 核对 |

---

## 5. 常见故障（按现象查）

| 现象 | 常见原因 | 处理 |
| --- | --- | --- |
| 日志「无法切换到指定游戏界面」/ 识别失败 | 非 16:9 分辨率、全屏独占、HDR、画面滤镜/帧率显示、窗口被遮挡、游戏没真正进主界面 | 看 `screenshot`；开 `auto_set_resolution_enable`；关闭 HDR/滤镜；把游戏切到窗口化 16:9 ≥1080p；再跑 |
| `game_path_exists:false` / 启动游戏失败 | `game_path` 失效（游戏搬家/换盘/多客户端） | 改 `game_path`（或 GUI 里选）；`auto_set_game_path_enable: true` |
| 找不到 `m7a.exe` | 旧版本（只有 `March7th Assistant.exe`） | 用 `app_update` 或图形界面更新；旧版需 `-Verb RunAs` 且可能拿不到退出码 |
| 运行锁不可用 / `lock: unavailable` | `logs\runs\` 权限、磁盘满、杀软拦截 | 修权限/清盘/加白名单；先 `status` 确认没有别的任务在跑 |
| 程序被删 / 找不到可执行文件 | 杀毒软件误删 | 把小助手目录加入排除项后重新解压（别用 update 包） |
| 任务结束后关机/睡眠 | `after_finish` 生效了 | agent 发起的运行固定 `--after-finish None`；检查配置是否被改成 `Shutdown` 等 |
| 中文乱码 | 终端编码不是 UTF-8 | `[Console]::OutputEncoding = [Text.Encoding]::UTF8`；或直接读 UTF-8 日志文件 |
| `status: running` 但进程不在了 | 控制台窗口被关 / 进程被杀 | 视为 aborted，不算完成；重跑并保留终端 |
| 改完配置没生效 | 正在运行的任务不读新值 / GUI 回写覆盖 | 任务结束后再改；改前让用户退出 GUI；`doctor` 复核 `config.values` |
| 两个任务同时操控游戏 | 单实例锁被绕过（`--force`）或锁不可用 | **不要**并发；只用一个入口（GUI 或命令行） |
| 定时任务不触发 | GUI 没运行（定时由 GUI 执行） | 保持 GUI 运行/最小化到托盘，或开开机自启 |
| GitHub 下载慢/失败 | 网络 | 官方 Releases 重试；或用户自选 Mirror酱（不碰 CDK） |

---

## 6. 旧版本（没有 `m7a.exe`）

旧版本只有 `March7th Assistant.exe`，清单要求管理员权限：普通终端运行会报「需要提升」，提权后又在新窗口跑，
看不到输出也拿不到退出码。替代做法：

```powershell
$dir = 'D:\March7thAssistant'   # 安装目录
$p = Start-Process -FilePath (Join-Path $dir 'March7th Assistant.exe') -ArgumentList 'daily' `
     -WorkingDirectory $dir -Verb RunAs -PassThru -Wait
$p.ExitCode
Get-Content (Join-Path $dir ("logs\" + (Get-Date -Format 'yyyy-MM-dd') + '.log')) -Encoding utf8 -Tail 40
```

旧版默认结束时停在窗口等回车（`pause_after_success` / `exit_after_failure`），没有人按回车 `-Wait` 会一直等。
**建议更新到带 `m7a.exe` 的新版本**（`run -Task app_update` 或图形界面检查更新）。

---

## 7. 更新、备份与回滚

- **更新**：`& $m7a -Action run -Task app_update`，或图形界面「检查更新」。
  **不要用完整包覆盖已有安装**（`update.7z` 才是更新包）。
- **备份**（改配置或升级前）：

  ```powershell
  $root = (& "$env:USERPROFILE\.agents\skills\m7a-control\scripts\m7a.ps1" -Action doctor | ConvertFrom-Json).root
  Copy-Item "$root\config.yaml" "$root\config.yaml.bak-$(Get-Date -Format yyyyMMdd-HHmmss)"
  Copy-Item "$root\config" "$root\config.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Recurse   # 流程编排等
  ```

- **回滚**：把 `config.yaml.bak-*` 复制回 `config.yaml`，再 `doctor` 确认 `config.ok`。
- **卸载/迁移**：先关闭 GUI 与运行中的任务，整目录移动/删除；`installs.json` 里的旧路径会在下次启动时被覆盖登记。
