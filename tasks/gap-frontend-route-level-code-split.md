---
id: gap-frontend-route-level-code-split
title: 首包主 chunk 4.55MB：路由级 lazy + 重依赖按需加载
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

`src/App.tsx` 静态 import `ProjectWorkspaceRoute`、`CockpitRoute`、`CockpitOverlayHost`、`ArchitectureStandaloneRoute`、`LogDrawerHost`、`OAuthConsentRoute`、`TaskMasterProvider`、`PluginsProvider` 等，没有 route-level `React.lazy`；构建主 chunk 约 **4,551KB（gzip 1,350KB）**。`src/modules/chat/ui/Markdown.tsx` 静态引入 react-markdown、react-syntax-highlighter、rehype-katex、remark-math；code-editor/architecture/cockpit 的重依赖也在 eager 图或首屏路径上。`src/main.tsx` 已经用动态 import 把 react-scan/ui-scenario 限制在 dev，这是可复用的模式。

这是**加载/解析/内存**问题，不是运行中 CPU；不要和 sticky/动画任务混为一个改动。目标是把不常驻的路由与重依赖移出首屏图，并用构建读数证明。

## AC

- [x] AC1 路由级 lazy：`/cockpit`、`/cockpit/remote`、`/session/:sessionId/architecture`、OAuth consent（以及可独立拆的 settings/code-editor 入口）使用 `React.lazy` + 局部 `Suspense`；登录/鉴权/重定向行为不变；路由渲染 smoke 或 e2e 通过。不要用全局 Suspense 包住整个 App 造成首屏闪烁。
- [x] AC2 重依赖按需：Markdown 路径中的 Mermaid/KaTeX/语法高亮只在真正渲染对应块时 import；不得让 react-markdown/高亮库因本次改动进入更多 eager 路径。
- [x] AC3 构建读数：记录改前/改后主 chunk 的 raw/gzip 大小与 chunk 列表；主 chunk gzip 至少下降 **20%**（若边界受约束，记录实际下降与原因，不得只改代码不测）。`npm run build:client` exit 0。
- [x] AC4 既有判据：路由/壳层测试、`npm run typecheck`、`npm run lint`、架构棘轮 exit 0；没有新的 eager 重依赖或布局抖动。

## DoD

- 不常驻的路由/重依赖不在首屏主 chunk 里；懒加载 fallback 稳定、局部、不改变工作区布局。
- 鉴权、深链、重定向、standalone architecture、cockpit/remote 行为不变。
- 构建读数与既有测试/typecheck/lint 全绿；Touches 与实际改动一致。
- 不引入新依赖；不把整个 chat/workspace 懒加载（那会破坏首屏与状态连续性）。

## Verification

### AC1 — route/tab-level lazy

