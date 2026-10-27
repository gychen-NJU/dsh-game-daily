# dsh-game-daily · Game Daily

[简体中文](README.md) | **English**

A DSH desktop plugin that puts the daily automation of **Genshin Impact / Honkai Impact 3rd / Honkai: Star Rail** into one panel in Settings — switch games at the top, toggle a per-game daily-agent switch that is **off by default**, set a schedule per game, and once saved the plugin creates Windows Scheduled Tasks that run the daily routine unattended. When a run finishes you get a Windows notification and (optionally) a new session that reports the result.

## Install

**From source (recommended):** clone the repo to any local directory, then point Harness's `plugin_manager` at that directory (it performs the package install and bundle selection itself; do **not** hand-edit the profile's `package.json` / `cordis.patch.yml`):

```powershell
git clone https://github.com/gychen-NJU/dsh-game-daily.git
```

```
plugin_manager  action: install_bundle  target: <the cloned dsh-game-daily directory>
```

**Development** (link into a profile; code changes take effect after restarting the desktop app):

```powershell
dsh plugin --profile web add link:<this repo directory>
```

After installing: **Settings → Game Daily**. The package declares `dsh.bundle.patch` and `dsh.client`, so `dsh-game-daily` shows up in the profile's `dsh.profile.bundles`.

### Hand it to an agent (one sentence)

Send this to your DSH agent:

> Install https://github.com/gychen-NJU/dsh-game-daily into my DSH desktop app: clone it locally, run plugin_manager install_bundle against that directory, then confirm "Settings → Game Daily" shows up and run the dependency check — fix anything it reports as missing.

The agent will clone, install the bundle, verify activation, and use the built-in dependency check to fill in external requirements (BetterGI, computer-use, skills, ...).

## What the panel does

- **Game tabs**: Genshin Impact / Honkai Impact 3rd / Honkai: Star Rail / Zenless Zone Zero (driven by ZenlessZoneZero-OneDragon).
- **Daily-agent switch (off by default)**: schedule and run settings appear only after you turn it on. Edits stay in a local draft; nothing is written and no task is (re)created until you press **Save & Apply**.
- **Schedule**: daily time, run days (every day / specific weekdays), timeout, mode (real run / dry-run diagnosis only), catch-up on missed runs, open a report session after each run, game path (Genshin can point at `BetterGI.exe`). Timeout means how long one run may take (5–180 min; defaults: Genshin 150, HI3/Star Rail 45). The scheduler's execution time limit is set to timeout + 10 min, and the watchdog spends the 5-minute margin on finalizing the run itself.
- **Dependency check**: dsh CLI, DSH version, headless runner (including the credentials patch), computer-use plugin, skill files, coordinate calibration, elevation helper, BetterGI, the bettergi-control skill, the bettergi-mcp script, and the bettergi MCP registration. Every missing item gets a **"Let DSH fix it"** button: one-click items (install the bundled bettergi-control skill, register the MCP row) run directly and the button turns into **Working…**; multi-step or privileged repairs open a new DSH session with the repair steps (including backup/read-back requirements) and switch the UI to it.
- **Run once / Stop / Disable all**: "Run once" uses the saved configuration; "Stop" kills that game's headless run; "Disable all" removes every scheduled task.
- **Recent runs**: reads `report.json` (status, mode, steps, evidence, conclusion) plus the tail of stdout.

## Execution pipeline

```
Settings panel ──POST /api/game-daily/apply──▶ state.json + automation/tasks.json
                                                  │
                                                  └─▶ automation/game-daily-register.ps1 (one UAC)
                                                         └─▶ Windows Scheduled Task game-daily-<game>
                                                                fires daily at HH:MM
                                                                │
                                                                ▼
                                                node automation/run-headless.mjs --game <id>
                                                                │  spawn
                                                                ▼
                                  dsh --profile headless --patch automation/headless-overlay.yml "<prompt>"
                                                                │
                                                                ▼
                             runs the skills (Genshin → bettergi-control; HI/SR → game-daily-*)
                                                                │
                                                                ▼
                             <stateDir>/runs/<game>/<runId>/{meta.json,report.json,stdout.log,screens/}
                                                                │  plugin reconciles every 60s
                                                                ▼
                                        record history → Windows toast → (optional) report session
```

