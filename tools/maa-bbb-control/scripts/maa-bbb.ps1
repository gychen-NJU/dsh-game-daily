<#
.SYNOPSIS
    Maa_bbb (MaaFramework Honkai Impact 3rd helper) control script for the DSH game-daily skill.

.DESCRIPTION
    Finds a local Maa_bbb install, inspects its saved configs, launches a config with
    mab.exe --direct-run, follows debug logs and stops a running instance.
    Every action writes exactly one JSON object to stdout.

    Actions:
      doctor   Read-only environment and install report.
      status   Install, version, running process, current config and recent maafw.log lines.
      configs  List saved configs with controller, resource and checked task names.
      get      Print one saved config JSON.
      run      Start mab.exe --config-id <ID> --direct-run (detached GUI process).
      stop     Terminate running mab.exe processes (process tree included).
      logs     Tail debug\maafw.log, debug\gui.log or debug\crash.log.
      presets  Read the preset task lists from interface.json.

.PARAMETER Action
    One of doctor, status, configs, get, run, stop, logs, presets. Default: doctor.

.PARAMETER ConfigId
    Config id (file name without .json under config\configs). Accepts the full id,
    the id without the leading c_, a unique prefix, the config display name,
    or 'current' for the config currently selected in the Maa_bbb GUI.

.PARAMETER Root
    Maa_bbb install root. When omitted the script checks (in order):
    env DSH_GAME_DAILY_MAA_ROOT, env MAA_BBB_ROOT, <state dir>\maa-root.txt,
    then E:\software\Maa_bbb, D:\software\Maa_bbb, %USERPROFILE%\Maa_bbb.
    A valid root must contain both mab.exe and interface.json.

.PARAMETER WaitSeconds
    For run: seconds to wait after spawning (0-600, default 0). Reports whether the
    process is still running and its exit code when it already exited.

.PARAMETER Lines
    For logs: number of trailing lines (default 40, max 2000).
    For status: number of maafw.log lines (default 20, max 2000).

.PARAMETER Kind
    For logs: maafw, gui or crash. Default: maafw.

.PARAMETER Filter
    For logs: optional .NET regular expression (case-insensitive); only matching
    lines are returned and then limited by -Lines.

.PARAMETER Json
    Accepted for symmetry with other skill scripts. JSON is always the output format.

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File maa-bbb.ps1 -Action doctor

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File maa-bbb.ps1 -Action configs

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File maa-bbb.ps1 -Action run -ConfigId current -WaitSeconds 20

.EXAMPLE
    powershell -NoProfile -ExecutionPolicy Bypass -File maa-bbb.ps1 -Action logs -Kind maafw -Lines 60 -Filter "ERR|WRN"

.NOTES
    Exit codes: 0 = ok, 1 = bad arguments / internal error / spawn or stop failure,
    2 = not installed / bad root / config or log missing / already running.
    Requires Windows PowerShell 5.1. No external modules, no Python, no admin rights
    for read-only actions. Launching mab.exe may require an elevated DSH session for
    the desktop controller to control the game.
#>

param(
    [Parameter(Position = 0)]
    [string]$Action = 'doctor',

    [string]$ConfigId = '',

    [string]$Root = '',

    [int]$WaitSeconds = 0,

    [int]$Lines = 0,

    [string]$Kind = 'maafw',

    [string]$Filter = '',

    [switch]$Json
)

$ErrorActionPreference = 'Stop'

