---
id: gap-ac345-correction-span-guard-folds-unclaimed-phrase
title: AC-345 用例 4 判据红：中断的 correction 走了 session_send 的跨度守卫（bc6b9335e），把「听了未转发」的
  PHRASE 折进投递 ⇒ CLI 队列里出现该句 ⇒ spec.ts:1381 退出 1
status: ready
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

- [x] 整文件判据退出 0：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-intent-control.spec.ts`（外层按 AGENTS.md 套 `bash scripts/with-memory-cap.sh`）输出 `8 passed`，且 `0 failed` / `0 did not run`；必须整文件跑，不得用 `-g` 子集代替。
- [x] 归因三分写进 Notes：真回归 / 判据假阳性 / 环境红，并给出所依据的 SPEC / AC 引文（走裁定 2 时必需）。
- [x] 若改产品代码：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-interrupt-correction-delivery.test.ts` 退出 0，且新增/变更的断言在改动前是红的。
- [x] 反 gaming：`git diff develop -- e2e/voice-realtime-intent-control.spec.ts` 中用例 4 仍有一条判别性读数（原 `:1381` 或等价重锚），`grep -c "never-relayed\|re-home" e2e/voice-realtime-intent-control.spec.ts` ≥ 1。

## DoD

判据文件在**落地的 develop 树**上整文件退出 0（`8 passed` / exit 0），以该次运行的 e2e data-dir 工件为证（`test-results/.last-run.json` `status:"passed"`，8 例无 failed）。把「产品回归 or 判据假阳性」的裁定与 SPEC/AC 引文一并落进任务 Notes 与（若走重锚）spec 注释；若改守卫，其注释要写清「哪种 heard 句会被折入、哪种不会」。不许只留下一个删掉断言的绿。

## Notes

**裁定＝判据假阳性**（用例 4 的前提过期），守卫按设计行为保留，**未改产品代码**。归因三分：真回归 **否**；判据假阳性 **是**；环境红 **否**（同一条命令在本会话整文件跑绿，见「读数」）。

**引文与证据链（裁定 2 的必要项）**

- **裁定源**"every finished sentence is delivered"（2026-10-14）：`server/modules/voice-realtime/voice-realtime-fragment-coverage.ts:9` 逐字「"Every finished sentence is delivered" (ruling 2026-10-14) was only enforced when the model answered in TEXT; a call that quietly left a piece out had no net」。
- `ce8a17671`（2026-10-15 23:19，`fix(voice): … a call that drops a heard sentence carries it`）把它落到 **call**（`proceedRelay` 的 `session_send` 跨度守卫），正文逐字「Two older pins are amended with their reason in place: … the "caption never reaches session_send" case uses a message that covers what was heard (**a left-out sentence is delivered by design under the 2026-10-14 ruling**)」。⇒ 同类陈旧钉子的先例是**就地改写并写明理由**，不是回退守卫。
- `bc6b9335e`（2026-10-15 23:54）把它落到**中断的更正**：正文逐字「it now runs the same span guard as session_send (heard sentences its words do not cover go in front, verbatim) and spends the span once the enqueue is confirmed」。动机是 live `259b51e0` 的**重复投递**；守卫本身由单测钉住：`voice-realtime-interrupt-correction-delivery.test.ts`「a heard sentence the correction does not cover goes in front of it verbatim, once」。
- **旁证（同一裁定在别处的落地被记作「正确」）**：`tasks/gap-live-voice-phantom-resend-exit-pair-and-no-new-heard-guard.md`（2026-10-16 01:04 live，已 done）逐字「零新听到的话 ⇒ 所有说出口的话都已投递（**含 span guard 前置的 A**），丢掉这次调用不会丢句」，并把 span guard 前置 A 的那次投递标注「（正确）」。
- **回退守卫反而更糟**：`8fe60310`（2026-10-15 23:02 live）读到「two were captioned and then delivered nowhere」——没有守卫时被漏掉的那句**上了屏、投递无门**；而 `bc6b9335e` 同时加了 `transcribedSinceWatermark.length = 0`，单把折入去掉会让该句**既不被投递、也不留在跨度里**（要两者都对就得另造第三种行为＝猴补丁）。
- **反方引文（已权衡，未采）**：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §18.4 G1 把「修正文本」写成「合并窗口里的待投递片段，或中断调用携带的修正」，字面不含跨度的被漏句；用例 4 的原注释也建立在「模式结束时仍未认领」。但 G1 定的是**最低内容**（2026-10-12 成文，早于 2026-10-14 裁定与两次守卫落地），"每句必投递"是**更晚且明确覆盖 call** 的裁定，且退守卫与 `8fe60310` 的实测形态冲突 ⇒ 不采。

