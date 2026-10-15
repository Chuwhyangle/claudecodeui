---
id: gap-ac345-correction-span-guard-folds-unclaimed-phrase
title: AC-345 用例 4 判据红：中断的 correction 走了 session_send 的跨度守卫（bc6b9335e），把「听了未转发」的
  PHRASE 折进投递 ⇒ CLI 队列里出现该句 ⇒ spec.ts:1381 退出 1
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-345
---
## Proposal

**判据**（AC-345 的 criterion，逐字）：

```
f=e2e/voice-realtime-intent-control.spec.ts; [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; DASHSCOPE_API_KEY= npx playwright test "$f"
```

**本轮直接现测（不是台账尾巴）**。在 `/data/home/yale/work/claudecodeui`（HEAD `092234227`，branch `author`）按 AGENTS.md 套 `bash scripts/with-memory-cap.sh`、`DASHSCOPE_API_KEY=` 置空直跑整文件，读数逐字：

```
✘  4 … :1321:3 › an upstream disconnect during the interrupt loses no backlog, and the phrase that never made it re-homes into the composer (7.2s)
  Error: a never-relayed phrase cannot be in the queue
1 failed
4 did not run
3 passed (49.4s)
EXIT=1
```

（与台账同源：台账唯一 fail 行 `2026-10-15T22:09:37.736Z` / tree `62636d301`，`payload.reason` 只含 webServer 引导 stderr——真实断言在 e2e 工件 `quay-e2e-2Iqchu/test-results/voice-realtime-intent-cont-ba06e--re-homes-into-the-composer/error-context.md`；见 [[quay-ledger-red-with-only-boot-stderr-read-the-e2e-artifact]]。）

**红在哪一行**：`e2e/voice-realtime-intent-control.spec.ts:1381`

```ts
expect(order.some((text) => text.includes(PHRASE)), 'a never-relayed phrase cannot be in the queue').toBe(false);
```

`PHRASE = 'and this phrase is never relayed to the session'`（用例 4 里模型听进、却从未转发的那句）。

**本轮那次运行的 relay journal 直接给出被判成「在队列里」的那条投递文本**（`<dataDir>/voice-realtime-log/feecf3bc-2995-40a4-9226-67361994c063.jsonl` 第 35 行）：

```json
{"kind":"session_send","outcome":"delivered",
 "message":"and this phrase is never relayed to the session\n\nno — hold the queue together and fix the reconnect path"}
```

CLI 队列里那条 = `PHRASE \n\n CORRECTION`，所以 `includes(PHRASE)` 为真。

**机制**。`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 的 `sessionInterrupt`（:4112）在投递中断的更正前，让它「走与 `session_send` 相同的跨度守卫」——`:4176` 起：

```ts
const heardLeftOut = !segmentedRelay && correctionText !== ''
  ? selectUncoveredFragments(
      transcribedSinceWatermark.filter((id) => itemTranscriptEmpty.get(id) === false)
        .map((id) => itemTranscriptText.get(id) ?? '').filter((t) => t.trim() !== ''),
      correctionText)
  : [];
const correction = mergesHold
  ? [held, ...heardLeftOut, correctionText].filter(Boolean).join('\n\n')
  : [...heardLeftOut, correctionText].filter(Boolean).join('\n\n');
```

PHRASE 的 `transcription.completed` 落进 `transcribedSinceWatermark`（:4670），此后没有 `session_send` 清它；中断时 `selectUncoveredFragments(['and this phrase is never relayed to the session'], CORRECTION)` 判它未被覆盖（`voice-realtime-fragment-coverage.ts`，`COVERED_PAIR_SHARE=0.5`、`MIN_JUDGED_CHARACTERS=5`）⇒ 被折到更正前面投递。journal 里模型自己的 `session_interrupt.heard` 只有 CORRECTION —— 这句是 relay 的守卫自己加的，不是模型声称听过的。

**引入这个折入的提交**：`bc6b9335e`（2026-10-15 23:54 +0800，`fix(voice): an interrupt's correction rides the closing turn and is delivered once`），在 HEAD 历史内，晚于判据文件最后一次改动 `ec18ce10b`（2026-10-15 17:30）。该提交正文第二点逐字：*"the correction … now runs the same span guard as session_send (heard sentences its words do not cover go in front, verbatim)"*。用例 4 建立在「PHRASE 在模式结束时仍未被认领」这一前提上；`bc6b9335e` 之后它已被更正投递，前提不再成立。

