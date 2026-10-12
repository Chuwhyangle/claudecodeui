---
id: gap-live-voice-scripted-scenarios-interrupt-covered-regression
title: 既有回归：voice-realtime-scripted-scenarios.spec.ts:673 的 scripted interrupt
  用例被 A+ 中断栅栏判为 covered 而等不到 stopped 帧——按栅栏语义修正用例（先有新话语再中断），不改产品代码
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 问题（2026-10-12 实测）

`e2e/voice-realtime-scripted-scenarios.spec.ts` 的 `a scripted interrupt reaches the session and the page reports the backlog it left`（约 :673）在干净 develop 上确定性红（3/3）：`voice-realtime-stopped` 20 s 内未出现。证据：`gap-live-voice-segmented-replay-20261012` Notes 的 AC4 段（worker 以 `git stash -u` 回到干净树复现）。

原因：A+ 栅栏（`gap-live-voice-interrupt-run-utterance-fence`，AC-343，已 done）落地后，`voice-realtime-ws-proxy.service.ts` 的 `decideModelInterrupt`（约 :699）在 `max(covers) >= triggerSeq` 或同一 triggerSeq 已执行时返回 `covered`，不发 `stopped` 帧。该用例只发了 `session_send('start the held turn')` 再直接 `session_interrupt`，中间没有任何新的用户话语（无 `transcription.completed`），触发句就是当前 run 已覆盖的那句 ⇒ 被正确判为 covered。用例的前提（「模型无新话语也会中断」）已被 D-7 栅栏语义推翻。

该 spec 被多处回归点名（`gap-live-voice-intent-control-browser-e2e` AC4、`gap-live-voice-segment-honest-heard-unrecognized-state` AC8、`gap-live-voice-segmented-replay-closure` AC5），不修会一直挡住它们。

### 要做的事

- 按栅栏语义修正用例：在 `session_interrupt` 前由假上游发一条新的最终转写（新 itemId，模拟用户说出「停下/改方向」的话语），使 `triggerSeq` 大于当前 run 的 covers，再断言 `stopped` 帧与 tool output。
- 另加一个用例钉住栅栏的负面：无新话语的重复中断 ⇒ 无 `stopped` 帧、tool output 为 `{stopped:false, reason:'covered'}`。

### SCOPE BOUNDARY

- ⛔ 不改产品代码（`voice-realtime-ws-proxy.service.ts` 归 GOAL-041 A+ 任务）；⛔ 不放宽栅栏。
- 不改共享测试桩（`e2e/voiceRealtimeScriptedUpstream.ts`、`voice-realtime-scripted-upstream.ts`），只改本 spec。

## Plan

1. 本地复现红；2. 修正用例；3. 加 covered 负面用例；4. 单跑 spec 两次。

## AC

- [x] AC1（取假形态排最前）：去掉新增的那条转写 ⇒ 修正后的用例红（逐字失败行记入 Notes），证明它依赖栅栏放行条件。
- [x] AC2：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-scripted-scenarios.spec.ts --workers=1` 退出 0，连续两次一致。
- [x] AC3：covered 负面用例：无新话语的中断 ⇒ 无 `voice-realtime-stopped`，tool output 含 `covered`。
- [x] AC4：`npm run typecheck`、`npm run lint` 退出 0。

## DoD

在任务工作树里修复前后各跑一次该 spec，逐用例结果与失败行写入 Notes；零云调用。

## Touches

- e2e/voice-realtime-scripted-scenarios.spec.ts
- tasks/gap-live-voice-scripted-scenarios-interrupt-covered-regression.md

## Notes

### ⚠️ 立项诊断被实测推翻（Proposal 保留为历史记录）

Proposal 说该用例「被 A+ 栅栏判为 covered」。**实测不成立**：栅栏根本没被走到。

复现红后，用代理日志（`<QUAY_E2E_DATA_DIR>/voice-realtime-log/<connectionId>.jsonl`）读到的是：

```
to-browser error TOOL_ARGUMENT_SCHEMA_VIOLATION (recoverable): The model called session_interrupt with arguments that do not match its schema (intent: Invalid input: expected string, received undefined).
```

旧用例发的是 `functionCall('session_interrupt', {}, 'interrupt-stop')` —— voice 面 `session_interrupt` 的 `intent` 是**必填**（SPEC §6.2：停下是一个判断，模型对「用户想要什么」的理解必须在案）。空参在**参数 schema 就被拒**，压根没进 stop 路径 ⇒ 没有 `stopped` 帧、没有 tool result。同一日志在修好后才出现 `session_interrupt: covered (no abort) backlog=0`（见 AC1 假形态），确认 `covered` 不是旧红的原因。

另：`buildVoiceRealtimeSeams`（`server/index.ts`）**没有**接 `hostCommandLifecycle`，浏览器 e2e 里 `coveredSeqs` 恒为空 ⇒ COVERED 那半（`max(coveredSeqs) >= triggerSeq`）不可达；可达的只有 IDEMPOTENT 那半（`abortedTriggerSeq === triggerSeq`）。因此本任务把 AC1 要求的「依赖栅栏放行条件」钉在幂等这半：先停一次（置 `abortedTriggerSeq`），**中间必须有一条新话语**把 `triggerSeq` 抬起来，第二次停才会被放行。

### 改动（仅 `e2e/voice-realtime-scripted-scenarios.spec.ts`，+166/−7）

- `session_interrupt` 补上必填 `intent`（连同 `heard`），并断言 tool receipt 的 `triggerSeq`。
- 新增 `hearUtterance()`：发一条 `captionCompleted` 并**等到 bar 真的渲染出这些词**才返回 —— 这是排序屏障而非 sleep（代理把 final transcription 在同一个同步块里既发 `caption` 又 `utteranceSeq += 1`，所以「页面已在渲染这些词」即「计数已发生」）。每个话语必须用**新 itemId**：页面按 itemId 归档 caption，复用同一个 id 是替换而不是新话语。
- 新增 `stoppedFrames` 记录器（`framereceived` 里按 `type === 'stopped'` 解码计数）。**为什么要读线上而不是 DOM**：bar 把 `stopped` 渲染成**一个**只换标签、不换位置的节点，两次停只留一个 `voice-realtime-stopped`；栅栏的可观测效果就是「有一个 `stopped` 帧 / 没有」，那是帧计数。
- AC7 用例（现 :741）：第一次停 → 断言 `voice-realtime-stopped` 可见 + `/still queued/` + receipt `triggerSeq === 1`、`reason` undefined + 帧数 +1；再 `hearUtterance` 出新话语 → 第二次停 → 帧数 +2、receipt `triggerSeq === 2`。
- 新增 AC3 用例（现 :814）：同一调用连发两次、中间无新话语 ⇒ receipt `{stopped:false, reason:'covered', triggerSeq:1}`，且**不再多一个 `stopped` 帧**。

未改产品代码、未改共享测试桩，未放宽栅栏：`git diff --stat develop...HEAD -- server/ src/ shared/ scripts/` 为空。

### AC1 假形态（逐字）

去掉「第二次停之前的那条新话语」后重跑该用例，exit 1：

```
Error: expect(received).toBe(expected) // Object.is equality
Expected: 2
Received: 1
Call Log:
- Timeout 20000ms exceeded while waiting on the predicate
   790 |       ),
   791 |     );
