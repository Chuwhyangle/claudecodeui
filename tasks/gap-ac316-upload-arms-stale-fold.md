---
id: gap-ac316-upload-arms-stale-fold
title: AC-316 判据腿一红：上传夹具里 AC-326 双腿仍钉「折叠成一行」，与已落地的逐句行模型相悖
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-316
---
## Proposal

### 现象（2026-10-13 直接复跑当前 HEAD 树，不是台账继承）

AC-316 判据的第一条命令直接红：

```
bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts
```

读数 `7 passed / 1 failed / 3 did not run`，EXIT=1。唯一失败是 `e2e/voice-realtime-upload-fixture.spec.ts:1265`（AC-326 那条腿「three transcriptions of one thought are ONE row …」），台账 `counts=[0,3,3,3,...,3,1,1,1,1,1,1,1,1]`，交付前的样本文本是 `alfa bravo charlie`（`ROW_HEARD[0]`）：

- `:1319` `expect.soft(provisional.length).toBeGreaterThan(0)` —— 实测 0（整条手势期间没有任何一次读到「恰好一行」）；
- `:1337` `expect.soft(Math.max(...counts)).toBeLessThanOrEqual(1)` —— 实测 3。

即同一手势期间屏上是 **3 行** user 行、交付后塌回 1 行——正是该腿禁掉的 `3→1` 塌缩。另两条命令我单独复跑为绿：protocol-sim 腿 EXIT=0，`e2e/voice-trim.spec.ts -g "AC-120"` `1 passed` EXIT=0。

### 机制（上一轮修复为什么没兜住）

- `gap-ac316-restore-criterion-two-regressions`（done，`goal_ac: AC-316`，提交 d526a5ff）修的是同一份 e2e 的 `FakeAudioContext` 与 `useVoiceRealtimeSession.ts` 的 `carried` 回退，**没有碰** AC-326 那条腿的行模型。
- 8a87620b（`gap-live-voice-segment-honest-heard-unrecognized-state`，done，`goal_ac: AC-355`，人 yale 2026-10-12 授权）把生产放置换成 `heardUtteranceRows`（`src/modules/chat/voice-realtime/placeCaptions.ts:235`，**每条 caption 一行**，键 `voice-caption-${caption.itemId}`）。唯一入口 `voiceTranscriptRows`（`:661`，`:678` 调它）此后只走逐句模型；`foldCaptionsIntoTranscriptRow`（`:153`）**再无生产调用点**，其 doc（`:200-233`）写明为什么改。
- AC-355 任务的回归范围（其 AC8）只覆盖 `voiceStopVsExit.test.tsx`、`src/modules/chat/voice-realtime/tests/`、`e2e/voice-realtime-scripted-scenarios.spec.ts`，**不含** `e2e/voice-realtime-upload-fixture.spec.ts` ⇒ AC-326 的臂在模型换代时无人看管。
- AC-326 的**单位臂**同样已空过：`src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts` 只 import 并断言 `foldCaptionsIntoTranscriptRow` —— 那个已无生产调用点的函数。文件是绿的，但它钉的行为已不在生产路径上。

### 冲突与方向

AC-326 的 expect (a)「交付前恰好 1 行」与 (c)「计数从不超过 1」和 AC-355 已落地的逐句模型直接冲突；两者都是人 yale 裁定（AC-326 2026-10-11，AC-355 2026-10-12，更晚）。本任务采取的方向：**以已落地的生产模型为准，把 AC-326 的两条臂改成断言这个模型**——回退生产会同时红掉 AC-355 的 replay 判据与 `voiceSegmentHonestState.test.tsx`，改臂是唯一不牵动生产回归的解。保留 AC-326 仍然为真的那两半：交付就地定型为一条真实消息、三段原文都不留成独立 user 行；空转写不产生行。

⚠️ 若执行者在当前树上复核后认定「一次语音一行」**仍是**本仓意图（例如找到晚于 8a87620b 的裁定），**不得静默弱化**这条腿：应在 Notes 写明读数并停派（needs-human）等裁定，而不是把它改绿。

