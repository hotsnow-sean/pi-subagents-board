# CHANGELOG

## 0.4.0

P2-c：干预（steer / stop）。

- **命令队列**：main 写 `<dataDir>/cmd/<sessionKey>--<id>.json` → worker 里的 agent 认领
  （`rename` 原子认领）→ 调 RPC → 写 `cmd-result/<id>.json` → main 读回执。
  文件名带会话前缀：多个会话的 agent 共用一个目录时按前缀分流，不会抢别人的命令。
- **5 秒死线**：超时撤回命令并如实说「会话不活跃」，agent 侧用同一窗口判过期——
  不会出现「面板说没送达，几秒后子代理真的被插了话」。
- **插话**：`delivered`（这一轮就能看到）与 `queued`（本轮结束后才看到）分开显示；
  mode 可选「立刻插话 / 本轮结束后再说」。
- **停止**：二次确认，文案写明 stopped 不能 resume；回执只代表受理（`state: stopping`），
  终态靠 status 收敛。
- **`stopping` 自己是一个状态**：stop 受理后 status 可能报 `stopping`，归一成 unknown 会让用户
  点了停止却看到「未知」，所以加进已知状态并单独配色。
- **置灰而不是点了报错**：`canSteer` / `canStop` 由数据层按段状态 + `ping.capabilities`
  计算，终态段、老版本扩展都不出现按钮；前台 run 不在 `status` 里，本来就不会有按钮。
- **干预坞**：输入框放在 body 下独立的 `#dock`（不参与每秒重绘），否则打一个字就被重建。
- 修掉一个真 bug：RPC 的请求超时定时器没 `unref`，握手中不断重试的会话会让进程退不出去。
- 75 例测试（新增 15：cmd-queue 7、main 干预/超时/清理 5、agent 命令认领 3）。

## 0.3.0

实测复验的三处修正 + 一个宿主新能力：

- **resume 接链修复**：resume 实测**复用同一个子会话文件**（首行 parentSession 指向父会话
  而非前一段），旧线索永远接不上 → 两张卡不合并。改为「新段 sessionFile === 某段
  childSessionFile」接链（取链尾），parentSession 降为兜底。
- **运行中可点**：async-started 时按 `<父stem>/<runId>/run-0/session.jsonl` 推导子会话
  路径，complete 前的对话流也能点开（complete 后事件真实路径覆盖）。
- **「← 返回主会话」**：main 反查「这段会话是谁的 child」（预览子会话时也能看到链）；
  打开走宿主新增的 `ctx.sessions.activate`——主会话**正常激活（可写）**，只有子会话
  才是只读预览（宿主 0.7.7-fork 之后的版本，旧宿主回落 reveal）。
- 动作横幅成功 6s 自动消失，失败才常驻。
- 60 例测试。

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

## 0.5.0 — 留言邮箱（放弃直接引导，改投主会话）

**交互重做（定稿 A 方案 · 卡片内联）**

- 「插话」改为「留言」：入口在卡片上，点了就地展开小表单，提交后收起、原地留一行回执。不再有常驻输入坞。
- 留言的投递对象是**主会话**，不再是子代理——落点是 SDK 的
  `sendUserMessage(text, { deliverAs: 'steer' })`（空闲 = 起一轮；在跑 = 插进当前轮，
  由 prompt() 自己分流，我们不再判断会话忙闲）。
- 停止不再占输入区：按钮就地变「确认停止」，3 秒不点自动退回。
- 删掉绿色结果横幅；提示改为顶部浮层（绝对定位，不占文档流，不会顶内容）。
- 渲染策略：计时数字单独更新、HTML 没变不碰 DOM、编辑留言时暂停重绘——
  「位置突变 / 选区丢失 / 焦点丢失」的共同根因就此收口。

**重复实现删除**

- 删 `lib/cmd-queue.mjs` 整层（文件命令队列 + rename 认领 + 5s 双端死线 + 双端过期判断）。
  那层是在和 pi-subagents 内部的 steering 状态机抢同一件事；改投主会话后没有存在理由。
