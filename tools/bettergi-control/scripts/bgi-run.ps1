<#
.SYNOPSIS
    触发 BetterGI：start / oneDragon / groups / progress（会启动进程，有副作用）。
.DESCRIPTION
    前置校验 → 启动 BetterGI.exe 并带对应参数 → 默认立即返回；-Wait 会等到日志出现截图器就绪证据。
    关键约束（源码/实测）：
      · 对**已运行实例**发命令无效（不会真正执行）→ 本脚本检测到实例在跑时直接拒绝（退出码 2）。
      · BetterGI 会自我提权（runas），会弹 UAC；原进程退出码 553 = 已提权重启，不算失败。
      · 命令行只有 5 个动作：无参 / start / startOneDragon / --startGroups / --TaskProgress。
.PARAMETER Mode
    start（只启动截图器+联动游戏）| oneDragon（跑一条龙）| groups（跑配置组）| progress（续跑进度）
.PARAMETER Name
    Mode=oneDragon 时是一条龙配置名（如 日常）；Mode=groups 时是配置组名（可逗号分隔多个）；Mode=progress 时是进度名或 latest
.PARAMETER Wait
    等到日志出现「遮罩窗口已启动」或超时（默认 120 秒）
.PARAMETER DryRun
    只打印将执行的命令 + 已有实例状态，不启动任何进程
.EXAMPLE
    pwsh -File bgi-run.ps1 -Mode oneDragon -Name 日常 -Wait
    pwsh -File bgi-run.ps1 -Mode groups -Name '采集-星螺'
    pwsh -File bgi-run.ps1 -Mode oneDragon -Name 日常 -DryRun
.NOTES
    退出码：0=已发起；1=启动失败/等待超时；2=前置条件不满足。UTF-8 带 BOM（PS 5.1）。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('start', 'oneDragon', 'groups', 'progress')]
    [string]$Mode,
    [string]$Name = '',
    [switch]$Wait,
    [switch]$DryRun,
    [int]$WaitSeconds = 120,
    [string]$Root = 'D:\software\BetterGI'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $Root)) { "✗ 安装根不存在: $Root"; exit 2 }
$exe = Join-Path $Root 'BetterGI.exe'
if (-not (Test-Path -LiteralPath $exe)) { "✗ 找不到 $exe"; exit 2 }

# ---------- 组装参数 ----------
$argList = @()
switch ($Mode) {
    'start' { $argList = @('start') }
    'oneDragon' {
        if ([string]::IsNullOrWhiteSpace($Name)) { "✗ -Mode oneDragon 需要 -Name <一条龙配置名>"; exit 2 }
        $argList = @('startOneDragon', $Name)
    }
    'groups' {
        if ([string]::IsNullOrWhiteSpace($Name)) { "✗ -Mode groups 需要 -Name <配置组名>（多个用逗号分隔）"; exit 2 }
        $argList = @('--startGroups')
        $argList += @($Name.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    }
    'progress' {
        $prog = if ([string]::IsNullOrWhiteSpace($Name)) { 'latest' } else { $Name }
        $argList = @('--TaskProgress', $prog)
    }
}

# 组的合法性预检（组名 = 文件名；status 必须 Enabled）
if ($Mode -eq 'groups') {
    $sgDir = Join-Path $Root 'User\ScriptGroup'
    foreach ($n in ($Name.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })) {
        $f = Join-Path $sgDir "$n.json"
        if (-not (Test-Path -LiteralPath $f)) {
            "⚠ 找不到配置组文件: $f（命令行会打印『传入的配置组名称不存在』并跳过）"
        } else {
            try {
                $g = Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json
                $bad = @($g.projects | Where-Object { $_.status -ne 'Enabled' })
                if ($bad.Count -gt 0) { "⚠ 组 '$n' 里有 $($bad.Count) 个项目 status 不是 Enabled → 会被静默跳过" }
            } catch { "⚠ 组 '$n' 解析失败: $($_.Exception.Message)" }
        }
    }
}

$cmdLine = "$exe $($argList -join ' ')"
$running = @(Get-Process -Name 'BetterGI' -ErrorAction SilentlyContinue)

# ---------- 提权判定与"免 UAC"路径 ----------
# BetterGI 启动时无条件自我提权（App.xaml.cs:64 → RuntimeHelper.EnsureElevated → Verb=runas），
# 所以从非提权上下文直接启动**必弹 UAC**；若装了最高权限的按需任务，就改走它（无提示）。
$taskName = 'BetterGI 按需执行'
$taskPresent = $false
try { $taskPresent = $null -ne (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) } catch { }
$me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
$isElevated = $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

