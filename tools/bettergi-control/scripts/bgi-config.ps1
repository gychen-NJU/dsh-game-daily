<#
.SYNOPSIS
    安全修改 BetterGI 的 User\config.json（检查进程 → 备份 → 改 → 回读校验）。
.DESCRIPTION
    只支持"父节点.叶子=值"两段式路径（因为同名叶子在不同配置段里会重复，例如 strategyName / partyName）。
    流程：① 拒绝在 BetterGI 运行时执行；② 备份 config.json；③ 文本级精确替换（保留注释与格式）；
         ④ 用 ConvertFrom-Json 复解析校验；⑤ 回读并打印 old → new。
.PARAMETER Set
    一条或多条 "父.子=值"。**只能写一次 -Set**，多条用逗号连成数组：
    -Set 'autoDomainConfig.condensedResinUseCount=5','autoDomainConfig.transientResinUseCount=0'
    值类型自动判定：true/false → 布尔；纯数字 → 数字；其余 → 字符串
.PARAMETER DryRun
    只显示将要做的修改，不写文件
.PARAMETER NoBackup
    不生成备份（默认会备份到 <Root>\_backup_<时间戳>\config.json）
.EXAMPLE
    pwsh -File bgi-config.ps1 -Set 'autoDomainConfig.specifyResinUse=true','autoDomainConfig.condensedResinUseCount=5' -DryRun
    pwsh -File bgi-config.ps1 -Set 'otherConfig.farmingPlanConfig.miyousheDataConfig.dailyEliteCap=400'   # 任意深度
.NOTES
    退出码：0=成功（或 DryRun 完成）；1=写失败/校验失败；2=前置不满足（程序在运行/参数非法）。
    UTF-8 带 BOM（PS 5.1）。写出的 config.json 为 UTF-8 无 BOM。

    路径解析口径（2026-10-16 说明）：点路径支持**任意深度**（早期只支持一层点，三层以上一律报"格式错误"）。
    逐层定位是在上一层对象窗口内**子串搜索** `"名字": {` 并做花括号配平——中间层只要在父窗口内能唯一找到即可
    （不要求是直接子节点）。最后一段（叶子）必须在该最内层窗口内**唯一**，出现多次会被拒绝
    （例如 otherConfig.farmingPlanConfig.dailyEliteCap 有两处同名字段 → 必须写完整路径绕过歧义）。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string[]]$Set,
    [string]$Root = 'D:\software\BetterGI',
    [switch]$DryRun,
    [switch]$NoBackup
)

$ErrorActionPreference = 'Stop'
$cfgPath = Join-Path $Root 'User\config.json'
if (-not (Test-Path -LiteralPath $cfgPath)) { "✗ 找不到 $cfgPath"; exit 2 }

# ---------- 运行状态（真正写入前会硬性拒绝；DryRun 只提示） ----------
$running = @(Get-Process -Name 'BetterGI' -ErrorAction SilentlyContinue)

$raw = [System.IO.File]::ReadAllText($cfgPath, (New-Object System.Text.UTF8Encoding($false)))
$new = $raw
$plan = @()

