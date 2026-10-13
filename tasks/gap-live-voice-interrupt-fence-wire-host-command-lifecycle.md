---
id: gap-live-voice-interrupt-fence-wire-host-command-lifecycle
title: 生产接线：server/index.ts 的 voice seams 接入 hostCommandLifecycle（经
  provider-runtime 暴露 resident host 的 command_lifecycle started 读数），让 AC-343 栅栏的
  covered 半边在生产生效（当前为死代码）
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-run-digest-evaluation-signal
  - gap-live-voice-continuous-transport-opt-in
  - gap-live-voice-interrupt-real-assembly-e2e
goal_ac: AC-343
---
## Proposal

**这是 AC-343 判据从未端到端验证过的「生产接线」那一半。** AC-343 的判据（`voice-realtime-interrupt-fence.test.ts`）在自己的 harness 里手动注入了 `hostCommandLifecycle`，证明的是 `decideModelInterrupt` 的逻辑；它从未证明生产装配接了这个 seam。

### 缺口（2026-10-13 实测）

- `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 声明了可选 seam `hostCommandLifecycle?: (sessionId) => HostCommandLifecycleReading | null`（约 :1024），`refreshInterruptCovers()`（约 :1820）据此填充 `coveredSeqs`；seam 缺失时直接 return。
- `server/index.ts` 的 `buildVoiceRealtimeSeams`（约 :538 起，接 `createVoiceRealtimeLiveExecutor` 的位置约 :680，同族 seam `hostQueueReading:` 约 :744、`hostRunActivity:` 约 :759）**没有接 `hostCommandLifecycle`**，`grep -n hostCommandLifecycle server/index.ts` 无输出。
- ⇒ 生产里 `coveredSeqs` 永远为空，`decideModelInterrupt` 的 covered 分支（`maxCovered >= triggerSeq`）是**死代码**，只有幂等半边（`abortedTriggerSeq === triggerSeq`）生效。行为后果已由 `gap-live-voice-interrupt-real-assembly-e2e` 的 `(d) contrast` 用例在真实装配链上读出：当前 run 已经把那句话出队进了 turn，模型再为同一句话调一次中断，**仍然会中止这个正在回答它的 run**（`aborted:true`，host interrupt 被调 1 次）。这正是 SPEC §0.3 D-7 要禁止的反复中断抖动。
- **生产侧还没有可以接的读数**：claude resident driver 在进程内记录了 `command_lifecycle`（`server/modules/providers/list/claude/claude-host-driver.provider.ts` 的 `lifecycle: CommandLifecycleEvent[]`），但 `server/modules/providers/services/provider-runtime.service.ts` 只对外暴露了 `pendingQueuedInputs`，没有「已 started 的 commandUuid」读数。所以本任务不是在 `server/index.ts` 加一行：需要先在 runtime 网关加一个与 `pendingQueuedInputs` 同形的只读方法（经 `resolveResidentDriver` 解析；拿不到读数时返回 `null`，不能返回空数组），再在 `buildVoiceRealtimeSeams` 里按 `hostQueueReading` 的写法接上（由 `sessionsDb.getSessionById(id)?.provider` 解析 provider）。

### 要做的事

1. resident driver 暴露 `startedQueuedCommands(appSessionId): readonly string[] | null`（命名由实现定，语义固定为「CLI 已出队进 turn 的 commandUuid」，取自 `command_lifecycle` 的 `started` 事件）。
2. `provider-runtime.service.ts` 增加同名只读网关方法，与 `pendingQueuedInputs` 同形：provider 未知、会话非 resident、driver 没有该方法、host 不在、或抛错时，一律返回 `null`。
3. `server/index.ts` 的 `buildVoiceRealtimeSeams` 增加 `hostCommandLifecycle: (sessionId) => …`，紧邻 `hostQueueReading`。
4. 更新 `gap-live-voice-interrupt-real-assembly-e2e` 留下的两处钉子（见 AC3）。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- ⛔ 不改 `decideModelInterrupt` 的判定逻辑（它已被 AC-343 证明），只改接线与读数通道。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3 D-7、§18.3 R-4.3、§18.4 G2。

## Plan

1. 读 claude driver 的 `lifecycle` 记录点与 `pendingQueuedInputs` 的实现；2. driver 方法 + runtime 网关方法（附单测：resident/非 resident/host 不在/抛错四种情况）；3. `server/index.ts` 接线；4. 翻转 Task A 的钉子：KNOWN GAP 钉子改为正向断言，`(d) contrast` 改为在生产同款接线下期望 `covered`；5. 跑 fence、真实装配、revision-order、queue-depth 判据；6. typecheck / lint。

## AC

- [x] AC1（承重，生产接线）：`grep -n "hostCommandLifecycle" server/index.ts` 有命中，且位于 `buildVoiceRealtimeSeams` 范围内；它读的是 runtime 网关的新方法，不是测试替身。
- [x] AC2（承重，真实链行为翻转）：在 `server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts` 中，`real assembly (d) contrast` 改用与 `server/index.ts` **同一个**读数函数（经真实 `createProviderRuntimeService` + 假 resident host 的 `startedQueuedCommands`），断言**不额外注入测试 seam** 也得到 `{stopped:false, reason:'covered'}`，host interrupt 被调 0 次。改前同一用例读到 `aborted:true`、host interrupt 被调 1 次（作为红证据记入 Notes）。
- [x] AC3（钉子交接，必须做）：`gap-live-voice-interrupt-real-assembly-e2e` 的用例 `KNOWN GAP (fixTask gap-live-voice-interrupt-fence-wire-host-command-lifecycle): server/index.ts does not wire hostCommandLifecycle, so the covered-fence half is dead in production` 在本任务接线后**会转红**（这是预期）。本任务必须把它改为正向断言（例如 `server/index.ts wires hostCommandLifecycle in buildVoiceRealtimeSeams`），并删除 `KNOWN GAP` 字样；`grep -n "KNOWN GAP (fixTask gap-live-voice-interrupt-fence-wire-host-command-lifecycle)" server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts` 无输出。
- [x] AC4：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts`、`…/voice-realtime-interrupt-fence.test.ts`、`…/voice-realtime-interrupt-revision-order.test.ts`、`…/voice-realtime-queue-depth-truth.test.ts`，以及 runtime 网关新方法所在的 providers 测试文件，各自单文件运行退出 0（⛔ 不做多文件 fan-out）。
- [x] AC5：`npm run typecheck`、`npm run lint` 退出 0；若新增了 `*.test.ts`，同步更新 `server/shared/tests/quay-test-script.test.ts` 计数钉子并单跑退出 0（优先在既有 providers 测试文件里追加用例，避免新增文件）。

