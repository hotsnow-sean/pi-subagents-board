# 方案调整：放弃面板直连子代理，改用邮箱（2026-11-07）

> 状态：**调研 + 设计，未实施**。本文件只回答一个问题——把 P2-c 的「命令通道」换成 DSH 式「邮箱」之后，subagents-board 应该长什么样。

---

## 1. 决策摘要

| 项 | 现在（P2-c） | 调整后 |
|---|---|---|
| 面板打字 | 直接 `steer` 目标 run | **写一封邮件给父会话**，由父 agent 决定是否转达 |
| 实时性 | 5s 双端死线 | **无死线**，durable 排队，父会话下次醒来读 |
| 状态来源 | 我们自己发明的 queued/delivered | 消息自身生命周期（queued/delivered/read） |
| 停止 | 同样走命令队列 | **保留**，但按「控制」而非「对话」处理（见 §7.2） |
| 打开子会话 | 运行中只读、终态可写 | 不变（U3 的结论保持） |

一句话：**面板从「遥控器」退回到「便签 + 观测台」**。唯一的对话面是父会话。

---

## 2. 为什么放弃「直接引导」

### 2.1 生态里零先例（已核）

| | 对话面 | 用户能直接对成员发言 |
|---|---|---|
| DSH / dsh-agent-teams | 单一（captain） | 不能，只能经 captain 或面板按钮 |
| Claude Code Agent Teams | 多面（选项切换焦点） | 能，但走的是「切到那个会话」而非「从别的界面遥控」 |
| subagents-board | 面板内独立坞 | 能，且**不切焦点、不经父会话** |

第三种在六家里找不到同类。前两种各自成立，因为它们各自有完整的「你在跟谁说话」的心智。

### 2.2 我们其实在和 pi-subagents 抢同一件事

pi-subagents 内部已经有一整套转向状态机（`bundle/chunk-3RKFH2UZ.js`）：

- `status.steering.targets[].state`：`scheduled / pending / delivered / failed / recovered`
- `deliveryStatus`：`queued / delivered`
- `waitForSteeringAction` 默认 3s ack 超时
- `mode`：`steer`（打断当前轮） / `follow_up`（排队到下次 resume） / `auto`
- 每次动作写 `events.jsonl` 的 `subagent.steering.notice`

而我们在外面又套了一层 `cmd/ → rename 认领 → RPC → cmd-result/`，自带 5s 双端死线、过期判死、会话名前缀过滤。**两层状态机叠着**，结果是：面板显示的是我们这层的状态，真实状态在它那层。用户看到「已投递」，系统里可能还是 `pending`；我们看到「超时」，它可能已经 `delivered`。

这不是实现瑕疵，是**架构错位**：我们在替一个已经有状态机的系统再发明一个状态机。

### 2.3 直连带来的三个说不清的问题

1. **身份问题**：面板里打的字，是谁说的？说给谁？UI 上没有位置表达「这是用户对某个子代理说的话」。
2. **越权问题**：父 agent 编排着这批子代理，面板却绕过它直接下命令。父 agent 的上下文里没有这条指令，它的后续决策建立在错误的前提上。
3. **失败不可解释**：5s 没回执就说「会话不活跃」，但真实原因可能是扩展没装、实例换代、或它在排队。

---

## 3. DSH 邮箱解剖（照抄对象）

### 3.1 存储

`<workspace>/.agent-teams/<teamId>/inbox/<recipient>.jsonl`，**每个收件人一个 JSONL 文件**，`captain` 是一个特殊的 key。

### 3.2 消息字段

```
id            uuid
from / to     发送者 / 收件人
content       正文
ts            创建时间
deliveryClaimedAt  投递租约（60s 过期后可重试）
deliveredAt   已被宿主接收（≠ 模型读过）
readAt        模型端真正消费
discardedAt   丢弃（代际失效时）
taskId / attemptId / sourceTaskId / sourceAttemptId  可选，绑任务代际
```

### 3.3 状态机

```
create → append（未标记）
   ↓ 投递方读 pending（未投递 且 未认领或租约过期）
claimMailboxDelivery（置 deliveryClaimedAt，60s 租约）
   ├─ 失败 → releaseMailboxDelivery（清租约，可重试）
   └─ 接收 → markMailboxDelivered（置 deliveredAt，仍未读）
                 ↓ 模型真正进入某个 step
            acknowledgeMailbox（置 deliveredAt + readAt）
或 → discardMailboxMessages（置 discardedAt）
```