try {
    [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
} catch {
}

$script:DefaultLogLines = 40
$script:MaxLogLines = 2000
$script:DefaultStatusLines = 20
$script:MaxWaitSeconds = 600

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

function Write-JsonOut {
    param(
        [Parameter(Mandatory = $true)]
        $InputObject
    )

    $json = $InputObject | ConvertTo-Json -Depth 20 -Compress
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function New-Err {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Code,

        [string]$Hint = '',

        $Extra = $null,

        [string]$ActionName = ''
    )

    $name = $ActionName
    if (-not $name) { $name = [string]$Action }

    $result = [ordered]@{
        ok     = $false
        action = $name
        error  = $Code
        hint   = $Hint
    }

    if ($Extra) {
        foreach ($key in @($Extra.Keys)) {
            $result[[string]$key] = $Extra[$key]
        }
    }

    return $result
}

function New-Check {
    param(
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Status,
        [string]$Detail = ''
    )

    return [ordered]@{
        id     = $Id
        status = $Status
        detail = $Detail
    }
}

function Get-ExitCodeForResult {
    param($Result)

    if ($Result.ok) { return 0 }

    switch ([string]$Result.error) {
        'MAA_NOT_INSTALLED' { return 2 }
        'MAA_BAD_ROOT' { return 2 }
        'MAA_CONFIG_NOT_FOUND' { return 2 }
        'MAA_CONFIG_DIR_MISSING' { return 2 }
        'MAA_CONFIG_UNREADABLE' { return 2 }
        'MAA_INTERFACE_MISSING' { return 2 }
        'MAA_INTERFACE_INVALID' { return 2 }
        'MAA_LOG_MISSING' { return 2 }
        'MAA_ALREADY_RUNNING' { return 2 }
        default { return 1 }
    }
}

# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

function Expand-PathValue {
    param([string]$Value)

    if (-not $Value) { return '' }

    $expanded = [Environment]::ExpandEnvironmentVariables($Value.Trim())

    if ($expanded.StartsWith('~')) {
        $homeDir = $env:USERPROFILE
        if (-not $homeDir) { $homeDir = $env:HOME }
        if ($expanded -eq '~') {
            $expanded = [string]$homeDir
        } elseif ($expanded.StartsWith('~\') -or $expanded.StartsWith('~/')) {
            if ($homeDir) { $expanded = Join-Path $homeDir $expanded.Substring(2) }
        }
    }

    return $expanded
}

function Get-StateDir {
    $dir = $env:DSH_GAME_DAILY_STATE_DIR
    if ($dir) { return (Expand-PathValue $dir) }

    $homeDir = $env:USERPROFILE
    if (-not $homeDir) { $homeDir = $env:HOME }
    if (-not $homeDir) { return '' }

    return (Join-Path $homeDir '.dsh\game-daily')
}

function Get-InstallInfo {
    param([string]$CandidateRoot)

    $info = [ordered]@{
        root         = ''
        ok           = $false
        hasExe       = $false
        hasInterface = $false
        exe          = ''
        interface    = ''
        version      = ''
    }

    if (-not $CandidateRoot) { return $info }

    $expanded = Expand-PathValue $CandidateRoot
    if (-not $expanded) { return $info }

    try {
        $full = [System.IO.Path]::GetFullPath($expanded)
    } catch {
        return $info
    }

    $info.root = $full
    $exe = Join-Path $full 'mab.exe'
    $iface = Join-Path $full 'interface.json'
    $info.exe = $exe
    $info.interface = $iface

    try {
        $info.hasExe = Test-Path -LiteralPath $exe -PathType Leaf
        $info.hasInterface = Test-Path -LiteralPath $iface -PathType Leaf
    } catch {
        $info.hasExe = $false
        $info.hasInterface = $false
    }

    $info.ok = ($info.hasExe -and $info.hasInterface)

    if ($info.hasInterface) {
        try {
            $raw = [System.IO.File]::ReadAllText($iface, [System.Text.Encoding]::UTF8)
            $obj = $raw | ConvertFrom-Json
            if ($obj.version) { $info.version = [string]$obj.version }
        } catch {
        }
    }

    if (-not $info.version -and $info.hasExe) {
        try {
            $item = Get-Item -LiteralPath $exe
            if ($item.VersionInfo.FileVersion) {
                $info.version = [string]$item.VersionInfo.FileVersion
            }
        } catch {
        }
    }

    return $info
}

function Add-Searched {
    param($List, [string]$Entry)

    $result = @($List)
    if ($Entry -and ($result -notcontains $Entry)) {
        $result += $Entry
    }

    return , $result
}

function Get-RootSearchPlan {
    param([string]$ExplicitRoot)

    $plan = New-Object System.Collections.ArrayList

    if ($ExplicitRoot) {
        [void]$plan.Add([ordered]@{ source = 'param'; value = $ExplicitRoot })
        return @($plan)
    }

    foreach ($name in @('DSH_GAME_DAILY_MAA_ROOT', 'MAA_BBB_ROOT')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($value) {
            [void]$plan.Add([ordered]@{ source = 'env:' + $name; value = $value })
        }
    }

    $stateDir = Get-StateDir
    if ($stateDir) {
        $pointer = Join-Path $stateDir 'maa-root.txt'
        if (Test-Path -LiteralPath $pointer -PathType Leaf) {
            $value = ''
            try {
                $value = ([System.IO.File]::ReadAllText($pointer, [System.Text.Encoding]::UTF8)).Trim()
            } catch {
            }
            if ($value) {
                [void]$plan.Add([ordered]@{ source = 'state-pointer:' + $pointer; value = $value })
            }
        }
    }

    $userProfile = $env:USERPROFILE
    $candidates = @('E:\software\Maa_bbb', 'D:\software\Maa_bbb')
    if ($userProfile) { $candidates += (Join-Path $userProfile 'Maa_bbb') }
    foreach ($candidate in $candidates) {
        [void]$plan.Add([ordered]@{ source = 'candidate'; value = $candidate })
    }

    return @($plan)
}

function Resolve-MaaRoot {
    param([string]$ExplicitRoot)

    $result = [ordered]@{
        ok       = $false
        root     = ''
        source   = ''
        searched = @()
        info     = $null
        error    = ''
        hint     = ''
        partial  = $false
    }

    $searched = @()
    $plan = Get-RootSearchPlan -ExplicitRoot $ExplicitRoot

    foreach ($probe in $plan) {
        $info = Get-InstallInfo -CandidateRoot $probe.value
        $searched = Add-Searched $searched $info.root

        if ($info.ok) {
            $result.ok = $true
            $result.root = $info.root
            $result.source = [string]$probe.source
            $result.info = $info
            $result.searched = $searched
            return $result
        }

        if (($info.hasExe -or $info.hasInterface) -and -not $result.partial) {
            $result.partial = $true
            $result.info = $info
            $result.root = $info.root
            $result.source = [string]$probe.source
        }
    }

    $result.searched = $searched

    $stateDir = Get-StateDir
    $pointerHint = ''
    if ($stateDir) { $pointerHint = Join-Path $stateDir 'maa-root.txt' }

    if ($ExplicitRoot) {
        $result.error = 'MAA_BAD_ROOT'
        $result.hint = 'The -Root path is not a Maa_bbb install: mab.exe and interface.json must both exist. Checked: ' + ($searched -join '; ')
    } else {
        $result.error = 'MAA_NOT_INSTALLED'
        $result.hint = 'Maa_bbb (mab.exe + interface.json) was not found. Install Maa_bbb, then either set env DSH_GAME_DAILY_MAA_ROOT / MAA_BBB_ROOT, write the install path to ' + $pointerHint + ', or pass -Root.'
    }

    return $result
}

function Get-NotInstalledResult {
    param($ResolveResult, [string]$ActionName)

    $result = [ordered]@{
        ok           = $false
        action       = $ActionName
        error        = [string]$ResolveResult.error
        hint         = [string]$ResolveResult.hint
        searched     = @($ResolveResult.searched)
        root         = [string]$ResolveResult.root
        source       = [string]$ResolveResult.source
        hasExe       = $false
        hasInterface = $false
    }

    if ($ResolveResult.info) {
        $result.hasExe = [bool]$ResolveResult.info.hasExe
        $result.hasInterface = [bool]$ResolveResult.info.hasInterface
    }

    return $result
}

# ---------------------------------------------------------------------------
# Maa_bbb specific helpers
# ---------------------------------------------------------------------------

function Test-IsAdmin {
    try {
        $identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $principal = New-Object System.Security.Principal.WindowsPrincipal($identity)
        return $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Get-MabProcesses {
    $procs = @()
    try {
        $procs = @(Get-Process -Name 'mab' -ErrorAction SilentlyContinue)
    } catch {
        $procs = @()
    }

    return $procs
}

function Get-MabProcessIds {
    $ids = @()
    foreach ($proc in @(Get-MabProcesses)) {
        $ids += [int]$proc.Id
    }

    return $ids
}

function Get-ConfigDir {
    param([string]$InstallRoot)
    return (Join-Path $InstallRoot 'config\configs')
}

function Get-DebugDir {
    param([string]$InstallRoot)
    return (Join-Path $InstallRoot 'debug')
}

function Get-CurrentConfigId {
    param([string]$InstallRoot)

    $file = Join-Path $InstallRoot 'config\multi_config.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return '' }

    try {
        $raw = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)
        $obj = $raw | ConvertFrom-Json
        if ($obj.curr_config_id) { return [string]$obj.curr_config_id }
    } catch {
    }

    return ''
}

function Get-ConfigOrder {
    param([string]$InstallRoot)

    $order = @()
    $file = Join-Path $InstallRoot 'config\multi_config.json'
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { return $order }

    try {
        $raw = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)
        $obj = $raw | ConvertFrom-Json
        foreach ($id in @($obj.config_list)) {
            if ($id) { $order += [string]$id }
        }
    } catch {
    }

    return $order
}

function Get-ConfigFiles {
    param([string]$InstallRoot)

    $dir = Get-ConfigDir $InstallRoot
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) { return @() }

    $files = @(Get-ChildItem -LiteralPath $dir -File -Filter '*.json' -ErrorAction SilentlyContinue)
    return $files
}

function Read-JsonFile {
    param([string]$Path)

    $result = [ordered]@{
        ok    = $false
        error = ''
        data  = $null
    }

    try {
        $raw = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
        $result.data = $raw | ConvertFrom-Json
        $result.ok = $true
    } catch {
        $result.error = $_.Exception.Message
    }

    return $result
}

function Get-ConfigSummary {
    param([string]$Path, [string]$CurrentId)

    $file = Get-Item -LiteralPath $Path
    $id = [string]$file.BaseName

    $summary = [ordered]@{
        id           = $id
        name         = ''
        controller   = ''
        resource     = ''
        taskCount    = 0
        checked      = 0
        enabledTasks = @()
        isCurrent    = ($id -eq $CurrentId)
        error        = ''
    }

    $parsed = Read-JsonFile $Path
    if (-not $parsed.ok) {
        $summary.error = 'MAA_CONFIG_UNREADABLE'
        return $summary
    }

    $cfg = $parsed.data
    if ($cfg.name) { $summary.name = [string]$cfg.name }

    $tasks = @($cfg.tasks | Where-Object { $_ -ne $null })
    $summary.taskCount = $tasks.Count

    $pseudo = @('PreTask', 'Controller', 'Resource', 'Post-Action')
    $enabled = @()
    $checkedCount = 0

    foreach ($task in $tasks) {
        $taskId = [string]$task.item_id
        $taskName = [string]$task.name

        if ($taskId -eq 'Controller') {
            if ($task.task_option) { $summary.controller = [string]$task.task_option.controller_type }
            continue
        }
        if ($taskId -eq 'Resource') {
            if ($task.task_option) { $summary.resource = [string]$task.task_option.resource }
            continue
        }
        if ($pseudo -contains $taskId) { continue }

        $isChecked = $false
        if ($task.is_checked -eq $true) { $isChecked = $true }

        if ($isChecked) {
            $checkedCount++
            $enabled += $taskName
        }
    }

    $summary.checked = $checkedCount
    $summary.enabledTasks = $enabled

    return $summary
}

function Get-ConfigSummaries {
    param([string]$InstallRoot)

    $dir = Get-ConfigDir $InstallRoot
    $currentId = Get-CurrentConfigId $InstallRoot

    $result = [ordered]@{
        ok              = $true
        configDir       = $dir
        count           = 0
        currentConfigId = $currentId
        configs         = @()
        warnings        = @()
    }

    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
        $result.ok = $false
        $result.error = 'MAA_CONFIG_DIR_MISSING'
        $result.hint = 'The install looks incomplete: ' + $dir + ' does not exist. Open mab.exe once and save a config.'
        return $result
    }

    $files = @(Get-ConfigFiles $InstallRoot)
    $order = @(Get-ConfigOrder $InstallRoot)
    $summaries = @()

    foreach ($file in $files) {
        $summaries += Get-ConfigSummary -Path $file.FullName -CurrentId $currentId
    }

    $ordered = @()
    foreach ($id in $order) {
        $hits = @($summaries | Where-Object { $_.id -eq $id })
        foreach ($hit in $hits) {
            $ordered += $hit
            $summaries = @($summaries | Where-Object { $_.id -ne $id })
        }
    }
    foreach ($summary in $summaries) { $ordered += $summary }

    $result.configs = $ordered
    $result.count = $ordered.Count

    if ($ordered.Count -eq 0) {
        $result.warnings += 'MAA_NO_CONFIGS'
    }

    return $result
}

