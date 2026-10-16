---
id: gap-live-voice-one-text-per-segment-prefer-response
title: live-voice 每段音频只许一条文本进 CLI：有 response 就只用 response，仅当该段无任何 response 应答才
  fallback 到 ASR transcript —— 删掉 session_send 与 correction 把 transcript
  补在模型话前面的跨度守卫，并退回 AC-345 今天的重锚
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**人的裁定（2026-10-16，逐字）**：

> 明确逻辑：每个语音片段只应有一次文本进入 CLI；优先用 response；仅在确认一段音频没有 response 时才 fallback 到 transcript。

**为什么**：ASR 文本（caption 通道的 `transcription.completed`）**在原理上无法判定**分歧属于「模型漏了句」还是「ASR 自己错听」—— 两种在相邻字对覆盖率上同形，只能靠文本猜，而文本正是要判的那个东西。

**本轮直接现测**（journal `3d2d3b2c-030b-4df4-a506-076bba083438`，2026-10-16 13:20 场，用户实测 Live Voice 第一场），逐字：

- `05:20:39.998 << transcription.completed "十月十五日，来望也，嗯，第一次考试。"` —— ASR 把 LiveWire 听成「来望也」
- `05:20:40.281 << function_call session_send {"message": "十月十五日，LiveWire 第一次测试。"}` —— **同一个 response**（`resp_AOlHP2QiGJ4cf1dQPHcUh`，唯一 output item，`out=33` 就是这次调用的 JSON）里，模型按音频把错听修好了
- `05:20:40.283 session_send left 1 heard sentence(s) out; delivered verbatim in front of it: 十月十五日，来望也，嗯，第一次考试。`
- `05:20:41.294 session_send delivered in 8 ms`，`message` = 两半拼起来：`十月十五日，来望也，嗯，第一次考试。十月十五日，LiveWire 第一次测试。`

读数是 14 字 / 13 个相邻字对、命中 6（`十月 月十 十五 五日 第一 一次`），share = **0.462 < `COVERED_PAIR_SHARE` 0.5**（`voice-realtime-fragment-coverage.ts:23`）⇒ 判为「未覆盖」。守卫生来是给 `8fe60310`（模型只 carry 后半句、前半句真丢）用的，它分不开「改写」与「遗漏」。后果两份：同一段音频**两条**文本进了 CLI；而且补进去的那份是**低保真的 ASR 错听** —— 模型刚按音频修好的 `LiveWire` 被 `来望也` 盖在它前面。

**处置（按裁定逐处）**，全在 `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`，作用域均 `!segmentedRelay`：

| # | 位置 | 现状 | 处置 |
|---|---|---|---|
| 1 | `:3971-3986` | `session_send` 到达时，把按字对判为未覆盖的 heard 句逐字补在模型话前面 | **删** |
| 2 | `:4177-4191` | 中断的 correction 套同一守卫 | **删** |
| 3 | `:4581-4590` | `MODEL_TEXT_REPLY`：模型没走 call 时才把 heard 句照发 | **保留** |
| 4 | `:3955-3961` | 空 span 拒绝（只读空/非空，不注入文本） | **保留** |

1、2 删掉后 `selectUncoveredFragments` 不再有消费者：`voice-realtime-fragment-coverage.ts` 与其单测一并删除，删除处留一句为什么那条「用字对覆盖率而不是相等」的理由不再成立。

**要一起退的钉子（本任务的代价，不能只留一个变绿的守卫）**：`gap-ac345-correction-span-guard-folds-unclaimed-phrase`（今天 done，裁定「判据假阳性、守卫按设计保留」）把 `e2e/voice-realtime-intent-control.spec.ts` 用例 4 重锚成 `:1418` 要求 PHRASE 必须随更正投递、`:1429` 注释「a delivered phrase must not be re-homed」。按本裁定那次 interrupt **有** response（模型发了带 correction 的调用）⇒ 不补、PHRASE 回填 composer，即退回重锚前的原读法（`:1381` 原「PHRASE 不得在队列里」、`:1388` 原「draft 含 PHRASE」）。`gap-ac345` Notes 里留的反方理由（`8fe60310`：撤掉守卫后那句「上了屏、投递无门」）由**回填 composer** 回答：不是投递无门，是交回输入框。用例 4 的标题与注释要同步改写，写明本裁定与它取代了什么。

<!-- dedup-ref -->
**dedup / granularity**：按机制 grep 全库（`跨度守卫` / `span guard` / `itemTranscriptText` / `verbatim`），无同机制开放任务；`task-granularity-advice --touches …` 返回 `peers: []` / `mentions: []` ⇒ 独立立案、不合并。同区域的 `gap-ac323`、`gap-live-voice-phantom-resend-exit-pair-and-no-new-heard-guard` 都 `done`，只作为上面「要退的钉子」被引用。

## AC

- [ ] AC1 单测（夹具用本轮真实串）：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-interrupt-correction-delivery.test.ts server/modules/voice-realtime/tests/voice-realtime-unclaimed-utterance-relay.test.ts` 退出 0；新增/变更的断言「有 response 的段不再把 heard 文本补在模型话前面」在改动前是红的；夹具逐字含 `来望也` 与 `十月十五日，LiveWire 第一次测试。`（`grep -c "来望也" server/modules/voice-realtime/tests/*.ts` ≥ 1）；`grep -rn "fragment-coverage" server/ e2e/` 无输出（模块删净、无悬空 import）。
- [ ] AC2 反向读数（判别性保留）：把处置 #3（`MODEL_TEXT_REPLY` 兜底）临时置空再跑它的单测 ⇒ **红**，证明「无 response 才 fallback」那一支仍被钉住；假形态已还原（`git status --porcelain` 干净）。
- [ ] AC3 整文件判据退出 0：`DASHSCOPE_API_KEY= bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-intent-control.spec.ts` 输出 `8 passed` / `0 failed` / `0 did not run`；用例 4 已退回原读法（PHRASE 不在队列、draft 含 PHRASE 两半都还有读数），注释写明本裁定。必须整文件跑，不得用 `-g` 子集代替。
- [ ] AC4 反 gaming：`git diff develop -- e2e/voice-realtime-intent-control.spec.ts` 里用例 4 的两半读数都在；`grep -c "never-relayed\|re-home" e2e/voice-realtime-intent-control.spec.ts` ≥ 1。

## DoD

真落地 = 在真上游的 e2e 运行里，一段音频只产生**一条**进 CLI 的文本。以该次运行的 e2e data-dir 工件为证：`voice-realtime-log/<connectionId>.jsonl` 里该段只有一条 `{"kind":"session_send"}`，其 `message` 逐字等于模型那条、不含 ASR 错听（`来望也` 不再出现在任何投递文本里），同时整文件 `8 passed`。夹具/单测绿是必要条件不是充分条件；不许只留下一个把断言删掉的绿，也不许把 #3 的兜底一并删掉来充「只用 response」—— 那会让真正没被任何 response 应答的句子静默消失（`8fe60310` 的形态）。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-fragment-coverage.ts
- server/modules/voice-realtime/tests/voice-realtime-fragment-coverage.test.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt-correction-delivery.test.ts
- server/modules/voice-realtime/tests/voice-realtime-unclaimed-utterance-relay.test.ts
- e2e/voice-realtime-intent-control.spec.ts
- goals/AC-345-live-voice-意图控制浏览器验收-scripted-fake-paced-audio-playwright-覆盖.md
- tasks/gap-live-voice-one-text-per-segment-prefer-response.md
