# BetterGI 失败排查手册（agent 专用）

> 用法：先跑 `bgi-status.ps1` 看状态，再按"日志关键字"定位。日志最新文件用通配 `better-genshin-impact*.log` 取。
> 出问题的前 **3 个必看**：① 当天日志的 `[ERR]` 行（**下一行**才是消息正文）；② `User\config.json` 的 `captureMode` / 各 `enabled`；③ `log\task_progress\*.json` 与 `log\ExecutionRecords\*.json`。

## 1. 日志关键字对照（出现这行 = 这个原因）

| 日志关键字 | 含义 | 处置 |
| --- | --- | --- |
| `遮罩窗口已启动，游戏大小1920x1080` | 截图链路已建立 | 正常；小于 1920×1080 会有告警 |
| `当前获取焦点的窗口为: XXX，不是原神，暂停` | 游戏失去前台焦点 | 让用户切回原神并停止操作其它窗口（任务会一直重试等待） |
| `未找到原神窗口，请先启动原神！` | 没找到游戏窗口 | 启动国服本体（`D:\Saved Games\Genshin Impact Game\YuanShen.exe`），别启错成云·原神 |
| `游戏窗口不能最小化` | 窗口被最小化 | 恢复窗口 |
| `游戏窗口分辨率不得小于 800x600` | 窗口太小 | `bgi-set-resolution.ps1 -Apply -StartGame -Verify`（见下方「分辨率/缩放不对」） |
| `游戏窗口分辨率不是 16:9 ！` | 非 16:9 | `bgi-close.ps1 -Target both` → `bgi-set-resolution.ps1 -Apply -StartGame -Verify`（改 Screenmanager 三键 + 补 HIGHDPIAWARE；实测客户区 1920×1080 才算过）。仍不行再手调 |
| `模拟键鼠消息发送失败！…你未以管理员权限运行…存在安全软件拦截（比如360）` | 提权/杀软 | 让 BetterGI 以管理员启动（计划任务用 `/RL HIGHEST`），把 BetterGI 与游戏加进杀软白名单 |
| `加载自定义拾取按键失败，继续使用默认的F键` | `pickKey` 不合法（无模板图/不是合法 VK 名） | 游戏内交互键改回 **F**，或改 E/G 并两边同步 |
| `未匹配到任何战斗脚本` | 队伍角色在现有策略里一个都没命中 | 给该队伍写一份 `User\AutoFight\<队名>.txt`（每角色一行），或换用已有策略覆盖的队伍 |
| `未完整匹配到当前队伍，使用匹配度最高的队伍：X` | 部分命中 | 可继续跑，但没被覆盖的角色只会普攻 |
| `未配置`（自动秘境战斗策略） | `autoFightConfig.strategyName` 为空 | 设为 `根据队伍自动选择` 或具体策略名 |
| `一条龙配置内未选择需要刷的秘境，跳过` | 一条龙 `DomainName` 为空 | 在 `User\OneDragon\<名>.json` 填 `DomainName` |
| `用尽所有浓缩树脂和原粹树脂后结束` | 用尽模式（会用到原粹） | 想排除原粹 → 改指定次数模式 |
| `你可能设置的刷取次数过多！退出秘境` | 指定次数 > 实际持有 | 把次数改到实际持有量以内 |
| `前往冒险家协会领取奖励执行异常：未能返回主界面` | 上一个任务把游戏留在了子界面（如秘境挑战/队伍界面） | 把"领取每日奖励"排到"自动秘境"**之前**；或手动回到主界面 |
| `执行脚本时发生异常: {Msg}` | JS 脚本报错 | 看 `User\JsScript\<名>\` 与日志堆栈；注意脚本运行期间实时触发器全停 |
| `需要执行的配置组为空` / `传入的配置组名称不存在` | `--startGroups` 名字写错/空 | 组名 = 文件名（精确匹配），且 `status` 必须 `Enabled` |
| `游戏已退出，BetterGI 自动停止截图器` | 游戏掉了 | 重新 `bgi-run.ps1 -Mode start` |
| `断开原因：516` | 桌面分身 RDP 连不上（家庭版/RDP 设置） | 见 §3"桌面分身" |

## 2. 症状 → 处理（按主题）

| 症状 | 最可能原因 | 处理 |
| --- | --- | --- |
| 启动后没反应，日志无新行 | 有实例已在跑（命令被转发但无效）/ UAC 没人点 | 退出所有 BetterGI 实例后重触发；或用 08:00 计划任务（最高权限免 UAC） |
| 功能全无反应但日志有 `交互或拾取` | 提权或杀软拦截 | 加白名单 + 管理员启动 |
| 截图全黑/花屏 | 截图方式不适配 | `captureMode` 依次试 `BitBlt` → `DwmGetDxSharedSurface` → `WindowsGraphicsCapture`（云原神只能用它）→ `WGC-HDR`（仅游戏开 HDR 时）→ `WGC V2`；每改一次重启截图器 |
| 分辨率/缩放不对 | 非 16:9、系统缩放大、多显示器 | `bgi-set-resolution.ps1`：`-Apply`（先关游戏与 BetterGI，自动备份）→ `-StartGame` → `-Verify` 实测；回滚用 `-Restore`。注意 `-Verify` 量的是 **DPI 换算后的客户区**：缩放 150% 时物理 1280×720 = 逻辑 1920×1080，正好达标 |
| 游戏更新后识别失效 | 模板/模型过时 | 升级 BetterGI；路径文件的 `bgi_version` 高于当前版本会被拒绝运行（**不要手改绕过**） |
| 找不到模型：`FileNotFoundException ... Assets\Model\...onnx` | 安装不完整 | 用完整发行包重装；完整性检查只看 `<BGI>\Assets\` 与 `<BGI>\GameTask\` 两个目录 |
| 任务卡在加载/传送 | 传送点没激活、游戏网络卡 | 手动激活传送点/传送一次再重试 |
| 反复重试后失败 | 脚本或路径不匹配 | 换策略/修路径；看 `RetryException` 上下文 |
| 自动寻路绕圈 | 小地图锁定未设"锁定方向" 或 非 BitLlt/BitBlt | 按路径追踪三条硬前置检查 |
| 改了 `config.json` 没生效 | 无热重载 + 运行中会被回写 | **退出程序**再改（本 skill 的 `bgi-config.ps1` 会强制检查） |
| 一条龙跑完但没领每日委托/纪行 | 秘境失败后卡在秘境界面 | 顺序调整（每日奖励提前）+ 看 `未能返回主界面` |
| 计划任务没触发 | 任务被禁用/未登录/睡着没唤醒/UAC | `Get-ScheduledTask -TaskName 'BetterGI 日常一条龙'` + `Get-ScheduledTaskInfo` 看 State / LastRunTime / LastTaskResult |
| 桌面分身报 516 | 家庭版无 RDP 服务端；或装了 RDPWrapper（**与桌面分身不兼容**） | 重启 BetterGI/重启系统重试；否则改用 rdpwrap 多任务户后台挂机方案；不要同时用两者 |
| 想后台跑但一直被"暂停" | 本机客户端要求前台 | 只有两条路：桌面分身（另一 Windows 会话）或云原神 webview 实例；否则保持原神前台、不锁屏 |

## 3. "设计如此，不是 bug"清单

1. 进入任务后**界面上开的实时任务全部停用**（自动拾取/剧情/吃药），任务期间只有 `AutoPick`/`AutoSkip`/`AutoEat` 能被脚本重新打开。
2. 改 `config.json` **必须重启**（无文件监听）；运行中手改会被回写覆盖。
3. `task.cancel` 在**正常结束**时也会发（显示名还叫"任务启动"）。
4. 一条龙**不写** `log\task_progress\`（只有调度器/`--startGroups`/`--TaskProgress` 写）；且 `endTime` 只在"无连续失败"时才写。
5. `ExecutionRecords` 的 `is_successful` **只对 `type:"Pathing"` 有真实含义**（其余三类正常收尾恒 `true`）。
6. 命令行**不能**启动单个独立任务；也**没有** `--help`/`--version`。
7. 非管理员启动的原进程退出码 **553**（= 已提权重启），不是失败。
8. 同 Windows 会话开不出第二个实例（argv 转发后自身退出）。
9. 通知发送失败只记 `[WRN]`，不重试。
10. 桌面分身一个 Windows 只能一个；米哈游系应用只能在一个桌面里运行。
11. 云原神网页版实例**不响应热键**、只能用 `WindowsGraphicsCapture`。
