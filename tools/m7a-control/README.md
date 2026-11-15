# m7a-control

**用自然语言指挥「三月七小助手 / March7thAssistant / M7A」**——一个给 AI agent 用的崩坏：星穹铁道自动化控制包（skill），也可以直接当 PowerShell 工具箱用。

- 找安装、报版本 / 路径 / 首次确认 / 游戏路径状态（`doctor`）
- 跑任务：完整运行、每日实训、清体力、差分宇宙、货币战争、模拟宇宙、锄大地、三深渊、兑换码、更新小助手（`run`）
- 长任务后台起、跟输出、读运行记录与日志（`run -Detach` / `follow` / `logs`）
- 暂停 / 继续 / 停止正在跑的任务（`control`）
- 失败定位：`logs\runs\<runId>.json` 的 `status/error/screenshot` + 当天日志（见 `references/install-and-troubleshoot.md`）

游戏操作全部由小助手完成；本包只负责**安装、运行、改配置、读结果、排障**。

> 这是 [dsh-game-daily](https://github.com/gychen-NJU/dsh-game-daily) 里「崩坏：星穹铁道」日常的依赖之一：
> 插件会在依赖体检里检查它，缺失时可一键安装到 `%USERPROFILE%\.agents\skills\m7a-control`。

## 安装

### 方式一：让 Agent / DSH 一键安装

DSH 设置 →「游戏日常」→ 星穹铁道 → 依赖体检里点「m7a-control」旁的修复按钮即可。

### 方式二：手动复制（从插件目录）

```powershell
Copy-Item -Recurse "<插件目录>\tools\m7a-control" "$env:USERPROFILE\.agents\skills\m7a-control"
```

技能目录里应有 `SKILL.md`、`scripts\m7a.ps1`、`references\`。

## 依赖

- Windows + Windows PowerShell 5.1（不需要 PS7，不需要 Python）
- 已安装三月七小助手（`m7a.exe`），安装位置由脚本自动发现；没有也能用 `doctor` 得到 `M7A_NOT_INSTALLED` 与安装指引
- 运行任务时小助手会弹一次 UAC，需要用户点「是」

## 30 秒上手

```powershell
$m7a = "$env:USERPROFILE\.agents\skills\m7a-control\scripts\m7a.ps1"

& $m7a -Action doctor                      # 体检（只读）：安装 / 版本 / 首次确认 / 游戏路径 / 最近运行
& $m7a -Action status -Tasks               # 当前状态 + 本机真实任务 id 列表
& $m7a -Action run -Task main -Detach      # 起「完整运行」，立即返回
& $m7a -Action follow -Run latest          # 跟输出（-FromLog 直接读本次运行日志）
& $m7a -Action logs -Run latest -Lines 40  # 读日志结尾
& $m7a -Action control -ActionName stop    # 需要时停止正在跑的任务
```

所有 action 都输出**一个 JSON 对象**（`ConvertTo-Json -Depth 6 -Compress`）；失败是 `{ "ok": false, "error": "...", "hint": "..." }`。
退出码：`0` 成功，`1` 内部错误/输出不可解析/参数错误，`2` 未安装/`-Root` 无效/前置不满足（含超时）；
`run` 额外透传小助手的 0–6（3 首次未确认 / 4 忙 / 5 UAC / 6 被停止）。

## 文档

| 文件 | 内容 |
| --- | --- |
| `SKILL.md` | agent 入口：能力边界、标准闭环、配方、红线、本机实证 |
| `references/commands-and-paths.md` | 命令行、27 个任务 id、退出码、JSON 字段、路径表、配置键 |
| `references/install-and-troubleshoot.md` | 安装、首次确认、doctor 输出解读、常见故障、更新/备份/回滚 |

## License

MIT
