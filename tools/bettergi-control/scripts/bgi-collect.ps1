<#
.SYNOPSIS
    材料 → 地图追踪路径索引；命中后可一键生成配置组并触发（采集类任务的入口）。
.DESCRIPTION
    扫描 User\AutoPathing\**\*.json（可用 -ExtraDirs 追加目录），把路径文件按
    "文件名 / info.name" 建成索引；-Material 做模糊匹配。
    现实约束（本机已核实）：User\AutoPathing 目前为空；内置
    GameTask\AutoLeyLineOutcrop\Assets\pathing（632 json）是**地脉花点位**，不是采集路线。
    没有路径文件时无法凭空生成路线——脚本会给出获取/录制指引并返回退出码 1。
.PARAMETER Material
    材料名（模糊匹配文件名或 info.name），例如 星螺
.PARAMETER List
    列出所有可用路径
.PARAMETER ExtraDirs
    追加扫描目录（例如你从路径仓库下载后的存放位置）
.PARAMETER Run
    命中后：生成配置组「采集-<材料>」并立即触发
.PARAMETER DryRun
    配合 -Run：只显示将执行的动作，不建组、不触发
.EXAMPLE
    pwsh -File bgi-collect.ps1 -List
    pwsh -File bgi-collect.ps1 -Material 星螺 -Run
.NOTES
    退出码：0=命中（已输出/已触发）；1=未命中；2=前置或参数问题。UTF-8 带 BOM（PS 5.1）。
#>
[CmdletBinding()]
param(
    [string]$Material = '',
    [switch]$List,
    [string[]]$ExtraDirs = @(),
    [switch]$Run,
    [switch]$DryRun,
    [string]$Root = 'D:\software\BetterGI'
)

$ErrorActionPreference = 'Continue'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$roots = @()
$ap = Join-Path $Root 'User\AutoPathing'
if (Test-Path -LiteralPath $ap) { $roots += $ap }
foreach ($d in $ExtraDirs) { if (Test-Path -LiteralPath $d) { $roots += (Resolve-Path -LiteralPath $d).Path } }
if ($roots.Count -eq 0) { "✗ 没有可扫描的目录（$ap 不存在）"; exit 2 }

# ---------- 建索引 ----------
$index = @()
foreach ($r in $roots) {
    foreach ($f in (Get-ChildItem -LiteralPath $r -Recurse -File -Filter '*.json' -ErrorAction SilentlyContinue | Sort-Object FullName)) {
        $base = [System.IO.Path]::GetFileNameWithoutExtension($f.Name)
        $infoName = ''
        try {
            $j = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            if ($j.info -and $j.info.name) { $infoName = [string]$j.info.name }
            elseif ($j.name) { $infoName = [string]$j.name }
        } catch { }
        $rel = $f.FullName.Substring($r.Length).TrimStart('\')
        $index += [pscustomobject]@{
            base     = $base
            infoName = $infoName
            rel      = $rel
            full     = $f.FullName
            root     = $r
            sizeKB   = [math]::Round($f.Length / 1KB, 1)
            modified = $f.LastWriteTime.ToString('yyyy-MM-dd HH:mm')
        }
    }
}

if ($List -or $Material -eq '') {
    "=== 可用的地图追踪路径（$($index.Count) 条，扫描目录 $($roots -join ' ; ')）==="
    if ($index.Count -eq 0) {
        "  （空）"
        ""
        "怎么获得采集路线（三条途径）："
        "  1) 官方路径仓库/脚本仓库里找同名路线（界面「脚本仓库」订阅，或 bgi.sh / s.bettergi.com 手动下载）→ 放到 $ap"
        "  2) 自己录：游戏内用「路径记录」快捷键录制（前置：≥1920x1080 的 16:9、小地图锁定=锁定方向、截图方式 BitBlt）"
        "  3) 已有别人给的路径文件 → 用 -ExtraDirs 指向它所在目录，或直接拷进 $ap"
        ""
        "注意：内置 GameTask\AutoLeyLineOutcrop\Assets\pathing 是地脉花点位，不是采集路线。"
        exit 0
    }
    $index | ForEach-Object { "  {0,-34} info.name={1,-16} {2} KB  {3}" -f $_.rel, $_.infoName, $_.sizeKB, $_.modified }
    "用法：pwsh -File bgi-collect.ps1 -Material <名> [-Run]"
    exit 0
}

# ---------- 匹配 ----------
$key = $Material.Trim()
$exact = @($index | Where-Object { $_.base -eq $key -or $_.infoName -eq $key })
$fuzzy = @($index | Where-Object { $_.base -like "*$key*" -or $_.infoName -like "*$key*" })
$hit = if ($exact.Count -gt 0) { $exact } else { $fuzzy }

if ($hit.Count -eq 0) {
    "✗ 没找到与「$key」匹配的路径文件（共索引 $($index.Count) 条）"
    if ($index.Count -gt 0) {
        "  现有可用名（前 20）："
        $index | Select-Object -First 20 | ForEach-Object { "    - $($_.base)$(if ($_.infoName) { " ($($_.infoName))" })" }
    }
    ""
    "获得路线的三条途径："
    "  1) 从官方路径/脚本仓库订阅或下载同名路线 → 放进 <BGI>\User\AutoPathing\"
    "  2) 自己用「路径记录」录一条（≥1920x1080 16:9、小地图锁定=锁定方向、BitBlt）"
    "  3) 用 -ExtraDirs 指向你已有的路径目录"
    exit 1
}

"✓ 命中 $($hit.Count) 条："
$hit | ForEach-Object { "    $($_.rel)   info.name=$($_.infoName)" }
$pick = $hit | Select-Object -First 1
$groupName = "采集-$key"

if (-not $Run) {
    "执行方式（二选一）："
    "  A) pwsh -File `"$scriptDir\bgi-group.ps1`" -Name '$groupName' -Type Pathing -Target '$($pick.rel)' -Add"
    "     pwsh -File `"$scriptDir\bgi-run.ps1`" -Mode groups -Name '$groupName'"
    "  B) 或写进 JS：pathingScript.runFileFromUser('$($pick.rel)') 后挂进配置组"
    exit 0
}

if ($DryRun) {
    "（-DryRun）将执行："
    "  1) bgi-group.ps1 -Name '$groupName' -Type Pathing -Target '$($pick.rel)' -Add"
    "  2) bgi-run.ps1 -Mode groups -Name '$groupName'"
    exit 0
}

# ---------- 建组 + 触发 ----------
& (Join-Path $scriptDir 'bgi-group.ps1') -Name $groupName -Type Pathing -Target $pick.rel -Add
if ($LASTEXITCODE -ne 0) { "✗ 建组失败（退出码 $LASTEXITCODE）"; exit 2 }
& (Join-Path $scriptDir 'bgi-run.ps1') -Mode groups -Name $groupName
if ($LASTEXITCODE -ne 0) { "✗ 触发失败（退出码 $LASTEXITCODE，2=已有实例在运行）"; exit 2 }
"→ 已触发采集任务。观测：pwsh -File `"$scriptDir\bgi-watch.ps1`" -Mode groups -TimeoutMinutes 60"
exit 0
