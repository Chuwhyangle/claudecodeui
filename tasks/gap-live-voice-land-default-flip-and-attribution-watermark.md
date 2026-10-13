---
id: gap-live-voice-land-default-flip-and-attribution-watermark
title: 落地 AC-375（删传输切换按钮 + 服务端默认翻 continuous）与投递归属水位线（含两个夹具）：提交与执行面内验证
status: needs-human
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-13 第三次 live voice 实测后落地的两批改动（**已在分支 `task/gap-live-voice-land-default-flip-and-attribution-watermark` 上提交，并已 ff 进 develop**）：

1. **AC-375**：删掉 Live Voice 的 continuous/turn 传输切换按钮（人裁定「用户在 live voice 下除了说话不应该关心别的」），服务端默认传输翻为 `continuous`，`VOICE_REALTIME_MODE=segmented` 降级为部署级回滚开关。
2. **投递归属水位线**：`sent` 帧新增 `coveredThroughItemId`（本次投递答到的对话边界＝中继最后一次 `input_audio_buffer.committed` 的 item id）；客户端按 id 认领而不是按模型转述文本匹配。旧行为下模型改写/掉句会让气泡永久悬空、退出时把已被处理的话倒进编辑框。

本任务负责把这两批改动**提交并在执行面内验证**，不含任何新的行为改动；**部署动作（构建主检出 + 重启 :3001）不进本任务的 AC/DoD**——2026-10-13 人裁定「设置在 merge 到 develop 前不能验证的 AC 在逻辑上是错的」（见 Notes）。落地时必须一并带上测试文件计数钉子（`server/shared/tests/quay-test-script.test.ts`）与 `scripts/suite-duration-baseline.tsv` 的新基线行。

## Plan

本任务剩余的是**执行面内的复核 + 勾选**（改动的落地与滚动已由人完成，读数见 Notes）：

1. 在 worktree 上 `git merge --no-edit develop`（分支与 develop 同点，通常为空操作；若计数钉子冲突，取并集并用 `quay-test-script.test.ts` 自证，不要照抄数字）。
2. 逐条复核 AC1 / AC2 / AC4 / AC5（读数见 `## Evidence`；develop 若有新并入的改动需重跑）。
3. 跑 AC3 的两条读数：两个 server 测试文件 + 残留引用 grep。
4. 经 Provider ABI `task_write` 逐条勾选，然后退出；由 worker-driver 机械 fan-in 落地。

## AC

- [x] AC1 `git status --porcelain` 为空（改动全部已提交）。
- [x] AC2 `npm run typecheck` 与 `npm run lint` 均退出 0。
- [ ] AC3（默认翻转与控件移除的**在树读数**，全部在 worktree 内取得）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-segmented-default.test.ts` 与 `…/voice-realtime-transport-opt-in.test.ts` 均退出 0（默认 `continuous`、`VOICE_REALTIME_MODE=segmented` 仍是部署级回滚开关）；`grep -rn 'transportOptIn' src/ server/` 无输出，且 `src/modules/chat/voice-realtime/tests/voiceTransportOptIn.test.tsx` 已不存在（客户端不再暴露传输切换控件）。⛔ 本判据不得包含任何需要合入 develop / 构建主检出 / 重启 `:3001` 才能取得的读数。
- [x] AC4 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-delivery-boundary.test.ts` 与 `npx vitest run src/modules/chat/voice-realtime/tests/voiceAttributionRewriteGap.test.tsx` 均退出 0。
- [x] AC5 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0（计数钉子与真实文件数一致）。

## DoD

develop 树含上述全部改动（已落地 `0541d1b8`）；两条用户可见结果——页面上传输切换控件消失、语音投递按 item id 归属而不是靠文本匹配——分别由 AC3 与 AC4 的夹具/断言读出。**线上滚动（构建主检出 + 重启 `:3001`）不是本任务的判据**：它是一次部署动作，其读数只证明「部署做了」，不证明「实现对了」。

## Touches