### 3.4 最关键的一条：**代际过滤**

`isCurrentMail()` 会检查消息绑的 `taskId + attemptId` 是否还是当前 attempt。任务被转派、旧 attempt 失效后，旧消息**自动作废**，不会在新一轮里突然冒出来。这是「邮箱」和「队列」的本质区别——邮箱有代际，队列没有。

### 3.5 已读的判定点

`installMailboxAdmission` 挂在 `agent/pre-step`：只有**真正进入某个 step 的消息**才被 ack。投递成功但没进上下文，不算读过。作者原话：

> Acceptance by Harness is not evidence that a model step consumed input.

---

## 4. pi-app 环境的能力盘点

### 4.1 有哪些

| 能力 | 位置 | 说明 |
|---|---|---|
| `pi.sendUserMessage(content, { deliverAs })` | `ExtensionAPI`（types.d.ts:1240） | 向**当前会话**发一条用户消息，**永远触发一轮**；流式中用 `steer` / `followUp` |
| `pi.sendMessage({customType,...}, { triggerTurn, deliverAs })` | 同上 | 自定义消息，可控制是否触发轮次 |
| `pi.on('turn_start' / 'before_agent_start' / 'message_end')` | 同上 | 可用于判定「消息真的被消费了」 |
| 上行唤醒（子代理完成 → 父会话） | pi-subagents `createParentWake` | **已存在**，见 4.3 |
| 跨进程 RPC（`steer` / `stop` / `status`） | pi-subagents RPC | **本次要放弃的那条** |

关键：`agent.mjs` 运行在**父会话进程内**，所以 `sendUserMessage` 发的是「父会话自己的」用户消息。这不是写别人的会话，是往自己的会话里投一条用户消息——完全合法。

### 4.2 没有的

- 没有「用户 → 子代理」的原语（除了 steer RPC）
- 没有宿主级「消息入队到主输入框」的 IPC
- 没有跨进程锁；`main` 和 `agent` 是两个进程

### 4.3 上行已经有人做了，别重复

pi-subagents 的 `createParentWake`（`chunk-BWC2LVII.js:5042`）在子代理完成时唤醒父会话，而且它的礼貌策略值得直接抄：

```js
sendMessage(message, options) {
  if (options?.triggerTurn !== true) { pi.sendMessage(message, options); return false }
  if (held || ctx.isIdle() && reserved()) {
    pi.sendMessage(message, { triggerTurn: false })   // 降级：只显示，不唤醒
    return true
  }
  if (ctx.isIdle()) reservation().sentAt = now()
  pi.sendMessage(message, options)
  return false
}
```

- `WAKE_PENDING_MS = 10_000`：10s 内只唤醒一次
- `held`：用户刚中止过 → 不再自动起轮（尊重中止）
- `agentStarted` 清 reservation

**结论：上行（子代理 → 父会话）不需要我们做。我们只做下行（面板 → 父会话）。**

---

## 5. 新方案

### 5.1 三层结构

```
┌─ UI / main 进程 ────────────────────────────┐
│  用户写一条留言 → 落盘（不可变）            │
└──────────────┬──────────────────────────────┘
               │  inbox/<sessionKey>/<id>.json   （只写这一次，之后不改）
               ▼
┌─ agent 扩展（父会话进程内）─────────────────┐
│  扫描 → 判断投递方式 → pi.sendUserMessage   │
│  → 写 receipts/<id>.json（可改）            │
└──────────────┬──────────────────────────────┘
               │
               ▼
        父 agent 收到一条用户消息
        → 自己决定：转达给某 child / 直接回答 / 忽略
```

### 5.2 为什么消息不可变、回执独立

DSH 用 `withTeamLock` 串行化「原地改 JSONL 行」。我们是**两个进程**（main 写、agent 改），没法共享内存锁。

所以拆开：

- `inbox/<sessionKey>/<id>.json` —— **一消息一文件，写入即终态，永不修改**。原子写用 `.tmp` + `rename`。
- `receipts/<id>.json` —— agent 独占写，状态只前进不回退。

这样零锁、零竞争，任意一方崩溃都不损坏对方的数据。代价是文件数多，但一个面板的留言量级（几十条）完全无所谓。

### 5.3 消息结构（对齐 DSH 命名，便于对照）

