---
id: gap-ac188-composer-stop-outlives-dock-idle
title: AC-188 回合结束窗口再红：原子读数 {dock:absent, sidebar:false,
  send:stop}——坞已空闲而发送键仍是停止态，三处并未读同一活性
status: todo
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

- [x] AC1 复现：在立案树上重复运行 `npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"`，捕获至少一次回合结束窗口里 `{dock:'absent', send:'stop'}` 同现的读数（命令与原始输出行写进 ## Evidence）。
- [x] AC2 定位分叉源：用逐帧/逐钩探针给出「发送键忙态」与「坞 in-flight 权威位」在回合结束边沿各自的清除时刻，指明谁滞后、滞后多久（写进 ## Evidence 并给出结论）。
- [x] AC3 修复：让回合结束后三处同时读空闲——坞 `absent` ⟺ 发送键回到 `input.send` ⟺ 侧栏不计该会话；不得靠加宽窗口 / 放宽断言 / 加 sleep / 改探针节奏达成。
- [x] AC4 判据绿：`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` 连续 ≥8 次 exit 0（其中 load1 ≥80 的 ≥3 次），且每次 `dock.wall ≤ 25_000`。
- [x] AC5 假形态仍红（旧坞挂载）：临时恢复旧 `ActivityIndicator` 标记挂载 ⇒ 数量读数（`docks` / `legacy`）必须红；还原。
- [x] AC6 假形态仍红（泊源 busy）：让侧栏 / 状态栏改读 1 秒轮询的 busy ⇒ 一致性读数在回合刚结束的窗口内必须红；还原。
- [x] AC7 假形态仍红（本缺陷）：临时让发送键忙态的清除滞后坞一拍 ⇒ `afterTurn` / `afterTurnLive` 的 `disagreements` 必须红；还原。
- [x] AC8 预算与实质读数不动：`SINGLE_SPEC_CEILING_MS`（55_000）、60s 门、`e2e/activity-dock-truthful.spec.ts` 里每一条实质读数（`docks` / `legacy` / `residentActivityMarkers` / panel / `turn` / `settled`）不得改动；仅当读数为测量伪影时可改读法，不得改不变量。
- [x] AC9 静态闸：`npx oxlint src/` 与 `npx tsc --noEmit -p tsconfig.json` 在改动文件上 exit 0。

## Evidence

### AC1 复现 — the filed reading, reproduced

