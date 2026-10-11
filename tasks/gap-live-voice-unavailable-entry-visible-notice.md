---
id: gap-live-voice-unavailable-entry-visible-notice
title: Live Voice
  入口在「还没有会话」时保持可点并给出可见通知（reason=voice.realtime.needsSession），不再是一个沉默的 disabled
  按钮
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

**现状（2026-10-11 本轮亲自复核，写前重读仍成立）**

- `src/modules/chat/composer/ChatComposer.tsx:149` 声明 `liveVoiceDisabled?: boolean`；`:254` 消费它；`:909` 应用为 `disabled={liveVoiceDisabled}`（本轮逐行读到）。
- `src/modules/chat/ChatInterface.tsx:897` 传 `liveVoiceDisabled={!voiceSessionId}` —— 尚无会话 id 的对话，其 Live Voice 控件 **disabled 且沉默**：触屏上 `disabled` 会整个吞掉事件，读者得不到任何解释。这就是缺陷本身：一个没有任何答复的死控件。
- 全树今日**没有** `liveVoiceDisabledReason` prop，也**没有** `voice.realtime.needsSession` 消息（本轮 `task_list` 检索两词均 0 命中），且**没有任何任务认领**这一机制 —— 未落地、无主。

**这个改动做什么**：Live Voice 不可用时控件**保持可点**，点击会得到一条**可见**通知，带上原因（`voice.realtime.needsSession`，默认文案 "Live Voice needs a conversation. Send a message first, then start Live Voice."），而不是继续依赖 `disabled` 把点击吞掉。

<!-- dedup-ref --> 去重 / 粒度判定（本轮实测）：机制去重 —— 检索 `liveVoiceDisabledReason` / `needsSession` / `voice.realtime.needsSession` / `Live Voice needs a conversation` / `Live Voice entry` / `receives the tap and answers it visibly` 均 0 命中；`沉默` / `Live Voice 控件` / `Live Voice 入口` 的命中都是无关机制（AC-315 判据重指、AC-323 入口迁移、ASR 健康检查）。无重复，不 STOP。粒度 —— 唯一声明了重叠实质源文件的在飞 peer 是 `gap-live-voice-caption-removal-on-shown`（ready），其 `## Touches` 含 `src/modules/chat/ChatInterface.tsx`；判定 **separate** —— 机制不同（caption 移除键改到 `shown` vs. 不可用入口给可见通知）、各自独立验收，且该 peer 已是 ready，此刻折叠只会互相踩踏。`src/modules/chat/composer/ChatComposer.tsx` 无任何在飞任务声明。

## Plan

**HANDOVER（本节是交接，不是要你重写实现）**：为本改动准备的 diff 就在本仓的 `stash@{0}`（message `pre-AC326-merge 2026-10-11`）。今日已作非破坏性验证（在 HEAD 的 scratch worktree）：

- `git stash apply stash@{0}` **无冲突**应用；
- diff 为 `src/modules/chat/ChatInterface.tsx` +6、`src/modules/chat/composer/ChatComposer.tsx` +67/−13、`src/modules/chat/tests/composerCompactTier.test.tsx` +73（共 133 insertions / 13 deletions）；
- `npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx` 在该 worktree **17/17 pass**（该文件从 15 个用例涨到 17 个）。

所以 worker 的活是 **apply stash → 逐条对照下面 AC 复核 → 落地**，不是再写一遍。它新增的两条用例逐字为：

```
(l) an unavailable Live Voice entry still receives the tap and answers it visibly
(l) an available Live Voice entry starts the session and shows no notice
```

步骤：

1. `git stash apply stash@{0}`（应无冲突），逐条对照 AC 复核 diff 的内容与边界。
2. 跑 AC 点名的命令（vitest 文件 + `npm run typecheck` + lint）。
3. 通过正常流程提交并落地（在会话内按 `scripts/with-memory-cap.sh` 的规矩缩放测试）。
4. **提交后 `git stash drop stash@{0}`** —— 落地即删，否则该 diff 可能被二次 apply（造成重复改动）。
5. 落地后真机走一遍 DoD（开全新会话 → 点 Live Voice → 看见通知）。

## AC

- [x] AC1（取假形态，排在新增断言最前）无会话 id 时点 Live Voice 控件 ⇒ 出现**可见**通知且**不静默无动作**：`npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx` exit 0，且这条「不可用入口仍收到点击并可见地答复」的断言是文件内该对新增用例中的**第一条**（取假：还原 `disabled` 静默路径 ⇒ 它最先变红）。
- [x] AC2（负控）会话存在时控件启动会话且**不**显示通知：同文件，「可用入口启动会话且不显示通知」用例通过，通知计数为 0（修好不得骚扰正常路径）。
- [x] AC3 不可用时控件**不是** `disabled`（断言 DOM/属性，而非仅行为）：同文件读得该按钮无 `disabled` 属性（`expect(button).not.toBeDisabled()` / `toBeEnabled()`），使触屏能送达点击；今天的 `disabled={liveVoiceDisabled}` 使它当前为红。
- [x] AC4 静态门：`npm run typecheck` exit 0；`npm run lint` exit 0。
- [x] AC5 无新测试文件 / 计数钉未被牵动：本改动**不新增测试文件**（用例进既有 `composerCompactTier.test.tsx`），故 `server/shared/tests/quay-test-script.test.ts` 的文件数钉与 `scripts/suite-duration-baseline.tsv` **不在**落地 diff 里：`git diff --name-only develop...HEAD -- server/shared/tests/quay-test-script.test.ts scripts/suite-duration-baseline.tsv` 输出为空。

## DoD

