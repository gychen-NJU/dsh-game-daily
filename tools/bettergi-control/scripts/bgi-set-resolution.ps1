<#
.SYNOPSIS
    把原神窗口纠正成 BetterGI 能用的 16:9（默认 1920×1080 窗口化）—— 走注册表，不动游戏文件。
.DESCRIPTION
    为什么需要它：BetterGI 的一条龙 / 自动秘境 / 自动寻路 / 自动采集都硬要求「16:9 且 ≥1920×1080」。
    本机屏幕是 2560×1600（16:10），一旦游戏回到 2560×1600，这些任务会整段报
    `[ERR] 游戏窗口分辨率不是 16:9 ！当前分辨率为 2560x1600`，而在此之前脚本侧只能
    「体检报阻断 + 让用户自己去游戏里改」。本脚本把这一步变成可自动执行的纠正：

      备份 → 写注册表（Unity 的 Screenmanager 三键）→ 可选拉起游戏 → 量窗口复核 → 失败可回滚

    原神（CN）读的键：HKCU\Software\miHoYo\原神
      Screenmanager Resolution Width_h182942802    = 宽
      Screenmanager Resolution Height_h2627697771  = 高
      Screenmanager Is Fullscreen mode_h3981298716 = 0 窗口化 / 1 全屏
    同时确保 YuanShen.exe 有 HIGHDPIAWARE DPI 覆盖：2560×1600@150% 缩放下，不加覆盖时
    游戏看到的是 1707×1067 的逻辑桌面，会被压到 1280×720（本机 2026-10-26 实测）。

    前置（硬性）：原神与 BetterGI 都必须先退出——运行中改注册表，游戏退出时会整份回写覆盖。
    窗口化 1920×1080 是唯一被实证跑通的组合（2026-10-26 12:53 一条龙走到 5/6、
    狗粮脚本 85 分钟成功；同一天 11:00 那次 2560×1600 导致合成树脂/秘境/每日奖励全 ERR）。

.PARAMETER Width
    目标宽，默认 1920。
.PARAMETER Height
    目标高，默认 1080。
.PARAMETER Fullscreen
    0=窗口化（默认，推荐）；1=全屏（只在你想用 2560×1440 这类 16:9 全屏时用）。
.PARAMETER RegKey
    注册表根键，默认 HKCU:\Software\miHoYo\原神（国际服可传 HKCU:\Software\miHoYo\Genshin Impact）。
.PARAMETER Root
    BetterGI 安装根，默认 D:\software\BetterGI（用来找 YuanShen.exe 与 BetterGI.exe）。
.PARAMETER InstallPath
    YuanShen.exe 绝对路径；省略时从 BetterGI 的 User\config.json 里读 genshinStartConfig.installPath。
.PARAMETER StateDir
    备份目录，默认 %USERPROFILE%\.dsh\game-daily\state。
.PARAMETER Apply
    真的写注册表。不带就是只读预览（等同 -DryRun）。
.PARAMETER Restore
    用上次 -Apply 的备份回滚（同样要求游戏未运行）。
.PARAMETER StartGame
    写完后拉起游戏并等窗口出现。默认用 `BetterGI.exe start`（会联动进游戏）；
    加 -DirectStart 则直接启动 YuanShen.exe（不弹 UAC、停在登录界面）。
.PARAMETER DirectStart
    配合 -StartGame：直接启动游戏进程，不经 BetterGI。
.PARAMETER StartMode
    Auto（默认）/ Process / Task。BetterGI 启动时无条件自提权，所以非提权上下文直接启动**必弹 UAC**。
    Auto = 已提权就直接启动（不会弹）；未提权但装了「BetterGI 按需执行」计划任务就走它
    （RunLevel=Highest，由任务计划服务提权，**完全不弹框**，可无人值守）；两者都不满足才回退直接启动并警告。
    Task = 强制走计划任务；Process = 强制直接启动（提权核对交给调用方）。
.PARAMETER Verify
    量当前游戏窗口（DPI 感知：150% 缩放下不会把合格的 1920×1080 误判成 1280×720），
    检查是否 16:9 且 ≥1920×1080。与 -StartGame 同用则在启动后自动复核。
.PARAMETER DryRun
    只读预览（默认行为，显式给出便于脚本化）。
.PARAMETER Json
    机器可读 JSON（stdout 只出 JSON）。
