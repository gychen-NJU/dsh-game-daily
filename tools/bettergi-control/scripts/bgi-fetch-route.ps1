<#
.SYNOPSIS
    在官方脚本仓库里检索（并可下载）地图追踪路线，例如「星螺」。
.DESCRIPTION
    为什么需要它：`User\AutoPathing` 里的采集路线不是自带的，得从官方仓库
    babalae/bettergi-scripts-list 取。MCP 工具 bgi_collect_material 会做这件事，
    但它需要 DSH 重启后可见；本脚本让 **skill 路径自身**也完整可用（无 MCP 也能跑通）。

    仓库结构（2026-10-16 实测，与直觉不同）：
      · 根目录 `repo.json` = 目录树索引（约 4.4 MB，只有 name/type/children）
      · 文件实际在 **`repo/<分区>/…`** 之下（分区 pathing / js / combat / tcg）
      · 落地映射（源码 ScriptRepoUpdater.PathMapper）：
          pathing → User\AutoPathing    js → User\JsScript
          combat  → User\AutoFight      tcg → User\AutoGeniusInvokation
    所以 raw 下载地址要写成 …/refs/heads/main/repo/pathing/<…>.json（漏掉 repo/ 会 404）。
.PARAMETER Material
    材料/怪物/矿物名，例如 星螺
.PARAMETER Kind
    仓库分区，默认 pathing
.PARAMETER Download
    下载命中文件到本机对应目录（保持子目录结构）
.PARAMETER All
    默认只取"位于同名目录下"的路线；加 -All 时连"文件名含关键词"的顺路路线也一起处理
.PARAMETER Overwrite
    覆盖已存在的文件
.PARAMETER Root
    BetterGI 安装根，默认 D:\software\BetterGI
.EXAMPLE
    pwsh -File bgi-fetch-route.ps1 -Material 星螺                 # 只检索
    pwsh -File bgi-fetch-route.ps1 -Material 星螺 -Download       # 检索 + 下载
    pwsh -File bgi-fetch-route.ps1 -Material 星螺 -Download -All  # 连顺路路线一起
.NOTES
    退出码：0=命中；1=未命中；2=参数/网络问题。UTF-8 带 BOM（PS 5.1）。
    索引缓存：$env:TEMP\bgi-repo-cache.json（6 小时有效），加 -RefreshIndex 强制重拉。
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$Material,
    [ValidateSet('pathing', 'js', 'combat', 'tcg')][string]$Kind = 'pathing',
    [switch]$Download,
    [switch]$All,
    [switch]$Overwrite,
    [switch]$RefreshIndex,
    [string]$Root = 'D:\software\BetterGI'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$RAW_BASE = 'https://raw.githubusercontent.com/babalae/bettergi-scripts-list/refs/heads/main/'
$INDEX_URLS = @(
    ($RAW_BASE + 'repo.json'),
    'https://r2-script.bettergi.com/github_mirror/repo.json'
)
$MAP = @{
    pathing = (Join-Path $Root 'User\AutoPathing')
    js      = (Join-Path $Root 'User\JsScript')
    combat  = (Join-Path $Root 'User\AutoFight')
    tcg     = (Join-Path $Root 'User\AutoGeniusInvokation')
}

# ---------- 1) 索引（带 6 小时缓存） ----------
$cache = Join-Path $env:TEMP 'bgi-repo-cache.json'
$needFetch = $RefreshIndex -or -not (Test-Path -LiteralPath $cache)
if (-not $needFetch) {
    $age = (Get-Date) - (Get-Item -LiteralPath $cache).LastWriteTime
    if ($age.TotalHours -gt 6) { $needFetch = $true }
}
if ($needFetch) {
    $ok = $false
    foreach ($u in $INDEX_URLS) {
        try {
            "拉取仓库索引：$u"
            Invoke-WebRequest -Uri $u -OutFile $cache -TimeoutSec 180 -UseBasicParsing
            $ok = $true; break
        } catch { "  ✗ $($_.Exception.Message)" }
    }
    if (-not $ok) {
        if (Test-Path -LiteralPath $cache) { "⚠ 拉取失败，改用旧缓存" } else { "✗ 无法获取仓库索引（网络问题？）"; exit 2 }
    }
}
$index = Get-Content -LiteralPath $cache -Raw -Encoding UTF8 | ConvertFrom-Json