- On the headless side, `--patch` layers an overlay that injects the bettergi MCP (needed by Genshin), and `DSH_PERMISSION_MODE=danger-full-access` makes the run unattended. HI/SR use the elevation helper (`scripts/run-step.mjs --ps`) when computer-use is unavailable.
- The report is the only source of truth: `report.json`'s `status` is `success / partial / failed / timeout`; the plugin never guesses from process exit codes.
- **Watchdog**: `run-headless.mjs` stops the headless run at "timeout − 5 min", writes a fallback `report.json` (`status=timeout`) and exits, so the OS time limit never kills the tree with nothing left behind.
- **Fallback reconcile**: if even that report is missing (manual kill or crash), reconcile records a `failed` run and notifies after the process is gone and a 3-minute grace period has passed — no more silent runs.
- **Foreground guard**: each run starts a 1-second-poll guard process from `automation/keep-foreground.ps1`. If the game window loses foreground, it is pulled back immediately (four levels of fallback: `SetForegroundWindow` → `AttachThreadInput` → simulated Alt → `SwitchToThisWindow`). It exits when the run ends/stops via a `.stop` file; logs go to `<stateDir>/automation/guard-<game>.log`. There is a **Foreground guard** toggle in the schedule card (`ui.foregroundGuard`, on by default).
- **Process cleanup (real mode)**: when a run finishes, the plugin closes that game's process (for Genshin it also closes `BetterGI.exe`) to save background resources. Before a new run starts it closes any other game process (`Get-Process` + `Stop-Process -Force`); if the previous run is still active, the scheduled run waits for it to finish (up to 20 minutes by default, tunable via `DSH_GAME_DAILY_WAIT_MS`) instead of fighting over the game window. Dry mode never touches processes.

## HTTP API (host side, prefix `/api/game-daily`)

| Method | Path | Description |
| --- | --- | --- |
| GET | `/state` | All game states + task summaries (scheduled-task info is cached and never blocks) |
| GET | `/probe?games=genshin,hi` | Dependency check results |
| POST | `/ui` | Save UI preferences (e.g. `lastGame`, `reportSessions`) |
| POST | `/apply` | Save schedules and rebuild scheduled tasks; `{dryRun:true}` only prints what would be registered |
| POST | `/disable` | Remove one game's (or all) scheduled tasks and turn the switch off |
| POST | `/run` | Run once now: `{game, mode:'real'|'dry'}` |
| POST | `/stop` | Stop that game's running process |
| POST | `/run-task` | Fire the registered scheduled task immediately (via Task Scheduler, not the plugin) |
| POST | `/install` | Create a repair session: `{check:'bettergi'}` or `{action:'fix-headless-credentials'}` |
| GET | `/runs?game=genshin` | Run history summaries |
| GET | `/run?id=<runId>` | Full report/meta/stdout of one run |
| GET | `/update` | Check for updates: `{current, latest, hasUpdate, repo, releases, checkedAt}` (30 min cache, `?force=1` to refresh) |
| POST | `/update` | Update now: `git pull --ff-only` when `.git` exists, otherwise download the zip and overwrite; returns `{from, to, method, restartRequired}` |
| POST | `/reconcile` | Trigger one reconciliation manually (normally every 60s) |

## Data location

- State and run artifacts: `$DSH_HOME/game-daily/` (default `%USERPROFILE%\.dsh\game-daily`)
  - `state.json` (atomic writes), `runs/<game>/<runId>/`, `automation/{tasks.json,game-daily-register.ps1,register-result.json,headless-overlay.yml,run-headless.log}`, `notifications.log`

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `DSH_HOME` | `%USERPROFILE%\.dsh` | DSH home directory |
| `DSH_PROFILE` | `desktop` | Profile used to check headless / plugins |
| `DSH_SKILLS_ROOT` | `%USERPROFILE%\.agents\skills` | Skill directory (game-daily family) |
| `DSH_GAME_DAILY_DEV` | — | `1` = dev isolation: state dir gains `/dev`, task prefix `game-daily-dev-` |
| `DSH_GAME_DAILY_STATE_DIR` | `$DSH_HOME/game-daily` | Override the state directory |
| `DSH_GAME_DAILY_TASK_PREFIX` | `game-daily-` | Override the scheduled-task name prefix |
| `DSH_GAME_DAILY_BETTERGI_MCP` | auto-resolved (see below) | Explicit path to the bettergi MCP server script (highest priority) |
| `DSH_GAME_DAILY_BETTERGI` | `C:\software\BetterGI\BetterGI.exe` | BetterGI install path (used by the dependency check) |

## Bundled tools (bettergi-mcp / bettergi-control)

So that "install the plugin = all tools present", both Genshin companion tools **ship inside the plugin package**:

| Location | Content |
| --- | --- |
| `tools/bettergi-mcp/bettergi-mcp.mjs` | the MCP server exposing the Genshin `bgi_*` tools (single file, zero dependencies, ~100KB, 29 tools) |
| `tools/bettergi-control/` | the bettergi-control skill (`SKILL.md` + `references/` + 15 `bgi-*.ps1` scripts) |

