<#
.SYNOPSIS
    Drive March7thAssistant (M7A / March 7th Assistant) for Honkai: Star Rail.

.DESCRIPTION
    Single-file control surface for the M7A command line (m7a.exe).
    M7A does the game-side work; this script only locates the install, runs tasks,
    reads run records / logs, and reports machine-readable JSON.

    Compatibility: Windows PowerShell 5.1 (powershell.exe). No PS7-only syntax.
    Output: exactly one JSON object on stdout, built with ConvertTo-Json -Depth 6 -Compress.
    Failure shape: { "ok": false, "error": "...", "hint": "..." }.

    Actions
      doctor   read-only physical exam: install root + version + m7a.exe --status --json
               + config.yaml whitelist keys + today's log tail + recent runs + blockers
      status   m7a.exe --status --json  (add -Tasks to also run --list --json)
      run      m7a.exe <taskId> --after-finish <mode> --json     (or --detach)
      follow   m7a.exe --follow <run>   (or -FromLog: read logs\runs\<run>.log tail)
      control  m7a.exe --control current pause|resume|stop
      logs     tail of logs\<yyyy-MM-dd>.log, or logs\runs\<run>.log with -Run

    Exit codes (script level)
      0  ok
      1  internal error / unparsable M7A output / spawn failure / bad arguments
      2  M7A not installed, explicit -Root invalid, or a precondition is not met
      For -Action run the m7a.exe exit code is passed through unchanged:
      0 success, 1 task failed, 2 bad args, 3 first run not confirmed, 4 busy,
      5 UAC cancelled, 6 stopped.

    Encoding
      This file MUST stay UTF-8 WITHOUT BOM and pure ASCII. Windows PowerShell 5.1
      decodes BOM-less script files with the ANSI code page, so non-ASCII literals
      would be mangled. Chinese text only ever arrives from M7A output / files and
      is read as UTF-8 (StandardOutputEncoding / Get-Content -Encoding UTF8).

.PARAMETER Action
    doctor | status | run | follow | control | logs
.PARAMETER Task
    M7A task id for -Action run. Common ids: main (full run: daily + power),
    daily, power, routine, divergent, currencywars, universe, fight,
    forgottenhall, purefiction, apocalyptic, redemption, game, app_update.
.PARAMETER Detach
    -Action run: pass --detach instead of --json and return immediately.
.PARAMETER Run
    Run id or "latest" for -Action follow / -Action logs.
.PARAMETER ActionName
    -Action control: pause | resume | stop.
.PARAMETER Lines
    Tail line count for logs / follow -FromLog (default 40).
.PARAMETER TimeoutMinutes
    Max wait for -Action run (default 60).
.PARAMETER TimeoutSeconds
    Max wait for -Action follow (default 300).
.PARAMETER AfterFinish
    Value for --after-finish (default None: never shut down or sleep the machine).
.PARAMETER FromLog
    -Action follow: read logs\runs\<run>.log instead of m7a.exe --follow.
.PARAMETER Tasks
    -Action status: also include m7a.exe --list --json.
.PARAMETER Force
    -Action run: skip the preflight checks (first-run / game path / active run).
.PARAMETER Root
    Explicit M7A install root; overrides discovery (validated, not silently ignored).

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File m7a.ps1 -Action doctor
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File m7a.ps1 -Action status -Tasks
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File m7a.ps1 -Action run -Task main -Detach
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File m7a.ps1 -Action follow -Run latest -TimeoutSeconds 120
.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File m7a.ps1 -Action logs -Lines 60
.NOTES
    File encoding: UTF-8 without BOM, ASCII only (Windows PowerShell 5.1 requirement).
#>
[CmdletBinding()]
param(
    [string]$Action = '',
    [string]$Task = 'main',
    [switch]$Detach,
    [string]$Run = '',
    [string]$ActionName = '',
    [int]$Lines = 40,
    [int]$TimeoutMinutes = 60,
    [int]$TimeoutSeconds = 300,
    [string]$AfterFinish = 'None',
    [switch]$FromLog,
    [switch]$Tasks,
    [switch]$Force,
    [string]$Root = ''
)

$ErrorActionPreference = 'Stop'

# Console output must be UTF-8 so JSON carrying Chinese text is readable by agents.
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
try { $OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }

# ---------------------------------------------------------------- helpers ---

# Write the single JSON line straight to the console stream.
# Do NOT use Write-Output here: everything Invoke-Main emits through the pipeline
# becomes its return value, and '$code = Invoke-Main' would capture the JSON too.
function Write-JsonOut {
    param([Parameter(Mandatory = $true)]$Data)
    $json = $Data | ConvertTo-Json -Depth 6 -Compress
    $writer = [Console]::Out
    $writer.WriteLine($json)
    $writer.Flush()
}

function New-Err {
    param(
        [Parameter(Mandatory = $true)][string]$Code,
        [string]$Hint = '',
        $Extra = $null
    )
    $obj = [ordered]@{ ok = $false; error = $Code }
    if ($Hint) { $obj.hint = $Hint }
    if ($Extra) {
        foreach ($key in $Extra.Keys) { $obj[$key] = $Extra[$key] }
    }
    return $obj
}

# Extract the first usable JSON value from mixed M7A output.
# Strategy: last standalone JSON line first (run records are the last line),
# then the first '{'/'[' up to the matching last '}'/']'.
function Get-JsonFromText {
    param([string]$Text)
    if ([string]::IsNullOrWhiteSpace($Text)) { return $null }
    $lines = @($Text -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 })
    for ($i = $lines.Count - 1; $i -ge 0; $i--) {
        $line = $lines[$i].Trim()
        if ($line.StartsWith('{') -or $line.StartsWith('[')) {
            try { return ($line | ConvertFrom-Json) } catch { }
        }
    }
    $objAt = $Text.IndexOf('{')
    $arrAt = $Text.IndexOf('[')
    $start = -1
    $close = '}'
    if ($objAt -ge 0 -and ($arrAt -lt 0 -or $objAt -lt $arrAt)) {
        $start = $objAt
        $close = '}'
    } elseif ($arrAt -ge 0) {
        $start = $arrAt
        $close = ']'
    }
    if ($start -lt 0) { return $null }
    $end = $Text.LastIndexOf($close)
    if ($end -le $start) { return $null }
    try { return ($Text.Substring($start, $end - $start + 1) | ConvertFrom-Json) } catch { return $null }
}

function ConvertTo-ArgumentString {
    param([string[]]$ArgList)
    $parts = @()
    foreach ($arg in $ArgList) {
        if ($null -eq $arg) { continue }
        $s = [string]$arg
        if ($s -match '[\s"]') {
            $escaped = [regex]::Replace($s, '(\\*)"', '$1$1\"')
            $parts += ('"' + $escaped + '"')
        } else {
            $parts += $s
        }
    }
    return ($parts -join ' ')
}

