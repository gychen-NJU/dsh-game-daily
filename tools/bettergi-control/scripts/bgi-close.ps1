<#
.SYNOPSIS
    关闭原神 / BetterGI（先优雅关闭，必要时强制），并如实报告是否真的关掉了。
.DESCRIPTION
    为什么需要它：改 User\config.json、User\OneDragon\*.json、User\ScriptGroup\*.json 之前
    **必须**先退出 BetterGI（程序没有配置监听，运行中会整份回写覆盖）；而"重新以 1920×1080 拉起游戏"
    也要先关掉旧实例。

    已知权限边界（实测）：
      · 原神一般是普通权限 → 本脚本（普通权限）就能关掉；
      · BetterGI 可能以管理员权限运行（它会自我提权重启，退出码 553 那种）→ 普通权限关不掉，
        此时脚本会明确报告"权限不足"，并给出手动/包装器两条替代路径（不要用调试器或注入去绕过）。

.PARAMETER Target
    game=只关原神；bettergi=只关 BetterGI；both=都关。默认 game。
.PARAMETER Force
    跳过优雅关闭（CloseMainWindow）直接强制结束。默认先优雅、超时才强制。
.PARAMETER GraceSeconds
    优雅关闭的等待秒数（默认 12）。
.PARAMETER DryRun
    只报告将关闭哪些进程，不动手。
.PARAMETER Json
    机器可读 JSON。
.EXAMPLE
    pwsh -File bgi-close.ps1 -Target game -DryRun
    pwsh -File bgi-close.ps1 -Target both
.NOTES
    退出码：0=目标都已不在（含本来就未运行）；1=仍有目标存活（多为权限不足）；2=参数/前置问题。
    UTF-8 带 BOM（PS 5.1）。