- **bettergi-mcp**: the dependency check reports "ready (bundled)"; **Register bettergi MCP** just appends a `dsh-mcp-client` entry to the current profile's `cordis.patch.yml` (backed up as `cordis.patch.yml.bak-gd-<timestamp>`, read back and verified, skipped when already present). Restart DSH to load it — **no network access needed**.
- **bettergi-control**: when `%USERPROFILE%\.agents\skills\bettergi-control\SKILL.md` is missing (or has fewer than 10 scripts), the panel shows **Install bettergi-control (bundled)**; one click is a **pure local copy** (the old directory is backed up as `bettergi-control.bak-<timestamp>`) — **no network access needed**. Override the skill directory with `DSH_SKILLS_ROOT`.
- The remote repositories [`gychen-NJU/bettergi-mcp`](https://github.com/gychen-NJU/bettergi-mcp) and [`gychen-NJU/bettergi-control`](https://github.com/gychen-NJU/bettergi-control) are only the **upstream source / update channel**: the plugin only goes to GitHub when its bundled copy is missing (an incomplete install), to fetch the single file (mcp) or zip (skill) as a fallback.
- Resolution order (bettergi-mcp): `DSH_GAME_DAILY_BETTERGI_MCP` env → `<stateDir>/vendor` (manual override/update) → **bundled copy** → sibling `dsh-betterGI` workspace (developer layout).
- Cloning for updates still works: `git clone https://github.com/gychen-NJU/bettergi-mcp`, then `DSH_GAME_DAILY_BETTERGI_MCP=<clone dir>\bettergi-mcp.mjs`.

## Where Zenless Zone Zero comes from (OneDragon)

All screen recognition and clicking for ZZZ is delegated to [ZenlessZoneZero-OneDragon](https://github.com/OneDragon-Anything/ZenlessZoneZero-OneDragon) ("one-dragon"). It runs a local HTTP backend (default `http://127.0.0.1:23001`). The plugin bundles a **zero-dependency MCP server** at `tools/zzz-od-mcp/zzz-od-mcp.mjs` that wraps that backend into agent tools (`mcp__zzz-od__*`, 12 of them: health/status/window/applications/operations/enter/run_one_dragon/run_app/wait/stop/close_game/server).

- **Ships with the plugin**: the MCP server, `automation/zzz-server.ps1` (elevated start/stop of the backend) and `skills/zzz-od-control/SKILL.md` are all inside the package — nothing is fetched from another repository.
- **OneDragon itself can be installed in one click**: when the ZZZ dependency check reports it missing, pressing "Let DSH fix this" runs `git clone` (or a zip download when git is absent) + `uv sync` + writes the base config (`config/01/game.yml`, `game_account.yml`). It installs to `D:\software\ZenlessZoneZero-OneDragon` by default and **never into the system drive**; set `DSH_GAME_DAILY_ZZZ_ROOT` to choose another location (C: is still rejected). The first install downloads hundreds of MB and takes a few minutes, so the button keeps showing "Working…". The chosen root is recorded in `<stateDir>/zzz-root.txt` and used by later checks and runs.
- **Privileges**: ZZZ runs elevated, so switching its window / sending input needs an **elevated backend**. When the dependency check finds it down, it offers **Start OneDragon backend (one UAC)**; the runner also tries to start it before a real run.
- **Flow**: `zzz_health → zzz_window → (zzz_enter if the window is not ready) → zzz_run_one_dragon → zzz_wait in a loop → zzz_status`; after the run the plugin closes the game and stops the backend. Known trap: running one-dragon while the game sits on the title screen makes the first app (mail) fail with "cannot recognise the screen", so `zzz_enter` first.
## Auto-update

The settings panel opens with a version bar that **reads the latest `package.json` from GitHub** and compares it with the local version.

- When the remote is newer the bar turns amber with "Update available vX.Y.Z" and offers **Update now** / Later / Release notes. Updating runs `git pull --ff-only` for git installs, or downloads the zip and overwrites plugin files when git is absent (`node_modules` and user data are untouched).
- Up to date: the bar only shows "Version vX.Y.Z · You are on the latest version" plus a **Check for updates** link (30 min cache, click forces a refresh).
- Files are swapped on disk, so **restart the DSH desktop app** to load the new code (scheduled tasks spawn a fresh node process each run and are unaffected).
- Version comparison handles `x.y.z` and `x.y.z-pre` (a prerelease sorts lower); a failed check is reported inline instead of throwing.

## Dependencies and boundaries

- Genshin: BetterGI (default `C:\software\BetterGI`, editable in the panel) + **bundled** bettergi-control skill and bettergi-mcp (above). BetterGI has no HTTP API — it can only be driven by command line / script groups.
- Zenless Zone Zero: ZenlessZoneZero-OneDragon (default `D:\software\ZenlessZoneZero-OneDragon`, auto-installable when missing) + an elevated one-dragon backend. The MCP server and skill ship with this plugin; the game itself still has to be installed.
- HI / SR: the `game-daily` skill family + the elevation helper (switch to computer-use per the skill docs when synthetic clicks are filtered).
- There is **no background/AFK mode**: Genshin must be visible and in the foreground at 16:9 ≥ 1920×1080; a locked screen will fail.
- Registering scheduled tasks and running BetterGI require one UAC confirmation; the panel says so next to the button.
- Account risk depends on how you use it: the official terms list third-party software / simulated input as grounds for a ban. Use it discreetly.

## Development

```powershell
node test/smoke.mjs          # pure-Node smoke test (no network, no UAC)
node --check index.js        # syntax check
```

`lib/` is pure Node with no third-party dependencies; `client.js` is a Harness lazy client factory (`window.__ModuleLoader__.load`) that registers exactly one slot: `settings.section`.

## License

[MIT](LICENSE) © 2026 gychen-NJU