一个**真实对象**被这套机制操作过（DIR-026 读法 A）：准备好的改动经正常流程提交并落地，人能开一个**全新会话**、点 Live Voice、**看见**通知而不是一个死控件。apply stash 且其单测通过是必要但不充分 —— **落地**才是交付物。落地后复核：`git log` 能看到本次改动提交，`git stash list` 中 `pre-AC326-merge 2026-10-11` 已不在（已 drop），且真机读数（截图/录屏或逐帧说明）落在本任务 Evidence。

## Touches

- src/modules/chat/ChatInterface.tsx (把不可用入口按可点传递，并把原因交给它)
- src/modules/chat/composer/ChatComposer.tsx (新增 reason prop 与可见通知；去掉静默 disabled 路径)
- src/modules/chat/tests/composerCompactTier.test.tsx (两条新增断言；不新建测试文件)
- tasks/gap-live-voice-unavailable-entry-visible-notice.md (self)

## Evidence

**落地**：`d5f97823 feat(voice-realtime): keep the Live Voice entry tappable and answer the tap`（3 文件，+148/−13）。随后按规矩做 pre-merge：第一次合 `develop`（当时 tip `13b85b1e`）无冲突得 `13982b9f`；本回合内 `develop` 又被 sibling 的 fan-in 推进到 `d265f362`，遂**重读 tip 再合一次**（无冲突），最终树 **`6df8ed26`** —— 下面全部 AC 复核与取假都在**这棵最终落地的树**上重跑，不是早先那次合并的读数。

`git stash drop` 已执行，`git stash list` 现为空（drop 前先按 tag 复核过：stash 新增行中不在 HEAD 里的只有本回合有意改写的 4 处 —— 魔数 `4000`、tooltip 回归、内联原因、较弱的那条断言）。

**AC1 / AC2 / AC3**（在 `6df8ed26` 上）：`npx vitest run src/modules/chat/tests/composerCompactTier.test.tsx` → `Tests 17 passed (17)`。新增用例对中**第一条**即 AC1 点名的 `(l) an unavailable Live Voice entry still receives the tap and answers it visibly`。

- **取假（在 `6df8ed26` 上重做）**：把 `aria-disabled={liveVoiceDisabled ? true : undefined}` 还原为改动前的 `disabled={liveVoiceDisabled}`（原生 disabled 不派发事件 ⇒ 无通知，即那条静默路径），重跑该文件 → `Tests 1 failed | 16 passed (17)`；唯一变红的就是 AC1 点名的那条，失败断言为 `AssertionError: an unavailable entry must not be natively disabled`（该用例的**第一条**断言），负控用例 `(l) an available Live Voice entry starts the session and shows no notice` 保持绿。随后 `git checkout --` 还原（实现已先提交，还原不会丢代码），重跑 17/17 绿、工作树 0 脏项。
- AC3 的实现形式：本仓 `vitest.setup.ts` **没有** `@testing-library/jest-dom`（不存在 `toBeDisabled`/`toBeEnabled`），故按 AC 括号里自己写明的「断言 DOM/属性，而非仅行为」用 `assert.equal(button.hasAttribute('disabled'), false, …)` 直接读属性 —— 这正是取假时最先变红的那条断言。

**AC4**（在 `6df8ed26` 上）：`npm run typecheck` exit 0；`npm run lint` exit 0，且 `npm run lint | grep ' error '` 无输出（只有既有 warning；`ChatComposer.tsx` 的 `react(refs)` warning 位于未改动行）。

**AC5**（在 `6df8ed26` 上）：`git diff --name-only develop...HEAD -- server/shared/tests/quay-test-script.test.ts scripts/suite-duration-baseline.tsv` 输出为空；`git diff --name-status develop...HEAD` 恰为 3 个 `M`（`ChatInterface.tsx` / `ChatComposer.tsx` / `composerCompactTier.test.tsx`）、无 `A`，与 `## Touches` 一致。第二次合并带进来的是 sibling 的 `e2e/voice-realtime-composer-embedded.spec.ts` 与两个 task 文件，**未触及**本改动那 3 个文件。

**真机读数（DIR-026 读法 A）** —— 隔离备用服务（`SERVER_PORT=3979`，`HOME` / `DATABASE_PATH` 指向 `/data/home/yale/work/dod-live-voice-notice/`，跑的就是本工作树的 `server/index.ts`）＋ 真实 Chromium（Playwright）＋ 真实账号 `doduser` ＋ 真实项目 `dod-empty-workspace`。点按用 `page.mouse.click(控件中心)`：真实命中测试，绕过 Playwright 自己的 actionability 检查（它把 `aria-disabled` 当作不可点，比浏览器更严）—— 恰恰是「这个控件到底收不收得到那一下」的判据。截图在 `/data/home/yale/work/dod-live-voice-notice/`。

- **读法 A（该工作区一个会话都没有，全新）**：`A-no-session-before-tap.png` —— 入口在输入框左下角，淡显（`opacity-50`）；读得 `disabledAttribute:false`、`domDisabled:false`、`aria-disabled:"true"`、`aria-label:"Start Live Voice"`。点按后 `A-no-session-after-tap.png` —— 一行可见通知浮在输入框上方、正对入口：**"Live Voice needs a conversation. Send a message first, then start Live Voice."**；读得 `noticeAppeared:true`、`noticeRole:"status"`、`voiceBarCount:0`、`composerStillRendered:1`。即：看得见答复，而不是一个死控件。
- **读法 B（同一项目，开了一个会话 `dod live voice session`）**：读得 `aria-disabled:null`；点按后 `B-session-after-tap.png` 显示 Live Voice 条取代输入框，`barAppeared:true`、`noticeCount:0` —— 正常路径未被骚扰。该次点击后条内显示 `Requested device not found`，是无麦克风的 headless Chromium 的预期结果，与本改动无关。