```jsonc
{
  "id": "01J...",              // ulid，天然有序
  "from": "panel",
  "to": "<sessionKey>",
  "content": "把日志级别改成 debug 再跑一次",
  "ts": 1762488000000,
  // 以下可选，用于「指向某个 run」的留言
  "targetRunId": "7f3a...",
  "targetLabel": "reviewer · run-7f3a",
  "createdBy": "user"          // 为将来的 agent→panel 留位
}
```

回执：

```jsonc
{
  "id": "01J...",
  "claimedAt": 1762488001000,   // agent 认领（租约 60s，过期可重投）
  "deliveredAt": 1762488001200, // sendUserMessage 返回
  "readAt": 1762488020000,      // 父会话进入下一个 step 时
  "discardedAt": null,
  "mode": "steer" | "nextTurn", // 实际采用的投递方式
  "reason": "session-busy"
}
```

### 5.4 投递语义（抄 parentWake 的礼貌规则）

| 父会话状态 | 投递方式 | 理由 |
|---|---|---|
| 正在跑一轮 | `sendUserMessage(text, { deliverAs: 'steer' })` | 插进当前轮，最接近「用户打断了 captain 一下」 |
| 空闲，且 10s 内已唤醒过 | `sendUserMessage(text, { deliverAs: 'followUp' })` | 排队，不重复起轮 |
| 空闲 | `sendUserMessage(text)`（触发新一轮） | 等价于用户自己打字 |
| 用户刚点过停止 | **不投递**，保持 queued | 尊重中止，别自动起轮 |
| 父会话进程不在 | 保持 queued | 等下次加载；这才是 durable |

### 5.5 注入的文本形态

```
[来自面板 · 18:42 · 目标 reviewer(7f3a)]
把日志级别改成 debug 再跑一次

（这条不是用户在主输入框打的；如需转达，用 subagent(action:"steer")。若该 run 已结束，直接向用户说明即可。）
```

三件事必须写进去：**来源**（不是用户直接打的）、**目标**（哪个 run）、**授权边界**（可以不做，但要说明）。最后一句是抄 DSH 的 `COMPLETION_ACTION`——「不要静默放弃，也不要自行扩大授权」。

### 5.6 已读判定

`pi.on('turn_start')` 时，把本会话所有 `deliveredAt && !readAt` 的回执标 read。理由与 DSH 一致：投递 ≠ 消费。

更严一点可以用 `message_start` 匹配注入文本的哈希，但收益不大，先不做。

---

## 6. 变更清单

### 删除

- `lib/cmd-queue.mjs`（`CLAIM_DIR / CMD_DIR / RESULT_DIR / parseCommandFileName / isExpired / buildResult`）
- `agent.mjs` 的 `scanCommands / runCommand / startCommands / stopCommands`，以及 `CMD_POLL_MS`、`COMMAND_TIMEOUT_MS`
- `main.mjs` 的 `steer` / `stop` handler（或改造，见 §7.2）
- `ui/app.js` 的 `#dock` 干预坞、`delivered/queued` 分显、stop 二次确认
- 相关测试：`cmd-queue.test.mjs`

### 新增

- `lib/mailbox.mjs`：纯函数（`buildMessage / validateMessage / shouldClaim / nextReceipt / isAckable`）
- `lib/wake-policy.mjs`：`decideDelivery({ sessionBusy, lastWakeAt, held })` → `steer | followUp | nextTurn | hold`
- `main.mjs`：`postMessage(content, targetRunId?)`、`listOutbox(sessionKey)`、`discardMessage(id)`
- `agent.mjs`：`scanInbox()` + `deliver()` + `ackOnTurnStart()`
- `ui`：卡片上的「留言」入口（不是常驻坞）

### 保留不动

- `lib/lineage.mjs`、`lib/live-store.mjs`、`lib/inbox-watch.mjs`（这是**上行通知**，与本次无关）
- `openSession` / `activate`（U3 结论）
- 诊断面板

---

## 7. 已决（2026-11-07 18:50 与零语确认）

| 问题 | 结论 |
|---|---|
| **停止** | **保留直连，重新定性**。停止是生命周期控制，不是对话。面板保留停止按钮 + 就地二次确认，但不占用输入区。DSH 也是这个分工（说话走邮箱、停止走面板按钮） |
| **空闲投递** | **起一轮，带回执**。用户主动留言 = 意图明确，等同自己打字；遵守 parentWake 的礼貌规则（用户刚中止过则不投），面板明确显示「已唤醒主代理」 |
| **留言入口形态** | **转 UI 实验**。做多方案可交互原型（假数据）对比后再定，见 `proto-mailbox-ui.html` |

### 7.1 由这三条推导出的不变量

