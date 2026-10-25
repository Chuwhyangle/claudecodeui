# Notice：统一的「需要人知道的事」模型与可忽略机制（design note）

| 项 | 值 |
|---|---|
| 状态 | **design note（未实施）**——先定模型/不变量，第一阶段只接入部署一个来源 |
| 日期 | 2026-10-25 |
| 基线 | `author` @ `1ddd2e531` |
| 起因 | 聊天页顶部的部署 banner（`DeployReadiness compact`，经 `noticeSlot` 注入）无法关闭；同时系统没有统一的应用内通知机制 |
| 已拍板 | ① 忽略状态存**服务端**、按用户；② 打断位**同时只显示 1 条**，其余折叠计数；③ **先只接部署**，`decisionQueue` / `useVersionCheck` / quay 异常留待后续阶段 |

---

## 1. 现状（已核实）

「需要人注意的事」目前散落在三套互不相通的实现里：

| 机制 | 位置 | 生命周期 | 应用内落点 | 可关闭 |
|---|---|---|---|---|
| 事件通知 | `server/modules/notifications`（`action_required` / `stop` / `error` 三类，20 s 去重） | 一次性事件 | 无（只发系统通知 / Web Push） | 偏好开关 |
| 状态提示 | `DeployReadiness`、`useVersionCheck` | 条件成立期间一直在 | 各组件自己轮询、自己渲染 | **否** |
| 待决策项 | 驾驶舱 `decisionQueue`（`attentionId`、`firstSeenAt`、选项、证据） | 人裁决前一直在 | 仅驾驶舱页 | 裁决即消失 |

聊天页顶部在消息列表之前还有 `UiNavigatePrompt`、locate 未命中提示、`SessionTaskChain`、`noticeSlot`。`noticeSlot` 是一个通用 ReactNode 槽，当前唯一使用者是部署 banner，**没有任何文档定义槽位的准入规则**。

部署 banner 的具体事实：

- 读数来自 `server/modules/system/deploy-readiness.service.ts`，全部以 `appRoot` 为根（本应用的 `dist-server/` / `dist/` 构建记录与本 checkout 的 HEAD），**不含**其它项目或 quay 状态。
- 前端每 15 s 轮询 `/api/system/deploy-readiness`；组件内没有 dismiss 状态，没有持久化。
- 它的内容是**状态**而非事件：「有 N 个提交未构建」每次轮询都重新为真，所以「点掉就删」的通知语义不适用。

## 2. 问题定性

缺的不是一个关闭按钮，而是**对「条目生命周期」的建模**。三套实现的差别只在生命周期（一次性 / 条件成立期间 / 待裁决），却各自实现展示、轮询和（不）关闭。继续逐个加按钮会得到互不一致的关闭语义，并且没有人负责回答「顶部这个位置到底该放什么」。

## 3. 设计原则

1. **按生命周期建模，不按来源建模。** 来源只是 provider；展示与忽略规则由生命周期与严重度决定。
2. **忽略 ≠ 删除。** 忽略只记录「我已看过 revision X」，条件本身不受影响。
3. **条件变了才重新出现。** 状态型条目的忽略绑定到 `revision`；revision 变化即视为新消息。
4. **严重度决定忽略权。** 不能因为用户嫌吵而藏起失败。
5. **打断位稀缺。** 同时只有 1 条可打断；其余进收件箱，不抢位置。
6. **服务端是忽略状态的权威。** 同一用户在手机与桌面看到同一结果。

## 4. 模型

```ts
type NoticeLifecycle = 'event' | 'condition' | 'decision';
type NoticeSeverity = 'info' | 'attention' | 'blocking';

type Notice = {
  id: string;            // 稳定标识，如 'deploy:pending-build'
  source: string;        // 'deploy' | …（第一阶段只有 'deploy'）
  lifecycle: NoticeLifecycle;
  severity: NoticeSeverity;
  revision: string;      // condition 的版本键；部署用 headSha
  scope: 'global';       // 第一阶段只有 global；project / session 留待后续
  title: string;         // i18n key + 参数，不是已渲染文本
  params: Record<string, string | number>;
  primaryAction?: { id: string; labelKey: string };
  raisedAt: string;
};
```

### 4.1 忽略规则

| lifecycle | severity | 可忽略 | 忽略键 |
|---|---|---|---|
| condition | info / attention | 是 | `(user, id)` → 已忽略的 `revision`；`revision` 变化即失效 |
| condition | blocking | **否** | — |
| event | 任意 | 确认即消失 | 确认时间 |
| decision | 任意 | **否**（必须裁决） | — |

第一阶段只实现 `condition`；`event` 与 `decision` 仅在类型里保留，不接线。

### 4.2 打断位准入

聊天页顶部的槽渲染：`scope = global` 且 `severity ≥ attention` 且未被忽略的条目，按 `blocking` > `attention`、再按 `raisedAt` 新者优先排序，**只显示第 1 条**，其余以「另有 N 条」折叠，点开进入收件箱视图。

## 5. 部署来源如何映射

| 部署读数 | Notice |
|---|---|
| `fresh` | 无条目 |
| `pending-build` / `built-pending-restart` | `deploy:pending-build`，condition / attention，`revision = headSha`，主操作「构建并重启」 |
| `building` / `restarting` | 同一条目的进行中态（主操作隐藏），不新增条目 |
| `failure !== null` 或 `lastDeploy.ok === false` | `deploy:failed`，condition / **blocking**，`revision = failure.at`，**不可忽略** |
| `unknown` | 无条目（驾驶舱完整形态仍显示「状态未知」） |

驾驶舱页的完整部署条保持常驻，**不受忽略影响**：那里是状态面板，不是打断位。

## 6. 分层与接口

