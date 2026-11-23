# CloudCLI Goal Loop：立目标、跑到 AC 全绿

**状态**：草案（2026-11-11）
**决策记录**：
- 数据归属：CloudCLI 自建 SQLite store（不直接读写 quay store，另提供 quay 格式导入导出）
- 判据环境：临时 worktree 隔离跑（agent 与判据共用同一个 goal worktree）

---

## 1. 背景与目标

quay 的 goal 能"一直执行到完成"，不是靠一个 agent 死循环，而是三层分工：

| 层 | 谁 | 每轮做什么 |
|---|---|---|
| 判 | `goal-driver.ts`（~42s/轮） | 跑每条 active AC 的 `criterion` 命令 → 写 evidence → 全绿机械翻 `achieved` |
| 立 | 同上 | 红了就派短命 agent 经 ABI 立 gap task；**goal 自己不碰任务状态** |
| 做 | `promotion-driver` + `worker-driver` | 挑任务、开 worktree、实现、过门、合入 |

支撑"可信"的三条硬规则：**判据是可跑命令**（空 ⇒ fail-closed）、**evidence 落盘**、**状态只由判据推导**（driver 只做机械 flip，激活/放弃归人）。

CloudCLI 缺的不是执行能力——会话 run、常驻会话、自动发消息、worktree、SQLite 全都有。缺的是**目标/判据这一层**和把它串成闭环。

**目标**：用户在一个项目里立 Goal + 若干条 AC，CloudCLI 自动循环"跑判据 → 让 agent 修 → 再跑"，直到全部 AC 通过或触发退出条件。

**非目标（v1）**：多 goal 并发、每 AC 独立会话/并行执行、直接驱动 quay 的 driver、自动合并回主分支。

---

## 2. 概念模型

```
Goal
 ├─ objective         目标陈述（人话）
 ├─ exitConditions    退出条件，必须逐字点名 AC id
 ├─ status            draft | active | achieved | paused | abandoned | stalled
 └─ sessionId         绑定的目标会话（cwd = goal worktree）

AC（验收条件）
 ├─ criterion        可跑 shell 命令；空 ⇒ fail-closed，不可人工勾绿
 ├─ expect           期望的读数/行为（描述性，人读）
 └─ status           active | achieved | superseded

Round（一轮）
 ├─ seq
 ├─ outcome          green | progress | no-progress | stalled | budget-hit | error
 └─ diffDigest       worktree HEAD + 工作区 diff 的摘要（判"有没有变化"）

Evidence（一条判据的一次读数）
 ├─ exitCode / timedOut
 ├─ outputDigest     sha256(截断后的输出)
 ├─ outputExcerpt    尾部 N 行，供人复核
 └─ verdict          pass | fail
```

**退出条件必须点名 AC**：退出条件写成"完成所有 AC"时，人和驱动都无法判断边界；写成 `AC-001, AC-004, AC-007` 才是可判的。

---

## 3. 数据模型（SQLite）

新增迁移，四张表，全部挂在项目维度：

```sql
CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,       -- 循环以这个调用者身份发消息
  project_id TEXT NOT NULL,
  session_id TEXT,                -- 激活时创建/绑定
  worktree_path TEXT,
  branch TEXT,
  title TEXT NOT NULL,
  objective TEXT NOT NULL,
  exit_conditions TEXT NOT NULL,  -- JSON: ["AC-001", ...]
  status TEXT NOT NULL,           -- draft|active|achieved|paused|abandoned|stalled
  budget TEXT NOT NULL,           -- JSON: {maxRounds, maxWallClockMs, maxNoProgress}
  created_at TEXT NOT NULL,
  activated_at TEXT,
  achieved_at TEXT
);

CREATE TABLE goal_acs (
  id TEXT PRIMARY KEY,            -- <goalId>-AC-001
  goal_id TEXT NOT NULL,
  title TEXT NOT NULL,
  criterion TEXT NOT NULL,
  expect TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);

CREATE TABLE goal_rounds (
  id TEXT PRIMARY KEY,
  goal_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT,
  diff_digest TEXT,
  prompt_digest TEXT
);

CREATE TABLE goal_evidence (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL,
  ac_id TEXT NOT NULL,
  exit_code INTEGER,
  timed_out INTEGER NOT NULL DEFAULT 0,
  output_digest TEXT NOT NULL,
  output_excerpt TEXT NOT NULL,
  verdict TEXT NOT NULL,          -- pass|fail
  at TEXT NOT NULL
);
```

`criterion` 为空、白名单外、或首轮即绿（见 §5.1）都不允许进入 `active`。

---

## 4. 执行闭环

### 4.1 激活（人触发）

```
1. 校验：goal 至少 1 条 active AC；每条 criterion 非空
2. 建 worktree：<project>-worktrees/goal-<id>，分支 goal/<id>（已存在则复用）
3. 建目标会话：provider 默认，cwd = worktree
4. 红先行：在 worktree 里跑一遍全部 criterion
   - 任一为绿 ⇒ 拒绝激活并报告（判据当前就是绿的，无法证明 agent 做了什么）
   - 全部为红 ⇒ 通过
5. status = active，启动 driver
```

