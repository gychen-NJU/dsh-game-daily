<#
.SYNOPSIS
    观测 BetterGI 任务并判定成败（只读；-DryRun 立刻出结论）。
.DESCRIPTION
    数据源：
      · Mode=oneDragon → 只认日志（一条龙**不写** task_progress）+ 通知（如已配）
      · Mode=groups    → 日志 + log\task_progress\*.json（endTime / history[].status）
    终态标记：日志出现 `一条龙和配置组任务结束` 视为收尾；`[ERR]` 视为失败证据。
.PARAMETER Mode
    oneDragon | groups
.PARAMETER TimeoutMinutes
    最长等待分钟数（默认 60）；到点仍未收尾 → 退出码 2
.PARAMETER DryRun
    不等待，只对**当前**日志做一次判定（用于"今天跑成没"）
.PARAMETER SinceMinutes
    DryRun 时只看最近 N 分钟的日志（默认 180）
.EXAMPLE
    pwsh -File bgi-watch.ps1 -Mode oneDragon -TimeoutMinutes 60
    pwsh -File bgi-watch.ps1 -Mode oneDragon -DryRun
.NOTES
    退出码：0=成功；1=发现失败证据；2=超时/未完成。UTF-8 带 BOM（PS 5.1）。
#>
[CmdletBinding()]
param(
    [ValidateSet('oneDragon', 'groups')]
    [string]$Mode = 'oneDragon',
    [int]$TimeoutMinutes = 60,
    [switch]$DryRun,
    [int]$SinceMinutes = 180,
    [string]$Root = 'D:\software\BetterGI',
    [string]$Name = '',            # 配置组名：用于过滤 ExecutionRecords（-Mode groups 时更准）
    [switch]$Json
)

$ErrorActionPreference = 'Continue'
$logDir = Join-Path $Root 'log'
if (-not (Test-Path -LiteralPath $logDir)) { "✗ 找不到日志目录: $logDir"; exit 2 }

# 配置组运行的**硬证据**：log\ExecutionRecords\<yyyyMMdd>.json 里每个项目结束时才写 end_time
# （记录在项目开始时就落盘，end_time 是默认值 0001-01-01 → 可据此判断"还在跑"）
function Get-ExecutionRecordSummary {
    try {
        $dir = Join-Path $Root 'log\ExecutionRecords'
        if (-not (Test-Path -LiteralPath $dir)) { return $null }
        $f = Get-ChildItem -LiteralPath $dir -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -Last 1
        if (-not $f) { return $null }
        $j = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
        $recs = @($j.execution_records)
        if ($Name) { $recs = @($recs | Where-Object { $_.group_name -eq $Name }) }
        $fin = @($recs | Where-Object { $_.end_time -and ([datetime]$_.end_time).Year -gt 2000 })
        return [pscustomobject]@{
            file     = $f.Name
            total    = $recs.Count
            finished = $fin.Count
            ok       = @($fin | Where-Object { $_.is_successful -eq $true }).Count
            records  = $fin
        }
    } catch { return $null }
}

$KEY = @(
    '一条龙和配置组任务结束', '执行结束', '任务启动！', '任务结束',
    '开始连续执行选中配置组', '遮罩窗口已启动',
    '匹配到战斗脚本', '未匹配到任何战斗脚本', '识别到的队伍角色',
    '切换队伍成功', '切换队伍失败', '合成"浓缩树脂"', '指定使用树脂',
    '用尽所有浓缩树脂和原粹树脂后结束', '刷取', '领取每日奖励', '检查每日奖励结果',
    '前往冒险家协会领取奖励', '前往合成台', '游戏已退出', '刷取次数过多',
    '未找到原神窗口', '模拟键鼠消息发送失败', '未能返回主界面', '不是原神，暂停'
)

