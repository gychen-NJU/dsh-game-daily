<#
.SYNOPSIS
    BetterGI 开跑前体检：一次性审完"现在到底能不能跑通采集/秘境"，并给出可执行的下一步。
.DESCRIPTION
    为什么需要它：BetterGI 的失败往往是"静默"的——配置组指向的路径文件不存在会直接跳过、
    窗口不达标会让截图失败、少一个晶核会让合成树脂空转。跑之前花 3 秒体检，比事后翻日志便宜得多。

    检查项（全部只读，不启动任何进程、不碰游戏）：
      ① 安装与配置：安装根、config.json 可解析、关键配置项现值
      ② 进程与窗口：BetterGI/原神是否运行；窗口尺寸、16:9、≥1080P、最小化、是否前台 → readyForTask
      ③ 显示可行性：物理分辨率、DPI 缩放、桌面能否容纳 1920x1080 窗口、YuanShen 的 DPI 覆盖
      ④ 资源分辨率：安装包里 GameTask/*/Assets 有哪几套分辨率目录（决定必须用哪种分辨率）
      ⑤ 路线资产：User\AutoPathing 下有多少路径文件
      ⑤b 资产版本门禁：路径文件的 info.bgi_version 是否高于本机版本（**高于就禁止运行**）、JS 脚本的 bgi_version（只是警告）
      ⑥ **配置组完整性**：每个组的每个 Pathing 项目是否真的能在 User\AutoPathing 里找到对应文件
      ⑦ 一条龙配置：列出配置名与任务顺序
      ⑧ 采集闭环件：MCP 服务器文件与 cordis.patch.yml 注册、`_daily_runner.ps1` 包装器
.PARAMETER Root
    BetterGI 安装根，默认 D:\software\BetterGI
.PARAMETER Json
    输出机器可读 JSON
.PARAMETER Material
    额外检查某材料的路线是否已装（例：星螺）
.EXAMPLE
    pwsh -File bgi-doctor.ps1 -Material 星螺
.NOTES
    退出码：0=就绪；1=有警告（能跑但有风险）；2=有阻断（现在跑必失败）。UTF-8 带 BOM（PS 5.1）。
#>
[CmdletBinding()]
param(
    [string]$Root = 'D:\software\BetterGI',
    [switch]$Json,
    [string]$Material = ''
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$blockers = New-Object System.Collections.ArrayList
$warnings = New-Object System.Collections.ArrayList
$notes = New-Object System.Collections.ArrayList
function Block([string]$m) { [void]$blockers.Add($m) }
function Warn([string]$m) { [void]$warnings.Add($m) }
function Note([string]$m) { [void]$notes.Add($m) }

$r = [ordered]@{
    root = $Root
    checkedAt = (Get-Date).ToString('yyyy-MM-dd HH:mm:ss')
    install = [ordered]@{ ok = $false; exeVersion = ''; configParses = $false }
    processes = [ordered]@{ bettergi = $false; bettergiPids = @(); game = $false; gamePids = @() }
    window = $null
    display = [ordered]@{ physicalWidth = 0; physicalHeight = 0; scalePercent = 0; virtualWidth = 0; virtualHeight = 0; canFit1080p = $false; dpiOverride = '' }
    assetResolutions = @()
    routes = [ordered]@{ count = 0; material = $Material; materialCount = 0 }
    groups = @()
    oneDragon = @()
    artifacts = [ordered]@{ mcpServer = $false; mcpRegistered = $false; dailyRunner = $false }
    config = [ordered]@{}
    blockers = @()
    warnings = @()
    notes = @()
}

# ---------- ① 安装与配置 ----------
$exe = Join-Path $Root 'BetterGI.exe'
$cfgPath = Join-Path $Root 'User\config.json'
if (-not (Test-Path -LiteralPath $Root)) { Block "安装根不存在：$Root"; }
elseif (-not (Test-Path -LiteralPath $exe)) { Block "找不到 $exe" }
else {
    $r.install.ok = $true
    $r.install.exeVersion = (Get-Item $exe).VersionInfo.ProductVersion
}
$cfg = $null
if (Test-Path -LiteralPath $cfgPath) {
    try { $cfg = Get-Content -LiteralPath $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json; $r.install.configParses = $true }
    catch { Block "config.json 解析失败：$($_.Exception.Message)" }
} else { Block "找不到 $cfgPath" }

if ($cfg) {
    $pick = $cfg.autoPickConfig
    $dom = $cfg.autoDomainConfig
    $r.config = [ordered]@{
        captureMode     = [string]$cfg.captureMode
        triggerInterval = $cfg.triggerInterval
        pickKey         = [string]$pick.pickKey
        pickEnabled     = [bool]$pick.enabled
        strategyName    = [string]$cfg.autoFightConfig.strategyName
        specifyResinUse = [bool]$dom.specifyResinUse
        condensed       = $dom.condensedResinUseCount
        transient       = $dom.transientResinUseCount
        original        = $dom.originalResinUseCount
        fragile         = $dom.fragileResinUseCount
        installPath     = [string]$cfg.genshinStartConfig.installPath
    }
    if ($r.config.captureMode -notmatch 'BitBlt') { Warn "截图方式=$($r.config.captureMode)（建议 BitBlt）" }
    if ($r.config.pickKey -notin @('F', 'E', 'G', 'L')) { Block "拾取键=$($r.config.pickKey) 不是 E/F/G/L 之一 → 会静默回退按 F，游戏内交互键不一致就会失败" }
    if ([string]::IsNullOrWhiteSpace($r.config.strategyName)) { Warn '自动战斗策略为空 → 自动秘境会被跳过' }
    if (-not $r.config.specifyResinUse) { Warn '秘境树脂是"用尽模式"（会用原粹，且无法排除）' }
}

# ---------- ② 进程与窗口 ----------
$bgi = @(Get-Process -Name 'BetterGI' -ErrorAction SilentlyContinue)
$game = @(Get-Process -Name 'YuanShen' -ErrorAction SilentlyContinue)
$r.processes.bettergi = ($bgi.Count -gt 0); $r.processes.bettergiPids = @($bgi | ForEach-Object { $_.Id })
$r.processes.game = ($game.Count -gt 0); $r.processes.gamePids = @($game | ForEach-Object { $_.Id })

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class BgiDoctorWin {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int c);
    public static uint ForegroundPid() { uint p; GetWindowThreadProcessId(GetForegroundWindow(), out p); return p; }
    public static string ForegroundTitle() { var sb = new StringBuilder(512); GetWindowText(GetForegroundWindow(), sb, sb.Capacity); return sb.ToString(); }
}
'@ -ErrorAction SilentlyContinue

if ($game.Count -gt 0) {
    $gp = $game | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($gp) {
        $rc = New-Object BgiDoctorWin+RECT
        [void][BgiDoctorWin]::GetClientRect($gp.MainWindowHandle, [ref]$rc)
        $w = $rc.Right - $rc.Left; $h = $rc.Bottom - $rc.Top
            # 本进程默认**不感知 DPI** → GetClientRect 返回被虚拟化的逻辑值（如 150% 缩放下 = 物理/1.5）
            # 必须用窗口自身 DPI 乘回去，否则会把合格的 1920x1080 误判成 1280x720（2026-10-17 实测踩到）
            $dpi = [BgiDoctorWin]::GetDpiForWindow($gp.MainWindowHandle)
            if ($dpi -gt 96) { $w = [int][math]::Round($w * $dpi / 96); $h = [int][math]::Round($h * $dpi / 96) }
        $ratio = if ($h -gt 0) { [math]::Round($w / $h, 4) } else { 0 }
        $min = [BgiDoctorWin]::IsIconic($gp.MainWindowHandle)
        $fg = ([BgiDoctorWin]::ForegroundPid() -eq $gp.Id)
        $r.window = [ordered]@{
            pid = $gp.Id; clientWidth = $w; clientHeight = $h
            is169 = ([math]::Abs($ratio - 1.7778) -lt 0.02); atLeast1080p = ($w -ge 1920 -and $h -ge 1080)
            minimized = $min; foreground = $fg; foregroundTitle = [BgiDoctorWin]::ForegroundTitle()
            readyForTask = ((-not $min) -and $fg -and ([math]::Abs($ratio - 1.7778) -lt 0.02) -and ($w -ge 1920 -and $h -ge 1080))
        }
        if ($min) { Block '游戏窗口处于最小化 → 截图会失败（先跑 bgi-focus-game.ps1）' }
        elseif (-not $r.window.is169) { Block "游戏窗口 $w x $h 不是 16:9 → 寻路/秘境会失败；自愈：bgi-set-resolution.ps1 -Apply -StartGame -Verify（先 bgi-close.ps1 -Target both，见 SKILL.md §4-9）" }
        elseif (-not $r.window.atLeast1080p) { Block "游戏窗口 $w x $h 小于 1920x1080 → BetterGI 只有 1080p 识别资源，采集/秘境不可靠（见 display 段）；自愈：bgi-set-resolution.ps1 -Apply -StartGame -Verify" }
        if (-not $fg -and -not $r.window.minimized) { Warn "原神不在前台（当前前台：$($r.window.foregroundTitle)）→ 任务会在第一帧暂停" }
    } else { Warn '原神在运行但没有可用窗口（可能仍在启动）' }
} else {
    Warn '原神未运行 → 触发任务时由 BetterGI 联动启动（约 1-2 分钟）'
}

# ---------- ③ 显示可行性（DPI 缩放是"放不下 1920x1080"的常见原因） ----------
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class BgiDoctorDisp {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct DEVMODE {
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
        public short dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra;
        public int dmFields, dmPositionX, dmPositionY, dmDisplayOrientation, dmDisplayFixedOutput;
        public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
        public short dmLogPixels;
        public int dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
        public int dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight;
    }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern bool EnumDisplaySettings(string dev, int mode, ref DEVMODE dm);
    public static DEVMODE Current() { DEVMODE dm = new DEVMODE(); dm.dmSize = (short)Marshal.SizeOf(typeof(DEVMODE)); EnumDisplaySettings(null, -1, ref dm); return dm; }
}
'@ -ErrorAction SilentlyContinue
try {
    $dm = [BgiDoctorDisp]::Current()
    $scale = if ($dm.dmLogPixels -gt 0) { [math]::Round($dm.dmLogPixels / 96 * 100) } else { 100 }
    $r.display.physicalWidth = $dm.dmPelsWidth
    $r.display.physicalHeight = $dm.dmPelsHeight
    $r.display.scalePercent = $scale
    $r.display.virtualWidth = [math]::Round($dm.dmPelsWidth / ($scale / 100))
    $r.display.virtualHeight = [math]::Round($dm.dmPelsHeight / ($scale / 100))
    # 一个 1920x1080 客户区窗口，加上标题栏/边框约 40px，需要桌面高度 ≥ 1120
    $r.display.canFit1080p = ($r.display.virtualHeight -ge 1120)
    $layers = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'
    $gi = [string]$cfg.genshinStartConfig.installPath
    if ($gi -and (Test-Path -LiteralPath $layers)) {
        $v = (Get-ItemProperty -Path $layers -Name $gi -ErrorAction SilentlyContinue).$gi
        if ($v) { $r.display.dpiOverride = [string]$v; Note "已给原神设置 DPI 覆盖：$v（**下次启动游戏**生效）" }
        else { $r.display.dpiOverride = '' }
    }
    $dpiFixed = ($r.display.dpiOverride -match 'HIGHDPIAWARE')
    if (-not $r.display.canFit1080p) {
        if ($dpiFixed) {
            # 游戏被声明为 DPI 感知后看到的是物理桌面，绕过逻辑桌面的限制 → 降级为警告
            Warn ("屏幕 $($r.display.physicalWidth)x$($r.display.physicalHeight) @ ${scale}% 缩放 → 逻辑桌面 $($r.display.virtualWidth)x$($r.display.virtualHeight) 放不下 1920x1080；" +
                  "但已给原神加 HIGHDPIAWARE 覆盖 → **下次启动游戏**即可选 1920x1080 窗口化。若届时仍不行，把显示缩放改成 100%。")
        } else {
            Block ("屏幕 $($r.display.physicalWidth)x$($r.display.physicalHeight) @ ${scale}% 缩放 → 逻辑桌面只有 $($r.display.virtualWidth)x$($r.display.virtualHeight)，放不下 1920x1080 的窗口（游戏会自己降到 1280x720，BetterGI 因此不可靠）")
            Note '两个解法：① 显示设置里把缩放改成 100%；② 给 YuanShen.exe 加 HIGHDPIAWARE DPI 覆盖（让游戏看到物理桌面），下次启动游戏后即可选 1920x1080 窗口化'
        }
    }
} catch { Warn "显示信息读取失败：$($_.Exception.Message)" }

# ---------- ④ 资源分辨率 ----------
try {
    $gt = Join-Path $Root 'GameTask'
    if (Test-Path -LiteralPath $gt) {
        $resSet = @{}
        Get-ChildItem -LiteralPath $gt -Directory | ForEach-Object {
            $a = Join-Path $_.FullName 'Assets'
            if (Test-Path -LiteralPath $a) {
                Get-ChildItem -LiteralPath $a -Directory | Where-Object { $_.Name -match '^\d+x\d+$' } | ForEach-Object { $resSet[$_.Name] = $true }
            }
        }
        $r.assetResolutions = @($resSet.Keys | Sort-Object)
        Note "安装包识别资源分辨率：$($r.assetResolutions -join ', ')（只有 1080p 说明必须让客户端区域=1920x1080）"
    }
} catch { Warn "资源目录扫描失败：$($_.Exception.Message)" }

# ---------- ⑤ 路线资产 ----------
try {
    $ap = Join-Path $Root 'User\AutoPathing'
    if (Test-Path -LiteralPath $ap) {
        $files = @(Get-ChildItem -LiteralPath $ap -Recurse -File -Filter '*.json' -ErrorAction SilentlyContinue)
        $r.routes.count = $files.Count
        if ($Material) { $r.routes.materialCount = @($files | Where-Object { $_.FullName -like "*$Material*" }).Count }
    }
    if ($r.routes.count -eq 0) { Warn 'User\AutoPathing 下没有任何路径文件 → 采集类任务没有可跑的东西' }
    if ($Material -and $r.routes.materialCount -eq 0) { Warn "没有安装「$Material」的路线（可用 bgi-fetch-route.ps1 / bgi_collect_material 拉取）" }
} catch { Warn "路径目录扫描失败：$($_.Exception.Message)" }

# ---------- ⑤b 资产版本门禁（静默拒跑的一类） ----------
# 源码口径：
#   · 路径文件：PathingTask.cs 比较 info.bgi_version 与当前版本，**高于当前版本就"禁止运行"**（硬拒绝，日志里只有一行 ERR）
#   · JS 脚本：Manifest.Validate 只记一条"脚本可能无法正常工作"的 ERR（不拦）
#   注意 JSON 键名是 snake_case（PathRecorder.JsonOptions = SnakeCaseLower），不是 camelCase。
try {
    $appVer = ''
    $exe = Join-Path $Root 'BetterGI.exe'
    if (Test-Path -LiteralPath $exe) {
        $vi = (Get-Item -LiteralPath $exe).VersionInfo
        $appVer = if ($vi.FileVersion) { $vi.FileVersion } else { $vi.ProductVersion }
        $appVer = ($appVer -replace '\.0$', '')      # 0.66.0.0 → 0.66.0
    }
    $r.appVersion = $appVer

    function ConvertTo-VerParts([string]$v) {
        $core = ($v -split '-')[0]
        $nums = @()
        foreach ($p in ($core -split '\.')) { $n = 0; if ([int]::TryParse($p, [ref]$n)) { $nums += $n } else { $nums += 0 } }
        while ($nums.Count -lt 3) { $nums += 0 }
        return $nums[0..2]
    }
    function Test-NewerThan([string]$candidate, [string]$current) {
        if (-not $candidate -or -not $current) { return $false }
        $a = ConvertTo-VerParts $candidate; $b = ConvertTo-VerParts $current
        for ($i = 0; $i -lt 3; $i++) {
            if ($a[$i] -gt $b[$i]) { return $true }
            if ($a[$i] -lt $b[$i]) { return $false }
        }
        return $false   # 相同版本不算"更高"
    }

    if ($appVer) {
        # 路径文件的硬门禁
        $blockedRoutes = @()
        $checkedRoutes = 0
        $ap2 = Join-Path $Root 'User\AutoPathing'
        if (Test-Path -LiteralPath $ap2) {
            foreach ($f in @(Get-ChildItem -LiteralPath $ap2 -Recurse -File -Filter '*.json' -ErrorAction SilentlyContinue)) {
                try {
                    $j = Get-Content -LiteralPath $f.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
                    $need = $j.info.bgi_version
                    if (-not $need) { $need = $j.info.bgiVersion }   # 兼容 camelCase
                    if ($need) {
                        $checkedRoutes++
                        if (Test-NewerThan $need $appVer) { $blockedRoutes += "$($f.Name)(要求 $need)" }
                    }
                } catch { }
            }
        }
        $r.versionGate = [ordered]@{ app = $appVer; routesChecked = $checkedRoutes; routesBlocked = $blockedRoutes }
        if ($blockedRoutes.Count -gt 0) {
            Block "有 $($blockedRoutes.Count) 个路径文件要求的 BetterGI 版本高于本机 $appVer，**会直接禁止运行**：$($blockedRoutes -join '；')"
        } elseif ($checkedRoutes -gt 0) {
            Note "路径文件版本门禁：$checkedRoutes 个文件都未要求高于本机 $appVer"
        }

        # JS 脚本的软门禁
        $jsWarn = @()
        $jsDir = Join-Path $Root 'User\JsScript'
        if (Test-Path -LiteralPath $jsDir) {
            foreach ($d in @(Get-ChildItem -LiteralPath $jsDir -Directory -ErrorAction SilentlyContinue)) {
                $mf = Join-Path $d.FullName 'manifest.json'
                if (-not (Test-Path -LiteralPath $mf)) { continue }
                try {
                    $m = Get-Content -LiteralPath $mf -Raw -Encoding UTF8 | ConvertFrom-Json
                    if ($m.bgi_version -and (Test-NewerThan $m.bgi_version $appVer)) { $jsWarn += "$($d.Name)(要求 $($m.bgi_version))" }
                } catch { }
            }
        }
        if ($jsWarn.Count -gt 0) { Warn "有 JS 脚本要求的版本高于本机 $appVer（不拦，但可能异常）：$($jsWarn -join '；')" }

        # JS 脚本的**二进制资产完整性**：PNG/ICO 被当文本下载会被 UTF-8 解码写坏（2026-10-16 真踩到，
        # 15 张识别图全炸），而脚本不会报错、只是图样匹配永远失败 → 必须在体检里拦住。
        if (Test-Path -LiteralPath $jsDir) {
            $broken = @()
            $checked = 0
            foreach ($f in @(Get-ChildItem -LiteralPath $jsDir -Recurse -File -ErrorAction SilentlyContinue |
                    Where-Object { $_.Extension -in @('.png', '.ico', '.jpg', '.jpeg') })) {
                try {
                    $fs = [System.IO.File]::Open($f.FullName, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                    $b = New-Object byte[] 4
                    [void]$fs.Read($b, 0, 4); $fs.Dispose()
                    $checked++
                    $isPng = ($b[0] -eq 0x89 -and $b[1] -eq 0x50 -and $b[2] -eq 0x4E -and $b[3] -eq 0x47)
                    $isIco = ($b[0] -eq 0 -and $b[1] -eq 0 -and $b[2] -eq 1 -and $b[3] -eq 0)
                    $isJpg = ($b[0] -eq 0xFF -and $b[1] -eq 0xD8)
                    if (-not ($isPng -or $isIco -or $isJpg)) { $broken += "$($f.Name)(前4字节 $($b -join ','))" }
                } catch { }
            }
            $r.jsAssets = [ordered]@{ checked = $checked; broken = $broken }
            if ($broken.Count -gt 0) {
                Block "有 $($broken.Count) 个 JS 脚本图片资产损坏（图样匹配会永远失败）：$($broken -join '；') → 用 bgi_install_js 带 overwrite 重装"
            } elseif ($checked -gt 0) {
                Note "JS 脚本图片资产：$checked 个魔数全部正常"
            }
        }
    } else {
        Note "未能读到 BetterGI.exe 的版本号，跳过资产版本门禁检查"
    }
} catch { Warn "资产版本门禁检查失败：$($_.Exception.Message)" }

# ---------- ⑥ 配置组完整性（最容易被忽视的静默失败） ----------
try {
    $sg = Join-Path $Root 'User\ScriptGroup'
    $ap = Join-Path $Root 'User\AutoPathing'
    if (Test-Path -LiteralPath $sg) {
        Get-ChildItem -LiteralPath $sg -Filter '*.json' -File | Sort-Object Name | ForEach-Object {
            $g = $null
            try { $g = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
            if (-not $g) { Warn "配置组 $($_.Name) 解析失败"; return }
            $missing = @()
            $disabled = @()
            foreach ($p in @($g.projects)) {
                if ($p.type -eq 'Pathing') {
                    $fp = Join-Path $ap (Join-Path ([string]$p.folderName) ([string]$p.name))
                    if (-not (Test-Path -LiteralPath $fp)) { $missing += "$($p.folderName)\$($p.name)" }
                } elseif ($p.type -eq 'Javascript') {
                    # JS 项目靠 User\JsScript\<folderName>\manifest.json 识别（源码 ScriptProject(folderName) 读它）
                    $mf = Join-Path (Join-Path $Root 'User\JsScript') (Join-Path ([string]$p.folderName) 'manifest.json')
                    if (-not (Test-Path -LiteralPath $mf)) { $missing += "JS:$($p.folderName)\manifest.json" }
                }
                if ([string]$p.status -ne 'Enabled') { $disabled += "$($p.name)(status=$($p.status))" }
            }
            $r.groups += [ordered]@{ name = $g.name; file = $_.Name; projects = @($g.projects).Count; missing = $missing; disabled = $disabled }
            if ($missing.Count -gt 0) { Block "配置组「$($g.name)」有 $($missing.Count) 个项目找不到路径文件（会被静默跳过）：$($missing -join '；')" }
            if ($disabled.Count -gt 0) { Warn "配置组「$($g.name)」有非 Enabled 项目：$($disabled -join '；')" }
        }
    }
} catch { Warn "配置组检查失败：$($_.Exception.Message)" }

# ---------- ⑦ 一条龙配置 ----------
try {
    $od = Join-Path $Root 'User\OneDragon'
    if (Test-Path -LiteralPath $od) {
        Get-ChildItem -LiteralPath $od -Filter '*.json' -File | ForEach-Object {
            $o = $null
            try { $o = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { }
            if ($o) {
                $order = @()
                if ($o.TaskOrder) {
                    foreach ($id in $o.TaskOrder) {
                        $nm = $null
                        if ($o.TaskDefinitions) { $nm = $o.TaskDefinitions.$id }
                        if ($nm) { $order += [string]$nm } else { $order += [string]$id }
                    }
                } elseif ($o.TaskEnabledList) {
                    $order = @($o.TaskEnabledList.PSObject.Properties.Name)
                }
                $r.oneDragon += [ordered]@{ name = $o.Name; file = $_.Name; tasks = $order; completionAction = [string]$o.CompletionAction }
            }
        }
        if ($r.oneDragon.Count -eq 0) { Warn 'User\OneDragon 下没有可用的一条龙配置' }

        # Name 重名检查：命令行 `startOneDragon <名>` 是按 **JSON 里的 Name 字段**做 Ordinal 精确匹配
        # （OneDragonFlowViewModel.cs:552-553 的 ConfigList.FirstOrDefault），重名时命中哪个是不确定的。
        # 注意：$r.oneDragon 里是 [ordered] 字典，Group-Object -Property / Measure-Object -Property 读不到它的键
        # （会得到空分组名 → 干净状态也误报），所以这里手工用哈希表分组。
        $byName = @{}
        foreach ($o in $r.oneDragon) {
            $nm = [string]$o.name
            if (-not $nm) { continue }
            if (-not $byName.ContainsKey($nm)) { $byName[$nm] = @() }
            $byName[$nm] = @($byName[$nm]) + @([string]$o.file)
        }
        foreach ($k in @($byName.Keys)) {
            $fs = @($byName[$k])
            if ($fs.Count -gt 1) {
                Block "一条龙配置 Name 重名：「$k」出现在 $($fs -join '、') —— 命令行 startOneDragon 会不确定地命中其中一个，请改名。"
            }
        }
        # 文件名与 Name 不一致也提示（命令行按 Name，而人在资源管理器里看的是文件名）
        foreach ($o in $r.oneDragon) {
            $base = [System.IO.Path]::GetFileNameWithoutExtension([string]$o.file)
            if ($o.name -and [string]$o.name -ne $base) { Note "一条龙配置「$base.json」的内部 Name 是「$($o.name)」，命令行要用 Name 触发。" }
        }
    }
} catch { Warn "一条龙配置检查失败：$($_.Exception.Message)" }

# ---------- ⑧ 采集闭环件 ----------
try {
    $mcpCandidates = @(
        (Join-Path $env:USERPROFILE '.dsh\game-daily\vendor\bettergi-mcp\bettergi-mcp.mjs'),
        (Join-Path $env:USERPROFILE '.dsh\game-daily\dev\vendor\bettergi-mcp\bettergi-mcp.mjs'),
        (Join-Path $env:USERPROFILE 'dsh-betterGI\tools\bettergi-mcp\bettergi-mcp.mjs')
    )
    if ($env:BETTERGI_MCP) { $mcpCandidates = @($env:BETTERGI_MCP) + $mcpCandidates }
    $mcp = @($mcpCandidates | Where-Object { Test-Path -LiteralPath $_ })[0]
    if (-not $mcp) { $mcp = $mcpCandidates[0] }
    $r.artifacts.mcpServer = (Test-Path -LiteralPath $mcp)
    $patch = Join-Path $env:USERPROFILE '.dsh\profiles\web\cordis.patch.yml'
    if (Test-Path -LiteralPath $patch) {
        $r.artifacts.mcpRegistered = [bool](Select-String -Path $patch -Pattern 'id: bettergi-mcp' -Quiet)
    }
    $r.artifacts.dailyRunner = (Test-Path -LiteralPath (Join-Path $Root '_daily_runner.ps1'))
    if ($r.artifacts.mcpServer -and -not $r.artifacts.mcpRegistered) { Warn 'MCP 服务器存在但未注册到 cordis.patch.yml' }
    if ($r.artifacts.mcpRegistered) { Note 'MCP 已注册（重启 DSH 后工具名形如 mcp__bettergi__*）' }
} catch { }

$r.blockers = @($blockers); $r.warnings = @($warnings); $r.notes = @($notes)

if ($Json) {
    $r | ConvertTo-Json -Depth 8
} else {
    "=== BetterGI 开跑前体检（$($r.checkedAt)）==="
    "安装        : $(if ($r.install.ok) { "✓ $Root  v$($r.install.exeVersion)" } else { '✗ 缺失' })   config 可解析=$($r.install.configParses)"
    "进程        : BetterGI=$(if ($r.processes.bettergi) { "运行中 PID $($r.processes.bettergiPids -join ',')" } else { '未运行' })  原神=$(if ($r.processes.game) { "运行中 PID $($r.processes.gamePids -join ',')" } else { '未运行' })"
    if ($r.window) {
        "游戏窗口    : $($r.window.clientWidth)x$($r.window.clientHeight)  16:9=$($r.window.is169)  ≥1080P=$($r.window.atLeast1080p)  最小化=$($r.window.minimized)  前台=$($r.window.foreground)  → 可跑=$($r.window.readyForTask)"
    }
    "显示        : $($r.display.physicalWidth)x$($r.display.physicalHeight) @ $($r.display.scalePercent)%  → 逻辑桌面 $($r.display.virtualWidth)x$($r.display.virtualHeight)  容纳1080p=$($r.display.canFit1080p)  DPI覆盖='$($r.display.dpiOverride)'"
    "识别资源    : $($r.assetResolutions -join ', ')"
    "路线资产    : $($r.routes.count) 个文件$(if ($Material) { "（含「$Material」$($r.routes.materialCount) 个）" })"
    if ($r.versionGate) { "资产版本    : 本机 $($r.versionGate.app)；路径文件门禁检查 $($r.versionGate.routesChecked) 个，超版本 $($r.versionGate.routesBlocked.Count) 个" }
    if ($r.jsAssets) { "JS 图片资产  : 检查 $($r.jsAssets.checked) 个，损坏 $($r.jsAssets.broken.Count) 个" }
    foreach ($g in $r.groups) { "配置组      : $($g.name)  $($g.projects) 项  缺文件=$($g.missing.Count)  非Enabled=$($g.disabled.Count)" }
    foreach ($o in $r.oneDragon) { "一条龙      : $($o.name)  $(($o.tasks) -join ' → ')  收工动作='$($o.completionAction)'" }
    "闭环件      : MCP服务器=$($r.artifacts.mcpServer)  已注册=$($r.artifacts.mcpRegistered)  包装器=$($r.artifacts.dailyRunner)"
    ""
    if ($r.blockers.Count) { "⛔ 阻断（现在跑必失败）："; $r.blockers | ForEach-Object { "  - $_" } } else { "✓ 无阻断项" }
    if ($r.warnings.Count) { "⚠ 警告（能跑但有风险）："; $r.warnings | ForEach-Object { "  - $_" } }
    if ($r.notes.Count) { "ℹ 说明："; $r.notes | ForEach-Object { "  - $_" } }
    ""
    if ($r.blockers.Count) { "结论：✗ 先处理上面的阻断项再跑" } elseif ($r.warnings.Count) { "结论：⚠ 可以跑，但先看一眼警告" } else { "结论：✓ 就绪，可以开跑" }
}

if ($blockers.Count -gt 0) { exit 2 }
if ($warnings.Count -gt 0) { exit 1 }
exit 0
