<#
.SYNOPSIS
    等待日志出现某个"里程碑"标志（确认任务真的跑起来了，而不是只看"已发起"）。
.DESCRIPTION
    为什么需要它：`bgi-run.ps1` 说"已发起"只代表进程起来了，真正跑没跑要等日志出现标志。
    本脚本在限定时间内轮询当天日志，命中即返回；适合"发起 → 确认已开始 → 再慢慢等收尾"的节奏。

    内置里程碑（字符串取自源码/实机日志，2026-10-16 核对）：
      capturer_ready   遮罩窗口已启动                    —— 截图器就绪（能截图了）
      dragon_started   一条龙任务执行: / 配置组任务执行:   —— 一条龙/配置组开始推进
      group_started    个脚本，开始执行                   —— 配置组加载完成、开始跑脚本
      task_started     任务启动！                        —— 某个任务开始
      domain_entered   自动秘境：进入 / 开始挑战          —— 真进秘境了
      combat_matched   匹配到战斗脚本                     —— 战斗策略选中
      script_finished  脚本执行结束                       —— 配置组里某个脚本跑完
      finished         一条龙和配置组任务结束             —— 整体收尾
      any_error        [ERR]                             —— 出现错误
.PARAMETER Milestone
    上面列出的里程碑名（默认 finished）。
.PARAMETER Pattern
    自定义正则（给了就忽略 Milestone）。
.PARAMETER TimeoutSeconds
    最多等多少秒（默认 45，上限 50——本机 MCP 单次调用约 60 秒上限）。
.PARAMETER SinceMinutes
    只看最近 N 分钟的日志行（默认不限，避免拿到昨天的）。
.PARAMETER Json
    机器可读 JSON。
.EXAMPLE
    pwsh -File bgi-wait.ps1 -Milestone capturer_ready -TimeoutSeconds 45
.NOTES
    退出码：0=等到；1=超时未出现；2=前置不满足（日志不存在）。UTF-8 带 BOM（PS 5.1）。
