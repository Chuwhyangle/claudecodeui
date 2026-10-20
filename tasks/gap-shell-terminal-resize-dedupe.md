---
id: gap-shell-terminal-resize-dedupe
title: Extract fitAndSendResize in useShellTerminal
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

F11（架构校准报告 2026-10-20，低严重度）：同一文件内的复制粘贴。

文件与位置：
- `src/modules/shell/hooks/useShellTerminal.ts:294-307` 与 `:323-336`：fit+resize 函数体相同，只有 delay 常量不同。
- `src/modules/sidebar/hooks/useSidebarController.ts:642-654` 与 `:656-668`：SSE `done` 与 `error` 处理器相同。
- `src/modules/settings/hooks/useMcpNavigationSettings.ts:38-55` 与 `:61-78`：`detectBrowserName` / `detectOsName` 结构克隆。
- `server/modules/voice-realtime/voice-realtime-tts.ts:264-269` 与 `:272-277`：`nestedErrorCode` / `nestedErrorMessage`。

为什么重要：整体低——这些克隆是局部的，有时重复比过早抽象更清楚。shell resize 处理器是唯一值得抽的一处：将来改 resize 语义需要改两个地方。语音那处（未改动）本身也是低风险。

改法（报告给出的 remediation）：在 `useShellTerminal` 内抽出 `fitAndSendResize()`；其余三处在没有其它改动理由时保持原样。

<!-- dedup-ref --> 去重检索实测：`useShellTerminal` → 0，`fitAndSendResize` → 0 命中，无任务以「抽 shell 终端 resize 辅助」为机制；`directoryBytes` / `bounded ledger` 等命中属其它重复族（F10），与本条无实现交集。

## AC

- [ ] `test "$(grep -c 'fitAddon.fit()' src/modules/shell/hooks/useShellTerminal.ts)" -eq 1`：fit 调用点只剩辅助函数内一处（贴出前后计数，立案时两条相同路径各一次）。
- [ ] `test "$(grep -c 'fitAndSendResize(' src/modules/shell/hooks/useShellTerminal.ts)" -eq 3`：一处定义 + 两处调用；`grep -n 'fitAndSendResize(' src/modules/shell/hooks/useShellTerminal.ts` 贴出三行的行号与上下文，证明两处调用分别是终端初始化路径与 ResizeObserver 路径。
- [ ] 新增 `src/modules/shell/tests/useShellTerminalResize.test.tsx`，`npx vitest run src/modules/shell/tests/useShellTerminalResize.test.tsx` 退出 0；用例以 spy 记录辅助函数被调用次数，断言初始化与 resize 两条路径各调用 1 次，并贴出两次计数。
- [ ] 既有 shell 判据不改一字仍绿：`npx vitest run src/modules/shell` 退出 0，贴出 `Test Files / Tests` 读数。
- [ ] `npm run typecheck` 退出 0，`npm run lint` 退出 0。
- [ ] `git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件（不多一个）。

## DoD

真实落地的标准是「两条真实的终端路径真的都经同一个辅助函数发起 fit+resize」，不是「多了一个函数名」。必须贴出：①`fitAddon.fit()` 的前后计数（2→1）与唯一调用行的上下文；②`fitAndSendResize(` 的三行（定义 + 两处调用）原文；③新判据的 `Test Files / Tests` 与两条调用计数（各 1 次）；④`src/modules/shell` 的既有判据读数；⑤typecheck / lint 退出码；⑥取假形态：把 ResizeObserver 路径临时改回内联的 `fitAddon.fit()` 调用 ⇒ 第一条 AC 红（计数 2）或新判据的调用计数红，还原后复绿，附两次读数。其余三处克隆不在本条，不得因本条改动 `useSidebarController.ts`、`useMcpNavigationSettings.ts`、`voice-realtime-tts.ts`。

## Touches

- src/modules/shell/hooks/useShellTerminal.ts（抽出 `fitAndSendResize()`，两条路径改调它）
- src/modules/shell/tests/useShellTerminalResize.test.tsx (new)（两条路径各调用一次的判据）
- tasks/gap-shell-terminal-resize-dedupe.md (self)
