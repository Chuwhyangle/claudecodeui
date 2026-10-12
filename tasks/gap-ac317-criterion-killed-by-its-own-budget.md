---
id: gap-ac317-criterion-killed-by-its-own-budget
title: AC-317 判据即便内容为真也被自己的闸预算杀掉：记录未声明 timeoutMs（逐字节同判据的姊妹 AC-315 声明 115000，其
  60s 超时串在声明落地那一刻结束）；本轮实测修好内容后整文件 7 passed / exit 0 / wall 67s > 60000ms 默认 ——
  不声明预算，台账尾永远读出 not-evaluated(timeout) 而不是 pass
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac316-restore-criterion-two-regressions
goal_ac: AC-317
---
## Proposal

### 本轮直接测量（不是台账尾巴），树 `d449486a`（= 台账最新 fail 记录的 treeSha）

AC-317 的 criterion 是两条命令的合取：

```
npx playwright test e2e/voice-realtime-upload-fixture.spec.ts && npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
```

1. **第二条命令确定性绿**：`tests 19 / pass 19 / fail 0`，exit 0（1.69s）。AC-317 的结构性保证（bridge 对 `conversation.item.input_audio_transcription.delta` / `.completed` 各有 dispatch 分支、转发为 outbound `caption` 帧、caption 文本与 `session_send` 的 `message` 是两条互不相通的通路）**成立，未回退**。
2. **第一条命令 exit 1**：全文件 `1 failed, 3 did not run, 3 passed (38.8s)`；`-g "three transcriptions of one thought"` 单独跑同样 exit 1 ⇒ **确定性红，不是负载 flake**。红在 `:1337`（`Math.max(counts) <= 1`，`counts=[0,1×60,2×8]`）与 `:1343`（`toHaveCount(1)` 收到 2，14 次轮询）。
3. **该内容红已被在飞任务认领，本任务不重复修**：`gap-ac316-restore-criterion-two-regressions`（status `ready`，`goal_ac: AC-316`）的「根因二」逐字就是它 —— `14b8e9ed` 把 `useVoiceRealtimeSession.ts:963` 的 `carried` 从「全部未归属 final caption」改成 `relayed === '' ? [] : matched.length > 0 ? matched : pending.slice(-1)`，rewrite 形态的中继只认领最后一条待定 caption，折叠行（`placeCaptions.ts` 的 `foldCaptionsIntoTranscriptRow`，行 id 取首条 `voice-caption-<itemId>`）于是存活并与交付行并存。该任务 Touches 正是 `useVoiceRealtimeSession.ts` / `placeCaptions.ts` / `e2e/voice-realtime-upload-fixture.spec.ts`，其 AC3(b) 已把 `:1337`/`:1343` 定为取假形态。⛔ 本任务不得再动这三类文件。

### 本任务闭合的是未被认领的那一半：闸预算

4. `goals/AC-317-*.md` 的 frontmatter **没有 `timeoutMs`**；姊妹 AC-315 的 criterion 与本 AC **逐字节相同**（同一条 `... upload-fixture.spec.ts && ... protocol-simulation.test.ts`），却声明了 `timeoutMs: 115000`。
5. 台账对照（同一命令、同一窗口）：

   - **AC-317（无声明）**：`2026-10-11T11:54:57` / `17:34:23` / `22:01:47` / `2026-10-12T02:02:14` 连续四条 `not-evaluated (timeout): acceptance timed out after 60000ms (killed)`，随后 `06:58:33` / `07:01:31` 两条 fail。
   - **AC-315（有声明）**：自己的 60s 超时串（`2026-10-11T12:13`–`13:40Z`）在 `753d249f` 于 `13:36:16Z` 声明 timeoutMs 之后**当刻结束**，`13:47:03Z` 起连续 pass。AC-323（115000）、AC-331（118000）、AC-332（100000）同一惯例。
6. **实测 wall（本任务的核心读数）**：在本树做单变量受控实验 —— 把 `:963` 暂时恢复成 `carried = pending`（随后立即还原：POST hash == PRE hash `37561fb35eb68edee62508082d317773fe1f2dc6`，`git status --porcelain` 空），整文件读数 **`7 passed (1.1m)`、exit 0、wall 67s**。⇒ 内容修好之后，这条命令本身就 > 60000ms 默认；不声明预算，闸仍会把它杀成 `not-evaluated (timeout)`，**永远读不出 pass**。这就是「内容为真 ≠ 判据可读为真」。

### 为什么早先的 done 没止住

