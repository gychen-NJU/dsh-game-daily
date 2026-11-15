<#
.SYNOPSIS
    战斗策略工具：列出 / 预测选中 / 语法校验（只读）。
.DESCRIPTION
    镜像 BetterGI 的解析与挑选规则：
      · 解析：跳过 // 与 # 注释；按 ; 断句；用「第一个括号深度为 0 的空格」分隔角色名与指令；
              指令按 | 与顶层 , 切分；方法名对照 Method.cs 白名单。
      · 挑选（SelectCombatScript）：命中当前队伍人数最多者优先；同分时角色表更短者优先；再同分保留先遇到的。
.PARAMETER Root
    BetterGI 安装根，默认 D:\software\BetterGI
.PARAMETER List
    列出 User\AutoFight 下所有策略及其角色表
.PARAMETER Simulate
    逗号分隔的队伍角色名，例如 -Simulate '莉奈娅,哥伦比娅,千织,兹白' → 预测会选中哪份策略
.PARAMETER Validate
    校验单个策略文件的语法与编码
.EXAMPLE
    pwsh -File bgi-strategy.ps1 -List
    pwsh -File bgi-strategy.ps1 -Simulate '莉奈娅,哥伦比娅,千织,兹白'
    pwsh -File bgi-strategy.ps1 -Validate 'D:\software\BetterGI\User\AutoFight\兹白月结晶.txt'
.NOTES
    退出码：0=正常/校验通过；1=校验发现问题或未匹配到策略；2=参数或路径问题。
    UTF-8 带 BOM 保存（Windows PowerShell 5.1）。
#>
[CmdletBinding()]
param(
    [string]$Root = 'D:\software\BetterGI',
    [switch]$List,
    [string]$Simulate = '',
    [string]$Validate = '',
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

# BetterGI Method.cs 的方法名/别名白名单
$METHODS = @(
    'skill', 'e', 'burst', 'q', 'attack', '普攻', '普通攻击', 'charge', '重击',
    'wait', 'after', '等待', 'ready', '完成', 'check', '检测',
    'walk', '行走', 'w', 'a', 's', 'd', 'aim', 'r', '瞄准', 'dash', '冲刺', 'jump', 'j', '跳跃',
    'mousedown', 'mouseup', 'click', 'moveby', 'keydown', 'keyup', 'keypress',
    'scroll', 'verticalscroll', 'round'
)

function Split-TopLevel([string]$text, [char]$sep) {
    # 在括号深度 0 处切分
    $parts = New-Object System.Collections.ArrayList
    $depth = 0; $buf = ''
    foreach ($ch in $text.ToCharArray()) {
        if ($ch -eq '(') { $depth++ }
        elseif ($ch -eq ')') { $depth-- }
        if ($ch -eq $sep -and $depth -eq 0) { [void]$parts.Add($buf); $buf = ''; continue }
        $buf += $ch
    }
    [void]$parts.Add($buf)
    return $parts
}

function Parse-StrategyFile([string]$path) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)
    $lines = Get-Content -LiteralPath $path -Encoding UTF8
    $names = New-Object System.Collections.ArrayList
    $commands = New-Object System.Collections.ArrayList
    $errors = New-Object System.Collections.ArrayList
    $lineNo = 0
    foreach ($raw in $lines) {
        $lineNo++
        $l = $raw.Trim()
        if ($l -eq '' -or $l.StartsWith('//') -or $l.StartsWith('#')) { continue }
        $l = $l.Replace('（', '(').Replace('）', ')').Replace('，', ',')
        $fragments = if ($l.Contains(';')) { $l.Split(';') } else { @($l) }
        foreach ($frag in $fragments) {
            $t = $frag.Trim()
            if ($t -eq '') { continue }
            $depth = 0; $sep = -1
            for ($i = 0; $i -lt $t.Length; $i++) {
                $c = $t[$i]
                if ($c -eq '(') { $depth++ }
                elseif ($c -eq ')') { $depth-- }
                elseif ($c -eq ' ' -and $depth -eq 0) { $sep = $i; break }
            }
            if ($sep -le 0) {
                [void]$errors.Add("L${lineNo}: 没有角色前缀（必须以空格分隔角色与指令）: $t")
                continue
            }
            $char = $t.Substring(0, $sep).Trim()
            $cmdText = $t.Substring($sep + 1)
            [void]$names.Add($char)
            foreach ($part in (Split-TopLevel $cmdText '|')) {
                foreach ($cmd in (Split-TopLevel $part ',')) {
                    $c = $cmd.Trim()
                    if ($c -eq '') { continue }
                    $m = $c.IndexOf('(')
                    $method = if ($m -gt 0) { $c.Substring(0, $m).Trim() } else { $c }
                    if ($METHODS -notcontains $method.ToLower()) {
                        [void]$errors.Add("L${lineNo}: 未知指令 '$method'（角色 $char）")
                    }
                    [void]$commands.Add($c)
                }
            }
        }
    }
    return [pscustomobject]@{
        path        = $path
        name        = [System.IO.Path]::GetFileNameWithoutExtension($path)
        hasBom      = $hasBom
        avatarNames = @($names | Select-Object -Unique)
        commands    = @($commands)
        errors      = @($errors)
    }
}

