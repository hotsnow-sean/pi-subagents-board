# CHANGELOG

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
- 单测：聚合、会话 key、落盘、降级共 26 例
