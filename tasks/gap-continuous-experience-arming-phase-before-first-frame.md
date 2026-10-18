---
id: gap-continuous-experience-arming-phase-before-first-frame
title: AC-361 再红：arming 相位落地后连续体验 spec 在推首帧前等 listening，25 s 超时——判据适配「首帧后才是
  listening」并重跑 X-1..X-7 读数（只改测试）
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-361
---
## Proposal

### 现状（2026-10-18 判据直接重跑，确定性复现）

AC-361 判据命令在当前 develop tip（`1c3dc19bb`）**退 1**：

- L1 半边绿：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts` → **15 pass / 0 fail / exit 0**。
- Playwright 半边红：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` → **1 failed / 10 did not run / exit 1**。首个失败在 `e2e/voice-realtime-continuous-experience.spec.ts:983`（`test.describe.configure({ mode: 'serial' })` 使后续 10 条不运行）：

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: "listening"
Received: "arming"

Call Log:
- Timeout 25000ms exceeded while waiting on the predicate

  981 |       await page.getByTestId('live-voice-button').click();
  982 |       await expect(page.locator(BAR)).toBeVisible({ timeout: 30_000 });
> 983 |       await expect.poll(() => phase(page), { timeout: 25_000 }).toBe('listening');
```

失败 run 的 artifact：`~/.cache/quay-e2e-tmp/quay-e2e-sdsHdx/test-results/voice-realtime-continuous--a2029-ne-utterance-per-spoken-run/`（含 `error-context.md` 与 trace）。gate evidence：`2026-10-18T03:25:59.539Z`，`acceptance failed (exit 1)`。

### 成因（读代码，逐行）

- `c99a0eaba`（2026-10-18 10:16，「feat(voice): add an arming phase until the first captured frame」，任务 `gap-live-voice-listening-before-capture-ready`）把相位契约改成：上游 `state: open` 之后不再直接 `listening`，而是 **`arming`**；只有**音频源交付第一帧**（`src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts` 的帧回调里置 `captureReadyRef.current = true`）才转 `listening`。
- 连续体验 spec 的 fake mic（`e2e/voiceRealtimeFakeMic.ts` 的 `installFakeMic`）在 `play()` 被调用之前**一帧都不推**：`pushFrame` 只由 `play()` 里的 `setInterval(tick, frameMs)` 驱动，`state.node` 之外没有任何 ambient 帧。
- spec 的顺序是：`:983` 先等 `phase === 'listening'`，`:997` 才 `playFakeMic(page)`。于是「首帧」永远等不到 ⇒ 相位停在 `arming` ⇒ 25 s 轮询超时。这是**确定性死锁**，不是 flakes，与执行面 busy/idle、调度器负载无关。
- 同一 spec 文件头（第 24-29 行、第 60 行附近）仍按旧契约写「capture's frames are held until `state: open`」，与新产品契约不符，需要同步改写；同时不得把整段改成解释某标记缺席的散文（会重新引入判据自己 grep 的字面量）。

### 前次修复为何没有保住

`gap-continuous-experience-settle-window-mid-utterance`（done，提交 `e602e1760`，2026-10-18 03:07）曾把本 spec 在 settle 生产者上重跑回绿（11 passed ×3，读数 sha256 `308909d0…`）。约 7 小时后 `c99a0eaba` 改了相位契约，但该任务的 `## Touches` 只含 `useVoiceRealtimeSession.ts` / `VoiceRealtimeBar.tsx` / 自己的新 e2e spec / `playwright.config.ts` 等，**不含** `e2e/voice-realtime-continuous-experience.spec.ts`，因此 AC-361 判据从未在新相位下重跑。前次修复本身没有错——它只是没有覆盖「相位契约变化会改变本 spec 的进入条件」这条耦合。

### 要做的事（只改测试；若判定必须改产品则 park）