## DoD

真实落地：生产装配里 covered 半边可达。以 `server/index.ts` 同款读数函数驱动真实装配链，读到「已覆盖的句子 ⇒ covered、host interrupt 被调 0 次」；真实 claude resident driver 的 `started` 读数来自它自己记录的 `command_lifecycle`，不是 proxy 用消息 id 推导出来的（SPEC §18.3 R-4.3）。可选的更高一层：用真实二进制的 resident 会话读一次 `started` 列表，或把这一项明确标为未验证、写进 Notes。不得用「接了一个返回 `null` 的 seam」冒充接线——那样 `coveredSeqs` 依然是空的。

## Touches

- server/index.ts（`buildVoiceRealtimeSeams` 增加 `hostCommandLifecycle:`）
- server/modules/providers/services/provider-runtime.service.ts（新增只读网关方法）
- server/modules/providers/list/claude/claude-host-driver.provider.ts（暴露 started commandUuid 读数）
- server/modules/voice-realtime/tests/voice-realtime-interrupt.test.ts（翻转 KNOWN GAP 钉子与 (d) contrast）
- server/modules/providers/tests/provider-runtime.service.test.ts（新方法的四种情况）
- tasks/gap-live-voice-interrupt-fence-wire-host-command-lifecycle.md

## Notes

立项：Opus 子代理会话，2026-10-13，由 `gap-live-voice-interrupt-real-assembly-e2e`（Task A）实测发现。goal_ac 挂 AC-343：这是 AC-343 自己的判据从未端到端验证过的生产接线半边。不重开 GOAL-041 的退出条件；AC-343 是否需要补判据由人决定。

### 落地（worker，2026-10-13）

分支 `task/gap-live-voice-interrupt-fence-wire-host-command-lifecycle`（自 develop `dffed541`），一个提交。三条读数通道：

