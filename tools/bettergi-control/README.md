# bettergi-control

**用自然语言指挥 BetterGI（"更好的原神"）完成自动化** —— 一个给 AI Agent 用的技能包（skill），也可以直接当 PowerShell 工具箱用。

- 启动原神与截图器、跑「一条龙」日常、跑配置组、采集材料、打秘境
- 改配置 / 改队伍 / 改树脂、查任务进度与失败原因、看战果与调度
- 每个脚本都支持 `-Json` 出机器可读结果、`-DryRun` 预览副作用，退出码语义统一（0 成功 / 1 失败或未命中 / 2 前置或参数问题）

> 这是 [dsh-game-daily](https://github.com/gychen-NJU/dsh-game-daily) 里「原神」日常的依赖之一：插件会在依赖体检里检查它，缺失时可一键安装到 `%USERPROFILE%\.agents\skills\bettergi-control`。

## 安装

### 方式一：让 Agent / DSH 一键安装

在 DSH 设置 →「游戏日常」→ 原神 → 依赖体检里，点「game-daily 技能 / bettergi-control」旁边的修复按钮即可自动拉取本仓库并安装。

### 方式二：手动 clone

```powershell
git clone https://github.com/gychen-NJU/bettergi-control "$env:USERPROFILE\.agents\skills\bettergi-control"
```

技能目录里应有 `SKILL.md` 与 `scripts\`（15 个 `bgi-*.ps1`）。DSH 的 skill 扫描路径是 `%USERPROFILE%\.agents\skills\`（可用 `DSH_SKILLS_ROOT` 覆盖）。

## 依赖

| 依赖 | 说明 |
| --- | --- |
| BetterGI 0.66.x | 默认安装路径 `D:\software\BetterGI`，所有脚本都接受 `-Root` 覆盖 |
| PowerShell 5.1 | 脚本为 UTF-8 **带 BOM**；请不要去掉 BOM（PS 5.1 会按 ANSI 解析中文导致语法错乱） |
| Windows 10/11 | 依赖计划任务、窗口 API；原神运行需 16:9 且 ≥1920×1080、可见且前台 |

## 脚本

| 脚本 | 用途 |
| --- | --- |
| `bgi-status.ps1` | 只读状态总览：进程 / 窗口 / config 关键值 / 一条龙 / 日志尾部 |
| `bgi-doctor.ps1` | 开跑前体检：安装、窗口、DPI、资源分辨率、路线资产、配置组完整性、JS 图片资产 |
| `bgi-run.ps1` | 触发 `start` / `oneDragon` / `groups` / `progress` |
| `bgi-watch.ps1` | 观测并判定成败（只认本次运行的 ERR；`-DryRun` 只看一眼不阻塞） |
| `bgi-wait.ps1` | 等里程碑（截图器就绪 / 真的进秘境 / 收尾…） |
| `bgi-log.ps1` | 日志定向检索（级别 / 正则 / 时间窗 / 任务过滤） |
| `bgi-results.ps1` | 战果统计（每条路线成败、耗时、失败清单） |
| `bgi-schedule.ps1` | 调度总览（计划任务 / 包装器 / 一条龙 / 配置组） |
| `bgi-config.ps1` | 安全改 `User\config.json`（自动备份、回读校验） |
| `bgi-group.ps1` | 生成 / 列出配置组 |
| `bgi-strategy.ps1` | 战斗策略列出 / 预测选中 / 语法校验 |
| `bgi-collect.ps1` | 材料 → 本机路径索引（可触发采集） |
| `bgi-fetch-route.ps1` | 材料 → 官方脚本仓库检索 / 下载路线 |
| `bgi-focus-game.ps1` | 跑自动化前的窗口准备（还原 + 置前 + 回报尺寸） |
| `bgi-close.ps1` | 关闭原神 / BetterGI（先优雅、必要时强制） |

完整使用说明见 `SKILL.md`；配方与排障见 `references\`。

## MCP 版

同一套能力的 MCP（stdio）版本在 [gychen-NJU/bettergi-mcp](https://github.com/gychen-NJU/bettergi-mcp)（29 个 `bgi_*` 工具，单文件零依赖）。DSH 里注册后可直接用 `mcp__bettergi__*` 调用。

## 安全边界

- 不改游戏文件、不读写游戏内存、不用未审计的第三方脚本
- 不点付费礼包、删除、重置类按钮
- BetterGI 运行中不写它的配置（会被内存回写覆盖）
- 账号风险由使用方式决定；请自行评估并低调使用

## License

MIT © 2026 gychen-NJU
