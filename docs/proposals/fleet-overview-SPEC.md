# 舰队总览：跨项目 / 跨会话进展可见性 SPEC

> 状态：proposal。本文档把「减少在项目/会话间来回切换看进展」这一目标落成一套分阶段方案，
> 每阶段同时交付「架构演进」与「前端可见改进」。凡标注 **[M]** 为 2026-10-18 本会话实测或
> 从代码读出的现状；标注 **[P]** 为待实现提案。

## 0. 决议记录

- **2026-10-18** 用户认可：**D（事件主干）做主干、A（Landing 总览主面）做主面**优先推进。
- **2026-10-18** 用户追加：会话列表每项增高，容纳「最新输入/输出摘要（横向滚动）+ quay 关键状态图示」。
- **2026-10-18** 用户定：**分阶段计划**，保证「架构持续演进 + 前端可见的功能改进」，不允许纯后端 slog。
- **2026-10-18** 定：quay 消费侧用 `goal list --json --no-evidence` → filter `{ includeEvidence: false }`；
  该改动由 **quay 仓库 task `gap-goal-list-ledger-scan`** 交付，**本仓库不实现**，只消费其输出。
- **2026-10-18** 定：`inFlight` 与甘特共享 `readLive`，**无便宜读取路径**，归 lazy（展开才读）。
- **2026-10-18** 定（默认，可推翻）：`lastMessagePreview` 脱敏 = **结构性白名单**（只取 user/assistant text，不取 tool 参数）+ 黑名单正则兜底 + 120 字符截断。

## 1. 问题与实测基线 [M]

### 1.1 问题

用户花大量时间在不同项目、不同会话之间来回切换检查进展；真正有价值的事件
（某会话结束了 / 卡住了 / 需要拍板）出现的频率比切换低一个数量级。产品目标不是「把更多东西
塞进每个会话」，而是**把罕见但有价值的事件主动送到眼前，把「轮询」变成「被叫」**。

### 1.2 现状实测（2026-10-18）

- **会话规模**：`~/.cloudcli/auth.db` 共 10593 会话——人类项目 9568（90%）、`/tmp` 366、worktree 659。
  各项目会话数：claudecodeui 390、quay 117、quay-fleet 108、archguard 21、cantus 16。
- **当前 Running sessions 视图**（`src/modules/sidebar/RunningView.tsx`）：只渲染会话名字，
  无阶段、无耗时、无工具、无项目归属；`Resident (idle)` 组同样只有名字 + Close。
- **当前 Landing**（`src/modules/project-workspace/WorkspaceStateView.tsx`）：整屏「Choose Your Project」空态，
  最大屏幕面积被浪费；移动端收进汉堡菜单，更荒。
- **quay 冷快照成本**（直接跑 `.quay/plugin/bin/quay`，绕过 server 缓存）：
  - `task list --json --no-body`：241ms（833 task）/ 470ms（2872 task）
  - `goal list --json`：741ms（376 goal / 50MB ledger）/ ~1.4s（275 goal / 157MB ledger）
  - `lanes --json`：907ms
  - **整份冷快照 ≈ 2.0s/项目**；`goal list` 成本 ∝ `.quay/gate-events.jsonl` 尺寸，与 goal 文件数无关。
- **transcript jsonl**：raw head = `mode`/`permission-mode`/`system` 初始化噪声；raw tail =
  `summary`/`modelUsage`（token+花费）结算行。「最新输入/输出」必须做**语义尾解析**
  （最后一条 user 文本 + 最后一条 assistant 文本），不是字节头/尾。
- **安全**：transcript 里存在明文凭据 → 任何把 transcript 尾部渲染到侧栏的摘要都必须脱敏。

## 2. 目标与非目标

### 2.1 目标

1. 一个跨项目/跨会话的总览面，三块数据：**① 正在跑**（阶段/工具/耗时，按项目分组）
   **② 刚结束**（终态 feed，带结果摘要）**③ task·goal 状态变迁**（quay store）。
2. 全局注意力路由：**未读徽标 + 通知 + 持久事件日志**，阈值决定「通知 / 徽标 / 静默」。
3. 会话行/项目行增强：会话行语义尾摘要；项目行 goal/task 状态计数 + 在飞任务标题（lazy）。
4. 同一套前端同时服务 **PC 与 Web**（桌面端 electron 复用同一 React 应用）。

### 2.2 非目标

- 不改 quay Core store / CLI（归 quay 仓库，见 §10）。
- 不做通用 BI / 报表 / 历史分析。
- 不做跨用户共享（保持单用户 self-hosted 语义）。

## 3. 数据源现状 [M]

