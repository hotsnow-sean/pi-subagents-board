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

## 0.6.2 — 插话竞态与标题时序（实测报告 v3 的 P2′ / P1″ / P1′ 短期）

**P2′ 插话竞态（三件全修）**：

- **回执事后核对**：steer RPC 只回受理时的状态（多半 queued），真正的失败——比如
  「run 在你发出去 66ms 后结束了」——只写进 run 的 status.json。现在回执带
  `requestId`，main 每次 getState 都拿它去 `steering.recent` 里对：失败就改口
  （红 chip + 人话原因），送达才说送达。**失败不再静默丢失**。
- **完成态闸门**：表单展开后 run 结束 → 卡面状态文字就地变「已完成」（只换文本不重建，
  焦点不丢），闸门行提示 + 发送禁用，**草稿留在框里**；提交前也有一道数据层校验。
- **投递计数上卡**：`插话 N · M 没投进`（meta 行，失败时红色，悬停看全量）。数据来自
  status.json 的 `steering`——RPC status 不带这个字段。

**P1″ 标题**：

- **运行中就有标题**：agent 每轮 status 后读 run 的 `status.json`（`asyncDir` 在
  started 事件里就有），把 `steps[0].sessionName` 补进 live 状态——不再等 complete。
  值没变不写回，面板的重绘判定不受影响。
- **resume 段不再显示复活提示语**：`You are reviving a previous…` 识别为噪音，
  标题沿链回退到上一段的（一条链同一个人，成立）。
- **`【…】` 优先**（P1′ 短期）：首行里方括号段提到最前，上游 48 字符截断啃不掉名字。

新增 `lib/run-snapshot.mjs`（只读、mtime 缓存、坏文件/超大文件一律 null）。
读的是扩展私有产物，全部容错——读不到就退回旧行为。测试 95 例。

## 0.7.0 — resume 标题回原 run 取 + 模型档位上卡（实测报告 v6）

**P1″ 结论 2（resume 标题是模板句）**：

- 报告给的三条路里选了**方案 1（面板读原 run）**：resume 段的 `status.json` 带
  `revivedFrom`，顺着它去同父目录读原 run 的 `status.json` 就有真标题，零后端改动；
  连环 resume 最多回追 4 跳。原 run 目录被清理时退回角色名，不编。
  不选方案 2（读 events 里的 `Follow-up:`）是因为那等于绕开上游对 prompt 的有意脱敏。
- **不依赖代际链**：链是按事件/子会话文件拼的，插件中途启动或跨会话 resume 时可能缺段；
  `revivedFrom` 是文件里的硬事实。UI 沿链回退保留作兜底（两道保险，mock 的 `?raw=1` 验过）。
- 卡片身份行加 **`↻ 续 <runId 前 8 位>`**：resume 卡与原卡同名，不给标记分不清是哪一次。

**P1′（`options.name` 被上游静默忽略）**：`run-snapshot` 现在读 `status.json.name`——
扩展哪天把它落地，面板零改动直接把人给的名字当标题（优先于 sessionName）。

**P3 可视化那一半**：卡片 meta 行显示实际用的模型与思考档位（`deepseek-v4-pro · high`），
调用参数 > frontmatter > 全局默认的分层在卡上直接可查，不用再翻 status。

**P2′ 建议 2（回执文案不用完成态口吻）**：queued 的 chip 从「已排队，等它这一步结束」
改成「已受理，它这一步做完才插进去」；投递中改「正在投递…」。

其余（P0 workflow Windows 启动、P1′ 的 `name` 落地、P2′ 后端亚秒窗口、P3 默认模型）
都在 pi-subagents 上游，插件侧无能为力。测试 103 例。

## 0.7.1 — 重绘、打开、标题三处的根因修（实测报告 v12）

**P7：整块重绘的根因不在计时，而在诊断区的心跳。** 卡片里的计时早就占位化了，
但「诊断」折叠区的 `心跳 3s 前` 每秒都不同 → 整段 HTML 每秒变一次 → `innerHTML`
整块重建。实测对照：心跳年龄每秒变化时卡片节点 2.5s 后被替换、选区被清空；不变时存活。

