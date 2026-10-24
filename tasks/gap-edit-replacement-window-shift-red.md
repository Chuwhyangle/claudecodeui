---
id: gap-edit-replacement-window-shift-red
title: 编辑重发的 replacement 行在窗口平移后重复：先落 store 级已知缺陷用例（窗口原点≠0 + 正控制）
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

<!-- dedup-ref --> 立案时实测：`task_list search "replacesAfterRowCount" / "window shift replacement" / "edit resend duplicate window origin"` 无在飞或已完成任务认领这条机制；唯一相邻的 `gap-activity-send-retry-duplicates-user-row` 修的是「socket persisted echo 未被 server 页面认领」的配对缺口，发生在 `removeOptimisticUserEchoes` 的候选表选择，不是本条的「窗口相对下标 vs 另一窗口」坐标系问题。本条不是重复。

**现象（2026-10-24 真浏览器复现）**：会话 >20 条 normalized message；发一条会被中断的消息，Stop，点编辑改写后重发；**编辑后的回合仍在处理中**时切到另一会话再切回，编辑后的 user 行出现两次：原位一条有 `Edit and resend`，末尾一条只有 `Copy message`；刷新后单条。

**根因读数**：`truncateAt`（`src/modules/chat/hooks/useSessionStore.ts:1612,1633`）把 `slot.serverMessages.findIndex(...)` 的**窗口相对下标**存进 `replacesAfterRowCount`；`removeOptimisticUserEchoes`（`src/modules/chat/utils/session/sessionMessageReconciliation.ts:151`）在另一个窗口里把它当作下标下限。实测：

```json
{"cutIndex":20,"serverLen":22,"startIndex":16,"floorStored":20}
// 切回后 fresh tail page:
{"floor":20,"serverLen":20,"matchingServerIndices":[19]}  // 跳过 → replacement 不退休
```

未退休行被 `readSortTime`（`useSessionStore.ts:378-381`）钉到末尾。

**为什么现有判据看不见**：`sessionMessageReconciliation.test.ts:92` 用 `kept.length` 作为 `replacesAfterRowCount`，窗口原点恒为 0；`sessionStoreTruncate.test.tsx` 的窗口也恒为 `startIndex=0`。本缺陷只在「切点窗口的原点 ≠ 刷新后窗口的原点」时出现。

**本任务边界**：只把缺陷变成可判定的 store 级已知缺陷读数（`it.fails` + 正控制），**不改生产代码**。设计依据见 `docs/proposals/transcript-authored-message-identity.md`；阶段 1 负责翻绿。

## Plan

1. 在 `src/modules/chat/tests/sessionStoreTruncate.test.tsx` 增加一条 `it.fails('KNOWN GAP: ...')`：
   - 首次 `fetchFromServer` 返回一个 `total=40`、长度 20 的尾页（绝对下标 20..39），最后一行是带 `transcriptAnchorId='u-anchor'` 的 user 行；断言 `slot.startIndex === 20`。
   - `appendRealtime` 一条 `replacesAnchorId='u-anchor'` 的 replacement 本地行，再 `truncateAt('session-1','u-anchor')`；当前实现把 `cutIndex=19` 写成 floor。
   - 把 mock 切成编辑后的尾页：`total=41`、长度 20（绝对下标 21..40），其中持久化 replacement 在页内下标 18（`transcriptAnchorId='u-replacement'`，文本与本地行相同），其后是一条 assistant。
   - `refreshLatestFromServer('session-1')` 后断言 edited 文本只出现 **1** 次。当前实现出现 2 次，断言抛出。
2. 同文件增加正控制（现在就必须绿）：
   - (a) 同一形状但刷新窗口原点不变 → replacement 被退休，只剩 1 条；
   - (b) 两条独立的同文本地发送、只有一条 persisted echo → 未被认领的第二条仍在（一对一未被文本折叠破坏）。
