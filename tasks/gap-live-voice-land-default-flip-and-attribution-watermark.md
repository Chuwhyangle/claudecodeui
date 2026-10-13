---
id: gap-live-voice-land-default-flip-and-attribution-watermark
title: 落地 AC-375（删传输切换按钮 + 服务端默认翻 continuous）与投递归属水位线（含两个夹具）：提交、构建、重启、验证
status: needs-human
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

2026-10-13 第三次 live voice 实测后落地的两批改动**仍未提交**：

1. **AC-375**：删掉 Live Voice 的 continuous/turn 传输切换按钮（人裁定「用户在 live voice 下除了说话不应该关心别的」），服务端默认传输翻为 `continuous`，`VOICE_REALTIME_MODE=segmented` 降级为部署级回滚开关。
2. **投递归属水位线**：`sent` 帧新增 `coveredThroughItemId`（本次投递答到的对话边界＝中继最后一次 `input_audio_buffer.committed` 的 item id）；客户端按 id 认领而不是按模型转述文本匹配。旧行为下模型改写/掉句会让气泡永久悬空、退出时把已被处理的话倒进编辑框。

本任务**只负责提交、构建、重启并验证**，不含任何新的行为改动。落地时必须一并带上测试文件计数钉子（`server/shared/tests/quay-test-script.test.ts` 的 314→315、316→317）与 `scripts/suite-duration-baseline.tsv` 的新基线行。

## Plan

1. 复核工作区 diff，确认包含：`voice-realtime-mode.ts` 默认翻转、`VoiceRealtimeBar.tsx` 去按钮、12 个 locale、`api.ts`/`voiceConfig.ts` 收敛、`voice-realtime-ws-proxy.service.ts` 水位线、两个新夹具、计数钉子、基线行。
2. `git add` 上述具名文件并提交（conventional type，**不加连字符**）。
3. `npm run typecheck && npm run lint && npm run build`。
4. 重启 `claudecodeui-server.service` —— **这会中断宿主会话**，必须放在最后一步并事先明确告知人。
5. 重启后只读验证（下一回合做）：build-info 的 gitSha、`/` 200、页面无传输按钮、两个新夹具绿。

## AC

- [x] AC1 `git status --porcelain` 为空（改动全部已提交）。
- [x] AC2 `npm run typecheck` 与 `npm run lint` 均退出 0。
- [ ] AC3 服务重启后 `cat dist-server/build-info.json` 的 gitSha 等于 `git rev-parse HEAD`，且 `curl -s -o /dev/null -w '%{http_code}' http://localhost:3001/` 输出 200。
- [x] AC4 `npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-delivery-boundary.test.ts` 与 `npx vitest run src/modules/chat/voice-realtime/tests/voiceAttributionRewriteGap.test.tsx` 均退出 0。
- [x] AC5 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0（计数钉子与真实文件数一致）。

## DoD

主检出 HEAD 含上述全部改动，线上服务从该构建运行，页面上传输切换按钮消失，语音投递按 item id 归属而不是靠文本匹配。

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

重启会中断宿主会话，必须作为最后一步并明确告知人。另有一处**未决**：`e2e/voice-realtime-live-session-send.spec.ts` 因本次默认翻转而恒红，由 gap-voice-e2e-spec-read-resolved-mode-not-env 修。

## Evidence

2026-10-13 worker 续做轮，在 `merge develop` 后的 worktree 上逐条复核：

- AC1 绿：`git status --porcelain` 空（全部改动已提交在该分支）。
- AC2 绿：`npm run typecheck` exit 0；`npm run lint` exit 0（仅 warning）。
- AC4 绿：`voice-realtime-delivery-boundary.test.ts` 4 passed / exit 0；`voiceAttributionRewriteGap.test.tsx` 5 passed / exit 0。
- AC5 绿：`quay-test-script.test.ts` 11 passed / exit 0（314→315、316→317 计数钉子与真实文件数一致）。
- AC3 **不可由执行者判定**：其读数（`dist-server/build-info.json` 的 gitSha == `git rev-parse HEAD`，且 `curl http://localhost:3001/` == 200）只存在于「合入 + 构建主检出 + 重启 `claudecodeui-server.service`」之后；该服务从主检出 `dist-server` 提供 :3001，重启会中断本 worker 所在会话，且 worker 不得触碰主检出。故执行者结构上取不到此读数——与任务 Notes「重启…必须…明确告知人」一致。

AC3 保持未勾、且不自行追加「（待外部）」标注：该标注只能由作者书写（worker 自行追加会伪造「已外部验证」）。因此正确终态 = `needs-human`：由人完成构建 + 重启后取读数、再勾选晋升。分支 `task/gap-live-voice-land-default-flip-and-attribution-watermark` 已含全部改动、tree 干净、AC1/2/4/5 全绿，人裁定后即可 ff 到 develop。

## Blocker

**2026-10-13T03:48:43.269Z — worker 未落地（exited-not-landed）**

- 未落地原因：AC 未全勾（checked 4/5，剩余未勾 1）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：d7c66270-418d-4657-8ca5-de0f179f67bc

**2026-10-13 续做轮更正：** 「续做只需验证并勾选 AC」对 AC3 不成立——AC3 的读数须在落地后由人构建 + 重启才能取得（见 `## Evidence`）。本轮验证 AC1/2/4/5 全绿后 park `needs-human`，不代勾 AC3、不自行追加「（待外部）」。