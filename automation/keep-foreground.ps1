<#
.SYNOPSIS
  前台守护：原神一旦被别的窗口抢走前台，就在 1 秒内把它拉回来。

.DESCRIPTION
  BetterGI 只有在「前台窗口是原神」时才推进任务，否则会打「不是原神，暂停」。
  暂停时间一长，当前任务就会中断（2026-10-22：chrome 抢前台 199 秒，自动秘境整段失败、
  连锁报「未能返回主界面」）。包装器自带的前台保护最快 60 秒才动一次手，来不及。
  本脚本独立运行，按秒级周期盯着前台窗口，被抢走就立即拉回，并记账到日志。
  退出条件：原神连续 10 分钟不存在 / 到达 -MaxMinutes / 出现停止文件。

.PARAMETER IntervalMs
  检查周期（毫秒），默认 1000。

.PARAMETER MaxMinutes
  最长运行分钟数，默认 150。到点自行退出，避免忘了关。

.PARAMETER GameProcessName
  游戏进程名，默认 YuanShen。

.PARAMETER LogPath
  日志路径，默认与本脚本同目录的 _keep_foreground.log。

.PARAMETER StopFile
  出现该文件即退出，默认与本脚本同目录的 _keep_foreground.stop。

.PARAMETER Once
  只检查并纠正一次就退出（测试用）。

.PARAMETER TestProcessName
  测试用：盯别的进程而不是原神（例如 notepad）。

.PARAMETER Quiet
  不向控制台输出（日志照写）。

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File D:\software\BetterGI\_keep_foreground.ps1 -MaxMinutes 120
#>
[CmdletBinding()]
param(
    [int]$IntervalMs = 1000,
    [int]$MaxMinutes = 150,
    [string]$GameProcessName = 'YuanShen',
    [string]$LogPath = '',
    [string]$StopFile = '',
    [switch]$Once,
    [string]$TestProcessName = '',
    [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $LogPath)  { $LogPath  = Join-Path $Root '_keep_foreground.log' }
if (-not $StopFile) { $StopFile = Join-Path $Root '_keep_foreground.stop' }
# 原神可能被窗口修复链重启：连续这么久看不到游戏窗口才判"游戏已退出"
$NoGameGraceSeconds = 600
if ($TestProcessName) { $GameProcessName = $TestProcessName }

# ---------------------------------------------------------------- Win32
if (-not ('BgiFgWin' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class BgiFgWin
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hWnd, StringBuilder s, int n);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);
    [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    public static List<IntPtr> WindowsOfPid(uint target)
    {
        List<IntPtr> list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr l)
        {
            uint pid;
            GetWindowThreadProcessId(h, out pid);
            if (pid == target && IsWindowVisible(h)) list.Add(h);
            return true;
        }, IntPtr.Zero);
        return list;
    }

    public static string TitleOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(512);
        GetWindowText(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string ClassOf(IntPtr h)
    {
        StringBuilder sb = new StringBuilder(256);
        GetClassName(h, sb, sb.Capacity);
        return sb.ToString();
    }

    public static string TitleOfPid(uint pid)
    {
        try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { return "?"; }
    }

    public static IntPtr Foreground() { return GetForegroundWindow(); }

    public static uint PidOf(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }

    public static long AreaOf(IntPtr h)
    {
        RECT r;
        if (!GetWindowRect(h, out r)) return 0;
        return (long)(r.Right - r.Left) * (long)(r.Bottom - r.Top);
    }

    public static IntPtr PickLargest(uint pid)
    {
        List<IntPtr> ws = WindowsOfPid(pid);
        IntPtr best = IntPtr.Zero;
        long bestArea = 0;
        foreach (IntPtr h in ws)
        {
            long a = AreaOf(h);
            if (a > bestArea) { bestArea = a; best = h; }
        }
        return best;
    }

    public static bool Restore(IntPtr h)
    {
        if (h == IntPtr.Zero) return false;
        if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
        if (Foreground() == h) return true;

        SetForegroundWindow(h);
        if (Foreground() == h) return true;

        // ① AttachThreadInput：绕过前台锁（最常用有效）
        IntPtr fg = Foreground();
        if (fg != IntPtr.Zero)
        {
            uint fgPid = 0;
            uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
            AttachThreadInput(GetCurrentThreadId(), fgThread, true);
            try
            {
                BringWindowToTop(h);
                SetForegroundWindow(h);
            }
            finally
            {
                AttachThreadInput(GetCurrentThreadId(), fgThread, false);
            }
            if (Foreground() == h) return true;
        }

        // ② 模拟一次 Alt 按键，解锁前台权限后再设
        keybd_event(0x12, 0, 0, IntPtr.Zero);
        keybd_event(0x12, 0, 2, IntPtr.Zero);
        SetForegroundWindow(h);
        if (Foreground() == h) return true;

        // ③ 最后手段
        SwitchToThisWindow(h, true);
        return Foreground() == h;
    }
}
'@
}

