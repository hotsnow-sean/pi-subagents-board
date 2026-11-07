# 其它客户端怎么处理「后台子代理 + 客户端查看同一份会话」

调研时间：2026-11-07
问题起点：pi-app 里子代理是宿主管不到的独立进程，宿主却能查看它的会话。这算不算「两个 pi 进程处理同一份会话」？别的生态怎么做？

---

## 0. 结论先行

看了 DSH（DeepSeek Harness）、dsh-agent-teams、Claude Code Agent Teams、Codex、OpenCode、DSH Super-agent 原型之后，有一条**跨生态一致**的规律，三条都不例外的铁律：

1. **写入权单一**。一份会话在任一时刻只有一个写者——就是那个正在跑 agent 循环的进程。没有任何一个实现让「客户端 / 另一个 agent / 宿主」去写别人正在写的会话。
2. **查看永不夺取运行时**。要看就跑两种路：**读盘**（tail 文件、只读查库），或者**切到那个 agent 自己的视图**（panel / pane / attach）。没有一家是「另起一个运行时加载同一份会话」来给你看。
3. **干涉走消息通道，不走文件**。mailbox、`sendMessage(queue | steer)`、interrupt、持久队列——投递目标是「那个正在跑的循环」，不是「磁盘上的文件」。

pi-app 现在的做法（H3 读盘 tail + 命令队列 steer）落在第 2、3 条上，属于主流路线；**唯一在别的生态里找不到先例的，是「用宿主 worker 打开一个正在跑的子会话」**——因为那正好违反了第 1、2 条。

---

## 1. DSH（DeepSeek Harness）本体

DSH 是 Cordis 内核、一切皆插件（连 agent 主循环都是插件）。子代理不是「主循环里的一个工具」，而是一个 **capability seam**：`ctx.subagents` 是契约，底下挂多个 provider。

### 1.1 两种生命周期

| 模式 | 行为 | 归属 |
|---|---|---|
| one-shot | 跑完一个 session、产出结果、销毁 | 调用方拿 `SubagentRun`，所有权完整转移 |
| continuable | 子 session 持久，跨多轮活着，能收后续消息与中断 | `SubagentManager` 持一个 in-process `Activation` 句柄 |

### 1.2 provider 决定了「进程边界」，也决定了一切

| provider | 进程 | 会话归属 |
|---|---|---|
| `spawn` | **同进程**，新建独立 `AgentLoop`，会话与执行上下文隔离 | 父进程内的 session store |
| `fork` | **同进程**，把父已完成的轮次 fork 进子上下文 | 同上 |
| `acp` | 子进程，ACP JSON-RPC over stdio，带 SIGTERM/SIGKILL 升级 | 子进程自己的 session |
| `codex` | 子进程（`codex app-server --stdio`） | 子进程自己的 session |
| `claude-code` | 子进程（Anthropic Claude Agent SDK，`persistSession:false`） | 子进程自己的 session |
| `dsh-sdk` | 远程 / 自定义 JSON-RPC | 对端 |

**这张表是全部答案的一半**：同进程（spawn / fork）时，UI 可以直接拿活对象、直接 `sendMessage`，不存在「两个进程」的问题；跨进程（acp / codex / claude-code）时，会话属于那个子进程，父侧只能靠协议消息与持久化日志。

### 1.3 continuable 的三个关键机制（可直接抄）

- **Activation**：进程内持有子 agent 的 `AgentHandle` + 一个 **inbox**，父→子消息**顺序处理**。也就是插话是「投进这个 inbox」，不是写文件。
- **`sendMessage()` 支持 queue 与 steer**：排队等当前轮次，或直接插进去。和 pi-app 的 `steer` 是同一个语义层次。
- **Cold resume**：子 agent 当前不在进程里（进程重启 / 被回收），manager **从持久化的会话日志重建**它，再激活句柄。
- **`listChildren(parentId)`**：文档明确写「**不需要加载或恢复子会话就能列出子代理**」。

这条 `listChildren` 的措辞值得单独拎出来——它说明「列出子代理」和「打开子代理会话」在设计上就是两个操作，前者不碰会话文件、不开进程。我们的 lineage 列表同理。

### 1.4 DSH 自己承认的边界

dsh-agent-teams 的 README 边界段原话（英文版）：

> State is file-backed and **serialized within one DSH process**; concurrent processes editing the same team are not coordinated.

以及「队长离线时无法冷恢复成员（任务与消息保留在磁盘）」。

**他们不解决多进程并发问题，而是声明「不做」。** 这是比「用锁硬扛」更常见的工程选择。

---

## 2. dsh-agent-teams（社区插件，把上面这些组装成「团队」）