- server/modules/voice-realtime/voice-realtime-mode.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-delivery-boundary.test.ts
- server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts
- server/modules/voice-realtime/tests/voice-realtime-segmented-default.test.ts
- server/modules/voice-realtime/tests/voice-realtime-streaming-stages.test.ts
- server/modules/voice-realtime/tests/voice-realtime-transport-opt-in.test.ts
- src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
- src/modules/chat/voice-realtime/VoiceRealtimeBar.tsx
- src/modules/chat/voice-realtime/tests/voiceAttributionRewriteGap.test.tsx
- src/modules/chat/voice-realtime/tests/voiceTransportOptIn.test.tsx (delete)
- src/shared/api.ts
- src/shared/voiceConfig.ts
- src/modules/i18n/locales/*/chat.json
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- docs/operations/voice-realtime-idle-history-probe.md
- experiments/voice-realtime-idle-history-probe/probe.mts
- tasks/gap-live-voice-land-default-flip-and-attribution-watermark.md

## Notes

未决（不属于本任务）：`e2e/voice-realtime-live-session-send.spec.ts` 因本次默认翻转而恒红，由 `gap-voice-e2e-spec-read-resolved-mode-not-env` 修。

### 2026-10-13 人裁定：删掉「只能在 merge 之后验证」的 AC

原 AC3 要求「服务重启后 `dist-server/build-info.json` 的 gitSha == `git rev-parse HEAD`，且 `curl :3001/` == 200」。这两个读数只在「合入 develop + 构建主检出 + 重启 `claudecodeui-server.service`」之后才存在，**执行者结构上取不到**：worker 不得触碰主检出，且该重启会掐断它自己所在的宿主会话。原实现因此把任务永久钉在 `needs-human`，并连带压住两个 `depends_on` 它的 todo（`gap-voice-e2e-spec-read-resolved-mode-not-env`、`gap-voice-unforwarded-utterance-visible-disposition`）——盘面表现为「没有任务在飞」，却没有任何红。

**裁定：设置在 merge 到 develop 前不能验证的 AC 在逻辑上是错的。** 判据必须落在本任务的执行面（worktree）内；部署动作不进 AC/DoD。AC3 已改写为在树可判的形态（旧「重启后取读数」的内容整体移出判据）。作者当时把它写进 AC 并 park `needs-human` 是错的方向——正确的方向是改写判据，不是把裁定权交给人。

**配套事实（记录，不是判据）**：人已于 2026-10-13 12:52–12:57 手工完成落地与滚动——任务分支 `merge develop`（唯一冲突是计数钉子 `quay-test-script.test.ts`，取并集 317/319，该测试 11 pass 自证）→ 主检出 ff → `git push . author:develop`（`0541d1b8`）→ `npm run build`（client vite + server tsc，build-info gitSha == HEAD）→ 重启 `claudecodeui-server.service`（12:56:54）→ `curl /` 200。这些是**已完成的事实**，不再作为勾选项。

## Evidence

2026-10-13 worker 续做轮，在 `merge develop` 后的 worktree 上逐条复核：

- AC1 绿：`git status --porcelain` 空（全部改动已提交在该分支）。
- AC2 绿：`npm run typecheck` exit 0；`npm run lint` exit 0（仅 warning）。
- AC4 绿：`voice-realtime-delivery-boundary.test.ts` 4 passed / exit 0；`voiceAttributionRewriteGap.test.tsx` 5 passed / exit 0。
- AC5 绿：`quay-test-script.test.ts` 11 passed / exit 0（计数钉子在并入 develop 后取并集，与真实文件数一致）。
- AC3（**2026-10-13 已改写**）：原形态的读数只能在合入 + 构建 + 重启后取得 ⇒ 判据本身错了（见 Notes 的人裁定）。现形态在执行面内可判，2026-10-13 在主检树（`d53ecdc9`）实测 `voice-realtime-segmented-default.test.ts` 10 passed / 0 fail、`voice-realtime-transport-opt-in.test.ts` 8 passed / 0 fail，`grep -rn 'transportOptIn' src/ server/` 无输出。

改写后 AC3 保持未勾：由重新派发的本轮在 worktree 内验证后勾选（不再 park `needs-human`——它的读数现在在执行面内）。分支 `task/gap-live-voice-land-default-flip-and-attribution-watermark` 与 develop 同点、tree 干净、AC1/2/4/5 已全绿。

## Blocker

**2026-10-13T03:48:43.269Z — worker 未落地（exited-not-landed）**

- 未落地原因：AC 未全勾（checked 4/5，剩余未勾 1）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：d7c66270-418d-4657-8ca5-de0f179f67bc