- 秒级字段全部占位：`<dd data-heartbeat>`、历史段计时也改 `<span data-timing>`；
- 页面拆成五个分区（notice / head / banner / cards / diag），各自比对后只写变化的；
- 卡片按 `data-card=runId` 增量替换：key 序列没变时只换内容真变了的那张。
  mock 验证：给卡片/顶栏/骨架打标记，2.6s 后标记全在（节点没被替换），计时照走。

**P9：不再固定 1s 空转。** 拉数据按活跃度 1s / 3s / 5s 调整，`document.hidden`
时完全停（恢复可见立刻拉一次）；UI 心跳单独 1s 跑，拉取变慢不影响计时显示。
mock 验证：隐藏后 2.5s 内 `getState` 调用数不变（3→3），恢复后 +1。

**P8：打开按钮按存在性置灰。** 根因是 UI 写 `childSessionFile || children.find(...)`，
有值就短路——而 4 个 workflow 父 run 的 `childSessionFile` 实测全部悬空，真实路径在
`status.json` 的 `steps[].sessionFile` 里（实测存在）。

- agent 侧按 `childSessionFile → children[].sessionFile → steps[].sessionFile` 排候选；
- main 侧 `existsCached`（5s 缓存）取第一个真实存在的，给出 `openTarget` / `openState`；
- `openState=missing` 的按钮置灰并说明「文件已不在磁盘上」，`none` 不出按钮；
- 提示层改 `position: fixed`，同 `(sessionFile)` 8 秒内只提示一次。

**P6：卡片标题有了完整链路。** `steps[].label`（排除等于 `workflowKey` 的占位符，
实测单个 step 的 workflow 会退化成 `task-1`）→ sessionName → 子代理 name →
`agent · runId8`。mode 永不作标题——之前 workflow 父 run 显示成「workflow」，就是
兜底只写了角色名。

**P1″：resume 徽标指向最初那条。** 连环 resume 时直接来源本身也是续跑，
徽标改显示根 run，`title` 写明「第 N 次续跑 · 直接来源 X · 最初那条 Y」。
`resolveRunTitle` 顺带返回 `rootRunId` / `hops`。

测试 106 例（新增 3：label 优先级与占位符过滤、steps 三字段、openTarget 三种结局）。

## 0.7.2 — 两个「打开」通向同一份会话、切视图时的闪烁与滚动丢失

**A. workflow 容器抢占子步骤的会话。** 实测 `8a08d1b2`（workflow 父 run）和
`370599a9`（它那一步的 run）的「打开」进的是同一份 `session.jsonl`。
原因是父 run 是个容器，它压根没有自己的会话：`childSessionFile` 猜出来的
`<runId>/run-0/session.jsonl` 并不存在（`status.json` 目录里只有
`events.jsonl` / `mission.json` / `workflow-*.jsonl`），于是候选链落到
`steps[0].sessionFile`——而那正是那一步自己的会话，它在列表里另有一张卡。

- `decorateOpen` 改两遍：先收集「谁自己的 `childSessionFile` 真实存在」，
  再逐段定目标；目标属于别人的会话 → `openState = 'shared'` + `openOwnerRunId`；
- UI 对 `shared` 不出「打开」，只写一行暗字「容器 · 会话见 <runId 尾号>」；
- 代际链里的历史段同样只认 `openState === 'ok'`，不拿借来的路径当入口。

**B. 切视图时的白闪与滚动丢失。** `context` 事件一到就 `el.innerHTML = ''`，
把 DOM、滚动位置、以及「上一帧」一起扔掉，于是：
打开子会话 → 侧栏弹回顶部；本来就在顶部 → 闪一下（空白 → 正在读取 → 卡片）。

- 不再清 DOM、不再清 `snapshot`：新数据到达前保留上一帧，只 patch 变化的区块；
- **滚动位置按内容归属（`ownerSessionKey`）记忆**：打开子会话时内容还是父会话
  那条链，归属没变，滚动位置原地不动；切到别的会话才换回它上次停的地方。

**C. 从设置页回来要等一会儿才出卡片。** 两个原因，都在这一版修掉：

- 桥的 `context` 是 hello 之后才 `postMessage` 过来的，界面起来那一刻还是 `{}`。
  原来的代码立刻 `getState`，拿到「没有打开会话」的假状态并弹横幅，真上下文
  到了再重画一次——先假后真的两次空态。现在没 `sessionFile` 就先等（1.5s 兜底，
  真没开会话时照旧给结果）；