if ($DryRun) {
    "Would run: $cmdLine"
    if ($taskPresent) {
        "路径: 走按需计划任务「$taskName」（RunLevel=Highest，**不会弹 UAC**）"
    } else {
        "路径: 直接启动 BetterGI$(if ($isElevated) { '（当前已提权，不会弹 UAC）' } else { '（当前未提权 → **会弹一次 UAC，需要有人点“是”**；装一次按需任务可免提示）' })"
    }
    if ($running.Count -gt 0) { "⚠ 当前已有实例在运行（PID $($running.Id -join ',')）——真正触发时本脚本会拒绝（退出码 2）。" }
    "（-DryRun：未启动任何进程）"
    exit 0
}

if ($running.Count -gt 0) {
    "✗ 已有 BetterGI 实例在运行（PID $($running.Id -join ',')）——对已运行实例发命令不会真正执行。"
    "  请先让用户从托盘退出 BetterGI，或改用界面操作。"
    exit 2
}

if ($taskPresent) {
    # 走提权任务：写请求文件 → Start-ScheduledTask → 等结果文件
    $reqPath = Join-Path $Root '_run_request.json'
    $resPath = Join-Path $Root '_run_request.result.json'
    $req = [ordered]@{ mode = $Mode; name = $Name; requestedAt = (Get-Date).ToString('o'); source = 'bgi-run.ps1' }
    try {
        ($req | ConvertTo-Json -Compress) | Set-Content -LiteralPath $reqPath -Encoding UTF8
        Remove-Item -LiteralPath $resPath -Force -ErrorAction SilentlyContinue
        Start-ScheduledTask -TaskName $taskName
        "→ 已通过按需任务「$taskName」触发（无 UAC）：$cmdLine"
    } catch {
        "✗ 通过按需任务触发失败：$($_.Exception.Message)"
        "  回退：直接启动（可能弹 UAC）。"
    }
    if (Test-Path -LiteralPath $reqPath) {
        # 如果请求文件还在（没被消费），说明任务没跑起来 → 回退直启
    } else {
        $deadline = (Get-Date).AddSeconds(25)
        while ((Get-Date) -lt $deadline) {
            if (Test-Path -LiteralPath $resPath) { break }
            Start-Sleep -Seconds 1
        }
        if (Test-Path -LiteralPath $resPath) {
            "结果文件：$resPath"
            Get-Content -LiteralPath $resPath -Raw -Encoding UTF8
            exit 0
        }
        "⚠ 25 秒内没等到结果文件（任务可能没被触发）；可用 Get-ScheduledTaskInfo -TaskName '$taskName' 查看。"
        exit 1
    }
}

# ---------- 启动 ----------
$logDir = Join-Path $Root 'log'
$before = Get-ChildItem -LiteralPath $logDir -Filter 'better-genshin-impact*.log' -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
$beforeSize = if ($before) { $before.Length } else { 0 }
$beforeWrite = if ($before) { $before.LastWriteTime } else { [datetime]::MinValue }

"→ 启动: $cmdLine"
"  （BetterGI 会自动提权，可能弹 UAC；原进程退出码 553 = 已提权重启，不是失败）"
$p = Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $Root -PassThru
if (-not $p) { "✗ Start-Process 返回空"; exit 1 }
Start-Sleep -Seconds 3

# ---------- -Wait：等截图器就绪证据 ----------
if ($Wait) {
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $found = $false
    while ((Get-Date) -lt $deadline) {
        $log = Get-ChildItem -LiteralPath $logDir -Filter 'better-genshin-impact*.log' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($log) {
            $text = ''
            try {
                $fs = [System.IO.File]::Open($log.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
                $text = $sr.ReadToEnd(); $sr.Dispose(); $fs.Dispose()
            } catch { $text = '' }
            $tail = @($text -split "`r?`n" | Select-Object -Last 60)
            $hit = $tail | Where-Object { $_ -match '遮罩窗口已启动' } | Select-Object -Last 1
            if ($hit) { "✓ 截图器就绪：$($hit.Trim())"; $found = $true; break }
            $err = $tail | Where-Object { $_ -match '模拟键鼠消息发送失败|未找到原神窗口|游戏窗口不能最小化' } | Select-Object -Last 1
            if ($err) { "✗ 启动受阻：$($err.Trim())"; exit 1 }
        }
        Start-Sleep -Seconds 2
    }
    if (-not $found) {
        "✗ 等待超时（$WaitSeconds 秒）未看到『遮罩窗口已启动』——可能是 UAC 未确认、游戏没起来或截图方式不兼容。"
        "  请跑 bgi-status.ps1 看进程与日志尾部。"
        exit 1
    }
}

exit 0