# Start m7a.exe, capture UTF-8 stdout/stderr, enforce a timeout, return a plain result.
# -KillOnTimeout is for read-only helpers (--follow / --status / --control): when the
# local wait expires the helper is terminated. A real task run is NEVER killed here:
# killing mid-automation can leave the game in a bad state, so the caller reports the
# still-running pid and tells the agent to poll with status / follow instead.
function Invoke-M7aProcess {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$ArgList = @(),
        [int]$TimeoutSeconds = 600,
        [string]$WorkingDir = '',
        [switch]$KillOnTimeout
    )
    $result = [ordered]@{
        ok       = $false
        code     = $null
        timedOut = $false
        pid      = 0
        stdout   = ''
        stderr   = ''
        error    = ''
    }
    if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
        $result.error = 'M7A_EXE_MISSING'
        return $result
    }
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $Exe
    $psi.Arguments = ConvertTo-ArgumentString $ArgList
    if ($WorkingDir) { $psi.WorkingDirectory = $WorkingDir }
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    $psi.StandardOutputEncoding = $utf8
    $psi.StandardErrorEncoding = $utf8
    try {
        $psi.EnvironmentVariables['PYTHONIOENCODING'] = 'utf-8'
        $psi.EnvironmentVariables['PYTHONUTF8'] = '1'
    } catch { }

    $proc = $null
    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
    } catch [System.ComponentModel.Win32Exception] {
        $ex = $_.Exception
        $result.code = $ex.NativeErrorCode
        if ($ex.NativeErrorCode -eq 740) {
            $result.error = 'M7A_ELEVATION_REQUIRED'
        } else {
            $result.error = 'M7A_SPAWN_FAILED: ' + $ex.Message
        }
        return $result
    } catch {
        $result.error = 'M7A_SPAWN_FAILED: ' + $_.Exception.Message
        return $result
    }

    $outTask = $proc.StandardOutput.ReadToEndAsync()
    $errTask = $proc.StandardError.ReadToEndAsync()
    try { $result.pid = $proc.Id } catch { }
    $waitMs = [Math]::Max(1000, $TimeoutSeconds * 1000)
    if (-not $proc.WaitForExit($waitMs)) {
        $result.timedOut = $true
        if ($KillOnTimeout) {
            # Direct Kill() first: reliable and immediate. taskkill /T then sweeps the
            # whole tree (M7A can spawn helpers), which matters when it is a real task.
            try { if (-not $proc.HasExited) { $proc.Kill() } } catch { }
            try { & taskkill.exe /PID $proc.Id /T /F *> $null } catch { }
            try { $proc.WaitForExit(5000) | Out-Null } catch { }
        } else {
            # Leave the child alive with its stdio pipes; the OS keeps the game task
            # going and we simply stop waiting. The streams are detached by exit.
            $result.error = ''
        }
    }
    $readWait = 5000
    if ($result.timedOut -and -not $KillOnTimeout) { $readWait = 200 }
    try {
        if ($outTask.Wait($readWait)) { $result.stdout = $outTask.Result } else { $result.stdout = '' }
    } catch { $result.stdout = '' }
    try {
        if ($errTask.Wait($readWait)) { $result.stderr = $errTask.Result } else { $result.stderr = '' }
    } catch { $result.stderr = '' }
    try {
        if ($proc.HasExited) { $result.code = $proc.ExitCode }
    } catch { }
    $result.ok = ($result.code -eq 0 -and -not $result.timedOut -and -not $result.error)
    return $result
}

# Read a text file that another process may still be writing (task output redirect).
function Read-TextFileShared {
    param([string]$File)
    if (-not $File) { return '' }
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return '' }
    try {
        $fs = [System.IO.File]::Open($File, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        try {
            $sr = New-Object System.IO.StreamReader($fs, (New-Object System.Text.UTF8Encoding($false)))
            $text = $sr.ReadToEnd()
            $sr.Close()
            return $text
        } finally {
            try { $fs.Close() } catch { }
        }
    } catch { return '' }
}

# Run m7a.exe with stdout/stderr redirected to temp FILES instead of pipes.
# Why files + Start-Process: PowerShell 5.1 keeps a task call blocked while an async
# pipe read is pending on a live child, and a cmd.exe wrapper would inherit our stdout
# handle, so the caller's own stream would never see EOF. Start-Process with file
# redirection gives the child fresh file handles, so the wait can time out, leave the
# task running, and still return promptly with the partial output.
function Invoke-M7aTaskToFile {
    param(
        [Parameter(Mandatory = $true)][string]$Exe,
        [string[]]$ArgList = @(),
        [int]$TimeoutSeconds = 3600,
        [string]$WorkingDir = ''
    )
    $result = [ordered]@{
        ok       = $false
        code     = $null
        timedOut = $false
        pid      = 0
        stdout   = ''
        stderr   = ''
        error    = ''
    }
    if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) {
        $result.error = 'M7A_EXE_MISSING'
        return $result
    }
    $dir = Join-Path $env:TEMP ('m7a-task-' + [guid]::NewGuid().ToString('N'))
    try { New-Item -ItemType Directory -Force -Path $dir | Out-Null } catch { }
    $outFile = Join-Path $dir 'stdout.txt'
    $errFile = Join-Path $dir 'stderr.txt'
    $argStr = ConvertTo-ArgumentString $ArgList

    # Child inherits this process env; force UTF-8 so the redirected text stays UTF-8.
    $oldIo = $env:PYTHONIOENCODING
    $oldUtf8 = $env:PYTHONUTF8
    $env:PYTHONIOENCODING = 'utf-8'
    $env:PYTHONUTF8 = '1'
    $proc = $null
    try {
        $startArgs = @{
            FilePath               = $Exe
            ArgumentList           = $argStr
            RedirectStandardOutput = $outFile
            RedirectStandardError  = $errFile
            NoNewWindow            = $true
            PassThru               = $true
        }
        if ($WorkingDir) { $startArgs['WorkingDirectory'] = $WorkingDir }
        $proc = Start-Process @startArgs
    } catch {
        $msg = $_.Exception.Message
        if ($msg -match 'elevation|740') { $result.error = 'M7A_ELEVATION_REQUIRED' }
        else { $result.error = 'M7A_SPAWN_FAILED: ' + $msg }
        return $result
    } finally {
        $env:PYTHONIOENCODING = $oldIo
        $env:PYTHONUTF8 = $oldUtf8
    }
    try { $result.pid = $proc.Id } catch { }
    # Touch the native handle right away: PowerShell's Start-Process object drops its
    # process handle when the spawn helper returns, after which ExitCode reads as $null.
    # Opening .Handle explicitly keeps the handle alive so ExitCode works after exit.
    try { $null = $proc.Handle } catch { }

    $waitMs = [Math]::Max(1000, $TimeoutSeconds * 1000)
    $finished = $false
    try { $finished = $proc.WaitForExit($waitMs) } catch { $finished = $false }

    if (-not $finished) {
        $result.timedOut = $true
        # Leave the task alive on purpose; report its pid so the caller can control it.
        $result.stdout = Read-TextFileShared $outFile
        $result.stderr = Read-TextFileShared $errFile
        return $result
    }

    try { $result.code = $proc.ExitCode } catch { }
    $result.stdout = Read-TextFileShared $outFile
    $result.stderr = Read-TextFileShared $errFile
    try { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue } catch { }
    $result.ok = ($result.code -eq 0 -and -not $result.error)
    return $result
}

