---
id: gap-frontend-route-level-code-split
title: 首包主 chunk 4.55MB：路由级 lazy + 重依赖按需加载
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

`src/App.tsx` 静态 import `ProjectWorkspaceRoute`、`CockpitRoute`、`CockpitOverlayHost`、`ArchitectureStandaloneRoute`、`LogDrawerHost`、`OAuthConsentRoute`、`TaskMasterProvider`、`PluginsProvider` 等，没有 route-level `React.lazy`；构建主 chunk 约 **4,551KB（gzip 1,350KB）**。`src/modules/chat/ui/Markdown.tsx` 静态引入 react-markdown、react-syntax-highlighter、rehype-katex、remark-math；code-editor/architecture/cockpit 的重依赖也在 eager 图或首屏路径上。`src/main.tsx` 已经用动态 import 把 react-scan/ui-scenario 限制在 dev，这是可复用的模式。

这是**加载/解析/内存**问题，不是运行中 CPU；不要和 sticky/动画任务混为一个改动。目标是把不常驻的路由与重依赖移出首屏图，并用构建读数证明。

## AC

- [ ] AC1 路由级 lazy：`/cockpit`、`/cockpit/remote`、`/session/:sessionId/architecture`、OAuth consent（以及可独立拆的 settings/code-editor 入口）使用 `React.lazy` + 局部 `Suspense`；登录/鉴权/重定向行为不变；路由渲染 smoke 或 e2e 通过。不要用全局 Suspense 包住整个 App 造成首屏闪烁。
- [ ] AC2 重依赖按需：Markdown 路径中的 Mermaid/KaTeX/语法高亮只在真正渲染对应块时 import；不得让 react-markdown/高亮库因本次改动进入更多 eager 路径。
- [ ] AC3 构建读数：记录改前/改后主 chunk 的 raw/gzip 大小与 chunk 列表；主 chunk gzip 至少下降 **20%**（若边界受约束，记录实际下降与原因，不得只改代码不测）。`npm run build:client` exit 0。
- [ ] AC4 既有判据：路由/壳层测试、`npm run typecheck`、`npm run lint`、架构棘轮 exit 0；没有新的 eager 重依赖或布局抖动。

## DoD

- 不常驻的路由/重依赖不在首屏主 chunk 里；懒加载 fallback 稳定、局部、不改变工作区布局。
- 鉴权、深链、重定向、standalone architecture、cockpit/remote 行为不变。
- 构建读数与既有测试/typecheck/lint 全绿；Touches 与实际改动一致。
- 不引入新依赖；不把整个 chat/workspace 懒加载（那会破坏首屏与状态连续性）。

## Touches

- src/App.tsx
- src/modules/project-workspace/ProjectWorkspaceRoute.tsx
- src/modules/chat/ui/Markdown.tsx
- vite.config.js
- tasks/gap-frontend-route-level-code-split.md
