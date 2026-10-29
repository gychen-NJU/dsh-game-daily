# dsh-game-daily · 游戏日常

**简体中文** | [English](README.en.md)

DSH 桌面端插件：把「原神 / 崩坏3 / 崩坏：星穹铁道」的每日自动化收进设置页一个面板里 —— 顶部切游戏、每游戏一个默认关闭的代理开关、按游戏配排班，保存后自动建立 Windows 计划任务，到点无人值守地跑一轮日常，跑完弹通知并（可选）开一个会话向你汇报。

## 安装

从源码安装（推荐）：先把仓库 clone 到本地任意目录，再让 Harness 的 `plugin_manager` 指向该目录（它自己完成 package 安装与 bundle 选择；**不要**手写 profile 的 `package.json` / `cordis.patch.yml`）：

```powershell
git clone https://github.com/gychen-NJU/dsh-game-daily.git
```

```
plugin_manager  action: install_bundle  target: <clone 下来的 dsh-game-daily 目录>
```

开发期（link 到某个 profile，改代码即时生效；改完仍需重启桌面端才会重新加载代码）：

```powershell
dsh plugin --profile web add link:<本仓库目录>
```

装好后：设置 → 游戏日常。插件包声明了 `dsh.bundle.patch` 与 `dsh.client`，profile 的 `dsh.profile.bundles` 会列出 `dsh-game-daily`。

### 交给 Agent 安装（一句话）

把下面这句直接发给你的 DSH Agent：

> 帮我把 https://github.com/gychen-NJU/dsh-game-daily 装进当前 DSH 桌面端：clone 到本地目录后用 plugin_manager install_bundle 指向该目录，装完确认「设置 → 游戏日常」出现并跑一次依赖体检，缺什么按提示修好。

Agent 会自己完成 clone、`install_bundle`、确认插件已激活，并按依赖体检结果补齐 BetterGI / computer-use / 技能等外部条件。

## 面板里能做什么

- **顶部游戏页签**：原神 / 崩坏3 / 崩坏：星穹铁道 / 绝区零（走 ZenlessZoneZero-OneDragon「一条龙」）。
- **代理日常开关（默认关）**：打开后才出现排班与执行设置；改动先落在本地草稿，点「保存并应用」才写盘并重建计划任务。
- **排班**：每天时间、执行日（每天 / 指定星期）、超时、模式（真实执行 / 演练只诊断）、错过补跑、跑完开一个会话汇报、游戏路径（原神可指定 `BetterGI.exe`）。超时指「一轮最多跑多久」（5–180 分钟，默认原神 150、崩3/星铁 45）；计划任务的系统执行时限会自动设为「超时 + 10 分钟」，而那 5 分钟的余量留给插件自己收尾。
- **依赖体检**：dsh CLI、DSH 版本、headless 运行器（含 credentials 补丁）、computer-use 插件、技能文件、坐标校准、提权助手、BetterGI、bettergi-control 技能、bettergi-mcp 脚本、bettergi MCP 注册；选到绝区零时另加「一条龙安装 / 一条龙后端」。缺任何一项都给出「让 DSH 修这个」按钮：能自动做的（下载 bettergi-mcp、安装 bettergi-control、注册 MCP 配置、启动一条龙后端）点一下直接做，按钮会变成「处理中…」；需要多步操作或权限的才新开一个 DSH 会话，把修复步骤（含备份/回读要求）交给 Harness 执行，并把界面切过去。
- **立即运行一次 / 停止 / 关闭全部代理**：立即运行走「已保存」的配置；停止会杀掉该游戏的 headless 运行进程；关闭全部代理会移除所有计划任务。
- **最近运行**：读取 `report.json`（状态、模式、步骤、证据、结论）与 stdout 尾部。

## 执行链路

