<#
.SYNOPSIS
    解析 BetterGI 安装根（各脚本 dot-source 它，别再各自写死盘符）。

.DESCRIPTION
    BetterGI 可能被装在任意盘符任意目录（D:\Games\BetterGI、E:\software\BetterGI、
    %LOCALAPPDATA%\Programs\BetterGI ...）。以前 15 个脚本都写死 D:\software\BetterGI，
    装到别处就整条链路报 rootExists=false。这里把解析顺序收敛到一处：

      1. 显式 -Root（调用方说了算；给了但不存在也照原样返回，好让报错指向用户填的路径）
      2. 环境变量 DSH_GAME_DAILY_BETTERGI_ROOT / DSH_GAME_DAILY_BETTERGI / BETTERGI_ROOT
         （值可以是安装根，也可以直接是 BetterGI.exe 的完整路径）
      3. 书签文件 <stateDir>\bettergi-root.txt（一行纯文本，安装器/面板写入）
      4. 常见目录探测（各盘符的 \software \Games \Program Files \Tools 与根目录、家目录、LOCALAPPDATA）
      5. 出厂默认 D:\software\BetterGI（保持老用户行为不变）

    探针一律是「目录下有没有 BetterGI.exe」——候选里常有同名空目录，不能凭名字认。

.EXAMPLE
    . (Join-Path $PSScriptRoot 'bgi-root.ps1'); $root = Resolve-BgiRoot -Root $Root
.NOTES
    UTF-8 带 BOM（Windows PowerShell 5.1 才不会把中文注释读成乱码）。
#>

function ConvertTo-BgiRootPath {
    param([string]$Value)
    if (-not $Value) { return '' }
    $v = $Value.Trim()
    $v = $v.Trim([char]'"', [char]"'").Trim()
    if (-not $v) { return '' }
    $v = $v -replace '[\\/]+$', ''
    if ($v -match '(?i)\.exe$') { $v = Split-Path -Parent $v }
    return $v
}

function Test-BgiRootPath {
    param([string]$Path)
    if (-not $Path) { return $false }
    try { return (Test-Path -LiteralPath (Join-Path $Path 'BetterGI.exe') -PathType Leaf) } catch { return $false }
}

function Get-BgiRootPointerPath {
    $base = $env:DSH_GAME_DAILY_STATE_DIR
    if (-not $base) { $base = Join-Path $env:USERPROFILE '.dsh\game-daily' }
    return (Join-Path $base 'bettergi-root.txt')
}

function Get-BgiRootCandidates {
    $list = New-Object System.Collections.ArrayList
    foreach ($drive in @('C:', 'D:', 'E:', 'F:', 'G:', 'H:')) {
        foreach ($mid in @('software', 'Games', 'Program Files', 'Tools')) {
            [void]$list.Add("$drive\$mid\BetterGI")
        }
        [void]$list.Add("$drive\BetterGI")
    }
    if ($env:USERPROFILE) {
        [void]$list.Add((Join-Path $env:USERPROFILE 'BetterGI'))
        [void]$list.Add((Join-Path $env:USERPROFILE 'Games\BetterGI'))
    }
    if ($env:LOCALAPPDATA) { [void]$list.Add((Join-Path $env:LOCALAPPDATA 'Programs\BetterGI')) }
    [void]$list.Add('D:\software\BetterGI')
    return $list
}

function Resolve-BgiRoot {
    [CmdletBinding()]
    param([string]$Root = '')

    $explicit = ConvertTo-BgiRootPath $Root
    if ($explicit) { return $explicit }   # 显式指定优先；不存在也照原样返回，让上层如实报 rootExists=false

    foreach ($name in @('DSH_GAME_DAILY_BETTERGI_ROOT', 'DSH_GAME_DAILY_BETTERGI', 'BETTERGI_ROOT')) {
        $candidate = ConvertTo-BgiRootPath ([Environment]::GetEnvironmentVariable($name))
        if ($candidate -and (Test-BgiRootPath $candidate)) { return $candidate }
    }

    $pointerFile = Get-BgiRootPointerPath
    if (Test-Path -LiteralPath $pointerFile) {
        try {
            $candidate = ConvertTo-BgiRootPath (Get-Content -LiteralPath $pointerFile -Raw -Encoding UTF8)
            if ($candidate -and (Test-BgiRootPath $candidate)) { return $candidate }
        } catch { }
    }

    foreach ($candidate in (Get-BgiRootCandidates)) {
        if (Test-BgiRootPath $candidate) { return $candidate }
    }

    return 'D:\software\BetterGI'
}

# 脚本只需一行：$Root = Resolve-BgiRoot -Root $Root
