---
id: gap-transcript-pixel-estimate-hotspot
title: 流式 transcript 的行高估算遍历所有可见行：profile offsetHeight 热点并按需增量
status: todo
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

`src/modules/chat/transcript/ChatMessagesPane.tsx` 的 `useTranscriptPxPerMessage` 在 MutationObserver/ResizeObserver 回调里对 `[data-transcript-content]` 的所有 `[data-message-timestamp]` 行读取 `offsetHeight`，并把行数组 map 成 `ContentRowInput`；流式期间 transcript 每 100ms 合并一次（`src/modules/chat-session/hooks/useChatRealtimeHandlers.ts` 的 `STREAM_FLUSH_INTERVAL_MS = 100`），DOM 变化会反复触发这个 O(visible rows) 的布局读取。已有 debounce 和 RAF，但没有按行增量或缓存；这是滚动条像素估算，不是首屏关键路径，适合先 profile 再优化。

现有 transcript 的 100ms 合并、settled/pending 拆分、LazyMessageRow/IntersectionObserver、`contain + content-visibility` 都是正确的，不要重写；本任务只处理这个测量热点，并以真实流式场景读数决定是否改。

## AC

- [ ] AC1 Profile：固定一个 >=100 行的 transcript + 正在流式输出的会话，用 Performance/React Profiler 记录 `rowsMeasured`、measure 调用次数、Layout/Recalculate Style/TaskDuration；先打印读数再判断。若无法取到真实流式场景，park `needs-human` 并说明，不得用静态 DOM 推断。
- [ ] AC2 若确认显著：只测量新增/变化的行，或缓存行高，或把估算延后到滚动条需要时；保留滚动条像素估算、LazyMessageRow 占位高度和“加载全部”行为，不得改变 transcript 视觉/滚动。
- [ ] AC3 复测：改后同一场景的测量次数/Layout/TaskDuration 有可重复下降，或记录“不显著，保持原样”的证据并关闭任务；不得为了改而改。
- [ ] AC4 既有判据：transcript/滚动相关用例、`npm run typecheck`、`npm run lint`、架构棘轮 exit 0。

## DoD

- 测量热点有 profile 读数与结论；显著的才改，不显著的保持原样。
- 不改变 transcript 的渲染、懒加载、滚动条估算和“加载全部”行为；不引入新的持续动画/层。
- 既有测试/typecheck/lint 全绿；Touches 一致。

## Touches

- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/transcript/LazyMessageRow.tsx
- src/modules/chat-transcript/hooks/useLazyRowObserver.ts
- tasks/gap-transcript-pixel-estimate-hotspot.md