```
设置页 ──POST /api/game-daily/apply──▶ 写 state.json + automation/tasks.json
                                              │
                                              └─▶ automation/game-daily-register.ps1（提权一次）
                                                     └─▶ Windows 计划任务 game-daily-<game>
                                                            每天 HH:MM 触发
                                                            │
                                                             ▼
                                             node automation/run-headless.mjs --game <id>
                                                            │  spawn
                                                            ▼
                              dsh --profile headless --patch automation/headless-overlay.yml "<prompt>"
                                                            │
                                                            ▼
                                 按技能执行（原神走 bettergi-control；崩3/星铁走 game-daily-*）
                                                            │
                                                            ▼
                                  <stateDir>/runs/<game>/<runId>/{meta.json,report.json,stdout.log,screens/}
                                                            │  插件每 60s reconcile
                                                            ▼
                                        记录历史 → Windows 通知 → （可选）在每个游戏**固定一个**汇报会话里追加结果（首次创建，之后复用；会话被删会自动重建）
```

- headless 侧通过 `--patch` 叠加 overlay 注入 bettergi MCP（原神需要），并带 `DSH_PERMISSION_MODE=danger-full-access` 实现无人值守；崩3/星铁没有 wincu 时按技能说明用提权助手（`scripts/run-step.mjs --ps`）。
- 报告是唯一判定依据：`report.json` 的 `status` 为 `success / partial / failed / timeout`；插件只认这个文件，不猜进程退出码。
- **看门狗**：`run-headless.mjs` 在「超时 − 5 分钟」到点时会主动停掉 headless、写一份兜底 `report.json`（`status=timeout`）再退出，避免被系统执行时限强杀后什么都不留下。
- **兜底对账**：如果某轮连兜底报告都没写（比如被手动结束或崩溃），reconcile 会在进程确已退出、且已过 3 分钟宽限后，补一条 `failed` 历史并发通知，不再静默。
- **前台守护**：每轮运行开始时，插件从 `automation/keep-foreground.ps1` 起一个 1 秒轮询的守护进程，游戏窗口被别的窗口抢走时立即拉回（四级回退：`SetForegroundWindow` → AttachThreadInput → 模拟 Alt → `SwitchToThisWindow`），结束/停止时写 `.stop` 自动退出；日志在 `<stateDir>/automation/guard-<game>.log`。面板排班卡里有「前台守护」开关（`ui.foregroundGuard`，默认开）。
- **进程收尾（真实模式）**：一轮跑完会关掉该游戏的进程（原神连同 `BetterGI.exe`），减少后台占用；开始新一轮前会先关掉其它游戏（`Get-Process` + `Stop-Process -Force`），若上一轮还在跑，计划任务会等它收尾（默认最多 20 分钟，`DSH_GAME_DAILY_WAIT_MS` 可调）而不是两边互相抢窗口。演练模式不动任何进程。

## HTTP 接口（Host 侧，前缀 `/api/game-daily`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/state` | 全部游戏状态 + 任务摘要（计划任务信息走缓存，不阻塞） |
| GET | `/probe?games=genshin,hi` | 依赖体检结果 |
| POST | `/ui` | 保存界面偏好（如 `lastGame`、`reportSessions`） |
| POST | `/apply` | 保存排班并重建计划任务；`{dryRun:true}` 只打印将注册的动作、不落盘 |
| POST | `/disable` | 移除某游戏（或全部）计划任务并关闭开关 |
| POST | `/run` | 立即运行一次：`{game, mode:'real'|'dry'}` |
| POST | `/stop` | 停止该游戏的运行进程 |
| POST | `/run-task` | 立刻触发已注册的计划任务（由任务管理器跑，而不是插件直启） |
| POST | `/install` | 修复动作：`{action:'install-bettergi-skill'}` 装技能、`{action:'install-bettergi-mcp'}` 下载+注册、`{action:'fix-bettergi-mcp'}` 只注册；其它 action 生成修复会话 |
| GET | `/runs?game=genshin` | 历史运行摘要 |
| GET | `/run?id=<runId>` | 单次运行的 report/meta/stdout 全文 |
| GET | `/update` | 检查更新：返回 `{current, latest, hasUpdate, repo, releases, checkedAt}`（30 分钟缓存，`?force=1` 强制刷新） |
| POST | `/update` | 立即更新：有 `.git` 走 `git pull --ff-only`，否则下载 zip 覆盖；返回 `{from, to, method, restartRequired}` |
| POST | `/reconcile` | 手动触发一次对账（平时每 60s 自动跑） |

## 数据位置

