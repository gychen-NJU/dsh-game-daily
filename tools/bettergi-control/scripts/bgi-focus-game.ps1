<#
.SYNOPSIS
    把原神窗口从最小化还原并切到前台（采集/秘境等自动化跑之前的必要前置）。
.DESCRIPTION
    为什么需要它：客户端模式的截图器只能截"可见且在前台"的游戏窗口——
    最小化时日志会出现「游戏窗口不能最小化」、被别的窗口挡住时会打
    `当前获取焦点的窗口为: X，不是原神，暂停`。所以「说一句就采集」的最后一环
    就是：先把游戏窗口还原并拉到前台，再启动 BetterGI。

    做法（按成功率从低到高逐级尝试）：
      ① 若最小化 → ShowWindow(SW_RESTORE)
      ② BringWindowToTop + SetForegroundWindow
      ③ 仍不在前台 → AttachThreadInput 附加当前前台线程后再 SetForegroundWindow（经典绕开前台锁）
      ④ 再不行 → 模拟一次 ALT 轻敲解锁前台限制后重试
    最后回读真实的前台窗口与客户区尺寸，如实报告成功与否。
.PARAMETER ProcessName
    游戏进程名，默认 YuanShen（国服本体）
.PARAMETER Json
    输出机器可读 JSON
.PARAMETER NoFocus
    只还原（取消最小化），不抢前台
.EXAMPLE
    pwsh -File bgi-focus-game.ps1            # 还原 + 置前 + 报告窗口状态
    pwsh -File bgi-focus-game.ps1 -Json     # 机器可读
.NOTES
    退出码：0=已在前台或已成功拉到前台；1=未能置前（但可能已还原）；2=前置不满足（游戏未运行/无窗口）。
    注意：本脚本会改变你当前的焦点（把原神提到最前），这是自动化跑起来的必要副作用。
    UTF-8 带 BOM（PS 5.1）。
#>
[CmdletBinding()]
param(
    [string]$ProcessName = 'YuanShen',
    [switch]$Json,
    [switch]$NoFocus
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$steps = New-Object System.Collections.ArrayList
function Note([string]$m) { [void]$steps.Add($m) }

if (-not ('BgiAgentFocusUtil' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class BgiAgentFocusUtil {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    public const int SW_RESTORE = 9;
    public const byte VK_MENU = 0x12;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public static string WindowTitle(IntPtr hWnd) {
        var sb = new StringBuilder(512);
        GetWindowText(hWnd, sb, sb.Capacity);
        return sb.ToString();
    }
    public static uint ForegroundPid() {
        uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid); return pid;
    }
    public static bool ForceForeground(IntPtr hWnd) {
        if (SetForegroundWindow(hWnd)) return true;
        // ② 置顶翻转：TOPMOST 再取消，常能骗过前台锁
        try {
            SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            SetWindowPos(hWnd, HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
            if (SetForegroundWindow(hWnd)) return true;
        } catch { }
        uint fgPid = ForegroundPid();
        uint fgThread = GetWindowThreadProcessId(GetForegroundWindow(), out fgPid);
        uint myThread = GetCurrentThreadId();
        bool attached = false;
        try {
            // ③ 附加到当前前台线程后再抢
            if (fgThread != 0 && fgThread != myThread) attached = AttachThreadInput(fgThread, myThread, true);
            BringWindowToTop(hWnd);
            if (SetForegroundWindow(hWnd)) return true;
            // ④ 轻敲 ALT 解锁前台限制
            keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
            keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
            return SetForegroundWindow(hWnd);
        } finally {
            if (attached) AttachThreadInput(fgThread, myThread, false);
        }
    }
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);
    public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    public static readonly IntPtr HWND_NOTOPMOST = new IntPtr(-2);
    public const uint SWP_NOMOVE = 0x0002;
    public const uint SWP_NOSIZE = 0x0001;
    public const uint SWP_SHOWWINDOW = 0x0040;
}
'@ -ErrorAction Stop
}

function Get-WindowSnapshot {
    param([IntPtr]$Hwnd)
    $r = New-Object BgiAgentFocusUtil+RECT
    [void][BgiAgentFocusUtil]::GetClientRect($Hwnd, [ref]$r)
    $w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top
            # 本进程默认**不感知 DPI** → GetClientRect 返回被虚拟化的逻辑值（如 150% 缩放下 = 物理/1.5）
            # 必须用窗口自身 DPI 乘回去，否则会把合格的 1920x1080 误判成 1280x720（2026-10-17 实测踩到）
            $dpi = [BgiAgentFocusUtil]::GetDpiForWindow($Hwnd)
            if ($dpi -gt 96) { $w = [int][math]::Round($w * $dpi / 96); $h = [int][math]::Round($h * $dpi / 96) }
    $ratio = if ($h -gt 0) { [math]::Round($w / $h, 4) } else { 0 }
    return [ordered]@{
        clientWidth  = $w
        clientHeight = $h
        is169        = ([math]::Abs($ratio - 1.7778) -lt 0.02)
        atLeast1080p = ($w -ge 1920 -and $h -ge 1080)
        minimized    = [BgiAgentFocusUtil]::IsIconic($Hwnd)
    }
}

$result = [ordered]@{
    processName = $ProcessName
    gameRunning = $false
    pid         = $null
    title       = ''
    focused     = $false
    restored    = $false
    window      = $null
    foregroundTitle = ''
    steps       = @()
    ok          = $false
}

$proc = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue) |
    Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1

