<#
.SYNOPSIS
    在 BetterGI 日志里做定向检索（"今天为什么失败"这类问题的取证工具）。
.DESCRIPTION
    比 bgi-status.ps1 的"日志尾部 20 行"强得多：可按时间窗、级别、正则、任务关键字过滤，
    默认按时间正序返回命中行（带行号与时间戳），并给出「本次运行」的边界提示。
    典型用法：
      bgi-log.ps1 -Level ERR                     # 今天所有 ERR
      bgi-log.ps1 -Pattern '未匹配到任何战斗脚本|切换队伍失败'
      bgi-log.ps1 -SinceMinutes 30 -Tail 80      # 最近半小时的最后 80 行
      bgi-log.ps1 -Task 自动秘境                  # 只看某个任务的段落
.PARAMETER Pattern
    正则（匹配消息行或日志头行）。
.PARAMETER Level
    ERR / WRN / INF（可多选，逗号分隔）。
.PARAMETER SinceMinutes
    只保留最近 N 分钟内的时间戳行（默认全天）。
.PARAMETER Tail
    最多返回多少行（默认 60）。
.PARAMETER Task
    只看包含该关键字（如"自动秘境"）的段落及其后 6 行。
.PARAMETER LogPath
    指定日志文件；默认取当日最新。
.PARAMETER Json
    输出机器可读 JSON（含 hits 数组与统计）。
.EXAMPLE
    pwsh -File bgi-log.ps1 -Level ERR -SinceMinutes 240
.NOTES
    退出码：0=有命中；1=无命中；2=前置不满足（日志不存在）。UTF-8 带 BOM（PS 5.1）。