function Get-ExitMeaning {
    param($Code)
    $map = @{
        0 = [ordered]@{ status = 'success'; label = 'Task finished successfully' }
        1 = [ordered]@{ status = 'failed'; label = 'Task failed (see the run record / log)' }
        2 = [ordered]@{ status = 'bad-args'; label = 'Bad command line arguments' }
        3 = [ordered]@{ status = 'first-run-required'; label = 'First run not confirmed: the user must accept the disclaimer in the GUI' }
        4 = [ordered]@{ status = 'busy'; label = 'Another task is already running' }
        5 = [ordered]@{ status = 'no-uac'; label = 'Admin rights were not granted (UAC cancelled)' }
        6 = [ordered]@{ status = 'stopped'; label = 'Task was stopped by a control command' }
    }
    $key = -1
    try { $key = [int]$Code } catch { $key = -1 }
    if ($map.ContainsKey($key)) { return $map[$key] }
    return [ordered]@{ status = 'unknown'; label = ('Unknown exit code: ' + [string]$Code) }
}

function Get-ExitHint {
    param($Code)
    switch ([int]$Code) {
        3 { return 'The user must open March7th Launcher.exe and accept the disclaimer once; then run again.' }
        4 { return 'Another run is active. Poll with -Action status / follow instead of starting a second run.' }
        5 { return 'UAC was cancelled. Retry and approve the prompt, or start the task from an elevated scheduled task.' }
        6 { return 'The run was stopped by --control current stop.' }
        1 { return 'Read logs\runs\<latest>.json (status/reason/error/screenshot) and the day log to find the failing step.' }
        default { return '' }
    }
}

function Get-StateDir {
    if ($env:DSH_GAME_DAILY_STATE_DIR) { return $env:DSH_GAME_DAILY_STATE_DIR }
    $userHome = $env:USERPROFILE
    if (-not $userHome) { $userHome = [Environment]::GetFolderPath('UserProfile') }
    return (Join-Path $userHome '.dsh\game-daily')
}

