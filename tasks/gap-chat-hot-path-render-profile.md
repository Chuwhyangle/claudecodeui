---
id: gap-chat-hot-path-render-profile
title: Chat 热路径大 hook/组件：先 profile commit/render 热点再做一个低风险改动
status: ready
labels:
  - gap
  - performance
  - frontend
parent: null
children: []
extra:
  schema: execution
---
## Finding

Chat 热路径集中了几个大文件/大 hook：`src/modules/chat-session/hooks/useChatSessionState.ts` 2,127 行 / 68 个 hooks、`src/modules/chat-session/hooks/useSessionStore.ts` 2,335 行、`src/modules/chat-composer/composer/ChatComposer.tsx` 1,618 行、`src/modules/chat/ChatInterface.tsx` 1,477 行 / 19 个 hooks。全仓已有 219 个 `useMemo`、693 个 `useCallback`、513 个 `useEffect`；继续无测量地加 memo/拆 hook 可能只是增加复杂度。

本任务**先 profile 再改**：固定 running + 流式 + >=100 条消息的场景，找出真实的 commit/render 热点；只有确认热点才做一个低风险改动（状态下沉、memo 边界、selector、减少不必要的 effect/state），否则记录证据并保持原样。CockpitPage/ArchitecturePanel 的大组件不在本任务范围（它们先由路由懒加载处理）。

## AC

- [ ] AC1 Profile：React Profiler + Performance 面板，记录 commit 次数、按组件/ hook 的 render 次数与耗时、`useChatSessionState` 消费者重渲染；先打印 `commits=... topComponents=...` 再决策。若无法取得真实流式场景，park `needs-human` 并说明。
- [ ] AC2 若确认热点：实现一个最小改动并复测同一场景；记录 before/after 的 commit/render/TaskDuration，证明有可重复改善；不得无测量地拆分 `useChatSessionState`。
- [ ] AC3 若未确认热点：在 Evidence 记录“无显著热点，保持原样”的读数并关闭；允许 no-change，不得为了改而改。
- [ ] AC4 既有判据：chat/transcript/composer 相关测试、`npm run typecheck`、`npm run lint`、架构棘轮 exit 0；不改变消息、发送、流式、滚动、输入法行为。

## DoD

- 有真实 profile 读数与结论；只改确认的热点，或证据化地不改。
- 不盲目拆分大 hook/大组件，不把状态提升到更大的 context，不新增全局可变状态。
- 既有测试/typecheck/lint 全绿；Touches 一致。

## Touches

- src/modules/chat-session/hooks/useChatSessionState.ts
- src/modules/chat-session/hooks/useSessionStore.ts
- src/modules/chat-composer/composer/ChatComposer.tsx
- src/modules/chat/ChatInterface.tsx
- tasks/gap-chat-hot-path-render-profile.md