- 状态与运行产物：`$DSH_HOME/game-daily/`（默认 `%USERPROFILE%\.dsh\game-daily`）
  - `state.json`（原子写）、`runs/<game>/<runId>/`、`automation/{tasks.json,game-daily-register.ps1,register-result.json,headless-overlay.yml,run-headless.log}`、`notifications.log`

## 环境变量

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `DSH_HOME` | `%USERPROFILE%\.dsh` | DSH 主目录 |
| `DSH_PROFILE` | `desktop` | 用来检查 headless / 插件的 profile 名 |
| `DSH_SKILLS_ROOT` | `%USERPROFILE%\.agents\skills` | 技能目录（game-daily 家族） |
| `DSH_GAME_DAILY_DEV` | — | `1` = 开发隔离：状态目录加 `/dev`、任务前缀 `game-daily-dev-` |
| `DSH_GAME_DAILY_STATE_DIR` | `$DSH_HOME/game-daily` | 覆盖状态目录 |
| `DSH_GAME_DAILY_TASK_PREFIX` | `game-daily-` | 覆盖计划任务名前缀 |
| `DSH_GAME_DAILY_BETTERGI_MCP` | 自动解析（见下） | bettergi MCP 服务器脚本的显式路径（优先级最高） |
| `DSH_GAME_DAILY_BETTERGI` | `D:\software\BetterGI\BetterGI.exe` | BetterGI 安装位置（体检用） |

## 随插件自带的工具（bettergi-mcp / bettergi-control）

为了让「装好插件 = 工具齐全」，两份原神配套工具**直接打进插件包**，安装插件时就已经在：

| 位置 | 内容 |
| --- | --- |
| `tools/bettergi-mcp/bettergi-mcp.mjs` | 原神 `bgi_*` 工具的 MCP 服务器（单文件、零依赖，约 100KB，29 个工具） |
| `tools/bettergi-control/` | bettergi-control 技能（`SKILL.md` + `references/` + 15 个 `bgi-*.ps1`） |

