# maa-bbb-control

给 agent 用的 Maa_bbb（识宝小助手）控制脚本：一条命令检查安装、列配置、启动崩坏3日常、读日志、停进程。

- 脚本：`scripts/maa-bbb.ps1`（Windows PowerShell 5.1，纯 ASCII，输出 JSON）
- 技能说明：`SKILL.md`；命令与路径索引：`references/commands-and-paths.md`；排障：`references/troubleshooting.md`
- 默认安装根 `E:\software\Maa_bbb`，也可用 `-Root` 或 `DSH_GAME_DAILY_MAA_ROOT` 覆盖
- 只读 Maa_bbb 的 `config/`，不修改任何现有配置；往世乐土桌面端/安卓端都支持（桌面端不需要 MuMu）
