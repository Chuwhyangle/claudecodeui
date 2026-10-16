---
id: gap-ac389-escape-abort-guard
title: AC-389 全局 Escape 守卫：只在输入框聚焦且无打开的浮层/对话框/弹层时 abort（浮层内的 Escape 只关浮层、abort
  调用数为 0）；交付 src/modules/chat/tests/escapeAbortGuard.test.tsx（新建，(a)–(e)
  五条腿含取假形态）并就地修订既有 pin chatInterfaceEscapeAbort.test.tsx 的聚焦前置
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-ac385-send-deliveryid-runid-compat-window
  - gap-ac386-run-get-dual-id-delivery-wait
goal_ac: AC-389
---
## Proposal

<!-- dedup-ref --> 机制去重读数（立案时实测，2026-10-16）：`grep -rl '^goal_ac: *AC-389' tasks/*.md` → **0** 命中；全库 `grep -rln 'AC-389' tasks/` → 只命中 `tasks/gap-ac387-pending-deliveries-from-activity-snapshot.md` 与 `tasks/gap-ac388-activity-dock-honest-status.md`（两份都把 AC-389 明确写成 non-goal：「同批 S4 任务 AC-388（活动坞如实文案）与 AC-389（Escape 守卫）是不同机制、不同文件，本任务不含」，非认领）⇒ 无任何状态（含 todo / ready / needs-human）的任务认领 AC-389。机制词 grep：`escapeAbortGuard` 全库 **0** 命中；`ChatInterface` 的 Escape abort 面只有 `src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx` 一条既有判据（另一条 pin，非本条判据）。合并候选（`node /data/home/yale/.claude/plugins/cache/quay/quay/0.20.0/scripts/dist/task-granularity-advice.js --root /data/home/yale/work/claudecodeui --touches src/modules/chat/ChatInterface.tsx --touches src/modules/chat/tests/escapeAbortGuard.test.tsx --json`）报 `peers: []`、`mentions: []` ⇒ 判定 **separate**（无开放任务声明同批文件）。本条对 S3 出口 AC 的先后已在任务层以结构化 `depends_on` 声明（SPEC §12：后一阶段任务不得先于前一阶段出口 AC 落地），正文不复述这层关系；AC-389 不消费任何 S2/S3 字段，`depends_on` 纯为阶段门。

### 机制（SPEC §9「全局 Escape」、GOAL-045 §9；基线 `976ef03b1`）

现状（读基线代码）：`src/modules/chat/ChatInterface.tsx:741-756` 的 `useEffect` 在 `canAbortSession` 为真时，于 `document` 上挂 capture 阶段 `keydown`；`handleGlobalEscape` 只挡 `key !== 'Escape' || event.repeat || event.defaultPrevented`，随后 `event.preventDefault()` + `handleAbortSession()`。它**不看焦点在哪**，也**不看有没有打开的浮层**。两个后果：

1. **浮层内按 Escape 会同时 abort 正在跑的 turn。** 各处浮层自带的 Escape 关闭监听都在 ChatInterface 的 document-capture 之后才生效或不 `preventDefault`：
   - Resident 徽标面板：`src/modules/chat/transcript/ResidentSessionBadge.tsx:231-249`（portal 到 `document.body`，`role="dialog"` + `data-resident-badge-panel="true"`，内层 `ResidentStatusBar.tsx:133` 另有 `data-resident-panel="true"`）的关闭监听在 **document 冒泡段**（`:150-158`），且**不** `preventDefault`/`stopPropagation` ⇒ ChatInterface 先触发、照 abort，随后面板才关。
   - 对话框：`src/shared/ui/Dialog.tsx:123-132/196`（`role="dialog"` `aria-modal="true"`）的 Escape 分支只 `e.stopPropagation()`、**不** `preventDefault()`；它注册在同为 `document` capture 的监听上、晚于 ChatInterface 的 effect ⇒ 同一节点同一阶段按注册顺序，ChatInterface 先跑，`defaultPrevented` 仍为 false ⇒ 照 abort。
   - 因此「浮层内 Escape 只关浮层」现在并不成立——SPEC §1.5 那次「点开 Resident 面板后按 Escape」的释放（`Working…` 短暂消失）走的就是这条路；abort 之后 round 仍在，M6 的 queued 行落到已关闭的命令上。
2. **焦点不在输入框时也会 abort。** 现有实现没有任何 `document.activeElement` 判定，焦点在页面任意处按 Escape 都会 abort。

反面对照（避免把已有免疫的浮层误当承重臂）：composer 的模型 / 权限 / 定时弹层经 `src/modules/chat/hooks/useComposerMenuAnchor.ts:52-58` 在 **window capture** 段 `preventDefault()` + `stopPropagation()`——window 段早于 document 段，故这些弹层**本来就**挡住了 abort，**不能**用来承载下面的 (e) 取假红。

要做的事（SPEC §9 原文）：全局 Escape **只在输入框聚焦且没有打开的浮层 / 对话框 / 弹层时才 abort**；浮层内的 Escape 只关浮层。