### 4.2 每轮

```
round 开始
  ├─ 串行跑每条 active AC 的 criterion（cwd = worktree，超时 120s，进程组 kill）
  ├─ 写 evidence
  ├─ 全绿 ⇒ goal achieved，通知，停
  ├─ 算未达成集：红的 AC + 失败输出尾部 + diffDigest + 上轮 diff
  ├─ 组装「目标轮」prompt：
  │     - 目标与退出条件
  │     - 本轮红的 AC 及其 expect
  │     - 每条 AC 的失败输出（截断）
  │     - 约束：只改本 worktree、不要动 goal 记录
  ├─ chatControlService.send(目标会话, prompt)   // 与手打同一条路径
  ├─ 等该 run 的 turn-complete（订阅 chat-run-registry，超时兜底）
  └─ round 结束，写 outcome
```

### 4.3 退出条件

| 条件 | 行为 |
|---|---|
| 全部 AC pass | 先合并 `goal/<id>` 回主分支：成功 ⇒ `achieved` + 通知；失败 ⇒ `paused`（worktree/分支保留，轮次仍记 `green`），等人处理 |
| 连续 K 轮 diff 不变且判据读数不变 | `stalled`，暂停并通知人 |
| 达到 maxRounds / maxWallClock | `paused`，通知人 |
| 用户暂停 | `paused` |
| 用户放弃 | `abandoned`，worktree 按归档口径处理（不直接删） |
| 判据命令本身报错（spawn 失败/超时） | 记 `error` 证据，本轮按红处理；连续 3 轮全 error ⇒ stalled |

---

## 5. 判据可信性（从 quay 实跑踩出来的硬规则）

### 5.1 红先行

激活时每条 AC 必须至少跑一次且为红。判据现在就是绿 ⇒ 无法区分"agent 修好了"和"判据恒真"。这是 quay 假绿的主要来源。

### 5.2 判据必须能取假

AC 的 `expect` 必须写出"什么情况会失败"。写不出反例的判据（恒真命令、纯描述）不允许激活。UI 上把 `expect` 作为必填项，并在激活校验里拒绝空泛表述。

### 5.3 会回退的量不能当 AC

性能数字、覆盖率、内存占用这类会波动的量只能当监控，不能作验收条件——否则 AC 会在绿红之间反复，形成自持循环（quay 的 `frozen-violated` 判据就是这个坑）。

### 5.4 无进展熔断

判 "有没有变化" 用两个读数：`diffDigest`（worktree HEAD + 工作区 diff）+ 每条 AC 的 `outputDigest`。连续 K 轮两者都不变 ⇒ `stalled`。这是防空转烧 token 的最后一道闸。

### 5.5 判据隔离

criterion 在 goal worktree 里跑，不碰用户主检出。同一轮内串行执行——并行跑构建/测试会互相争用同一份工作区，读数不可信。

### 5.6 证据留痕

每轮每条 AC 都落 evidence（命令、退出码、输出摘要、时间）。人可复核"agent 到底跑没跑、跑出了什么"。没有 evidence 的"完成"一律不算。

---

## 6. Worktree 方案

- **激活时创建**：`git worktree add <project>-worktrees/goal-<id> -b goal/<id>`
- **agent 与判据共用**：目标会话的 `cwd` 指向该 worktree，criterion 也在这里跑——这样判据看到的就是 agent 刚改过的代码。
- **不与主检出同步**：goal 期间主检出可以继续做别的事。
- **结束时**：`achieved` 保留 worktree 并提示合并；`abandoned` 按归档口径（`git worktree remove` 前先确认分支已存档，不直接删未合并分支）。

复用现有 `server/modules/worktrees/` 的 create/open/remove service，不另写 git 操作。

---

## 7. 模块落点

### 后端 `server/modules/goals/`

```
index.ts                          barrel：只导出 routes 与 driver 启停
goals.routes.ts                   薄路由：解析 → service → 响应
goals.service.ts                  Goal/AC CRUD、状态迁移、人闸校验
goal-driver.service.ts            常驻循环：轮次、判据、prompt 组装、退出判定
criterion-runner.service.ts       spawn 判据、超时、进程组 kill、输出截断与 digest
round-prompt.ts                   目标轮 prompt 组装（纯函数，可测）
tests/                            单测 + 路由 parsing 测试
```

- 数据库访问走 `server/modules/database/` 的 barrel，新增 `goal-*` repositories。
- 发消息走 `server/modules/websocket/` 的 `chatControlService.send`，与 `scheduled-messages` 同路径。
- 等 run 完成订阅 `chat-run-registry` 的完成事件，超时兜底。
- 跨模块一律经 `index.ts`，不深引。

### 前端 `src/modules/goals/`

```
GoalPanel.tsx                     goal 卡片 + AC 列表 + 轮次时间线
hooks/useGoalStatus.ts            REST + websocket 实时读数
components/AcRow.tsx              单条 AC：红/绿、criterion、最近 evidence
components/RoundTimeline.tsx      轮次与耗时（复用 LoopPulseGantt 的视觉语言）
```