**为什么上一轮修复没顶住**。认领 AC-345 的前驱任务（`gap-live-voice-intent-control-browser-e2e` 及三个 gap 修复 `gap-ac345-pending-card-absent-hold-not-engaged` / `gap-ac345-interleave-extra-silent-queue-push` / `gap-ac345-gate-deadline-below-criterion-wallclock`）都已 `done`，各自修的是**用例 1 / 用例 2 / 闸预算**。但判据文件开头是 `test.describe.configure({ mode: 'serial' })`（≈:618）：用例 1 红时用例 2–8 报 "did not run"，**用例 4 在用例 1–3 全绿之前根本不可达**。三个前驱把 1–3 修绿后，用例 4（其红由更晚的 `bc6b9335e` 造成）才第一次被走到。形态即 [[serial-spec-hides-later-reds-a-one-red-ledger-lies]]：单个 case 的绿 ≠ 判据绿。

**serial 级联已扫**。用例 5–8 在整文件跑里报 "did not run"；本会话已单跑复核，四例全绿（`4 passed (59.7s)` / `EXIT=0`），故本轮**唯一真红是用例 4**，scope 限于它，不用去追那 4 条。

<!-- dedup-ref -->
去重与粒度：当前任务库**没有**任何 in-flight（todo/ready/needs-human）任务以 `goal_ac: AC-345` 认领本判据；`gap-live-voice-intent-control-browser-e2e` 与 3 个 `gap-ac345-*` 均 `done`，它们不是重复，而是「上一轮修复没顶住」的证据。本任务与它们无前置关系，独立重立。`task-granularity-advice` 对计划 Touches 报 `peers: []` / `mentions: []`，无合并候选。

**两条候选裁定（执行者必须择一并给证据）**：

1. **产品回归（leading）**。AC-345 的 `expect` 对用例 4 的字面契约是「中断途中上游断连 ⇒ backlog 不丢、**转 composer**」；`docs/proposals/voice-realtime-persistent-control-SPEC.md:410` 亦逐字「上游 realtime 断连 … backlog 不得因此丢失（转 composer）」。若「听了未转发」的那句在模式退出时必须回到 composer，则 `bc6b9335e` 让它被更正投递，等于把人自己的话吞进了会话。修在 `sessionInterrupt` 的守卫（例如：只在被模型/更正认领时才折入；或断连/退出路径不折入、留给 composer 回流），并补单测。
2. **判据假阳性（择此须引文）**。若裁定 `bc6b9335e` 的守卫是对的（该句确应随更正投递，免得下一轮重复投递——提交正文的动机），则用例 4 的前提已过期，须按 SPEC §18.4 / D 系列与 AC 的 `expect` 重锚 `:1381` 与 `:1388–:1389`，并保留一条**能被反向读数红掉**的判别断言。

⛔ 不许把判据变绿做成「删 / 注释掉 `:1381`」——那是 [[ac-must-verifiable-before-landing]] 意义上的假绿。

## AC

- [ ] 整文件判据退出 0：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-intent-control.spec.ts`（外层按 AGENTS.md 套 `bash scripts/with-memory-cap.sh`）输出 `8 passed`，且 `0 failed` / `0 did not run`；必须整文件跑，不得用 `-g` 子集代替。
- [ ] 归因三分写进 Notes：真回归 / 判据假阳性 / 环境红，并给出所依据的 SPEC / AC 引文（走裁定 2 时必需）。
- [ ] 若改产品代码：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-interrupt-correction-delivery.test.ts` 退出 0，且新增/变更的断言在改动前是红的。
- [ ] 反 gaming：`git diff develop -- e2e/voice-realtime-intent-control.spec.ts` 中用例 4 仍有一条判别性读数（原 `:1381` 或等价重锚），`grep -c "never-relayed\|re-home" e2e/voice-realtime-intent-control.spec.ts` ≥ 1。

## DoD

判据文件在**落地的 develop 树**上整文件退出 0（`8 passed` / exit 0），以该次运行的 e2e data-dir 工件为证（`test-results/.last-run.json` `status:"passed"`，8 例无 failed）。把「产品回归 or 判据假阳性」的裁定与 SPEC/AC 引文一并落进任务 Notes 与（若走重锚）spec 注释；若改守卫，其注释要写清「哪种 heard 句会被折入、哪种不会」。不许只留下一个删掉断言的绿。

## Touches

- e2e/voice-realtime-intent-control.spec.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt-correction-delivery.test.ts
- goals/AC-345-live-voice-意图控制浏览器验收-scripted-fake-paced-audio-playwright-覆盖.md
- tasks/gap-ac345-correction-span-guard-folds-unclaimed-phrase.md
