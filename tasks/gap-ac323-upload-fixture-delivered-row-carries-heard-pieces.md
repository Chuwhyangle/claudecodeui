---
id: gap-ac323-upload-fixture-delivered-row-carries-heard-pieces
title: AC-323 判据红（共用 upload-fixture spec 的 AC-326 用例）：交付行按 2026-10-14
  裁定逐字带上被听片段，读数把那条唯一交付行读成原声残留行 ⇒ 重锚读数，不动投递语义
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-323
---
## Proposal

### 现状（2026-10-16 复核，author checkout；develop tip `bc6b9335e`）

AC-323 判据第一条命令

```
npx playwright test e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts
```

在 develop 上 exit 1，唯一红灯是 `e2e/voice-realtime-upload-fixture.spec.ts:1374`：

```
Error: an utterance was put into the chat area as a row of the client's own;
heardInChat=[0,0,…(45 个 0)…,27,27,27,27,27,27,27]
rows=[[],…,[],["alfa bravo charlie delta echo foxtrot golf hotel india send the summary of the release notes to the team channelTXT…"],…]
expect(received).toEqual(expected)   // Expected []  Received 7 objects {heardInChat:27, texts:[<上面那句>]}
```

台账工件：`.cache/quay-e2e-tmp/quay-e2e-3cbBbR/test-results/voice-realtime-upload-fixt-9fd55-ss-transcription-makes-none/error-context.md`，对应 gate 事件 `2026-10-15T16:41:52Z`（item `AC-323`，verdict fail）。该次运行 `1 failed`，判据第二/三条命令因 `&&` 未被执行；三 spec 的其余用例全绿（含 composer-embedded 的 7 例），故整条 AC-323 判据只因此一处红。

该用例也同属 AC-326 判据（其第三条命令 `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts`）。

<!-- dedup-ref --> 同区、不同机制的在库任务（仅作追溯）：`gap-ac315-upload-criterion-provisional-empty-and-gate-deadline`（done，共用本 spec 的另一处红与门超时）、`gap-ac323-gate-deadline-below-criterion-serial-time`（done，本判据的 timeoutMs 声明）。本任务改的是 ce8a17671 引入的「交付行逐字带上被听片段」这一新机制，与之不同；granularity-advice 对 `e2e/voice-realtime-upload-fixture.spec.ts` 报 `peers: []`，无并行落点。

### 机制（交付行按裁定必然含被听片段，而读数分不清「交付行」与「原声残留行」）

ce8a17671（2026-10-15 23:19，develop）「a call that drops a heard sentence carries it」新增 `server/modules/voice-realtime/voice-realtime-fragment-coverage.ts`：`selectUncoveredFragments` 对每条被听句子与模型消息做字符对重叠判定，未覆盖者**逐字加在模型消息前面**投递（该模块头注释原话：「it decides only whether to ADD the person's own words, verbatim, in front of what the model wrote」）。同一 commit 还把 mid-turn 的 `attachment{queued_command}` 投影成 user 文本行，于是交付消息现在确实作为一条 user 行落在 `.chat-messages-pane` 里。

本 spec 的假上游：模型 `session_send` 发 `ROW_DELIVERED = 'send the summary of the release notes to the team channel'`（`e2e/voice-realtime-upload-fixture.spec.ts:144`），三条被听片段 `ROW_HEARD = ['alfa bravo charlie','delta echo foxtrot','golf hotel india']`（`:134`）与它零重叠 ⇒ 全部被判未覆盖 ⇒ 交付行文本 = 三片段 + ROW_DELIVERED（工件里读到的那句正是如此）。

