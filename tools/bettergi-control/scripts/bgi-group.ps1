<#
.SYNOPSIS
    生成 / 列出 BetterGI 配置组（User\ScriptGroup\<组名>.json）。
.DESCRIPTION
    配置组是"命令行唯一能指定执行的任务集合"：--startGroups <组名> 会按 projects 顺序执行。
    形状（已按源码与实测核对）：
      { "name": "<组名>", "projects": [ { "name":…, "folderName":…, "type":"Javascript|Pathing|KeyMouse|Shell",
                                          "status":"Enabled", "schedule":"Daily", "runNum":1 } ] }
    ⚠ status 必须恰好是 Enabled；写成别的 → 命令行路径会**静默跳过却记成成功**。
.PARAMETER Name
    组名（= 文件名，命令行按精确匹配）
.PARAMETER Type
    Javascript | Pathing | KeyMouse | Shell
.PARAMETER Target
    Pathing → 路径文件名（可省略 .json；可用 "子目录/文件名"）；Javascript → User\JsScript 下的脚本文件夹名；
    KeyMouse → 录制文件名；Shell → 要执行的命令
.PARAMETER List
    列出所有配置组及其项目
.PARAMETER DryRun
    只显示将写入的内容
.EXAMPLE
    pwsh -File bgi-group.ps1 -List
    pwsh -File bgi-group.ps1 -Name '采集-星螺' -Type Pathing -Target '星螺' -Add
.NOTES
    退出码：0=成功；1=写入/校验失败；2=参数或前置问题。UTF-8 带 BOM（PS 5.1）。
#>
[CmdletBinding()]
param(
    [string]$Name = '',
    [ValidateSet('Javascript', 'Pathing', 'KeyMouse', 'Shell')]
    [string]$Type = 'Pathing',
    [string]$Target = '',
    [switch]$Add,
    [switch]$List,
    [switch]$DryRun,
    [string]$Root = 'D:\software\BetterGI'
)

$ErrorActionPreference = 'Stop'
$sgDir = Join-Path $Root 'User\ScriptGroup'
if (-not (Test-Path -LiteralPath $sgDir)) { New-Item -ItemType Directory -Force -Path $sgDir | Out-Null }

# ---------- -List ----------
if ($List -or (-not $Add -and $Name -eq '')) {
    $files = @(Get-ChildItem -LiteralPath $sgDir -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)
    "=== 配置组（$($files.Count) 个，目录 $sgDir）==="
    if ($files.Count -eq 0) { "  （空）" }
    foreach ($f in $files) {
        try {
            $g = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
            "  [$($g.name)]  ← $($f.Name)  共 $($g.projects.Count) 项"
            foreach ($p in $g.projects) {
                "      - {0,-28} type={1,-10} status={2,-8} folder={3}" -f $p.name, $p.type, $p.status, $p.folderName
            }
        } catch { "  $($f.Name)  解析失败: $($_.Exception.Message)" }
    }
    "用法提示：pwsh -File bgi-run.ps1 -Mode groups -Name '<组名>' 触发；多个组用逗号分隔。"
    exit 0
}

if (-not $Add) { "✗ 需要 -Add（新增项目）或 -List（列出）"; exit 2 }
if ([string]::IsNullOrWhiteSpace($Name)) { "✗ -Add 需要 -Name <组名>"; exit 2 }
if ([string]::IsNullOrWhiteSpace($Target)) { "✗ -Add 需要 -Target <目标>"; exit 2 }

# ---------- 组装项目 ----------
$proj = [ordered]@{ name = ''; folderName = ''; type = $Type; status = 'Enabled'; schedule = 'Daily'; runNum = 1 }
switch ($Type) {
    'Pathing' {
        $t = $Target.Trim()
        if ($t -match '[\\/]') {
            # 支持任意深度：目录 = 去掉最后一段，文件名 = 最后一段
            # （旧实现用 parts[0]/parts[-1]，三层路径会被写成"第一段当目录"→ 运行时找不到文件）
            $i = $t.LastIndexOfAny([char[]]@('\', '/'))
            $proj.folderName = $t.Substring(0, $i)
            $proj.name = $t.Substring($i + 1)
        } else { $proj.name = $t }
        if ($proj.name -notmatch '\.json$') { $proj.name = $proj.name + '.json' }
        # 存在性检查（给出警告但不阻断：路径可能在 User\AutoPathing 的子目录里）
        $cand = Join-Path (Join-Path $Root 'User\AutoPathing') (Join-Path $proj.folderName $proj.name)
        if (-not (Test-Path -LiteralPath $cand)) {
            "⚠ 未找到路径文件: $cand"
            "  （Pathing 用 bgi-collect.ps1 -List 看有哪些可用路径）"
        }
    }
    'Javascript' {
        $proj.folderName = $Target.Trim()
        $proj.name = $proj.folderName + '.js'
        $manifest = Join-Path (Join-Path $Root 'User\JsScript') (Join-Path $proj.folderName 'manifest.json')
        if (-not (Test-Path -LiteralPath $manifest)) { "⚠ 未找到脚本描述: $manifest（需要 manifest.json + main.js）" }
        $proj['allowJsNotification'] = $true
    }
    'KeyMouse' { $proj.name = $Target.Trim() }
    'Shell' { $proj.name = $Target.Trim() }
}

# ---------- 合并进组文件 ----------
$file = Join-Path $sgDir "$Name.json"
$group = $null
if (Test-Path -LiteralPath $file) {
    try { $group = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json } catch { "✗ 现有组文件解析失败: $($_.Exception.Message)"; exit 1 }
}
if (-not $group) { $group = [pscustomobject]@{ name = $Name; projects = @() } }
$projects = @($group.projects)
$dup = @($projects | Where-Object { $_.name -eq $proj.name -and $_.type -eq $proj.type })
if ($dup.Count -gt 0) { "ℹ 组 '$Name' 里已存在同名同类型项目（$($proj.name) / $($proj.type)），未重复添加。"; exit 0 }
$projects += [pscustomobject]$proj

$outObj = [ordered]@{ name = $Name; projects = $projects }
$json = $outObj | ConvertTo-Json -Depth 6

if ($DryRun) {
    "（-DryRun）将写入 $file ："
    $json
    exit 0
}

# ---------- 备份 + 写入（UTF-8 无 BOM）+ 回读 ----------
if (Test-Path -LiteralPath $file) {
    $bkDir = Join-Path $Root ("_backup_" + (Get-Date -Format 'yyyyMMdd_HHmmss'))
    New-Item -ItemType Directory -Force -Path $bkDir | Out-Null
    Copy-Item -LiteralPath $file -Destination (Join-Path $bkDir "$Name.json") -Force
    "✓ 已备份原组文件到 $bkDir"
}
[System.IO.File]::WriteAllText($file, $json, (New-Object System.Text.UTF8Encoding($false)))
$chk = [System.IO.File]::ReadAllText($file, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
"✓ 已写入 $file（回读校验通过，共 $($chk.projects.Count) 项）"
$chk.projects | ForEach-Object { "    - {0,-28} type={1,-10} status={2}" -f $_.name, $_.type, $_.status }
"触发：pwsh -File bgi-run.ps1 -Mode groups -Name '$Name'"
exit 0