#>
[CmdletBinding()]
param(
    [string]$Pattern = '',
    [string[]]$Level = @(),
    [int]$SinceMinutes = 0,
    [int]$Tail = 60,
    [string]$Task = '',
    [string]$LogPath = '',
    [string]$Root = 'D:\software\BetterGI',
    [switch]$Json
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

if (-not $LogPath) {
    $logDir = Join-Path $Root 'log'
    if (-not (Test-Path -LiteralPath $logDir)) { "✗ 日志目录不存在：$logDir"; exit 2 }
    $today = Join-Path $logDir ("better-genshin-impact{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
    if (Test-Path -LiteralPath $today) { $LogPath = $today }
    else {
        $latest = Get-ChildItem -LiteralPath $logDir -Filter 'better-genshin-impact*.log' -File -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $latest) { "✗ 找不到任何日志文件（$logDir）"; exit 2 }
        $LogPath = $latest.FullName
    }
}
if (-not (Test-Path -LiteralPath $LogPath)) { "✗ 日志不存在：$LogPath"; exit 2 }

# 共享读（日志可能正在被写入）
$text = ''
try {
    $fs = [System.IO.File]::Open($LogPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
    $text = $sr.ReadToEnd(); $sr.Dispose(); $fs.Dispose()
} catch { "✗ 读取失败：$($_.Exception.Message)"; exit 2 }
$lines = @($text -split "`r?`n")

$cut = if ($SinceMinutes -gt 0) { (Get-Date).AddMinutes(-$SinceMinutes) } else { $null }
$levelSet = @($Level | ForEach-Object { $_.ToUpper() } | Where-Object { $_ })
$hits = New-Object System.Collections.ArrayList
$runStarts = New-Object System.Collections.ArrayList
$runEnds = New-Object System.Collections.ArrayList

for ($i = 0; $i -lt $lines.Count; $i++) {
    $l = $lines[$i]
    if (-not $l) { continue }

    # 运行边界（无论是否命中都要统计）
    if ($l -match '一条龙和配置组任务结束') { [void]$runEnds.Add($l.Substring(0, [Math]::Min(20, $l.Length))) }

    if ($l -match '^\[(\d{2}):(\d{2}):(\d{2})') {
        $ts = [datetime]::ParseExact($Matches[1] + ':' + $Matches[2] + ':' + $Matches[3], 'HH:mm:ss', $null)
        $stamp = (Get-Date).Date.Add($ts.TimeOfDay)
        if ($cut -and $stamp -lt $cut) { continue }
    } else {
        # 消息行（Serilog 把正文放在下一行）：时间窗按上一行时间戳近似，无法判断时保留
        if ($cut) {
            $prev = $lines[$i - 1]
            if ($prev -match '^\[(\d{2}):(\d{2}):(\d{2})') {
                $ts2 = [datetime]::ParseExact($Matches[1] + ':' + $Matches[2] + ':' + $Matches[3], 'HH:mm:ss', $null)
                if ((Get-Date).Date.Add($ts2.TimeOfDay) -lt $cut) { continue }
            }
        }
    }

    $isHeader = ($l -match '^\[\d{2}:\d{2}:\d{2}\.\d+\]')
    $msg = ''
    $consumedNext = $false
    # 正文行 = 下一行不是新的日志头。注意别用「全可选分组」的正则判断——那种写法永远匹配（踩过）
    if ($isHeader -and $i + 1 -lt $lines.Count -and $lines[$i + 1] -and
        $lines[$i + 1] -notmatch '^\[\d{2}:\d{2}:\d{2}\.\d+\]') {
        $msg = $lines[$i + 1]
        $consumedNext = $true
    }
    $combined = "$l`n$msg"

    if ($levelSet.Count -gt 0) {
        $ok = $false
        foreach ($lv in $levelSet) { if ($combined -match "\[$lv\]") { $ok = $true; break } }
        if (-not $ok) { continue }
    }
    if ($Pattern -and $combined -notmatch $Pattern) { continue }
    if ($Task -and $combined -notmatch [regex]::Escape($Task)) { continue }

    # 头行格式： [时间] [级别] [Primary:S1:P…:T…] 类名 —— 取类名，避免把噪声塞进输出
    $cls = ''
    if ($isHeader -and $l -match '\]\s+(\S+)\s*$') { $cls = $Matches[1] }
    [void]$hits.Add([ordered]@{
        line    = $i + 1
        time    = if ($l -match '^\[(\d{2}:\d{2}:\d{2})') { $Matches[1] } else { '' }
        level   = if ($l -match '\[(ERR|WRN|INF|DBG)\]') { $Matches[1] } else { '' }
        text    = $cls
        message = $msg.Trim()
    })
    # 正文行已被合并成一条，跳过它，避免同一事件命中两次
    if ($consumedNext) { $i++ }
}

$perLevel = @{}
foreach ($h in $hits) { $k = if ($h.level) { $h.level } else { 'MSG' }; $perLevel[$k] = 1 + [int]$perLevel[$k] }

$shown = @($hits | Select-Object -Last $Tail)
$result = [ordered]@{
    logFile   = $LogPath
    sizeKB    = [math]::Round((Get-Item -LiteralPath $LogPath).Length / 1KB, 1)
    totalHits = $hits.Count
    shown     = $shown.Count
    perLevel  = $perLevel
    lastEnd   = if ($runEnds.Count -gt 0) { $runEnds[-1] } else { '' }
    filters   = [ordered]@{ pattern = $Pattern; levels = $levelSet; sinceMinutes = $SinceMinutes; task = $Task }
    hits      = $shown
}

if ($Json) {
    $result | ConvertTo-Json -Depth 6 -Compress
} else {
    "=== 日志检索 ==="
    "文件    : $LogPath（$($result.sizeKB) KB）"
    $f = @()
    if ($Pattern) { $f += "正则=$Pattern" }
    if ($levelSet.Count) { $f += "级别=$($levelSet -join '/')" }
    if ($SinceMinutes -gt 0) { $f += "最近 $SinceMinutes 分钟" }
    if ($Task) { $f += "任务含「$Task」" }
    if ($f.Count) { "过滤    : $($f -join '  ')" }
    "命中    : $($hits.Count) 条$(if ($runEnds.Count) { "（日志里最后一次一条龙收尾：$($runEnds[-1])）" })  按级别：" + (($perLevel.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', ')
    ""
    if ($shown.Count -eq 0) { "（无命中）" }
    else {
        "--- 最后 $($shown.Count) 条命中 ---"
        $shown | ForEach-Object {
            $m = if ($_.message) { ' → ' + $_.message } else { '' }
            "  L{0,-6} [{1}] {2}{3}" -f $_.line, $_.level, $_.text, $m
        }
    }
}

if ($hits.Count -gt 0) { exit 0 } else { exit 1 }
