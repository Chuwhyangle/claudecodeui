# Transcript 的 authored message identity 与 edit 事务（design note）

| 项 | 值 |
|---|---|
| 状态 | **design note（未实施）**——先定不变量/状态机/事件，再分阶段落地 |
| 日期 | 2026-10-24 |
| 基线 | `author` @ `6c0d362f4` |
| 范围 | 打字发送与“编辑重发”的 replacement 行；语音 caption 的身份见 `docs/proposals/id-relations-and-projection-invariants.md` |
| 现象 | 编辑后回合仍在飞行中时切走再切回，编辑后的 user 行出现两次：原位一条（有 anchor）、末尾一条（只有 Copy） |

---

## 1. 问题定性

当前 bug 不是“下标算错一位”，而是**用户消息没有贯穿全程的身份**。

- 客户端在发送时造 `local_<时间>_<随机>`；provider 落盘后是另一个 id（Claude 是 transcript uuid，Codex 是 turn id）。
- 两者之间只能靠“文本相等 + 时间窗 + 当前窗口下标”去猜。
- 编辑重发时，`truncateAt` 把**当前窗口内的相对下标** `cutIndex` 存进 `replacesAfterRowCount`（`src/modules/chat/hooks/useSessionStore.ts:1612,1633`）；退休逻辑又在**另一个窗口**里把它当下标用（`src/modules/chat/utils/session/sessionMessageReconciliation.ts:151`）。
- 窗口一滑，坐标系就变了。实测：`cutIndex=20, floor=20`，切回后持久化行在下标 `19`，被跳过；未退休的 replacement 被 `readSortTime` 钉到 transcript 末尾（`useSessionStore.ts:378-381`）。

窗口是**视图**，持久化是**事实**。视图会滑动、重取、分页；事实不会。当前实现把“持久化”表达成了“出现在当前窗口的某个下标”。

---

## 2. 设计原则

1. **身份优先于坐标。** 下标只回答“取哪一页”，不回答“这是哪条消息”。
2. **窗口是纯视图。** 切会话、刷新、分页只改变可见范围，不改变“哪些消息存在”。
3. **持久化事实是会话级的。** 一旦某条 authored message 被持久化，这个事实不因窗口滑走而消失。
4. **服务端是持久化的权威。** provider 把 user 行写进 transcript；服务端负责把“哪一行”映射回 authored id 并广播。
5. **provider 用能力契约说话。** 能携带/报告调用方身份就声明支持；不能就显式走 legacy，不允许用一个全局文本启发式假装知道。

---

## 3. 不变量

- **I1（身份）**：一条 authored message 从创建到落盘只有一个 `authoredId`；任何 persisted 行的下标、时间戳、文本都不是身份。
- **I2（退休）**：一条 pending 用户行当且仅当“该 `authoredId` 已持久化”时退休；与它是否在当前窗口无关。
- **I3（编辑事务）**：一次 edit 必须同时携带 `anchorId`（被替换）与 `replacementAuthoredId`（替换物）。
- **I4（窗口无关）**：切会话、刷新、窗口平移不得改变最终 transcript 中 authored message 的集合，只改变可见范围。
- **I5（一对一）**：两条文本相同的独立消息必须各占一行；一条消息永远不能画两次。
- **I6（provider 契约）**：声明 `supportsMessageEditing` 的 provider 必须能报告本次 run 持久化了哪一行；报告不了就不应开放编辑。
- **I7（坐标来源）**：历史分页的 `startIndex` 由服务端显式给出，不由客户端用 provider 的 `total` 反推。

当前实现违反 I1、I2、I3、I7；I4/I5 是用户看到的结果。

---

## 4. 身份模型

```ts
type AuthoredMessage = {
  authoredId: string;          // 稳定 UUID，发送/编辑时确定
  sessionId: string;
  text: string;
  state: 'pending' | 'accepted' | 'persisted' | 'failed' | 'cancelled';
  replacesAnchorId?: string;   // edit 事务才有
  providerRowId?: string;      // persisted 后由服务端告知
  providerAnchorId?: string;
};
```

- `authoredId` 与 provider row id 是两条不同的边：前者属于“人说的话”，后者属于“provider 写的行”。服务端账本负责把它们连起来。
- 客户端 pending 行保留 `id = local_<authoredId>` 的形状（不直接冒充 provider id），另带 `authoredId`。
- `transcriptAnchorId` 仍然只由 provider 行提供；不要给未持久化的 pending 行提前挂 anchor，否则编辑/fork 按钮会在服务端还找不到它时出现。

### 会话级已持久化集合

```ts
slot.persistedAuthoredIds: Set<string>;  // 只增不减
```

任何一条历史页、persisted realtime 行、`message_persisted` 事件都往里加。退休判断只读这个集合：

```ts
visiblePending = pending.filter(m => !slot.persistedAuthoredIds.has(m.authoredId));
```

它跨窗口累积，因此 I2/I4 成立；不再需要 `replacesAfterRowCount`。

---

## 5. 状态机

### 5.1 普通发送

```text
composing
  └─ send ─▶ pending（本地行可见）
               ├─ server accepted ─▶ accepted
               │                        └─ provider row persisted ─▶ persisted（本地行退休）
               ├─ refused / timeout ─▶ failed（草稿保留）
               └─ abort ─▶ cancelled
```

