---
id: gap-goal-038-ac323-regression-ac
title: GOAL-038 退出条件 3 的「AC-323 的三条 e2e spec 链」无在域 AC 覆盖：提议新增一条既有判据回归 AC（AC-323
  三链 + typecheck 一字不改仍绿）
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
  needs_human_cause: human-adjudication
  park_reason: 跟进提案：GOAL-038（sufficiency verdict = insufficient）的在域 AC 集 {AC-326,
    AC-327} 未读到退出条件 3 逐字点名的「AC-323 的三条 e2e spec 链」，退出条件 5 的 `npm run typecheck`
    亦只在两条 AC 的 prose 里、不在任何 criterion 命令中。本任务只提议新增一条 AC、不实现、不写 goals/*.md、不改任何
    GOAL/AC 状态；须人裁定是否采纳。
---
## Proposal

选型 **(a)：新增一条 AC**——把 GOAL-038 `## 退出条件` 第 3 条里**唯一未被在域 AC 集读到的承重项**「AC-323 的三条 e2e spec 链」立成一条可运行判据的**既有判据回归 AC**，并顺带把退出条件第 5 条的 `npm run typecheck` 从 prose 提升为判据命令。**本任务只提议：不写 `goals/*.md`，不改任何 GOAL/AC 状态，不实现任何代码**；由人裁定后经被授权的 goal 写入路径在 goal ABI 里落地。

### 未被覆盖的部分（逐字引用）

GOAL-038 `## 退出条件` 第 3 条逐字为：

> 既有判据一字不改仍绿：AC-317 的 `e2e/voice-realtime-upload-fixture.spec.ts` 三条既有用例（含「words heard and relayed verbatim appear once」与交付后原声行计数为 0 的断言）、AC-323 的三条 e2e spec 链、协议模拟套件。

同节第 5 条逐字为：

> `npm run typecheck` exit 0。

这一条退条件点名的既有判据有三件，在域 AC 集 {AC-326, AC-327} 的覆盖情况如下：

| 退出条件 3 点名的既有判据 | 在域 AC 是否读到 |
|---|---|
| AC-317 的 upload-fixture 三条既有用例 | ✅ AC-326 (d) / AC-327 (d) 明写；且两条 AC 的 criterion 各自含 `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts` |
| **「AC-323 的三条 e2e spec 链」** | ❌ **无任何在域 AC 提到 AC-323，也没有任何判据命令跑它的三个 spec** |
| 协议模拟套件 | ✅ AC-327 的 criterion 跑 `server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`，且 (d) 明写「既有 `state`/`ready`/`caption`/`sent`/`segment_ack`/`error` 帧的集合与相对顺序不变」 |

退出条件 5 的 `npm run typecheck` 同样欠读：它只出现在 AC-326 (d) 与 AC-327 (d) 的 **prose**（「(d) 既有判据不得变红：……`npm run typecheck` 退出 0」），**不在任何 AC 的 criterion 命令里**——没有任何一条判据会在 `typecheck` 红时 exit 非 0。

「AC-323 的三条 e2e spec 链」= AC-323 的 criterion 三条命令链，逐字为：

```
npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts
npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime
npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "
```

### 为何现有 AC 集不覆盖它

AC-326 的 criterion 是 `test:client -- …/voiceSingleTranscriptRow.test.ts` && `test:client -- …/useVoiceRealtimeSession.test.tsx` && `playwright …/voice-realtime-upload-fixture.spec.ts`；AC-327 的 criterion 是 `test:client -- …/voiceDeliveryState.test.tsx` && `tsx --test …/voice-realtime-ws-proxy.protocol-simulation.test.ts` && `playwright …/voice-realtime-upload-fixture.spec.ts`。两条都**没有**跑 AC-323 的 `voice-realtime-live-session-send.spec.ts`、`voice-realtime-composer-embedded.spec.ts`、`mobile-workspace-composer-layout.spec.ts -g " idle "`，也**没有**跑 CMD2 的目录过滤器 `src/modules/chat/voice-realtime`（AC-326 只跑该目录下的单个文件）。于是：即便 GOAL-038 的实现把容器内紧凑栏 / 双入口 / 移动端布局搞回归，AC-326、AC-327 的判据仍可能各自 exit 0——退出条件 3/5 读不到，没有任何在域 AC 会因此变红。

### 这个缺口是真的、不是纸面的

GOAL-038 的两条实现任务正好压在 AC-323 的判据面上：

- AC-326（任务 `gap-live-voice-single-transcript-row`）的 `## Touches` 含 `src/modules/chat/ChatInterface.tsx` 与 `src/modules/chat/voice-realtime/{placeCaptions.ts, useVoiceRealtimeSession.ts, index.ts, tests/voiceSingleTranscriptRow.test.ts}`——后者正是 AC-323 CMD2 目录过滤器 `src/modules/chat/voice-realtime` 覆盖的整片；`ChatInterface.tsx` 是 CMD1 `voice-realtime-composer-embedded.spec.ts` 的渲染路径。
- AC-327（任务 `gap-live-voice-delivery-state-visible`）的 `## Touches` 含同一批前端文件（`ChatInterface.tsx` / `useVoiceRealtimeSession.ts`）与同一个 `e2e/voice-realtime-upload-fixture.spec.ts`。
- GOAL-038 `## 非目标` 自己逐字写着「不改底栏即时字幕（**AC-323 的判据钉住它**）」——目标作者已承认 AC-323 的判据是本实现的回归边界，只是没有把它立成一条在域 AC。

### 建议新增的 AC（供人裁定采纳 / 改措辞）

**标题**：GOAL-038 的实现不回归 AC-323 的容器内紧凑栏与双入口判据：AC-323 的三条判据命令链一字不改仍 exit 0，且 `npm run typecheck` exit 0。

**criterion**（四条命令，均 exit 0）：

```
npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts && npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime && npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle " && npm run typecheck
```

**承重结构（防止这条回归 AC 变成空过——本 GOAL 已经吃过一次空过翻绿的坑，见 AC-326 条〇）**：

1. **跑在 GOAL-038 实现落地后的树上**，不是在 `develop` 基线上——基线今天本来就绿（AC-323 已 achieved），只有实现没把它搞红才有信息量。
2. **不许靠放宽 AC-323 的判据换绿**：用 `git diff --exit-code <GOAL-038 合并基>..HEAD -- e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-composer-embedded.spec.ts e2e/mobile-workspace-composer-layout.spec.ts src/modules/chat/tests/composerCompactTier.test.tsx` 守卫——这四份文件 GOAL-038 的两条实现都不该动，diff 为空才算数。唯一例外是 `e2e/voice-realtime-upload-fixture.spec.ts`（AC-326 在其上**新增**用例），其**既有**断言不得改。
3. **取假形态**：在实现树上注入一个紧凑栏回归（例：`listening` 阶段栏高改 `h-20`）⇒ CMD2 红（AC-323 第二节「三态 boundingBox 的 height 与 top 差 ≤2px」）；还原后回绿。证明这条判据会因 GOAL-038 的改动而红，而非恒绿。

### 为何本提案覆盖它，以及为何不选 (b)

退出条件 3 要求「既有判据一字不改仍绿」，而被保护的 AC-323 判据面正是 GOAL-038 改动的直接落点（见上），且被 GOAL-038 自己的 `## 非目标` 逐字承认——**它没有要求超过本目标该做的**，故不是「退出条件写得过多」的形态，不该选 (b) 删/放宽退出条件；缺口在 AC 集那一侧，只能新增 AC。把退出条件 5 的 typecheck 一并提成命令，是同一机制（既有判据不回归）的自然收口。

### 去重与合并候选

<!-- dedup-ref --> 本任务与 `gap-live-voice-single-transcript-row`（AC-326 实现）、`gap-live-voice-delivery-state-visible`（AC-327 实现）不是同一机制：那两条各自实现一个在域 AC，并各自带一条 `(d) 既有判据不得变红` 的 prose 声明；本任务提议的是把「AC-323 三链 + typecheck」这一独立于两者的回归面立成**第 3 条在域 AC**，只提议、不实现。`tasks/` 内无任何 GOAL-038 的 AC / 退出条件提案任务（`ls tasks/ | grep -iE 'goal-?038'` 为空；`grep -rl GOAL-038 tasks/*.md` 只命中 AC-327 的实现任务），无同机制任务，不构成重复立案。merge-candidate（granularity）检查：本任务不跑在任何源码文件上（Touches 仅为 goal 文件与该任务自身），无 open 任务与本任务在同一实质源文件上重叠——**none found**。

## AC

- [x] **AC1 提案落点**：由被授权的 goal 写入路径在 GOAL-038 的在域 AC 集新增一条 AC，其 criterion 逐字为 `npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts && npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime && npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle " && npm run typecheck`，且其 expect 含上面「承重结构」的三条——该行只能由被授权的 goal 写入路径落地（非本 agent）（待外部）
- [x] **AC2 人裁定被记录**：本任务 `## Resolution` 写明人 yale 对 (i) 是否采纳本提案（采纳 / 改措辞 / 不采纳并另立 AC）与 (ii)「一字不改」守卫如何表达（`git diff --exit-code` 四文件白名单，或人指定的等价读法）的裁定——该行只能由人 yale 写入（待外部）
- [ ] **AC3 机械读回：GOAL-038 的 sufficiency 不再是与旧 key 关联的裸 `insufficient`**：AC1 落地并跑过一轮 driver 后，`.quay/goal-round.jsonl` 中 GOAL-038 最新 `goal-sufficiency` 满足——(a) 其对象不再是立案时那条 `{"goal":"GOAL-038","verdict":"insufficient"}`（round 94 / ts `2026-10-10T19:00:57.544Z`，无 `cause=`）；(b) **正面控制**：`.quay/goal-sufficiency-cache.json` 的 `entries` 中存在新的 `sufficiencyCacheKey(GOAL-038, 含新增 AC 的在域集)`（立案时该键为 `09e926a6e75c676e0c5d2cbb791fc133eba3a87b94269ec87dc41f600e551827`；在域集一变，键必变），只有真跑过判官才会写缓存——该行须在落地后读得到（待外部）

## DoD

人 yale 裁定**采纳**后，由被授权的 goal 写入路径（而非本 agent）真实把这条 AC 写进 GOAL-038 的在域集；并在其后的**真实 round log** 中观察到 GOAL-038 的 sufficiency verdict 随之改变（不再是旧的裸 `insufficient`；`.quay/goal-sufficiency-cache.json` 出现新 key 条目为正面控制）。**仅有 AC 文本改动而无后续 verdict 观察不算完成。** 若人裁定**不采纳**，则本任务以 `## Resolution` 记录裁定与理由为完成——此时不改任何 GOAL/AC 状态、不新增 AC。两条路径都不由本 agent 代写 `goals/*.md`。

## Touches

- goals/GOAL-038-live-voice-转写行原地定型-一次语音一行-交付状态线性可见.md
- tasks/gap-goal-038-ac323-regression-ac.md（self）

## Resolution

**人 yale 2026-10-11 对本任务 AC2 两问的裁定**：

- (i) **采纳**本提案：为 GOAL-038 新增这条「既有判据回归」AC。
- (ii) 「不许靠放宽 AC-323 判据换绿」的守卫，采用**四文件白名单 diff** 的形式（`git diff --exit-code <GOAL-038 合并基>..HEAD -- e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-composer-embedded.spec.ts e2e/mobile-workspace-composer-layout.spec.ts src/modules/chat/tests/composerCompactTier.test.tsx`）。

**落地（经 goal 写入 ABI，2026-10-11）**：

- 新 AC 已创建为 **AC-331**（`goal=GOAL-038`、`status=active`），`title` / `criterion` 逐字取自本任务 Proposal 的「建议新增的 AC」段；`expect` 含提案的三条承重结构（跑在实现落地后的树上 / ⛔ 不许放宽 AC-323 判据 + 上面那条四文件白名单 diff / 取假形态：注入紧凑栏回归 ⇒ vitest `composerCompactTier` 必红），并把唯一例外（`e2e/voice-realtime-upload-fixture.spec.ts` 上 AC-326 的新增用例不属白名单）写进 expect。
- GOAL-038 的 `## 退出条件` 小节**未改动**：它不采用 GOAL-037 那种「覆盖：AC-NNN」映射写法，在域集由 AC 记录本身（`goal=GOAL-038`）决定，新增 AC 即入集。

**AC3 仍未勾**：它要的是下一轮 driver 观察——GOAL-038 最新 `goal-sufficiency` 不再是立案时那条裸 `insufficient`（round 94 / `2026-10-10T19:00:57.544Z`），且 `.quay/goal-sufficiency-cache.json` 出现新的 `sufficiencyCacheKey(GOAL-038, 含 AC-331 的在域集)`（立案时的键为 `09e926a6e75c676e0c5d2cbb791fc133eba3a87b94269ec87dc41f600e551827`）。参照：同型做法在 GOAL-037 上已实测生效（新增 AC-328 后 verdict 由 `insufficient` 转 `covered`，连续三轮读数）。
