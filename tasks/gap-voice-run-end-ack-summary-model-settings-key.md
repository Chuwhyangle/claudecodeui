---
id: gap-voice-run-end-ack-summary-model-settings-key
title: run-end 确认语 + 摘要模型收敛进 voice-realtime.settings.json（runEndAck /
  summaryModel 键，env 保留作逃生舱）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

「voice-realtime 部署旋钮从 env 收敛到设置文件」的下一批：把 `runEndAck` 与 `summaryModel` 两个 env-only 旋钮收进 `voice-realtime.settings.json`，env 保留作逃生舱（优先级 env > 文件 > 默认）。

现状（已核对）：
- `VOICE_REALTIME_RUN_END_ACK`（`|` 分隔候选）与 `VOICE_REALTIME_SUMMARY_MODEL`（模型名）都在 `server/index.ts` 装配点从 `process.env` 读（`:684`、`:725`），settings 文件没有这两个键。
- `announcePhrases` 刚落地的任务（`gap-voice-announce-phrases-settings-key`，已 done）已经建立了接线先例：装配点每连接调 `loadVoiceRealtimeSettings(...)` 拿 `announcePhrases`（cache warm 用），proxy 每连接也 load 一次拿同一张表。
- 这两个键的 `|` 分隔拆分已有现成纯函数：`resolveVoiceRealtimeRunEndAckCandidates`（`voice-realtime-narrator.ts`）就是给 runEndAck 用的。

改法（三件）：

1. `voice-realtime-settings.ts` 加两键：
   - `summaryModel: string | null`——非空字符串，`null` 表示「文件没说」，回落 env → 空（即无真模型，或回退 stand-in）。
   - `runEndAck: string[]`——`|` 分隔字符串，拆分复用 `resolveVoiceRealtimeRunEndAckCandidates`；空数组表示「文件没说」，回落 env → 空（关闭）。
   - 两者都进 `VoiceRealtimeSettings` 与 `problems`（形状错整份拒绝、I/O 失败用默认，沿用既有规则）。
2. `server/index.ts` 装配点：从**同一次** `loadVoiceRealtimeSettings(...)` 结果里拿两键，做「env > 文件 > 默认」合并——`summaryModel = env 非空 ? env : settings.summaryModel ?? ''`；`runEndAck = env 候选非空 ? env 候选 : settings.runEndAck`。log 一行注明来源（env / file / default），与 announcePhrases 的 cache warm 同一次 load，不重复读文件。
3. 优先级语义与 announcePhrases 不同、要写清楚：announcePhrases 此前无 env，收敛后只有「文件 > 默认」一层；这两个键**线上已有 env**，收敛是「文件成为主配置、env 降为逃生舱」，不是删 env。`VOICE_REALTIME_RUN_END_ACK` / `VOICE_REALTIME_SUMMARY_MODEL` 两个 env 名与现有 `.env`/`.env.example` 条目**保留不动**。

<!-- dedup-ref --> 与 `voice-summary-latency-and-run-end-ack`（已 done，实现 runEndAck + qwen-flash 摘要模型）、`gap-voice-announce-phrases-settings-key`（已 done，announcePhrases 收敛先例）的关系：本条是同一收敛机制在这两个键上的推广，独立交付；其余旋钮（TTS/closingTurn/silenceTail/uplinkVad…）仍是后续逐条任务，不在本条。

## AC

- [ ] `npx vitest run server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts` 退出 0，且新增 `runEndAck`（`|` 拆分、空回退）与 `summaryModel`（非空字符串、空/非法回退并进 `problems`）两键用例。
- [ ] 优先级：`VOICE_REALTIME_SUMMARY_MODEL` 与 `VOICE_REALTIME_RUN_END_ACK` env 设值时覆盖文件值（env 臂仍在 `server/index.ts` 读 env 优先）；`grep -n "VOICE_REALTIME_SUMMARY_MODEL" server/index.ts` 与 `grep -n "VOICE_REALTIME_RUN_END_ACK" server/index.ts` 仍命中（env 逃生舱未删）。
- [ ] `npx vitest run server/modules/voice-realtime/tests/voice-realtime-run-end-summary.test.ts` 退出 0（runEndAck env 臂与 summaryModel env 臂保持绿——env 仍是逃生舱）。
- [ ] 不新增 server 测试文件（`quay-test-script.test.ts` 收集数 pin 不动，沿用 `voice-summary-latency-and-run-end-ack` 的 DoD 纪律）。
- [ ] `npm run typecheck` 退出 0；`npm run build:server` 退出 0。

## DoD

`voice-realtime.settings.json` 的 `runEndAck` 与 `summaryModel` 两键真实生效：无文件时行为与今天一致（env 或默认），文件设值时成为主配置、env 仍可覆盖（装配点同一次 load、优先级 env > 文件 > 默认，单测 + grep 判据钉住）。不在本条的：其余旋钮收敛、真实 DashScope 出声（H1 人工验收门）。

## Touches

- server/modules/voice-realtime/voice-realtime-settings.ts
- server/modules/voice-realtime/voice-realtime-narrator.ts
- server/modules/voice-realtime/index.ts
- server/index.ts
- server/modules/voice-realtime/tests/voice-realtime-context-and-settings.test.ts
- server/modules/voice-realtime/tests/voice-realtime-run-end-summary.test.ts
- tasks/gap-voice-run-end-ack-summary-model-settings-key.md