.PARAMETER WaitSeconds
    -StartGame 后等窗口的最长秒数，默认 150。
.EXAMPLE
    pwsh -File bgi-set-resolution.ps1                      # 只看现状与建议
.EXAMPLE
    pwsh -File bgi-close.ps1 -Target both                  # 先退出游戏与 BetterGI
    pwsh -File bgi-set-resolution.ps1 -Apply -StartGame -Verify
.EXAMPLE
    pwsh -File bgi-set-resolution.ps1 -Restore             # 回滚到上次 -Apply 前
.NOTES
    退出码：0=已经是目标值 / 已写入并通过复核；1=前置不满足（游戏或 BetterGI 在运行、
    注册表键缺失、YuanShen.exe 找不到、没有可回滚的备份）；2=写入或验证失败。
    UTF-8 带 BOM（PS 5.1）。
#>
[CmdletBinding()]
param(
    [int]$Width = 1920,
    [int]$Height = 1080,
    [int]$Fullscreen = 0,
    [string]$RegKey = 'HKCU:\Software\miHoYo\原神',
    [string]$Root = 'D:\software\BetterGI',
    [string]$InstallPath = '',
    [string]$StateDir = '',
    [switch]$Apply,
    [switch]$Restore,
    [switch]$StartGame,
    [switch]$DirectStart,
    [ValidateSet('Auto', 'Process', 'Task')]
    [string]$StartMode = 'Auto',
    [switch]$Verify,
    [switch]$DryRun,
    [switch]$Json,
    [int]$WaitSeconds = 150
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$script:VW = 'Screenmanager Resolution Width_h182942802'
$script:VH = 'Screenmanager Resolution Height_h2627697771'
$script:VF = 'Screenmanager Is Fullscreen mode_h3981298716'
$script:Layers = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'
$script:windowOk = $false

$result = [ordered]@{
    schemaVersion = 1
    ok            = $false
    action        = 'inspect'
    regKey        = $RegKey
    target        = [ordered]@{ width = $Width; height = $Height; fullscreen = $Fullscreen }
    current       = [ordered]@{ exists = $false; width = $null; height = $null; fullscreen = $null }
    gameExe       = $InstallPath
    processes     = [ordered]@{ game = $false; gamePids = @(); bettergi = $false; bettergiPids = @() }
    dpiOverride   = [ordered]@{ name = $InstallPath; value = $null; hasHighDpiAware = $false; added = $false }
    backupPath    = $null
    changed       = $false
    start         = $null
    window        = $null
    message       = ''
}

function Write-Line([string]$text) {
    if (-not $Json) { Write-Output $text }
}

function Get-Procs([string]$name) {
    return @(Get-Process -Name $name -ErrorAction SilentlyContinue)
}

function Get-RegState {
    $state = [ordered]@{ exists = (Test-Path -LiteralPath $RegKey); width = $null; height = $null; fullscreen = $null }
    if (-not $state.exists) { return $state }
    $p = Get-ItemProperty -LiteralPath $RegKey -ErrorAction SilentlyContinue
    if ($null -ne $p) {
        if ($p.PSObject.Properties.Name -contains $script:VW) { $state.width = [int]$p.($script:VW) }
        if ($p.PSObject.Properties.Name -contains $script:VH) { $state.height = [int]$p.($script:VH) }
        if ($p.PSObject.Properties.Name -contains $script:VF) { $state.fullscreen = [int]$p.($script:VF) }
    }
    return $state
}

function Set-RegState([int]$w, [int]$h, [int]$f) {
    Set-ItemProperty -LiteralPath $RegKey -Name $script:VW -Value $w -Type DWord -ErrorAction Stop
    Set-ItemProperty -LiteralPath $RegKey -Name $script:VH -Value $h -Type DWord -ErrorAction Stop
    Set-ItemProperty -LiteralPath $RegKey -Name $script:VF -Value $f -Type DWord -ErrorAction Stop
}

function Resolve-GameExe {
    if ($InstallPath -and (Test-Path -LiteralPath $InstallPath)) { return $InstallPath }
    $cfg = Join-Path $Root 'User\config.json'
    if (Test-Path -LiteralPath $cfg) {
        try {
            $raw = [System.IO.File]::ReadAllText($cfg, [System.Text.Encoding]::UTF8)
            $m = [regex]::Match($raw, '"installPath"\s*:\s*"((?:[^"\\]|\\.)*)"')
            if ($m.Success) {
                $p = $m.Groups[1].Value -replace '\\\\', '\'
                if (Test-Path -LiteralPath $p) { return $p }
            }
        } catch { }
    }
    foreach ($guess in @('D:\Saved Games\Genshin Impact Game\YuanShen.exe', 'D:\Program Files\Genshin Impact\Genshin Impact Game\YuanShen.exe')) {
        if (Test-Path -LiteralPath $guess) { return $guess }
    }
    return ''
}

function Get-DpiOverride([string]$exe) {
    $out = [ordered]@{ name = $exe; value = $null; hasHighDpiAware = $false; added = $false }
    if (-not $exe -or -not (Test-Path -LiteralPath $script:Layers)) { return $out }
    $p = Get-ItemProperty -Path $script:Layers -ErrorAction SilentlyContinue
    if ($null -ne $p -and ($p.PSObject.Properties.Name -contains $exe)) {
        $out.value = [string]$p.$exe
        $out.hasHighDpiAware = ($out.value -match 'HIGHDPIAWARE')
    }
    return $out
}

function Add-Item($list, $item) { if ($null -ne $list) { [void]$list.Add($item) } }

function Get-IsElevated {
    $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
    return $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# 免 UAC 启动。BetterGI 启动时**无条件自我提权**（App.xaml.cs:64 .UseElevated() →
# RuntimeHelper.EnsureElevated() → 非提权就 RestartAsElevated() 用 Verb=runas），
# 所以从非提权上下文直接 Start-Process **必然弹一次 UAC** —— 夜里没人点就白跑。
# 本机装有 RunLevel=Highest 的计划任务「BetterGI 按需执行」（跑 D:\software\BetterGI\_ondemand_runner.ps1），
# 走它 = 由任务计划服务提权启动，**不弹任何框**。请求文件协议：写 _run_request.json → Start-ScheduledTask。
# 注意：只用 $script:startInfo 回传，函数内绝不 return 对象（避免输出流被当返回值吞掉）。
$script:startInfo = $null
function Start-BetterGI([string]$bgiExe) {
    $info = [ordered]@{ mode = $StartMode; elevated = $false; task = $null; usedTask = $false; skipped = $false; pids = @(); ok = $false; note = '' }
    $info.elevated = Get-IsElevated
    $already = Get-Procs 'BetterGI'
    if ($already.Count -gt 0) {
        $info.skipped = $true; $info.ok = $true; $info.pids = @($already.Id)
        $info.note = "BetterGI 已在运行（PID $($already.Id -join ',')），跳过启动"
        Write-Line "→ $($info.note)"
        $script:startInfo = $info
        return
    }
    $taskName = 'BetterGI 按需执行'
    $task = $null
    try { $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue } catch { }
    $useTask = ($StartMode -eq 'Task') -or ($StartMode -eq 'Auto' -and -not $info.elevated -and $null -ne $task)
    if ($StartMode -eq 'Task' -and $null -eq $task) {
        $info.note = "要求走按需任务，但计划任务「$taskName」不存在"
        Write-Line "✗ $($info.note)"
        $script:startInfo = $info
        return
    }
    if ($useTask) {
        $info.task = $taskName
        $reqPath = Join-Path $Root '_run_request.json'
        $resPath = Join-Path $Root '_run_request.result.json'
        $req = [ordered]@{ mode = 'start'; name = ''; requestedAt = (Get-Date).ToString('o'); source = 'bgi-set-resolution.ps1' }
        try {
            ($req | ConvertTo-Json -Compress) | Set-Content -LiteralPath $reqPath -Encoding UTF8
            Remove-Item -LiteralPath $resPath -Force -ErrorAction SilentlyContinue
            Start-ScheduledTask -TaskName $taskName
            $info.usedTask = $true
            Write-Line "→ 已通过按需任务「$taskName」触发 BetterGI start（RunLevel=Highest，**免 UAC**）"
        } catch {
            Write-Line "⚠ 按需任务触发失败：$($_.Exception.Message) → 回退直接启动（可能弹 UAC）"
            $info.usedTask = $false
            $useTask = $false
        }
        if ($useTask) {
            $deadline = (Get-Date).AddSeconds(60)
            while ((Get-Date) -lt $deadline) {
                if (Test-Path -LiteralPath $resPath) { break }
                if ((Get-Procs 'BetterGI').Count -gt 0) { break }
                Start-Sleep -Milliseconds 1500
            }
            if (Test-Path -LiteralPath $resPath) {
                $r = $null
                try { $r = Get-Content -LiteralPath $resPath -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
                if ($null -ne $r -and ($r.PSObject.Properties.Name -contains 'ok') -and -not $r.ok) {
                    $info.note = "按需任务返回失败：$($r.error)"
                    Write-Line "✗ $($info.note)"
                    $script:startInfo = $info
                    return
                }
            }
        }
    }
    if (-not $useTask) {
        if (-not $info.elevated) { Write-Line '⚠ 当前未提权且没走按需任务 → BetterGI 会自提权，**会弹一次 UAC**' }
        try {
            Start-Process -FilePath $bgiExe -ArgumentList 'start' | Out-Null
        } catch {
            $info.note = "直接启动失败：$($_.Exception.Message)"
            Write-Line "✗ $($info.note)"
            $script:startInfo = $info
            return
        }
        Write-Line '→ 已发起 BetterGI start（直接启动）'
    }
    $deadline2 = (Get-Date).AddSeconds(60)
    while ((Get-Date) -lt $deadline2) {
        $ps = Get-Procs 'BetterGI'
        if ($ps.Count -gt 0) {
            $info.pids = @($ps.Id); $info.ok = $true
            $info.note = "BetterGI 已启动（PID $($ps.Id -join ',')）"
            break
        }
        Start-Sleep -Milliseconds 1500
    }
    if (-not $info.ok) {
        $info.note = '60 秒内没看到 BetterGI 进程（被 UAC 拦下？或启动即退出）'
        Write-Line "✗ $($info.note)"
    } else {
        Write-Line "→ $($info.note)"
    }
    $script:startInfo = $info
}

# 启动并等游戏窗口出现（-StartGame 与「已经是目标值但要求启动」两处共用）。
# 同样只用 $script:startOk / $script:startNote 回传，绝不 return 对象。
$script:startOk = $false
$script:startNote = ''
function Invoke-StartGame {
    $script:startOk = $false
    if ($DirectStart) {
        if (-not $result.gameExe) {
            $script:startNote = '找不到 YuanShen.exe，无法直启'
            Write-Line "✗ $($script:startNote)"
            return
        }
        Start-Process -FilePath $result.gameExe | Out-Null
        Write-Line "→ 已直启游戏：$($result.gameExe)"
    } else {
        $bgiExe = Join-Path $Root 'BetterGI.exe'
        if (Test-Path -LiteralPath $bgiExe) {
            Start-BetterGI $bgiExe
            $result.start = $script:startInfo
            if (-not $script:startInfo.ok) {
                $script:startNote = $script:startInfo.note
                return
            }
            if ($script:startInfo.usedTask) {
                Write-Line '  （已走按需计划任务：任务计划服务负责提权，没有 UAC 弹窗，适合无人值守）'
            }
        } elseif ($result.gameExe) {
            Start-Process -FilePath $result.gameExe | Out-Null
            Write-Line "→ BetterGI.exe 不存在，改为直启游戏：$($result.gameExe)"
        } else {
            $script:startNote = '既没有 BetterGI.exe 也没有 YuanShen.exe'
            Write-Line "✗ $($script:startNote)"
            return
        }
    }
    $deadline = (Get-Date).AddSeconds($WaitSeconds)
    $win = $null
    while ((Get-Date) -lt $deadline) {
        $g = Get-Procs 'YuanShen' | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
        if ($g) { $win = $g; break }
        Start-Sleep -Milliseconds 1500
    }
    if (-not $win) {
        $script:startNote = "等了 $WaitSeconds 秒仍没等到游戏窗口"
        Write-Line "✗ $($script:startNote)"
        return
    }
    Write-Line "→ 游戏窗口已出现（pid $($win.Id)），等 6 秒让它把窗口尺寸落定…"
    Start-Sleep -Seconds 6
    $script:startOk = $true
}

function Test-GameWindow {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class BgiSetResWin {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
}
'@ -ErrorAction SilentlyContinue

    $g = Get-Procs 'YuanShen' | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if (-not $g) {
        Write-Line '✗ 游戏没在运行，无法量窗口（先 -StartGame 或手动启动）'
        $result.message = '游戏没在运行，无法复核'
        $script:windowOk = $false
        return
    }
    $rc = New-Object BgiSetResWin+RECT
    [void][BgiSetResWin]::GetClientRect($g.MainWindowHandle, [ref]$rc)
    $rw = $rc.Right - $rc.Left; $rh = $rc.Bottom - $rc.Top
    # 本进程默认不感知 DPI → GetClientRect 返回被虚拟化的逻辑值；必须用窗口自身 DPI 乘回去，
    # 否则会把合格的 1920x1080 误判成 1280x720（2026-10-17 实测踩到，见 bgi-doctor.ps1 同款注释）
    $dpi = [BgiSetResWin]::GetDpiForWindow($g.MainWindowHandle)
    $w = $rw; $h = $rh
    if ($dpi -gt 96) { $w = [int][math]::Round($rw * $dpi / 96); $h = [int][math]::Round($rh * $dpi / 96) }
    $ratio = if ($h -gt 0) { [math]::Round($w / $h, 4) } else { 0 }
    $is169 = ([math]::Abs($ratio - 1.7778) -lt 0.02)
    $atLeast = ($w -ge 1920 -and $h -ge 1080)
    $min = [BgiSetResWin]::IsIconic($g.MainWindowHandle)
    $result.window = [ordered]@{
        pid = $g.Id; rawWidth = $rw; rawHeight = $rh; dpi = $dpi
        width = $w; height = $h; ratio = $ratio
        is169 = $is169; atLeast1080p = $atLeast; minimized = $min
    }
    Write-Line ("窗口实测：{0}x{1}（原始 {2}x{3}，DPI {4}）16:9={5} ≥1080P={6} 最小化={7}" -f $w, $h, $rw, $rh, $dpi, $is169, $atLeast, $min)
    if ($min) {
        Write-Line '✗ 窗口处于最小化 → 先 bgi-focus-game.ps1 还原'
        $result.message = '窗口处于最小化'
        $script:windowOk = $false
        return
    }
    if (-not ($is169 -and $atLeast)) {
        Write-Line '✗ 复核未通过：窗口仍不是 16:9 且 ≥1920×1080 → 任务会失败。'
        Write-Line '  可能原因：① 游戏没真的退出就写了注册表（退出时回写覆盖）；② 该服/该版本读的不是这个键；③ 显示缩放/多屏影响。'
        Write-Line '  回滚：pwsh -File bgi-set-resolution.ps1 -Restore'
        $result.message = '复核未通过'
        $script:windowOk = $false
        return
    }
    Write-Line '✓ 复核通过：窗口是 16:9 且 ≥1920×1080，可以跑一条龙/秘境/寻路。'
    $script:windowOk = $true
}

# ---------- 进程前置 ----------
$game = Get-Procs 'YuanShen'
$bgi = Get-Procs 'BetterGI'
$result.processes.game = ($game.Count -gt 0)
$result.processes.gamePids = @($game | ForEach-Object { $_.Id })
$result.processes.bettergi = ($bgi.Count -gt 0)
$result.processes.bettergiPids = @($bgi | ForEach-Object { $_.Id })

$result.gameExe = Resolve-GameExe
$result.dpiOverride = Get-DpiOverride $result.gameExe
$before = Get-RegState
$result.current = $before

$isTarget = ($before.width -eq $Width -and $before.height -eq $Height -and $before.fullscreen -eq $Fullscreen)

Write-Line '── 原神窗口分辨率 ──'
if (-not $before.exists) {
    Write-Line "✗ 注册表键不存在：$RegKey（游戏至少启动过一次才会有）"
    $result.message = "注册表键不存在：$RegKey"
    if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
    exit 1
}
$curText = if ($null -eq $before.width) { '（缺少 Screenmanager 值）' } else { "$($before.width)x$($before.height) " + $(if ($before.fullscreen -eq 0) { '窗口化' } else { '全屏' }) }
Write-Line "注册表当前：$curText"
Write-Line ("目标      ：{0}x{1} {2}" -f $Width, $Height, $(if ($Fullscreen -eq 0) { '窗口化' } else { '全屏' }))
Write-Line ("进程      ：原神={0}{1}  BetterGI={2}{3}" -f $result.processes.game, $(if ($result.processes.game) { " (pid $($result.processes.gamePids -join ','))" } else { '' }), $result.processes.bettergi, $(if ($result.processes.bettergi) { " (pid $($result.processes.bettergiPids -join ','))" } else { '' }))
if ($result.gameExe) {
    Write-Line ("游戏 exe  ：{0}" -f $result.gameExe)
    if ($result.dpiOverride.hasHighDpiAware) { Write-Line "DPI 覆盖  ：已设 HIGHDPIAWARE（2560×1600@150% 下必需，否则游戏会被压到 1280×720）" }
    else { Write-Line "DPI 覆盖  ：未设 HIGHDPIAWARE（-Apply 会补上）" }
} else {
    Write-Line '游戏 exe  ：未找到 YuanShen.exe（可用 -InstallPath 指定）'
}

# ---------- 回滚 ----------
if ($Restore) {
    $result.action = 'restore'
    if (-not $StateDir) { $StateDir = Join-Path $env:USERPROFILE '.dsh\game-daily\state' }
    $backupFile = Join-Path $StateDir 'bgi-resolution-backup.json'
    if (-not (Test-Path -LiteralPath $backupFile)) {
        Write-Line "✗ 没有可回滚的备份：$backupFile"
        $result.message = '没有可回滚的备份'
        if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
        exit 1
    }
    if ($result.processes.game -or $result.processes.bettergi) {
        Write-Line '✗ 游戏或 BetterGI 仍在运行 → 先关掉再回滚（运行中改注册表会被回写覆盖）'
        $result.message = '游戏或 BetterGI 仍在运行'
        if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
        exit 1
    }
    $b = Get-Content -LiteralPath $backupFile -Raw -Encoding UTF8 | ConvertFrom-Json
    try {
        if ($null -ne $b.values.width) { Set-ItemProperty -LiteralPath $RegKey -Name $script:VW -Value ([int]$b.values.width) -Type DWord -ErrorAction Stop }
        if ($null -ne $b.values.height) { Set-ItemProperty -LiteralPath $RegKey -Name $script:VH -Value ([int]$b.values.height) -Type DWord -ErrorAction Stop }
        if ($null -ne $b.values.fullscreen) { Set-ItemProperty -LiteralPath $RegKey -Name $script:VF -Value ([int]$b.values.fullscreen) -Type DWord -ErrorAction Stop }
        if ($null -ne $b.dpiOverride.value -and $result.gameExe) {
            New-ItemProperty -Path $script:Layers -Name $result.gameExe -Value ([string]$b.dpiOverride.value) -PropertyType String -Force | Out-Null
        } elseif ($null -eq $b.dpiOverride.value -and $result.gameExe -and $result.dpiOverride.hasHighDpiAware) {
            Remove-ItemProperty -Path $script:Layers -Name $result.gameExe -ErrorAction SilentlyContinue
        }
    } catch {
        Write-Line "✗ 回滚失败：$($_.Exception.Message)"
        $result.message = "回滚失败：$($_.Exception.Message)"
        if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
        exit 2
    }
    $after = Get-RegState
    $result.current = $after
    $result.changed = $true
    $result.backupPath = $backupFile
    Write-Line ("✓ 已回滚到 {0}x{1} {2}" -f $after.width, $after.height, $(if ($after.fullscreen -eq 0) { '窗口化' } else { '全屏' }))
    $result.ok = $true
    $result.message = '已回滚'
    if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
    exit 0
}

# ---------- 只读预览 ----------
if (-not $Apply) {
    $result.action = 'inspect'
    if ($isTarget) {
        Write-Line '✓ 已经是目标值，不需要改。'
        if (-not $result.dpiOverride.hasHighDpiAware -and $result.gameExe) { Write-Line 'ℹ 但缺 HIGHDPIAWARE DPI 覆盖，建议 -Apply 补上（否则游戏可能被压到 1280×720）。' }
        if ($StartGame) {
            Invoke-StartGame
            if (-not $script:startOk) {
                $result.message = $script:startNote
                if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
                exit 2
            }
        }
        if ($Verify) {
            Test-GameWindow
            if (-not $script:windowOk) {
                if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
                exit 2
            }
            $result.ok = $true
            $result.message = '注册表是目标值且窗口复核通过'
            if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
            exit 0
        }
        $result.ok = $true
        $result.message = '已经是目标值'
        if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
        exit 0
    }
    if ($Verify) { Test-GameWindow }
    Write-Line ''
    Write-Line '✗ 不是 BetterGI 能用的分辨率：一条龙里的合成树脂/自动秘境/每日奖励/自动采集会报'
    Write-Line '  [ERR] 游戏窗口分辨率不是 16:9 ！当前分辨率为 2560x1600 , 非 16:9 分辨率的游戏无法正常使用""功能 !'
    Write-Line ''
    Write-Line '修复（游戏与 BetterGI 必须先退出）：'
    Write-Line '  pwsh -File bgi-close.ps1 -Target both'
    Write-Line ("  pwsh -File bgi-set-resolution.ps1 -Apply -StartGame -Verify" + $(if ($Fullscreen -ne 0) { " -Width $Width -Height $Height -Fullscreen $Fullscreen" } else { '' }))
    $result.message = '不是目标值，需要 -Apply'
    if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
    exit 1
}

# ---------- 写入 ----------
$result.action = 'apply'
if ($result.processes.game -or $result.processes.bettergi) {
    Write-Line '✗ 游戏或 BetterGI 仍在运行 → 先关掉（运行中写注册表会被游戏退出时回写覆盖）。'
    Write-Line '  pwsh -File bgi-close.ps1 -Target both'
    $result.message = '游戏或 BetterGI 仍在运行'
    if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
    exit 1
}

if (-not $StateDir) { $StateDir = Join-Path $env:USERPROFILE '.dsh\game-daily\state' }
if (-not (Test-Path -LiteralPath $StateDir)) { New-Item -ItemType Directory -Path $StateDir -Force | Out-Null }
$backupFile = Join-Path $StateDir 'bgi-resolution-backup.json'
$backup = [ordered]@{
    createdAt   = (Get-Date).ToString('o')
    regKey      = $RegKey
    values      = [ordered]@{ width = $before.width; height = $before.height; fullscreen = $before.fullscreen }
    dpiOverride = [ordered]@{ name = $result.gameExe; value = $result.dpiOverride.value }
}
$backup | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $backupFile -Encoding UTF8
$result.backupPath = $backupFile
Write-Line "备份已写：$backupFile（回滚：-Restore）"

try {
    Set-RegState $Width $Height $Fullscreen
} catch {
    Write-Line "✗ 写注册表失败：$($_.Exception.Message)"
    $result.message = "写注册表失败：$($_.Exception.Message)"
    if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
    exit 2
}

if ($result.gameExe -and -not $result.dpiOverride.hasHighDpiAware -and (Test-Path -LiteralPath $script:Layers)) {
    try {
        New-ItemProperty -Path $script:Layers -Name $result.gameExe -Value '~ HIGHDPIAWARE' -PropertyType String -Force | Out-Null
        $result.dpiOverride.added = $true
        $result.dpiOverride.value = '~ HIGHDPIAWARE'
        $result.dpiOverride.hasHighDpiAware = $true
        Write-Line '✓ 已补 HIGHDPIAWARE DPI 覆盖（下次启动游戏生效）'
    } catch {
        Write-Line "⚠ 补 DPI 覆盖失败：$($_.Exception.Message)"
    }
}

$after = Get-RegState
$result.current = $after
$result.changed = $true
if ($after.width -ne $Width -or $after.height -ne $Height -or $after.fullscreen -ne $Fullscreen) {
    Write-Line ("✗ 写入后回读不一致：{0}x{1} fullscreen={2}" -f $after.width, $after.height, $after.fullscreen)
    $result.message = '回读不一致'
    if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
    exit 2
}
Write-Line ("✓ 已写入并回读一致：{0}x{1} {2}" -f $after.width, $after.height, $(if ($after.fullscreen -eq 0) { '窗口化' } else { '全屏' }))

# ---------- 启动并复核 ----------
$needWindowCheck = [bool]$Verify
if ($StartGame) {
    Invoke-StartGame
    if (-not $script:startOk) {
        $result.message = $script:startNote
        if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
        exit 2
    }
    $needWindowCheck = $true
}

if ($needWindowCheck) {
    Test-GameWindow
    if (-not $script:windowOk) {
        if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
        exit 2
    }
}

$result.ok = $true
$result.message = if ($result.message) { $result.message } else { '已达成目标分辨率' }
if ($Json) { $result | ConvertTo-Json -Depth 8 -Compress }
exit 0