| 数据 | 现状 | 位置 |
|---|---|---|
| 会话实时阶段/耗时 | 已算好：activity snapshot 带 `phase`(thinking/writing/tool/compacting/awaitingPermission) + `toolName` + `elapsedMs` + `taskCount`/`scheduleCount` | `SessionActivity`（`shared/types.ts:510`）；侧栏可经 `useProcessingSessions()`（`SessionProtectionContext`）读 `SessionActivityMap` |
| 忙/闲 + resident | 已有 `useSessionHosts()` + `classifyRunningSessions` | `shared/hooks/useSessionHosts.ts` |
| 项目级 quay 计数 | 已算好：`QuaySnapshot` 含 `tasks`(byStatus/ready/needsHuman/done)、`goals`(breakdown.byStatus)、`inFlight`、`gantt`、`tests`、`fanIn` | `GET /:projectId/snapshot`（`server/modules/quay/quay.service.ts` 计算）；前端 `QuayPanel` + `LoopPulseGantt` |
| 会话消息正文 | 在 transcript jsonl（`sessions.jsonl_path`），不在 DB；需语义尾解析 | chat 模块已有 `messageTransforms.ts` / `sessionMessagePagination.ts` |
| 通知底座 | 已存在：web-push（`vapid_keys`/`push_subscriptions`）+ 桌面 WS + `notification_channel_endpoints` + 偏好 + 设置页 | `server/modules/notifications/`；前端 `useWebPush.ts` |

**核心结论**：三块数据（实时、终态、task·goal）的**信号源都已存在**，缺的是「聚合 + 呈现 + 注意力路由」。

## 4. 架构总览 [P]

```
              事件源（event sources）
   session-end · task/goal-flip · needs-human · await-auth
                        │
                        ▼
              ┌───────────────────────┐
              │  EVENT STORE          │   append-only, per-user
              │  （持久事件日志）       │
              └───────────┬───────────┘
      ┌───────────┬───────┴───────┬───────────┐
      ▼           ▼               ▼           ▼
  landing      badge          notify       session-row
  (feed)      (unread)        (push)       （每行 = 该会话最近事件投影）
```

- **D 事件主干**：三数据族汇成一条事件流，喂 feed / 徽标 / 通知三消费者；会话行是第四个消费者（同一事件流的精简投影），保证行上图示与 Landing 面板永不互相矛盾。
- **A Landing 主面**：改造 `WorkspaceStateView` 成三块面板；移动端顶部脉冲条 + 横滑三页。
- **两级 quay 端点**：eager 的 `fleet-summary`（计数）与 lazy 的 `snapshot`（inFlight + 甘特）。

## 5. 事件主干 [P]

### 5.1 事件源

1. **会话终态**：从 delivery/turn 账本（GOAL-045 那条线）归约「以什么结果结束」。
2. **task/goal 状态翻转**：quay store 的 status 翻转（todo→ready→done、needs-human、achieved…）。
3. **needs-human / 等待授权**：需要用户动手的信号。

### 5.2 存储

append-only `events` 表（per-user），字段含：`kind`、`subject`（sessionId / taskId / goalId）、
`projectId`、`payload`（终态/翻转/一句话摘要）、`at`。

### 5.3 通知路由阈值（建议默认，P4 前确认）

```
session ended : error        ──► push + badge + feed
needs-human                  ──► push + badge + feed
awaiting permission          ──► push + badge + feed
session ended : success      ──► badge + feed      (no push)
phase/tool change (live)     ──► feed only         (silent)
```

复用 `server/modules/notifications/` 的 web-push + 桌面 WS + 偏好，只补「事件源 → 路由」这一段。

## 6. 两级 quay 端点 [P]

### 6.1 `GET /api/quay/fleet-summary`（新，廉价，eager）

```jsonc
{ "projects": [ {
    "projectId": "...", "projectPath": "...",
    "driver": { "state": "idle", "alive": true },
    "tasks":  { "total": 833, "todo": 0, "ready": 0, "needsHuman": 0, "done": 0 },
    "goals":  { "total": 376, "active": 0, "achieved": 0 }
  } ],
  "generatedAt": "...", "ttlPerProjectMs": 120000 }
```

- 计算：`task list --json --no-body` + `goal list --json --no-evidence`（`{ includeEvidence:false }`）。
- 服务端 `Promise.all` 扇出 + **concurrency 上限（4）** + 每项目 2min TTL；**不含 inFlight/gantt**。
- 实测依据：并发 4 路 `goal list` 墙钟 ≈ 单路（多核吸收），但 CPU/内存线性放大，故设上限。

### 6.2 `GET /:projectId/snapshot`（现有，lazy）

inFlight + gantt 保留在此，展开项目 / 打开 quay tab 才调。依据：二者同源 `readLive`（~670ms+），无便宜路径。

## 7. 前端总览面 [P]

- **Landing 三面板**：① 正在跑（`SessionActivity` 的 phase/tool/elapsed，按项目分组）② 刚结束（终态 feed）
  ③ task·goal 变迁（fleet-summary 计数 + 事件流翻转）。
- **移动端**：顶部脉冲条（铃铛 + 未读计数，常驻）+ 横滑三页。
- **会话行增强**：+1 行语义尾摘要（选中行 marquee，其余静态截断）。
- **项目行增强**：goal/task 状态计数徽标 + 在飞任务标题（lazy）。

## 8. lastMessagePreview 与脱敏 [P]

- 服务端从 transcript jsonl **尾部向前**解析，取最后一条 user 文本 + 最后一条 assistant 文本，拼接成一
  行（120 字符截断）。只读尾部，不整文件读（live 会话 jsonl 持续 append，抽样已见 2.9MB）。