function Get-LatestLog {
    Get-ChildItem -LiteralPath $logDir -Filter 'better-genshin-impact*.log' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

function Read-LogLines([string]$path) {
    # 共享读（日志正被 BetterGI 写入也能读），并自行分行，避免 Get-Content 附加元属性
    $text = ''
    try {
        $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        $text = $sr.ReadToEnd()
        $sr.Dispose(); $fs.Dispose()
    } catch { $text = '' }
    return @($text -split "`r?`n")
}

function Read-KeyEvents([int]$sinceMin) {
    $log = Get-LatestLog
    if (-not $log) { return @() }
    $cut = (Get-Date).AddMinutes(-$sinceMin)
    $lines = Read-LogLines $log.FullName
    $events = New-Object System.Collections.ArrayList
    for ($i = 0; $i -lt $lines.Count; $i++) {
        $l = $lines[$i]
        if ($l -notmatch '^\[(\d{2}):(\d{2}):(\d{2})') { continue }
        $ts = [datetime]::ParseExact($Matches[1] + ':' + $Matches[2] + ':' + $Matches[3], 'HH:mm:ss', $null)
        $today = (Get-Date).Date.Add($ts.TimeOfDay)
        if ($today -lt $cut) { continue }
        $msg = ($lines[($i + 1)..([Math]::Min($i + 2, $lines.Count - 1))] |
            Where-Object { $_ -and $_.Trim() -ne '' -and $_ -notmatch '^\s+at\s' -and $_ -notmatch '^\[' } |
            Select-Object -First 1)
        $combined = $l + ' ' + $msg
        foreach ($k in $KEY) {
            if ($combined -match [regex]::Escape($k)) { [void]$events.Add([ordered]@{ time = $l.Substring(1, 8); level = $(if ($l -match '\[ERR\]') { 'ERR' } elseif ($l -match '\[WRN\]') { 'WRN' } else { 'INF' }); key = $k; message = $msg }); break }
        }
    }
    return $events
}

function Get-ProgressSummary {
    $dir = Join-Path $logDir 'task_progress'
    if (-not (Test-Path -LiteralPath $dir)) { return @() }
    $out = @()
    foreach ($f in (Get-ChildItem -LiteralPath $dir -Filter '*.json' -File | Sort-Object LastWriteTime -Descending | Select-Object -First 3)) {
        try {
            $j = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            $fails = @($j.history | Where-Object { $_.status -eq 2 })
            $out += [ordered]@{ name = $f.Name; endTime = $j.endTime; loop = $j.loop; failedItems = $fails.Count }
        } catch { $out += [ordered]@{ name = $f.Name; error = $_.Exception.Message } }
    }
    return $out
}

function Evaluate($events) {
    $ends = @($events | Where-Object { $_.key -eq '一条龙和配置组任务结束' })
    $lastEnd = if ($ends.Count -gt 0) { $ends[-1] } else { $null }
    # 2026-10-17 修复假阳性：配置组运行时，日志里可能**还没有**本次的收尾标记，而上一条历史记录
    # （例如 01:41 的一条龙）留下的标记会被误当成"本次已收尾" → 明明刚开跑却报 ✓ 成功。
    # 正确做法：以**最近一次「开始连续执行选中配置组」**为锚点，收尾标记必须发生在它之后才算数。
    # 注意：这个锚点只适用于**配置组模式**——一条龙运行不写"开始连续执行"，若也套用会把正常
    # 收尾的一条龙误报成"未收尾"（我 2026-10-17 改完立刻踩到这个回归，故加 Mode 门控）。
    $starts = if ($Mode -eq 'groups') { @($events | Where-Object { $_.key -eq '开始连续执行选中配置组' }) } else { @() }
    $lastStart = if ($starts.Count -gt 0) { $starts[-1] } else { $null }
    # 配置组运行的**权威终点**：`配置组 \"<名>\" 执行结束`（2026-10-17 实测发现，比 ExecutionRecords 实时）
    $gEnds = @($events | Where-Object { $_.key -eq '执行结束' -and $_.message -match '配置组' })
    $lastGEnd = if ($gEnds.Count -gt 0) { $gEnds[-1] } else { $null }
    $ended = [bool]($lastEnd -and (-not $lastStart -or $lastEnd.time -gt $lastStart.time))
    # 配置组模式还有一条更硬的证据：ExecutionRecords，每个项目结束时才写 end_time
    if ($Mode -eq 'groups') {
        $rec = Get-ExecutionRecordSummary
        $script:RecSummary = $rec
        if ($rec -and $rec.finished -gt 0 -and ($rec.total -eq 0 -or $rec.finished -ge $rec.total)) { $ended = $true }
        if ($lastGEnd -and (-not $lastStart -or $lastGEnd.time -gt $lastStart.time)) { $ended = $true }
    }
    $errs = @($events | Where-Object { $_.level -eq 'ERR' })
    # 只把"本次开始/收尾之后"的 ERR 算作本次失败；更早的 ERR 属于上一轮运行
    $anchor = if ($lastStart -and $lastEnd) { if ($lastStart.time -gt $lastEnd.time) { $lastStart.time } else { $lastEnd.time } }
              elseif ($lastStart) { $lastStart.time } elseif ($lastEnd) { $lastEnd.time } else { $null }
    # 一条龙模式还要收住右边界：收尾之后若又跑了配置组，那段时间的 ERR 不属于这条龙
    # （否则"跑完日常→又去采集"会把采集的报错算到日常头上，2026-10-17 踩到）
    $windowEnd = $null
    if ($Mode -eq 'oneDragon' -and $lastEnd) {
        $gs = @($events | Where-Object { $_.key -eq '开始连续执行选中配置组' -and $_.time -gt $lastEnd.time })
        if ($gs.Count -gt 0) { $windowEnd = $gs[0].time }
    }
    $errsThisRun = if ($anchor) { @($errs | Where-Object { $_.time -gt $anchor -and (-not $windowEnd -or $_.time -lt $windowEnd) }) } else { $errs }
    $verdict = if ($errsThisRun.Count -gt 0) { 'failed' } elseif ($ended) { 'success' } elseif ($lastStart) { 'incomplete' } elseif ($lastEnd) { 'success' } else { 'incomplete' }
    return [pscustomobject]@{
        verdict      = $verdict
        errors       = $errsThisRun
        errorsBefore = @($errs | Where-Object { $anchor -and $_.time -le $anchor })
        ended        = $ended
        lastEndTime  = if ($lastEnd) { $lastEnd.time } else { $null }
        startedTime  = if ($lastStart) { $lastStart.time } else { $null }
        anchorTime   = $anchor
        windowEnd    = $windowEnd
        lastGroupEndTime = if ($lastGEnd) { $lastGEnd.time } else { $null }
    }
}

# ---------- DryRun：一次判定 ----------
if ($DryRun) {
    $events = Read-KeyEvents $SinceMinutes
    $ev = Evaluate $events
    $prog = Get-ProgressSummary
    if ($Json) {
        # 显式 @() 包裹：PS 5.1 里空 ArrayList 会被 ConvertTo-Json 序列化成 {} 而不是 []
        $payload = [ordered]@{
            mode       = $Mode
            verdict    = $ev.verdict
            ended      = $ev.ended
            lastEndTime = $ev.lastEndTime
            eventCount = @($events).Count
            events     = @($events)
            progress   = @($prog)
            errors     = @($ev.errors)
            errorsBefore = @($ev.errorsBefore)
        }
        $payload | ConvertTo-Json -Depth 6 -Compress
    } else {
        "=== $Mode 运行判定（仅看最近 $SinceMinutes 分钟）==="
        "结论      : $(switch ($ev.verdict) { 'success' { '✓ 成功（已收尾且无 ERR）' } 'failed' { '✗ 失败（有 ERR）' } default { '… 未收尾（可能还在跑，或根本没启动）' } })"
        "收尾标记  : $(if (-not $ev.ended) { '未出现' } elseif ($Mode -eq 'groups') { "已出现「配置组 … 执行结束」@ $($ev.lastGroupEndTime)" } else { "已出现「一条龙和配置组任务结束」@ $($ev.lastEndTime)" })"
        if ($events.Count -gt 0) {
            "--- 关键事件（最后 25 条）---"
            $events | Select-Object -Last 25 | ForEach-Object { "  [{0}] {1,-4} {2,-22} {3}" -f $_.time, $_.level, $_.key, $_.message }
        } else { "（最近 $SinceMinutes 分钟内没有关键事件——任务大概没启动）" }
        if ($ev.errors.Count -gt 0) {
            "--- 失败证据（本次运行内的 ERR）---"
            $ev.errors | ForEach-Object { "  [{0}] {1} → {2}" -f $_.time, $_.key, $_.message }
        }
        if ($ev.errorsBefore -and $ev.errorsBefore.Count -gt 0) {
            "--- 更早运行留下的 ERR（未计入本次判定）---"
            $ev.errorsBefore | ForEach-Object { "  [{0}] {1} → {2}" -f $_.time, $_.key, $_.message }
        }
        if ($prog.Count -gt 0 -and $Mode -eq 'groups') {
            "--- task_progress ---"
            $prog | ForEach-Object { "  $($_.name)  endTime=$($_.endTime)  失败项=$($_.failedItems)" }
        }
    }
    switch ($ev.verdict) { 'success' { exit 0 } 'failed' { exit 1 } default { exit 2 } }
}

# ---------- 等待模式 ----------
$deadline = (Get-Date).AddMinutes($TimeoutMinutes)
$baseline = Read-KeyEvents 1   # 起点近似：先取最近 1 分钟，避免把历史 ERR 算进来
"→ 开始观测（最多 $TimeoutMinutes 分钟）…"
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 15
    $events = Read-KeyEvents ($TimeoutMinutes + 5)
    $ev = Evaluate $events
    if ($ev.verdict -ne 'incomplete') { break }
}
$events = Read-KeyEvents ($TimeoutMinutes + 5)
$ev = Evaluate $events
$prog = Get-ProgressSummary
if ($Json) {
    [ordered]@{ mode = $Mode; verdict = $ev.verdict; ended = $ev.ended; events = $events; progress = $prog } | ConvertTo-Json -Depth 6
} else {
    $events | Select-Object -Last 30 | ForEach-Object { "  [{0}] {1,-4} {2,-22} {3}" -f $_.time, $_.level, $_.key, $_.message }
    "结论: $(switch ($ev.verdict) { 'success' { '✓ 成功收尾且无 ERR' } 'failed' { '✗ 有 ERR，见上' } default { '… 超时未收尾' } })"
}
switch ($ev.verdict) { 'success' { exit 0 } 'failed' { exit 1 } default { exit 2 } }
