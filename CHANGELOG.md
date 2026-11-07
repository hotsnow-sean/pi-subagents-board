# CHANGELOG

## 0.2.0

P2-b：从「能看见」到「能回去」。

- `main.mjs` 新增 `invoke('openSession')`：走宿主 `sessions.reveal` 打开子会话的**只读预览**（不绑 worker、不能发消息——观测层不指挥用户会话）
- 信箱：main 侧 5s 巡检 live 状态，新结束的 run 投一条宿主信箱（标题/摘要/耗时/tokens，`sessionFile` 指回产出它的会话，落点右栏面板）
  - 台账 `notified.json` 按 `<sessionKey>|<runId>` 去重，7 天清理
  - 激活/热重载时把「早已结束」的段静默记账（60s 宽限），不会把历史重播一遍
- `lib/inbox-watch.mjs`：巡检的纯逻辑（选段、台账种子、条目生成、清理），时间显式传参便于单测
- `ui/`：子代理行整行可点 → 只读预览；结果用常驻横幅（活过每秒重绘）；无 children 明细时用卡级「打开子会话」兜底
- 单测 55 例

## 0.1.0

P2-a：数据层打通。

- `agent.mjs`：pi-subagents RPC 客户端
  - 握手：监听 `ready` + 主动 `ping` 双路；失败按 2s/5s/10s/20s 退避重试
  - 事件订阅：`ready.payload.events` 与 `ping.capabilities.events` 取并集
  - `jobs-changed`（实测 2.7~14 次/秒）只置脏标记，1s 合并成一次 `status`
  - 心跳：推送模式 5s、轮询模式 2s，用来给 main 判活
  - 连续 3 次 `status` 失败自动降级为轮询模式
  - 实例换代（stale）后停掉全部定时器，只记一次日志
- `lib/lineage.mjs`：代际链聚合纯函数
  - `async-started` 提供 agent / cwd / asyncDir；`async-complete` 提供终态、摘要、耗时、tokens、成本、子会话路径
  - `resume` 的链接靠子会话首行 `parentSession`（事件里没有 `revivedFrom`）
  - `status` 只覆盖进度，不新增字段
- `lib/live-store.mjs`：`live/<sessionKey>-<pid>-<startedAt>.json` 原子写、按实例启动时间取最新、30s 判活、7 天清理
- `lib/degrade.mjs`：五种降级状态（ok / poll / rpc-unavailable / stale / no-data）的文案
- `main.mjs`：`getState` / `getDiagnostics`
- `ui/`：只读面板（卡片、children、代际链折叠、降级横幅、诊断折叠区）
- 单测：聚合、会话 key、落盘、降级共 46 例（含 main 侧 getState 与 agent 侧握手集成）
