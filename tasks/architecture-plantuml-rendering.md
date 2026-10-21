---
id: architecture-plantuml-rendering
title: architecture tab 换 plantuml-js 渲染：ELK 分层 + UML 原生语法 + overview/neighborhood 视图
status: done
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

## Evidence

- 2026-10-22T00:10Z（worktree `architecture-plantuml-rendering`，HEAD 已 merge develop）：AC1 桥接映射表的唯一来源是 `@yalehwang/plantuml-js/archguard` 的 `ARCHGUARD_RELATION_ARROWS`（`src/modules/architecture/archguardToPlantUml.ts:1`）；composition→`o--`（不升 `*--`）、call→`..>`（非实线）、显示名 relpath 截前不截后均由 `src/modules/architecture/tests/architectureTab.test.tsx` 逐条断言。
- AC2 同一 spec 覆盖 plantuml-js 渲染 SVG、overview 点组展开、neighborhood 下钻 hops+1、hover 入/出边高亮；实测 `npx vitest run src/modules/architecture/tests/architectureTab.test.tsx` → `20 passed (20)`，`Test Files 1 passed`，7.54s。
- AC3 实测 `npm run typecheck` → exit 0（client/server/scripts 三份 tsconfig）；`npm run build` → exit 0（vite build 22.41s + build:server）。懒加载读数：产物 `dist/assets/elk-BHX33hGi.js` 1,467.03 kB 为独立 chunk，主 `index-*.js` 未内联 elk；源码唯一入口是 `await import('@yalehwang/plantuml-js/elk')`（`src/modules/architecture/PlantUmlGraph.tsx:271`），Touches 的 `src/modules/i18n/locales/en/chat.json` 与 panel 接缝已在 develop。
- 依赖面：`@yalehwang/plantuml-js` 由 `file:vendor/plantuml-js/yalehwang-plantuml-js-0.1.0.tgz` 切到 registry `^0.2.0`；`package-lock.json` 的 resolved 为 `https://registry.npmjs.org/@yalehwang/plantuml-js/-/plantuml-js-0.2.0.tgz`；node_modules 实测 `version: 0.2.0`，exports 含 `.` / `./elk` / `./archguard`。
- 回归面：上次 suite 红的 `server/shared/tests/quay-test-script.test.ts` 单文件复跑 → `14 pass / 0 fail`（98.6s）。
- anti-drift Touches 硬门：`ANTI-DRIFT OK — task architecture-plantuml-rendering — 2 actual file(s), all within declared Touches (9 glob(s))`（delta vs develop = `package.json`、`package-lock.json`）。
- `task_check` → `ok:true, acTotal:3, acChecked:3`。

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