# 在当前文本区间内定位 `"名字": { ... }` 对象，返回绝对起止下标（花括号配平，忽略字符串内的括号）
function Find-ObjectWindow([string]$text, [string]$name, [int]$from, [int]$to) {
    $pat = '"' + [regex]::Escape($name) + '"\s*:\s*\{'
    $m = [regex]::Match($text.Substring($from, $to - $from + 1), $pat)
    if (-not $m.Success) { return $null }
    $start = $from + $m.Index + $m.Length - 1   # 指向 '{'
    $depth = 0; $inStr = $false; $esc = $false
    for ($i = $start; $i -le $to; $i++) {
        $ch = $text[$i]
        if ($inStr) {
            if ($esc) { $esc = $false }
            elseif ($ch -eq '\') { $esc = $true }
            elseif ($ch -eq '"') { $inStr = $false }
            continue
        }
        if ($ch -eq '"') { $inStr = $true; continue }
        if ($ch -eq '{') { $depth++ }
        elseif ($ch -eq '}') { $depth--; if ($depth -eq 0) { return @{ start = $start; end = $i } } }
    }
    return $null
}

foreach ($item in $Set) {
    # 支持任意深度：父.子[.孙...]=值（早期只支持一层点，otherConfig.farmingPlanConfig.x 这类三层路径一律失败）
    if ($item -notmatch '^([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+)\s*=\s*(.*)$') {
        "✗ 参数格式应为 父.子[.孙...]=值，收到: $item"; exit 2
    }
    $pathText = $Matches[1]; $valueText = $Matches[2].Trim()
    $segs = $pathText.Split('.')
    $leaf = $segs[$segs.Count - 1]
    $containers = @()
    if ($segs.Count -gt 1) { $containers = $segs[0..($segs.Count - 2)] }

    # 值 → JSON 字面量
    if ($valueText -eq 'true' -or $valueText -eq 'false') { $literal = $valueText }
    elseif ($valueText -match '^-?\d+(\.\d+)?$') { $literal = $valueText }
    else { $literal = '"' + ($valueText -replace '\\', '\\\\' -replace '"', '\"') + '"' }

    # 逐层收窄到最内层容器（花括号配平精确框出对象，避免同名叶子在别的段里出现）
    $from = 0; $to = $new.Length - 1
    foreach ($c in $containers) {
        $win = Find-ObjectWindow -text $new -name $c -from $from -to $to
        if (-not $win) { "✗ 找不到节点「$c」（路径 $pathText 的容器链：$($containers -join ' → ')）"; exit 2 }
        $from = $win.start; $to = $win.end
    }
    $windowStart = $from; $windowEnd = $to

    $leafPattern = '("' + [regex]::Escape($leaf) + '"\s*:\s*)("(?:[^"\\]|\\.)*"|true|false|-?\d+(?:\.\d+)?)'
    $leafMatches = [regex]::Matches($new.Substring($windowStart, $windowEnd - $windowStart + 1), $leafPattern)
    if ($leafMatches.Count -eq 0) { "✗ 在「$($containers -join '.')」段里找不到键「$leaf」"; exit 2 }
    if ($leafMatches.Count -gt 1) { "✗ 「$pathText」在该段里出现 $($leafMatches.Count) 次，无法唯一定位，请手工改"; exit 2 }

    $m = $leafMatches[0]
    $oldLiteral = $m.Groups[2].Value
    $absoluteStart = $windowStart + $m.Groups[1].Index + $m.Groups[1].Length
    $absoluteEnd = $absoluteStart + $oldLiteral.Length
    $new = $new.Substring(0, $absoluteStart) + $literal + $new.Substring($absoluteEnd)

    $plan += [pscustomobject]@{ key = $pathText; old = $oldLiteral; new = $literal }
}

# ---------- 校验：改完必须仍是合法 JSON ----------
try {
    $null = $new | ConvertFrom-Json
} catch {
    "✗ 替换后 JSON 解析失败，已放弃写入：$($_.Exception.Message)"
    $plan | ForEach-Object { "    $($_.key): $($_.old) → $($_.new)" }
    exit 1
}

if ($DryRun) {
    "（-DryRun）将修改 $cfgPath ："
    $plan | ForEach-Object { "    {0,-55} {1} → {2}" -f $_.key, $_.old, $_.new }
    if ($running.Count -gt 0) { "⚠ 当前 BetterGI 正在运行（PID $($running.Id -join ',')）——真正写入会被本脚本拒绝；请先让用户退出程序。" }
    exit 0
}

if ($running.Count -gt 0) {
    "✗ BetterGI 正在运行（PID $($running.Id -join ',')）——运行中改配置会被它回写覆盖。"
    "  请让用户从托盘退出 BetterGI 后重试（只想预览可用 -DryRun）。"
    exit 2
}

# ---------- 备份 ----------
if (-not $NoBackup) {
    $bk = Join-Path $Root ("_backup_" + (Get-Date -Format 'yyyyMMdd_HHmmss'))
    New-Item -ItemType Directory -Force -Path $bk | Out-Null
    Copy-Item -LiteralPath $cfgPath -Destination (Join-Path $bk 'config.json') -Force
    "✓ 已备份: $bk\config.json"
}

# ---------- 写入（UTF-8 无 BOM）----------
[System.IO.File]::WriteAllText($cfgPath, $new, (New-Object System.Text.UTF8Encoding($false)))

# ---------- 回读校验 ----------
$check = [System.IO.File]::ReadAllText($cfgPath, (New-Object System.Text.UTF8Encoding($false))) | ConvertFrom-Json
"✓ 已写入并回读校验通过："
foreach ($p in $plan) {
    $node = $check
    foreach ($seg in $p.key.Split('.')) { $node = $node.$seg }
    "    {0,-55} {1} → {2}   (回读={3})" -f $p.key, $p.old, $p.new, $node
}
exit 0