function Resolve-ConfigTarget {
    param([string]$InstallRoot, [string]$ConfigId)

    $result = [ordered]@{
        ok        = $false
        id        = ''
        file      = ''
        name      = ''
        error     = ''
        hint      = ''
        available = @()
    }

    $dir = Get-ConfigDir $InstallRoot
    if (-not (Test-Path -LiteralPath $dir -PathType Container)) {
        $result.error = 'MAA_CONFIG_DIR_MISSING'
        $result.hint = 'config\configs is missing under ' + $InstallRoot
        return $result
    }

    $files = @(Get-ConfigFiles $InstallRoot)
    $result.available = @($files | ForEach-Object { [string]$_.BaseName })

    $wanted = ''
    if ($ConfigId) { $wanted = $ConfigId.Trim() }

    if (-not $wanted) {
        $result.error = 'MAA_CONFIG_ID_REQUIRED'
        $result.hint = 'Pass -ConfigId (or -ConfigId current). Available ids: ' + ($result.available -join ', ')
        return $result
    }

    if ($wanted -eq 'current' -or $wanted -eq 'curr') {
        $current = Get-CurrentConfigId $InstallRoot
        if ($current) { $wanted = $current }
    }

    $match = $null

    foreach ($candidate in @($wanted, ('c_' + $wanted))) {
        foreach ($file in $files) {
            if ($file.BaseName -ceq $candidate) { $match = $file; break }
        }
        if ($match) { break }
    }

    if (-not $match) {
        foreach ($file in $files) {
            if ($file.BaseName -ieq $wanted -or $file.BaseName -ieq ('c_' + $wanted)) {
                $match = $file
                break
            }
        }
    }

    if (-not $match) {
        $hits = @($files | Where-Object {
                $_.BaseName.StartsWith($wanted, [System.StringComparison]::OrdinalIgnoreCase) -or
                $_.BaseName.StartsWith(('c_' + $wanted), [System.StringComparison]::OrdinalIgnoreCase)
            })
        if ($hits.Count -eq 1) { $match = $hits[0] }
    }

    if (-not $match) {
        $hits = @()
        foreach ($file in $files) {
            $parsed = Read-JsonFile $file.FullName
            if ($parsed.ok -and ([string]$parsed.data.name) -eq $wanted) {
                $hits += $file
            }
        }
        if ($hits.Count -eq 1) { $match = $hits[0] }
    }

    if (-not $match) {
        $result.error = 'MAA_CONFIG_NOT_FOUND'
        $result.hint = 'No config matches "' + $wanted + '". Available ids: ' + ($result.available -join ', ')
        return $result
    }

    $result.ok = $true
    $result.id = [string]$match.BaseName
    $result.file = [string]$match.FullName

    $parsed = Read-JsonFile $match.FullName
    if ($parsed.ok) { $result.name = [string]$parsed.data.name }

    return $result
}

