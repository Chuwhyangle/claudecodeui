---
id: gap-transcript-pixel-estimate-hotspot
title: 流式 transcript 的行高估算遍历所有可见行：profile offsetHeight 热点并按需增量
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

`src/modules/chat/transcript/ChatMessagesPane.tsx` 的 `useTranscriptPxPerMessage` 在 MutationObserver/ResizeObserver 回调里对 `[data-transcript-content]` 的所有 `[data-message-timestamp]` 行读取 `offsetHeight`，并把行数组 map 成 `ContentRowInput`；流式期间 transcript 每 100ms 合并一次（`src/modules/chat-session/hooks/useChatRealtimeHandlers.ts` 的 `STREAM_FLUSH_INTERVAL_MS = 100`），DOM 变化会反复触发这个 O(visible rows) 的布局读取。已有 debounce 和 RAF，但没有按行增量或缓存；这是滚动条像素估算，不是首屏关键路径，适合先 profile 再优化。

现有 transcript 的 100ms 合并、settled/pending 拆分、LazyMessageRow/IntersectionObserver、`contain + content-visibility` 都是正确的，不要重写；本任务只处理这个测量热点，并以真实流式场景读数决定是否改。

## AC

- [x] AC1 Profile：固定一个 >=100 行的 transcript + 正在流式输出的会话，用 Performance/React Profiler 记录 `rowsMeasured`、measure 调用次数、Layout/Recalculate Style/TaskDuration；先打印读数再判断。若无法取到真实流式场景，park `needs-human` 并说明，不得用静态 DOM 推断。
- [x] AC2 若确认显著：只测量新增/变化的行，或缓存行高，或把估算延后到滚动条需要时；保留滚动条像素估算、LazyMessageRow 占位高度和“加载全部”行为，不得改变 transcript 视觉/滚动。
- [x] AC3 复测：改后同一场景的测量次数/Layout/TaskDuration 有可重复下降，或记录“不显著，保持原样”的证据并关闭任务；不得为了改而改。
- [x] AC4 既有判据：transcript/滚动相关用例、`npm run typecheck`、`npm run lint`、架构棘轮 exit 0。

## DoD

- 测量热点有 profile 读数与结论；显著的才改，不显著的保持原样。
- 不改变 transcript 的渲染、懒加载、滚动条估算和“加载全部”行为；不引入新的持续动画/层。
- 既有测试/typecheck/lint 全绿；Touches 一致。

## Touches

- src/modules/chat/transcript/ChatMessagesPane.tsx
- src/modules/chat/transcript/LazyMessageRow.tsx
- src/modules/chat-transcript/hooks/useLazyRowObserver.ts
- tasks/gap-transcript-pixel-estimate-hotspot.md

## 验证记录

### AC1 场景与仪器（真实流式，不是静态 DOM 推断）

- 场景：playwright.config.ts 的隔离实例（真实 Chromium + 真实后端 + 真实 Vite 客户端），打开后端自己索引的种子会话 `e2e-transcript-jump`（REST `total=4800` 条绘制行）；用 transcript 自己的 older-page prefetch 把 `[data-transcript-content]` 的已绘制行数从 52 增到 **202 行**。
- 流式：只用 wire double 把 `stream_delta` 帧投递到 App 自己的 chat socket（`MessageEvent` 走 `onmessage`），其余全是真的——`useChatRealtimeHandlers` 的 100ms 合并、store、React、MutationObserver/ResizeObserver 全部是生产路径。5,000ms 内投递 50 个 delta（100ms 一帧），随后 `stream_end`。
- 仪器：Chromium CDP `Performance` 域在窗口前后各读一次（LayoutCount/LayoutDuration、RecalcStyleCount/RecalcStyleDuration、TaskDuration、ScriptDuration 均取差值）；`rowsMeasured` 由给 `HTMLElement.prototype.offsetHeight` 加计数器得到，只在 `measure()` 的同步批次内、且元素带 `data-message-timestamp` 时计数；`measure` 调用次数由 `[data-transcript-content]` 的 querySelector 调用点计数（栈帧已确认是 `ChatMessagesPane.tsx` 的 `measure`，`stackMatched=true`）。
- 读数先打印后判断（probe 在 `console.log('[px-probe] …')` 之后才做断言）。

### AC1 / AC3 读数

窗口 A（纯文本流，50 次 100ms flush，202 行）：

- rowsMeasured=202（row-height reads=203）
- measure 调用次数=**1**
- LayoutCount=1，LayoutDuration=0.34ms
- RecalcStyleCount=190，RecalcStyleDuration=19.9ms
- TaskDuration=3362ms，ScriptDuration=1199ms

窗口 B（最坏形状：文本流 + 每 900ms 追加一条新行，共 5 条新行，205 行）：

- rowsMeasured=205（row-height reads=1229）
- measure 调用次数=**6**（120ms debounce 把每次新行突发的多次 mutation 折成一次）
- LayoutCount=11，LayoutDuration=3.28ms
- RecalcStyleCount=213，RecalcStyleDuration=55.0ms
- TaskDuration=3469ms，ScriptDuration=1294ms

### 结论：不显著，保持原样（AC2 的条件不成立）

- 该测量占流式窗口 TaskDuration 的比例：≤3.28ms / 3469ms ≈ **0.1%**；即使把窗口 A 的全部 Layout 都算给它，也是 0.34ms。
- 触发频率与 Finding 的假设相反：50 次 100ms flush 只触发 **1** 次 measure；最坏形状（不断新增行）也只有 6 次 / 5s，不是“每次 DOM 变化”。原因是 observer 只监听 `childList`+`subtree` 与 `style`/`data-row-measured` 两个属性——流式 flush 改写的是存活行内部的文本（characterData），observer 看不见；ResizeObserver 的目标（滚动容器）尺寸也不变。
- 窗口里真正的开销是流式渲染本身（ScriptDuration≈1.2s、TaskDuration≈3.4s，即 markdown/React 管线），不是这个行高测量；本任务不改它（Finding 明确不重写流式/渲染路径）。
- 因此 AC2 的“若确认显著”前提不成立：未改任何产品代码，滚动条像素估算、LazyMessageRow 占位高度、懒加载与“加载全部”行为原样保留。AC3 走“记录不显著，保持原样”分支。
- 可复现性：probe 是临时 e2e spec（与仓库既有临时探针做法一致），读数已记在本段，跑完删除、未提交；两次独立运行读数一致（单行窗口 measureCalls 均为 1；新行窗口 6 次，LayoutDuration 3.28ms 量级）。

### AC4 既有判据（本 worktree 实测）

- transcript/滚动相关单测：`vitest run` 8 个文件 / **80 tests passed**（contentHeightModel、lazyMessageRow、transcriptScrollOwnership、sessionMessagePagination、chatMessageLocate、messageStreamEnd、transcriptExport、transcriptExportWorkSegments），exit 0。
- `npm run typecheck`：exit 0。
- `npm run lint`：exit 0（仅既有 warning）。
- 架构棘轮 `server/shared/tests/architecture-ratchet.test.ts`：6 pass / 0 fail，exit 0（另有既有的“可下调基线”提示，非本任务引入；未改基线）。

### ADR-007 暗轴

- 该轴仍暗,理由:本任务只做前端测量热点的 profile 与结论，读数不显著故未改任何代码或依赖图，没有 L_D/L_G 可量化读数。