#>
[CmdletBinding()]
param(
    [ValidateSet('capturer_ready', 'dragon_started', 'group_started', 'task_started', 'domain_entered', 'combat_matched', 'script_finished', 'finished', 'any_error')]
    [string]$Milestone = 'finished',
    [string]$Pattern = '',
    [int]$TimeoutSeconds = 45,
    [int]$SinceMinutes = 0,
    [string]$Root = 'D:\software\BetterGI',
    [switch]$Json
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$MAP = @{
    capturer_ready  = '遮罩窗口已启动'
    dragon_started  = '一条龙任务执行:|配置组任务执行:'
    group_started   = '个脚本，开始执行'
    task_started    = '任务启动！'
    domain_entered  = '自动秘境：进入|开始挑战'
    combat_matched  = '匹配到战斗脚本'
    script_finished = '脚本执行结束'
    finished        = '一条龙和配置组任务结束'
    any_error       = '\[ERR\]'
}
$regex = if ($Pattern) { $Pattern } else { $MAP[$Milestone] }
$budget = [Math]::Min([Math]::Max($TimeoutSeconds, 1), 50)

$logDir = Join-Path $Root 'log'
if (-not (Test-Path -LiteralPath $logDir)) { "✗ 日志目录不存在：$logDir"; exit 2 }
$log = Join-Path $logDir ("better-genshin-impact{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
if (-not (Test-Path -LiteralPath $log)) {
    $latest = Get-ChildItem -LiteralPath $logDir -Filter 'better-genshin-impact*.log' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $latest) { "✗ 找不到日志文件"; exit 2 }
    $log = $latest.FullName
}

function Read-Text([string]$path) {
    # 共享读：日志可能正被写入
    try {
        $fs = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
        $t = $sr.ReadToEnd(); $sr.Dispose(); $fs.Dispose()
        return $t
    } catch { return '' }
}

$sw = [Diagnostics.Stopwatch]::StartNew()
$hit = $null
while ($sw.Elapsed.TotalSeconds -lt $budget) {
    $text = Read-Text $log
    $lines = @($text -split "`r?`n")
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        $l = $lines[$i]
        if (-not $l) { continue }
        if ($l -notmatch $regex) { continue }
        # 时间窗过滤：取本行或上一行的时间戳
        if ($SinceMinutes -gt 0) {
            $stampTxt = if ($l -match '^\[(\d{2}:\d{2}:\d{2})') { $Matches[1] } elseif ($i -gt 0 -and $lines[$i - 1] -match '^\[(\d{2}:\d{2}:\d{2})') { $Matches[1] } else { '' }
            if ($stampTxt) {
                $ts = [datetime]::ParseExact($stampTxt, 'HH:mm:ss', $null)
                if ((Get-Date).Date.Add($ts.TimeOfDay) -lt (Get-Date).AddMinutes(-$SinceMinutes)) { continue }
            }
        }
        # 组装人读文本。BetterGI 的日志是「头行(时间/级别/类名) + 下一行正文」，
        # 而里程碑字符串通常落在**正文行**上——此时要向前找最近的日志头补齐元信息。
        $isHeader = ($l -match '^\[\d{2}:\d{2}:\d{2}\.\d+\]')
        $msg = ''
        $cls = ''
        $time = ''
        $level = ''
        if ($isHeader) {
            if ($i + 1 -lt $lines.Count -and $lines[$i + 1] -and $lines[$i + 1] -notmatch '^\[\d{2}:\d{2}:\d{2}\.\d+\]') { $msg = $lines[$i + 1].Trim() }
            if ($l -match '^\[(\d{2}:\d{2}:\d{2})') { $time = $Matches[1] }
            if ($l -match '\[(ERR|WRN|INF|DBG)\]') { $level = $Matches[1] }
            if ($l -match '\]\s+(\S+)\s*$') { $cls = $Matches[1] }
            if (-not $msg) { $msg = ($l -replace '^\[\d{2}:\d{2}:\d{2}\.\d+\]\s*', '').Trim() }
        } else {
            $msg = $l.Trim()
            for ($j = $i - 1; $j -ge [Math]::Max(0, $i - 4); $j--) {
                if ($lines[$j] -match '^\[\d{2}:\d{2}:\d{2}\.\d+\]') {
                    if ($lines[$j] -match '^\[(\d{2}:\d{2}:\d{2})') { $time = $Matches[1] }
                    if ($lines[$j] -match '\[(ERR|WRN|INF|DBG)\]') { $level = $Matches[1] }
                    if ($lines[$j] -match '\]\s+(\S+)\s*$') { $cls = $Matches[1] }
                    break
                }
            }
        }
        $hit = [ordered]@{
            milestone = if ($Pattern) { '(custom)' } else { $Milestone }
            line      = $i + 1
            time      = $time
            level     = $level
            class     = $cls
            message   = $msg
        }
        break
    }
    if ($hit) { break }
    Start-Sleep -Milliseconds 1500
}
$sw.Stop()

$result = [ordered]@{
    milestone = if ($Pattern) { '(custom)' } else { $Milestone }
    regex     = $regex
    logFile   = $log
    found     = [bool]$hit
    waitedSec = [math]::Round($sw.Elapsed.TotalSeconds, 1)
    hit       = $hit
}

if ($Json) {
    $result | ConvertTo-Json -Depth 6 -Compress
} else {
    if ($hit) {
        "✓ 等到里程碑「$($result.milestone)」（等了 $($result.waitedSec) 秒）"
        "  [$($hit.time)] $($hit.level) $($hit.class)"
        "  $($hit.message)"
    } else {
        "✗ 等待 $($result.waitedSec) 秒仍未看到里程碑「$($result.milestone)」（正则：$regex）"
        "  日志：$log"
        "  排查：bgi-log.ps1 -Level ERR；或确认任务是否真的发起了（bgi_status.ps1）"
    }
}

if ($hit) { exit 0 } else { exit 1 }
