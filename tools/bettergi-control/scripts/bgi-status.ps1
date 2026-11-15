<#
.SYNOPSIS
    BetterGI 状态总览（只读，不修改任何文件）。
.DESCRIPTION
    一次性输出：进程、游戏窗口尺寸与 16:9 判断、User\config.json 关键键、
    User\OneDragon\*.json 摘要、最新日志尾部、task_progress / ExecutionRecords 列表、
    以及触发前的前置检查结论（阻断项）。
.PARAMETER Root
    BetterGI 安装根，默认 D:\software\BetterGI
.PARAMETER Json
    以 JSON 输出（供 agent / 后续 MCP 消费）
.PARAMETER TailLines
    日志尾部行数，默认 20
.EXAMPLE
    pwsh -File bgi-status.ps1 -Json
.NOTES
    退出码：0=正常；2=安装根缺失。UTF-8 带 BOM 保存（Windows PowerShell 5.1）。
#>
[CmdletBinding()]
param(
    [string]$Root = 'D:\software\BetterGI',
    [switch]$Json,
    [switch]$Raw,
    [int]$TailLines = 20
)

$ErrorActionPreference = 'Continue'
$result = [ordered]@{
    root            = $Root
    rootExists      = $false
    bgiRunning      = $false
    bgiPids         = @()
    gameRunning     = $false
    gamePids        = @()
    gameWindow      = $null
    configParseOk   = $false
    config          = [ordered]@{}
    oneDragon       = @()
    logFile         = $null
    logTail         = @()
    taskProgress    = @()
    executionRecords = @()
    blockers        = @()
    warnings        = @()
}

# ---------- 0. 安装根 ----------
$result.rootExists = Test-Path -LiteralPath $Root
if (-not $result.rootExists) {
    if ($Json) { $result | ConvertTo-Json -Depth 6 } else { "✗ 安装根不存在: $Root" }
    exit 2
}

# ---------- 1. 进程 ----------
$bgi = @(Get-Process -Name 'BetterGI' -ErrorAction SilentlyContinue)
$game = @(Get-Process -Name 'YuanShen' -ErrorAction SilentlyContinue)
$result.bgiRunning = ($bgi.Count -gt 0)
$result.bgiPids = @($bgi | ForEach-Object { $_.Id })
$result.gameRunning = ($game.Count -gt 0)
$result.gamePids = @($game | ForEach-Object { $_.Id })

