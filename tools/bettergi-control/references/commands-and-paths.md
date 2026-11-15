# BetterGI 命令行 / 路径 / 数据格式速查

> 依据：BetterGI **0.66.0**（本机 `D:\software\BetterGI`）+ 源码 `0.66.2-alpha.2` 快照核对。
> 所有路径以 `<BGI>` 代表安装根 `D:\software\BetterGI`。

## 1. 命令行（全部动作，就这 5 个）

| 写法 | 行为 | 备注 |
| --- | --- | --- |
| （无参数） | 只打开界面 | — |
| `start` | 启动截图器（`linkedStartEnabled=true` 时联动启动游戏） | 不启动任何任务 |
| `startOneDragon <配置名>` | 启动一条龙；配置名匹配 `User\OneDragon\<名>.json` 的 `Name`（**Ordinal 精确匹配**） | 会自行拉起游戏并进游戏 |
| `--startGroups <组名> [组名2 …]` | 依次执行配置组 | **组名后必须至少跟一个名字**，否则什么都不做 |
| `--TaskProgress [名称\|latest]` | 续跑任务进度 | 同上，必须带参数 |

附加参数：`--instance childsession|webview`、`--instance-name <名>`、`--restart-from-pid <pid>`（多实例/桌面分身用，一般不要手敲）。

**匹配规则**：`start` / `startOneDragon` 用 `Contains`（所以 `--startOneDragon` 也有效）；`--startGroups` / `--TaskProgress` 用**精确 Equals**。
**没有** `--help`、`--version`；**未识别的参数被静默忽略**。

调用示例（注意 exe 路径要带引号）：

```powershell
$exe = 'D:\software\BetterGI\BetterGI.exe'
& $exe start
& $exe startOneDragon 日常
& $exe --startGroups '采集-星螺'
& $exe --TaskProgress latest
```

**退出码**：

| 码 | 含义 |
| --- | --- |
| `0` | 正常（含"把 argv 转发给已运行实例后自身退出"） |
| `553` | **已自动提权重启**（`'r'+'u'+'n'+'a'+'s'`）——不是失败 |
| `65535` (0xFFFF) | 启动期失败四类之一：根管道连不上 / 网页版实例名非法 / 根管道初始化失败 / 缺 `Assets\` 或 `GameTask\` |

⚠️ `BetterGI.exe` 是 WinExe，`& $exe ...` **拿不到 `$LASTEXITCODE`**（恒为空）；要判退出码用 `Start-Process -PassThru` + `$p.ExitCode`（注意 `-ArgumentList` 的元素会被拼成命令行，含空格的值必须把引号写进元素内）。
⚠️ **对已运行实例发命令无效**：`start` 有时只把窗口弹到前台，`startOneDragon`/`--startGroups`/`--TaskProgress` 基本不会真正执行 → 触发前必须先确认没有实例在跑。

## 2. 关键路径表

| 用途 | 路径 |
| --- | --- |
| 主程序 | `<BGI>\BetterGI.exe`（不是 `BetterGenshinImpact.exe`） |
| 主配置 | `<BGI>\User\config.json`（**无热重载**，改前必须退出程序） |
| 配置组 | `<BGI>\User\ScriptGroup\<组名>.json` |
| 一条龙 | `<BGI>\User\OneDragon\<配置名>.json` |
| JS 脚本 | `<BGI>\User\JsScript\<脚本名>\manifest.json` + `main.js` |
| 战斗策略 | `<BGI>\User\AutoFight\<名>.txt`（同名 `.json` 优先） |
| 七圣召唤策略 | `<BGI>\User\AutoGeniusInvokation\<名>.txt` |
| 地图追踪路径 | `<BGI>\User\AutoPathing\*.json`（**本机目前为空**） |
| 配置备份 | `<BGI>\User\backup\config_<时间戳>.json.bak` |
| 业务日志 | `<BGI>\log\better-genshin-impact<yyyyMMdd>.log`（保留最多 31 个文件 / 21 天） |
| 任务进度 | `<BGI>\log\task_progress\<yyyyMMddHHmmss>.json`（>3 天自动删） |
| 执行记录 | `<BGI>\log\ExecutionRecords\<yyyyMMdd>.json` |
| 统计报告 | `<BGI>\log\logparse\LogAnalysis_*.html` |
| 内置识别素材 | `<BGI>\Assets\**`、`<BGI>\GameTask\<任务名>\Assets\**` |

**日志格式**：`[HH:mm:ss.fff] [LVL] [Primary:S1:P<pid>:T<ms>] 类名` 换行后是消息正文；`[ERR]/[WRN]` 的**下一行**才是可读消息。检索一律用通配 `better-genshin-impact*.log` 取最新。

## 3. `User\config.json` 重点键

| 键（JSON 路径） | 默认 | 说明 |
| --- | --- | --- |
| `captureMode` | `"BitLlt"`→`"BitBlt"` | 截图方式。**地图追踪必须 BitBlt**；云原神只能用 `WindowsGraphicsCapture`；WGC/HDR/V2 需 Win10 1903+ |
| `triggerInterval` | `50` | 实时触发器帧间隔（ms） |
| `autoPickConfig.enabled` | `true` | 自动拾取总开关 |
| `autoPickConfig.pickKey` | `"F"` | 交互/拾取键。**只支持带模板图的 E/F/G/L**（`<BGI>\GameTask\AutoPick\Assets\1920x1080\{E,F,G,L}.png`）；写别的会静默回退 F |
| `autoPickConfig.mode` | `"Whitelist"` | `Whitelist` / `Blacklist`；内置白名单 631 条、黑名单 4924 条 |
| `autoSkipConfig.enabled` | `true` | 自动剧情；含 `autoGetDailyRewardsEnabled`（领每日委托奖励）、`autoReExploreEnabled`（自动重新派遣） |
| `autoFightConfig.strategyName` | `"根据队伍自动选择"` | 战斗策略名；也可填 `User\AutoFight\<名>` 的文件名 |
| `autoDomainConfig.specifyResinUse` | `false` | **`false`=用尽模式（硬编码：浓缩→原粹，排除不了原粹）**；`true`=指定次数模式 |
| `autoDomainConfig.condensedResinUseCount` 等 | `0` | 指定模式下的次数（浓缩/须臾/脆弱/原粹/原粹20/原粹40）；**纳入顺序固定**：浓缩 → 原粹40 → 原粹20 → 原粹 → 须臾 → 脆弱 |
| `autoDomainConfig.resinPriorityList` | `["浓缩树脂","原粹树脂"]` | **死字段**：源码只赋值不读取，别指望它改行为 |
| `genshinStartConfig.autoEnterGameEnabled` | `true` | 启动后自动进游戏 |
| `genshinStartConfig.linkedStartEnabled` | `true` | 启动截图器时联动启动游戏 |
| `genshinStartConfig.installPath` | 自动探测 | 游戏 exe 路径（注册表 `HKCU\Software\miHoYo\HYP\1_1\hk4e_cn\GameInstallPath`） |
| `hotKeyConfig.bgiEnabledHotkey` | `"F11"` | 全局启用/禁用热键 |
| `hotKeyConfig.cancelTaskHotkey` | `""` | **停止当前任务的热键，默认空**——建议让用户绑一个 |
| `notificationConfig.*` | — | Webhook/钉钉/Discord/QQ/邮件等；判失败看 `task.error`，`task.cancel` 不可用 |

## 4. 一条龙配置（`User\OneDragon\<名>.json`）

**合法任务名（8 个）**：`领取邮件` · `合成树脂` · `自动秘境` · `自动首领讨伐` · `自动幽境危战` · `自动地脉花` · `领取每日奖励` · `领取尘歌壶奖励`
（`每日委托` 那项在源码里被注释掉了——**"领取每日奖励"= 去凯瑟琳领每日委托奖励 + 领纪行奖励**。）

两种格式都认，程序读一次后会**升级写成新格式**：

```json
// 新格式（程序写出）
{ "Name":"日常", "TaskOrder":["<guid1>","<guid2>"], "TaskEnabledList":{"<guid>":true},
  "TaskDefinitions":{"<guid>":"领取邮件"},
  "PartyName":"兹白月结晶", "DomainName":"荒坠的圣迹", "DailyRewardPartyName":"每日委托",
  "CraftingBenchCountry":"枫丹", "AdventurersGuildCountry":"枫丹", "MinResinToKeep":0 }