它把当前 DSH 会话变成 **captain**，拉持久成员、拆带依赖的任务、走邮箱直连。要点：

- **成员默认 `memberProvider: spawn`**（同进程 continuable 子代理）。所以它的 Web 面板能拿到「活的活动」，不是纯读盘。
- **面板数据源是双层**：`/.agent-teams/` 下的**磁盘真相** + **实时 subagent 活动**，合并展示。原话是 "The Web panel reads that disk truth and combines it with live sub-agent activity."
- **消息语义**：后来的 mailbox 消息 "barge in with new instructions"（直接插入），只有传 `mode=queue` 才等当前轮次跑完。
- **团队状态文件化**：`stateDir: .agent-teams`，任务 DAG、成员、邮箱都在磁盘；归档保留完整历史。
- **单队长、单活跃团队**；成员默认不能嵌套（`memberMaxDepth: 0`）。
- 一个有意思的进化：部分 fork 版加了 **context pressure 自动接管**（成员 context 用到 70% 就建替代成员、转派其任务）——那是「会话太长」的问题，不是「多进程写文件」的问题。

**对 pi-app 的意义**：dsh-agent-teams 的「磁盘 truth + live 活动」合并，就是我们 `live-store`（内存态落盘）+ 子会话 tail 的同构实现。这条路线有人走，且是同一个理由：**活状态在进程里，历史在磁盘上，面板必须两边都读**。

---

## 3. Claude Code Agent Teams（多进程那一派的代表）

### 3.1 两种形态，进程模型完全不同

| 模式 | 进程 | 通信 |
|---|---|---|
| **in-process**（默认） | 同一 Node 进程，用 `AsyncLocalStorage` 做身份/权限隔离 | 内存直传（共享 AppState） |
| **split panes** | **每个 teammate 一个独立 Claude Code 进程**，一个 tmux pane / iTerm2 分屏 | **文件邮箱** |

每个 teammate 都是「一个完整的、独立的 Claude Code 会话」，有自己的 context window。

### 3.2 查看：切视图，不是加载会话

- **in-process**：输入框下方有 agent panel，上下键选人、**Enter 打开该队友的 transcript 并可直接发消息**、Escape 打断它当前轮次、`x` 停掉它。
- **split-pane**：直接点进那个 pane。

注意这里的设计：**你看到的是「那个 agent 的视图」，不是「把它的会话装进你自己的会话里」。** 焦点在哪个 agent 上是显式状态，查看和发言都在同一个视图里完成。

### 3.3 消息：文件邮箱 + 锁 + 轮询

- 路径：`~/.claude/teams/{team-name}/inboxes/{agent-name}.json`，JSON 数组。
- 写：`writeToMailbox()` 先拿 **proper-lockfile** 文件锁（重试 10 次，5–100ms 指数退避），读-追加-写回-放锁。**锁是必须的，因为多个 agent 进程会同时写同一个 inbox。**
- 读：`useInboxPoller` 每 **1 秒**轮询一次自己的 inbox，取 `read === false` 的消息，处理完标记已读。**没有 watcher、没有 IPC、没有 push。**
- 投递语义（这条最值得抄）：
  - 收件人 **idle** → 立刻作为新的 user turn 提交，模型马上开始
  - 收件人 **busy（mid-turn / 工具执行中）** → 排队，**当前轮次结束后**再投递
  - 标记已读发生在「成功投递或可靠入队之后」，崩溃时宁可重复投递也不丢

### 3.4 他们踩过的坑（我们也可能踩）

- team config 里的运行时状态（session id、pane id）**不能手改**，下一次状态更新会覆盖。
- v2.1.207 之前，邮箱里**一条格式错误的条目会让该邮箱每秒报一次错、直到手动删文件**——「读别人的状态文件」这套设计的典型脆性。
- `/resume` 与 `/rewind` **不恢复 in-process 队友**，恢复后 lead 可能给已不存在的队友发消息。
- 已知「队友偶尔干完活不发完成通知」。

这些坑的性质和我们 E2（实例换代丢历史）、E5（迟到回执）是同一类：**跨进程/跨生命周期的状态一致性，靠约定，不靠类型**。

---

## 4. DSH Super-agent 原型：最硬的做法

这条线不是插件，是 DeepSeek 的架构原型（MIT，明确写「研究原型，不是正式产品」）。它对你的问题给了一个最直接的答案：

- 两层：**Router**（14 个工具，只分派、不干活）+ **Worker**（6 个工具，只干活）。
- 每个 **Ticket** 对应**一个独立会话 + 一个独立目录**。
- `Engine` 是 Trigger / Thread / Decision / Ticket / Assignment 五类聚合的**唯一写入者**。
- 存储是**单个 SQLite 文件**，**Runtime 先取目录锁再打开，防止第二个进程迁移或写入**。
- 副作用走**持久队列**（`Effects`），事务内入队、提交后执行，同 kind/key 只保留一行，失败指数退避。
- 心跳固定节拍：Passes 每 2 秒一次，**同一时间只跑一个 pass**，期间请求合并到下一次。

