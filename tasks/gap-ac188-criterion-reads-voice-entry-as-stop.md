---
id: gap-ac188-criterion-reads-voice-entry-as-stop
title: AC-188 判据在 Live Voice 入口并入提交键后把空闲读成 stop：空闲时提交键 aria-label 是 Start Live
  Voice 而非 Send，回合结束后一致性读数恒红
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
## Proposal

**现象（本轮直接重跑；HEAD `36b775dc`，tree `1685d1dd`，起始 load1 51.54）**

```
bash scripts/with-memory-cap.sh npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"
```

**exit 1**（1/1，用时 33.7s）。逐字读数：

```
consistency.turn.desktop={"dock":"in-turn","sidebar":true,"send":"stop","composer":"drawn"}
consistency.turn.mobile ={"dock":"in-turn","sidebar":true,"send":"stop","composer":"drawn"}
consistency.afterTurnLive.desktop=[{"dock":"in-turn","sidebar":false,"send":"stop","composer":"drawn"} ×4,
                                   {"dock":"absent","sidebar":false,"send":"stop","composer":"drawn"} ×20]
consistency.afterTurnLive.mobile = 同形
consistency.afterTurn.desktop=[{"dock":"absent","sidebar":false,"send":"stop","composer":"drawn"} ×8]
consistency.composerAbsent.desktop=live:0/24 settled:0/8
consistency.composerAbsent.mobile =live:0/24 settled:0/8
ac188.step sampled @17558ms

  Error: desktop: no reading may show the dock idle while the sidebar or the send button still says busy
    at /data/home/yale/work/claudecodeui/e2e/activity-dock-truthful.spec.ts:1836:9
  1 failed
    e2e/activity-dock-truthful.spec.ts:1508:3 › activity dock consolidation › AC-188 one dock, no legacy surface, and one answer across the dock, the sidebar and the send button
```

同一读数的其它面全对：`dock.count.desktop=1`、`dock.count.mobile=1`、`legacy.tab=0`、`legacy.inline=0`、`resident.activityMarkers=[]`、面板控件 start/close/copy/address/pid 各 1。失败只落在 `send` 这一位，且 composer 全程 `drawn`——**不是** 2026-10-09 那次「HMR 把 `ProjectWorkspaceRouteContent` 整棵拆掉、composer absent」的形态（见已 done 的 `gap-ac188-composer-stop-outlives-dock-idle`）。

**根因（已用失败现场固定）**

`sample()`（`e2e/activity-dock-truthful.spec.ts:1338-1340`）与 `sampleBurst()` 的页内 `read()`（`:1397-1407`）把「找不到 `form[data-slot="prompt-input"] button[aria-label="<input.send 文案>"]`」直接读成 `send:'stop'`。这个等价只在「提交键的可访问名要么是 Send、要么是 Stop」时成立。

`6ddb14b9d`（`feat(chat): merge Live Voice entry into the submit button`，2026-10-19T11:35:35+08:00）把 Live Voice 入口并进了同一个提交键：空草稿且空闲时 `submitIsVoice` 为真，`submitAriaLabel` 变成 `voice.realtime.enter`（en: `Start Live Voice`），同一个 `type="submit"` 控件带 `data-testid="live-voice-button"`（`src/modules/chat/composer/ChatComposer.tsx:566-578` 的 label 选择、`:1103` 的 `aria-label={submitAriaLabel}`）。于是回合结束后提交键仍在、且已回到空闲语义，但页面上没有 `aria-label="Send"` 的按钮，判据把它读成 `stop`——一头写死「坞说空闲」，另一头把空闲误读成忙。

失败现场 trace 逐字（`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-N2X7HO/test-results/activity-dock-truthful-act-513f9-sidebar-and-the-send-button/trace.zip` 内 `9-trace.trace`）：

```
{"type":"submit","aria-label":"Start Live Voice","title":"Start Live Voice","data-testid":"live-voice-button"}
```