# ---------------------------------------------------------------- 工具
$script:LogLock = New-Object object
function Write-FgLog {
    param([string]$Text)
    $line = ('[{0}] {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Text)
    try {
        [System.Threading.Monitor]::Enter($script:LogLock)
        [IO.File]::AppendAllText($LogPath, $line + "`r`n", (New-Object System.Text.UTF8Encoding($false)))
    } catch { } finally {
        try { [System.Threading.Monitor]::Exit($script:LogLock) } catch { }
    }
    if (-not $Quiet) { Write-Host $line }
}

function Get-GameWindow {
    $procs = @(Get-Process -Name $GameProcessName -ErrorAction SilentlyContinue)
    if ($procs.Count -eq 0) { return $null }
    $best = $null; $bestArea = 0
    foreach ($p in $procs) {
        $h = [BgiFgWin]::PickLargest([uint32]$p.Id)
        if ($h -ne [IntPtr]::Zero) {
            $a = [BgiFgWin]::AreaOf($h)
            if ($a -gt $bestArea) { $bestArea = $a; $best = $h }
        }
    }
    if ($best -eq $null) { return $null }
    return [pscustomobject]@{
        Hwnd  = $best
        Title = [BgiFgWin]::TitleOf($best)
        Class = [BgiFgWin]::ClassOf($best)
        Area  = $bestArea
    }
}

function Test-GameForeground {
    param($win)
    if (-not $win) { return $false }
    return ([BgiFgWin]::Foreground() -eq $win.Hwnd)
}

function Get-ForegroundInfo {
    $h = [BgiFgWin]::Foreground()
    $pid2 = [BgiFgWin]::PidOf($h)
    return [pscustomobject]@{
        Hwnd  = $h
        Pid   = $pid2
        Name  = [BgiFgWin]::TitleOfPid($pid2)
        Title = [BgiFgWin]::TitleOf($h)
    }
}

# ---------------------------------------------------------------- 主循环
$started = Get-Date
$deadline = $started.AddMinutes($MaxMinutes)
$restores = 0
$misses = 0
Write-FgLog ("=== 前台守护启动（进程={0}, 间隔={1}ms, 最长={2}分钟, 日志={3}）===" -f $GameProcessName, $IntervalMs, $MaxMinutes, $LogPath)

if ($Once) {
    $w = Get-GameWindow
    $fg = Get-ForegroundInfo
    if (-not $w) { Write-FgLog "原神未运行（进程 $GameProcessName 不存在）"; exit 3 }
    Write-FgLog ("目标窗口：{0} [{1}] 面积={2}；当前前台：{3}（{4} / pid {5}）" -f $w.Title, $w.Class, $w.Area, $fg.Title, $fg.Name, $fg.Pid)
    if (Test-GameForeground $w) { Write-FgLog "已在前台，无需处理"; exit 0 }
    $ok = [BgiFgWin]::Restore($w.Hwnd)
    $fg2 = Get-ForegroundInfo
    Write-FgLog ("拉回结果：{0}；当前前台：{1}（{2} / pid {3}）" -f $ok, $fg2.Title, $fg2.Name, $fg2.Pid)
    if ($ok) { exit 0 } else { exit 4 }
}

$aLast = $null
$lastGameSeen = Get-Date
while ($true) {
    if (Test-Path -LiteralPath $StopFile) { Write-FgLog "检测到停止文件，退出"; break }
    if ((Get-Date) -gt $deadline) { Write-FgLog ("到达 -MaxMinutes {0} 分钟，退出" -f $MaxMinutes); break }

    $w = Get-GameWindow
    if (-not $w) {
        $misses++
        if (((Get-Date) - $lastGameSeen).TotalSeconds -ge $NoGameGraceSeconds) {
            Write-FgLog ("原神已退出（连续 {0} 秒未检测到窗口），守护结束" -f $NoGameGraceSeconds)
            break
        }
    } else {
        $misses = 0
        $lastGameSeen = Get-Date
        if (-not (Test-GameForeground $w)) {
            $fg = Get-ForegroundInfo
            $sig = ('{0}|{1}' -f $fg.Pid, $fg.Title)
            $ok = [BgiFgWin]::Restore($w.Hwnd)
            if ($ok) {
                $restores++
                Write-FgLog ("↪ 拉回原神（抢前者：{0} / pid {1} / 标题「{2}」）第 {3} 次" -f $fg.Name, $fg.Pid, $fg.Title, $restores)
            } else {
                Write-FgLog ("⚠ 拉回失败（抢前者：{0} / pid {1} / 标题「{2}」）" -f $fg.Name, $fg.Pid, $fg.Title)
            }
        }
    }

    Start-Sleep -Milliseconds ([Math]::Max(200, $IntervalMs))
}

Write-FgLog ("=== 前台守护结束：共拉回 {0} 次，运行 {1:N1} 分钟 ===" -f $restores, ((Get-Date) - $started).TotalMinutes)
exit 0
