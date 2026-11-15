<#
.SYNOPSIS
    战果统计：某天/最近几天配置组里每条路线跑成没、花了多久、顺手统计了多少怪。
.DESCRIPTION
    数据源（都是 BetterGI 自己写的，本脚本只读）：
      · log\ExecutionRecords\<yyyyMMdd>.json —— 每条执行记录：group_name / project_name / folder_name /
        type / start_time / end_time / is_successful（**只有 Pathing 类型的 is_successful 有真实含义**，
        KeyMouse 那条恒为 true，见 ScriptGroupProject.cs:248 / :317）
      · log\FarmingPlan\<yyyyMMdd>.json   —— 刷取计划统计：totalNormalMobCount / totalEliteMobCount / records
      · log\task_progress\*.json          —— 配置组的断点续跑进度（跑过配置组才会有）
    注意：**一条龙（startOneDragon）不写 ExecutionRecords**，只有配置组任务 / --startGroups / --TaskProgress 会写。
.PARAMETER Date
    日期：today（默认）/ yesterday / yyyyMMdd / yyyy-MM-dd
.PARAMETER Days
    汇总最近 N 天（默认 1，即只看 Date 那天；设 >1 时从 Date 往前数）
.PARAMETER Group
    只看某个配置组（模糊匹配 group_name）
.PARAMETER Material
    只看项目名/文件夹名含该关键字的记录（例：星螺）
.PARAMETER Json
    机器可读 JSON
.EXAMPLE
    pwsh -File bgi-results.ps1                      # 今天
    pwsh -File bgi-results.ps1 -Date yesterday -Material 星螺
    pwsh -File bgi-results.ps1 -Days 7 -Json
.NOTES
    退出码：0=有记录；1=没有任何记录；2=前置不满足。UTF-8 带 BOM（PS 5.1）。