1. **重排进入门，读产品自己的新契约**：进入 Live Voice、bar 可见之后，先等上游真的打开（`upstream.liveConnectionCount() === 1`、`upstream.vad()?.turnDetection === 'server_vad'`），再读相位为 `arming`（`open` 不等于麦克风就绪；此时 fake capture 尚未推帧，这是确定性的），然后 `playFakeMic(page)`，**首帧到达后**再等 `listening`。不得为了绕过而删掉 `listening` 断言、改成 `test.fail`/skip/known-defect；`listening` 必须在首帧后仍被直接断言（末尾 `run.phase === 'listening'` 的腿保留）。
2. 同步修正 `:983` 附近与文件头中「frames held until state: open」的过期注释为「首帧前 `arming`、首帧后 `listening`」，并保留零外联/真 capture 路径的既有说明。
3. 重跑并确认 11 条全部运行、全部通过。`serial` 模式会遮蔽后续红：首条转绿后若后续腿（尤其 X-1/X-6 的 status 行、X-7 延迟表）因新相位或 arming 文案（bar 在 arming 时显示 `Starting microphone…`）而红，按当前真实读数逐条重锚；**不得**放松任何既有断言。若某腿必须改产品语义才能恢复，停在 `needs-human` 并写明理由，不得顺手改产品。
4. 取 AC-361(e) 读数：同一种子连续 3 次全绿 + 归一化读数一致 + 零外联；把 X-1..X-7 逐项读数表写入 `## Notes`。

## AC

- [ ] AC1（假形态排最前，且先红）：把进入门改回「`playFakeMic` 之前等 `listening`」（即当前红形态）时，单跑 `npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 复现 `Expected: "listening" / Received: "arming"` 且退 1；恢复重排后同一命令退 0。逐字报错与恢复后的读数记入 `## Notes`。
- [ ] AC2：AC-361 判据命令（`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts && npx playwright test e2e/voice-realtime-continuous-experience.spec.ts`）退出 0；e2e 为 11 passed / 11 run，无 did not run / skipped。
- [ ] AC3：`grep -c "expectKnownDefect\|test\.fail\|test\.skip\|fixme" e2e/voice-realtime-continuous-experience.spec.ts` = 0，且 `grep -c "^  test("` = 11；`grep -n "toBe('listening')" e2e/voice-realtime-continuous-experience.spec.ts` 至少命中 2 处（首帧后的进入读数与末尾 `run.phase`），且都未被包装。
- [ ] AC4：同一种子连续 3 次运行 e2e 全绿，`QUAY_CONTINUOUS_EXPERIENCE_DUMP` 归一化读数三次一致（sha256 记 `## Notes`），`egress` 读数 `dials:1` 且无 loopback 拒绝。
- [ ] AC5：`npx oxlint e2e/voice-realtime-continuous-experience.spec.ts` 退出 0；`git diff --stat develop` 只含 `e2e/` 下的测试文件（不改 `server/`、`src/`）。

## DoD

真实 e2e（真浏览器 fake mic → 真 proxy/bridge → 脚本化声学上游）在当前 continuous 代码路径上重新跑通：bar 在首帧前诚实读 `arming`、首帧后 `listening`，X-1..X-7 逐项读数恢复，11 个用例全部运行且直接断言通过；判据命令退出 0 并可重复三次读数一致。只改测试，不改产品代码。

## Touches

- e2e/voice-realtime-continuous-experience.spec.ts
- e2e/voiceRealtimeFakeMic.ts
- tasks/gap-continuous-experience-arming-phase-before-first-frame.md

## Notes

立案：gap 轮 2026-10-18。GOAL-044 achieved 后 AC-361 离开 reverify scope，本轮判据直接重跑为 fail（evidence `2026-10-18T03:25:59.539Z`，exit 1）；复现命令、逐字报错与 artifact 路径见 Proposal；L1 单测 15/15 绿。worker 若动 `server/` 或 `src/` 须先读对应 `.agents/skills/*-module-standards/SKILL.md`（AGENTS.md 硬要求）；本任务预期只改 `e2e/`。

<!-- dedup-ref --> 机制去重：`gap-live-voice-listening-before-capture-ready`（done，`c99a0eaba`，引入 arming 相位的前置变更）；`gap-continuous-experience-settle-window-mid-utterance`（done，上一次让本 spec 回绿的修复）；`gap-continuous-experience-busy-window-swallows-forward-row` 与 `gap-live-voice-continuous-experience-spec-realign-*`（均 done，历史 spec 重锚）。本次不是投影重锚，而是新相位契约使本 spec 的进入门自锁，故立新任务。merge-candidate：`task-granularity-advice.js --touches e2e/voice-realtime-continuous-experience.spec.ts --json` → `peers: []`、`mentions: []`，无同文件在飞任务，**separate**。