- 脱敏：**结构性白名单**（只取 user/assistant 的 text block，不取 tool 输入输出，因为密钥几乎都在 tool
  参数里）+ 黑名单正则兜底（`sk-…`、`password=`、`Bearer …` 等）+ 截断。

## 9. 分阶段计划

| 阶段 | 前端可见改进 | 架构演进 | 依赖 | 完成口径 |
|---|---|---|---|---|
| **P1 会话「在干什么」可见化** | Running sessions 视图 + 会话行渲染 phase/tool/elapsed（现在只有名字） | 确立「会话状态卡片」读取路径＝总览的种子；复用 `deriveActivityDockView` 的 phase 归约 | 无（纯前端，0 新后端） | 每条 running 会话显示 阶段+工具+耗时；resident-idle 显示 idle |
| **P2 项目行 task 计数徽标** | 项目行显示 task 状态计数 | `fleet-summary` 端点骨架（扇出 + TTL + concurrency 上限），先挂 driver + task(no-body) | 无（no-body 已可用） | quay 项目行显示 task 计数，轮询不 spawn 多余 CLI |
| **P3 Landing 总览主面 + 会话终态** | Landing 空态 → 三块面板 + 移动端脉冲条 | **会话终态派生**（delivery/turn 账本归约）＝事件主干第一批事件源 | P1 + P2 | 打开 Landing 看到跨项目「正在跑」+「刚结束（带终态）」 |
| **P4 事件主干 + 全局徽标 + 通知** | 全局未读铃铛 + 事件 feed | append-only 事件存储 + 通知路由（接现有底座）+ 阈值 | P3 | 出错/needs-human 触发徽标+通知；正常完成只进 feed；feed 与徽标同源 |
| **P5 会话行/项目行增强** | 会话行语义尾滚动摘要；项目行 goal 计数 + 在飞标题（lazy） | `lastMessagePreview`（语义尾解析 + 脱敏）；fleet-summary 接 `{includeEvidence:false}` | quay 侧 `--no-evidence`；P4 | 会话行显示脱敏限长最近 I/O；项目行显示 goal 计数、展开显示在飞标题/甘特 |

依赖流：

```
P1 ──► P3 ──► P4 ──► P5
P2 ──┘                ▲
                      │
[quay --no-evidence] ─┘  （对方仓库并行轨；P2/P3/P4 不被阻塞）
```

## 10. 跨仓库依赖

- quay 仓库 task `gap-goal-list-ledger-scan`：给 `goal list` 加 `--no-evidence`（filter
  `{ includeEvidence: false }`），跳过 `.quay/gate-events.jsonl` 全量扫描（冷 ~1.4s → ~0.1s）。
  **由对方会话拥有**，本仓库只消费；P5 接它，P2/P3/P4 不阻塞。

## 11. 风险与未测

1. **会话终态归约口径未定**：成功 / 出错 / needs-human / 被打断 / 超时 各档如何从账本归约，P3 前须定。
2. **「值得打扰」阈值**：§5.3 是建议默认，P4 前须确认。
3. **大列表性能**：390 会话项目每行增高后列表翻倍长；需「只对活跃/选中/最近 N 行增高」或虚拟化。
4. **会话↔quay task 无关联**：会话行若想显示「该会话在干哪个 quay task」，需在派发路径新增戳记（P5 之外的可选增强）。
5. **脱敏不可穷尽**：白名单 + 黑名单是尽力而为，不能替代「transcript 本就该少存明文凭据」。

## 12. 验收矩阵

| 阶段 | 可验证判据（机械优先） |
|---|---|
| P1 | running 行渲染 `data-activity-phase`/`data-activity-tool`/`data-activity-elapsed`，值与 `SessionActivity` 一致；resident-idle 行无 phase；`RunningView`/`SidebarSessionItem` 测试绿 |
| P2 | `fleet-summary` 返回 quay 项目的 task 计数；2min TTL 内二次请求不 spawn 新 CLI；无 quay 配置项目不在返回集 |
| P3 | Landing 在无会话选中时渲染三面板；「刚结束」条目含终态；移动端脉冲条出现 |
| P4 | 注入「session error / needs-human」事件 → 徽标计数 +1 且触发通知；「success」→ 只进 feed 不通知；feed 与徽标读同一事件表 |
| P5 | 会话行显示 ≤120 字符脱敏语义尾；含 `sk-…`/`password=` 的行被脱敏；项目行显示 goal 计数；在飞标题展开才读 |

## 附录 A：实测原始读数（2026-10-18）

- 冷快照计时：见 §1.2（`task list`/`goal list`/`lanes` 各 verb 单次冷计时）。
- `gate-events.jsonl` 尺寸：claudecodeui 50MB/146,244 行；quay 157MB/587,625 行；quay-fleet 40MB/114,902 行。
- warm/并发：`goal list` warm 760→732ms（≈4%，CPU-bound）；4 路并发墙钟 788ms ≈ 单路。
- transcript head/tail 样本：raw head=mode/system 噪声，raw tail=summary/modelUsage 结算，均非对话正文。