时间线吻合：门账本 `.quay/gate-events.jsonl` 里 AC-188 最后一条 `pass` 是 2026-10-19T01:46:53Z（09:46+08），`6ddb14b9d` 落在同日 11:35+08 之后；此后账本只有 2026-10-21T06:04:02Z 与 06:04:42Z 两条 `fail`，tree 都是 `53d10964`。

上一件修复 `gap-ac188-composer-stop-outlives-dock-idle`（done）当时论证过「drawn composer 上 `send:'stop'` ⇒ `isLoading` ⇒ `sessionActivity ≠ null` ⇒ 坞不可能是 `absent`」。该论证的第二步依赖「提交键只在 send/stop 两个文案之间切换」；Live Voice 并入提交键后，drawn 的空闲提交键可以不出现 Send 文案，论证失效。

**为什么这不是放宽不变量**

要保的保证不变：回合结束后坞 `absent` 时侧栏不得说忙、提交键不得处于 stop 态；回合开着时提交键必须是 stop 态。改的只是读数方式——从「Send 文案缺席 ⇒ stop」换成「读同一个提交控件自身的 `aria-label` 再分类」：

- stop 集合：`input.stop`（`Stop`）、`resident.stopResident`；
- idle 集合：`input.send`（`Send`）、`voice.realtime.enter`（`Start Live Voice`，仅空草稿空闲时替代 Send）；
- 其它任何可访问名读作 `other`，三类断言（turn 期要 `stop`、settled 要 `send`）都会红——不认识的新文案不会被默认为空闲。

`composer: 'drawn' | 'absent'` 的旁路读数保留（整页拆掉仍不冒充分歧）。

**本轮要做的事**

1. 在 `sample()` 与 `sampleBurst()` 的读数里改为取提交控件（`FORM` 内唯一的 `button[type="submit"]`，并以 `input.send`/`input.stop`/`resident.stopResident`/`voice.realtime.enter` 四个 locale 文案做分类集合）的 `aria-label`；页内 `sampleBurst` 需把 stop/idle 集合传进去。保留 `composer` 读数与既有注释的事实，重写「Send 缺席即 stop」的错误论证。
2. 直接重跑判据证明绿（≥5 次连续 exit 0，逐次记起始 load1 与 `dock.wall`）。
3. 重跑三条取假形态仍红（见 AC6），其中第三条专门证明新读数不会把真正的「提交键仍 stop」读成空闲。

范围边界：只动 `e2e/activity-dock-truthful.spec.ts`；若用例体预算被顶破，只允许在 `playwright.config.ts` 的 `SPEC_BUDGET_MS` 里按实测申报（不得改 `SINGLE_SPEC_CEILING_MS` 语义，也不得放宽用例自带的 `25_000` 断言）。不碰生产代码，不改 AC 的 `criterion:` 命令。

<!-- dedup-ref -->
去重：`grep -lE '^goal_ac: *"?AC-188"?' tasks/*.md` 命中的六条全部 `done`（`gap-activity-single-dock-global-consistency`、`gap-ac188-criterion-body-budget-below-its-turn-walk-floor`、`gap-ac188-criterion-agreement-loses-poll-source-falsifiability`、`gap-ac188-case-budget-red-is-postturn-renavigation-tail`、`gap-ac188-case-bootstrap-collision-and-gate-kill`、`gap-ac188-composer-stop-outlives-dock-idle`），无在办重复；没有一条处理 Live Voice 并入提交键之后的文案读数。`task-granularity-advice --touches e2e/activity-dock-truthful.spec.ts --json` 返回 `peers: []` / `mentions: []`（该文件 13 件已落地任务、中位改动 298 行、中位执行轮次 2），判为 separate。

## AC