function Get-InterfaceInfo {
    param([string]$InstallRoot)

    $file = Join-Path $InstallRoot 'interface.json'
    $result = [ordered]@{
        ok               = $false
        file             = $file
        version          = ''
        title            = ''
        interfaceVersion = 0
        controllers      = @()
        presets          = @()
        error            = ''
    }

    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        $result.error = 'MAA_INTERFACE_MISSING: ' + $file
        return $result
    }

    try {
        $raw = [System.IO.File]::ReadAllText($file, [System.Text.Encoding]::UTF8)
        $obj = $raw | ConvertFrom-Json

        $result.ok = $true
        if ($obj.version) { $result.version = [string]$obj.version }
        if ($obj.title) { $result.title = [string]$obj.title }
        if ($obj.interface_version) { $result.interfaceVersion = [int]$obj.interface_version }

        $controllers = @()
        foreach ($controller in @($obj.controller)) {
            if ($controller -eq $null) { continue }
            $controllers += [ordered]@{
                name = [string]$controller.name
                type = [string]$controller.type
            }
        }
        $result.controllers = $controllers

        $presets = @()
        foreach ($preset in @($obj.preset)) {
            if ($preset -eq $null) { continue }

            $tasks = @()
            foreach ($task in @($preset.task)) {
                if ($task -eq $null) { continue }
                if ($task -is [string]) {
                    $tasks += [string]$task
                } else {
                    $tasks += [string]$task.name
                }
            }

            $presets += [ordered]@{
                name      = [string]$preset.name
                label     = [string]$preset.label
                taskCount = $tasks.Count
                tasks     = $tasks
            }
        }
        $result.presets = $presets
    } catch {
        $result.ok = $false
        $result.error = 'MAA_INTERFACE_INVALID: ' + $_.Exception.Message
    }

    return $result
}

function Get-AdbInfo {
    $result = [ordered]@{
        available = $false
        path      = ''
        source    = ''
    }

    try {
        $cmd = Get-Command -Name 'adb.exe' -CommandType Application -ErrorAction SilentlyContinue
        if ($cmd) {
            $result.available = $true
            $result.path = [string]$cmd.Source
            $result.source = 'PATH'
            return $result
        }
    } catch {
    }

    $candidates = New-Object System.Collections.ArrayList

    $localAppData = $env:LOCALAPPDATA
    if ($localAppData) {
        [void]$candidates.Add((Join-Path $localAppData 'Android\Sdk\platform-tools\adb.exe'))
    }

    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $base) { continue }
        [void]$candidates.Add((Join-Path $base 'Netease\MuMuPlayer-12.0\shell\adb.exe'))
        [void]$candidates.Add((Join-Path $base 'Netease\MuMuPlayer-12.0\nx_main\adb.exe'))
        [void]$candidates.Add((Join-Path $base 'Netease\MuMuPlayer-5.0\shell\adb.exe'))
        [void]$candidates.Add((Join-Path $base 'Netease\MuMuPlayer-5.0\nx_main\adb.exe'))
    }

    foreach ($path in @(
            'D:\software\MuMuPlayer-12.0\shell\adb.exe',
            'E:\software\MuMuPlayer-12.0\shell\adb.exe',
            'D:\software\MuMuPlayer-5.0\shell\adb.exe',
            'E:\software\MuMuPlayer-5.0\shell\adb.exe',
            'E:\software\platform-tools\adb.exe',
            'D:\software\platform-tools\adb.exe')) {
        [void]$candidates.Add($path)
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            $result.available = $true
            $result.path = [string]$candidate
            $result.source = 'known-path'
            return $result
        }
    }

    return $result
}

function Get-MumuInfo {
    $result = [ordered]@{
        available = $false
        path      = ''
        processes = @()
        source    = ''
    }

    $names = @()
    try {
        foreach ($proc in @(Get-Process -ErrorAction SilentlyContinue)) {
            if ($proc.ProcessName -match 'MuMu|Nemu') {
                $names += [string]$proc.ProcessName
            }
        }
    } catch {
    }

    if ($names.Count -gt 0) {
        $result.available = $true
        $result.processes = @($names | Sort-Object -Unique)
        $result.source = 'process'
        return $result
    }

    $dirs = New-Object System.Collections.ArrayList
    foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)})) {
        if (-not $base) { continue }
        [void]$dirs.Add((Join-Path $base 'Netease\MuMuPlayer-12.0'))
        [void]$dirs.Add((Join-Path $base 'Netease\MuMuPlayer-5.0'))
        [void]$dirs.Add((Join-Path $base 'MuMuPlayer-12.0'))
        [void]$dirs.Add((Join-Path $base 'MuMuPlayer-5.0'))
    }

    foreach ($path in @(
            'D:\software\MuMuPlayer-12.0',
            'E:\software\MuMuPlayer-12.0',
            'D:\software\MuMuPlayer-5.0',
            'E:\software\MuMuPlayer-5.0',
            'D:\Program Files\Netease\MuMuPlayer-12.0',
            'E:\Program Files\Netease\MuMuPlayer-12.0')) {
        [void]$dirs.Add($path)
    }

    foreach ($dir in $dirs) {
        if (Test-Path -LiteralPath $dir -PathType Container) {
            $result.available = $true
            $result.path = [string]$dir
            $result.source = 'known-path'
            return $result
        }
    }

    return $result
}

function Get-LogFilePath {
    param([string]$InstallRoot, [string]$KindName)

    $debugDir = Get-DebugDir $InstallRoot
    switch ($KindName) {
        'maafw' { return (Join-Path $debugDir 'maafw.log') }
        'gui' { return (Join-Path $debugDir 'gui.log') }
        'crash' { return (Join-Path $debugDir 'crash.log') }
        default { return '' }
    }
}

function Get-FileInfo {
    param([string]$Path)

    $info = [ordered]@{
        path      = $Path
        exists    = $false
        sizeBytes = 0
        lastWrite = ''
    }

    if (-not $Path) { return $info }

    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        try {
            $item = Get-Item -LiteralPath $Path
            $info.exists = $true
            $info.sizeBytes = [long]$item.Length
            $info.lastWrite = $item.LastWriteTime.ToString('o')
        } catch {
        }
    }

    return $info
}