### 实现方向（执行者按此实现，等价实现允许）

- **焦点判定**：`document.activeElement` 落在 composer 的 textarea 上。`ChatInterface` 已持有 `useChatComposerState` 的 `textareaRef`（`:572`，并透传给 ChatComposer `:1132`），用 `textareaRef.current` 与其 `contains(document.activeElement)` 即可，**无需**新增 DOM 标记。
- **浮层判定**：Escape 时 `document.querySelector('[role="dialog"],[role="menu"],[role="listbox"]')` 非空即视为有浮层（上述四类浮层各自：Dialog 与徽标面板 `role="dialog"`、composer 弹层 `role="menu"`、命令菜单 `role="listbox"`，且都只在打开时进 DOM；徽标面板 portal 到 `document.body`，须查 `document` 而非 render 容器）。命中任一 ⇒ **直接 return，不得 `preventDefault()`**，把这次 Escape 留给浮层自己的关闭处理。若将来浮层改用别的容器/标记，以「浮层打开时 DOM 里可被一个选择器判定」为准。
- 若改用共享浮层登记表 / 共享 hook（跨模块共用），放 `src/shared/hooks/` 或 `src/shared/utils.ts`，并**先**把该文件补进 Touches 再写（见 Touches 末条）。

### 既有一条 pin 会被这条守卫顶过期（必须就地修订，不得翻转契约）

`src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx:285-322` 在**未聚焦任何输入框**（`fireEvent.keyDown(document, { key: 'Escape' })`）时断言 abort 恰好 1 次。加了「焦点必须在输入框」的前置后，这条钉必然变红。按「判据被更晚的守卫顶过期 ⇒ 就地改写钉子、保留整条 expect 的两半」处理：给它的 abort 臂**只补**「先聚焦 composer 的 textarea」这一前置，两半断言（可 abort 时恰一次、`canAbortSession=false` 时零次）与文案**逐字保留**。该文件把 `useChatComposerState` 整块 mock 且 `textareaRef: { current: null }`——把它改成 `vi.hoisted` 的**同一个 ref 对象**返回，React 会把 ChatComposer 真实 textarea 挂到它上面，`ref.current.focus()` 即可满足前置。**不得**删掉或翻转这条 pin 的任何一条读数。

## Plan

1. **先跑基线红**：`npx vitest run src/modules/chat/tests/escapeAbortGuard.test.tsx`（文件不存在 ⇒ 退出 1、`No test files found`），逐字抄进完成记录。
2. **写新判据** `src/modules/chat/tests/escapeAbortGuard.test.tsx`：真实 `ChatInterface`（沿用 `chatInterfaceEscapeAbort.test.tsx` 的 hook 替身手法，只替身到网络/会话 hook，保留真实 document capture 监听与真实 ChatComposer）+ 真实浮层组件，一条文件覆盖 (a)–(d)。Escape 的真实派发：有聚焦前置的臂对**已聚焦的 textarea** 派发（capture 仍会先到 document 上的监听），无聚焦前置的臂对 `document` 派发；每条断言前先打印读数。
3. **实现守卫**（`ChatInterface.tsx` 的 Escape effect）：焦点 + 无浮层双前置；命中浮层时不 `preventDefault`。
4. **就地修订** `chatInterfaceEscapeAbort.test.tsx`（补聚焦前置，两半断言逐字保留）。
5. **取假形态**：(e) 把 Escape effect 恢复为基线「无条件 document 级 capture 监听」⇒ 跑新判据确认 (b) 变红（(c) 因同一守卫缺失会同红），(a)/(d) 仍绿；还原后全绿，`git diff` 不含临时代码。
6. **collateral**：跑既有 Escape 相关 pin（`chatInterfaceEscapeAbort` / `chatComposerResponsive` / `residentStatusBarCloseReachable` / `workspaceTabsResponsive`，四者都 `fireEvent.keyDown(document, { key: 'Escape' })`）+ `npm run typecheck` / `npm run lint`。

## AC

