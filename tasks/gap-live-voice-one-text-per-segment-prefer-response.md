---
id: gap-live-voice-one-text-per-segment-prefer-response
title: live-voice 每段音频只许一条文本进 CLI：有 response 就只用 response，仅当该段无任何 response 应答才
  fallback 到 ASR transcript —— 删掉 session_send 与 correction 把 transcript
  补在模型话前面的跨度守卫，并退回 AC-345 今天的重锚
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

- [x] AC1 单测（夹具用本轮真实串）：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-interrupt-correction-delivery.test.ts server/modules/voice-realtime/tests/voice-realtime-unclaimed-utterance-relay.test.ts` 退出 0；新增/变更的断言「有 response 的段不再把 heard 文本补在模型话前面」在改动前是红的；夹具逐字含 `来望也` 与 `十月十五日，LiveWire 第一次测试。`（`grep -c "来望也" server/modules/voice-realtime/tests/*.ts` ≥ 1）；`grep -rn "fragment-coverage" server/ e2e/` 无输出（模块删净、无悬空 import）。
- [x] AC2 反向读数（判别性保留）：把处置 #3（`MODEL_TEXT_REPLY` 兜底）临时置空再跑它的单测 ⇒ **红**，证明「无 response 才 fallback」那一支仍被钉住；假形态已还原（`git status --porcelain` 干净）。
- [x] AC3 整文件判据退出 0：`DASHSCOPE_API_KEY= bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-intent-control.spec.ts` 输出 `8 passed` / `0 failed` / `0 did not run`；用例 4 已退回原读法（PHRASE 不在队列、draft 含 PHRASE 两半都还有读数），注释写明本裁定。必须整文件跑，不得用 `-g` 子集代替。
- [x] AC4 反 gaming：`git diff develop -- e2e/voice-realtime-intent-control.spec.ts` 里用例 4 的两半读数都在；`grep -c "never-relayed\|re-home" e2e/voice-realtime-intent-control.spec.ts` ≥ 1。

## DoD

真落地 = 在真上游的 e2e 运行里，一段音频只产生**一条**进 CLI 的文本。以该次运行的 e2e data-dir 工件为证：`voice-realtime-log/<connectionId>.jsonl` 里该段只有一条 `{"kind":"session_send"}`，其 `message` 逐字等于模型那条、不含 ASR 错听（`来望也` 不再出现在任何投递文本里），同时整文件 `8 passed`。夹具/单测绿是必要条件不是充分条件；不许只留下一个把断言删掉的绿，也不许把 #3 的兜底一并删掉来充「只用 response」—— 那会让真正没被任何 response 应答的句子静默消失（`8fe60310` 的形态）。

## Notes

落地（2026-10-16，worker 会话；实现 commit `0b9e9abba`）。

**AC1**：两文件 7 用例退出 0（含新增的「a segment whose response repaired the endpoint mishearing sends the model's words alone」——夹具逐字 `来望也` / `十月十五日，LiveWire 第一次测试。`）。反向读数：把两处守卫用 `git stash` 还原成改动前源码后，**3 条新增/变更断言全红**（unclaimed ×1、partial-relay ×1、interrupt-correction ×1），其中 `session_send` 那条正是「有 response 的段不再把 heard 文本补在模型话前面」。`grep -c "来望也"` = 3 个文件（1/2/4 次）；`grep -rn "fragment-coverage" server/ e2e/` **无输出** —— 连解释缺席的散文也改写成了不落该字面量的说法（`absence-ac-grep-counts-the-prose-that-explains-the-absence`）。

**AC2**：`MODEL_TEXT_REPLY` 兜底的判据临时置 `false &&` ⇒「a text reply delivers the unanswered sentences verbatim…」**红**（1 failed / 3 passed），`git checkout` 还原后 `git status --porcelain` 空。

**AC3**：整文件 `8 passed (1.6m)`，退出 0（无 failed / did not run 行）。用例 4 退回原读法：队列断言 `a never-relayed phrase cannot be in the queue`（PHRASE 不在队列）+ 草稿断言 `toContain(PHRASE)`，两半都在；注释写明本裁定取代了 `8c3c60c99`/`af3f21b9b` 的重锚，并写明反方理由由 composer 回填回答。

**AC4**：`git diff develop -- e2e/voice-realtime-intent-control.spec.ts` 两半读数在；`grep -c "never-relayed\|re-home"` = 5。

**DoD 读数（AC3 那次运行的 e2e data-dir）**：`quay-e2e-nYVN0Y/voice-realtime-log/*.jsonl` 里**没有任何** `delivered verbatim in front` 行（该日志行随守卫一并消失）；每条 `{"kind":"session_send"}` 的 `message` 逐字等于模型那次 call 的参数（如 `and keep the parser change small` / `and then I said this out loud` / `no — take the other direction instead`），无拼接的 ASR 文本；`来望也` 不出现在任何工件里。唯一多段拼接的投递是忙时 hold + correction 的合并（`open the held turn … sync job\n\nno — leave the sync job alone…`），那是被保持的**该句自己的话**，不是旁听句（处置 #1/#2 之外，属保留语义）。真上游那次 ASR 错听本身无法在 scripted 假上游里复现，故 `来望也` 的形态由 AC1 夹具逐字钉住。

**计划外但必须一起改的兄弟钉子**（守卫删除的连带面，非本任务立案时的估计）：
- `server/modules/voice-realtime/tests/voice-realtime-partial-relay-fragments.test.ts`（`session_send` 侧守卫的专属单测）：首例翻转为新读数；另加一条否定读法。
- `server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts` leg B：其第二半（44 s 后那条 A 的改写被当作回声拒绝）**依赖**守卫先把投递变成「A B」；守卫删掉后那条 call 是 A 自己的 response（会话并不持有它的字），`relayRestatesDelivery` 只拒「末次投递的重述」，故它现在**被投递**——这恰是「一段一条文本」的另一半。回声的拒绝改由同句省一字的连续改写（子序列但非连续）钉住，leg B 的 false form 一并重锚到该形态，判别性保留（mutant 下该改写被投递 ⇒ `assert.throws` 成立）。
- `server/modules/voice-realtime/tests/voice-realtime-continuous-empty-guard-span.test.ts` AC3 false form：mutant（水位不推进）下的读数改为「只带模型自己的话」。
全库 voice-realtime 单测 612/612 绿；`tsc --noEmit`（server 与 root 两份 tsconfig）退出 0。`goals/AC-345….md` 未改：其 expect 的用例 4 读法（backlog 不丢、转 composer）与本裁定一致，重锚期间反倒不一致，退回后自动对齐。

**本轮续做（exited-not-landed 续轮，2026-10-16）**：上一轮 suite 的唯一红腿在 `server/shared/tests/quay-test-script.test.ts`（fan-in 日志 headline 报的是同文件另一条**通过**的用例，属 log-layout artifact）。真因是两条**全树测试文件计数钉**：本任务删掉 `voice-realtime-fragment-coverage.test.ts` 后，`find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort | wc -l` 从 347 落到 346，而 AC2/AC3 仍钉 347（`known=3 unknown=344` / `known=1 unknown=346`）。该 test 文件与 develop 逐字相同 ⇒ 它钉的是**树**、不是本分支 delta，delta-relatedness 的 one-hop 判定因此报 UNRELATED（假阴性）。按其自述「a moving target, so the pin is re-measured, never derived」重测后改动两处字面量与散注（`346 - 3 = 343`、`346 - 1 = 345`），并把该文件补进 `## Touches`。单文件复跑 **14/14 绿**。`scripts/suite-duration-baseline.tsv` 不需要动：被删文件本无行、无判据断言其计数，AC7 的 90% 地板仍成立（338/346 = 97.7%）。AC1 两文件复跑 **7/7 绿**（含「a segment whose response repaired the endpoint mishearing sends the model's words alone」），AC3 整文件复跑 **8 passed (1.6m)**；本次改动不触及任何 voice 代码路径。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-fragment-coverage.ts
- server/modules/voice-realtime/tests/voice-realtime-fragment-coverage.test.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt-correction-delivery.test.ts
- server/modules/voice-realtime/tests/voice-realtime-unclaimed-utterance-relay.test.ts
- server/modules/voice-realtime/tests/voice-realtime-partial-relay-fragments.test.ts
- server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts
- server/modules/voice-realtime/tests/voice-realtime-continuous-empty-guard-span.test.ts
- e2e/voice-realtime-intent-control.spec.ts
- goals/AC-345-live-voice-意图控制浏览器验收-scripted-fake-paced-audio-playwright-覆盖.md
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-live-voice-one-text-per-segment-prefer-response.md

## Blocker

**2026-10-16T05:55:09.589Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=70592 server/shared/tests/quay-test-script.test.ts passed=false end_ms=1792129791030
- run_id：wk-prod-anchor
- session_id：9fa204aa-c9bb-45c4-99c1-47e2242f14fe