function Get-LogTail {
    param(
        [string]$File,
        [int]$LineCount = 40,
        [string]$Filter = ''
    )

    $result = [ordered]@{
        ok        = $false
        file      = $File
        lines     = @()
        count     = 0
        sizeBytes = 0
        lastWrite = ''
        error     = ''
    }

    if (-not $File) {
        $result.error = 'MAA_LOG_MISSING'
        return $result
    }

    if (-not (Test-Path -LiteralPath $File -PathType Leaf)) {
        $result.error = 'MAA_LOG_MISSING'
        return $result
    }

    $regex = $null
    if ($Filter) {
        try {
            $regex = New-Object System.Text.RegularExpressions.Regex($Filter, [System.Text.RegularExpressions.RegexOptions]::IgnoreCase)
        } catch {
            $result.error = 'MAA_BAD_FILTER: ' + $_.Exception.Message
            return $result
        }
    }

    $stream = $null

    try {
        $item = Get-Item -LiteralPath $File
        $result.sizeBytes = [long]$item.Length
        $result.lastWrite = $item.LastWriteTime.ToString('o')

        $stream = [System.IO.File]::Open(
            $File,
            [System.IO.FileMode]::Open,
            [System.IO.FileAccess]::Read,
            ([System.IO.FileShare]::ReadWrite -bor [System.IO.FileShare]::Delete))

        $length = [long]$stream.Length
        $maxBytes = 4194304
        $start = [long]0
        if ($length -gt $maxBytes) { $start = $length - $maxBytes }

        $stream.Position = $start
        $size = [int]($length - $start)
        $lines = @()

        if ($size -gt 0) {
            $bytes = [byte[]]::new($size)
            $read = 0
            while ($read -lt $size) {
                $n = $stream.Read($bytes, $read, $size - $read)
                if ($n -le 0) { break }
                $read += $n
            }

            $text = [System.Text.Encoding]::UTF8.GetString($bytes, 0, $read)
            $text = $text.TrimStart([char]0xFEFF)

            $all = @($text -split "`r?`n")
            if ($regex) {
                $all = @($all | Where-Object { $regex.IsMatch($_) })
            }
            $all = @($all | Where-Object { $_.Length -gt 0 })

            if ($all.Count -gt $LineCount) {
                $lines = @($all[($all.Count - $LineCount)..($all.Count - 1)])
            } else {
                $lines = $all
            }
        }

        $result.lines = @($lines | ForEach-Object { [string]$_ })
        $result.count = $result.lines.Count
        $result.ok = $true
    } catch {
        $result.error = $_.Exception.Message
    } finally {
        if ($stream) {
            try { $stream.Dispose() } catch {
            }
        }
    }

    return $result
}

function Invoke-NativeQuiet {
    param(
        [string]$FilePath,
        [string[]]$Arguments
    )

    $result = [ordered]@{
        ok       = $false
        exitCode = -1
        output   = ''
    }

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = $FilePath
    $psi.Arguments = ($Arguments -join ' ')
    $psi.UseShellExecute = $false
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    $psi.CreateNoWindow = $true

    $proc = $null

    try {
        $proc = [System.Diagnostics.Process]::Start($psi)
        $stdout = $proc.StandardOutput.ReadToEnd()
        $stderr = $proc.StandardError.ReadToEnd()
        $proc.WaitForExit()
        $result.exitCode = [int]$proc.ExitCode
        $result.output = ([string]$stdout + ' ' + [string]$stderr).Trim()
        $result.ok = ($proc.ExitCode -eq 0)
    } catch {
        $result.output = $_.Exception.Message
    } finally {
        if ($proc) {
            try { $proc.Dispose() } catch {
            }
        }
    }

    return $result
}

# ---------------------------------------------------------------------------
# Actions
# ---------------------------------------------------------------------------