# ---------- 2) 摊平目录树并匹配 ----------
$script:files = @()
function Walk($nodes, $prefix) {
    foreach ($n in $nodes) {
        if (-not $n -or -not $n.name) { continue }
        $p = if ($prefix) { "$prefix/$($n.name)" } else { $n.name }
        if ($n.type -eq 'file') { $script:files += $p }
        if ($n.children -and $n.children -is [array]) { Walk $n.children $p }
    }
}
Walk $index.indexes ''

$key = $Material.Trim()
$kindFiles = @($script:files | Where-Object { $_ -like "$Kind/*" -and $_ -like '*.json' })
$primary = @($kindFiles | Where-Object { $_ -like "*/$key/*" })
$secondary = @($kindFiles | Where-Object { $_ -notlike "*/$key/*" -and (Split-Path $_ -Leaf) -like "*$key*" })

"=== 官方仓库检索「$key」（分区 $Kind） ==="
if ($primary.Count -gt 0) {
    "主命中 $($primary.Count) 条（位于同名目录下）："
    $primary | ForEach-Object { "  · $_" }
} else { "（没有位于同名目录下的路线）" }
if ($secondary.Count -gt 0) {
    "顺路/相关 $($secondary.Count) 条（文件名含关键词）："
    $secondary | Select-Object -First 20 | ForEach-Object { "  · $_" }
}
if ($primary.Count -eq 0 -and $secondary.Count -eq 0) {
    "没有找到匹配项——换更短的关键词试试；或自己录制路线（游戏内「路径记录」）。"
    exit 1
}

$targets = @($primary)
if ($All) { $targets += $secondary }
if ($primary.Count -eq 0) { $targets = @($secondary); "⚠ 没有主命中，仅处理顺路路线" }

# ---------- 3) 下载 ----------
if (-not $Download) {
    ""
    "（未下载：加 -Download 落到 $($MAP[$Kind])）"
    "下载后可用：pwsh -File bgi-collect.ps1 -Material '$key' -List   查看；-Run 生成配置组并触发"
    exit 0
}

$destRoot = $MAP[$Kind]
$newCount = 0
$skipCount = 0
$failCount = 0
foreach ($rel in $targets) {
    # rel 形如 pathing/地方特产/璃月/星螺/01-….json → 本机 <destRoot>\地方特产\璃月\星螺\01-….json
    $parts = $rel -split '/'
    $sub = @($parts | Select-Object -Skip 1)
    $dest = Join-Path $destRoot ($sub -join '\')
    if ((Test-Path -LiteralPath $dest) -and -not $Overwrite) {
        "  已存在  $($sub -join '/')"; $skipCount++; continue
    }
    # 中文与空格按段编码；文件实际在仓库的 repo/ 之下
    $enc = (($rel -split '/') | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
    $url = $RAW_BASE + 'repo/' + $enc
    try {
        $text = (Invoke-WebRequest -Uri $url -TimeoutSec 120 -UseBasicParsing).Content
        $dir = Split-Path -Parent $dest
        if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        [System.IO.File]::WriteAllText($dest, $text, (New-Object System.Text.UTF8Encoding($false)))
        # 落地即校验：必须是带 info + positions 的合法地图追踪文件
        $points = 0
        try { $points = @((Get-Content -LiteralPath $dest -Raw -Encoding UTF8 | ConvertFrom-Json).positions).Count } catch { $points = 0 }
        if ($points -gt 0) { "  已下载  $($sub -join '/')  ✓ $points 个路径点"; $newCount++ }
        else { "  已下载  $($sub -join '/')  ⚠ 结构异常（positions 为空）"; $newCount++ }
    } catch {
        "  失败    $($sub -join '/')  ← $($_.Exception.Message)"; $failCount++
    }
}
""
"合计：新下载 $newCount / 已存在 $skipCount / 失败 $failCount → $destRoot"
"下一步：pwsh -File bgi-collect.ps1 -Material '$key' -Run    # 生成配置组「采集-$key」并触发"
exit 0