Command (same as the gate's `loop.scoped_command` shape):

```
npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"
```

On the filing tree (develop `6bf719a2`) the case ran **10/10 green** unmodified (load1 29→102,
`dock.wall` 17.6–17.8s) — the red is intermittent. It reproduces when a Vite HMR update lands in
the after-turn window, which is exactly what the gate's run had: the gate evaluates at
`evaluationRoot=/data/home/yale/work/claudecodeui` (`loop.repo_root`), the **main checkout**, where
sibling task workers edit `src/` and `server/` concurrently. Repeating the command there while
`src/modules/chat/ChatInterface.tsx` takes an HMR update reproduces the filed reading verbatim
(`/tmp/ac188-hmr2.log`):

```
[e2e] page console error: The above error occurred in the <ProjectWorkspaceRouteContent> component:
    at ProjectWorkspaceRouteContent (…/ProjectWorkspaceRoute.tsx:51:20)
    at PaletteOpsProvider (…/PaletteOpsContext.tsx:27:38)
    at SessionProtectionProvider (…/SessionProtectionContext.tsx:51:45)
    …
    at WebSocketProvider (…/src/shared/context/WebSocketContext.tsx?t=1791564059171:181:37)
    …
Consider adding an error boundary to your tree to customize error handling behavior.
consistency.afterTurnLive.desktop=[{"dock":"absent","sidebar":false,"send":"stop"}, … ×24]
consistency.afterTurnLive.mobile =[{"dock":"absent","sidebar":false,"send":"stop"}, … ×24]
consistency.afterTurn.desktop    =[{"dock":"absent","sidebar":false,"send":"stop"}, … ×8]
consistency.afterTurn.mobile     =[{"dock":"absent","sidebar":false,"send":"stop"}, … ×8]

    Error: desktop: no reading may show the dock idle while the sidebar or the send button still says busy
    > 1775 |       ).toEqual([]);
    at …/e2e/activity-dock-truthful.spec.ts:1775:9
  1 failed … EXIT=1
```

The `?t=…` on `WebSocketContext.tsx` is Vite's HMR stamp: the update replaced the module under the
running `WebSocketProvider`, the duo `useWebSocket`/`WebSocketProvider` no longer shared one React
context, `useWebSocket` threw (`must be used within a WebSocketProvider`), and
`ProjectWorkspaceRouteContent` — the whole workspace, composer, dock and sidebar together —
unmounted. Every sample after that is the same torn reading.

### AC2 定位分叉源 — the fork, named

There is **no fork between the three surfaces**. All three read one source, and the code says so:

- `useChatSessionState.ts:614-615` — `sessionActivity = processingSessions.get(activeSessionId) || null`,
  `isProcessing = sessionActivity !== null`. `ChatInterface` passes the same `sessionActivity` to
  `ActivityIndicator` (`activity={hasActivityIndicator ? activity : null}`, `ChatMessagesPane.tsx:669`,
  where `hasActivityIndicator = Boolean(sessionActivity …)`, `ChatInterface.tsx:728`) and the same
  `isProcessing` to `ChatComposer` (`isLoading={isProcessing}`).
- `ChatComposer.tsx:505-515` — `submitAriaLabel = … : isLoading ? (isResidentSession ? 'resident.stopResident' : 'input.stop') : 'input.send'`.
  With an empty draft the `input.send`-labelled button is absent **iff** `isLoading`.
- `ActivityIndicator.tsx:106-132` — the dock holds its last activity for `EXIT_ANIMATION_MS = 220ms`
  after `activity` goes null, then `deriveActivityDockView` returns `hidden` and it returns `null`
  (`:157`), so `dock === 'absent'`.

Chain: `send:'stop'` ⟹ `isLoading` ⟹ `sessionActivity ≠ null` ⟹ the activity handed to
`ActivityIndicator` is non-null in the same render ⟹ its state is never `hidden` ⟹ `dock ≠ 'absent'`.
So `{dock:'absent', send:'stop'}` is unsatisfiable **whenever the dock's `activity` input is
`sessionActivity`** — i.e. when no permission request is pending — and the composer form is drawn.
It has exactly two other reachable sources, and neither is a liveness divergence:

1. the composer form not drawn at all — the missing `input.send` button is then read as "the submit
   says stop" although there is no submit. **This is the filed red** (see AC1: the whole
   `ProjectWorkspaceRouteContent` subtree is unmounted, both surfaces together).
2. a pending permission request — `hasActivityIndicator = Boolean(sessionActivity && pendingPermissionRequests.length === 0)`
   makes the dock's `activity` null *by design* while the turn keeps running and the send stays
   `stop`. The permission card replaces the dock's row. AC-188's walk
   (`unattended-turn@0 → turn-end@5000 → wait@5500`) raises no permission, so this branch is not
   exercised by the criterion; the fix does **not** paper over it (a drawn, busy composer with a
   hidden dock still reads `stop` and still reds). The only place the two sources can read *differently* is the **open**
   edge, in the benign direction: `useActivityFreshness.ts:185,244-254` sets `hasTurnAnchor` from the
   server's hello/beat `isProcessing`, so the dock reads `in-turn` on the anchor while the composer is
   still idle (`turnOpen` samples: `{dock:'in-turn', sidebar:false, send:'send'}`). That is the dock
   *leading*, which the criterion does not (and should not) flag.

Who lags whom at the *end* edge — from the healthy window (`/tmp/ac188-fix-healthy1.log`),
`consistency.afterTurnLive.desktop`:

```
[{"dock":"in-turn",…,"send":"send"},×4, {"dock":"absent",…,"send":"send"},×20]
```

The **send clears first** (sample 0); the dock departs at sample 4, i.e. ~220ms later — exactly its
`EXIT_ANIMATION_MS`. The dock is the **last** to leave and never the first. There is no window in
which the send is still busy while the dock has gone.

### AC3 修复 — one reading, one answer

