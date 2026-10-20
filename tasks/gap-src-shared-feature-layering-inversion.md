---
id: gap-src-shared-feature-layering-inversion
title: Break the shared→feature layering inversion in src (WebSocketContext
  imports modules/auth and modules/settings)
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

F1（架构校准报告 2026-10-20，ArchGuard 0.1.40 加独立源码扫描，HEAD `abc2b5ed9`）：`src` 里有一个 42 个包的巨型目录环，涉及 15 个顶层模块。

度量：单个 SCC 含 42 个包、109 条内部包边，其中 52 条跨越顶层模块边界；独立源码扫描复现出完全相同的 42 成员集合。

成员：`modules/{auth,chat,chat/*,code-editor,code-editor/markdown,command-palette,command-palette/hooks,mcp,onboarding,plugins,prd-editor,provider-auth,settings,settings/*,shell,skills,standalone-shell,task-master,task-master/*}` 加 `shared/context`、`shared/ui`。

已验证的闭合边：
- `src/shared/context/WebSocketContext.tsx:3` `import { useAuth } from '@/modules/auth'`（立案时已在本树逐行确认）
- `src/shared/context/WebSocketContext.tsx:4` `import { readDeviceName } from '@/modules/settings'`（同上）
- `src/modules/settings/hooks/useSettingsController.ts:3` `import { useTheme } from '@/shared/context/ThemeContext'`
- `src/modules/settings/Settings.tsx:6`、`src/modules/settings/SettingsSidebar.tsx:5` 导入 `@/shared/ui`
- `src/shared/ui/DarkModeToggle.tsx:3` `import { useTheme } from '@/shared/context/ThemeContext'`
- 最短环：`shared/context → modules/settings → shared/ui → shared/context`
- `src/modules/auth/ProtectedRoute.tsx:6` `import { Onboarding } from '@/modules/onboarding'`；`shared/context → modules/auth` 闭合 auth 分支

为什么重要：`shared/` 层反过来依赖 feature 模块（`shared → modules/auth`、`shared → modules/settings`），这是层序倒置，不只是目录环。它让 `shared` 无法独立复用与独立测试，并逼出对加载顺序敏感的工作区写法（服务端 F3 已有一处被迫改成动态导入的注释为证）。

改法（报告给出的 remediation）：反转 `shared` 的这两条边。`WebSocketContext` 经 port/provider 接收 auth 与 session-host 回调，或接收 device-name 值（把依赖 auth 的那部分移到 `shared/` 之外的应用级 provider）；`readDeviceName` 是纯偏好读取，移到 `shared/userSettings`。然后用公开 barrel 与单向 feature 依赖收拾余下的 feature 缠结。

<!-- dedup-ref --> 相关但不同机制：`gap-live-host-for-session-canonicalize`（done）处理的是 live host 的会话规范化，不是 `src` 的层序倒置；`gap-ac394-server-import-cycle-budget`（done）是服务端目录图的棘轮/预算（只数结构与基线），不是本条的修复。另与本批 `gap-chat-settings-composer-transcript-cycles` 相关但独立验收：那条治 `chat↔settings` 与 `composer↔transcript` 两个 feature 环，本条治 `shared→feature` 反向依赖；两者都涉及 `src/modules/settings/hooks/useMcpNavigationSettings.ts` 里的纯偏好读取，调度器按 Touches 串行。去重检索实测：`layering inversion` → 0，`shared 不得回指 modules` 仅命中 AC-394 的棘轮（done，机制不同），`WebSocketContext` 的命中均为其它机制的功能任务（device identity、resident 状态等）。

## AC

- [ ] `test -z "$(grep -rn "@/modules/" src/shared --include='*.ts' --include='*.tsx')"`：`src/shared` 对 `@/modules` 的 import 为 0（立案时 2 条，均在 `WebSocketContext.tsx`），命令退出 0。
- [ ] 新增 `src/shared/tests/sharedLayerIsolation.test.tsx`，`npx vitest run src/shared/tests/sharedLayerIsolation.test.tsx` 退出 0。该用例必须真的证明隔离：在 vitest 里把 `@/modules` 映射成一个「被导入即抛错」的桩模块，再导入并渲染 `src/shared/context/WebSocketContext.tsx` 与 `src/shared/index.ts`；桩模块的抛错计数必须为 0（正例对照：同一用例第二段显式导入该桩，计数变为 1，证明桩确实有区分力）。
- [ ] 结构读数（外部工具，归档用）：对 `src` 跑一次新鲜 `archguard_detect_cycles(outputScope=package)`，SCC 成员里不再含任何 `shared/*` 包；同一查询报告 SCC 规模严格小于基线 42。贴出前后两次成员清单与规模（基线 42 记在正文）。该读数为 ArchGuard MCP 查询（待外部）。
- [ ] `npm run typecheck` 退出 0，`npm run lint` 退出 0。
- [ ] `git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件（不多一个）。

## DoD

真实落地的标准是「`shared` 在没有任何 feature 模块参与的情况下可加载、可渲染」，不是「移走了一行 import」。必须贴出：①`grep -rn "@/modules/" src/shared` 的前后计数（前 2、后 0）；②隔离判据的 `Test Files / Tests` 读数，以及桩模块抛错计数 0 与正例对照 1 两次读数；③`WebSocketContext.tsx` 新的 auth/device-name 获取方式原文（port 或注入值），并说明应用装配点在哪注入；④ArchGuard 的 SCC 前后成员清单与规模（42 → 实际值）；⑤typecheck / lint 退出码；⑥取假形态：把 `import { useAuth } from '@/modules/auth'` 临时加回 `WebSocketContext.tsx` ⇒ AC1 红（计数 1）且隔离判据红（桩被导入即抛错），还原后复绿，附两次读数。若隔离判据无法在不启动真实 WebSocket 的前提下渲染，允许把「渲染」降级为「导入并取默认导出」，但必须在完成记录写明降级理由，不得删掉桩的抛错计数。

## Touches

- src/shared/context/WebSocketContext.tsx（去掉 `@/modules/auth` 与 `@/modules/settings` 两条 import，改为 port / 注入值）
- src/shared/userSettings.ts (new)（`readDeviceName` 的共享实现）
- src/shared/index.ts（导出共享读取）
- src/modules/settings/hooks/useMcpNavigationSettings.ts（`readDeviceName` 迁出，保留其余 policy 读取）
- src/modules/settings/index.ts（去掉 `readDeviceName` 的转出口）
- src/shared/tests/sharedLayerIsolation.test.tsx (new)（隔离判据：`@/modules` 桩抛错计数）
- tasks/gap-src-shared-feature-layering-inversion.md (self)
