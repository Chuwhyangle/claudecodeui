---
id: gap-live-voice-phantom-resend-exit-pair-and-no-new-heard-guard
title: Live Voice 退出时模型把已投递的话改写后重发（幻影第二条）：退出路径在「无待提交」时仍无条件
  commit+response.create 凭空开一轮，且重复守卫只比字面、改写即绕过——两处一起收口
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现象（2026-10-16 01:04–01:07 live 实测，journal `cae49fed-56a7-4877-9265-d4e7f3de0db6.jsonl`）

- 17:05:59.647 转写 A「检查一下本会话到现在为止已经嗯发出的嗯采集到的语音…费用。」，17:06:03.829 转写 B「统计最近对于费用的优化是不是起作用了？」。模型的 `session_send` 只带 B；中继的 span guard 把 A 逐字前置，投递「A+B」（17:06:05.083，正确）。
- 此后 44 秒零 `speech_started`、零转写、门控 0 帧放行（`audioTokens` 两轮都是 294，上游无新输入音频）。17:06:49.047 浏览器发 close frame。
- 退出路径无条件发 `input_audio_buffer.commit` + `response.create`（`voice-realtime-ws-proxy.service.ts:4678-4679`）。commit 被拒「buffer too small, or have no audio」，但 `response.create` 仍起了一轮；模型在这一轮里把 A **改写**（去「嗯」、补标点、`real time 服模型`→`realtime 模型`）后当新消息 `session_send`，17:06:50.556 被投递——你从未说过的第二段。

### 两个独立的缺口

**缺口 1：退出路径凭空开一轮。** `exitUplinkVad`（`:4657` 起）在门控 `flush` 之后不看「是否真有未提交音频」就发 commit+response.create。设计初衷（`:4650-4655`）是「别让立即 close 吃掉刚 flush 出去的尾句」，该理由只在**有待提交尾部**时成立。无待提交时它什么也提交不了，却让模型对历史里「看似未答」的 A 再答一次，并多付一整轮上下文的钱。

**缺口 2：重复守卫只比字面。** `proceedRelay`（`:3543-3549`）的伪调用判据为 `unforwardedUserUtterances === 0 && (normalized === lastAcceptedRelayText || lastAcceptedRelayText.includes(normalized))`。`normalizeRelayText`（`:307`）只剥空白/标点/符号，改写后的 A′ 既不等于也不被包含于「A B」，守卫放行。上一次 `gap-live-voice-continuous-duplicate-session-send-without-new-audio`（已 done）补的是同字面重复，触发点是上游自起响应；这次触发点不同、缺口相同。

### 方案（人 yale 2026-10-16 裁定：退出路径「无待提交 ⇒ 不发 response.create」允许；守卫规则按下列语料证据）

**腿 A（退出对）**：`exitUplinkVad` 在以下三者**同时**成立时，既不发 `input_audio_buffer.commit` 也不发 `response.create`，直接走 teardown：① 门控 `flush` 返回 0 帧；② 自上游最近一个 `committed` 以来本连接转发上游的音频帧数为 0；③ 上游没有未闭合的 `speech_started`。任一不成立 ⇒ 原行为（commit → response.create → 有界等待 → close，顺序不变）。「别短路 commit」的旧告诫针对的是**有尾部时**的顺序，本腿只在整对都无事可做时整对省略，不改变有尾部时的 commit-then-response 顺序。实验侧校验器 `experiments/voice-realtime-vad-three-arm/uplinkVadGate.mts` 的 `uplinkExitIsWellFormed` 是实验自己的观测校验，不接生产路径，不动；`docs/operations/voice-vad-filtered-pcm-upstream-replay.md` 补一行说明「无待提交时生产退出为裸 close」。

**腿 B（守卫）**：自上次已接受投递以来「听到的话」计数为 0（`unforwardedUserUtterances === 0`，该计数同时计 `committed` 与最终转写）且 `lastAcceptedRelayText !== ''` 时，`session_send` 判伪：不投递、`noteNotDelivered('duplicate: no new user audio since the last delivery — …')`、按现有 `withoutToolResume` 应答。**不再要求文本相等/包含**。依据——语料普查（`~/.cloudcli/voice-realtime-log/*.jsonl` 全部 continuous 模式连接）：308 次 `session_send`/`session_interrupt` 调用里，「自上一次调用以来零新 `committed`/转写」的 17 次中，16 次是字面重复（两次旧缺陷的复发与同一句连发），1 次是本幻影，**合法调用 0 次**。不对称论证：零新听到的话 ⇒ 所有说出口的话都已投递（含 span guard 前置的 A），丢掉这次调用不会丢句；残余风险按三次法则约 1% 量级，Notes 里照实记。`sessionInterrupt` 的更正路径不在本任务范围。

不在本任务：「工具结果回显实际投递文本」（让模型知道 A 已被前置）——成本低但收益被腿 A/B 覆盖，另议。

<!-- dedup-ref -->相关但不同机制：`gap-live-voice-continuous-duplicate-session-send-without-new-audio`（已 done，字面守卫的出处）、`gap-voice-uplink-vad-real-prefix-a-and-exit-commit`（已 done，退出对的出处）。与 `gap-live-voice-interrupt-aftermath-note-rides-the-correction` 同改 `voice-realtime-ws-proxy.service.ts`，机制与验收独立，分开立案。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts
- server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts
- docs/operations/voice-vad-filtered-pcm-upstream-replay.md
- tasks/gap-live-voice-phantom-resend-exit-pair-and-no-new-heard-guard.md

## AC

- [ ] 腿 A 用例（`voice-realtime-fake-vad-upstream.test.ts`）：一次完整 commit 之后无新放行帧，浏览器发 close，上游收到的帧序列里既无 `input_audio_buffer.commit` 也无 `response.create`，连接仍正常 teardown。`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts` exit 0。
- [ ] 腿 A 保形用例（同文件）：close 时门控仍有待 flush 的尾帧、或上游有未闭合 `speech_started`，序列仍为 `input_audio_buffer.commit` → `response.create` → close，顺序不变。同一命令 exit 0。
- [ ] 腿 B 复现用例（`voice-realtime-scripted-scenarios.test.ts`）：脚本化上游依次给出转写 A、B，模型 `session_send` 只带 B（A 被前置，投递一条「A B」）；其后无新音频，模型再发一条把 A 改写后的 `session_send`，断言宿主侧**只收到一条投递**，journal 含 `duplicate: no new user audio`。`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts` exit 0。
- [ ] 腿 B 保形用例（同文件）：两句话之间有新的 `committed`+转写时，第二条 `session_send` 照常投递（含「模型先文本答 No response requested.，再补发转发」的迟到转发形态）。同一命令 exit 0。
- [ ] 假形态：在源码里把腿 B 的条件还原为「必须文本相等/包含」，腿 B 复现用例变红（执行者在 Notes 里贴出这一次红的输出）。
- [ ] `npm run typecheck` 与 `npm run lint` 均 exit 0。

## DoD

用本次幻影的真实序列重放：以 `cae49fed-….jsonl` 的转写/调用序列驱动真 proxy（脚本化上游，零云调用），把「修复前：第二条投递的全文」与「修复后：同一输入下宿主收到的投递列表」逐字贴入 Notes，并贴 `duplicate` 的 journal 行。另贴一段「无待提交退出」的上游帧序列实录（无 commit、无 response.create）。仅有测试断言、没有这两段实录不算落地。语料普查脚本与其 308/17/16/1/0 的读数一并贴入，供下次复核（回放前先把 `~/.cloudcli/voice-realtime-log/` 里用到的 journal 冻结拷出，目录会被淘汰）。