- [ ] AC1（复现，逐字）在立案树上运行 `bash scripts/with-memory-cap.sh npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"`，捕获 **exit 1**，并逐字贴出回合结束后 `{"dock":"absent","sidebar":false,"send":"stop","composer":"drawn"}` ×8、`e2e/activity-dock-truthful.spec.ts:1836` 的失败行、该次起始 load1 与 `dock.wall`。
- [ ] AC2（根因读数）从失败现场 trace 或页面 DOM 取到提交控件逐字为 `aria-label="Start Live Voice"` + `data-testid="live-voice-button"`，并贴 `git log -1 --format='%H %cI %s' 6ddb14b9d`，证明其提交时间晚于门账本 AC-188 最后一条 `pass`（2026-10-19T01:46:53Z）。
- [ ] AC3（读数改造，可 grep）`sample()` 与 `sampleBurst()` 的 `read()` 都改为读提交控件自身的 `aria-label` 并按 stop/idle 两个集合分类，其它读作 `other`；`grep -n "send:" e2e/activity-dock-truthful.spec.ts` 的输出证明不再有「`submit.count() === 0` / `document.querySelector(submitSelector) === null` ⇒ stop」的表达式；`git diff` 证明断言方向、窗口长度/节奏、`25_000` 预算与其它实质读数未改。
- [ ] AC4（判据绿，真实浏览器与服务端）`npx playwright test e2e/activity-dock-truthful.spec.ts -g "AC-188"` **连续 ≥5 次 exit 0**，逐次记录起始 load1 与 `dock.wall`，并贴一次完整读数（`dock.count.*`、`legacy.*`、`resident.activityMarkers`、`consistency.turn.*`、`consistency.afterTurnLive.*`、`consistency.afterTurn.*`）；调用一律包 `bash scripts/with-memory-cap.sh`。
- [ ] AC5（正控制，非真空）同一次绿的读数里必须出现「idle 集合文案被读成 `send`」的现场证据（例如回合结束后的提交键为 `Start Live Voice` 或 `Send`）；整段窗口只读到 `stop`/`other` 不算通过。
- [ ] AC6（三条假形态仍红，各自还原）(i) 挂回旧 `ActivityIndicator` 的 `.chat-activity-tab` 与 `data-slot="chat-activity-inline"` ⇒ `legacy` 计数读数必须红；(ii) 让 `src/modules/sidebar/RunningView.tsx` 改读 1 秒 `/api/session-hosts` 轮询的 busy ⇒ live 窗口一致性必须红；(iii) 让提交键在坞回到空闲后仍保持 stop 文案到窗口结束（例如临时把 `isLoading` 的清除滞后）⇒ `afterTurn`/`afterTurnLive` 的 `disagreements` 必须红。逐条贴失败断言，`git checkout -- <file>` 还原后 `git status --short` 对生产文件为 clean。
- [ ] AC7（静态闸）`npm run typecheck` exit 0；`npx oxlint e2e/activity-dock-truthful.spec.ts` exit 0（若 oxlint 不覆盖 `e2e/`，贴出该事实并用 `npm run lint` 的实际覆盖范围与 typecheck 结果说明）。
- [ ] AC8（边界）`git diff --stat` 只落在 `## Touches` 列出的文件上；`SINGLE_SPEC_CEILING_MS`、AC-188 的 `criterion:` 命令、`25_000` 用例体预算均未改。

## DoD

- 判据命令与 `-g "AC-188"` 的选择不变；绿来自真实 `playwright test` 起的 server + Vite + 调试 agent `unattended-turn`/`turn-end` 回合，不是 mock、不是页内替身。
- 读数改造**不是放宽**：断言方向与窗口不变；`stop` 只由 stop 文案成立、`send` 只由 idle 文案成立，未知文案读 `other` 并使 turn/settled 断言红（在 `## Evidence` 写明落点）。
- 三条假形态都实跑出红并已还原，尤其 (iii) 证明新读数仍能发现「坞已空闲而提交键仍 stop」。
- ≥5 次连续绿的逐次起始 load1 与 `dock.wall` 读数进记录。
- 无（待外部）AC：每条都能由执行者在工作树上亲手做出。

## Touches

- `e2e/activity-dock-truthful.spec.ts`（AC-188 的 AC2–AC6 读数：提交键按可访问名分类）
- `tasks/gap-ac188-criterion-reads-voice-entry-as-stop.md`（自触：本任务状态翻转的记录）
