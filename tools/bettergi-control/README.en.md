# bettergi-control

An AI-agent skill (and a plain PowerShell toolkit) for driving **BetterGI** — the Genshin Impact automation tool — with natural language.

- Start the game + capturer, run the "one dragon" daily chain, run script groups, gather materials
- Change config / party / resin, inspect failures, read results and schedules
- Every script supports `-Json` (machine-readable) and `-DryRun` (preview), with consistent exit codes: 0 ok / 1 failed-or-no-match / 2 precondition or argument problem

> Dependency of [dsh-game-daily](https://github.com/gychen-NJU/dsh-game-daily): the plugin's dependency check installs this skill into `%USERPROFILE%\.agents\skills\bettergi-control` on demand.

## Install

```powershell
git clone https://github.com/gychen-NJU/bettergi-control "$env:USERPROFILE\.agents\skills\bettergi-control"
```

Or click the fix button next to the skill check in DSH Settings → Game Daily → Genshin.

## Requirements

| Requirement | Notes |
| --- | --- |
| BetterGI 0.66.x | Default `D:\software\BetterGI`; every script accepts `-Root` |
| PowerShell 5.1 | Scripts are UTF-8 **with BOM**; keep the BOM or Chinese text breaks under PS 5.1 |
| Windows 10/11 | Needs Task Scheduler, window APIs; Genshin must be 16:9, ≥1920×1080, visible and foreground |

## Scripts

`bgi-status` · `bgi-doctor` · `bgi-run` · `bgi-watch` · `bgi-wait` · `bgi-log` · `bgi-results` · `bgi-schedule` · `bgi-config` · `bgi-group` · `bgi-strategy` · `bgi-collect` · `bgi-fetch-route` · `bgi-focus-game` · `bgi-close` — see `SKILL.md` for usage.

## MCP version

[gychen-NJU/bettergi-mcp](https://github.com/gychen-NJU/bettergi-mcp) — 29 `bgi_*` tools over stdio, single file, no dependencies.

## Safety

No game-file edits, no memory access, no unaudited third-party scripts, no paid/delete/reset buttons; never write BetterGI config while it is running. Account risk is your own call.

## License

MIT © 2026 gychen-NJU