function Invoke-DoctorAction {
    param($Resolved)

    $root = [string]$Resolved.root
    $isAdmin = Test-IsAdmin
    $mabProcs = @(Get-MabProcesses)
    $pids = @()
    foreach ($proc in $mabProcs) { $pids += [int]$proc.Id }

    $adb = Get-AdbInfo
    $mumu = Get-MumuInfo

    $checks = New-Object System.Collections.ArrayList
    $blockers = @()
    $warnings = @()

    $hasExe = $false
    $hasInterface = $false
    $exe = ''
    $iface = ''
    $version = ''

    if ($Resolved.info) {
        $info = $Resolved.info
        $hasExe = [bool]$info.hasExe
        $hasInterface = [bool]$info.hasInterface
        $exe = [string]$info.exe
        $iface = [string]$info.interface
        $version = [string]$info.version
    }

    $configDir = ''
    $debugDir = ''
    $maafwLog = ''
    $guiLog = ''
    $crashLog = ''

    if ($root) {
        $configDir = Get-ConfigDir $root
        $debugDir = Get-DebugDir $root
        $maafwLog = Join-Path $debugDir 'maafw.log'
        $guiLog = Join-Path $debugDir 'gui.log'
        $crashLog = Join-Path $debugDir 'crash.log'
    }

    $configCount = 0
    $currentId = ''
    $currentName = ''
    $presetCount = 0
    $interfaceVersion = 0
    $title = ''

    if ($Resolved.ok) {
        $ifaceInfo = Get-InterfaceInfo $root
        if ($ifaceInfo.ok) {
            if ($ifaceInfo.version) { $version = [string]$ifaceInfo.version }
            $title = [string]$ifaceInfo.title
            $interfaceVersion = [int]$ifaceInfo.interfaceVersion
            $presetCount = @($ifaceInfo.presets).Count
        }

        $summaries = Get-ConfigSummaries $root
        if ($summaries.ok) {
            $configCount = [int]$summaries.count
            $currentId = [string]$summaries.currentConfigId
            foreach ($summary in @($summaries.configs)) {
                if ($summary.id -eq $currentId) { $currentName = [string]$summary.name }
            }
        }
    }

    if ($Resolved.ok) {
        [void]$checks.Add((New-Check -Id 'installed' -Status 'pass' -Detail ('Maa_bbb install found at ' + $root + ' (source: ' + [string]$Resolved.source + ')')))
    } else {
        [void]$checks.Add((New-Check -Id 'installed' -Status 'fail' -Detail ('mab.exe + interface.json not found. Searched: ' + (@($Resolved.searched) -join '; '))))
        $blockers += [string]$Resolved.error
    }

    if ($hasExe) {
        [void]$checks.Add((New-Check -Id 'exe' -Status 'pass' -Detail $exe))
    } else {
        [void]$checks.Add((New-Check -Id 'exe' -Status 'fail' -Detail 'mab.exe is missing under the install root.'))
    }

    if ($hasInterface) {
        [void]$checks.Add((New-Check -Id 'interface' -Status 'pass' -Detail $iface))
    } else {
        [void]$checks.Add((New-Check -Id 'interface' -Status 'fail' -Detail 'interface.json is missing under the install root.'))
    }

    if ($configCount -gt 0) {
        [void]$checks.Add((New-Check -Id 'configs' -Status 'pass' -Detail ('' + $configCount + ' saved config(s) in ' + $configDir)))
    } elseif ($Resolved.ok) {
        [void]$checks.Add((New-Check -Id 'configs' -Status 'warn' -Detail ('No saved config found in ' + $configDir + '. Open mab.exe once and save a config first.')))
        $warnings += 'MAA_NO_CONFIGS'
    } else {
        [void]$checks.Add((New-Check -Id 'configs' -Status 'fail' -Detail 'Not installed; no saved configs to read.'))
    }

    $logsPresent = @()
    if ($root) {
        foreach ($name in @('maafw.log', 'gui.log', 'crash.log')) {
            if (Test-Path -LiteralPath (Join-Path $debugDir $name) -PathType Leaf) {
                $logsPresent += $name
            }
        }
    }

    if ($logsPresent.Count -gt 0) {
        [void]$checks.Add((New-Check -Id 'logs' -Status 'pass' -Detail ('debug logs present: ' + ($logsPresent -join ', '))))
    } elseif ($Resolved.ok) {
        [void]$checks.Add((New-Check -Id 'logs' -Status 'warn' -Detail ('No debug log yet in ' + $debugDir + '. Run mab.exe once to create maafw.log.')))
        $warnings += 'MAA_LOGS_MISSING'
    } else {
        [void]$checks.Add((New-Check -Id 'logs' -Status 'fail' -Detail 'Not installed; no debug logs to read.'))
    }

    if ($adb.available) {
        [void]$checks.Add((New-Check -Id 'adb' -Status 'pass' -Detail ('adb found: ' + [string]$adb.path + ' (source: ' + [string]$adb.source + ')')))
    } else {
        [void]$checks.Add((New-Check -Id 'adb' -Status 'warn' -Detail 'adb not found. Needed only for the Android controller (MuMu + ADB), for example the Past Elysia Realms lane.'))
        $warnings += 'MAA_ADB_MISSING'
    }

    if ($mumu.available) {
        $mumuDetail = 'MuMu detected'
        if ($mumu.path) { $mumuDetail = 'MuMu install found: ' + [string]$mumu.path }
        elseif (@($mumu.processes).Count -gt 0) { $mumuDetail = 'MuMu process running: ' + (@($mumu.processes) -join ', ') }
        [void]$checks.Add((New-Check -Id 'mumu' -Status 'pass' -Detail $mumuDetail))
    } else {
        [void]$checks.Add((New-Check -Id 'mumu' -Status 'warn' -Detail 'MuMu emulator not detected. Needed only for the Android controller.'))
        $warnings += 'MAA_MUMU_MISSING'
    }

    if (-not $isAdmin) { $warnings += 'MAA_NOT_ADMIN' }

    $files = [ordered]@{
        exe       = $exe
        interface = $iface
        configDir = $configDir
        debugDir  = $debugDir
        maafwLog  = $maafwLog
        guiLog    = $guiLog
        crashLog  = $crashLog
    }

    $result = [ordered]@{
        ok               = ($blockers.Count -eq 0)
        action           = 'doctor'
        root             = $root
        source           = [string]$Resolved.source
        searched         = @($Resolved.searched)
        version          = $version
        title            = $title
        interfaceVersion = $interfaceVersion
        presetCount      = $presetCount
        hasExe           = $hasExe
        hasInterface     = $hasInterface
        isAdmin          = $isAdmin
        running          = ($pids.Count -gt 0)
        runningPids      = $pids
        configCount      = $configCount
        configDir        = $configDir
        currentConfigId  = $currentId
        currentConfigName = $currentName
        adbAvailable     = [bool]$adb.available
        adbPath          = [string]$adb.path
        mumuAvailable    = [bool]$mumu.available
        mumuPath         = [string]$mumu.path
        checks           = @($checks)
        blockers         = @($blockers)
        warnings         = @($warnings)
        files            = $files
    }

    if (-not $result.ok) {
        $result.error = [string]$Resolved.error
        $result.hint = [string]$Resolved.hint
    }

    return $result
}

function Invoke-StatusAction {
    param([string]$InstallRoot, [int]$LineCount)

    $ifaceInfo = Get-InterfaceInfo $InstallRoot
    $mabProcs = @(Get-MabProcesses)
    $pids = @()
    foreach ($proc in $mabProcs) { $pids += [int]$proc.Id }

    $currentId = Get-CurrentConfigId $InstallRoot
    $currentName = ''
    $currentController = ''
    $currentResource = ''

    if ($currentId) {
        $summaries = Get-ConfigSummaries $InstallRoot
        if ($summaries.ok) {
            foreach ($summary in @($summaries.configs)) {
                if ($summary.id -eq $currentId) {
                    $currentName = [string]$summary.name
                    $currentController = [string]$summary.controller
                    $currentResource = [string]$summary.resource
                }
            }
        }
    }

    $configs = Get-ConfigSummaries $InstallRoot
    $configCount = 0
    if ($configs.ok) { $configCount = [int]$configs.count }

    $logFile = Get-LogFilePath -InstallRoot $InstallRoot -KindName 'maafw'
    $tail = Get-LogTail -File $logFile -LineCount $LineCount -Filter ''

    $logLines = @()
    $logError = ''
    if ($tail.ok) {
        $logLines = @($tail.lines)
    } else {
        $logError = [string]$tail.error
    }

    $debugDir = Get-DebugDir $InstallRoot

    return [ordered]@{
        ok                 = $true
        action             = 'status'
        root               = $InstallRoot
        version            = [string]$ifaceInfo.version
        title              = [string]$ifaceInfo.title
        isAdmin            = (Test-IsAdmin)
        running            = ($pids.Count -gt 0)
        runningPids        = $pids
        configCount        = $configCount
        currentConfigId    = $currentId
        currentConfigName  = $currentName
        currentController  = $currentController
        currentResource    = $currentResource
        logFile            = $logFile
        logLines           = $logLines
        logError           = $logError
        debug              = [ordered]@{
            maafwLog = (Get-FileInfo (Join-Path $debugDir 'maafw.log'))
            guiLog   = (Get-FileInfo (Join-Path $debugDir 'gui.log'))
            crashLog = (Get-FileInfo (Join-Path $debugDir 'crash.log'))
        }
    }
}