3. 为记录红文案，临时把 `it.fails` 改成 `it` 跑一次，保存失败断言里的 `actual` 列表（必须恰好是两条 edited 文本，而不是 mock/setup 错误），随后还原为 `it.fails`。
4. 不新增 `server/**/*.test.ts` 文件；不改生产代码。

## AC

- [x] AC1 已知缺陷用例存在：`npx vitest run src/modules/chat/tests/sessionStoreTruncate.test.tsx` 退出码 **0**；输出含该 `KNOWN GAP` 用例且被 vitest 计为 expected failure（`it.fails`），不是 skip/todo。
- [x] AC2 红态是断言而不是 setup 错误：临时把该用例的 `it.fails` 改为 `it` 后运行，失败断言逐字给出 `actual` 为两条相同 edited 文本（例如 `['... corrected', '... corrected']`），退出码 1；`git checkout -- src/modules/chat/tests/sessionStoreTruncate.test.tsx` 或等价还原后回到 `it.fails`，文件退出码 0。完成记录贴出 red 的 `actual` 与命令。
- [x] AC3 正控制各自独立可反红：(a) 窗口原点不变的 refresh 退休 replacement；(b) 两次真实同文发送、只有一条 persisted echo 时，未配对的第二条本地行保留。两条在同一文件里是独立用例，均可单独失败。
- [x] AC4 零生产改动：`git diff --stat -- src server e2e playwright.config.ts` 为空；改动只落在 `## Touches` 列出的测试/文档/任务文件。
- [x] AC5 `npm run typecheck` 退出码 0。

## DoD

缺陷从“只能靠真浏览器和长历史偶发”变成**一条可在 vitest 里稳定复现的已知缺陷读数**：窗口原点 ≠ 0、切点后窗口再平移、持久化 echo 落在旧 floor 之下。红态必须是断言读出的两条 edited 行，且同文件的正控制证明退休逻辑没有被整体关闭或按文本折叠。阶段 1 只需把该 `it.fails` 翻成 `it`，就能证明修复针对的是同一个读数。本任务不产出浏览器截图（测试-only）；真实浏览器复现留在阶段 1 的 DoD。

## Touches

- src/modules/chat/tests/sessionStoreTruncate.test.tsx
- docs/proposals/transcript-authored-message-identity.md
- tasks/gap-edit-replacement-window-shift-red.md

## 完成记录

- AC1：`cd <worktree> && npx vitest run src/modules/chat/tests/sessionStoreTruncate.test.tsx` → `Tests 11 passed (11)`，退出码 **0**；其中 `replacement rows across a sliding history window > KNOWN GAP: a shifted window draws the edited user row twice` 由 `it.fails` 计为 expected failure（不是 skip/todo）。
- AC2：临时把该用例的 `it.fails` 改为 `it` 后同一命令退出码 **1**，失败断言为 `assert.deepEqual(drawnEditedRows(view), [EDITED_TEXT])`，逐字 `actual`：
  ```
  [
    'last prompt, corrected',
    'last prompt, corrected'
  ]
  ```
  随后还原为 `it.fails`，同一命令回到 11 passed、退出码 0。
- AC3 反红证明（临时消融，均已 `git checkout --` 还原，worktree 只余测试改动）：
  - 关闭退休（`removeOptimisticUserEchoes` 提前 `return realtimeMessages`）→ 正控制 (a)(b) 两条同时红；`KNOWN GAP` 仍为 expected failure；
  - 去掉 `findServerEchoForLocalUser` 的 `claimedServerIds` 一对一护栏 → 仅 (b) 红，(a) 仍绿。两条正控制互相独立、且各自确实能反红。
- AC4：`git diff --name-only develop -- src server e2e playwright.config.ts` 只列出 `src/modules/chat/tests/sessionStoreTruncate.test.tsx`（Touches 内测试文件）；排除该测试目录后为空，无任何生产代码改动。
- AC5：`npm run typecheck` 退出码 **0**。
- 交付前：`git merge --no-edit develop` 无冲突；anti-drift Touches check 输出 `ANTI-DRIFT OK`、退出码 0。