- **bettergi-mcp**：面板体检直接判「已就位（插件自带）」；点「注册 bettergi MCP」只是把一条 `dsh-mcp-client` 配置追加到当前 profile 的 `cordis.patch.yml`（先备份成 `cordis.patch.yml.bak-gd-<时间戳>`，写后回读校验，已存在则不重复写），重启 DSH 生效——**不需要联网**。
- **bettergi-control**：体检发现 `%USERPROFILE%\.agents\skills\bettergi-control\SKILL.md` 缺失（或脚本不足 10 个）时，面板给出「安装 bettergi-control（插件自带）」按钮；点一下就是**纯本地目录拷贝**（旧目录备份成 `bettergi-control.bak-<时间戳>`），**不联网**。技能目录可用 `DSH_SKILLS_ROOT` 覆盖。
- 远程仓库 [`gychen-NJU/bettergi-mcp`](https://github.com/gychen-NJU/bettergi-mcp) 与 [`gychen-NJU/bettergi-control`](https://github.com/gychen-NJU/bettergi-control) 只作为**上游来源/更新通道**：只有当插件内的自带副本缺失（安装不完整）时，插件才会去 GitHub 取单文件（mcp）或 zip（skill）兜底。
- 解析优先级（bettergi-mcp）：`DSH_GAME_DAILY_BETTERGI_MCP` 环境变量 → 状态目录 `vendor/`（手动覆盖/更新）→ **插件自带副本** → 同级 `dsh-betterGI` 工作区（开发机布局）。
- 想自己 clone 更新也可以：`git clone https://github.com/gychen-NJU/bettergi-mcp`，然后 `DSH_GAME_DAILY_BETTERGI_MCP=<clone 目录>\bettergi-mcp.mjs`。

## 绝区零从哪来（一条龙）

绝区零的画面识别与点击交给 [ZenlessZoneZero-OneDragon](https://github.com/OneDragon-Anything/ZenlessZoneZero-OneDragon)（下称「一条龙」）。它在本机跑一个 HTTP 后端（默认 `http://127.0.0.1:23001`），插件自带一个**零依赖 MCP 服务器** `tools/zzz-od-mcp/zzz-od-mcp.mjs`，把这个后端包装成 agent 可调用的工具（`mcp__zzz-od__*`，12 个：health/status/window/applications/operations/enter/run_one_dragon/run_app/wait/stop/close_game/server）。

- **随插件分发**：MCP 服务器、`automation/zzz-server.ps1`（提权启动/停止后端）、技能说明 `skills/zzz-od-control/SKILL.md` 都在插件包里，不需要额外从别的仓库拉取。
- **一条龙本体可一键自动安装**：体检里「绝区零一条龙」缺失时，点「让 DSH 修复」会自动 `git clone`（没有 git 就下 zip）+ `uv sync` + 写基础配置（`config/01/game.yml`、`game_account.yml`）。默认装到 `D:\software\ZenlessZoneZero-OneDragon`，**不会装进系统盘**；可用 `DSH_GAME_DAILY_ZZZ_ROOT` 指定别的位置（同样拒绝 C 盘）。首次安装要下几百 MB、耗时几分钟，按钮会一直显示「处理中…」。装完位置会记录到 `<stateDir>/zzz-root.txt`，后续体检与运行都以它为准。
- **权限**：绝区零以管理员运行，切窗口/发输入需要**提权的一条龙后端**。体检里「一条龙后端」不在跑时给「启动一条龙后端（会弹一次 UAC）」按钮；真实运行前 runner 也会自动尝试启动。
- **流程**：`zzz_health → zzz_window →（窗口无效时 zzz_enter）→ zzz_run_one_dragon → 循环 zzz_wait → zzz_status`；跑完插件自动关游戏、停后端。已知坑：游戏停在标题界面直接跑一条龙，第一个应用（邮件）会报「未能识别当前画面」，所以必须先 `zzz_enter` 进到「大世界-普通」。

## 自动更新

设置页顶部有一条版本栏：**打开面板时会自动去 GitHub 读最新的 `package.json`**，和本地版本比对。

- 远端更新时，版本栏变黄并显示「发现新版本 vX.Y.Z」，右侧出现 **立即更新** / 稍后 / 查看更新说明；点「立即更新」直接升级（有 `.git` 的安装走 `git pull --ff-only`，没有 git 则下载 zip 覆盖，只覆盖插件文件，不动 `node_modules` 与用户数据）。
- 已是最新时只显示「版本 vX.Y.Z · 已是最新版本」，右边是「检查更新」（30 分钟缓存，点一下强制刷新）。
- 更新写盘后需要**重启 DSH 桌面端**才会加载新代码（计划任务每轮新起 node 进程，不受影响）。
- 版本比较支持 `x.y.z` 与 `x.y.z-pre`（prerelease 视为更小）；检查失败不弹错，只在版本栏提示「检查更新失败」。

## 依赖与边界

- 原神：BetterGI（默认 `D:\software\BetterGI`，可在面板里改）+ **随插件自带**的 bettergi-control 技能与 bettergi-mcp（见上）；BetterGI 没有 HTTP API，只能命令行/配置组驱动。
- 崩坏3 / 星铁：`game-daily` 家族技能 + 提权助手（坐标点击被拦时按技能说明改用 computer-use）。
- 绝区零：ZenlessZoneZero-OneDragon（默认 `D:\software\ZenlessZoneZero-OneDragon`，缺失可一键自动安装）+ 提权的一条龙后端；插件自带 MCP 与技能，游戏本体仍需自己安装。
- 没有「后台挂机」：原神必须可见且前台、16:9 ≥1920×1080；锁屏会失败。
- 注册计划任务、跑 BetterGI 需要一次 UAC；面板会在按钮旁说明。
- 账号风险由使用方式决定：官方条款把第三方软件/模拟操作列为封号理由之一，低调使用。

## 开发

```powershell
node test/smoke.mjs          # 纯 Node 冒烟（不触网、不弹 UAC）
node --check index.js        # 语法自检
```

`lib/` 全部是纯 Node 模块（无第三方依赖）；`client.js` 是 Harness 的 lazy client 工厂（`window.__ModuleLoader__.load`），只注册 `settings.section` 一个 slot。

## 许可

[MIT](LICENSE) © 2026 gychen-NJU

