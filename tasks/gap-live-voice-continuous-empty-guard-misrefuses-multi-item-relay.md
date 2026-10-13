---
id: gap-live-voice-continuous-empty-guard-misrefuses-multi-item-relay
title: continuous 空转写守卫只看「最后一个已转写条目」，模型把多段合成一次 session_send 时被末尾 0.37 s
  空碎片整条误拒——改为按上次转发以来的归属区间判定
status: todo
labels:
  - gap
  - P0
parent: null
children: []
extra:
  acceptance: test -f
    server/modules/voice-realtime/tests/voice-realtime-continuous-empty-guard-span.test.ts
    && npx tsx --tsconfig server/tsconfig.json --test
    server/modules/voice-realtime/tests/voice-realtime-continuous-empty-guard-span.test.ts
---
## Proposal

**现象（2026-10-13 真实 live voice，journal `b5d01c21`，continuous）**——人说的「几步的延迟都有点大，包括识别延迟」机械性丢失：

```
56:57.740 transcription.completed "几步的延迟都有点大。"
56:57.815 function_call session_send {"message": "      ← response cancelled (turn_detected)，MALFORMED_FUNCTION_CALL
57:01.504 transcription.completed "包括识别脸识。"
57:01.794 transcription.completed ""                   ← 57:01.323–01.695 的 0.37 s 碎片
57:02.324 function_call session_send {"message": "几步的延迟都有点大，包括识别延迟，然后……"}
57:02.324 session_send not-delivered (empty-transcript)
```

**机制（代码已核）**：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` `sessionSend` 的 continuous 分支（约 :2705–2718）只问 `itemTranscriptEmpty.get(lastTranscribedItemId)`。模型一次调用覆盖了**上次转发以来的多个条目**（这里 3 个，两个有字），守卫却只按最后一个条目（空碎片）裁决 ⇒ 有文本的转发被整条拒绝。前一次同内容调用因 `turn_detected` 被截断（MALFORMED），两者叠加 ⇒ 整句丢失。

人 yale 2026-10-14 批准（复盘 P0-2）：**按归属水位/区间修正**。

## Plan

1. 在 proxy 维护 continuous 的**转发水位**：记录上一次被接受（或被判定处理完）的 `session_send` 时刻已转写到的条目位置；本次调用的**归属区间** = 水位之后到当前为止已 `transcription.completed` 的全部条目。
2. 守卫改为：区间内**全部**条目转写为空（且 `message` 本身已由 `EMPTY_RELAY_TEXT` 判非空）才拒；区间内只要有一条非空 ⇒ 放行。区间为空集（还没有任何转写）沿用现行「unknown 不是 empty」放行。
3. 水位推进点：被接受投递、被判空拒绝、MALFORMED 截断——三者语义分别写清；MALFORMED 截断**不推进**水位（其内容会由模型重发）。
4. segmented 路径的 seq-keyed 守卫不动。
5. 测试：新文件 `voice-realtime-continuous-empty-guard-span.test.ts`，用 b5d01c21 的**逐字事件序列**（3 条转写含 1 条空 + 截断调用 + 合并调用）驱动假上游。

## AC

- [ ] AC1 回放 b5d01c21 56:57.740–57:02.324 的事件序列（逐字转写与逐字 `arguments`）⇒ `session_send delivered`，投递文本为 `几步的延迟都有点大，包括识别延迟，然后……`；取假形态：守卫改回只看 `lastTranscribedItemId` ⇒ 本用例红（`not-delivered (empty-transcript)`）。
- [ ] AC2 区间内全部为空（如单个空碎片后紧跟一次转发）⇒ 仍 `not-delivered (empty-transcript)`，现有 `voice-realtime-empty-transcript-guard.test.ts` 单文件运行退出 0。
- [ ] AC3 水位推进：被接受的转发之后再来一条空碎片 + 转发 ⇒ 拒（不被更早的非空条目「借票」放行）；取假形态：水位不推进 ⇒ 红。
- [ ] AC4 MALFORMED 截断不推进水位：截断 → 新转写 → 重发 ⇒ 重发的归属区间包含截断前的条目。
- [ ] AC5 segmented 路径行为不变：segmented 相关守卫测试单文件运行退出 0。
- [ ] AC6 用 capture `b5d01c21….wav`（sha256 前缀 `0f2bd51fbbb28c9f`）对应区间在备用端口实例或探针上做一次真实上游回放（花费上限 ¥0.1，未重启 :3001、pid 前后相同），把读数（转写条目、调用、守卫裁决）写入 Notes；真实上游未复现同一切分时如实写「未复现，仅脚本证据」。

## DoD

continuous 模式下，一次覆盖多个条目的转发只在其归属区间全空时被拒；b5d01c21 的丢句形态在合入后的代码上被投递；空碎片单独转发仍被拒。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-empty-transcript-guard.test.ts
- server/modules/voice-realtime/tests/voice-realtime-continuous-empty-guard-span.test.ts (new)
- tasks/gap-live-voice-continuous-empty-guard-misrefuses-multi-item-relay.md

## Notes

**查重（2026-10-14）**：`gap-voice-realtime-empty-transcript-delivery-guard`（done）引入投递点守卫；SPEC §10 / 决策文档 §12.5「按条目自身空转写判定」引入 continuous 的 item-scoped 分支——本任务修正其「最后条目」近似，不是重复。无未完成同机制任务。

**证据**：journal `~/.cloudcli/voice-realtime-log/b5d01c21-3f53-4228-a28e-d18b7cb967f7.jsonl`、capture 同 id。