function Get-AllStrategies([string]$root) {
    $dir = Join-Path $root 'User\AutoFight'
    if (-not (Test-Path -LiteralPath $dir)) { return @() }
    $files = Get-ChildItem -LiteralPath $dir -Recurse -File -Filter '*.txt' -ErrorAction SilentlyContinue |
        Sort-Object FullName
    $out = @()
    foreach ($f in $files) {
        try { $out += Parse-StrategyFile $f.FullName }
        catch { $out += [pscustomobject]@{ path = $f.FullName; name = $f.Name; hasBom = $false; avatarNames = @(); commands = @(); errors = @("解析失败: $($_.Exception.Message)") } }
    }
    return $out
}

if (-not (Test-Path -LiteralPath $Root)) { "✗ 安装根不存在: $Root"; exit 2 }

# ---------- -List ----------
if ($List -or ($Simulate -eq '' -and $Validate -eq '' -and -not $List)) {
    $all = Get-AllStrategies $Root
    if ($Json) {
        @($all | ForEach-Object { [ordered]@{ name = $_.name; avatarCount = $_.avatarNames.Count; avatars = $_.avatarNames; commandCount = $_.commands.Count; errors = $_.errors; path = $_.path } }) | ConvertTo-Json -Depth 5
    } else {
        "=== User\AutoFight 下的战斗策略（$($all.Count) 份）==="
        foreach ($s in $all) {
            "  {0,-30} 角色 {1,2} 人 / 指令 {2,3} 条{3}" -f $s.name, $s.avatarNames.Count, $s.commands.Count, $(if ($s.errors.Count -gt 0) { "  ⚠ $($s.errors.Count) 处语法问题" } else { '' })
            "      角色: $($s.avatarNames -join ', ')"
        }
        "提示：选策略是「命中队伍人数最多者优先，同分取角色表更短者」——用 -Simulate '<队伍四人>' 预测结果。"
    }
    if (-not $Simulate -and -not $Validate) { exit 0 }
}

# ---------- -Simulate ----------
if ($Simulate -ne '') {
    $team = @($Simulate.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    if ($team.Count -eq 0) { "✗ -Simulate 需要逗号分隔的角色名"; exit 2 }
    $all = Get-AllStrategies $Root
    $rows = @()
    $best = $null
    foreach ($s in $all) {
        $hit = @($team | Where-Object { $s.avatarNames -contains $_ })
        $rows += [ordered]@{ name = $s.name; matchCount = $hit.Count; avatarCount = $s.avatarNames.Count; matched = $hit }
        if ($hit.Count -gt 0) {
            # 官方规则：命中人数多者优先；同分取角色表更短者；再同分保留先遇到的
            if ($null -eq $best -or $hit.Count -gt $best.matchCount -or
                ($hit.Count -eq $best.matchCount -and $s.avatarNames.Count -lt $best.avatarCount)) {
                $best = [pscustomobject]@{ name = $s.name; matchCount = $hit.Count; avatarCount = $s.avatarNames.Count; matched = $hit }
            }
        }
    }
    if ($Json) {
        [ordered]@{ team = $team; candidates = $rows; winner = $best } | ConvertTo-Json -Depth 5
    } else {
        "=== 预测：队伍 [$($team -join ', ')] 会选中哪份策略 ==="
        foreach ($r in $rows) { "  {0,-30} 命中 {1}/{2}  {3}" -f $r.name, $r.matchCount, $team.Count, $(if ($r.matched.Count -gt 0) { "（$($r.matched -join ',')）" } else { '' }) }
        if ($best) {
            if ($best.matchCount -eq $team.Count) { "→ 会完整匹配: $($best.name)" }
            else { "→ 只部分命中（日志会显示「未完整匹配到当前队伍，使用匹配度最高的队伍」）: $($best.name)" }
        } else {
            "→ ⛔ 没有任何策略命中 → 运行时会抛「未匹配到任何战斗脚本」，该秘境/战斗会直接结束"
        }
    }
    if (-not $best) { exit 1 }
    exit 0
}

# ---------- -Validate ----------
if ($Validate -ne '') {
    if (-not (Test-Path -LiteralPath $Validate)) { "✗ 文件不存在: $Validate"; exit 2 }
    $s = Parse-StrategyFile (Resolve-Path -LiteralPath $Validate).Path
    if ($Json) {
        [ordered]@{ name = $s.name; hasBom = $s.hasBom; avatarCount = $s.avatarNames.Count; avatars = $s.avatarNames; commandCount = $s.commands.Count; errors = $s.errors } | ConvertTo-Json -Depth 5
    } else {
        "=== 校验 $($s.name) ==="
        "编码      : $(if ($s.hasBom) { 'UTF-8 带 BOM' } else { 'UTF-8 无 BOM（推荐）' })"
        "角色      : $($s.avatarNames.Count) 人 → $($s.avatarNames -join ', ')"
        "指令      : $($s.commands.Count) 条"
        if ($s.errors.Count -eq 0) { "语法      : ✓ 无问题" } else { "语法      : ✗ $($s.errors.Count) 处"; $s.errors | ForEach-Object { "   - $_" } }
    }
    if ($s.errors.Count -gt 0) { exit 1 }
    exit 0
}

exit 0