**这就是「用锁把单写者做成硬约束」**。它不依赖任何参与者自觉，第二个进程**打不开**。

代价也明显：单机、单库、单 Engine，横向扩展要换架构。

---

## 5. 其它两家的做法（简）

| | 进程模型 | 子会话存储 | 查看 / 干涉 |
|---|---|---|---|
| **Codex CLI** | Rust 单体，同进程 | 每个 child 独立 conversation，`fork_turns` 控制继承几轮 | 状态从事件流推导（`TurnStarted/TurnComplete/TurnAborted`）；完成后发 completion envelope；父用 `wait_agent` 等 |
| **OpenCode** | client/server（Hono HTTP + SSE），SQLite 存 session 与消息 | child session 是库里另一条记录（带 `parentID`） | 后台完成时把结果作为 `synthetic: true` 的消息插进父会话；传 `task_id` 可续跑同一个 child |

共同点仍然是：**child 的会话由它自己的运行时持有**，父侧只收到「结果消息」或「状态事件」，不碰对方会话文件。

---

## 6. 四方对照（把 pi-app 放进去）

| | 会话写者 | 客户端怎么看 | 客户端怎么插话 | 多进程一致性 |
|---|---|---|---|---|
| DSH spawn/fork | 父进程 | 直接拿活对象 | 内存 inbox（queue / steer / interrupt） | 不存在（同进程） |
| DSH acp/codex/claude-code | 子进程 | 协议消息 + 持久日志 | 协议消息 | 由 provider 各自负责 |
| dsh-agent-teams | 各成员运行时 | 磁盘 truth + live 活动 | 邮箱（barge in / queue） | **声明不协调**（单进程串行化） |
| Claude Code teams（tmux） | 每个 teammate 自己的进程 | 切 pane / 打开该 agent 的 transcript | **mailbox JSON + 文件锁 + 1s 轮询** | 文件锁 |
| DSH Super-agent | Engine（唯一写者） | 查库 / 网页面板 | 持久 Effects 队列 | **目录锁，第二个进程打不开** |
| **pi-app（现在）** | 子代理进程 / 宿主 worker | **tail 文件（H3）** | **命令文件 + rename 原子认领 + 5s 双端死线** | 结构隔离（主会话归宿主、子会话归子代理） |
| **pi-app（若运行中 bind）** | **两个** | 新 worker 的 SessionManager（快照） | 宿主 prompt（另起循环） | **无**，会产生两条父链 |

最后一行就是唯一的破口，而且它在所有参考实现里都没有对应物。

---

## 7. 对 pi-app 的具体结论

### 7.1 已经被验证的

- **读盘预览是对的**。Claude Code 的 mailbox 是 1s 轮询文件，DSH 的 dsh-agent-teams 面板读磁盘 truth——「文件是真相，进程是消费者」是主流共识。我们的 250ms 节流 + 1.2s 兜底轮询在这个区间里，不算激进。
- **命令队列等价于文件锁**。`rename` 原子认领比 proper-lockfile 更干净（rename 在 POSIX/NTFS 上本身就是原子操作，不存在「锁残留」）。Claude Code 要重试 10 次才拿到锁，我们一次 rename 定胜负。
- **终态 bind 是被允许的操作**，它等价于 DSH 的 cold resume 与 Claude Code 的「队友不在运行时把它带回来」。前提只有一个：**原写者已退出**。

### 7.2 反向证据

**「用宿主 worker 打开一个正在跑的子会话」在所有生态里找不到先例。** 这不是「别人没想到」，是三条铁律的第 1、2 条同时不允许。我们的 `writeable: false` 不是保守，是对齐行业下限。

### 7.3 可以抄的四点

1. **投递语义按收件人状态分流**：Claude Code 的 idle 立即 / busy 排队，比我们现在「一律排队等 5s」更贴近直觉。我们可以让 `canSteer` 的判断落到「agent 当前在不在 turn 里」：不在就直接送（下次它启动立刻看到），在就排。
2. **回执的「重复投递优于丢失」**：Claude Code 明确选了这个 trade-off（崩溃时可能重复投递）。我们现在的 5s 死线是「宁可报没送达」，方向相反——但我们的场景是用户盯着屏幕等回复，报错比静默重投更好。**这条不抄，但要写进文档说清理由**，否则以后会有人以为是疏忽。
3. **单一焦点模型**：Claude Code 的 agent panel 是「当前在看哪个 agent」的显式状态，返回就是焦点切回 lead。这个模型正好治 U1（返回按钮插在卡片之间导致内容跳动）——**返回应该是固定在工具条上的「切回 lead」，而不是卡片流里的一个元素**。
4. **列表不加载会话**：DSH 的 `listChildren` 明确「不加载子会话就能列出」。我们的面板刷新时对每条 lineage 建卡，本来就该只依赖 live 数据，不该顺手去 stat 子会话文件（这条也解释了 E6 读盘开销为什么是设计问题而不是性能问题）。