# ---------- 2. 游戏窗口（客户区尺寸） ----------
if ($result.gameRunning) {
    try {
        if (-not ('BgiAgentWinUtil' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class BgiAgentWinUtil {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    public static uint ForegroundPid() { uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return pid; }
    public static string WindowTitle(IntPtr hWnd) { var sb = new StringBuilder(512); GetWindowText(hWnd, sb, sb.Capacity); return sb.ToString(); }
}
'@ -ErrorAction Stop
        }
        $proc = $game | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($proc) {
            $r = New-Object BgiAgentWinUtil+RECT
            [void][BgiAgentWinUtil]::GetClientRect($proc.MainWindowHandle, [ref]$r)
            $w = $r.Right - $r.Left
            $h = $r.Bottom - $r.Top
            # 本进程默认**不感知 DPI** → GetClientRect 返回被虚拟化的逻辑值（如 150% 缩放下 = 物理/1.5）
            # 必须用窗口自身 DPI 乘回去，否则会把合格的 1920x1080 误判成 1280x720（2026-10-17 实测踩到）
            $dpi = [BgiAgentWinUtil]::GetDpiForWindow($proc.MainWindowHandle)
            if ($dpi -gt 96) { $w = [int][math]::Round($w * $dpi / 96); $h = [int][math]::Round($h * $dpi / 96) }
            $ratio = if ($h -gt 0) { [math]::Round($w / $h, 4) } else { 0 }
            $result.gameWindow = [ordered]@{
                pid            = $proc.Id
                title          = $proc.MainWindowTitle
                clientWidth    = $w
                clientHeight   = $h
                is169          = ([math]::Abs($ratio - 1.7778) -lt 0.02)
                atLeast1080p   = ($w -ge 1920 -and $h -ge 1080)
                minimized      = [BgiAgentWinUtil]::IsIconic($proc.MainWindowHandle)
                foreground     = ([BgiAgentWinUtil]::ForegroundPid() -eq $proc.Id)
                foregroundTitle = [BgiAgentWinUtil]::WindowTitle([BgiAgentWinUtil]::GetForegroundWindow())
                readyForTask   = (-not [BgiAgentWinUtil]::IsIconic($proc.MainWindowHandle)) -and ([BgiAgentWinUtil]::ForegroundPid() -eq $proc.Id) -and ([math]::Abs($ratio - 1.7778) -lt 0.02) -and ($w -ge 1920 -and $h -ge 1080)
            }
        }
    } catch {
        $result.warnings += "窗口尺寸读取失败: $($_.Exception.Message)"
    }
}

# ---------- 3. config.json 关键键（JSON 解析失败时用正则兜底） ----------
$cfgPath = Join-Path $Root 'User\config.json'
$cfgRaw = $null
if (Test-Path -LiteralPath $cfgPath) {
    $cfgRaw = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8
    $cfgObj = $null
    try { $cfgObj = $cfgRaw | ConvertFrom-Json; $result.configParseOk = $true }
    catch { $result.warnings += "config.json 无法按 JSON 解析（可能含注释/尾逗号），已回退正则读取" }

    function Get-Rx([string]$pattern) {
        $m = [regex]::Match($cfgRaw, $pattern)
        if ($m.Success) { return $m.Groups[1].Value }
        return $null
    }
    function Get-Cfg([string]$path, [string]$rxPattern) {
        if ($cfgObj) {
            $node = $cfgObj
            foreach ($seg in $path.Split('.')) {
                if ($null -eq $node) { break }
                $node = $node.$seg
            }
            if ($null -ne $node) { return $node }
        }
        return (Get-Rx $rxPattern)
    }

    $result.config = [ordered]@{
        captureMode            = Get-Cfg 'captureMode' '"captureMode"\s*:\s*"([^"]*)"'
        triggerInterval        = Get-Cfg 'triggerInterval' '"triggerInterval"\s*:\s*(-?\d+)'
        pickKey                = Get-Cfg 'autoPickConfig.pickKey' '"pickKey"\s*:\s*"([^"]*)"'
        autoPickEnabled        = Get-Cfg 'autoPickConfig.enabled' '"autoPickConfig"[\s\S]{0,400}?"enabled"\s*:\s*(true|false)'
        autoPickMode           = Get-Cfg 'autoPickConfig.mode' '"mode"\s*:\s*"([^"]*)"'
        autoSkipEnabled        = Get-Cfg 'autoSkipConfig.enabled' '"autoSkipConfig"[\s\S]{0,400}?"enabled"\s*:\s*(true|false)'
        fightStrategyName      = Get-Cfg 'autoFightConfig.strategyName' '"strategyName"\s*:\s*"([^"]*)"'
        specifyResinUse        = Get-Cfg 'autoDomainConfig.specifyResinUse' '"specifyResinUse"\s*:\s*(true|false)'
        condensedResinUseCount = Get-Cfg 'autoDomainConfig.condensedResinUseCount' '"condensedResinUseCount"\s*:\s*(\d+)'
        transientResinUseCount = Get-Cfg 'autoDomainConfig.transientResinUseCount' '"transientResinUseCount"\s*:\s*(\d+)'
        originalResinUseCount  = Get-Cfg 'autoDomainConfig.originalResinUseCount' '"originalResinUseCount"\s*:\s*(\d+)'
        fragileResinUseCount   = Get-Cfg 'autoDomainConfig.fragileResinUseCount' '"fragileResinUseCount"\s*:\s*(\d+)'
        autoEnterGameEnabled   = Get-Cfg 'genshinStartConfig.autoEnterGameEnabled' '"autoEnterGameEnabled"\s*:\s*(true|false)'
        linkedStartEnabled     = Get-Cfg 'genshinStartConfig.linkedStartEnabled' '"linkedStartEnabled"\s*:\s*(true|false)'
        installPath            = Get-Cfg 'genshinStartConfig.installPath' '"installPath"\s*:\s*"([^"]*)"'
        bgiEnabledHotkey       = Get-Cfg 'hotKeyConfig.bgiEnabledHotkey' '"bgiEnabledHotkey"\s*:\s*"([^"]*)"'
        cancelTaskHotkey       = Get-Cfg 'hotKeyConfig.cancelTaskHotkey' '"cancelTaskHotkey"\s*:\s*"([^"]*)"'
    }
} else {
    $result.warnings += "找不到 $cfgPath（BetterGI 是否还没首次运行过？）"
}

# ---------- 4. 一条龙配置摘要 ----------
$odDir = Join-Path $Root 'User\OneDragon'
if (Test-Path -LiteralPath $odDir) {
    foreach ($f in (Get-ChildItem -LiteralPath $odDir -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
        $item = [ordered]@{ file = $f.Name; name = $null; order = @(); partyName = $null; domainName = $null; dailyRewardPartyName = $null }
        try {
            $od = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            $item.name = $od.Name
            $defs = $od.TaskDefinitions
            $order = @()
            if ($od.TaskOrder) { $order = @($od.TaskOrder) }
            elseif ($od.TaskEnabledList) { $order = @($od.TaskEnabledList.PSObject.Properties | ForEach-Object { $_.Name }) }
            $names = @()
            foreach ($k in $order) {
                if ($defs -and $defs.PSObject.Properties.Name -contains $k) { $names += $defs.$k } else { $names += $k }
            }
            $item.order = $names
            $item.partyName = $od.PartyName
            $item.domainName = $od.DomainName
            $item.dailyRewardPartyName = $od.DailyRewardPartyName
            $item.craftingBenchCountry = $od.CraftingBenchCountry
            $item.adventurersGuildCountry = $od.AdventurersGuildCountry
        } catch {
            $item.name = "<解析失败: $($_.Exception.Message)>"
        }
        $result.oneDragon += $item
    }
}

# ---------- 5. 日志 / 进度 / 执行记录 ----------
$logDir = Join-Path $Root 'log'
$latestLog = Get-ChildItem -LiteralPath $logDir -Filter 'better-genshin-impact*.log' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
if ($latestLog) {
    $result.logFile = [ordered]@{
        path     = $latestLog.FullName
        sizeKB   = [math]::Round($latestLog.Length / 1KB, 1)
        lastWrite = $latestLog.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
    }
    # 共享读文本后自行分行：本机脚本上下文里 Get-Content 会给每行附加 PSDrive/PSProvider 元属性，JSON 会炸
    $logText = ''
    try {
        $fs = [System.IO.File]::Open($latestLog.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        $logText = $sr.ReadToEnd()
        $sr.Dispose(); $fs.Dispose()
    } catch { $logText = '' }
    $allLines = @($logText -split "`r?`n")
    $tailBuf = @($allLines | Where-Object { $_ -and $_.Trim() -ne '' } | Select-Object -Last $TailLines)
    if (-not $Raw) {
        # 默认过滤 .NET 堆栈帧，只留消息与日志头（避免 cnb.cool 之类异常刷屏）
        $tailBuf = @($tailBuf | Where-Object {
            $_ -notmatch '^\s+at\s' -and $_ -notmatch '^\s+---' -and $_ -notmatch '^\s+at BetterGenshinImpact'
        })
    }
    $result.logTail = $tailBuf
}

$tpDir = Join-Path $logDir 'task_progress'
if (Test-Path -LiteralPath $tpDir) {
    $result.taskProgress = @(Get-ChildItem -LiteralPath $tpDir -Filter '*.json' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 5 | ForEach-Object {
            $end = $null
            try { $end = (Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json).endTime } catch { }
            [ordered]@{ name = $_.Name; lastWrite = $_.LastWriteTime.ToString('HH:mm:ss'); endTime = $end }
        })
}
$exDir = Join-Path $logDir 'ExecutionRecords'
if (Test-Path -LiteralPath $exDir) {
    $result.executionRecords = @(Get-ChildItem -LiteralPath $exDir -Filter '*.json' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 3 | ForEach-Object {
            [ordered]@{ name = $_.Name; sizeKB = [math]::Round($_.Length / 1KB, 1) }
        })
}

# ---------- 6. 前置检查（阻断项） ----------
if ($result.bgiRunning) {
    $result.blockers += "BetterGI 正在运行（PID $($result.bgiPids -join ','))：可以触发任务，但**改配置类操作必须先让用户退出程序**"
}
if ($result.configParseOk -and $result.config.captureMode -and $result.config.captureMode -ne 'BitBlt') {
    $result.warnings += "captureMode=$($result.config.captureMode)（不是 BitBlt）：地图追踪/部分识别会表现异常"
}
if ($result.config.pickKey -and $result.config.pickKey -notin @('F', 'E', 'G', 'L')) {
    $result.warnings += "pickKey=$($result.config.pickKey) 不在 E/F/G/L 内 → BetterGI 会静默回退按 F，游戏内交互键也会对不上"
}
if ($result.gameWindow) {
    if (-not $result.gameWindow.is169) { $result.blockers += "游戏窗口客户区 $($result.gameWindow.clientWidth)x$($result.gameWindow.clientHeight) 不是 16:9 → 自动秘境/寻路会失败" }
    elseif (-not $result.gameWindow.atLeast1080p) { $result.warnings += "窗口 $($result.gameWindow.clientWidth)x$($result.gameWindow.clientHeight) 是 16:9 但小于 1920x1080 → 自动秘境可能异常" }
    if ($result.gameWindow.minimized) { $result.blockers += "游戏窗口处于最小化 → 截图会失败" }
}
if (-not $result.gameRunning) { $result.warnings += "游戏未运行（触发 start/一条龙时会由 BetterGI 联动启动）" }

# ---------- 7. 输出 ----------
if ($Json) {
    $result | ConvertTo-Json -Depth 6
} else {
    "=== BetterGI 状态（$Root） ==="
    "进程        : BetterGI=$(if ($result.bgiRunning) { "运行中 PID $($result.bgiPids -join ',')" } else { '未运行' })  原神=$(if ($result.gameRunning) { "运行中 PID $($result.gamePids -join ',')" } else { '未运行' })"
    if ($result.gameWindow) {
        "游戏窗口    : $($result.gameWindow.clientWidth)x$($result.gameWindow.clientHeight)  16:9=$($result.gameWindow.is169)  ≥1080P=$($result.gameWindow.atLeast1080p)  最小化=$($result.gameWindow.minimized)  前台=$($result.gameWindow.foreground)  可跑=$($result.gameWindow.readyForTask)"
        if (-not $result.gameWindow.foreground) { "  当前前台窗口: $($result.gameWindow.foregroundTitle)（自动化要求原神保持前台，否则任务会暂停）" }
    }
    "截图/间隔   : $($result.config.captureMode) / $($result.config.triggerInterval)ms   拾取键=$($result.config.pickKey)  模式=$($result.config.autoPickMode)"
    "自动战斗    : 策略=$($result.config.fightStrategyName)"
    "自动秘境树脂: 指定模式=$($result.config.specifyResinUse)  浓缩=$($result.config.condensedResinUseCount) 须臾=$($result.config.transientResinUseCount) 原粹=$($result.config.originalResinUseCount) 脆弱=$($result.config.fragileResinUseCount)"
    "启动配置    : 自动进游戏=$($result.config.autoEnterGameEnabled) 联动启动=$($result.config.linkedStartEnabled) 游戏路径=$($result.config.installPath)"
    "热键        : 启用/禁用=$($result.config.bgiEnabledHotkey)  停止任务=$($result.config.cancelTaskHotkey)"
    ""
    if ($result.oneDragon.Count -gt 0) {
        "--- 一条龙配置 ---"
        foreach ($od in $result.oneDragon) {
            "  [$($od.name)] 顺序: $($od.order -join ' → ')"
            "      秘境队伍=$($od.partyName)  秘境=$($od.domainName)  每日奖励队伍=$($od.dailyRewardPartyName)"
            "      合成台=$($od.craftingBenchCountry)  冒险家协会=$($od.adventurersGuildCountry)"
        }
        ""
    }
    if ($result.logFile) { "--- 最新日志 ---"; "  $($result.logFile.path)  ($($result.logFile.sizeKB) KB, $($result.logFile.lastWrite))" }
    if ($result.logTail.Count -gt 0) { "--- 日志尾部 $($result.logTail.Count) 行 ---"; $result.logTail | ForEach-Object { "  $_" } }
    if ($result.taskProgress.Count -gt 0) { ""; "--- task_progress（最近 5）---"; $result.taskProgress | ForEach-Object { "  $($_.name)  写入=$($_.lastWrite)  endTime=$($_.endTime)" } }
    if ($result.executionRecords.Count -gt 0) { "--- ExecutionRecords（最近 3）---"; $result.executionRecords | ForEach-Object { "  $($_.name)  ($($_.sizeKB) KB)" } }
    ""
    if ($result.blockers.Count -gt 0) { "⛔ 阻断项："; $result.blockers | ForEach-Object { "  - $_" } } else { "✓ 无阻断项" }
    if ($result.warnings.Count -gt 0) { "⚠ 提示："; $result.warnings | ForEach-Object { "  - $_" } }
}

exit 0
