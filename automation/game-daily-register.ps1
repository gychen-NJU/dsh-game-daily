param(
  [Parameter(Mandatory = $true)][string]$StateDir,
  [switch]$DryRun,
  [switch]$Remove,
  [switch]$All,
  [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'
$autoDir = Join-Path $StateDir 'automation'
$cfgPath = Join-Path $autoDir 'tasks.json'
$resultPath = Join-Path $autoDir 'register-result.json'
$logPath = Join-Path $autoDir 'register.log'

New-Item -ItemType Directory -Force -Path $autoDir | Out-Null

function Write-Log([string]$message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'o'), $message
  try { Add-Content -Path $logPath -Value $line -Encoding UTF8 } catch { }
  Write-Host $line
}

function Write-Result($value) {
  $json = $value | ConvertTo-Json -Depth 8
  Set-Content -Path $resultPath -Value $json -Encoding UTF8
}

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principalCheck = New-Object Security.Principal.WindowsPrincipal($identity)
$isAdmin = $principalCheck.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Log "start admin=$isAdmin dryRun=$($DryRun.IsPresent) remove=$($Remove.IsPresent) all=$($All.IsPresent)"

if (-not $isAdmin -and -not $DryRun.IsPresent -and -not $NoElevate.IsPresent) {
  Write-Log 'not elevated; relaunch via UAC and wait'
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-StateDir', $StateDir)
  if ($Remove.IsPresent) { $argList += '-Remove' }
  if ($All.IsPresent) { $argList += '-All' }
  try {
    $exe = (Get-Process -Id $PID).Path
    $child = Start-Process -FilePath $exe -Verb RunAs -ArgumentList $argList -PassThru -WindowStyle Hidden
    $child.WaitForExit(600000) | Out-Null
    Write-Log "elevated exit code $($child.ExitCode)"
    $deadline = (Get-Date).AddSeconds(30)
    while (-not (Test-Path $resultPath) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
    if (-not (Test-Path $resultPath)) {
      Write-Result @{ ok = $false; elevated = $true; error = 'elevated run produced no result'; at = (Get-Date).ToString('o') }
    }
  } catch {
    Write-Log "elevation failed: $($_.Exception.Message)"
    Write-Result @{ ok = $false; elevated = $false; error = [string]$_.Exception.Message; at = (Get-Date).ToString('o') }
  }
  exit 0
}

if (-not (Test-Path $cfgPath)) {
  Write-Log "config missing: $cfgPath"
  Write-Result @{ ok = $false; error = "tasks.json missing: $cfgPath"; at = (Get-Date).ToString('o') }
  exit 1
}

$cfg = Get-Content -Path $cfgPath -Raw -Encoding UTF8 | ConvertFrom-Json
$games = @($cfg.games)
$results = @()
$failed = 0
$userName = $identity.Name

foreach ($game in $games) {
  $entry = [ordered]@{
    id = [string]$game.id
    taskName = [string]$game.taskName
    enabled = [bool]$game.enabled
    time = [string]$game.time
    action = 'skipped'
    error = ''
  }
  $taskName = [string]$game.taskName
  if (-not $taskName) {
    $entry.action = 'skipped'
    $entry.error = 'empty taskName'
    $results += $entry
    continue
  }
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  $shouldRemove = $Remove.IsPresent -or ($game.enabled -ne $true)
  try {
    if ($shouldRemove) {
      if ($existing) {
        if ($DryRun.IsPresent) {
          $entry.action = 'would-remove'
        } else {
          Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
          $entry.action = 'removed'
        }
      } else {
        $entry.action = 'absent'
      }
      $results += $entry
      continue
    }

    $timeParts = ([string]$game.time).Split(':')
    if ($timeParts.Count -ne 2) { throw "bad time: $($game.time)" }
    $at = (Get-Date).Date.AddHours([int]$timeParts[0]).AddMinutes([int]$timeParts[1])

    if ($game.weekdays -is [array] -and @($game.weekdays).Count -gt 0) {
      $names = @()
      foreach ($d in @($game.weekdays)) {
        switch ([int]$d) {
          1 { $names += 'Monday' }
          2 { $names += 'Tuesday' }
          3 { $names += 'Wednesday' }
          4 { $names += 'Thursday' }
          5 { $names += 'Friday' }
          6 { $names += 'Saturday' }
          7 { $names += 'Sunday' }
        }
      }
      $trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $names -At $at
      $entry.action = 'weekly'
    } else {
      $trigger = New-ScheduledTaskTrigger -Daily -At $at
      $entry.action = 'daily'
    }

    # Guard: a desktop host may report its own Electron exe as process.execPath.
    # Registering that would silently launch a second host instance that exits at once.
    $nodeExe = [string]$cfg.nodeExe
    if ($nodeExe -and ([IO.Path]::GetFileName($nodeExe) -notmatch '^(node|node\.exe)$')) { $nodeExe = '' }
    if (-not $nodeExe) { $nodeExe = (Get-Command node.exe -ErrorAction SilentlyContinue).Source }
    $runner = [string]$cfg.runnerScript
    if (-not $nodeExe) { throw 'node.exe not found' }
    if (-not $runner) { throw 'runnerScript missing in tasks.json' }
    $mode = 'real'
    if ($game.mode -and ([string]$game.mode).ToLowerInvariant() -eq 'dry') { $mode = 'dry' }
    # Watchdog budget: run-headless.mjs stops itself 5 minutes before this, writes a
    # fallback report and exits, so the scheduler never has to kill the process tree.
    $budget = [int]$game.timeoutMin
    if ($budget -le 0) { $budget = 90 }
    $argument = '"{0}" --game {1} --state-dir "{2}" --profile {3} --mode {4} --timeout-min {5}' -f $runner, $game.id, $StateDir, ([string]$cfg.profile), $mode, $budget
    if ($cfg.skillsRoot) { $argument += ' --skills-root "{0}"' -f [string]$cfg.skillsRoot }
    $action = New-ScheduledTaskAction -Execute $nodeExe -Argument $argument -WorkingDirectory $StateDir

    $catchUp = [bool]$game.catchUp
    $limit = New-TimeSpan -Minutes ($budget + 10)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable:$catchUp -WakeToRun -MultipleInstances IgnoreNew -ExecutionTimeLimit $limit
    $principal = New-ScheduledTaskPrincipal -UserId $userName -LogonType Interactive -RunLevel Highest

    if ($DryRun.IsPresent) {
      $entry.action = 'would-register'
    } else {
      Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force -ErrorAction Stop | Out-Null
      $entry.action = if ($existing) { 'updated' } else { 'created' }
    }
  } catch {
    $entry.action = 'error'
    $entry.error = [string]$_.Exception.Message
    $failed++
    Write-Log "task $taskName failed: $($entry.error)"
  }
  $results += $entry
}

$payload = [ordered]@{
  ok = ($failed -eq 0)
  at = (Get-Date).ToString('o')
  dryRun = $DryRun.IsPresent
  elevated = $isAdmin
  configPath = $cfgPath
  tasks = $results
}
Write-Result $payload
if ($DryRun.IsPresent) { Write-Host ($payload | ConvertTo-Json -Depth 8) }
Write-Log ("done ok={0} failed={1}" -f $payload.ok, $failed)
if ($failed -gt 0) { exit 1 }
exit 0