- [ ] AC1 判据绿：`npx vitest run src/modules/chat/tests/escapeAbortGuard.test.tsx` 退出 **0**。红态基线：文件不存在，vitest 报 `No test files found`（退出 1）——逐字红态读数抄进完成记录。
- [ ] AC2 (a) 输入框聚焦、无浮层、会话在跑：聚焦 composer 的 textarea（`document.activeElement` 落在其上）、`canAbortSession=true`、`document.querySelector('[role="dialog"],[role="menu"],[role="listbox"]') === null` ⇒ 一次 Escape 触发 `handleAbortSession` **恰好一次**（abort 计数 = 1）。
- [ ] AC3 (b) 浮层打开时 Escape 只关浮层、abort = 0（承重腿）：分别对 (i) Resident 徽标面板（点开 pill ⇒ `document` 内出现 `[data-resident-badge-panel]` / `[role="dialog"]`）、(ii) 对话框（真实 `Dialog` 打开，`role="dialog"`）、(iii) composer 弹层（真实 `role="menu"` / `role="listbox"` 之一打开）按 Escape ⇒ 每条臂断言 (1) abort 调用数为 **0**、(2) 该浮层**已关闭**（对应标记从 DOM 消失）。三条臂均须在输入框处于聚焦态下取得（浮层优先于焦点）。⚠️ **至少一条臂必须是「自身 Escape 处理不 `preventDefault` 」的浮层**（徽标面板或 Dialog，见 Proposal 反面对照），它才是下面 (e) 的承重臂；`useComposerMenuAnchor` 系弹层本就免疫 abort，单靠它整条 (b) 会真空绿。
- [ ] AC4 (c) 焦点不在输入框时 Escape 不 abort：无浮层、`canAbortSession=true`、焦点移到页面其它元素（`document.body` 或一个按钮）⇒ Escape 后 abort 计数**不变**（等于前值）。
- [ ] AC5 (d) 会话不在跑（`canAbortSession=false`）时 Escape 不 abort：输入框聚焦、无浮层 ⇒ Escape 后 abort 计数为 0。
- [ ] AC6 (e) 取假形态可复现：把 `ChatInterface.tsx` 的 Escape effect 恢复为基线无条件 document 级 capture 监听 ⇒ 判据文件一字不动重跑退出**非 0**，红**落在 (b)**（abort 数变 1）而非别的腿先红（(c) 因同一守卫缺失会同红属预期；(a)/(d) 仍绿）；还原后 (a)–(d) 全绿。逐字红态读数、退出码、变异 diff 与恢复命令抄进完成记录，`git diff` 最终不含该临时代码。
- [ ] AC7 既有 pin 不回退：`npx vitest run src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx` 退出 **0**，且其两半读数（可 abort 时恰一次、`canAbortSession=false` 时零次）与文案**逐字保留**——只加「先聚焦 textarea」前置，不删不改任何断言；把修订前后 diff 抄进完成记录。再逐个跑 `src/modules/chat/tests/chatComposerResponsive.test.tsx`、`src/modules/chat/tests/residentStatusBarCloseReachable.test.tsx`、`src/modules/project-workspace/tests/workspaceTabsResponsive.test.tsx` 各退出 **0**（这三个也 `fireEvent.keyDown(document, { key: 'Escape' })`，须证明未被守卫波及）。
- [ ] AC8 遵守 `$frontend-module-standards`（`@/` 导入、`type` 不用 `interface`、`import type`、跨模块只经 `index.ts` barrel、测试放 `src/modules/chat/tests/`）；`npm run typecheck` 与 `npm run lint` 退出 0。
- [ ] AC9 collateral：新增一个客户端测试文件后复量是否压破任何既有覆盖率 / 时长地板，按需更新对应基线；先量（通常不动，免得给 diff 添未声明文件），把复量命令与读数抄进完成记录。

## DoD

真实落地（不是「测试存在」、也不是「常量存在」）：在 `src/modules/chat/tests/escapeAbortGuard.test.tsx` 上以**真实** `ChatInterface` 的 Escape 处理（真实 document capture 监听 + 真实 ChatComposer，非替身监听器）驱动——

(a) 输入框聚焦、无浮层、会话在跑 ⇒ 一次 Escape 恰触发一次 abort；
(b) Resident 徽标面板 / 对话框 / composer 弹层任一打开时按 Escape ⇒ 只关该浮层，abort 为 0（三个类别各一条真实浮层，浮层由真实组件打开，其中至少一条来自自身不 `preventDefault` 的浮层）；
(c) 焦点不在输入框 ⇒ 不 abort；
(d) `canAbortSession=false` ⇒ 不 abort；
(e) 把 Escape effect 恢复为基线无条件 document 级 capture 监听 ⇒ (b) 变红、还原后恢复绿——红的是那条读数本身，判据有洞会被看见；
既有 pin `chatInterfaceEscapeAbort.test.tsx` 只加聚焦前置、两半读数与文案逐字保留仍退出 0；`npm run typecheck`、`npm run lint` 退出 0。

## Touches

- `src/modules/chat/ChatInterface.tsx` （Escape effect：加输入框聚焦 + 无浮层双前置；命中浮层时不 `preventDefault`）
- `src/modules/chat/tests/escapeAbortGuard.test.tsx` （新：AC-389 判据文件，(a)–(d) 四条腿 + 取假形态）
- `src/modules/chat/tests/chatInterfaceEscapeAbort.test.tsx` （就地修订：abort 臂补「先聚焦 composer textarea」前置，两半断言与文案逐字保留）
- `tasks/gap-ac389-escape-abort-guard.md` （自触）

（若实现改用共享浮层登记表 / 共享 hook（放 `src/shared/hooks/` 或 `src/shared/utils.ts`），或需要给浮层加新的 DOM 标记而改到 `src/shared/ui/Dialog.tsx`、`src/modules/chat/composer/ComposerMenuPrimitives.tsx`、`src/modules/chat/composer/CommandMenu.tsx`、`src/modules/chat/transcript/ResidentSessionBadge.tsx` 等，**先**用 task_write 把这些文件补进本 Touches 再写。）
