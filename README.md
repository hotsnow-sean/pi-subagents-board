# pi-plugin-subagents-board

给 [pi-app](https://github.com/hotsnow-sean/pi-app) 桌面端用的外部插件：在**右栏**观测 [`pi-subagents`](https://www.npmjs.com/package/pi-subagents) 的后台运行。

子代理默认以后台方式跑（`asyncByDefault: true`），结果不进父会话的工具详情——也就是说，派出去之后**它跑得怎么样、什么时候结束，在界面里是看不见的**。这个插件把那段运行状态接到右栏。

## 它显示什么

- 谁在跑（`worker` / `reviewer` / 自定义 agent 名）、什么状态、跑了多久
- 每个 run 的 children（并行 / 链式 / workflow 下的多个子代理），各自的模型与 thinking 档位
- 终止态的原因：成功 / 失败 / 被停止，以及扩展给出的摘要
- 代际链：`resume` 出来的新一段会挂在同一张卡上（「已从第 N 段继续」），不会变成两张卡
- **点一下子代理行 → 只读预览那段子会话**（不绑 worker、不能发消息；想接手自己从侧栏切过去）
- **插手**：对**后台 run** 插话（立刻生效 / 本轮结束后再说）与停止；回执区分「已送达」与「已排队」
- **信箱**：run 结束时投一条「worker 已完成」到顶栏信箱，点开回到产出它的会话 + 右栏面板
- **这份数据能不能信**：推送 / 轮询 / 未连上 / 心跳过期，各有一套明确文案

## 干预的边界

- 只对**后台**（async）run 有效。前台子代理没有 async id，只能用 Esc 停整轮——面板上不会出现按钮。
- 已终态 / 已停止的段也不出现按钮：先置灰，别让用户点了才看到报错。
- **插话的 `queued` 不等于「它已经看到」**：只说明排上了队，子代理本轮结束才会读到；
  排队中的插话也不会取消正在跑的 shell 命令。
- **停止不可逆**：`stopped` 的 run 不能 resume（扩展明确），只能重新派一个。回执的
  `state: "stopping"` 只代表受理，真正终止要靠 status 收敛，所以面板会自己再拉一次状态。
- 命令 5 秒内没人认领就作废：说明那个会话已经不活跃了，界面会直说，不会悄悄生效。

## 它不显示什么

字段诚实原则——下面这些 RPC 确实拿不到，所以界面上不留空位（留了就会永远显示 `—`，比不显示更像坏了）：

- 任务原文：事件载荷里是 `[prompt redacted]`
- 当前在跑哪个工具：`status` 只给 `activity.turnCount` / `toolCount` 与 `lastActivityAt`
- 「子代理在等父会话回答」：`status` 里没有任何 `wait*/pending*/supervisor*` 字段

## 依赖

- pi-app 桌面端 `>= 0.7.7`（需要插件的 `agent` 注入、`ctx.sessions.reveal`、会话实时预览）
- 宿主里已安装并启用 `pi-subagents` 扩展（`pi install npm:pi-subagents`）

> `engines['pi-desktop']` 写的是 `>=0.7.7-0` 而不是 `>=0.7.7`：宿主 fork 版本号带 prerelease
> 后缀（如 `0.7.7-fork.3`），在 semver 语义里**小于** `0.7.7`。写成 `>=0.7.7` 会让 fork 版
> 宿主把插件判成不兼容并静默跳过（设置页只显示一行「不满足版本要求」）。

没有 pi-subagents 时插件不会崩：面板会显示「未连上 pi-subagents」并持续重试握手，装好之后自动恢复。

## 安装

设置 → 插件 → 从目录安装，选这个仓库的根目录。装完**新开一个会话**生效（插件扩展随 worker 启动注入）。

## 开发

```bash
npm test              # node:test，纯函数与落盘的单测
```

调试时把宿主指向「装着插件目录的父目录」：

```bash
PI_PLUGINS_DIR=/path/to/pi-plugins-dev npm run dev
```

宿主会扫这个目录下的每个子目录找 `plugin.json`，所以仓库本身要放在某个父目录里（本仓库默认放在 `pi-plugins-dev/subagents-board`）。

改 `main.mjs` / `ui/` 走宿主热重载（按插件目录最大 mtime）；改 `agent.mjs` 需要新会话——它在 worker 里，随会话创建加载一次。

## 数据流

```
pi-subagents (worker 进程内)
      ↕ eventBus RPC（subagents:rpc:v1:*）
        读：ping / status / 事件        写：steer / stop
agent.mjs（worker 进程，宿主注入的 pi extension）
      ↓ 原子写 <dataDir>/live/<sessionKey>-<pid>-<startedAt>.json
      ↑ 读 <dataDir>/inbox/<sessionKey>/<id>.json，执行后写 receipts/<id>.json
main.mjs（main 进程）
      ↕ 插件面板通过 pi.invoke('getState' | 'note' | 'stop', …) 每秒读 / 按需写
ui/（sandbox iframe）
```

main 与 worker 之间没有插件可用的 IPC 通道，所以两个方向都走文件。文件名带实例后缀是必需的：会话切换会让插件扩展**换代**（工厂重新调用、state 清空），共用文件名会把上一代结果覆盖成空白。

「插话」= 对某个 run 的一次 steer：面板写一条不可变的 note，worker 里的 agent 读到后调扩展的 `steer` RPC（`{ id, message, mode }`），把扩展返回的 steering 收据写成回执。不自己实现投递状态机、不做双端死线，也不碰别人的会话文件——steer 的落点是那个 run 自己的 steering inbox。

## 路线图

- [x] P2-a 数据打通：RPC 客户端、分文件落盘、降级与重连
- [x] P2-b 面板完善：代际链展开、打开会话（只读预览）、信箱
- [x] P2-c 干预：插话（steer）与停止（stop），回执区分 `delivered` / `queued`
- [ ] P2-d 分发：README、安装验证
- [ ] 交互与视觉打磨：卡片信息分层（有效信息被淹没）、返回按钮位置（出现/消失会让内容跳一下）

## 许可

MIT