1. 面板只有一种「说话」：**给主代理**。
2. 面板只有一种「控制」：**停止**，且它是按钮，不是输入。
3. 二者视觉上必须分开——否则又回到「一个坞里既有说话又有停止」的老问题，那正是 U3/U4 的来源。
4. 留言可能触发一轮模型调用，所以回执必须显式（`已发送 → 主代理已读`），不能静默。

---

## 8. 代价与收益

**代价**

1. 延迟：面板 → 父会话 → 转达，比直连慢一到两轮
2. token：空闲起轮是真金白银
3. 可靠性下放给模型：父 agent 可能忽略或理解错
4. 需要父会话进程在线

**收益**

1. 删掉一整层状态机和它的所有边界 bug（死线、认领、过期、跨实例）
2. 语义与行业一致：一个对话面，一个调度者
3. 留言 durable，不再「5s 后失效」
4. 可审计：每条留言与回执都在磁盘上
5. 面板终于只做一件事：**看**。外加「留个话」。

---

## 9. 参考

- dsh-agent-teams `src/mailbox.ts`（状态机、代际过滤、pre-step admission）
- dsh-agent-teams `src/state.ts`（`appendMailbox` / `mutateMailbox` / `withTeamLock` / 60s 租约）
- dsh-agent-teams `docs/usage.md`（Web UI 行为、停止入口、已知限制）
- pi-subagents `bundle/chunk-BWC2LVII.js:5042`（`createParentWake`）
- pi-subagents `bundle/chunk-3RKFH2UZ.js`（steering 状态机、`follow_up` 排队）
- pi-coding-agent `dist/core/extensions/types.d.ts:1240`（`sendUserMessage`）
- 本仓库 `docs/research-2026-11-07-multi-agent-clients.md` §7.5

---

## 8. 定稿与实施（0.5.0）

零语拍板：UI 按 **A 方案（卡片内联）**；与扩展重复实现的部分全部去掉，用扩展/SDK 提供的。

### 8.1 重复实现清单（已删）

| 删掉的东西 | 为什么是重复 |
|---|---|
| `lib/cmd-queue.mjs` 整层（文件命令队列、rename 认领、5s 双端死线、双端过期） | steer 本体是 pi-subagents 的 steering 状态机（scheduled/pending/delivered/failed/recovered + 3s ack）；改投主会话后连 steer 都不用了，这层只剩成本 |
| 面板自判「会话忙闲」选 deliverAs | `prompt()` **只在 isStreaming 分支读 streamingBehavior**（否则抛 "Agent is already processing"），空闲时忽略。固定传 `steer` 一种写法覆盖两种状态 |
| `delivered` / `queued` 两态文案 | 我们根本不知道子代理/主代理「读没读」。回执只说四种事实：已投给主代理 / 已发出未确认 / 投递失败 / 已过期 |

### 8.2 保留的通道（都来自外部，不自己造）

- 投递：`ExtensionAPI.sendUserMessage(content, { deliverAs: 'steer' })` —— 投给**自己所在的父会话**，不碰别人的会话
- 停止：pi-subagents 的 `stop` RPC（`interruptAsyncRun`）
- 上行唤醒：pi-subagents `createParentWake`（10s 节流、userAborted 后 held）—— 我们不做
- 状态：`status` RPC + 三源事件合并（原有）

### 8.3 邮箱结构（零锁双进程）

```
dataDir/inbox/<sessionKey>/<id>.json    main 写，不可变，一消息一文件
dataDir/receipts/<id>.json              agent 独占写；存在 = 已处理（幂等依据）
```

- 按会话分目录 → agent 只读自己那一格，不需要文件名前缀过滤，也就不需要 rename 认领
- note 不删（回执判断幂等），隔夜由 `pruneMail` 清（24h）
- 单端过期（10 分钟，agent 侧）：隔夜留言不该在开机时突然起一轮模型调用
- 面板**不等回执**：postNote 写完即返回 id。P2-c「面板说没送达、几秒后却真的投了」的窗口不存在了

### 8.4 UI（A 方案）与渲染策略

- 留言表单内联在卡片里；提交后收起，原地一行回执
- 停止就地二次确认（3s 回退），永不占输入区
- 绿色结果横幅删除；提示改为顶部 absolute 浮层（不占文档流）
- 渲染三条：计时数字单独 `textContent` 更新；HTML 未变不碰 DOM；编辑留言时暂停重绘（表单自身状态变化放行一次，`paintOnce`）