# Inspect one candidate directory. Returns path facts; never probes parents.
function Get-InstallInfo {
    param([string]$Dir)
    $info = [ordered]@{
        root          = ''
        exe           = ''
        launcher      = ''
        assistant     = ''
        config        = ''
        exampleConfig = ''
        versionFile   = ''
        logsDir       = ''
        runsDir       = ''
        docsDir       = ''
        hasExe        = $false
        looksLikeRoot = $false
        legacyOnly    = $false
        version       = ''
        ok            = $false
    }
    if ([string]::IsNullOrWhiteSpace($Dir)) { return $info }
    $d = $Dir.Trim().TrimEnd('\')
    $info.root = $d
    $info.exe = Join-Path $d 'm7a.exe'
    $info.launcher = Join-Path $d 'March7th Launcher.exe'
    $info.assistant = Join-Path $d 'March7th Assistant.exe'
    $info.config = Join-Path $d 'config.yaml'
    $info.exampleConfig = Join-Path $d (Join-Path 'assets\config' 'config.example.yaml')
    $info.versionFile = Join-Path $d (Join-Path 'assets\config' 'version.txt')
    $info.logsDir = Join-Path $d 'logs'
    $info.runsDir = Join-Path (Join-Path $d 'logs') 'runs'
    $info.docsDir = Join-Path $d (Join-Path 'assets' 'docs')

    $info.hasExe = Test-Path -LiteralPath $info.exe -PathType Leaf
    $marker = $false
    foreach ($path in @($info.config, $info.launcher, $info.assistant)) {
        if (Test-Path -LiteralPath $path -PathType Leaf) { $marker = $true; break }
    }
    if (-not $marker -and (Test-Path -LiteralPath $info.exampleConfig -PathType Leaf)) { $marker = $true }
    if (-not $marker -and (Test-Path -LiteralPath (Join-Path $d 'assets') -PathType Container)) { $marker = $true }
    $info.looksLikeRoot = $marker
    $info.ok = ($info.hasExe -and $marker)
    $info.legacyOnly = ((-not $info.hasExe) -and $marker)
    if (Test-Path -LiteralPath $info.versionFile -PathType Leaf) {
        try { $info.version = (Get-Content -LiteralPath $info.versionFile -Raw -Encoding UTF8).Trim() } catch { $info.version = '' }
    }
    return $info
}

# %LOCALAPPDATA%\March7thAssistant\installs.json is written by the M7A GUI itself.
function Get-InstallBookmarks {
    $local = $env:LOCALAPPDATA
    if (-not $local) { $local = Join-Path $env:USERPROFILE 'AppData\Local' }
    $file = Join-Path $local (Join-Path 'March7thAssistant' 'installs.json')
    $out = [ordered]@{ file = $file; paths = @(); error = '' }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        $out.error = 'missing'
        return $out
    }
    $data = $null
    try { $data = Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json } catch {
        $out.error = 'bad-json'
        return $out
    }
    $list = @()
    if ($data -is [System.Array]) { $list = @($data) }
    elseif ($data -is [System.Management.Automation.PSCustomObject]) {
        foreach ($propName in @('installs', 'data')) {
            $prop = $data.PSObject.Properties[$propName]
            if ($prop -and $null -ne $prop.Value) {
                if ($prop.Value -is [System.Array]) { $list = @($prop.Value) } else { $list = @($prop.Value) }
                break
            }
        }
    }
    $paths = @()
    foreach ($item in $list) {
        if ($null -eq $item) { continue }
        if ($item -is [string]) { $paths += $item; continue }
        foreach ($field in @('path', 'install_path', 'installPath', 'root', 'dir', 'directory', 'location')) {
            $prop = $item.PSObject.Properties[$field]
            if ($prop -and $prop.Value) { $paths += [string]$prop.Value; break }
        }
    }
    if ($paths.Count -eq 0 -and $data -is [System.Management.Automation.PSCustomObject]) {
        foreach ($prop in $data.PSObject.Properties) {
            if ($prop.Value -is [string] -and $prop.Value -match '[\\/]') { $paths += $prop.Value }
        }
    }
    $out.paths = @($paths | ForEach-Object { ([string]$_).Trim().TrimEnd('\') } | Where-Object { $_ } | Select-Object -Unique)
    return $out
}

function Get-CandidateRoots {
    $userHome = $env:USERPROFILE
    $list = @(
        (Join-Path $userHome 'Games\March7thAssistant'),
        'D:\March7thAssistant',
        'E:\software\March7thAssistant',
        'D:\software\March7thAssistant',
        (Join-Path $userHome 'March7thAssistant')
    )
    return @($list | Where-Object { $_ } | Select-Object -Unique)
}

# Append one path to a string array. The leading comma keeps a one-element result
# an array; without it PowerShell unrolls the return value and '+=' later on a
# bare string would CONCATENATE the paths instead of appending them.
function Add-Searched {
    param([string[]]$List, [string]$Path)
    $result = @($List)
    if (-not $Path) { return ,$result }
    $p = $Path.Trim().TrimEnd('\')
    if (-not $p) { return ,$result }
    if ($result -notcontains $p) { $result += $p }
    return ,$result
}

# Discovery order (same sources as lib/m7a.mjs): explicit -Root, env var, state-dir
# pointer, M7A's own installs.json, then a short list of common folders.
# Never walk the disk.
function Resolve-M7aRoot {
    param([string]$ExplicitRoot)
    $searched = @()
    if ($ExplicitRoot) {
        $info = Get-InstallInfo $ExplicitRoot
        $searched = Add-Searched $searched $ExplicitRoot
        if (-not $info.ok) {
            return [ordered]@{ ok = $false; error = 'M7A_BAD_ROOT'; info = $info; source = 'root'; searched = @($searched); legacyOnly = [bool]$info.legacyOnly; legacyRoot = $info.root }
        }
        return [ordered]@{ ok = $true; info = $info; source = 'root'; searched = @($searched) }
    }

    foreach ($name in @('DSH_GAME_DAILY_M7A_ROOT', 'M7A_ROOT')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if (-not $value) { continue }
        $searched = Add-Searched $searched $value
        $info = Get-InstallInfo $value
        if ($info.ok) { return [ordered]@{ ok = $true; info = $info; source = ('env:' + $name); searched = @($searched) } }
    }

    $pointer = Join-Path (Get-StateDir) 'm7a-root.txt'
    if (Test-Path -LiteralPath $pointer -PathType Leaf) {
        $value = ''
        try { $value = (Get-Content -LiteralPath $pointer -Raw -Encoding UTF8).Trim() } catch { $value = '' }
        if ($value) {
            $searched = Add-Searched $searched $value
            $info = Get-InstallInfo $value
            if ($info.ok) { return [ordered]@{ ok = $true; info = $info; source = 'state-pointer'; searched = @($searched) } }
        }
    }

    $bookmarks = Get-InstallBookmarks
    foreach ($path in $bookmarks.paths) {
        $searched = Add-Searched $searched $path
        $info = Get-InstallInfo $path
        if ($info.ok) { return [ordered]@{ ok = $true; info = $info; source = 'installs.json'; searched = @($searched) } }
    }

    foreach ($path in (Get-CandidateRoots)) {
        $searched = Add-Searched $searched $path
        $info = Get-InstallInfo $path
        if ($info.ok) { return [ordered]@{ ok = $true; info = $info; source = 'default-candidates'; searched = @($searched) } }
    }

    $legacyRoot = ''
    foreach ($path in $searched) {
        $info = Get-InstallInfo $path
        if ($info.legacyOnly) { $legacyRoot = $info.root; break }
    }
    return [ordered]@{
        ok          = $false
        error       = 'M7A_NOT_INSTALLED'
        source      = ''
        searched    = @($searched)
        legacyOnly  = [bool]$legacyRoot
        legacyRoot  = $legacyRoot
        bookmarks   = $bookmarks
        pointer     = $pointer
    }
}

function Invoke-M7aStatus {
    param($Info)
    $proc = Invoke-M7aProcess -Exe $Info.exe -ArgList @('--status', '--json') -TimeoutSeconds 30 -WorkingDir $Info.root -KillOnTimeout
    $data = Get-JsonFromText $proc.stdout
    if ($null -eq $data) { $data = Get-JsonFromText $proc.stderr }
    return [ordered]@{ proc = $proc; data = $data }
}

function Get-M7aConfig {
    param([string]$InstallRoot)
    $file = Join-Path $InstallRoot 'config.yaml'
    $out = [ordered]@{ ok = $false; file = $file; values = [ordered]@{}; scheduledTasksBlock = $false; error = '' }
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        $out.error = 'M7A_CONFIG_MISSING'
        return $out
    }
    $text = ''
    try { $text = Get-Content -LiteralPath $file -Raw -Encoding UTF8 } catch {
        $out.error = 'M7A_CONFIG_UNREADABLE: ' + $_.Exception.Message
        return $out
    }
    $keys = @(
        'game_path', 'auto_set_game_path_enable', 'auto_set_resolution_enable',
        'daily_enable', 'power_enable', 'after_finish', 'pause_after_success',
        'exit_after_failure', 'check_update', 'cloud_game_enable'
    )
    foreach ($key in $keys) {
        # [ \t]* and not \s* after the colon: \s would swallow the newline and capture
        # the next indented line as the value of an empty key.
        $pattern = '(?m)^' + [regex]::Escape($key) + '[ \t]*:[ \t]*([^#\r\n]*)'
        $match = [regex]::Match($text, $pattern)
        if ($match.Success) { $out.values[$key] = (ConvertFrom-YamlScalar $match.Groups[1].Value) }
    }
    $out.scheduledTasksBlock = [regex]::IsMatch($text, '(?m)^scheduled_tasks[ \t]*:[ \t]*(\r?\n|$)')
    $inline = [regex]::Match($text, '(?m)^scheduled_tasks[ \t]*:[ \t]*([^#\r\n]*)')
    if ($inline.Success) {
        $inlineValue = ConvertFrom-YamlScalar $inline.Groups[1].Value
        if ($inlineValue) { $out.values['scheduled_tasks'] = $inlineValue }
    }
    $out.ok = $true
    return $out
}

# Trim whitespace and one layer of matching YAML quotes.
function ConvertFrom-YamlScalar {
    param([string]$Value)
    if ($null -eq $Value) { return '' }
    $v = $Value.Trim()
    if ($v.Length -ge 2) {
        if (($v.StartsWith('"') -and $v.EndsWith('"')) -or ($v.StartsWith("'") -and $v.EndsWith("'"))) {
            $v = $v.Substring(1, $v.Length - 2)
        }
    }
    return $v
}

function Get-FileTail {
    param([string]$File, [int]$LineCount = 40)
    $out = [ordered]@{ ok = $false; file = $File; lines = @(); error = ''; count = 0 }
    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) {
        $out.error = 'M7A_LOG_MISSING'
        return $out
    }
    try {
        $raw = @(Get-Content -LiteralPath $File -Tail $LineCount -Encoding UTF8)
        # Get-Content lines carry provider note properties (PSPath/PSDrive/PSProvider/...)
        # in Windows PowerShell 5.1; ConvertTo-Json would serialize each line as a huge
        # object instead of a string, so strip them by casting to [string].
        $lines = @()
        foreach ($item in $raw) { $lines += [string]$item }
        $out.lines = @($lines)
        $out.count = $lines.Count
        $out.ok = $true
    } catch {
        $out.error = 'M7A_LOG_UNREADABLE: ' + $_.Exception.Message
    }
    return $out
}

function Get-TodayLogFile {
    param([string]$InstallRoot)
    $stamp = (Get-Date).ToString('yyyy-MM-dd')
    return (Join-Path (Join-Path $InstallRoot 'logs') ($stamp + '.log'))
}

function Get-LatestRunId {
    param([string]$InstallRoot)
    $dir = Join-Path (Join-Path $InstallRoot 'logs') 'runs'
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return '' }
    $files = @(Get-ChildItem -LiteralPath $dir -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending)
    foreach ($f in $files) {
        if ($f.Extension -eq '.log' -or $f.Extension -eq '.json') { return $f.BaseName }
    }
    return ''
}

function Get-RecentRuns {
    param([string]$InstallRoot, [int]$Limit = 3)
    $dir = Join-Path (Join-Path $InstallRoot 'logs') 'runs'
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return @() }
    $files = @(Get-ChildItem -LiteralPath $dir -File -Filter '*.json' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First $Limit)
    $out = @()
    foreach ($file in $files) {
        $item = [ordered]@{ runId = $file.BaseName; mtime = $file.LastWriteTime.ToString('o'); file = $file.FullName }
        $record = $null
        try { $record = Get-Content -LiteralPath $file.FullName -Raw -Encoding UTF8 | ConvertFrom-Json } catch { $record = $null }
        if ($null -ne $record -and $record -is [System.Management.Automation.PSCustomObject]) {
            foreach ($field in @('status', 'reason', 'error', 'exit_code', 'started_at', 'finished_at', 'screenshot')) {
                $prop = $record.PSObject.Properties[$field]
                if ($prop -and $null -ne $prop.Value) { $item[$field] = $prop.Value }
            }
        }
        $out += $item
    }
    return $out
}