function Invoke-ConfigsAction {
    param([string]$InstallRoot)

    $summaries = Get-ConfigSummaries $InstallRoot
    if (-not $summaries.ok) {
        return (New-Err -Code ([string]$summaries.error) -Hint ([string]$summaries.hint))
    }

    $result = [ordered]@{
        ok              = $true
        action          = 'configs'
        root            = $InstallRoot
        configDir       = [string]$summaries.configDir
        count           = [int]$summaries.count
        currentConfigId = [string]$summaries.currentConfigId
        configs         = @($summaries.configs)
    }

    if (@($summaries.warnings).Count -gt 0) {
        $result.warnings = @($summaries.warnings)
    }

    return $result
}

function Invoke-GetAction {
    param([string]$InstallRoot, [string]$ConfigId)

    $target = Resolve-ConfigTarget -InstallRoot $InstallRoot -ConfigId $ConfigId
    if (-not $target.ok) {
        return (New-Err -Code ([string]$target.error) -Hint ([string]$target.hint) -Extra @{ available = @($target.available) })
    }

    $parsed = Read-JsonFile $target.file
    if (-not $parsed.ok) {
        return (New-Err -Code 'MAA_CONFIG_UNREADABLE' -Hint ('Could not parse ' + $target.file + ': ' + [string]$parsed.error))
    }

    return [ordered]@{
        ok       = $true
        action   = 'get'
        root     = $InstallRoot
        configId = [string]$target.id
        name     = [string]$target.name
        file     = [string]$target.file
        config   = $parsed.data
    }
}

function Invoke-RunAction {
    param([string]$InstallRoot, [string]$ConfigId, [int]$WaitSecondsValue)

    $target = Resolve-ConfigTarget -InstallRoot $InstallRoot -ConfigId $ConfigId
    if (-not $target.ok) {
        return (New-Err -Code ([string]$target.error) -Hint ([string]$target.hint) -Extra @{ configId = $ConfigId; available = @($target.available) })
    }

    $runningPids = @(Get-MabProcessIds)
    if ($runningPids.Count -gt 0) {
        return (New-Err -Code 'MAA_ALREADY_RUNNING' -Hint ('mab.exe is already running (pid: ' + ($runningPids -join ', ') + '). Run -Action stop first, or wait for the current run to finish.') -Extra @{ runningPids = $runningPids })
    }

    $wait = $WaitSecondsValue
    if ($wait -lt 0) { $wait = 0 }
    if ($wait -gt $script:MaxWaitSeconds) { $wait = $script:MaxWaitSeconds }

    $exe = Join-Path $InstallRoot 'mab.exe'
    $arguments = @('--config-id', [string]$target.id, '--direct-run')

    $proc = $null
    try {
        $proc = Start-Process -FilePath $exe -ArgumentList $arguments -WorkingDirectory $InstallRoot -PassThru
    } catch {
        $detail = $_.Exception.Message
        $hint = 'Could not start mab.exe. Check the install and try again.'
        if ($detail -match '740|elevat') {
            $hint = 'mab.exe requires elevation. Start this script (or DSH) as Administrator and retry.'
        }
        return (New-Err -Code 'MAA_SPAWN_FAILED' -Hint $hint -Extra @{ detail = $detail; exe = $exe })
    }

    $startedAt = Get-Date
    $stillRunning = $true
    $exitCode = $null

    if ($proc) {
        try {
            $proc.Refresh()
            $stillRunning = -not $proc.HasExited
            if (-not $stillRunning) { $exitCode = [int]$proc.ExitCode }
        } catch {
        }
    }

    if ($wait -gt 0) {
        $deadline = $startedAt.AddSeconds($wait)
        while ((Get-Date) -lt $deadline) {
            try {
                $proc.Refresh()
                if ($proc.HasExited) { break }
            } catch {
                break
            }
            Start-Sleep -Milliseconds 500
        }

        try {
            $proc.Refresh()
            $stillRunning = -not $proc.HasExited
            if (-not $stillRunning) { $exitCode = [int]$proc.ExitCode }
        } catch {
        }
    }

    $logFile = Get-LogFilePath -InstallRoot $InstallRoot -KindName 'maafw'
    $logTail = @()
    if ($wait -gt 0) {
        $tail = Get-LogTail -File $logFile -LineCount 8 -Filter ''
        if ($tail.ok) { $logTail = @($tail.lines) }
    }

    $result = [ordered]@{
        ok            = $true
        action        = 'run'
        root          = $InstallRoot
        configId      = [string]$target.id
        configName    = [string]$target.name
        args          = $arguments
        pid           = [int]$proc.Id
        startedAt     = $startedAt.ToString('o')
        waitedSeconds = $wait
        stillRunning  = $stillRunning
        exitCode      = $exitCode
        logFile       = $logFile
        logTail       = $logTail
    }

    if (-not $stillRunning) {
        $result.hint = 'mab.exe exited during the wait window (exit code ' + [string]$exitCode + '). Read the logs with -Action logs for the reason.'
    }

    return $result
}

function Invoke-StopAction {
    param([string]$InstallRoot)

    $runningPids = @(Get-MabProcessIds)

    if ($runningPids.Count -eq 0) {
        return [ordered]@{
            ok        = $true
            action    = 'stop'
            root      = $InstallRoot
            killed    = @()
            remaining = @()
            message   = 'No mab.exe process was running.'
        }
    }

    $killed = @()
    $failed = @()

    foreach ($pidValue in $runningPids) {
        $done = $false

        $kill = Invoke-NativeQuiet -FilePath 'taskkill.exe' -Arguments @('/PID', [string]$pidValue, '/T', '/F')
        if ($kill.ok) { $done = $true }

        if (-not $done) {
            try {
                Stop-Process -Id $pidValue -Force -ErrorAction Stop
                $done = $true
            } catch {
            }
        }

        if ($done) { $killed += $pidValue } else { $failed += $pidValue }
    }

    Start-Sleep -Milliseconds 800
    $remaining = @(Get-MabProcessIds)

    if ($remaining.Count -gt 0) {
        return (New-Err -Code 'MAA_STOP_FAILED' -Hint 'Some mab.exe processes are still running. Run this script from an elevated session and retry.' -Extra @{ killed = $killed; remaining = $remaining; failed = $failed })
    }

    return [ordered]@{
        ok        = $true
        action    = 'stop'
        root      = $InstallRoot
        killed    = $killed
        remaining = @()
        failed    = $failed
    }
}