用例的读数 `chatAreaNodesContaining(page, piece)`（`:731`，`page.locator('.chat-messages-pane').locator('div, span, p', { hasText: piece }).count()`）统计「chat 区里任何含该片段的节点」——那条**唯一、正确、按裁定应存在**的交付行本身含全部三片段，于是每次采样都把它读成「原声自成一行的残留」（27 = 3 片段 × 该交付行子树里的若干 div/span/p）。末尾 `for (const piece of ROW_HEARD) … USER_ROW.filter({ hasText: piece }).count() … toBe(0)`（`:1396`）同因必红。

即：该用例的读数前提——`ROW_DELIVERED` 常量注释原话：「a delivered text that contained a piece would make 'that piece has no row of its own' unreadable (the delivered row itself would match it)」——在 ce8a17671 把 carry 语义落地后不再成立；ce8a17671 当时点名改写了两个兄弟 pin（其提交信息原话：「Two older pins are amended with their reason in place」），唯独漏了这一处。

### 提案（只重锚读数，不动投递语义 / 产品代码 / 判据命令）

在 `e2e/voice-realtime-upload-fixture.spec.ts` 的这条用例里，把读数从「chat 区里出现的词」改为「**不属于那条唯一交付行**的 chat 区节点里出现的词」，使按裁定逐字带上被听片段的交付行不再被算作残留：

1. 采样 `heardInChat`：改为统计「含该片段、且**不含** `ROW_DELIVERED`」的节点（等价实现：排除交付行子树）。交付行及其全部祖先/后代都同时含 `ROW_DELIVERED`，故被排除；读数非 0 就只可能来自真正另起一行的残留。
2. 末尾 per-piece 断言（`:1396`）：把「含该片段且非交付行」的 user 行计数断为 0（如 `filter({ hasText: piece }).filter({ hasNotText: ROW_DELIVERED })`），或以既有 `await expect(owned).toHaveCount(1)` 为准。
3. 保非空转：保留 `shotWhileSpoken`（交付前必须采到「字幕里已有词、chat 区仍无本手势行」的时刻）与非空转断言；并在 AC 里给读数配一个假形态突变体，证明重锚没有把读数改空。

### 边界

- 只改 `e2e/voice-realtime-upload-fixture.spec.ts` 这一条用例的读数与其局部读数辅助；不改 `ROW_HEARD`/`ROW_DELIVERED` 常量、假上游帧序、产品代码、判据命令。
- 与 AC-326 记录 expect 的张力：其 (b)「三段原声转写各自作为 user 行的计数均为 0」在字面上与 2026-10-14 裁定（被听句子必须逐字投递 ⇒ 那条唯一交付行必然含这些词）冲突。本任务按 AC-326 标题的意图（「一次语音只对应一行用户消息」）把读数重锚到「不得**另有**自成一行的残留」；若复核判定 AC-326 的字面判据仍是本仓意图，则冲突属 GOAL-038 侧、需人裁定——但本重锚同时是 AC-323 判据第一条命令能 exit 0 的唯一通道。
- 墙钟提示（非本任务交付）：第一条命令（三 spec 联跑）在本机常态 ≈2.0m，逼近记录里 `timeoutMs=115000`（驱动 spawn 上限 `12e4`），近期多次以 `not-evaluated(timeout)` 收场。本重锚不使其更慢（用例在交付后 `ROW_SETTLED_MS=500ms` 即 break）。worker 请贴三命令串行墙钟；若仍逼近上限，另开「判据拆分」任务（同族已见 criterion-serial-over-driver-spawn-cap）。

## AC