#>
[CmdletBinding()]
param(
    [string]$Date = 'today',
    [int]$Days = 1,
    [string]$Group = '',
    [string]$Material = '',
    [string]$Root = 'D:\software\BetterGI',
    [switch]$Json
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

function Resolve-Date([string]$spec) {
    $s = $spec.Trim()
    if ($s -eq '' -or $s -eq 'today') { return (Get-Date).Date }
    if ($s -eq 'yesterday') { return (Get-Date).Date.AddDays(-1) }
    $d = [datetime]::MinValue
    foreach ($fmt in 'yyyyMMdd', 'yyyy-MM-dd') {
        if ([datetime]::TryParseExact($s, $fmt, $null, [System.Globalization.DateTimeStyles]::None, [ref]$d)) { return $d.Date }
    }
    throw "无法识别的日期：$spec（用 today / yesterday / yyyyMMdd / yyyy-MM-dd）"
}
try { $anchor = Resolve-Date $Date } catch { "✗ $($_.Exception.Message)"; exit 2 }

$logDir = Join-Path $Root 'log'
$erDir = Join-Path $logDir 'ExecutionRecords'
$fpDir = Join-Path $logDir 'FarmingPlan'
$tpDir = Join-Path $logDir 'task_progress'

$days = [Math]::Max(1, $Days)
$records = New-Object System.Collections.ArrayList
$daySummaries = New-Object System.Collections.ArrayList
$farmDays = New-Object System.Collections.ArrayList
$daysWithNoFile = New-Object System.Collections.ArrayList

for ($i = 0; $i -lt $days; $i++) {
    $d = $anchor.AddDays(-$i)
    $key = $d.ToString('yyyyMMdd')
    $erFile = Join-Path $erDir "$key.json"
    $dayCount = 0
    if (Test-Path -LiteralPath $erFile) {
        try {
            $j = Get-Content -LiteralPath $erFile -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($r in @($j.execution_records)) {
                if ($Group -and $r.group_name -notlike "*$Group*") { continue }
                if ($Material -and ($r.project_name -notlike "*$Material*") -and ($r.folder_name -notlike "*$Material*")) { continue }
                $dur = $null
                try {
                    if ($r.start_time -and $r.end_time) {
                        $st = [datetime]$r.start_time; $en = [datetime]$r.end_time
                        $dur = [math]::Round(($en - $st).TotalMinutes, 2)
                    }
                } catch { }
                [void]$records.Add([ordered]@{
                    date       = $key
                    time       = if ($r.start_time) { ([datetime]$r.start_time).ToString('HH:mm:ss') } else { '' }
                    group      = [string]$r.group_name
                    project    = [string]$r.project_name
                    folder     = [string]$r.folder_name
                    type       = [string]$r.type
                    successful = [bool]$r.is_successful
                    minutes    = $dur
                })
                $dayCount++
            }
        } catch { [void]$daysWithNoFile.Add("$key（解析失败：$($_.Exception.Message)）") }
    } else {
        [void]$daysWithNoFile.Add($key)
    }
    [void]$daySummaries.Add([ordered]@{ date = $key; records = $dayCount })

    $fpFile = Join-Path $fpDir "$key.json"
    if (Test-Path -LiteralPath $fpFile) {
        try {
            $f = Get-Content -LiteralPath $fpFile -Raw -Encoding UTF8 | ConvertFrom-Json
            [void]$farmDays.Add([ordered]@{
                date        = $key
                normalMobs  = $f.totalNormalMobCount
                eliteMobs   = $f.totalEliteMobCount
                records     = @($f.records).Count
            })
        } catch { }
    }
}

$okCount = @($records | Where-Object { $_.successful }).Count
$failCount = $records.Count - $okCount
# 注意：$records 里是 [ordered] 字典，Measure-Object -Property 读不到字典的键（会报"找不到属性 minutes"）→ 手工累加
$totalMinutes = 0.0
foreach ($r in $records) { if ($r.minutes) { $totalMinutes += [double]$r.minutes } }

$progress = @()
if (Test-Path -LiteralPath $tpDir) {
    $progress = @(Get-ChildItem -LiteralPath $tpDir -Filter '*.json' -File -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 5 | ForEach-Object {
            $p = $null
            try { $p = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
            [ordered]@{
                file    = $_.Name
                name    = if ($p) { [string]$p.Name } else { '' }
                group   = if ($p) { [string]$p.CurrentScriptGroupName } else { '' }
                project = if ($p -and $p.CurrentScriptGroupProjectInfo) { [string]$p.CurrentScriptGroupProjectInfo.Name } else { '' }
                loop    = if ($p) { [bool]$p.Loop } else { $false }
            }
        })
}

$result = [ordered]@{
    root        = $Root
    anchorDate  = $anchor.ToString('yyyy-MM-dd')
    days        = $days
    filters     = [ordered]@{ group = $Group; material = $Material }
    recordCount = $records.Count
    okCount     = $okCount
    failCount   = $failCount
    totalMinutes = [math]::Round($totalMinutes, 1)
    perDay      = $daySummaries
    daysWithoutFile = $daysWithNoFile
    farming     = $farmDays
    taskProgress = $progress
    records     = @($records)
}

if ($Json) {
    $result | ConvertTo-Json -Depth 8
} else {
    "=== 执行战果（$($anchor.ToString('yyyy-MM-dd'))$(if ($days -gt 1) { " 起往前 $days 天" })）==="
    if ($Group) { "配置组过滤: $Group" }
    if ($Material) { "项目过滤  : $Material" }
    ""
    if ($records.Count -eq 0) {
        "（没有执行记录）"
        "说明：**一条龙不写 ExecutionRecords**——只有配置组任务 / --startGroups / --TaskProgress 会写。"
        if ($daysWithNoFile.Count) { "缺文件的日期：$($daysWithNoFile -join ', ')" }
        "若你期望有记录，请确认：① 真的跑过配置组；② 日期选对了。"
    } else {
        "总计: $($records.Count) 条  成功 $okCount / 失败 $failCount  累计耗时 $([math]::Round($totalMinutes,1)) 分钟"
        ""
        $records | ForEach-Object {
            $mark = if ($_.successful) { '✓' } else { '✗' }
            $dur = if ($_.minutes) { "$($_.minutes) 分" } else { '—' }
            $folderTxt = ''
            if ($_.folder) { $folderTxt = " ($($_.folder))" }
            "  {0} {1} [{2}] {3}{4}  {5}" -f $mark, $_.time, $_.type, $_.project, $folderTxt, $dur
            if ($_.group) { "      组: $($_.group)" }
        }
        if ($failCount -gt 0) {
            ""
            "失败项（建议用 bgi_log_search 查这几条路线的时段）："
            $records | Where-Object { -not $_.successful } | ForEach-Object { "  · $($_.project)  @ $($_.time)" }
        }
    }
    if ($farmDays.Count) {
        ""
        "刷取统计（FarmingPlan）："
        $farmDays | ForEach-Object { "  $($_.date)  小怪 $($_.normalMobs)  精英 $($_.eliteMobs)  记录 $($_.records) 条" }
    }
    if ($progress.Count) {
        ""
        "断点续跑进度（task_progress）："
        $progress | ForEach-Object { "  $($_.file)  组=$($_.group)  项目=$($_.project)  循环=$($_.loop)" }
    }
}

if ($records.Count -gt 0) { exit 0 } else { exit 1 }