function Invoke-LogsAction {
    param([string]$InstallRoot, [string]$KindName, [int]$LineCount, [string]$FilterValue)

    $kindKey = $KindName.ToLowerInvariant()
    if (@('maafw', 'gui', 'crash') -notcontains $kindKey) {
        return (New-Err -Code 'MAA_BAD_ARGS' -Hint '-Kind must be one of: maafw, gui, crash.')
    }

    $count = $LineCount
    if ($count -lt 1) { $count = $script:DefaultLogLines }
    if ($count -gt $script:MaxLogLines) { $count = $script:MaxLogLines }

    $file = Get-LogFilePath -InstallRoot $InstallRoot -KindName $kindKey
    $tail = Get-LogTail -File $file -LineCount $count -Filter $FilterValue

    if (-not $tail.ok) {
        $code = 'MAA_LOG_MISSING'
        if ([string]$tail.error -like 'MAA_BAD_FILTER*') { $code = 'MAA_BAD_FILTER' }
        return (New-Err -Code $code -Hint ([string]$tail.error) -Extra @{ kind = $kindKey; file = $file })
    }

    return [ordered]@{
        ok        = $true
        action    = 'logs'
        root      = $InstallRoot
        kind      = $kindKey
        file      = $file
        filter    = $FilterValue
        count     = [int]$tail.count
        lines     = @($tail.lines)
        sizeBytes = [long]$tail.sizeBytes
        lastWrite = [string]$tail.lastWrite
    }
}

function Invoke-PresetsAction {
    param([string]$InstallRoot)

    $ifaceInfo = Get-InterfaceInfo $InstallRoot
    if (-not $ifaceInfo.ok) {
        $code = 'MAA_INTERFACE_INVALID'
        if ([string]$ifaceInfo.error -like 'MAA_INTERFACE_MISSING*') { $code = 'MAA_INTERFACE_MISSING' }
        return (New-Err -Code $code -Hint ([string]$ifaceInfo.error) -Extra @{ file = [string]$ifaceInfo.file })
    }

    return [ordered]@{
        ok               = $true
        action           = 'presets'
        root             = $InstallRoot
        interface        = [string]$ifaceInfo.file
        version          = [string]$ifaceInfo.version
        interfaceVersion = [int]$ifaceInfo.interfaceVersion
        count            = @($ifaceInfo.presets).Count
        presets          = @($ifaceInfo.presets)
        controllers      = @($ifaceInfo.controllers)
    }
}

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

function Invoke-Main {
    param([string]$ActionName)

    $known = @('doctor', 'status', 'configs', 'get', 'run', 'stop', 'logs', 'presets')

    $normalized = ''
    if ($ActionName) { $normalized = $ActionName.ToLowerInvariant().Trim() }

    if ($normalized -eq 'help' -or $normalized -eq '-h' -or $normalized -eq '--help') {
        Write-JsonOut ([ordered]@{
                ok      = $true
                action  = 'help'
                actions = $known
                usage   = 'maa-bbb.ps1 -Action <doctor|status|configs|get|run|stop|logs|presets> [-ConfigId <id>] [-Root <path>] [-WaitSeconds <n>] [-Lines <n>] [-Kind <maafw|gui|crash>] [-Filter <regex>]'
            })
        return 0
    }

    if ($known -notcontains $normalized) {
        Write-JsonOut (New-Err -Code 'MAA_BAD_ARGS' -Hint ('-Action must be one of: ' + ($known -join ', ')) -ActionName $normalized)
        return 1
    }

    if ($normalized -eq 'logs') {
        $kindKey = $Kind.ToLowerInvariant()
        if (@('maafw', 'gui', 'crash') -notcontains $kindKey) {
            Write-JsonOut (New-Err -Code 'MAA_BAD_ARGS' -Hint '-Kind must be one of: maafw, gui, crash.' -ActionName $normalized)
            return 1
        }
    }

    if (($normalized -eq 'get' -or $normalized -eq 'run') -and -not $ConfigId) {
        Write-JsonOut (New-Err -Code 'MAA_CONFIG_ID_REQUIRED' -Hint ('-Action ' + $normalized + ' needs -ConfigId. Run -Action configs to list ids.') -ActionName $normalized)
        return 1
    }

    $resolved = Resolve-MaaRoot -ExplicitRoot $Root

    if (-not $resolved.ok -and $normalized -ne 'doctor') {
        Write-JsonOut (Get-NotInstalledResult -ResolveResult $resolved -ActionName $normalized)
        return 2
    }

    $root = [string]$resolved.root

    if ($normalized -eq 'doctor') {
        $result = Invoke-DoctorAction -Resolved $resolved
    } elseif ($normalized -eq 'status') {
        $count = $Lines
        if ($count -lt 1) { $count = $script:DefaultStatusLines }
        if ($count -gt $script:MaxLogLines) { $count = $script:MaxLogLines }
        $result = Invoke-StatusAction -InstallRoot $root -LineCount $count
    } elseif ($normalized -eq 'configs') {
        $result = Invoke-ConfigsAction -InstallRoot $root
    } elseif ($normalized -eq 'get') {
        $result = Invoke-GetAction -InstallRoot $root -ConfigId $ConfigId
    } elseif ($normalized -eq 'run') {
        $result = Invoke-RunAction -InstallRoot $root -ConfigId $ConfigId -WaitSecondsValue $WaitSeconds
    } elseif ($normalized -eq 'stop') {
        $result = Invoke-StopAction -InstallRoot $root
    } elseif ($normalized -eq 'logs') {
        $result = Invoke-LogsAction -InstallRoot $root -KindName $Kind -LineCount $Lines -FilterValue $Filter
    } else {
        $result = Invoke-PresetsAction -InstallRoot $root
    }

    Write-JsonOut $result
    return (Get-ExitCodeForResult $result)
}

try {
    $exitCode = Invoke-Main -ActionName $Action
    exit $exitCode
} catch {
    $detail = $_.Exception.Message
    $payload = [ordered]@{
        ok     = $false
        action = [string]$Action
        error  = 'MAA_SCRIPT_ERROR'
        hint   = 'Unexpected script error. Re-run -Action doctor and check the message.'
        detail = $detail
    }
    try { Write-JsonOut $payload } catch {
    }
    exit 1
}