`sample()` and `sampleBurst()` now take the submit's label **only off a drawn composer** (the form
`form[data-slot="prompt-input"]` is present): `stop` requires `composerDrawn && no send-labelled
button`. The composer's presence rides on the sample (`composer: 'drawn' | 'absent'`) and is logged
(`consistency.composerAbsent.<tier>`). Nothing else changed: no window widened, no sleep added, no
assertion relaxed, no probe rhythm touched, and the invariant is untouched — after the turn ends,
on a drawn composer, the dock is `absent` ⟺ the submit is back to `input.send` ⟺ the sidebar is not
counting the session (the healthy readings above and AC4's runs).

Falsification the other way: re-applying the *same* HMR trigger with the fix in place
(`/tmp/ac188-fix-hmr.log`) still tears the workspace down —

```
[e2e] page console error: The above error occurred in the <ProjectWorkspaceRouteContent> component: …
consistency.composerAbsent.desktop=live:24/24 settled:8/8
consistency.composerAbsent.mobile =live:24/24 settled:8/8
  1 passed (17.3s) … EXIT=0
```

— but the torn page now reads `{dock:'absent', sidebar:false, send:'send', composer:'absent'}` and
the run **passes**, with the teardown **visible** in the log instead of misread as three surfaces
disagreeing. Honest trade-off, stated: a page-wide teardown in the window now reads as agreement,
because there are no surfaces left to disagree; it is visible in `consistency.composerAbsent` but is
not asserted on (a host/harness condition is not a defect of the three surfaces). The durable root
fix — making the app survive an HMR update that swaps the module owning `WebSocketContext` (or
isolating the gate's evaluation root so sibling edits never reach it) — is outside this task's
declared `## Touches`; filed here for a follow-up.

### AC4 判据绿

`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"`, 8 consecutive runs at
synthetic load (80 CPU loops; `load1` recorded at each run start) — `dock.wall` per run:

| run | exit | `load1` at start | `dock.wall` |
|----:|-----:|-----------------:|------------:|
| 1 | 0 | 82.72 | 17789 ms |
| 2 | 0 | 89.18 | 17872 ms |
| 3 | 0 | 91.35 | 17755 ms |
| 4 | 0 | 92.37 | 17899 ms |
| 5 | 0 | 95.81 | 17704 ms |
| 6 | 0 | 97.80 | 17803 ms |
| 7 | 0 | 96.86 | 17770 ms |
| 8 | 0 | 96.64 | 17787 ms |

**8/8 consecutive exit 0**; `load1` 82.72–97.80 (all ≥ 80 — the AC asks for ≥ 3); `dock.wall`
17704–17899 ms, every one ≤ 25 000. The driver is single-instance (`flock -n`), holds 80 synthetic
CPU loops (`yes > /dev/null`) for the whole batch and records `load1` from `/proc/loadavg` at each
run's start; log `/tmp/ac188-ac4b.log`. Post-`develop`-merge the same command re-ran green on the
final tree (`/tmp/ac188-postmerge.log`, EXIT=0, `dock.wall=17439ms`).

### AC5/AC6/AC7 假形态

Each false form was applied to the **worktree** source, run with the same command, observed, and
reverted with `git checkout -- <file>` (`git status --porcelain` empty afterwards — only the spec
remains modified).

**AC5 — the legacy surface is still excluded.** Re-mounted the old tab class on
`ActivityIndicator`'s root:

```
dock.count.desktop=1 legacy.tab=1 legacy.inline=0 resident.activityMarkers=[]
Error: desktop: the old tab class and the inline slot must not match anything
> 1809 |       ).toEqual([]);
  1 failed … EXIT=1
```

`legacy.tab=1` — the criterion's exclusion of the legacy surface still bites. Restored.

**AC6 — a sidebar on the one-second poll is still caught.** `RunningView` was made to read the
busy set *one poll beat late* (a 1000 ms-delayed copy of the page's busy set — the shape the view
had when it read the `GET /api/session-hosts` poll directly, which clears only at its next tick):

```
consistency.afterTurnLive.desktop=[{"dock":"in-turn",…},×4,
  {"dock":"absent","sidebar":true,"send":"send"},×14,  ← the dock left; the sidebar still says busy
  {"dock":"absent","sidebar":false,"send":"send"},×5]
Error: desktop: no live reading may show the dock leave the turn while the sidebar or the send
       button still says busy
> 1851 |       ).toEqual([]);
  1 failed … EXIT=1
```

The lag is deterministic (a beat-behind copy, not a tick-phase race): the dock reads `absent` while
the sidebar still counts the session for 14 consecutive live samples. Restored.

**AC7 — a send whose busy clears after the dock's is still caught (this defect).** `ChatComposer`
held the submit's stop label 400 ms past the turn's (`laggedLoading`, used only at the
`: isLoading ?` branch of `submitAriaLabel`):

```
consistency.afterTurnLive.desktop=[{"dock":"in-turn",…},×4,
  {"dock":"absent","sidebar":false,"send":"stop"},×4,  ← the send still says stop; the dock is gone
  {"dock":"absent","sidebar":false,"send":"send"},×20]
Error: desktop: no live reading may show the dock leave the turn while the sidebar or the send
       button still says busy
> 1851 |       ).toEqual([]);
  1 failed … EXIT=1
```

The send stays `stop` after the dock has left — the exact asymmetry this case exists to catch. It
reds in the **live** window (the settled `afterTurn` window opens ~0.6 s after the dock departs, so
the beat-long lag has already cleared there) — which is why that window exists (spec comment at
lines 1838–1844). Restored.

Baseline for contrast: the same command on the unmutated worktree with the fix in place
(`/tmp/ac188-fix-healthy1.log`) is 1 passed / EXIT=0, its live window reading
`{"dock":"in-turn",…}×4 → {"dock":"absent","sidebar":false,"send":"send"}×20` — the send clears
first, the dock last, and the two never disagree.

### AC8 预算与实质读数不动

The task's change is confined to `e2e/activity-dock-truthful.spec.ts` (+70 / −9) and touches no
invariant: `SINGLE_SPEC_CEILING_MS` (55_000, in `playwright.config.ts`) and the gate's 60s kill are
untouched; `LIVE_WINDOW_SAMPLES` (24) and `LIVE_WINDOW_PERIOD_MS` (55) are unchanged; no sleep was
added and no assertion relaxed. The two `disagreements` filters
(`!inTurn(s.dock) && (s.sidebar || s.send === 'stop')`) and every substantive assertion
(`docks`/`legacy`/`residentActivityMarkers`/panel/`turn`/`settled`) are byte-identical. What changed
is the *reading of `send`*: `stop` is now read only off a drawn composer — the sanctioned
measurement-artifact fix (AC8's 「仅当读数为测量伪影时可改读法」), whose artifact-ness AC1/AC2 prove
(`send:'stop'` ⟹ non-null activity ⟹ the dock can never read `absent`, so `{dock:'absent',
send:'stop'}` is unreachable while the composer is drawn).

### AC9 静态闸

```
npx oxlint src/                     → exit 0
npx tsc --noEmit -p tsconfig.json   → exit 0
```

Both exit 0 (oxlint emits pre-existing warnings only, no error). Note honestly: the changed file
lives under `e2e/`, which the repo's `typecheck` (`tsconfig.json` + `server/` + `scripts/`) and
`lint` (`src/ server/ scripts/ shared/`) scopes do **not** include — the spec is outside every
static gate by design (Playwright transpiles it); the two gate commands named by the AC are run
as-is and exit 0, and the spec compiles and runs green.

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
## Needs-Human

**执行 2026-10-09T17:26:10.933Z — 停派终止（失败无法归因，⛔ 不再重派）**

- 阻碍原因：exited-not-landed 失败无法归因（基建/契约疑似，非实现缺陷）——停止重派，⛔ 不再拿新会话撞同一堵墙：suite red could not be attributed to any failing test file in 2 consecutive rounds (bounded to at most one retry) — infra/contract suspected, not an implementable defect (parser extracted 0 of 1 failing lines and attributed none to a file; pseudo-stage tokens: suite-watchdog); stopping instead of spending another worker session
- 失败步/判词：step=suite: not ok - suite-watchdog: terminated by an external signal before the suite finished — see the report above
- run_id：wk-prod-anchor
- session_id：54e374e0-ffc6-4ae9-84f3-1f5b733ac38e
- suite 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-suite-gap-ac188-composer-stop-outlives-dock-idle~wk-prod-anchor~1791566724028-4c534f.log
- fan-in 日志：/data/home/yale/work/claudecodeui/.quay/fan-in-gap-ac188-composer-stop-outlives-dock-idle-wk-prod-anchor.log