- `pending → accepted` 只表示服务端收下了，不是退休理由。
- `accepted → persisted` 才退休；退休依据是 `authoredId`，不是窗口。
- 重试复用同一个 `authoredId`（服务端按 session + authoredId 幂等）。

### 5.2 编辑重发（事务）

```text
idle
  └─ edit(anchorId) ─▶ announced
                         ├─ server: replacementAuthoredId 生成
                         ├─ history_truncated { anchorId, replacementAuthoredId }
                         ├─ rewind / resumeSessionAt / resident rebuild
                         └─ dispatch run(replacementAuthoredId)
                                ├─ provider row persisted
                                │    └─ message_persisted { replacementAuthoredId, providerRowId }
                                │         └─ replacement 本地行退休
                                └─ failure ─▶ edit_failed（客户端重读历史还原）
```

- 第 2 步的 `replacementAuthoredId` 由服务端生成，随 `history_truncated` 下发；客户端在 `truncateAt` 时把它写到 replacement 本地行上。
- `truncateAt` 不再需要 `cutIndex` 来决定退休；它只需要 `anchorId`（截断旧行）和 `replacementAuthoredId`（认领替换行）。
- 首条消息编辑的 `resumeFromScratch` 走同一状态机；provider session 归属是独立问题（见 §9）。

---

## 6. 事件

| 事件 | 方向 | 载荷 | 语义 |
|---|---|---|---|
| `chat.send` | client → server | `{ sessionId, content, authoredId? }` | 普通发送；缺省由服务端生成 |
| `chat.edit-send` | client → server | `{ sessionId, anchorId, content, authoredId? }` | 编辑事务；缺省由服务端生成 replacement id |
| `message_accepted` | server → client | `{ sessionId, authoredId }` | 可选；服务端受理，不退休 |
| `history_truncated` | server → client | `{ sessionId, anchorId, replacementAuthoredId }` | 编辑事务宣告；第二字段是新增 |
| `message_persisted` | server → client | `{ sessionId, authoredId, providerRowId, providerAnchorId? }` | 持久化事实；退休的唯一依据 |
| `turn_failed` | server → client | `{ sessionId, authoredId, code }` | 失败；本地行保留为草稿/失败态 |

事件发送方是服务端的 run 账本，不是客户端推断。`message_persisted` 可以晚于 `history_truncated`，也可以发生在历史页刷新之前；客户端按 `authoredId` 认领即可。

---

## 7. Provider 能力契约

```ts
messageIdentity: 'caller' | 'provider' | 'none'
```

- **Claude → caller**：`buildPromptMessages` 把 `authoredId` 写成 `SDKUserMessage.uuid`；per-run 与 resident（`claude-host-driver.provider.ts:4237-4246` 已给每条 prompt 盖 uuid）共用约定。`normalizeMessage` 已把 user 行的 `raw.uuid` 映射成 `transcriptAnchorId`（`claude-sessions.provider.ts:1130-1142`）。
- **Codex → provider**：user 行锚点是 Codex 生成的 `turnId`（`codex-sessions.provider.ts:2038`），调用方控制不了；由服务端账本把本次 run 的新 turn id 映射回 `authoredId`，再发 `message_persisted`。
- **Cursor / OpenCode → none**：今天本来就没有编辑能力，不涉及。

先决测量（阶段 2 再做，不阻塞阶段 0/1）：

```text
normalUuidPersisted=<true|false>
editResumeUuidPersisted=<true|false>
residentUuidPersisted=<true|false>
```

普通 turn 已实测 true；edit/rewind 与 resident held-input 尚未逐字测。只有这两项为 true，Claude 才走 caller identity；否则 Claude 也暂时留在阶段 1 的坐标止血路径。

---

## 8. 与阶段 0/1 的关系

- **阶段 0**：把问题变成可判定的 store 级已知缺陷用例（窗口原点 ≠ 0 + 窗口平移 + 正控制）；不改生产代码。
- **阶段 1**：止血——`truncateAt` 存绝对切点、退休消费窗口原点、tail page 显式 `startIndex`、处理 `cutIndex < 0`。它仍然使用文本/时间匹配，但坐标不再跨窗口混用。
- **阶段 2**（另立任务）：身份贯通，删除 `replacesAfterRowCount` 与文本/时间启发式。

阶段 1 不是最终架构，只是把当前用户路径修到“不再重复”，并为阶段 2 留出干净的删除点。

---

## 9. 非目标与独立问题

1. **编辑首条消息的 provider session 归属**：`resumeFromScratch` 会产生新 jsonl，同步器可能再建 app session 行；原 app session 的 `/messages` 仍指向旧 transcript。这是 run→provider session 的归属问题，另立任务。
2. **`truncateAt` 找不到 anchor**：当前直接返回，本地不截断、服务端已截断。阶段 1 只处理“锚点只在 realtime 里”的安全切点；锚点比窗口更老的路径另立判据。
3. **语音 caption**：`itemId`/`deliveryId` 的身份模型已在 `id-relations-and-projection-invariants.md` 中定义，本 note 不重述。
4. **多标签页**：`message_persisted` 是广播；没有本地 replacement 行的标签页只是更新账本，不画第二行。