<!-- dedup-ref -->
与 `gap-live-voice-segment-lost-uncertain-honest-state`（todo）是**并行**关系：它改 `placeCaptions.ts` 的逐段 lost/uncertain 状态；本任务**不改生产代码**（`foldCaptionsIntoTranscriptRow` 保留原样，只把它的判据改锚），故两者 Touches 不重叠。

### 取假形态

把入口 `voiceTranscriptRows` 的放置临时回退到 `foldCaptionsIntoTranscriptRow`（一次实验，随后复原、不落 diff）⇒ 改写后的单位臂与 e2e 腿必须变红；复原后绿。以此证明新断言钉的是当前模型，而不是又一轮空过。

## AC

- [x] AC1：`bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts` 退出 0（AC-316 判据第一条命令）；`e2e/voice-realtime-upload-fixture.spec.ts` 内 8 条腿全绿或全为显式 skip，不再有 `did not run` 之外的失败。
- [x] AC2：`:1265` 那条腿改后仍断言、且只剩仍为真的那几半——一段语音的 N 条转写各成一行 `voice-caption-*`（`heard`）按 seq 排列；交付**就地**吸收为一条真实消息，三段原文都不留成独立 user 行；空转写不产生行。
- [x] AC3：`npx vitest run src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts` 退出 0，且该文件改成断言生产入口 `voiceTranscriptRows` 的逐句行（不再只断言没有调用点的 `foldCaptionsIntoTranscriptRow`）。
- [x] AC4：取假形态——把 `voiceTranscriptRows` 的放置临时回退到 `foldCaptionsIntoTranscriptRow` 后，AC2 的腿与 AC3 的文件变红；复原后绿。两次读数贴进 Notes。
- [x] AC5：AC-355 侧不被回退：`npx vitest run src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx` 退出 0；`npm run typecheck`、`npm run lint` 各退出 0。
- [x] AC6：AC-316 判据另两条命令各退出 0——`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`；`npx playwright test e2e/voice-trim.spec.ts -g "AC-120"`。

## DoD

在**当前 HEAD 的树**上用真实 e2e 夹具（`FakeAudioContext` + 假上游）驱动一次注入手势：上传夹具、三段时间转写先后到达时屏上是三行 `voice-caption-*`（`heard`），交付后只剩一条带 `voice-transcript-badge` 的真实行、三段原文各自作为 user 行的计数为 0；截图与台账读数写入 Notes。AC-316 判据三条命令在同一棵树上全绿（贴出各命令的 exit code 与末行）。单位臂在入口回退到旧折叠时红、复原后绿，两次读数都贴出。运行遵守 8G cgroup：Playwright 单文件经 `bash scripts/with-memory-cap.sh` 跑，不跑无界的 `--test` 扇出。

## Touches

- e2e/voice-realtime-upload-fixture.spec.ts
- src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts
- tasks/gap-ac316-upload-arms-stale-fold.md

## Notes

立案：gap-filing 轮次，2026-10-13。AC-316 已离开 reverify 范围（GOAL-033 `achieved`、`longTerm: false`），本轮的「红」来自**直接复跑判据**，不是台账尾巴。

若执行者顺带删除已无生产调用点的 `foldCaptionsIntoTranscriptRow` 及其 barrel 导出，需把 `src/modules/chat/voice-realtime/placeCaptions.ts`、`src/modules/chat/voice-realtime/index.ts` 补进 Touches，并知会正在改同一文件的 `gap-live-voice-segment-lost-uncertain-honest-state`。

AC-326 记录本身（`goals/AC-326…` 的 expect (a)/(c)）随之失效，应由 AC-326 自己的 driver 收口；本任务只改臂、不改任何 AC 记录。

### 执行记录（2026-10-13，worker，提交 6f8f89c4，分支 `task/gap-ac316-upload-arms-stale-fold`）

复核：当前 HEAD 树上「一次语音一行」**不是**本仓意图——8a87620b（AC-355，人 yale 2026-10-12 授权，晚于 AC-326 的 2026-10-11）已把生产放置换成 `heardUtteranceRows`；未找到晚于它的反向裁定。故按 Proposal 方向改锚 AC-326 的两条臂，**不改生产代码**。