#>
[CmdletBinding()]
param(
    [ValidateSet('game', 'bettergi', 'both')][string]$Target = 'game',
    [switch]$Force,
    [int]$GraceSeconds = 12,
    [string]$GameProcess = 'YuanShen',
    [string]$BgiProcess = 'BetterGI',
    [switch]$DryRun,
    [switch]$Json
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Get-Elevated([System.Diagnostics.Process]$p) {
    # 判断进程是否以管理员权限运行：普通权限读不到它的某些信息时通常意味着更高完整性级别
    try { [void]$p.Handle; return $false } catch { return $true }
}

$names = @()
if ($Target -eq 'game' -or $Target -eq 'both') { $names += $GameProcess }
if ($Target -eq 'bettergi' -or $Target -eq 'both') { $names += $BgiProcess }

$plan = New-Object System.Collections.ArrayList
foreach ($n in $names) {
    foreach ($p in @(Get-Process -Name $n -ErrorAction SilentlyContinue)) {
        $title = ''
        try { $title = $p.MainWindowTitle } catch { }
        [void]$plan.Add([ordered]@{
            name     = $n
            pid      = $p.Id
            title    = $title
            elevated = (Get-Elevated $p)
            action   = if ($Force) { 'force-kill' } else { 'close-then-kill-if-needed' }
        })
    }
}

$results = New-Object System.Collections.ArrayList

if ($plan.Count -eq 0) {
    $out = [ordered]@{
        target = $Target; dryRun = [bool]$DryRun; planned = @(); results = @()
        message = '没有需要关闭的进程（目标本来就未运行）。'
    }
    if ($Json) { $out | ConvertTo-Json -Depth 6 -Compress }
    else { "✓ 没有需要关闭的进程（$Target 本来就未运行）。" }
    exit 0
}

if ($DryRun) {
    if ($Json) {
        ([ordered]@{ target = $Target; dryRun = $true; planned = @($plan); results = @() }) | ConvertTo-Json -Depth 6
    } else {
        "=== 将关闭以下进程（DryRun，未动手）==="
        foreach ($it in $plan) {
            "  · $($it.name) PID $($it.pid)  窗口='$($it.title)'  管理员权限=$(if ($it.elevated) { '是（普通权限可能关不掉）' } else { '否' })"
        }
        "  方式：$(if ($Force) { '强制结束' } else { "先优雅关闭，$GraceSeconds 秒内没退出再强制结束" })"
    }
    exit 0
}

foreach ($it in $plan) {
    $p = Get-Process -Id $it.pid -ErrorAction SilentlyContinue
    if (-not $p) { [void]$results.Add([ordered]@{ pid = $it.pid; name = $it.name; outcome = 'already-gone' }); continue }

    $outcome = ''
    if (-not $Force) {
        try { [void]$p.CloseMainWindow() } catch { }
        $deadline = (Get-Date).AddSeconds($GraceSeconds)
        while ((Get-Date) -lt $deadline -and -not $p.HasExited) { Start-Sleep -Milliseconds 500; try { $p.Refresh() } catch { break } }
    }

    $alive = $null
    try { $alive = -not $p.HasExited } catch { $alive = $false }
    if ($alive) {
        try {
            Stop-Process -Id $it.pid -Force -ErrorAction Stop
            Start-Sleep -Milliseconds 800
            $still = Get-Process -Id $it.pid -ErrorAction SilentlyContinue
            $outcome = if ($still) { 'survived-after-kill' } else { 'force-killed' }
        } catch {
            $outcome = 'access-denied'
            $err = $_.Exception.Message
        }
    } else {
        $outcome = 'closed-gracefully'
    }
    [void]$results.Add([ordered]@{ pid = $it.pid; name = $it.name; elevated = $it.elevated; outcome = $outcome; error = if ($err) { $err } else { '' } })
    $err = $null
}

# ---------- 权限不足时自动改走提权按需任务（免 UAC） ----------
# 由计划任务/提权上下文启动的游戏与 BetterGI，普通权限 Stop-Process 必报 Access is denied。
# 本机「BetterGI 按需执行」任务（RunLevel=Highest）支持 {mode:"stop"}，由任务计划服务提权，
# 没有 UAC 弹窗 —— 无人值守时这一步必须能自己走通，不然关不掉就没法改分辨率/重跑。
$taskStop = $null
if (@($results | Where-Object { $_.outcome -eq 'access-denied' }).Count -gt 0) {
    $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    $isElev = $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
    $taskName = 'BetterGI 按需执行'
    $task = $null
    try { $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
    if ($isElev) {
        $taskStop = [ordered]@{ attempted = $false; note = '当前已提权却仍 Access is denied（反作弊保护），按需任务也未必能关' }
    } elseif ($null -eq $task) {
        $taskStop = [ordered]@{ attempted = $false; note = "计划任务「$taskName」不存在，无法免 UAC 关闭" }
    } else {
        $rootBgi = 'D:\software\BetterGI'
        $reqPath = Join-Path $rootBgi '_run_request.json'
        $resPath = Join-Path $rootBgi '_run_request.result.json'
        $stopName = switch ($Target) { 'game' { 'game' } 'bettergi' { 'bettergi' } default { 'both' } }
        $taskStop = [ordered]@{ attempted = $true; ok = $false; stopped = @(); failed = @(); note = '' }
        try {
            (@{ mode = 'stop'; name = $stopName; requestedAt = (Get-Date).ToString('o'); source = 'bgi-close.ps1' } | ConvertTo-Json -Compress) |
                Set-Content -LiteralPath $reqPath -Encoding UTF8
            Remove-Item -LiteralPath $resPath -Force -ErrorAction SilentlyContinue
            Start-ScheduledTask -TaskName $taskName
            $deadline2 = (Get-Date).AddSeconds(60)
            while ((Get-Date) -lt $deadline2 -and -not (Test-Path -LiteralPath $resPath)) { Start-Sleep -Milliseconds 1000 }
            $r = $null
            if (Test-Path -LiteralPath $resPath) {
                try { $r = Get-Content -LiteralPath $resPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
            }
            if ($null -ne $r) {
                $taskStop.ok = [bool]$r.ok
                $taskStop.stopped = @($r.stopped)
                $taskStop.failed = @($r.failed)
                $taskStop.note = "按需任务已执行（免 UAC）：ok=$($r.ok)"
            } else {
                $taskStop.note = '按需任务已触发，但 60 秒内没等到结果文件'
            }
        } catch {
            $taskStop.note = "按需任务触发失败：$($_.Exception.Message)"
        }
    }
}

$survivors = @($plan | Where-Object { Get-Process -Id $_.pid -ErrorAction SilentlyContinue })

if ($Json) {
    ([ordered]@{ target = $Target; dryRun = $false; planned = @($plan); results = @($results); viaTask = $taskStop; survivors = $survivors.Count }) | ConvertTo-Json -Depth 6
} else {
    "=== 关闭结果（target=$Target）==="
    foreach ($r in $results) {
        $txt = switch ($r.outcome) {
            'closed-gracefully'  { '✓ 已优雅关闭' }
            'force-killed'       { '✓ 已强制结束' }
            'already-gone'       { '· 已经不在' }
            'survived-after-kill'{ '✗ 强制结束仍未退出' }
            'access-denied'      { '✗ 权限不足，无法结束' }
            default              { $r.outcome }
        }
        "  PID $($r.pid) $($r.name) → $txt"
        if ($r.error) { "      错误：$($r.error)" }
    }
    if ($null -ne $taskStop) {
        ""
        if ($taskStop.attempted -and $taskStop.ok) {
            "  ✓ 普通权限关不掉 → 已自动走提权按需任务关闭（无 UAC）：已停止=[$($taskStop.stopped -join ',')]"
        } elseif ($taskStop.attempted) {
            "  ⚠ 已尝试按需任务关闭：$($taskStop.note)；失败=[$($taskStop.failed -join '; ')]"
        } else {
            "  ℹ $($taskStop.note)"
        }
    }
    if ($survivors.Count -gt 0) {
        ""
        "怎么处理权限不足："
        "  · BetterGI：桌面「日常一条龙」快捷方式（或右键 → 以管理员身份运行）；或在其托盘图标上右键退出。"
        "    本机计划任务/包装器 _daily_runner.ps1 以最高权限运行，会在启动前自动清理残留实例。"
        "  · 原神：一般不需要管理员权限；若提示权限不足，请在任务管理器里结束它。"
    }
}

if ($survivors.Count -gt 0) { exit 1 }
exit 0