**AC-345 的 `expect` 未被削弱**：该条对用例 4 的字面契约是「中断途中上游断连 ⇒ backlog 不丢、**转 composer**」；重锚后**两半都仍有读数**，并**新增**守卫自身的读数（下表）。

**重锚内容（只改 `e2e/voice-realtime-intent-control.spec.ts` 用例 4；裁定与引文同时写进 spec 注释）**

- `:1381` 原「`PHRASE` 不得在队列里」⇒ 改为：该句**必须随更正投递**，且**在更正之前**（spoken order），整条投递全文打进 `reading.correctionDelivery`：`carrying.indexOf(PHRASE) >= 0 && carrying.indexOf(PHRASE) < carrying.indexOf(CORRECTION)`。
- `:1388` 原「draft 含 `PHRASE`」⇒ 改用**断开时真正未进投递的那句** `STRANDED = 'and the last thing said goes down with the line'`（说完即断线）读 `toContain(STRANDED)`——「转 composer」那一半仍在。
- `:1389` 保留（draft 不含 `CORRECTION`）并**加严**：`not.toContain(PHRASE)`（被投递带走的句子不得回填 composer）。
- 用例标题与文档注释同步改写，注释里写明裁定、引文与「哪种 heard 句会被折入」。
- 旁证：同类「听了未转发 ⇒ 转 composer」读数在兄弟 spec `e2e/voice-realtime-scripted-scenarios.spec.ts:1031`（非中断形态）仍在；本任务未动它。

**反向读数（判别性保留，可被红掉）**：把 `sessionInterrupt` 的 `heardLeftOut` 暂时置空再跑用例 4 ⇒ **红**，实测逐字：

```
Error: the heard sentence the correction did not cover must ride it:
["open the held turn for the disconnect case","[The previous turn was interrupted before it finished. … ]\n\nno — hold the queue together and fix the reconnect path"]
1 failed
```

（撤掉守卫后队列里只剩更正。）该假形态**已还原**：`git checkout -- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`，`git status` 干净。

**读数**

- **整文件判据**：`DASHSCOPE_API_KEY= bash scripts/with-memory-cap.sh npx playwright test e2e/voice-realtime-intent-control.spec.ts` → `8 passed (1.6m)` / `EXIT=0`，`0 failed` / `0 did not run`。data-dir `/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-Hvleko`，`test-results/.last-run.json` = `{"status":"passed","failedTests":[]}`。
- 用例 4 两次读数逐字：
  - `reading.correctionDelivery="[The previous turn was interrupted before it finished. … takes precedence over any conflicting thing said earlier.]\n\nand this phrase is never relayed to the session\n\nno — hold the queue together and fix the reconnect path"`
  - `reading.rehomedDraft="and the last thing said goes down with the line"`
- **守卫单测**（AC3 那条命令）：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-interrupt-correction-delivery.test.ts` → `pass 3 / fail 0` / `EXIT=0`。
- `npx oxlint e2e/voice-realtime-intent-control.spec.ts` → `EXIT=0`（`npm run lint` 的 glob 不含 `e2e/`）。
- anti-drift Touches：`ANTI-DRIFT OK … 1 actual file(s), all within declared Touches` / `EXIT=0`。

**逐条 AC**

- **AC1** ✓ 整文件 `8 passed` / exit 0（非 `-g` 子集）。
- **AC2** ✓ 本节即三分归因与 SPEC/AC 引文。
- **AC3** ✓ **前件为假**：未改产品代码（`git diff develop --stat` 只有 `e2e/voice-realtime-intent-control.spec.ts` 一个文件，52+/11-）。同一条命令仍跑过：`pass 3 / fail 0` / exit 0。
- **AC4** ✓ `grep -c "never-relayed\|re-home" e2e/voice-realtime-intent-control.spec.ts` = **5** ≥ 1；用例 4 的守卫读数有实测的反向红（见上）。

未改：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`、`server/modules/voice-realtime/tests/voice-realtime-interrupt-correction-delivery.test.ts`、`goals/AC-345-live-voice-意图控制浏览器验收-scripted-fake-paced-audio-playwright-覆盖.md`（AC 的 `expect` 未被削弱 ⇒ 判据文本无需改）。

## Touches

- e2e/voice-realtime-intent-control.spec.ts
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-interrupt-correction-delivery.test.ts
- goals/AC-345-live-voice-意图控制浏览器验收-scripted-fake-paced-audio-playwright-覆盖.md
- tasks/gap-ac345-correction-span-guard-folds-unclaimed-phrase.md
