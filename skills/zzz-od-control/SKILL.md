# zzz-od-control · 绝区零「一条龙」指挥技能

> 本技能由 **dsh-game-daily** 插件自带（`skills/zzz-od-control/`），配合插件内置的 `zzz-od-mcp` 使用。
> 它不自己点游戏：所有画面识别与点击都交给本机的 **ZenlessZoneZero-OneDragon**（一条龙）后端。

## 0. 前提

- 本机已安装 [ZenlessZoneZero-OneDragon](https://github.com/OneDragon-Anything/ZenlessZoneZero-OneDragon)，默认位置 `D:\software\ZenlessZoneZero-OneDragon`（可用环境变量 `DSH_GAME_DAILY_ZZZ_ROOT` / `ZZZ_OD_ROOT` 覆盖）。
- 一条龙后端在本机 `http://127.0.0.1:23001`，用 `zzz_server` 工具可查询/启动/停止。
- 绝区零游戏是**管理员权限**运行的：切窗口 / 发送输入都需要**提权**的后端。因此后端必须由管理员启动（启动时可能弹一次 UAC）。

## 1. 工具（`mcp__zzz-od__*`）

| 工具 | 作用 |
| --- | --- |
| `zzz_health` | 后端 health（任何动作前先查） |
| `zzz_status` | 当前是否在跑、跑哪个应用 |
| `zzz_window` | 游戏窗口标题/坐标/尺寸/是否前台 |
| `zzz_applications` | 日常应用清单与启用状态 |
| `zzz_operations` | 可单独运行的操作清单 |
| `zzz_enter` | 打开并登录游戏（`block:true` 时等到窗口就绪） |
| `zzz_run_one_dragon` | 执行一条龙全部日常（异步，之后用 `zzz_wait` 轮询） |
| `zzz_run_app` | 只跑某个应用（`app_id` 来自 `zzz_applications`） |
| `zzz_wait` | 轮询到空闲；单次 ≤50 秒，循环调用 |
| `zzz_stop` | 停止当前运行 |
| `zzz_close_game` | 关闭游戏（跑完释放内存） |
| `zzz_server` | `status` / `start`（可能弹 UAC）/ `stop` |

## 2. 标准流程（日常代理）

1. `zzz_server {action:"status"}`；不可达则 `zzz_server {action:"start"}`（**一次 UAC**）。
2. `zzz_health` 确认返回 `status: ok`（`{"status":"ok","message":"..."}` 之类）。
3. `zzz_window`：如果窗口无效/不在前台 → `zzz_enter {block:true}`；等到 `is_win_valid:true` 且 `is_win_active:true`。
4. `zzz_run_one_dragon {}` 发起 → 反复 `zzz_wait {timeout_seconds:40}` 直到 `running` 变 false。
5. `zzz_status` 取最终状态；把每个应用的成功/失败写进报告。
6. 跑完 `zzz_close_game` 释放内存（插件在真实模式也会自己关，见下）。

一次性应用可 `zzz_run_app {app_id:"..."}`；只想补某项时用。

## 3. 已知坑

- **游戏停在标题界面时直接跑一条龙**：第一个应用（邮件）会报「未能识别当前画面」。必须先用 `zzz_enter` 进到「大世界-普通」。
- 一条龙的日常应用包括：邮件、每日签到、咖啡店、录像店营业、丽都城募、活跃度奖励、丽都周纪（以 `zzz_applications` 实际列表为准）。
- 后端跑在非管理员权限时：`pygetwindow` 报 `Error code from Windows: 5 拒绝访问`，日志里能看到「切换到游戏窗口失败」，随后 OCR 拿不到图。此时必须用 `zzz_server {action:"stop"}` → `start`（提权）。
- 单次 MCP 调用别等太久：`zzz_wait` 最多 50 秒；长流程用循环。
- 日志位置：`<一条龙根>\.debug\python-out.log`（INFO）与 `python-err.log`（错误栈）。

## 4. 安全红线

1. 不要改一条龙的配置去绕验证；需要改配置时先停后端、备份、改完回读。
2. 不点付费/删除/重置类按钮；本技能只调用「日常」类应用。
3. 游戏与后端都要管理员权限才能操作窗口；**不要**用普通权限反复重试启动。
4. 报告里必须写清哪些应用成功、哪些失败（含日志证据行）。
