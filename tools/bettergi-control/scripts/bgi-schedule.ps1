<#
.SYNOPSIS
    调度与运行历史一览：Windows 计划任务、包装器日志、一条龙配置、配置组、今日跑没跑。
.DESCRIPTION
    回答"明天几点跑 / 昨天跑成没 / 包装器有没有替我清残留"这类问题。
    只读，不启动任何进程。
.PARAMETER Root
    BetterGI 安装根，默认 D:\software\BetterGI
.PARAMETER Runs
    额外回溯最近几次一条龙运行（从日志里扫"一条龙和配置组任务结束"），默认 5 次。
.PARAMETER Json
    机器可读 JSON
.EXAMPLE
    pwsh -File bgi-schedule.ps1
.NOTES
    退出码：0=正常；1=发现问题（计划任务缺失/未触发）；2=前置不满足。UTF-8 带 BOM（PS 5.1）。
#>
[CmdletBinding()]
param(
    [string]$Root = 'D:\software\BetterGI',
    [int]$Runs = 5,
    [switch]$Json
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$warnings = New-Object System.Collections.ArrayList
$r = [ordered]@{
    root = $Root
    checkedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    task = $null
    runnerLogTail = @()
    oneDragon = @()
    groups = @()
    recentRuns = @()
    todayRun = $false
    warnings = @()
}

# ---------- ① Windows 计划任务 ----------
$taskName = 'BetterGI 日常一条龙'
try {
    $t = Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    $info = $t | Get-ScheduledTaskInfo
    $r.task = [ordered]@{
        name = $t.TaskName
        state = [string]$t.State
        trigger = if ($t.Triggers.Count -gt 0) { [string]$t.Triggers[0].StartBoundary } else { '' }
        nextRun = if ($info.NextRunTime) { $info.NextRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '' }
        lastRun = if ($info.LastRunTime -and $info.LastRunTime.Year -gt 1999) { $info.LastRunTime.ToString('yyyy-MM-dd HH:mm:ss') } else { '（从未运行）' }
        lastResult = $info.LastTaskResult
        runLevel = [string]$t.Principal.RunLevel
        action = if ($t.Actions.Count -gt 0) { "$($t.Actions[0].Execute) $($t.Actions[0].Arguments)".Trim() } else { '' }
        wakeToRun = [bool]$t.Settings.WakeToRun
    }
    if ($info.LastTaskResult -ne 0) { [void]$warnings.Add("计划任务上次返回码 $($info.LastTaskResult)（非 0）") }
    if (-not $t.Actions[0].Arguments -or $t.Actions[0].Arguments -notmatch '_daily_runner') {
        [void]$warnings.Add("计划任务动作不是包装器 _daily_runner.ps1（挂着的 BetterGI 会让命令被吞掉）")
    }
} catch {
    [void]$warnings.Add("找不到计划任务「$taskName」：$($_.Exception.Message)")
}

# ---------- ② 包装器日志 ----------
$runnerLog = Join-Path $Root '_daily_runner.log'
if (Test-Path -LiteralPath $runnerLog) {
    try {
        $fs = [System.IO.File]::Open($runnerLog, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        $txt = $sr.ReadToEnd(); $sr.Dispose(); $fs.Dispose()
        $lines = @($txt -split "`r?`n" | Where-Object { $_ })
        $r.runnerLogTail = @($lines | Select-Object -Last 8)
        $todayStamp = (Get-Date).ToString('yyyy-MM-dd')
        # 不要写 -like "[$stamp*" —— `[` 在 -like 里是通配符起止符（踩过）
        $todayLines = @($lines | Where-Object { $_.Contains($todayStamp) })
        $r.todayRun = ($todayLines | Where-Object { $_ -match 'BetterGI 已启动' }).Count -gt 0
        $cleaned = @($todayLines | Where-Object { $_ -match '发现 \d+ 个' })
        if ($cleaned.Count -gt 0) { [void]$warnings.Add("今天包装器清理过残留实例（$($cleaned[-1])）——按设计工作，但说明当时 BetterGI 还开着") }
        if ($todayLines | Where-Object { $_ -match '本次不启动' }) { [void]$warnings.Add('今天包装器放弃了启动（残留实例没清干净）') }
    } catch { [void]$warnings.Add("包装器日志读取失败：$($_.Exception.Message)") }
} else { [void]$warnings.Add("没有包装器日志 $runnerLog（计划任务可能还在用裸调用）") }

# ---------- ③ 一条龙配置 ----------
try {
    $od = Join-Path $Root 'User\OneDragon'
    if (Test-Path -LiteralPath $od) {
        Get-ChildItem -LiteralPath $od -Filter '*.json' -File | Sort-Object Name | ForEach-Object {
            $o = $null
            try { $o = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
            if (-not $o) { [void]$warnings.Add("一条龙配置 $($_.Name) 解析失败"); return }
            $order = @()
            if ($o.TaskOrder) {
                foreach ($id in $o.TaskOrder) {
                    $nm = if ($o.TaskDefinitions) { $o.TaskDefinitions.$id } else { $null }
                    if ($nm) { $order += [string]$nm } else { $order += [string]$id }
                }
            }
            $r.oneDragon += [ordered]@{ name = $o.Name; file = $_.Name; tasks = $order; completionAction = [string]$o.CompletionAction }
        }
    }
} catch { [void]$warnings.Add("一条龙配置检查失败：$($_.Exception.Message)") }

# ---------- ④ 配置组（哪些已接进一条龙） ----------
try {
    $sgDir = Join-Path $Root 'User\ScriptGroup'
    if (Test-Path -LiteralPath $sgDir) {
        $inFlow = @()
        foreach ($c in $r.oneDragon) { $inFlow += @($c.tasks) }
        Get-ChildItem -LiteralPath $sgDir -Filter '*.json' -File | Sort-Object Name | ForEach-Object {
            $g = $null
            try { $g = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
            if ($g) {
                $r.groups += [ordered]@{
                    name = $g.name
                    projects = @($g.projects).Count
                    inOneDragon = ($inFlow -contains $g.name)
                }
            }
        }
    }
} catch { [void]$warnings.Add("配置组检查失败：$($_.Exception.Message)") }

# ---------- ⑤ 最近几次运行（从日志扫收尾标记） ----------
try {
    $logDir = Join-Path $Root 'log'
    $files = @(Get-ChildItem -LiteralPath $logDir -Filter 'better-genshin-impact*.log' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 3)
    foreach ($f in $files) {
        try {
            $fs = [System.IO.File]::Open($f.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
            $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
            $txt = $sr.ReadToEnd(); $sr.Dispose(); $fs.Dispose()
            foreach ($m in [regex]::Matches($txt, '\[(\d{2}:\d{2}:\d{2})\.\d+\][^\n]*\n[^\n]*一条龙和配置组任务结束')) {
                $r.recentRuns += [ordered]@{ date = $f.LastWriteTime.ToString('yyyy-MM-dd'); time = $m.Groups[1].Value }
            }
        } catch { }
    }
    $r.recentRuns = @($r.recentRuns | Select-Object -Last $Runs)
} catch { }

$r.warnings = @($warnings)

if ($Json) {
    $r | ConvertTo-Json -Depth 6
} else {
    "=== BetterGI 调度与运行一览（$($r.checkedAt)）==="
    if ($r.task) {
        "计划任务    : $($r.task.name)  State=$($r.task.state)"
        "  触发      : $($r.task.trigger)   下次=$($r.task.nextRun)"
        "  上次      : $($r.task.lastRun)  返回码=$($r.task.lastResult)  RunLevel=$($r.task.runLevel)  WakeToRun=$($r.task.wakeToRun)"
        "  动作      : $($r.task.action)"
    } else { "计划任务    : ✗ 未找到" }
    "今天跑了吗  : $(if ($r.todayRun) { '已触发过（包装器日志有启动记录）' } else { '尚未触发（或今天没跑）' })"
    foreach ($o in $r.oneDragon) { "一条龙      : $($o.name)  $(($o.tasks) -join ' → ')  收工='$($o.completionAction)'" }
    foreach ($g in $r.groups) { "配置组      : $($g.name)  $($g.projects) 项  已接进一条龙=$(if ($g.inOneDragon) { '是' } else { '否（按需）' })" }
    if ($r.recentRuns.Count) { "最近收尾    : " + (($r.recentRuns | ForEach-Object { "$($_.date) $($_.time)" }) -join ' | ') }
    if ($r.runnerLogTail.Count) { ""; "包装器日志尾部："; $r.runnerLogTail | ForEach-Object { "  $_" } }
    if ($r.warnings.Count) { ""; "⚠ 注意："; $r.warnings | ForEach-Object { "  - $_" } } else { ""; "✓ 调度无明显问题" }
}

if ($warnings.Count -gt 0) { exit 1 }
exit 0