做法：e2e `:1272` 那条腿改为「整条手势期间采样绑定本手势的行，出现 N 行各自 `heard`、按 seq 排列的读数即为凭据」，随后断言就地定型为一条真实消息、三段原文各自 0 行、空转写 0 行；`voiceSingleTranscriptRow.test.ts` 改为断言入口 `voiceTranscriptRows` 的逐句行（新增 `describe('voiceTranscriptRows — …')` 5 例），保留 `foldCaptionsIntoTranscriptRow` 的 join 规则块并标注「已无生产调用点」。附带的非行为改动：腿内每轮采样的 ledger 现在随运行打印（`[e2e] AC-326 rows: …`），与本文件其它读数一致。

各判据读数（同一棵提交树 6f8f89c4）：

- **AC1**：`bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts` → 末行 `11 passed (1.4m)`，EXIT=0。upload-fixture 内 8 条腿全绿，无 `did not run`。
- **AC2**：`:1272` 腿（标题 `each utterance of one thought is its own \`heard\` row, and the delivery finalises ONE real message in place, and a wordless transcription makes none`）在 AC1 内绿（9.1s）。其 ledger（一次带截图的运行）：`heard=[3,3,…,3,2,2,…,2,0,0,…,0]`，`rows=[] , [三条 heard 行]×45 , [三条 heard 行、第三条转 `Tidying up…`（delivering）]×… , [单条真实行 "send the summary of the release notes to the team channel / From voice transcript"]×8`。即：屏上先后是「空 → 三行逐句 `heard` → 第三行转 delivering → 塌定为一条真实行」，无 `3→1` 折叠行。
- **AC3**：`npx vitest run src/modules/chat/voice-realtime/tests/voiceSingleTranscriptRow.test.ts` → `Test Files 1 passed (1) / Tests 14 passed (14)`，EXIT=0。
- **AC4（取假形态）**：把 `placeCaptions.ts` 的放置临时改回 `foldCaptionsIntoTranscriptRow`（`const folded = foldCaptionsIntoTranscriptRow(...); const spoken = folded ? [folded] : [];`）后取两次读数——(i) 单位臂：`Test Files 1 failed (1) / Tests 2 failed | 12 passed (14)`，EXIT=1（「one row per utterance」「spoken order」两例红）；(ii) e2e 腿：`1 failed`，EXIT=1，断言消息 `no reading saw the endpoint's 3 utterances as 3 rows of their own, each \`heard\`; heard=[1,1,…] rows=[["alfa bravo charlie delta echo foxtrot golf hotel indiaHeardTXT…"], …]`。**随后复原**（`git diff placeCaptions.ts` 为空），复跑：单位臂 14/14 绿、e2e 腿绿。
- **AC5**：`npx vitest run src/modules/chat/voice-realtime/tests/voiceSegmentHonestState.test.tsx` → `Tests 16 passed (16)`，EXIT=0；`npm run typecheck` EXIT=0（`tsc --noEmit` ×3 全过）；`npm run lint` EXIT=0（仅既有 warning，无 error）。
- **AC6**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` → `tests 19 / pass 19 / fail 0`，EXIT=0；`npx playwright test e2e/voice-trim.spec.ts -g "AC-120"`（经 `bash scripts/with-memory-cap.sh`）→ `1 passed (13.6s)`，EXIT=0。

截图（`QUAY_LIVE_VOICE_SHOT_DIR` 下，一次带截图的运行产出；其临时目录 `…/.quay-shots/` 已在提交前删除，不留 residue）：`ac326-heard-rows-while-spoken-1280.png`（三行逐句 `heard`，交付前）、`ac326-same-row-after-delivery-1280.png`（就地定型的一条真实行 + `voice-transcript-badge`）、`ac326-wordless-made-no-row-1280.png`（空转写 0 行）。

集成：`git merge --no-edit develop` → `Already up to date`（develop 未推进），无冲突；本任务无 `loop.scoped_command`，scoped gate 跳过。