- 新 `lib/note-queue.mjs`：一消息一文件（不可变）+ 回执独立（agent 独占写），零锁、幂等、无死线。
  只有单端过期（10 分钟）：隔夜留言不该在开机时突然起一轮。
- 回执只有「已投给主代理 / 已发出未确认 / 投递失败 / 已过期」四种，不再谎称「已送达子代理」。

## 0.6.0 — 插话改为一句话 steer 到子代理

0.5.0 把「插话」退成了「给主会话留言」，由主代理决定要不要转派。实测下来：
交互形态（卡片内联）是对的，但投递对象错了——用户想影响的是那个子代理本身。

- **投递目标改回子代理**：worker 侧直接发扩展的 `steer` RPC
  `{ id: runId, message, mode }`，落点是那个 run 自己的 steering inbox。
  不经过主会话、不污染父会话上下文、不需要模型配合转派。
- **不再自造投递语义**：回执里的状态直接来自扩展的 steering 收据
  （`delivered` = 已插进它在跑的这一轮；其余 = 排队等这一步结束），
  外加失败原因原样透出（例如「run 已终态，只能用 resume」）。
- **删掉 `renderNoteText`**：不再需要「翻译给主代理看」的那层前缀。
- **有效期 10 分钟 → 2 分钟**：steer 是瞬时动作，几分钟前的留言投过去只会撞上终态。
- UI 文案：按钮「插话…」、占位「对 <agent> 说一句」、提示「插进它当前这一轮」；
  回执四种事实——正在投递 / 已插进这一轮 / 已排队 / 失败原因。
- 测试 82 例（含新增 mode / index 校验、delivered 映射、index 透传）。

## 0.6.1 — UI 对齐原型 A + 卡片可分辨（实测报告 P1/P2 的 UI 部分）

**版式重做**（`docs/proto-mailbox-ui.html` 的 A 方案照搬落地）：

- 卡面分层照原型：`标题 · 状态文字 · 计时（右对齐）` 一行，下面身份行
  （角色 · run id 尾号 · 回合数）、摘要（两行截断）、元信息行、操作区。
  删掉状态胶囊标签——状态用文字颜色表达，少一层壳。
- 「正在跑什么」上卡：status 的 `currentTool` 显示成 `bash 2.3s`（每秒单独刷新）。
- 代际链 / 多子代理明细折成一行（虚线分隔 + ▸），点开才展开；展开状态自己记，重绘不丢。
- 回执从纯文字行改成 chip（↑ 投递中 / ✓ 已插进这一轮 / 排队 / 失败），5 分钟后不再显示——
  那之后它是历史，不是刚才发生的事。
- 顶部浮层 / 降级横幅 / 空态 / 诊断区全部按原型口径重绘；颜色一律走宿主 `--pi-*` token，
  语义色用 `light-dark()` 跟随宿主主题（不再靠 `prefers-color-scheme` 猜）。

**可分辨性（P1）**：卡片主标题改用子代理会话名（`steps[0].sessionName` 去掉角色前缀、
截到 `工作目录:` 为止）；同角色并发时不再都是 "worker"。身份行带 run id 前 8 位——
插话 / 停止都得认这个 id，只写角色名对不上号。

**交互修正（P2）**：「插话」按钮改 toggle，再点一次收起；Esc 收起；收起时未发送的
内容丢弃并给轻提示。

**重绘根因修掉一层**：计时数字之前虽是 textContent 单独更新，但它的值仍参与
`lastHtml` 比对——每秒算出的 HTML 都不同，整块 innerHTML 实际每秒重建一次，
「HTML 没变不碰 DOM」形同虚设。现在计时 / 工具标签在 HTML 里是**空占位**，
插入 DOM 后由 `tickTimings` 填充，结构没变就真的不重绘（打字焦点实测 3s 不丢）。

测试 85 例（新增 sessionName 三来源贯通）。
