---
id: architecture-plantuml-rendering
title: architecture tab 换 plantuml-js 渲染：ELK 分层 + UML 原生语法 + overview/neighborhood 视图
status: ready
labels:
  - feature
parent: null
children: []
extra: {}
depends_on:
  - architecture-renderer-contract
---
## Proposal

用户拍板：architecture tab 从 cytoscape 换 plantuml-js（@yalehwang/plantuml-js，ELK 分层布局 + UML class diagram 原生语法）。现状痛点：cose 力导向对分层架构不直观、UML 箭头/class box 手搓。plantuml-js 已验证（789 节点真实邻域）：overview depth=2 塌到 44 节点/8 crossings/96ms 可读阶梯，neighborhood 下钻 50ms，nodeIntersect 全场景 0。接入：前端加 archguardToPlantUml 桥接（映射表已定：dependency/call→`..>`+stereotype、composition/aggregation→`o--`、inheritance→`--|>`、implementation→`..|>`），换 plantuml-js 渲染器（懒加载 elkjs ~1.6MB），overview/neighborhood 视图替换 maxNodes/maxHops 截断。cytoscape 组件移除（其 UML 箭头映射直接复用进桥接）。

依赖版本：`@yalehwang/plantuml-js@^0.2.0`（已发布可安装）。后端用 `@yalehwang/plantuml-js/archguard`（archguardToPlantUml 纯函数零依赖，不拖渲染器）；前端 `await import('@yalehwang/plantuml-js/elk')` 懒加载（viz-free、无 WASM、只有 elkjs ~1.6MB，elkjs 的 worker 是内联 blob 自包含、vite 无需配 worker 路径）。

## AC

- [x] 前端桥接函数 exit 0：JSON 邻域 → .puml，映射表正确（composition→o-- 不升 *--；call→..> 非实线；显示名 relpath.EntityName 前截不截后）
- [x] 前端测试 exit 0：plantuml-js 渲染 SVG、overview 视图点组展开、neighborhood 点实体下钻 hops+1、hover 高亮入/出边
- [x] `npm run typecheck` 与 `npm run build` 通过；plantuml-js 走 dynamic import 懒加载（不增大首屏主 chunk）

## DoD

真实大项目会话（archguard 789 节点邻域）在浏览器打开 architecture tab：plantuml-js 渲染出 ELK 分层图，overview 默认 44 节点可读，点组展开、点实体下钻即时（<0.5s），UML 箭头（空心三角/空心菱形/虚线依赖）原样呈现。

## Touches

- package.json
- package-lock.json
- src/modules/architecture/ArchitecturePanel.tsx
- src/modules/architecture/useArchitectureGraph.ts
- src/modules/architecture/PlantUmlGraph.tsx
- src/modules/architecture/archguardToPlantUml.ts
- src/modules/architecture/tests/architectureTab.test.tsx
- src/modules/i18n/locales/en/chat.json
- tasks/architecture-plantuml-rendering.md

## Blocker

**2026-10-21T16:06:43.434Z — worker 未落地（exited-not-landed）**

- 未落地原因：AC 未全勾（checked 0/3，剩余未勾 3）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：6c8395db-e9b9-4958-a87f-ac7ed39dda13