function Get-OutputTailLines {
    param([string]$Text, [int]$Count = 10)
    if ([string]::IsNullOrWhiteSpace($Text)) { return @() }
    $lines = @($Text -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 })
    if ($lines.Count -le $Count) { return @($lines) }
    return @($lines[($lines.Count - $Count)..($lines.Count - 1)])
}

function Get-NotInstalledResult {
    param([string]$ActionNameLocal, $Resolved)
    $hint = 'March7thAssistant (m7a.exe) was not found. Install: download March7thAssistant_full.zip from GitHub Releases, extract to %USERPROFILE%\Games\March7thAssistant (avoid C:\Program Files), start March7th Launcher.exe once as yourself and accept the disclaimer, then set game_path. Discovery covers the DSH_GAME_DAILY_M7A_ROOT env var, <stateDir>\m7a-root.txt, %LOCALAPPDATA%\March7thAssistant\installs.json and a short list of common folders; no disk walk is done.'
    if ($Resolved.error -eq 'M7A_BAD_ROOT') {
        $hint = 'The -Root value does not look like a March7thAssistant install (missing m7a.exe or the assets/config marker). Check the folder or omit -Root to use discovery.'
    }
    $extra = [ordered]@{
        action     = $ActionNameLocal
        searched   = @($Resolved.searched)
        legacyOnly = [bool]$Resolved.legacyOnly
    }
    if ($Resolved.legacyRoot) { $extra.legacyRoot = $Resolved.legacyRoot }
    if ($Resolved.error -eq 'M7A_BAD_ROOT' -and $Resolved.info) { $extra.root = $Resolved.info.root }
    return (New-Err -Code $Resolved.error -Hint $hint -Extra $extra)
}

# ------------------------------------------------------------------ main ---