- `claude-host-driver.provider.ts`：`startedQueuedCommands(appSessionId)` 把进程内 `lifecycle` 里 `state === 'started'` 的事件折成去重后的 commandUuid 列表；不是本 driver 托管的会话返回 `null`，`[]` 是**真实读数**（空闲队列）。
- `provider-runtime.service.ts`：`startedQueuedCommands(provider, sessionId)` 是 `pendingQueuedInputs` 的同形兄弟，经 `resolveResidentDriver` 下潜，返回**脱离副本**（调用方改不动 host 状态）；非 resident / host 不在 / driver 无此方法 / 抛错一律 `null`。
- `server/index.ts` `buildVoiceRealtimeSeams`：`hostCommandLifecycle` 接在 `hostQueueReading` 隔壁，provider 取 `sessionsDb.getSessionById(id)?.provider`，`[]` 不塌成 `null`。锚点：`server/index.ts:782`，闭合于 :853 之前。

#### AC2 红证据（改前，真实装配链，同一 (d) 场景）

`(d-unwired) interrupt={"aborted":true,"runId":"…","triggerSeq":1,"queuedStillPending":0} abortCount=1` —— 未接线时，为一句 run 已经出队进 turn 的句子调中断，仍然中止了正在回答它的那个 run。改后同一条链（`withRealChain({})`，生产默认接线）读作 `(d-production) interrupt={"stopped":false,"reason":"covered",…,"triggerSeq":1,…} abortCount=0`。

判据拆分：`(d)` 用例仍由**判据自己**注入读数以隔离 proxy 的 join（host uuid → 投递携带的 utterance → `coveredSeqs`）；`(d) contrast` 走生产接线；新增 `(d) false form`（`hostCommandLifecycle: 'absent'` = 本任务之前装配的假形态）保住一条可执行的真实链臂，其读数确实不同（`aborted:true`、interrupt 1 次），使两条正向用例非空洞。KNOWNGAP 钉子替换为 `server/index.ts wires hostCommandLifecycle in buildVoiceRealtimeSeams`（仍以 `buildVoiceRealtimeSeams` 为范围并断言同族 seam 存在，另加「不是 `=> null` 桩」一条）。

#### 未验证项（明示）

- DoD 的**可选更高一层**——用真实二进制的 resident 会话读一次 `started` 列表——**未验证**：本任务不启动真实 claude resident 进程（SCOPE BOUNDARY：不重启服务、不碰生产）。driver 层的读数是单测 + 真实装配链上的假 resident host 覆盖的，真实二进制侧的 `command_lifecycle.started` 落点由既有 driver 行为承载。
- 未新增 `*.test.ts`，故 `server/shared/tests/quay-test-script.test.ts` 的计数钉子无需变更；仍单跑确认退出 0。

#### 验证读数（单文件、顺序，退出码）

`voice-realtime-interrupt.test.ts` 14/14、`voice-realtime-interrupt-fence.test.ts` 6/6、`voice-realtime-interrupt-revision-order.test.ts` 7/7、`voice-realtime-queue-depth-truth.test.ts` 5/5、`provider-runtime.service.test.ts` 7/7、`quay-test-script.test.ts` 全绿 —— 均 exit 0。`npm run typecheck` exit 0（三个 tsconfig）；`npm run lint` exit 0，改动文件无任何 finding。

depends_on（历史：避免 Touches 冲突，须在这些任务合入 develop 之后再做）：
- `gap-live-voice-run-digest-evaluation-signal`
- `gap-live-voice-continuous-transport-opt-in`
- `gap-live-voice-interrupt-real-assembly-e2e`（提交 `f67ad5b3`，本任务翻转的钉子在它里面）

已落地、不再构成依赖：`gap-live-voice-silence-tail-suppression`（done）、`gap-live-voice-double-drop-fault-injection-red-first`（done）、`gap-live-voice-reconnect-epoch-scoped-commit-pairing`（done）。`gap-live-voice-double-drop-browser-e2e`（todo）的 Touches 只有 `e2e/voice-realtime-double-drop.spec.ts` 与 `playwright.config.ts`，与本任务不重叠，所以不列为依赖。

先例：`gap-live-voice-scripted-scenarios-interrupt-covered-regression` 的 Notes 已记录「`buildVoiceRealtimeSeams` 没有接 `hostCommandLifecycle`，浏览器 e2e 里 `coveredSeqs` 恒为空」，但当时没有立案跟进；本任务就是那次的跟进。`gap-live-voice-queue-depth-refresh-on-turn-boundary` 的 Notes 记录过 driver 只有 PULL 读数、没有 push 通道——本任务同样只走 PULL 读数（栅栏在中断那一刻采样），不需要订阅。