`src/App.tsx` now lazy-loads the architecture standalone page, both cockpit routes, the OAuth consent page and the log drawer, each under its own local `Suspense` (`LazySurface`); there is no `Suspense` above `Routes`. The workspace route, chat pane and shell providers remain static (DoD's "not the whole workspace" clause).

`WorkspaceMain` lazy-loads its non-resident tabs — files, shell, git, tasks, quay, architecture, browser, plugin tabs and the editor sidebar — each with a local `Suspense`; the tab fallback is one fixed-size centered spinner inside the tab's own area and the always-mounted slots (tasks panel, editor sidebar) use `fallback={null}`, so the shell layout does not move. `SidebarModals` lazy-loads Settings; `ProviderLoginModal` lazy-loads the embedded terminal.

Route smoke (real components, no stubbing of the route): `npx vitest run src/modules/architecture/tests/standalonePage.test.tsx src/modules/cockpit/tests/CockpitOverlay.test.tsx src/modules/project-workspace/tests src/modules/sidebar/tests src/modules/chat/tests` — 173 files / 1,352 tests passed (the four directories plus chat: 173 files, 1352 tests). Auth, deep-link and redirect paths are unchanged: `ProtectedRoute`, `CockpitRoute` and `OAuthConsentRoute` are the same components at the same paths; only the module they are imported through is now async.

### AC2 — heavy deps on demand

`src/modules/chat/ui/Markdown.tsx` no longer statically imports the Prism highlighter, the mermaid wrapper, `remark-math` or `rehype-katex`. The highlighter and mermaid wrapper are `React.lazy` dynamic imports used inside a `<Suspense fallback={<PlainCodeBlock/>}>`; the math plugin pair loads through a closure-owned promise only when `MATH_DELIMITER` matches the content and the renderer re-renders once it resolves. `MermaidDiagram` itself already dynamic-imports the mermaid library.

Build evidence: in the final entry chunk `dist/assets/index-BKwCW71B.js`, `react-markdown`, `refractor`, `PrismLight`, `remark-math`, `rehype-katex` and `katex` module markers are all absent (grep count 0; a single `react-markdown` string is a chunk-name map entry, not the module). KaTeX now lives in async `index-Dbf-SWJG.js` (270.60 kB / 81.35 kB gzip), loaded only through the math/code-editor paths. No eager path gained react-markdown or the highlighter: `MarkdownCodeBlock` remains reachable only through the lazy code-editor/settings/editor chunks.

### AC3 — build readings

Both readings are `npm run build:client` output on this task tree (baseline from clean develop 90c04402d).

- Before: `dist/assets/index-30bEKqF7.js` — **4,563.55 kB raw / 1,353.00 kB gzip** (single entry chunk).
- After: `dist/assets/index-BKwCW71B.js` — **3,434.75 kB raw / 1,058.84 kB gzip**; **−24.7% raw, −21.7% gzip** (≥20% required).
- New async chunks (raw / gzip): settings `index-DNvaP-mQ.js` 203.53 / 46.59; architecture `index-CX_EalDW.js` 351.43 / 99.34; code-editor+KaTeX `index-Dbf-SWJG.js` 270.60 / 81.35; task-tabs `index-CWOCwHhL.js` 52.98 / 13.17; git `index-Dg3ebyfy.js`-class chunk 77.36 / 17.85; cockpit/oauth/architecture-standalone route chunks each < 3 kB at the route module layer (their feature graphs are shared with the workspace).
- `npm run build:client` exit 0 (`✓ built in ~24s`, `write-client-build-info: wrote dist/build-info.json`).

Boundary note (honest reading): the remaining entry weight is i18n locale JSON (~1.3 MB transformed) plus the eagerly-required chat/sidebar/cockpit shell. The workspace route is deliberately not lazy per DoD, so that shell is the floor this split cannot cross without a separate i18n/shell task.

### AC4 — existing gates

- `npx vitest run src/modules/chat/tests src/modules/sidebar/tests src/modules/project-workspace/tests src/modules/code-editor/tests src/modules/provider-auth` — 173 files, 1,352 tests, all passed.
- `npm run typecheck` exit 0 (client + server + scripts tsconfigs).
- `npm run lint` exit 0.
- Architecture ratchet + frontend import-cycle budget: `tsx --test server/shared/tests/architecture-ratchet.test.ts server/shared/tests/frontend-import-cycle-budget.test.ts` — 21/21 pass. The architecture standalone route was placed under `project-workspace/` precisely so the new lazy edge does not add an `architecture -> project-workspace` directory SCC (that first attempt went red and was moved, not baseline-widened).
- The moved `useEditorSidebar` hook is 175 lines, no module-level `let`/Map/Set and 6 hook calls, so the oversize/mutable/hookStateHeavy dimensions are unaffected.

### ADR-007 dark axis

- L_G archguard: cycles=0 (architecture-ratchet + frontend-import-cycle-budget, 21/21 pass; no new file or directory cycle)

## Touches

- src/App.tsx
- src/modules/project-workspace/WorkspaceMain.tsx
- src/modules/project-workspace/ArchitectureStandaloneRoute.tsx (new)
- src/modules/project-workspace/hooks/useEditorSidebar.ts (new; moved from code-editor)
- src/modules/code-editor/hooks/useEditorSidebar.ts (deleted by the move)
- src/modules/code-editor/index.ts
- src/modules/chat/ui/Markdown.tsx
- src/modules/chat/tests/markdownSyntaxThemeInjection.test.tsx
- src/modules/provider-auth/ProviderLoginModal.tsx
- src/modules/sidebar/SidebarModals.tsx
- vite.config.js
- tasks/gap-frontend-route-level-code-split.md