function Invoke-Main {
    $script:ActionValue = $Action
    $action = ([string]$Action).Trim().ToLowerInvariant()
    $allowedActions = @('doctor', 'status', 'run', 'follow', 'control', 'logs')
    if ($allowedActions -notcontains $action) {
        Write-JsonOut (New-Err -Code 'M7A_BAD_ARGS' -Hint '-Action must be one of doctor | status | run | follow | control | logs' -Extra ([ordered]@{ action = $Action }))
        return 1
    }
    if ($Lines -lt 1) { $Lines = 1 }
    if ($Lines -gt 500) { $Lines = 500 }
    if ($TimeoutMinutes -lt 1) { $TimeoutMinutes = 1 }
    if ($TimeoutMinutes -gt 600) { $TimeoutMinutes = 600 }
    if ($TimeoutSeconds -lt 5) { $TimeoutSeconds = 5 }
    if ($TimeoutSeconds -gt 3600) { $TimeoutSeconds = 3600 }
    if ([string]::IsNullOrWhiteSpace($AfterFinish)) { $AfterFinish = 'None' }

    if ($action -eq 'control') {
        $controlName = ([string]$ActionName).Trim().ToLowerInvariant()
        if (@('pause', 'resume', 'stop') -notcontains $controlName) {
            Write-JsonOut (New-Err -Code 'M7A_BAD_ARGS' -Hint '-Action control requires -ActionName pause | resume | stop' -Extra ([ordered]@{ action = 'control'; actionName = $ActionName }))
            return 1
        }
    }

    $resolved = Resolve-M7aRoot -ExplicitRoot $Root
    if (-not $resolved.ok) {
        $payload = Get-NotInstalledResult -ActionNameLocal $action -Resolved $resolved
        Write-JsonOut $payload
        return 2
    }
    $info = $resolved.info

    switch ($action) {

        'doctor' {
            $statusRes = Invoke-M7aStatus -Info $info
            $config = Get-M7aConfig -InstallRoot $info.root
            $todayFile = Get-TodayLogFile -InstallRoot $info.root
            $todayLog = Get-FileTail -File $todayFile -LineCount 5
            $recent = @(Get-RecentRuns -InstallRoot $info.root -Limit 3)
            $status = $statusRes.data

            $checks = @()
            $blockers = @()
            $warnings = @()

            $checks += [ordered]@{ id = 'installed'; ok = $true; detail = ('root: ' + $info.root) }
            if ($status) {
                $checks += [ordered]@{ id = 'status'; ok = $true; detail = 'm7a.exe --status --json parsed' }
            } else {
                $checks += [ordered]@{ id = 'status'; ok = $false; detail = 'm7a.exe --status --json returned no parsable JSON' }
                $blockers += 'M7A_STATUS_UNPARSABLE'
            }
            $firstRunOk = $true
            $gamePathOk = $true
            $activeRun = ''
            if ($status) {
                $firstProp = $status.PSObject.Properties['first_run_completed']
                if ($firstProp -and $firstProp.Value -eq $false) { $firstRunOk = $false }
                $gameProp = $status.PSObject.Properties['game_path_exists']
                if ($gameProp -and $gameProp.Value -eq $false) { $gamePathOk = $false }
                $activeProp = $status.PSObject.Properties['active_run']
                if ($activeProp -and $activeProp.Value) { $activeRun = [string]$activeProp.Value }
            }
            if (-not $firstRunOk) {
                $checks += [ordered]@{ id = 'firstRun'; ok = $false; detail = 'first_run_completed = false: the user must accept the disclaimer once in the GUI' }
                $blockers += 'M7A_FIRST_RUN_NOT_COMPLETED'
            } else {
                $checks += [ordered]@{ id = 'firstRun'; ok = $true; detail = 'first_run_completed is not false' }
            }
            if (-not $gamePathOk) {
                $checks += [ordered]@{ id = 'gamePath'; ok = $false; detail = 'game_path_exists = false: fix game_path in config.yaml or let the GUI detect it' }
                $blockers += 'M7A_GAME_PATH_MISSING'
            } else {
                $checks += [ordered]@{ id = 'gamePath'; ok = $true; detail = 'game_path_exists is not false' }
            }
            if ($activeRun) {
                $checks += [ordered]@{ id = 'activeRun'; ok = $true; detail = ('active_run: ' + $activeRun + ' (a task is running; do not start a second one)') }
                $warnings += 'M7A_ACTIVE_RUN'
            } else {
                $checks += [ordered]@{ id = 'activeRun'; ok = $true; detail = 'no active run' }
            }
            if ($config.ok) {
                $checks += [ordered]@{ id = 'config'; ok = $true; detail = ('config.yaml readable: ' + $config.file) }
                if (-not $config.values.Contains('game_path') -or -not $config.values['game_path']) {
                    $warnings += 'M7A_CONFIG_GAME_PATH_EMPTY'
                }
            } else {
                $checks += [ordered]@{ id = 'config'; ok = $false; detail = $config.error }
                $warnings += 'M7A_CONFIG_UNREADABLE'
            }
            if ($todayLog.ok) {
                $checks += [ordered]@{ id = 'todayLog'; ok = $true; detail = ('today log: ' + $todayLog.file) }
            } else {
                $checks += [ordered]@{ id = 'todayLog'; ok = $true; detail = ('no log for today yet: ' + $todayLog.file) }
                $warnings += 'M7A_TODAY_LOG_MISSING'
            }

            $out = [ordered]@{
                ok            = ($blockers.Count -eq 0)
                action        = 'doctor'
                root          = $info.root
                source        = $resolved.source
                exe           = $info.exe
                version       = $(if ($status -and $status.PSObject.Properties['version'] -and $status.version) { [string]$status.version } else { [string]$info.version })
                files         = [ordered]@{
                    m7aExe       = (Test-Path -LiteralPath $info.exe -PathType Leaf)
                    launcher     = (Test-Path -LiteralPath $info.launcher -PathType Leaf)
                    assistant    = (Test-Path -LiteralPath $info.assistant -PathType Leaf)
                    config       = (Test-Path -LiteralPath $info.config -PathType Leaf)
                    exampleConfig = (Test-Path -LiteralPath $info.exampleConfig -PathType Leaf)
                    versionFile  = (Test-Path -LiteralPath $info.versionFile -PathType Leaf)
                    logsDir      = (Test-Path -LiteralPath $info.logsDir -PathType Container)
                    runsDir      = (Test-Path -LiteralPath $info.runsDir -PathType Container)
                    docsDir      = (Test-Path -LiteralPath $info.docsDir -PathType Container)
                }
                status        = $status
                statusExitCode = $statusRes.proc.code
                config        = [ordered]@{ ok = $config.ok; file = $config.file; values = $config.values; scheduledTasksBlock = $config.scheduledTasksBlock; error = $config.error }
                todayLog      = [ordered]@{ ok = $todayLog.ok; file = $todayLog.file; lines = $todayLog.lines; error = $todayLog.error }
                recentRuns    = @($recent)
                checks        = @($checks)
                blockers      = @($blockers)
                warnings      = @($warnings)
            }
            $out.deepCheck = [ordered]@{
                firstRunOk = $firstRunOk
                gamePathOk = $gamePathOk
                activeRun  = $activeRun
            }
            if ($blockers.Count -gt 0) {
                $out.error = $blockers[0]
                if ($blockers -contains 'M7A_FIRST_RUN_NOT_COMPLETED') {
                    $out.hint = 'The user must open March7th Launcher.exe and accept the disclaimer once (the agent cannot do this for them); then set game_path and rerun doctor.'
                } elseif ($blockers -contains 'M7A_GAME_PATH_MISSING') {
                    $out.hint = 'Set game_path in config.yaml (or let the GUI detect it) and make sure auto_set_game_path_enable is true; then rerun doctor.'
                } elseif ($blockers -contains 'M7A_STATUS_UNPARSABLE') {
                    $out.hint = 'm7a.exe --status --json produced no JSON. Check that m7a.exe is the new CLI build (assets/config/version.txt) and that the output is not UTF-16; rerun with -Action status to see the raw tail.'
                }
            }
            Write-JsonOut $out
            if ($blockers.Count -gt 0) { return 2 }
            return 0
        }

        'status' {
            $statusRes = Invoke-M7aStatus -Info $info
            if ($null -eq $statusRes.data) {
                Write-JsonOut (New-Err -Code 'M7A_STATUS_UNPARSABLE' -Hint 'm7a.exe --status --json produced no parsable JSON; run the command manually to inspect its output.' -Extra ([ordered]@{
                    action     = 'status'
                    root       = $info.root
                    exitCode   = $statusRes.proc.code
                    stdoutTail = @(Get-OutputTailLines -Text $statusRes.proc.stdout -Count 8)
                    stderrTail = @(Get-OutputTailLines -Text $statusRes.proc.stderr -Count 8)
                    timedOut   = $statusRes.proc.timedOut
                }))
                return 1
            }
            $data = $statusRes.data
            $activeRun = ''
            $activeProp = $data.PSObject.Properties['active_run']
            if ($activeProp -and $activeProp.Value) { $activeRun = [string]$activeProp.Value }
            $out = [ordered]@{
                ok          = $true
                action      = 'status'
                root        = $info.root
                exe         = $info.exe
                version     = $(if ($data.PSObject.Properties['version'] -and $data.version) { [string]$data.version } else { [string]$info.version })
                exitCode    = $statusRes.proc.code
                activeRun   = $activeRun
                status      = $data
            }
            if ($Tasks) {
                $listProc = Invoke-M7aProcess -Exe $info.exe -ArgList @('--list', '--json') -TimeoutSeconds 30 -WorkingDir $info.root -KillOnTimeout
                $listData = Get-JsonFromText $listProc.stdout
                if ($null -eq $listData) { $listData = Get-JsonFromText $listProc.stderr }
                $out.tasks = $listData
                $out.tasksExitCode = $listProc.code
                if ($null -eq $listData) { $out.tasksError = 'M7A_LIST_UNPARSABLE' }
            }
            Write-JsonOut $out
            return 0
        }

        'run' {
            if (-not $Force) {
                $pre = Invoke-M7aStatus -Info $info
                if ($null -eq $pre.data) {
                    Write-JsonOut (New-Err -Code 'M7A_STATUS_UNPARSABLE' -Hint 'Preflight failed: m7a.exe --status --json produced no parsable JSON. Use -Force to skip preflight if you know the install is healthy.' -Extra ([ordered]@{
                        action   = 'run'
                        taskId   = $Task
                        root     = $info.root
                        exitCode = $pre.proc.code
                    }))
                    return 2
                }
                $preStatus = $pre.data
                $firstProp = $preStatus.PSObject.Properties['first_run_completed']
                if ($firstProp -and $firstProp.Value -eq $false) {
                    Write-JsonOut (New-Err -Code 'M7A_FIRST_RUN_REQUIRED' -Hint 'The user must open March7th Launcher.exe and accept the disclaimer once; the agent cannot confirm it. Then run again.' -Extra ([ordered]@{ action = 'run'; taskId = $Task; root = $info.root }))
                    return 3
                }
                $gameProp = $preStatus.PSObject.Properties['game_path_exists']
                if ($gameProp -and $gameProp.Value -eq $false) {
                    Write-JsonOut (New-Err -Code 'M7A_GAME_PATH_MISSING' -Hint 'game_path_exists = false. Fix game_path in config.yaml (or let the GUI detect it), then run again.' -Extra ([ordered]@{ action = 'run'; taskId = $Task; root = $info.root }))
                    return 2
                }
                $activeProp = $preStatus.PSObject.Properties['active_run']
                if ($activeProp -and $activeProp.Value) {
                    Write-JsonOut (New-Err -Code 'M7A_BUSY' -Hint 'Another run is active. Follow it with -Action follow -Run latest instead of starting a second run (or use -Force to override).' -Extra ([ordered]@{ action = 'run'; taskId = $Task; root = $info.root; activeRun = [string]$activeProp.Value }))
                    return 4
                }
            }

            $argList = @($Task, '--after-finish', $AfterFinish)
            if ($Detach) { $argList += '--detach' } else { $argList += '--json' }
            $started = Get-Date
            $waitSeconds = [Math]::Max(1, $TimeoutMinutes * 60)
            # Local wait is bounded: on timeout the run is stopped (see the hint), because a
            # live child with our stdout attached would otherwise hang the caller until the
            # task ends on its own. For long automation use -Detach and poll instead.
            $proc = Invoke-M7aProcess -Exe $info.exe -ArgList $argList -TimeoutSeconds $waitSeconds -WorkingDir $info.root -KillOnTimeout
            $elapsed = [int]((Get-Date) - $started).TotalSeconds
            $record = Get-JsonFromText $proc.stdout
            if ($null -eq $record) { $record = Get-JsonFromText $proc.stderr }

            $out = [ordered]@{
                ok         = ([bool]$proc.ok)
                action     = 'run'
                taskId     = $Task
                detach     = [bool]$Detach
                afterFinish = $AfterFinish
                root       = $info.root
                exitCode   = $proc.code
                timedOut   = $proc.timedOut
                durationSec = $elapsed
                meaning    = (Get-ExitMeaning $proc.code)
                record     = $record
            }
            if ($Detach) {
                $out.outputTail = @(Get-OutputTailLines -Text $proc.stdout -Count 5)
                $out.hint = 'Detached: poll with -Action status, -Action follow -Run latest, or -Action logs; read logs\runs\<runId>.json for the final record.'
            }
            if ($proc.error) {
                $out.error = $proc.error
                $out.hint = $(if ($proc.error -eq 'M7A_ELEVATION_REQUIRED') { 'm7a.exe refused to start without elevation. Run this from an elevated shell or from an elevated scheduled task (UAC cannot be answered from a piped process).' } else { 'm7a.exe could not be started; check the install and antivirus quarantine.' })
                $out.ok = $false
                $out.stdoutTail = @(Get-OutputTailLines -Text $proc.stdout -Count 8)
                $out.stderrTail = @(Get-OutputTailLines -Text $proc.stderr -Count 8)
                Write-JsonOut $out
                return 1
            }
            if ($proc.timedOut) {
                $out.ok = $false
                $out.error = 'M7A_RUN_TIMEOUT'
                $out.hint = ('Local wait limit reached (' + [string]$TimeoutMinutes + ' min). The run was stopped so the call could return; read -Action logs to see how far it got, and use -Detach for tasks that should outlive the call.')
                $out.outputTail = @(Get-OutputTailLines -Text $proc.stdout -Count 5)
                if ($proc.pid) { $out.m7aProcessId = $proc.pid }
            } elseif (-not $proc.ok) {
                $out.error = 'M7A_TASK_' + ([string](Get-ExitMeaning $proc.code).status).ToUpperInvariant().Replace('-', '_')
                $out.hint = (Get-ExitHint $proc.code)
                if ($proc.code -eq 2) { $out.hint = ('Unknown task id or bad arguments for: ' + $Task + '. Use -Action status -Tasks to list the ids supported by this build.') }
            }
            Write-JsonOut $out
            if ($proc.timedOut) { return 2 }
            if ($null -ne $proc.code) { return ([int]$proc.code) }
            return 1
        }

        'follow' {
            $runId = ([string]$Run).Trim()
            if (-not $runId) { $runId = 'latest' }

            if ($FromLog -or $Detach) {
                $target = $runId
                if ($target -eq 'latest') {
                    $target = Get-LatestRunId -InstallRoot $info.root
                    if (-not $target) {
                        Write-JsonOut (New-Err -Code 'M7A_NO_RUNS' -Hint 'No run records in logs\runs yet. Start a task first (-Action run -Task main -Detach).' -Extra ([ordered]@{ action = 'follow'; root = $info.root; runsDir = $info.runsDir }))
                        return 2
                    }
                }
                $file = Join-Path $info.runsDir ($target + '.log')
                $tail = Get-FileTail -File $file -LineCount $Lines
                $out = [ordered]@{
                    ok      = [bool]$tail.ok
                    action  = 'follow'
                    mode    = 'log'
                    run     = $target
                    root    = $info.root
                    file    = $file
                    lines   = @($tail.lines)
                    count   = $tail.count
                }
                if (-not $tail.ok) {
                    $out.error = $tail.error
                    $out.hint = 'Run logs are written to logs\runs\<runId>.log; use the .json record for the final status.'
                }
                Write-JsonOut $out
                if ($tail.ok) { return 0 }
                return 2
            }

            $proc = Invoke-M7aProcess -Exe $info.exe -ArgList @('--follow', $runId) -TimeoutSeconds $TimeoutSeconds -WorkingDir $info.root -KillOnTimeout
            $allLines = @($proc.stdout -split "`r?`n" | Where-Object { $_.Trim().Length -gt 0 })
            $tailLines = @()
            if ($allLines.Count -gt 0) {
                $take = [Math]::Min($Lines, $allLines.Count)
                $tailLines = @($allLines[($allLines.Count - $take)..($allLines.Count - 1)])
            }
            $out = [ordered]@{
                ok        = (-not $proc.error)
                action    = 'follow'
                mode      = 'follow'
                run       = $runId
                root      = $info.root
                exitCode  = $proc.code
                timedOut  = $proc.timedOut
                lineCount = $allLines.Count
                lines     = $tailLines
            }
            if ($proc.error) {
                $out.error = $proc.error
                $out.hint = 'm7a.exe --follow could not start. Fall back to -FromLog (reads logs\runs\<run>.log) or -Action logs.'
                $out.ok = $false
            } elseif ($proc.timedOut) {
                $out.hint = 'Follow window elapsed while the run may still be active. Call again, or read logs\runs\<runId>.json for the final record.'
            } else {
                $out.hint = 'm7a.exe --follow exited (run finished or no such run). Read -Action logs for the day log tail.'
            }
            Write-JsonOut $out
            if ($proc.error) { return 1 }
            if ($proc.timedOut) { return 2 }
            return 0
        }

        'control' {
            $controlName = ([string]$ActionName).Trim().ToLowerInvariant()
            $proc = Invoke-M7aProcess -Exe $info.exe -ArgList @('--control', 'current', $controlName) -TimeoutSeconds 30 -WorkingDir $info.root -KillOnTimeout
            $out = [ordered]@{
                ok         = ([bool]$proc.ok)
                action     = 'control'
                control    = $controlName
                root       = $info.root
                exitCode   = $proc.code
                meaning    = (Get-ExitMeaning $proc.code)
                outputTail = @(Get-OutputTailLines -Text $proc.stdout -Count 8)
            }
            if ($proc.error) {
                $out.error = $proc.error
                $out.hint = 'm7a.exe --control could not start; check the install. pause/resume/stop only work while a task is running.'
                $out.ok = $false
            } elseif (-not $proc.ok) {
                $out.error = 'M7A_CONTROL_FAILED'
                $out.hint = 'There may be no active run to control (start one with -Action run first), or the build does not support --control.'
            } else {
                $out.hint = ('Sent ' + $controlName + ' to the current run.')
            }
            Write-JsonOut $out
            if ($proc.error) { return 1 }
            if ($null -ne $proc.code) { return ([int]$proc.code) }
            return 1
        }

        'logs' {
            $target = ([string]$Run).Trim()
            if ($target) {
                if ($target -eq 'latest') {
                    $target = Get-LatestRunId -InstallRoot $info.root
                    if (-not $target) {
                        Write-JsonOut (New-Err -Code 'M7A_NO_RUNS' -Hint 'No run records in logs\runs yet. Start a task first.' -Extra ([ordered]@{ action = 'logs'; root = $info.root; runsDir = $info.runsDir }))
                        return 2
                    }
                }
                $file = Join-Path $info.runsDir ($target + '.log')
                $tail = Get-FileTail -File $file -LineCount $Lines
                $out = [ordered]@{
                    ok     = [bool]$tail.ok
                    action = 'logs'
                    scope  = 'run'
                    run    = $target
                    root   = $info.root
                    file   = $file
                    lines  = @($tail.lines)
                    count  = $tail.count
                }
                if (-not $tail.ok) {
                    $out.error = $tail.error
                    $out.hint = 'Per-run logs live in logs\runs\<runId>.log (the .json record has status/reason/error).'
                }
                Write-JsonOut $out
                if ($tail.ok) { return 0 }
                return 2
            }

            $file = Get-TodayLogFile -InstallRoot $info.root
            $tail = Get-FileTail -File $file -LineCount $Lines
            $out = [ordered]@{
                ok     = [bool]$tail.ok
                action = 'logs'
                scope  = 'today'
                root   = $info.root
                file   = $file
                lines  = @($tail.lines)
                count  = $tail.count
            }
            if (-not $tail.ok) {
                $out.error = $tail.error
                $out.hint = 'M7A writes logs\<yyyy-MM-dd>.log for the current day only when it has run something; use -Run latest for the last run log.'
            }
            Write-JsonOut $out
            if ($tail.ok) { return 0 }
            return 2
        }

        default {
            Write-JsonOut (New-Err -Code 'M7A_BAD_ARGS' -Hint 'Unknown action.' -Extra ([ordered]@{ action = $Action }))
            return 1
        }
    }
}

try {
    $code = Invoke-Main
    exit $code
} catch {
    $detail = ''
    try { $detail = [string]$_.Exception.Message } catch { }
    Write-JsonOut (New-Err -Code 'M7A_SCRIPT_ERROR' -Hint 'Unexpected error inside m7a.ps1; the message is in detail.' -Extra ([ordered]@{ action = $Action; detail = $detail }))
    exit 1
}
