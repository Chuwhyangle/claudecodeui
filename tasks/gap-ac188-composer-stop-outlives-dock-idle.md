---
id: gap-ac188-composer-stop-outlives-dock-idle
title: AC-188 回合结束窗口再红：原子读数 {dock:absent, sidebar:false,
  send:stop}——坞已空闲而发送键仍是停止态，三处并未读同一活性
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-188
---
## Finding

**现象（门账本，最后一次直接重跑）**

门账本 AC-188 的 `gate=goal` 事件，最后一条 = **fail**，`timestamp 2026-10-09T16:07:58.542Z`，`treeSha
d18dd560317f0a8d8806cca37b7659b325392093`，`evaluationRoot=/data/home/yale/work/claudecodeui`（随后
`ac1e7b7f` 一次与本判据无关的 voice-realtime 提交把 HEAD tree 推到 `538830ec`，不影响本判据读数）。该次
`reason` 又被截断在 WebServer 的 stderr（`[BABEL] Note … exceeds the max of 500KB`、`[DEP0190]`），
读不出失败落点——与上一轮同类，故本轮不依赖 reason 尾巴，直接读失败现场。

**失败现场（该次运行的 `error-context.md`，逐字）**

```
Error: desktop: no reading may show the dock idle while the sidebar or the send button still says busy
expect(received).toEqual(expected)
- Expected  -  1
+ Received  + 42
- Array []
+ Array [ { "dock": "absent", "send": "stop", "sidebar": false } × 8 ]
```

落点 `e2e/activity-dock-truthful.spec.ts:1772-1775`——回合结束后的**定窗** `disagreements` 断言
（`reading.afterTurn.filter((s) => !inTurn(s.dock) && (s.sidebar || s.send === 'stop'))`）。桌面视口 8 个
样本**全部**读作 `{dock:'absent', sidebar:false, send:'stop'}`：坞读空闲、侧栏读不忙，而**发送键仍是停止
态**。这正是 AC-188 明文禁止的「坞说空闲而别处说忙」。

**同一现场的活窗读数（该次运行的 `trace.zip` 内 stdout，原子采样）**

`consistency.afterTurnLive.desktop` 与 `.mobile` 各 24 个样本**全部** `{dock:'absent', sidebar:false,
send:'stop'}`；`consistency.afterTurn.desktop` 8 个样本同样全 `…send:'stop'`。活窗由 `sampleBurst` 在
页内**同一次同步 `read()`** 里读三处（`e2e/activity-dock-truthful.spec.ts:1351-1363`），所以这**不是**
「三次读数之间的竞态」——同一个 DOM 瞬间里 composer 的提交键仍是停止态，而坞与侧栏已读空闲。发送键比坞
多停了至少 1.3s（活窗跨度 1288ms）+ 0.5s（定窗 503/988ms）。

**三处本应读同一活性，却在此处分叉**

- 坞：`deriveActivityDockView(useActivityFreshness(sessionId)…)` 的产物（`ChatComposer.tsx:455-461`、
  `src/modules/chat/hooks/useActivityFreshness.ts`）；其 in-flight 权威位来自 `activity.heartbeat` 的
  run-registry 位。
- 发送键：`submitAriaLabel` 仅由 `isLoading` 决定（`ChatComposer.tsx:505-516`）；`isLoading` =
  `ChatInterface.tsx:890` 传入的 `isProcessing` = `useChatSessionState.ts:614-615` 的
  `processingSessions.get(activeSessionId) !== null`。
- 侧栏：`RunningView.tsx:67` 的 `useBusySessionIdSet()` = `processingSessions` 成员集
  （`SessionProtectionContext.tsx:49-58`）。

`send:'stop'` 与 `sidebar:false` 名义上都来自 `processingSessions` 成员，同一刻不应相反；现场却相反且持
续整个窗口。**待判定**：复现这一读数后给出分叉源——最可能是「发送键的忙态读到了一条比坞的 in-flight 权
威位活得久的信号」（`processingSessions` 由 `complete` 帧 / 5s 轮询清除，坞由 heartbeat 的 in-flight 位
清除，两条清除路径落点不同），使坞先离线而发送键滞后；或侧栏读数为测量伪影（`RUNNING_GROUP` 容器此刻未
挂载）。修法须让三处在回合结束的边沿**同时**回到空闲。

**为什么早先的修法没兜住**