- `tick()` 在请求在飞时直接 `return`，切会话/回前台那次刷新会被悄悄丢掉，
  要等下一个轮询周期（1–5s）才补上——这就是「明显延迟」。现在排队重跑，
  并且校验结果是否属于当前会话，串台的结果直接丢弃。

测试 107 例（新增：容器 shared 判定；原有 openState 用例补了互不相同的会话文件）。

## 0.7.3 — 「打开」在预览态变成「返回」，卡上标出你正在看谁

打开子会话后面板进入只读预览，列表里就有那一段——但卡上还写着「打开」，
点它打开的是自己，没有反馈，也看不出「我现在看的是谁」。

- main 侧 `markViewing`：预览时把 `openTarget` 与当前 `sessionFile` 比对
  （归一化后比较，Windows 大小写/斜杠方向不影响），命中的段标 `viewing`
  并带 `viewBackTo`（= 父会话文件）；只标 `openState === 'ok'` 的 owner 段，
  workflow 容器借来的会话（shared）不抢这个标记；
- UI：`viewing` 的卡按钮换成「返回」（点了回主会话），卡片加 `.viewing`
  淡蓝边与底色；其余卡照旧「打开」；
- 回到主会话后所有段 `viewing` 归零，按钮自动变回「打开」。

真实数据验证：预览 `370599a9` 的会话时，只有 `370599a9` 那张标 viewing，
返回落点是父会话；回主会话后 viewing 数量为 0。测试 108 例（新增一条）。

## 0.7.4 — 容器与步骤：父子卡片；顶部返回按钮换成图标

**A. 顶部返回按钮只留图标。** 那一行本来就窄，「← 主会话」四个字占的位置比
「子代理 · 本会话」还多。现在是一个 22×22 的 chevron 按钮，`title` 写「返回主会话」，
键盘焦点有描边。卡上那个带字的「返回」保留——那是「我知道我在看谁」的入口。

**B. workflow 容器用它和各步骤的父子卡片。** 之前容器与步骤是两张平级卡：
容器卡借了第一步的会话，所以不出「打开」，只写一行「容器 · 会话见 XXXXXXXX」；
步骤卡散在时间序里，得靠 sessionName 猜它们是一伙的。

关系来源是磁盘事实：容器 `status.json` 的 `steps[].runId` 就是那一步的 run id
（那个 run 在列表里本来就是独立一张卡）。不按 agent 名推断，也不靠「谁借了谁的会话」
——fanout 多步时后者只能认出一个。

- 视觉用**缩进 + 连接线**，不是大框包小框。同一份数据两版都渲染对比过（360px 面板）：
  大框的子卡内容区宽 322px、缩进版 314px——大框只多 8px 宽，却因为父子各多一层
  内边距 + 边框，整组高 18px；四层底色（面板 / 父卡 / 大框 / 子卡）叠起来发闷，
  父卡与大框之间还有一条 2px 的缝，看上去像两块不相干的东西。缩进版一条 1.5px 的线
  从父卡左下角垂下来，层级一眼可见，fanout 多步时也不会长成两三屏。
- 容器卡底色压深一档（`--surface-3`）：它是「一次编排」，不是「一次执行」；
  身份行只写「N 步 / N 步 · M/N 完成」，不再重复角色和 run 尾号。
- 容器不再提供「打开」：入口在下面各自的子卡上，一张卡一个入口，不再出现
  两个「打开」通向同一份会话。
- 子卡按父的 `steps[]` 顺序排（第一步在上），不按「谁最后说话」的 mtime——
  读一个 workflow 的顺序是「先做了什么、再做了什么」。
- **容器的标题**不再取 `steps[0].label`：那是第一步的名字，父子并排时会和子卡
  撞名。容器没有自己的名字（`workflow` 字段是结果和 trace），兜底成
  `workflow · <runId8>`，子卡继续用自己的 label。
- 组的排序锚点是「组内最新活动」，父先启动、子步骤刚跑完的 workflow 不会沉底。
- 父卡不在列表里（跨代际 live 文件）时子卡保持顶层，只是没有缩进——降级不藏数据。

测试 110 例（新增 2：容器认领 steps[].runId 并排在子卡前面、容器不抢第一步的 label）。