- [x] `npx playwright test e2e/voice-realtime-upload-fixture.spec.ts -g "no utterance of one thought"` 退出码 0（重锚后单跑）。— 实测 exit 0，`1 passed (17.2s)`；ledger `heardInChat=[0×53]`。
- [x] AC-323 判据第一条命令（live-session-send + upload-fixture + composer-embedded 三 spec 联跑）退出码 0，并贴 pass 计数。— 实测 exit 0，`18 passed (2.0m)`，墙钟 121s。
- [x] 整条 AC-323 判据三命令串行退出码 0：①三 spec playwright；②`npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx src/modules/chat/voice-realtime`；③`npx playwright test e2e/mobile-workspace-composer-layout.spec.ts -g " idle "`。— 实测三条串行 exit 0/0/0，墙钟 147s/5s/25s（总 177s）；②`190 passed`（18 files），③`6 passed`。
- [x] 取假形态必须变红：造一条突变体（交付前或交付后另出现一条只含某被听片段、且不含 `ROW_DELIVERED` 的 user 行）⇒ 重锚后的 `heardInChat` 非 0、用例红；还原 ⇒ 复绿。（证明读数未被改空。）— 突变体（注入一条仅含 `alfa bravo charlie`、不含 `ROW_DELIVERED` 的 user 行）⇒ `heardInChat=[1×53]`、exit 1、报 `an utterance was put into the chat area as a row of the client's own`；还原后 exit 0、`heardInChat=[0×53]`。
- [x] `npm run lint` 与 `npm run typecheck` 退出码 0。— 实测均 exit 0（lint 仅既有 warning，无新增）。

## DoD

在合并后的 develop 树上，用真实 Chromium 驱动真实服务（上游为 spec 自带假 Realtime 上游，不触真实 DashScope、不产生费用），跑完 AC-323 判据三条命令并贴出 exit 码 / pass 计数 / 墙钟原文；贴出该用例红→绿对照（修复前 error-context 的 `heardInChat=[…27…]` 与 `rows`，修复后 `passed`）；贴出假形态突变的红读数。未验证项如实写明。

## Touches

- e2e/voice-realtime-upload-fixture.spec.ts
- server/shared/tests/quay-test-script.test.ts（附带：把 develop 基线里已过期的 server 测试计数钉子按现树复量，非本任务机制所改）
- tasks/gap-ac323-upload-fixture-delivered-row-carries-heard-pieces.md

## Notes

本任务由 gap-filing 轮立案（2026-10-16，AC-323 判据 re-run 红）。worker 轮请在此记录：红→绿读数对照、假形态突变读数、三命令串行墙钟与 exit 码。

### worker（2026-10-16）

红→绿对照（同一 `-g "no utterance of one thought"` 单跑）：
- 红（develop，ce8a17671 后）：`heardInChat=[0…,27,27,27,27,27,27,27]`，交付行 `rows` 末行 = `"alfa bravo charlie delta echo foxtrot golf hotel india send the summary of the release notes to the team channelTXT<时间>"`。
- 绿（本分支）：`heardInChat=[0×53]`，同一条交付行文本（三片段 + `ROW_DELIVERED` 逐字在同一 `<p>` 内），`1 passed (17.2s)`。

假形态突变读数：注入一条仅含 `alfa bravo charlie`、不含 `ROW_DELIVERED` 的 user 行 ⇒ `heardInChat=[1×53]`，exit 1，报 `an utterance was put into the chat area as a row of the client's own`；移除注入 ⇒ exit 0、`heardInChat=[0×53]`（读数非空转）。

三命令串行墙钟 / exit 码：①`npx playwright test live-session-send + upload-fixture + composer-embedded`：exit 0，`18 passed (2.0m)`，墙钟 121s（另一次单独复跑 147s / 2.4m）；②`npx vitest run composerCompactTier + voice-realtime`：exit 0，`190 passed`，5s；③`npx playwright test mobile-workspace-composer-layout -g " idle "`：exit 0，`6 passed`，25s。串行总墙钟 177s。upload-fixture 单文件七例全绿：`7 passed (59.5s)`。

补充（与本任务交付无关，仅记录）：命令①墙钟 121–147s，高于 AC-323 记录里 `timeoutMs=115000` 与驱动 spawn 上限 `12e4`；本重锚未使其更慢（AC-326 用例交付后 500ms 即 break）。若判据仍以 `not-evaluated(timeout)` 收场，属 GOAL-038 侧「判据拆分」事项。