// 旧格式（手写可用，程序会升级）：taskEnabledList 的键直接是中文任务名，
// 顺序取字典键序（或 taskOrder），taskDefinitions 留空即可
```

顺序在 `TaskOrder` 数组里；**建议把"领取每日奖励"放在"自动秘境"之前**，这样秘境失败不会连带崩掉每日委托/纪行/派遣。

## 5. 配置组（`User\ScriptGroup\<组名>.json`）

```json
{
  "name": "采集-星螺",
  "projects": [
    { "name": "星螺路线.json", "folderName": "星螺", "type": "Pathing", "status": "Enabled", "runNum": 1 },
    { "name": "每日委托.js", "folderName": "daily", "type": "Javascript", "status": "Enabled",
      "schedule": "Daily", "runNum": 1, "allowJsNotification": true }
  ]
}
```

- `type` ∈ `Javascript` / `Pathing` / `KeyMouse` / `Shell`；**`status` 必须恰好是 `"Enabled"`**（写成别的：界面报错，而命令行路径**静默跳过却记成成功**）。
- `Pathing` 的 `name` 是文件名（含 `.json`），`folderName` 是 `User\AutoPathing` 下的子目录（可空）。
- `Javascript` 的 `folderName` 指向 `User\JsScript\<folderName>\`（须有 `manifest.json` + `main`）。
- `Shell` 的 `name` 就是命令本身。

## 6. JS 侧可用任务名（写脚本时用）

`dispatcher.addTrigger` 实时任务**只认 3 个**：`AutoPick` / `AutoSkip` / `AutoEat`
`dispatcher.runTask` 独立任务：`AutoGeniusInvokation` / `AutoWood` / `AutoFight` / `AutoDomain` / `AutoBoss` / `AutoFishing` / `AutoCook` / `AutoEat` / `CountInventoryItem`
带参数的：`runAutoDomainTask` / `runAutoBossTask` / `runAutoFightTask` / `runCombatScript` / `runAutoLeyLineOutcropTask` / `runAutoStygianOnslaughtTask` / `runCountInventoryItemTask`
读取路径/策略：`pathingScript.*`（`User\AutoPathing`）、`strategyFile.*`（`User\AutoFight`）；`file.*` 被夹紧在脚本目录内。

## 7. 通知（唯一的事件推送面，判失败用它）

- 订阅键：`notificationConfig.notificationEventSubscribe`（逗号分隔，留空=全发）
- Webhook 报文是 **snake_case 7 键**：`send_to` / `event` / `result` / `timestamp` / `screenshot`(JPEG base64) / `message` / `data`
- ⚠️ **`result` 在 Webhook 渠道是整数**（`0`=Success / `1`=Fail / `2`=PartialSuccess），不是字符串；判成功用 `-eq 0`
- ⚠️ `task.cancel` 显示名是"任务启动"、**正常结束也会发** → 判失败只用 `task.error`
- `autoeat.*` 三个码源码里没有发送点，收不到