### 6.1 服务端

- 新 module `server/modules/notices/`（遵循 `$backend-module-standards`，叶子目录，经 barrel 导出）：
  - `notice-registry.service.ts`：持有 `NoticeProvider[]`，`list(userId)` 汇总、套用忽略、排序。
  - `NoticeProvider = { source: string; read(): Promise<Notice[]> }`。部署 provider 由 `system` module 注入，**notices 不反向 import system**，避免环。
  - `notice-dismissals` 仓库：表 `user_notice_dismissals(user_id, notice_id, revision, dismissed_at)`，主键 `(user_id, notice_id)`，写入为 upsert（只保留最近一次忽略的 revision）。
- 路由：
  - `GET /api/notices` → `{ active: Notice[], dismissed: Notice[] }`（已按规则排序；`dismissed` 供收件箱）。
  - `POST /api/notices/:id/dismiss` body `{ revision }`。服务端校验：条目存在、当前 `revision` 等于请求的 `revision`、且 `severity !== 'blocking'`；否则 409 / 403，不静默成功。
- 不改 `notifications` module：它仍是 event 类条目的外发渠道，本阶段不接。

### 6.2 客户端

- 新 `src/modules/notices/`（遵循 `$frontend-module-standards`）：`useNotices`（轮询，沿用 15 s，推送留待后续）、`NoticeSlot`（打断位，1 条 + 折叠计数 + 忽略按钮 + 主操作）、`NoticeInbox`（折叠展开后的列表，含已忽略项）。
- `WorkspaceMain` 的 `noticeSlot={<DeployReadiness compact />}` 改为 `noticeSlot={<NoticeSlot />}`；`DeployReadiness` 的紧凑形态下线，完整形态留在驾驶舱。
- 「构建并重启」的确认面板与 `POST /api/system/deploy` 不变：`primaryAction` 只是打开同一个确认面板，**确认仍是离散的人类动作**（设计上拒绝语音「是」触发重启，这一点必须保持）。

## 7. 不变量

- **N1（忽略绑定 revision）**：对 `(user, id)` 的忽略只对当时的 `revision` 有效；`revision` 变化后条目重新进入 `active`。
- **N2（blocking 不可忽略）**：服务端对 `blocking` 的 dismiss 请求必须拒绝，客户端不渲染忽略按钮；两侧各自独立成立。
- **N3（忽略不改变条件）**：dismiss 不触发任何部署读数、构建或重启。
- **N4（打断位单条）**：`NoticeSlot` 任意时刻至多渲染 1 条完整条目，另有条目时必有折叠计数。
- **N5（跨设备一致）**：同一用户在两个客户端先后读取，忽略结果一致。
- **N6（可找回）**：被忽略条目出现在 `dismissed`，收件箱可见。
- **N7（部署确认不降级）**：从打断位发起部署必须经过确认面板的确认按钮。
- **N8（不反向依赖）**：`notices` 不 import `system`；provider 由上层注入。

## 8. 分阶段

| 阶段 | 内容 | 本 proposal 是否覆盖 |
|---|---|---|
| P1 | notices module + 忽略表 + `GET /api/notices` + `POST dismiss`；部署 provider；`NoticeSlot` / `NoticeInbox`；替换紧凑部署条 | **是** |
| P2 | 推送替代轮询（复用 WebSocket 通道）；`useVersionCheck` 接入 | 否 |
| P3 | quay 异常（driver 停、fan-in 卡住等）接入 | 否 |
| P4 | `decisionQueue` 并入 `decision` 型，驾驶舱与打断位共用 | 否 |
| P5 | event 型与 `notifications` 外发渠道对接 | 否 |

P1 不预先为 P2–P5 加任何分支；类型里保留 `event` / `decision` 只是为了模型完整，不接线。

## 9. 验证面（P1 的验收思路）

**单元 / 契约**

- 注册表：`pending-build` + 无忽略 → active；忽略当前 `headSha` → 不在 active、在 dismissed；`headSha` 变化 → 重新 active（N1）。
- `deploy:failed` 的 dismiss 请求 → 被拒（N2）；`revision` 不匹配的 dismiss → 409。
- 两个 userId 各自忽略互不影响，同一 userId 读取一致（N5）。
- 部署 provider 的映射表（§5）逐行断言，尤其 `fresh` 无条目、`building` 不新增条目。

**UI（按仓库 DoD）**

- MCP 浏览器在真实页面上走一遍：出现 → 忽略 → 刷新仍隐藏 → 构造新提交后重新出现 → 失败态无忽略按钮 → 折叠计数与收件箱；截图存 `tmp/`。
- 存在可用场景时同时跑 `node scripts/ui-scenario.mjs`，贴 JSON 报告与检查点截图。
- 隔离实例验证，不得在 live :3001 上触发真实构建重启。

**反向（假形态）**

- 把忽略键改成只按 `id` 不带 `revision`，N1 的用例必须变红。
- 去掉服务端对 blocking 的拒绝，N2 的用例必须变红。

## 10. 风险与未决

- **多用户场景**：忽略按 `userId` 存，单用户部署下等同全局；多用户时每人各忽略一次，符合预期。
- **轮询放大**：`GET /api/notices` 每次调用会触发部署 provider 读 git；沿用 15 s，与现状同量级，P2 再改推送。
- **认知负荷**：「忽略到下个提交」比「永久关闭」更啰嗦。若实际使用中觉得吵，可在 P1 之后评估增加「本次会话内不再提示」，但不在本阶段预设。
- **未核实**：收件箱入口放在哪（侧边栏 / 顶部折叠计数展开 / 驾驶舱）尚未定，P1 先做折叠展开；quay tab 现有的异常提示是否应并入同一模型也未核实，留给 P3。