第二条机制发现（同文件、同机制，随本任务一并重锚）：AC-327 用例（`the delivery wait is visible in the bar…`）的读数同因红——`STATE_HEARD='ping the build server about the failed nightly'` 与 `STATE_DELIVERED='tell the platform team the nightly failed'` 几乎零重叠，carry 规则把它逐字带到交付行前，故交付后 `chatAreaNodesContaining(page, STATE_HEARD)` 非 0、`USER_ROW.filter({hasText: STATE_HEARD})` 数为 1。台账里只见 AC-326 一处红，是因为本 spec 为 `mode: 'serial'`：AC-326 先红，其后的 AC-327「did not run」。本任务用同一 `excluding` 锚把 AC-327 的三处 `chatAreaNodesContaining` 与一处行 filter 一并重锚（同文件、同机制，在 `## Touches` 内）；AC6 用例的 `HEARD` 与 `DELIVERED` 重叠率 ≥0.5（实测 carried=[]），交付行不含 `HEARD`，故未动。

### worker（2026-10-16，CONTINUE 轮 — 附带复量计数钉子，解 fan-in）

本轮交付物（spec 重锚）与分支原有的三条提交不变，5/5 AC 仍成立。本轮唯一改动是**附带**复量 `server/shared/tests/quay-test-script.test.ts` 的 AC2/AC3 计数钉子——上一轮 fan-in 正是因它被 baseline A/B 判 `changed-assertion` HARD RED 而未能落地。

判定「红在 develop 侧、非本 delta」的三步本地实测：
1. 驱动自己那次 develop 基线跑逐字含 `__PERFILE__ … quay-test-script.test.ts passed=false`（`.quay/fan-in-suite-gap-ac323-…~baseline-1792084412472-564139.log` 第 1 行）⇒ 基线侧即红。
2. 本分支该文件 blob 与 develop 逐字节相同（`git rev-parse HEAD:<f>` = `git rev-parse develop:<f>` = `cc082ca5670d8791d2b58ee4ad7b64ea45ff24b2`）⇒ 红不是本任务 delta 造成的。
3. `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | sort | wc -l` = **347**，而两个字面量钉的总数是 340 ⇒ 确定性过期 7 个文件。

修法（只移字面量，不补基线行）：
- AC2 `known=3 unknown=337` → **344**（347 − 3）
- AC3 `known=1 unknown=339` → **346**（347 − 1）
- AC7 的 90% 地板未受影响（基线数据行覆盖 338 个收集文件 / 347 = 97.4% ≥ 90%），故未动 `scripts/suite-duration-baseline.tsv`。

复量（合并 develop 后的树上）：
- `bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/shared/tests/quay-test-script.test.ts` → **14/14 绿，RC=0**（AC2 3.3s / AC3 19.8s / AC5 13.3s / AC6 13.3s / AC7 8ms）。
- AC1 冒烟（本任务交付物）：`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts -g "no utterance of one thought"` → **1 passed (17.3s)，RC=0**，ledger `heardInChat=[0×53]`，交付行仍逐字含三片段 + `ROW_DELIVERED`。
- `npm run lint` RC=0（仅既有 warning，无新增）、`npm run typecheck` RC=0。
- dispatch 提示把该文件报成 `delta-relatedness = UNRELATED` —— 就「是否本 delta 所改」而言它对，但对「该不该处理」无用：develop 自身的那条红只能靠复量钉子清掉。

## Blocker

**2026-10-15T17:16:04.199Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=70259 server/shared/tests/quay-test-script.test.ts passed=false end_ms=1792084159599 [baseline A/B: HARD RED (changed-assertion) — the task's red set is NOT a subset of the develop baseline red set: added=- changed=server/shared/tests/quay-test-script.test.ts]
- run_id：wk-prod-anchor
- session_id：d399189f-5ed4-4078-aafc-f1fe85f2cf1b