if (-not $proc) {
    $any = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
    if ($any.Count -eq 0) {
        Note "未发现 $ProcessName 进程"
        $result.blocker = "$ProcessName 未运行——先用 bgi-run.ps1 -Mode start 启动"
    } else {
        Note "发现 $ProcessName (PID $($any[0].Id)) 但没有可用的主窗口（可能仍在启动，或已最小化到托盘）"
        $result.blocker = "$ProcessName 在运行但没有可用窗口，稍后重试"
    }
    $result.steps = @($steps)
    if ($Json) { $result | ConvertTo-Json -Depth 6 } else { "✗ $($result.blocker)"; $steps | ForEach-Object { "  $_" } }
    exit 2
}

$result.gameRunning = $true
$result.pid = $proc.Id
$result.title = $proc.MainWindowTitle
$hwnd = $proc.MainWindowHandle

$before = Get-WindowSnapshot -Hwnd $hwnd
$fgPidBefore = [BgiAgentFocusUtil]::ForegroundPid()
$alreadyFocused = ($fgPidBefore -eq $proc.Id) -and (-not $before.minimized)
Note ("初始：最小化={0} 前台={1} 客户区={2}x{3}" -f $before.minimized, ($fgPidBefore -eq $proc.Id), $before.clientWidth, $before.clientHeight)

if (-not $alreadyFocused) {
    # 首选 SwitchToThisWindow：实测在原神上「还原 + 置前」一次到位
    # （ShowWindow(SW_RESTORE) / SetWindowPlacement / ShowWindowAsync 对原神窗口全部无效，2026-10-16 实测）
    if (-not $NoFocus) {
        [BgiAgentFocusUtil]::SwitchToThisWindow($hwnd, $true)
        Start-Sleep -Milliseconds 900
        $afterSwitch = Get-WindowSnapshot -Hwnd $hwnd
        $fgPidSwitch = [BgiAgentFocusUtil]::ForegroundPid()
        Note ("SwitchToThisWindow：最小化={0} 前台={1} 客户区={2}x{3}" -f $afterSwitch.minimized, ($fgPidSwitch -eq $proc.Id), $afterSwitch.clientWidth, $afterSwitch.clientHeight)
        if (-not $afterSwitch.minimized) { $result.restored = $true }
        if ($fgPidSwitch -eq $proc.Id) { $result.focused = $true }
    }
    if (-not $result.restored) {
        [void][BgiAgentFocusUtil]::ShowWindow($hwnd, [BgiAgentFocusUtil]::SW_RESTORE)
        Start-Sleep -Milliseconds 400
        if (-not [BgiAgentFocusUtil]::IsIconic($hwnd)) { $result.restored = $true; Note "ShowWindow(SW_RESTORE) 已还原" }
        else { Note "ShowWindow(SW_RESTORE) 无效（原神窗口不吃这一套）" }
    }
    if (-not $result.focused -and -not $NoFocus) {
        $ok = [BgiAgentFocusUtil]::ForceForeground($hwnd)
        Start-Sleep -Milliseconds 600
        $fgPidAfter = [BgiAgentFocusUtil]::ForegroundPid()
        $result.focused = ($fgPidAfter -eq $proc.Id)
        Note ("置前兜底（SetForegroundWindow 系列）：API返回={0} 实际前台={1}" -f $ok, $result.focused)
    }
    if ($NoFocus) { Note "(-NoFocus) 跳过置前" }
} else {
    $result.focused = $true
    Note "本来就在前台，无需动作"
}

$fg = [BgiAgentFocusUtil]::GetForegroundWindow()
$result.foregroundTitle = [BgiAgentFocusUtil]::WindowTitle($fg)
$result.window = Get-WindowSnapshot -Hwnd $hwnd
$result.ok = ($result.focused -or $NoFocus) -and (-not $result.window.minimized)
# "可跑自动化"= 可见 + 在前台 + 16:9 且 ≥1920x1080（BetterGI 对小地图/秘境识别的硬要求）
$result.ready = $result.focused -and (-not $result.window.minimized) -and $result.window.is169 -and $result.window.atLeast1080p
$result.steps = @($steps)

if ($Json) {
    $result | ConvertTo-Json -Depth 6
} else {
    "=== 原神窗口就绪检查 ==="
    "进程        : $ProcessName PID $($result.pid)  标题=$($result.title)"
    "客户区      : $($result.window.clientWidth)x$($result.window.clientHeight)  16:9=$($result.window.is169)  ≥1080P=$($result.window.atLeast1080p)"
    "最小化      : $($result.window.minimized)"
    "在前台      : $($result.focused)   当前前台窗口=$($result.foregroundTitle)"
    "过程        :"
    $steps | ForEach-Object { "  - $_" }
    if ($result.ready) {
        "✓ 可以开始跑自动化（可见、在前台、1920×1080 的 16:9 窗口）"
    } elseif ($result.window.minimized) {
        "✗ 仍处于最小化——自动化会失败，请手动点开游戏窗口"
    } elseif (-not $result.focused) {
        "⚠ 窗口已可见但未取得前台（Windows 前台锁）——跑之前请手动点一下原神窗口，或再执行一次本脚本"
    } elseif (-not $result.window.is169) {
        "✗ 窗口不是 16:9（$($result.window.clientWidth)x$($result.window.clientHeight)）——BetterGI 要求 16:9，请在游戏设置里改"
    } else {
        "✗ 分辨率不足：当前 $($result.window.clientWidth)x$($result.window.clientHeight)，采集/秘境需要 ≥1920x1080 的窗口化 16:9；可在游戏「设置→图像」里调，或关掉游戏后用注册表法批量设置"
    }
}

if ($result.ready) { exit 0 }
if ($result.window.minimized) { exit 2 }
exit 1