>  792 |     await expect.poll(() => stoppedFrames.length, { timeout: 20_000 }).toBe(stoppedBefore + 2);
```

同次运行的代理日志出现 `session_interrupt: covered (no abort) backlog=0` —— 正是栅栏把第二次停判成 debounce。这条读数在 `543d3cb4` 上取得；合并 develop 后 `voice-realtime-ws-proxy.service.ts` 的差异**只有注释行**（`git diff 543d3cb4..HEAD -- <file>` 过滤后为空），行为未变，故结论原样成立。

### AC3 的读数口径（如实记录）

AC3 字面写「无 `voice-realtime-stopped`」。**第一次停的节点是合法留在屏上的**（bar 那个节点只换标签、不换位置），所以可判定的是「**没有多出** `stopped` 帧」，不是「屏幕上没有这个 testid」。用例按帧计数断言（`stoppedFrames.length` 停在 `stoppedBefore + 1`），并在断言前 `waitForTimeout(2_000)` 作为 settle 边界 —— covered 路径在任何 `send` **之前**就返回了，而此 socket 上任何更晚的帧都必须排在上游已持有的那个 tool result 之后。

### 修复前红（DoD：修复前跑一次）

`-g "a scripted interrupt reaches the session"`，exit 1，失败在第 690 行：

```
Error: expect(locator).toBeVisible() failed
Locator: getByTestId('voice-realtime-stopped')
Expected: visible / Timeout: 20000ms / Error: element(s) not found
```

页面快照显示 run 仍在 `Working… 15s`、状态 `listening … Busy 00:24 · 0 bytes waiting`。

### 修复后（DoD：修复后跑一次；AC2）

合并 develop 后（`a340a84c`）连跑两次，**各自 exit 0、`11 passed (1.5m)`**，两次一致。11 个用例含新增 :741 与 :814。逐用例：:514 通过，:568 通过，:610 通过，:662 通过，:703 通过，:741 通过，:814 通过，:867 通过，:913 通过，:951 通过，:1016 通过。

代理日志（修复后）：AC7 两条 `session_interrupt: aborted=false backlog=0`；AC3 先 `aborted=false backlog=0`、后 `covered (no abort) backlog=0`。

**零云调用**：`DASHSCOPE_API_KEY=` 置空运行；spec 首个用例本身即断言 voice 路径不出 loopback（`nonLoopbackWebSockets` 为空）。

### AC4

`npm run typecheck` exit 0；`npm run lint` exit 0（仅既有 warning，无一在本任务改动的文件里）。

### 环境

工作树 `/data/home/yale/work/claudecodeui-worktrees/gap-live-voice-scripted-scenarios-interrupt-covered-regression`，分支 `task/gap-live-voice-scripted-scenarios-interrupt-covered-regression`，实现提交 `800ee2da`，合并 develop 提交 `a340a84c`。工作树干净（无 e2e 残留）。