`gap-activity-single-dock-global-consistency` 建的是判据本身；`gap-ac188-criterion-body-budget-below-
its-turn-walk-floor`、`gap-ac188-case-budget-red-is-postturn-renavigation-tail` 只抬/重标用例体预算；
`gap-ac188-case-bootstrap-collision-and-gate-kill` 修的是夹具账号冲突与 setup 重试；
`gap-ac188-criterion-agreement-loses-poll-source-falsifiability` 退役的是一条假形态。**没有一条改过「发
送键忙态的清除源」**。并且提交 `2b774f6d`（`e2e(AC-188): drop the post-turn re-navigation from the
settled reading`）移除了回合后重新导航——正是它此前给慢表面留出的收敛时间；撤掉后定窗直接落在收敛边上，
这条分叉才暴露出来。

**复现性**

立案前在同一树上跑 `-g "AC-188"` 10 次（80 个装载进程，load1 29→102）**10/10 pass**（`dock.wall`
17.6–17.8s）。故这是一条**间歇**分叉：门账本记 fail，直接重跑多数绿——判据要求的「任何时刻」不变量并不
稳定成立。

<!-- dedup-ref -->
与在办任务的关系：本仓所有携带 `goal_ac: AC-188` 的任务（含上列）均 `done`，无在办重复；
`task-granularity-advice` 对候选 Touches 报 `peers: []` / `mentions: []`，判为 **separate**。

## AC

- [ ] AC1 复现：在立案树上重复运行 `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"`，捕获至少一次回合结束窗口里 `{dock:'absent', send:'stop'}` 同现的读数（命令与原始输出行写进 ## Evidence）。
- [ ] AC2 定位分叉源：用逐帧/逐钩探针给出「发送键忙态」与「坞 in-flight 权威位」在回合结束边沿各自的清除时刻，指明谁滞后、滞后多久（写进 ## Evidence 并给出结论）。
- [ ] AC3 修复：让回合结束后三处同时读空闲——坞 `absent` ⟺ 发送键回到 `input.send` ⟺ 侧栏不计该会话；不得靠加宽窗口 / 放宽断言 / 加 sleep / 改探针节奏达成。
- [ ] AC4 判据绿：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` 连续 ≥8 次 exit 0（其中 load1 ≥80 的 ≥3 次），且每次 `dock.wall ≤ 25_000`。
- [ ] AC5 假形态仍红（旧坞挂载）：临时恢复旧 `ActivityIndicator` 标记挂载 ⇒ 数量读数（`docks` / `legacy`）必须红；还原。
- [ ] AC6 假形态仍红（泊源 busy）：让侧栏 / 状态栏改读 1 秒轮询的 busy ⇒ 一致性读数在回合刚结束的窗口内必须红；还原。
- [ ] AC7 假形态仍红（本缺陷）：临时让发送键忙态的清除滞后坞一拍 ⇒ `afterTurn` / `afterTurnLive` 的 `disagreements` 必须红；还原。
- [ ] AC8 预算与实质读数不动：`SINGLE_SPEC_CEILING_MS`（55_000）、60s 门、`e2e/activity-dock-truthful.spec.ts` 里每一条实质读数（`docks` / `legacy` / `residentActivityMarkers` / panel / `turn` / `settled`）不得改动；仅当读数为测量伪影时可改读法，不得改不变量。
- [ ] AC9 静态闸：`npx oxlint src/` 与 `npx tsc --noEmit -p tsconfig.json` 在改动文件上 exit 0。

## DoD

Definition of Done — the real bar, not artifacts: on the post-fix tree the criterion
`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` lands green **repeatedly on a live
host**（含高 load1 ≥80 的至少 3 次），并且用**机制演示**证明这次绿是修出来的而非运气：在改后树上
**故意复活本缺陷**（AC7 的变异：让发送键忙态的清除滞后坞一拍），观察到 `afterTurn` / `afterTurnLive` 的
`disagreements` 变红，再还原并重跑转绿。三条假形态（AC5 / AC6 / AC7）各自在同一树上红一次并还原。计数读
数（恰一个坞、旧页签与内联行计数 0、resident 无忙闲字样）与预算守卫保持原值。整个修改不削弱任何实质性读
数，不靠加宽窗口 / sleep / 放宽断言达成一致。

## Touches

- src/modules/chat/composer/ChatComposer.tsx（发送键忙态与提交键 aria-label 的清除源；坞的 `deriveActivityDockView` 落点）
- src/modules/chat/hooks/useChatSessionState.ts（`isProcessing = processingSessions 成员` 的导出）
- src/modules/chat/hooks/useChatRealtimeHandlers.ts（`complete` / `onSessionIdle` 清除 processingSessions 的落点）
- src/shared/context/SessionProtectionContext.tsx（processingSessions 提供者 / `busySessionIds`）
- e2e/activity-dock-truthful.spec.ts（判据用例；仅当读数为测量伪影时改读法，不改不变量）
- tasks/gap-ac188-composer-stop-outlives-dock-idle.md（本任务自身）