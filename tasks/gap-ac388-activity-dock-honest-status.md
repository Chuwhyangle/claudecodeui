---
id: gap-ac388-activity-dock-honest-status
title: AC-388 活动坞如实：processing ∧ phase=idle ∧ 长时间无携带 phase 的 turn 帧 ⇒ 不写
  Working…（改「等待服务端」如实文案并保留 Stop）；elapsed 取服务端 turn 的 startedAt，重挂载/新 hello
  不归零；交付 src/modules/chat/tests/activityDockHonestStatus.test.tsx（新建，(a)–(d) 四条腿
  + 取假形态）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac383-delivery-activity-snapshot-channel
  - gap-ac385-send-deliveryid-runid-compat-window
  - gap-ac386-run-get-dual-id-delivery-wait
goal_ac: AC-388
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -rl '^goal_ac: *AC-388' tasks/*.md` → **0** 命中；全库 `grep -rln 'AC-388' tasks/` → 只命中 `tasks/gap-ac387-pending-deliveries-from-activity-snapshot.md`（其正文把 AC-388 明确列为不做的 non-goal：「同批 S4 任务 AC-388（活动坞如实文案）与 AC-389（Escape 守卫）是不同机制、不同文件，本任务不含」，非认领）⇒ 无任何状态（含 todo / ready / needs-human）的任务认领 AC-388。机制词 grep：`activityDockHonestStatus` 全库 **0** 命中；`awaitingServer`、「等待服务端」在 `src/` 下 **0** 命中；`turnStartedAt` 只在 `server/modules/websocket/services/chat-run-registry.service.ts`（run 的 `startedAt`）与 freshness 机的**本地** `turnStartedAt` 出现，客户端尚无「服务端透传的 turn 起始」这一读数 ⇒ 该机制尚不存在。合并候选（`node /data/home/yale/.claude/plugins/cache/quay/quay/0.20.0/scripts/dist/task-granularity-advice.js --root /data/home/yale/work/claudecodeui --touches src/modules/chat/hooks/useActivityFreshness.ts --touches src/modules/chat/utils/activityDockView.ts --touches src/modules/chat/composer/ActivityIndicator.tsx --touches src/modules/i18n/locales/en/chat.json --json`）报 `peers: []`、`mentions: []` ⇒ 四个文件无任何开放任务在 Touches 声明 ⇒ 判定 **separate**（无重叠；S4 另两条前端 AC-387 待发行、AC-389 Escape 守卫是不同机制、不同文件、不同判据）。本条真正要消费的服务端字段是 activity 快照上 `turn.startedAt`，由 S2 的 `gap-ac383-delivery-activity-snapshot-channel` 落进 `ActivityProtocolSnapshot.turn`，故在任务层以结构化 `depends_on` 声明阶段先后（SPEC §12：后一阶段任务不得先于前一阶段出口 AC 落地），正文不复述这层关系。

### 机制（SPEC §9「活动坞」、GOAL-045 §9）

现状（读基线代码）：

1. **文案撒谎**：`deriveActivityDockView`（`src/modules/chat/utils/activityDockView.ts:170`）在「本地表有 processing 且证据新鲜」时落 `in-turn`，其 `phaseLabelKey` 只由**服务端上报的 phase** 决定（`activityPhaseLabelKey`，:113）——phase 为 `idle` 时返回 null。于是 `ActivityIndicator`（`src/modules/chat/composer/ActivityIndicator.tsx:217-233`）的 label 落到 `phaseLabel ?? renderedActivity?.statusText ?? t('claudeStatus.actions.working')`，即 `Working…`。一个本地表说在跑、但服务端一直没上报任何 running phase 的 turn（旧 round 永挂的稳态、以及「已接受、尚未 `init`」的窗口），就这样被写成 `Working…`——而服务端其实什么都没在报。
2. **elapsed 以 hello 时刻为锚**：`useActivityFreshness`（`src/modules/chat/hooks/useActivityFreshness.ts:163-195`）在 `chat_subscribed` 上算 `carriedStart = sameIdentity && snapshot.turnStartedAt !== null ? snapshot.turnStartedAt : asOf`（:184）；**新挂载的机器 `snapshot.bootId === null` ⇒ `sameIdentity` 假 ⇒ `carriedStart = asOf`（hello 时刻）**。刷新 / 重挂载即把锚点重置到当下，把卡了两小时的 turn 显示成几秒（SPEC §9 明指 `:184`）。heartbeat 分支（:222-254）同病：`startedAt: snapshot.bootId === bootId ? (snapshot.turnStartedAt ?? asOf) : asOf`。elapsed 由 `getElapsedMs = asOf - turnStartedAt`（`src/modules/chat/utils/activityFreshness.ts:179`）算——锚点错，读数就错。

SPEC §9 的修法：`processing ∧ phase = idle ∧ 长时间无帧` 时**不再写 `Working…`**，改为「等待服务端」类的如实文案；`elapsed` 取**服务端 turn 的 `startedAt`**（AC-383 把它加进 activity 快照的 `turn`）。

### 与既有 pin 的边界（本条的硬约束）

`src/modules/chat/tests/activityDockUnreachable.test.tsx` 钉着两条**相反方向**的正控制：

- (i) 一帧之后**立即**（t=0）的 in-turn dock 必须含六个轮换动作词之一（`:145-160` 的 positive control，词集由所有 shipped locale 的 `claudeStatus.actions.*` 之并集构成，:36-49）；
- (ii) 之后**整段无帧**、过阈值 ⇒ state 变 `unreachable`、**坞内零 Stop、零 aria-label**（`:170-215`）。

`src/modules/chat/tests/activityDockProgressReading.test.tsx:147` 同钉「首帧无 phase ⇒ label 以 `Working` 开头」。

因此「等待服务端」的如实文案**必须**满足三条边界：(a) 只在 `in-turn`（证据新鲜）下生效，绝不碰 `unreachable`（那是 SPEC 里另一条已钉的读数）；(b) 只在**过了阈值**（实现导出的常量，取值 > 0）后生效，不在 t=0 抢掉两条正控制；(c) 文案键**不落在** `claudeStatus.actions.*` 之下——那组正是六词集合，写进去会红 `activityDockUnreachable` 的「无轮换词」断言。

## Plan

1. **先写判据** `src/modules/chat/tests/activityDockHonestStatus.test.tsx`（新建）：装配照 `activityDockPhaseTruthful.test.tsx`——**真实** `ActivityIndicator` + **真实** `useActivityFreshness`、内存 `ActivityConnection`（`subscribe` + `isConnected: true` + 一个 `push` 助手包 `act`）、`vi.useFakeTimers({ now: START })`、i18n 以 en `chat.json` 初始化（`PHASE_LABEL_FALLBACKS` 之外的键从 locale 文件读，不重打字面量）。逐条断言 (a)–(d)。先看它红：文件不存在 ⇒ vitest 报 `No test files found`、退出 1。
2. **文案如实（a）**：在 `activityDockView.ts` 增一个读数（如 `awaitingServer: boolean`，或一个 label key），判定条件为「`in-turn` ∧ `phase === 'idle'` ∧ 已过阈值（实现导出的常量，如 `UNCONFIRMED_TURN_LABEL_MS`）仍未见任何携带 phase 的 turn 帧」；`ActivityIndicator` 在该读数下把 label 换成 `claudeStatus.awaitingServer.title`（**不**放 `claudeStatus.actions.*`），`data-activity-state` 仍 `in-turn` ⇒ `showStop`（`state === 'in-turn' && canInterrupt`）不变，Stop 保留。
3. **elapsed 取服务端 turn 的 startedAt（b）**：`useActivityFreshness` 把锚点改为**服务端上报的 turn 起始**（AC-383 的 `turn.startedAt`，服务端钟），hello / heartbeat 的 `asOf` 只推进 `asOf`、不再当锚（改 `:184` 与 heartbeat 分支的 `?? asOf`）。同一 `bootId` 内，组件卸载重挂载或新 hello 都不改锚；`bootId` 变（进程重启）则该 turn 作废、锚清空。读取路径三选一（读数相同）：
   - 在 `useActivityFreshness` 自身连接上处理 `activity.snapshot` / `activity.upsert` 帧（AC-383 的 `turn.startedAt`）；或
   - 经 `useSessionActivity` 视图读取——此时**先**把 `src/modules/chat/hooks/useSessionActivity.ts` 用 task_write 加进 Touches；或
   - 在 hello / heartbeat 帧上新增 `turnStartedAt` 字段（同样满足读数）——此时后端按 `$backend-module-standards` 实现，并**先**把 `server/modules/websocket/services/activity-heartbeat.service.ts`（视情况 `chat-websocket.service.ts`）加进 Touches。
4. **文案键落全 locale**：`claudeStatus.awaitingServer.title`（en 如 `'Waiting for the server'`）加进全部 12 个 shipped locale 的 `chat.json`，照 `unreachable` / `sendFailed` 的先例；组件侧带 `defaultValue` 兜底。
5. **跑守卫**：新判据绿；既有客户端 dock 判据保持绿（写下运行的文件清单与读数）；`npm run typecheck`、`npm run lint` 退出 0。

## AC

- [x] AC1 判据绿：`npx vitest run src/modules/chat/tests/activityDockHonestStatus.test.tsx` 退出 **0**。红态基线：文件不存在，vitest 报 `No test files found`（退出 1）——把逐字红态读数抄进完成记录。
- [x] AC2 (a) 如实文案（承重）：`processing=true`（activity prop 非空）+ 服务端心跳持续到达且 `phase: 'idle'`、`isProcessing: true`、过了阈值仍无任何携带 phase 的 turn 帧 ⇒ 断言 (i) label **不等于** `Working…` 且**不含任何** `claudeStatus.actions.*` 词（该组值从 en `chat.json` 读出，不重打字面量）；(ii) label 等于 `chat.json` 里 `claudeStatus.awaitingServer.title` 的值；(iii) `data-activity-state === 'in-turn'`；(iv) 传入 `onStop` + `canStop` 时坞内**仍有** Stop 控件（`data-testid="running-turn-stop"`）。每条读数先打印再断言。
- [x] AC3 (b) elapsed 取服务端 turn 的 startedAt：以服务端钟 `S` 起一个 turn（帧携带 turn 起始 `S`），推进到 `S+T` 后读 `data-activity-elapsed-ms ≈ T`；**卸载再挂载**（`unmount()` 后重新 `render`，喂同一 / 更晚 `asOf` 的帧）⇒ 读数仍 ≈ T（**不回到 0**）；**再喂一个新 hello**（更晚 `timestamp`、同 `bootId`）⇒ 读数仍不归零。所有读数先采齐再断言。
- [x] AC4 (c) 真实在跑的 turn 不回退：phase 依次 `thinking` / `writing` / `tool` 的帧 ⇒ label 分别为 locale 的对应词（`tool` 带工具名）、`data-activity-phase` 逐帧相符，且 elapsed 随 `asOf` 推进逐秒增长（跨 ≥3 秒采多点、单调不减）。
- [x] AC5 (d) **取假形态可复现**：把 elapsed 锚点改回 hello 的 `asOf`（S1 行为）⇒ 判据文件一字不动重跑退出**非 0**，且红**落在 (b) 的「重挂载 / 换 hello 后读数不归零」断言**上（**不是别的腿先红**）；用后还原、重跑 (a)–(c) 恢复绿。逐字红态读数、退出码、变异 diff 与恢复命令抄进完成记录，`git diff` 最终不含该临时代码。
- [x] AC6 既有客户端判据不回退：逐个 `npx vitest run` 跑 `src/modules/chat/tests/activityDockUnreachable.test.tsx`、`activityDockProgressReading.test.tsx`、`activityDockPhaseTruthful.test.tsx`、`activityDockControls.test.tsx`、`activityDockConsolidation.test.tsx`、`activityDockTaskSchedule.test.tsx`、`src/modules/chat/tests/activityFreshness.test.ts`、`activityIndicatorResponsive.test.tsx`，各退出 **0**；写下文件清单与读数。**特别**：不得改动 `activityDockUnreachable.test.tsx` 与 `activityDockProgressReading.test.tsx`（与本题相反方向的 pin）；若实现上被迫改，在完成记录里逐条列出并说明，不得悄悄让它们变红。
- [x] AC7 遵守 `$frontend-module-standards`（`@/` 导入、`type` 不用 `interface`、`import type`、导出带消费方注释、跨模块只经 `index.ts` barrel、测试放 `src/modules/chat/tests/`）；若实现触及 `server/`，那部分遵守 `$backend-module-standards`。`npm run typecheck` 与 `npm run lint` 退出 0。
- [x] AC8 collateral：新增一个客户端测试文件后复量是否压破任何既有覆盖率 / 时长地板，按需更新对应基线；先量（通常不动，免得给 diff 添未声明文件），把复量命令与读数抄进完成记录。

## DoD

真实落地（不是「测试存在」、也不是「常量存在」）：在 `src/modules/chat/tests/activityDockHonestStatus.test.tsx` 上以**真实** `ActivityIndicator` + **真实** `useActivityFreshness` + 内存 `ActivityConnection` + 注入的假钟驱动真实形状的帧序列——

(a) 本地表说 processing、服务端持续心跳但 `phase` 一直 `idle`、过阈值仍无任何携带 phase 的 turn 帧 ⇒ label 是 `claudeStatus.awaitingServer.title` 的如实文案（既非 `Working…`、也非六个轮换词之一），`data-activity-state="in-turn"`，且坞内仍画着 Stop；
(b) 同一 turn（服务端钟 `S`）跨「卸载再挂载」与「新 hello」⇒ `data-activity-elapsed-ms` 取自 `S`、**不归零**；
(c) phase 为 `thinking` / `writing` / `tool` 的真实 turn 仍显示对应标签与逐秒增长的 elapsed；
(d) 假形态（锚点改回 hello 的 `asOf`）⇒ (b) 变红、还原后恢复绿——即红的是那条读数本身，判据有洞会被看见；
(e) `activityDockUnreachable` / `activityDockProgressReading` / `activityDockPhaseTruthful` / `activityFreshness` 等既有判据逐字不改、各退出 0；`npm run typecheck`、`npm run lint` 退出 0。

「等待服务端」的文案键**不在** `claudeStatus.actions.*` 之下（那组是六词正控制集合），且加进全部 12 个 shipped locale。

## Touches

- `src/modules/chat/hooks/useActivityFreshness.ts` （elapsed 锚改为服务端 turn 起始，不再用 hello 的 `asOf`；`:184` 与 heartbeat 分支的 `?? asOf`）
- `src/modules/chat/utils/activityDockView.ts` （`in-turn` ∧ phase idle ∧ 过阈值的如实读数）
- `src/modules/chat/composer/ActivityIndicator.tsx` （如实文案，`data-activity-state` 仍 `in-turn`、Stop 保留）
- `src/modules/i18n/locales/en/chat.json` （新增 `claudeStatus.awaitingServer.title`）
- `src/modules/i18n/locales/de/chat.json`
- `src/modules/i18n/locales/es/chat.json`
- `src/modules/i18n/locales/fr/chat.json`
- `src/modules/i18n/locales/id/chat.json`
- `src/modules/i18n/locales/it/chat.json`
- `src/modules/i18n/locales/ja/chat.json`
- `src/modules/i18n/locales/ko/chat.json`
- `src/modules/i18n/locales/ru/chat.json`
- `src/modules/i18n/locales/tr/chat.json`
- `src/modules/i18n/locales/zh-CN/chat.json`
- `src/modules/i18n/locales/zh-TW/chat.json`
- `src/modules/chat/tests/activityDockHonestStatus.test.tsx` （新：AC-388 判据文件，(a)–(d) 四条腿 + 取假形态）
- `tasks/gap-ac388-activity-dock-honest-status.md` （自触）

（若实现按 Plan 第 3 步选择经 `useSessionActivity` 读取、或改 hello/heartbeat 帧携带 `turnStartedAt`，**先**用 task_write 把 `src/modules/chat/hooks/useSessionActivity.ts` 或 `server/modules/websocket/services/activity-heartbeat.service.ts`（视情况 `chat-websocket.service.ts`）加进本 Touches 再写。）

## 完成记录

**结论：AC-388 已落地。活动坞对「本地表说 processing、服务端一直在证明自己在、却从未上报任何 running phase」的 turn 不再写 `Working…`，改说 `claudeStatus.awaitingServer.title`；elapsed 锚取服务端 turn 的起始（AC-383 的 activity 快照 `turn.startedAt`），重挂载 / 新 hello 不归零。**

### AC1 —— 判据绿（红态基线先取）

- 红态基线（文件不存在）：`npx vitest run src/modules/chat/tests/activityDockHonestStatusDoesNotExist.test.tsx` → 逐字 `No test files found, exiting with code 1`、`EXIT=1`。
- 绿：`npx vitest run src/modules/chat/tests/activityDockHonestStatus.test.tsx` → `Test Files 1 passed (1)`、`Tests 3 passed (3)`、`EXIT=0`。

### AC2 (a) —— 如实文案（读数先采齐再断言）

`dock.honestStatus.(a) t=0: state=in-turn label="Working" | after 16000ms of idle beats: state=in-turn label="Waiting for the server" elapsed=16000ms action-word-hits=[]`

断言：label 不含任何 `claudeStatus.actions.*`（`hits=[]`）、`label === enChat.claudeStatus.awaitingServer.title`（`Waiting for the server`）、`data-activity-state === 'in-turn'`、`[data-testid="running-turn-stop"]` 仍在。t=0 正控制：仍读到轮换词（`Working`）。

### AC3 (b) —— elapsed 锚 = 服务端 turn 的 startedAt

`dock.honestStatus.(b) before remount: elapsed=30000ms (want 30000) | after remount: elapsed=30000ms (want 30000) | after a new hello: elapsed=35000ms (want 35000)`

服务端钟 `S` 起 turn（快照 `turn.startedAt = S`），推进到 `S+T`（T=30000）读 `data-activity-elapsed-ms = 30000`；`unmount()` 后重新 `render` + 重放同一快照 ⇒ 仍 `30000`（不归零）；再喂更晚 `timestamp`、同 `bootId` 的新 hello ⇒ `35000`（只有 `asOf` 前进，锚不动）。

### AC4 (c) —— 真在跑的 turn 不回退

`dock.honestStatus.(c) thinking: phase=thinking label="Thinking" elapsed=3000ms | writing: phase=writing label="Writing" elapsed=7000ms | tool: phase=tool label="Running Bash" elapsed=11000ms`

`data-activity-phase` 逐帧相符（thinking/writing/tool，`tool` 带工具名 `Bash`）；elapsed 随 `asOf` 推进单调增（3000 < 7000 < 11000，跨度 8000ms ≥ 3s）。

### AC5 (d) —— 取假形态可复现（锚改回 hello 的 `asOf` = S1 行为）

```
$ cp useActivityFreshness.ts /tmp/backup
$ git show develop:src/modules/chat/hooks/useActivityFreshness.ts > src/modules/chat/hooks/useActivityFreshness.ts
$ npx vitest run src/modules/chat/tests/activityDockHonestStatus.test.tsx
   × (b) the elapsed anchor is the server turn start: a remount and a later hello do not restart it
     → a remounted dock must still publish an elapsed reading; readings: before remount: elapsed=30000ms (want 30000) | after remount: elapsed=nullms (want 30000) | after a new hello: elapsed=0ms (want 35000)
   ✓ (a) ...   ✓ (c) ...
 Test Files  1 failed (1) | Tests  1 failed | 2 passed (3)      EXIT=1
$ cp /tmp/backup src/modules/chat/hooks/useActivityFreshness.ts
$ npx vitest run src/modules/chat/tests/activityDockHonestStatus.test.tsx   →  Tests 3 passed (3)   EXIT=0
```

红**只**落在 (b) 的「重挂载后读数不归零」那条断言上（(a)、(c) 保持绿）；判据文件一字未动。变异 diff = `useActivityFreshness.ts` 回到 develop（无 snapshot 分支 ⇒ 锚只能来自 hello/heartbeat 的 `asOf`）；`git status --porcelain` 最终不含该临时代码（已还原，最终提交 1e6daf74c 即实现本体）。

### AC6 —— 既有客户端判据不回退（逐文件，各自 `npx vitest run`）

| 文件 | 读数 | 退出 |
| --- | --- | --- |
| `activityDockUnreachable.test.tsx` | `8 passed (8)` | 0 |
| `activityDockProgressReading.test.tsx` | `1 passed (1)` | 0 |
| `activityDockPhaseTruthful.test.tsx` | `4 passed (4)` | 0 |
| `activityDockControls.test.tsx` | `4 passed (4)` | 0 |
| `activityDockConsolidation.test.tsx` | `2 passed (2)` | 0 |
| `activityDockTaskSchedule.test.tsx` | `5 passed (5)` | 0 |
| `activityFreshness.test.ts` | `7 passed (7)` | 0 |
| `activityIndicatorResponsive.test.tsx` | `8 passed (8)` | 0 |

`activityDockUnreachable.test.tsx` 与 `activityDockProgressReading.test.tsx`（相反方向的 pin）逐字节未改，`git diff` 不含。

### AC7 —— 标准 / typecheck / lint

- `npm run typecheck` → `EXIT=0`（`tsconfig.json` + `server/tsconfig.json` + `scripts/tsconfig.json` 三步全过）。
- `npm run lint` → `EXIT=0`（无 error；`activityDockHonestStatus.test.tsx` 零告警；`useActivityFreshness.ts` / `ActivityIndicator.tsx` 上的 `react(refs)` / `react(set-state-in-effect)` 均为 develop 上既有的 warning）。
- `$frontend-module-standards`：`@/` 应用源导入、无 `interface`、`import type`、导出常量带消费方注释、跨模块只经 barrel（本改动全在 chat 模块内）、测试置于 `src/modules/chat/tests/`。未触及 `server/`。

### AC8 collateral —— 复量覆盖率 / 时长地板

- 复量命令：`npx vitest run src/modules/chat/tests/activityDockHonestStatus.test.tsx`（本文件最慢用例 35ms）。
- 全库无客户端覆盖率阈值（`vitest.config.ts` 无 `coverage` 配置）；`scripts/suite-duration-baseline.tsv` 只列 **server** 测试文件（不覆盖本文件）；唯一的客户端时长地板 `scripts/test-timeout-margin-check.sh`（判据：每个 client 文件 `T_max ≤ B/K = 5000/4 = 1250ms`）——新文件 `T_max = 35ms`，远在阈值内 ⇒ **未改任何基线**（不给 diff 添未声明文件）。

### 交付物

- `src/modules/chat/utils/activityDockView.ts`：新增导出常量 `UNCONFIRMED_TURN_LABEL_MS = 15_000` 与 `ActivityDockView.awaitingServer`（判定：`in-turn ∧ phase === 'idle' ∧ elapsed ≥ 阈值`）。
- `src/modules/chat/composer/ActivityIndicator.tsx`：`awaitingServer` ⇒ label 落 `claudeStatus.awaitingServer.title`（**不**在 `claudeStatus.actions.*` 之下；仅替换 `Working` 兜底，不覆盖 provider `statusText`）；`data-activity-state` 仍 `in-turn` ⇒ `showStop` 不变、Stop 保留。
- `src/modules/chat/hooks/useActivityFreshness.ts`：接 `activity.snapshot` / `activity.upsert`，把 AC-383 的 `turn.startedAt` 作为 elapsed 锚；hello/heartbeat 的 `asOf` 只在服务端从未给出 turn 起始时兜底（既有 pin 依赖该兜底）。
- 12 个 shipped locale 的 `chat.json` 各新增 `claudeStatus.awaitingServer.title`（已逐 locale 核对：不含任何 locale 的 `claudeStatus.actions.*` 词）。
- `src/modules/chat/tests/activityDockHonestStatus.test.tsx`（新）：(a)–(c) 三条腿 + t=0 正控制。

### 边界（与既有 pin 的关系）

- `unreachable` 那条读数未受影响：`awaitingServer` 只在 `in-turn` 分支计算，`activityDockUnreachable` 全文未动且绿。
- 「过阈值才生效」保证 t=0 的两条相反方向正控制（`activityDockUnreachable` 的六词、`activityDockProgressReading` 的首帧 `Working`）保持绿。