挂载点：项目工作区新增 tab「目标」，与现有 QuayPanel（外部 quay 项目只读镜像）并列。

### REST

```
GET    /api/goals?project=
POST   /api/goals
PATCH  /api/goals/:id
POST   /api/goals/:id/acs
POST   /api/goals/:id/activate | pause | resume | abandon
GET    /api/goals/:id/rounds
```

### WebSocket 事件

```
goal.status      status 变化
goal.round       一轮开始/结束（outcome）
goal.evidence    单条 AC 的读数
```

---

## 8. 与 quay 的关系

- **产品内建**，不要求用户安装 quay。
- **格式兼容**：提供 `quay store → CloudCLI goals` 导入（读 `goals/*.md` 的 frontmatter + AC 记录），以及反向导出。CloudCLI 仓库自身的 49 个 GOAL / 348 条 AC 可作为第一批导入验证。
- **边界不变**：`src/modules/quay/` 继续做"外部 quay 项目"的只读镜像；goal loop 是 CloudCLI 自己的写面，两者互不替代。

---

## 9. MVP 范围

1. Goal / AC 的建与改（API + UI）
2. 激活时红先行校验
3. 一条 goal 绑定一个专属会话，自动续跑
4. 每轮判据 + evidence + 轮次记录
5. 预算（轮数/墙钟/无进展）与 stalled
6. 全绿通知 + worktree 保留提示

**v1 不做**：多 goal 并发、每 AC 独立会话、并行判据、自动合并、quay driver 联动。

---

## 10. 风险与开放问题

| 风险 | 缓解 |
|---|---|
| criterion 慢或挂起 | 120s 超时 + 进程组 kill；连续 error 进 stalled |
| agent 改坏 worktree | 主检出不受影响；evidence + git diff 可回溯 |
| provider 的 turn 完成语义不一致 | 以 chat-run-registry 的统一 run 完成事件为准，不在 goal 侧解析 provider 事件 |
| 判据写得太弱导致假绿 | 红先行 + `expect` 必填 + 人复核 evidence；不引入"自动判定判据质量"的复杂度 |
| 用户关掉 CloudCLI 后循环停 | 语义明确：driver 在应用进程内；如需后台常驻，后续接服务端守护 |

**已定**（2026-11-11 用户裁定）：
1. achieved 后**自动合并回主分支**。合并失败不丢 worktree，转人工。
2. criterion **不加命令白名单**，命令照跑；隔离仍由 goal worktree 提供。
3. goal 会话 v1 新建专用会话（上下文干净）。

---

## 11. 实现状态（2026-11-12）

**已落地**：

| 层 | 文件 | 状态 |
|---|---|---|
| 存储 | `server/modules/database/`（4 表 + 迁移 + `goals.db.ts`） | ✅ |
| 判据 | `criterion-runner.service.ts`、`goal-worktree.service.ts`、`red-first.ts`、`diff-digest.ts` | ✅ |
| 生命周期 | `goals.service.ts`（CRUD、activate、pause、resume、abandon） | ✅ |
| 轮次 | `run-round.ts`（判据、evidence、无进展熔断、全绿合并） | ✅ |
| 续跑 | `goal-driver.service.ts`（预算、stalled、send→等 run、不可重入） | ✅ |
| 路由 | `goals.routes.ts` + `server/index.ts` 挂载 `/api/goals` | ✅ |
| 前端 | `src/modules/goals/` + 项目工作区「目标」tab + i18n | ✅ |
| 权限 | goal 创建者私有：列表按 userId 过滤，详情/操作不匹配一律 404 | ✅ |
| 通知 | achieved / stalled / 预算暂停推到桌面 toast 通道 | ✅ |
| 界面完整度 | 激活选 provider、预算可配、UUID 只显短 id、AC evidence 读数 | ✅ |

**验证**（2026-11-12）：

- 后端 100 个测试全绿（goals 模块 8 个文件 + 数据库集成 + import-cycle 预算）。
- 前端 31 个测试全绿（GoalPanel 18 + workspace tabs 10 + i18n 3）。
- `tsc`（server + client）0 错误。
- 真实浏览器（Playwright + 系统 Chromium）：登录 → 项目 → Goals tab → 新建 goal → 卡片显示，截图见 `/tmp/goal-ui/shots/`。
- 场景运行器：`e2e/scenarios/goal-loop.json` 通过，报告与截图见 `/tmp/goal-ui/scenario/`。
- 真 HTTP + 真 worktree 端到端：`goals.http.test.ts` 覆盖红→绿→合并→achieved、pause/resume。

**已知限制（v1）**：
- `ControlCaller.via` 的 `goal` 复用 `scheduled` 的 run source（新增独立 source 会牵动两个穷举测试与前端词汇表）。
- 前端 5s 轮询，尚无 goal 的 websocket 实时事件。
- 退出条件在创建时为空的，激活时自动回填为全部 active AC id。
- 场景运行器的语义面对生产构建不可用；纯导航+截图的场景现在可以跑，`drive`/`expect` 步骤会在生产构建上明确失败。
