# maa-bbb-mcp

`dsh-game-daily` 随包的 Maa_bbb（识宝小助手 / MFW）MCP 服务端。把崩坏3自动化工具 Maa_bbb 的
**配置读写 + 跑配置 + 停进程 + 读日志** 暴露成 agent 可调用的 MCP 工具。

- 实现：`maa-bbb-mcp.mjs`（零依赖 Node ESM，直接 `node` 跑，stdio JSON-RPC 2.0）
- 目标环境：Windows + Maa_bbb（`mab.exe` 已验证 v1.13.20）
- 协议：`initialize` 返回 `protocolVersion: 2025-06-18`、`capabilities.tools`、`serverInfo: maa-bbb-mcp@0.1.0`

## 快速验证

```powershell
node --check tools\maa-bbb-mcp\maa-bbb-mcp.mjs
# 手动起一个 stdio 会话（任意 MCP 客户端都可以）：
node tools\maa-bbb-mcp\maa-bbb-mcp.mjs
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"t","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

在 DSH 里注册时，启动命令填 `node`，参数填该文件的绝对路径；环境变量可选
`DSH_GAME_DAILY_MAA_ROOT` 指定安装根。stderr 是日志，stdout 只出 JSON-RPC。

## 安装根解析

按顺序命中第一个同时含 `mab.exe` 与 `interface.json` 的目录：

1. `DSH_GAME_DAILY_MAA_ROOT`
2. `MAA_BBB_ROOT`
3. `<stateDir>/maa-root.txt`（`stateDir` 默认 `%USERPROFILE%\.dsh\game-daily`，可用 `DSH_GAME_DAILY_STATE_DIR` 覆盖）
4. 候选：`E:\software\Maa_bbb`、`D:\software\Maa_bbb`、`C:\software\Maa_bbb`、`%USERPROFILE%\Maa_bbb`

没安装时全部工具返回 `{ok:false, error:"MAA_NOT_INSTALLED", searched:[...], hint:"..."}`，不会崩。

## Maa_bbb 数据模型（本服务依赖的事实）

- `config/configs/<id>.json`：4 空格缩进、CRLF、无末尾换行、无 BOM。任务列表固定以 3 个伪任务开头：
  `PreTask`、`Controller`（`task_option.controller_type` = 桌面端/安卓端）、`Resource`
  （`task_option.resource` = 键鼠操作 等）。其后是真实任务 `{name, item_id:"t_<32hex>", is_checked, task_option}`。
- 真实任务的 `item_id` 由 GUI 随机生成，**无法从任务名推导**；`maa_bbb_task_catalog` 的 `itemId`
  只能从已有配置反查，查不到时为 `null`。
- `config/multi_config.json`：`{curr_config_id, config_list:[...]}`。新配置必须登记进 `config_list`
  才会出现在 GUI；`curr_config_id` 是「当前配置」。
- `interface.json`：`controller` / `resource` / `group` / `preset` / `import` 是权威来源；
  它的 `task` 与 `option` 恒为空，任务定义散在 `tasks/**.json`（其中 8 个文件带 `//` 注释，是 JSONC）。
- `debug/maafw.log`、`debug/gui.log`、`debug/crash.log` 会被运行中的 Maa_bbb 持续追加。

## 工具（10 个，均以 `maa_bbb_` 开头）

| 工具 | 作用 |
| --- | --- |
| `maa_bbb_status` | 总览：安装根/版本/是否在跑/当前配置/配置摘要/adb 与 MuMu/日志尾部 |
| `maa_bbb_config_list` | 列出 `config/configs/*.json` 摘要 |
| `maa_bbb_config_get` | 读一个配置（默认压缩 `task_option`，`maxTasks` 截断，`full:true` 看原始结构） |
| `maa_bbb_config_update` | 只改指定字段：`enable`/`disable`/`controllerType`/`resource`/`taskOptions`/`setCurrent` |
| `maa_bbb_config_clone` | 克隆配置（默认 id `c_` + 32 位随机 hex）并登记 `config_list` |
| `maa_bbb_presets` | 读 `interface.json` 的 3 个 preset 与任务启用清单 |
| `maa_bbb_run` | `spawn mab.exe --config-id <id> --direct-run [...]`，返回 pid |
| `maa_bbb_stop` | 结束安装根下的 `mab.exe`（`taskkill /PID /T`，`force:true` 才加 `/F`） |
| `maa_bbb_log_tail` | 读 `debug/<kind>.log` 尾部，可 `filter` 子串过滤 |
| `maa_bbb_task_catalog` | 汇总 `interface.json` 的 group + `tasks/**.json` 任务目录，可按 group 过滤 |

调用示例：

```json
{"name":"maa_bbb_config_update","arguments":{"configId":"c_...","disable":["往世乐土"],"taskOptions":{"家园资源领取":{"家园资源领取-领取方式":"..."}}}}
{"name":"maa_bbb_run","arguments":{"configId":"c_...","waitSeconds":8}}
{"name":"maa_bbb_log_tail","arguments":{"lines":20,"kind":"maafw","filter":"ERR"}}
```

## 写入安全

- **原子写**：临时文件 + `rename`；UTF-8 无 BOM；保留原文件的 EOL（CRLF/LF）与「无末尾换行」风格。
- **写前备份**：`<file>.bak-maa-<yyyyMMdd-HHmmss>`；写后回读校验 JSON。
- **不碰** `config/config.json`（MFW 全局设置）；只在 `config/configs/*.json` 与
  `config/multi_config.json` 上写。
- `config_update` 的未知任务名会让整次调用返回 `TASK_NOT_FOUND` 且**不写盘**；非法
  `controllerType` / `resource` 分别返回 `INVALID_CONTROLLER` / `INVALID_RESOURCE`。
- Maa_bbb 正在运行时修改配置会返回 `warning`：GUI 退出时可能回写覆盖，建议先 `maa_bbb_stop`。
- `config_clone` 若登记 `multi_config` 失败，会删掉刚写的新配置回滚，避免孤儿配置。

## 已知限制

- 本机没有 adb / MuMu 模拟器：`adbAvailable`、`mumuAvailable` 为 `false`，安卓端（往世乐土等）
  只能做配置面支持，不能实跑。检测顺序为 `where adb` + 常见 SDK/MuMu 路径、`MUMU_INSTALL_PATH`。
- `maa_bbb_run` 会真的启动 GUI 并控制游戏窗口；游戏未开时 MaaFramework 会在日志里报窗口/识别错误，
  这属于预期。`waitSeconds` 只确认进程存活，不代表任务成功。
- 任务实际执行结果仍以 `debug/maafw.log` / `gui.log` 为准；本服务不做视觉或流程判定。