<!-- dedup-ref --> `gap-live-voice-realtime-asr-caption-transcript`（done）交付的实现仍成立（第二条命令今天绿，interim 去重也仍成立 —— 交付前的 user 行计数全程为 1）；`gap-ac317-upload-fixture-criterion-nondeterministic`（done）修的是判据自身的时序（fixture 可提交性 + 往返窗有界重放），且明确「⛔ 不改 `goals/**`」，从未碰过 `timeoutMs` —— 本条是它够不到的机制。内容那一半由在飞的 `gap-ac316-restore-criterion-two-regressions` 认领，故不在本任务范围内。

### 已知限制（登记，不在本任务改）

AC-317 的判据第一条命令跑的是**整份 serial spec 文件**，其中还载有姊妹 AC（AC-326 / AC-327 / AC-331 等）的用例，所以 AC-317 的裁决与它们耦合：任一条红都会把本 AC 判红。收窄判据属人的裁定，本任务不改 criterion 文本。

### 边界 / 不做

- ⛔ 不改 AC-317 的 `criterion` / `expect` 文本（只加 frontmatter 一行 `timeoutMs`）。
- ⛔ 不动 `useVoiceRealtimeSession.ts` / `placeCaptions.ts` / `e2e/voice-realtime-upload-fixture.spec.ts` —— 内容红归在飞的 AC-316 任务，本任务重复编辑那三处会与其并发改同一行。
- ⛔ 不加 retries / skip、不放松任何断言、不改 `playwright.config.ts`。
- 若依赖任务尚未落地致使内容仍红：如实登记并停在 `depends_on` 上，**不得把「预算已声明」写成「判据已绿」**。

## AC

- [ ] AC1（预算声明，承重）`goals/AC-317-*.md` 的 frontmatter 出现 `timeoutMs`，取值 ≥115000；回读（frontmatter / `goal_get`）证明该字段存在，并在任务或 commit 里写明依据：与逐字节同判据的姊妹 AC-315 取齐 + 本轮实测 wall 67s。
- [ ] AC2（端到端翻绿，承重）依赖任务落地后，AC-317 的 criterion 命令 exit 0，登记逐字读数与 wall；且该轮 AC-317 的闸裁决为 `pass` —— `gate_log AC-317` 的最后一条 `verdict` 为 `pass`（不是 `not-evaluated`）。
- [ ] AC3（取假形态）同一命令留红/绿两组读数：以旧默认（`timeoutMs`/`--timeout` = 60000）跑一次得 `not-evaluated (timeout): acceptance timed out after 60000ms (killed)`，以声明预算跑一次得 `pass`；读数须落在 `wall ∈ (60000ms, 声明预算)` 区间内。
- [ ] AC4（判据未改）`git diff` 对 `goals/AC-317-*.md` 的新增/删除行只有一行（新增的 `timeoutMs:`）；`criterion` 与 `expect` 文本逐字节相同。
- [ ] AC5（静态门）`npm run typecheck` exit 0；相对 develop 无新增 lint 诊断。

## DoD

真实落地：AC-317 的台账尾由 `fail` / `not-evaluated` 翻成 **pass**，留下那一轮的 wall 读数与闸裁决（`gate_log AC-317` 的 `verdict: pass`），而不是「我加了配置」的自述；声明本身落在 store 的提交里。⛔ 不得以「预算已声明」替代「判据已绿」：若依赖未落地而内容仍红，如实登记并停在 `depends_on` 上。

## Touches

- goals/AC-317-实时-asr-interim-final-transcript-作为用户消息展示-不混入模型推理输入-依赖-ac-316.md（仅 frontmatter 的 `timeoutMs` 一行；criterion/expect 文本不动）
- tasks/gap-ac317-criterion-killed-by-its-own-budget.md（self）

## Notes

- 判据本体（`goals/AC-317-*.md`）**不是**本任务的「测试文件」：本任务不写代码，它的验收读数就是 AC-317 自己那条 criterion 命令的闸裁决（`gate_log AC-317` 的 `verdict`）与 wall。`e2e/voice-realtime-upload-fixture.spec.ts` 只被**读取/执行**用于取证，⛔ 不在本任务 Touches 内，因为它由在飞的 `gap-ac316-restore-criterion-two-regressions` 独占。
- 本条与在飞任务的机制不同、交付面不相交（前者改 `useVoiceRealtimeSession.ts:963` 的归属启发式，后者只改 `goals/**` 的一行预算），故按 granularity 判为 **separate**；Touches 无重叠，scheduler 不会把它们串行到互相阻塞。