### 7.4 需要承认的限制（跟 DSH 一样老实）

dsh-agent-teams 明说「队长离线时无法冷恢复成员」。我们同样：**插件 agent 进程不在了，命令队列就没人认领**，5s 后主侧只能报「会话不活跃」。这不是缺陷，是这个架构的边界，应该写在 UI 文案里而不是藏在日志里。

---

## 7.5 UI 层实证：通用输入框能不能对子代理说话（2026-11-07 补）

证据来源：dsh-agent-teams `docs/usage.md` 的「Web UI」「Captain 动态规划与停止整队」「已知限制」三节（据此仓库 README 指向的官方使用文档）。

**结论：不能。DSH 的输入框始终只对 captain 说话。**

三条硬证据：

1. 活动面板「成员行展示职业头像、角色、实时状态和任务标签，**点击可打开成员子会话**」；历史场景的措辞是「点击成员可打开其**持久化会话记录**」。**打开 = 查看 / 回放**，文档从未描述「打开后在该会话里发言」。
2. 成员的唤醒由 scheduler 和 `ctx.subagents.followup()` 驱动；用户的操作入口是**面板按钮**（Approve & Run / 返回对话修改 / 放弃本次计划），以及"Web approval wakes the captain with a control message"——控制消息的收件人是 **captain**。
3. `agent_teams_send_message` 是**成员 ↔ 成员 / 队长**的邮箱工具（「拒绝冒名 `from`」），不是用户 → 成员的通道。

所以用户的干预面只有三个：输入框（只到 captain）、面板（改成员模型/角色、改任务负责人与依赖、停止团队）、对 captain 说「去调整」。

### 生态分叉：谁持有对话面

| 模型 | 对话面 | 用户能直接对成员发言吗 |
|---|---|---|
| DSH / dsh-agent-teams | **单一**（captain），成员靠 captain 或邮箱驱动 | 不能 |
| Claude Code Agent Teams | **多面**（agent panel 选人 → Enter 进该 teammate 的 transcript） | 能 |
| subagents-board（现状） | 面板内独立坞，既不切焦点、也不经父会话 | 能，但走的是**第三种**路 |

这条分叉有两个直接推论：

1. **我们的「坞」没有可参照的心智**：它既不是「跟父会话说」，也不是「切到那个会话去说」。用户觉得「交互一般」，有一半原因是它是第三种模型，无从类比。收敛只有两个方向——**并到父会话**（学 DSH：插话 = 给主 agent 的普通消息，由它转派）或**切到子会话**（学 Claude Code：焦点切换，输入框跟着选中卡走）。中间态在生态里找不到先例。
2. **「停止不占输入区」被实证了**：DSH 把停止团队从 composer 挪到团队标题右侧 + 二次确认，原文是「**入口不再占用聊天输入区域**」，且「输入框仍可在停止完成后发送新的恢复指令」。这是他们迭代**之后**的结论，不是初始设计——正好支持 U4，也支持「停止与插话不该共用一个坞」。

另有一处值得抄的边界文案：`agent_teams_status` 被要求「以磁盘为准汇总」，因为「模型不总是严格走工具仪式」——与我们对「面板如实反映磁盘真相、不以 agent 自报为准」的判断同向。

---

## 8. 参考来源

- DSH subagent orchestration（DeepWiki，含 provider 表、Activation、cold resume、`listChildren`）
- dsh-agent-teams README / 边界说明（dshpluginhub、dsh-plugin.org、dshfind）
- Claude Code 官方文档 *Orchestrate teams of Claude Code sessions*（display mode、mailbox 路径、idle/busy 投递、agent panel 操作）
- Claude Code swarm 源码分析（社区，基于 v2.1.88 source map：`proper-lockfile` 重试参数、1s 轮询、8 种消息类型、`markAsRead` 时机）
- DSH Super-agent 原型 `docs/007-architecture.md`（Engine 唯一写入者、SQLite、目录锁、Effects 队列、2s Passes）
- Codex CLI / OpenCode 的 child session 机制（第三方架构分析：`spawn_agent`、`fork_turns`、`parentID`、`synthetic: true`）
