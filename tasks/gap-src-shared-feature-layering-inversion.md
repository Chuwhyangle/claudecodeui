---
id: gap-src-shared-feature-layering-inversion
title: Break the shared→feature layering inversion in src (WebSocketContext
  imports modules/auth and modules/settings)
status: done
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

- [x] `test -z "$(grep -rnE "from ['\"]@/modules/|import\(['\"]@/modules/" src/shared --include='*.ts' --include='*.tsx' --exclude-dir=tests)"`：`src/shared` 的**生产代码**对 `@/modules` 的静态/动态 import 为 0（立案时 2 条，均在 `WebSocketContext.tsx`），命令退出 0。**判据修订（实测）**：原文的 `grep -rn "@/modules/" src/shared` 在立案 commit `abc2b5ed9` 上实测 **9** 条而非正文所写的 2 条——2 条生产 import + 5 条 `src/shared/tests/*` 的测试引用 + 1 条注释（`voiceClientFrontend.ts:9`）；且 AC2 要求新增的隔离判据自身必须 `vi.mock('@/modules/…')`，字面命令与 AC2 互斥。故按正文「立案时 2 条」的口径把命令限定为生产 import（排除 tests 与注释），实测 2 → 0。原始 grep 9 → 8，剩余 8 条全是 tests/注释。详见 Completion Record。
- [x] 新增 `src/shared/tests/sharedLayerIsolation.test.tsx`，`npx vitest run src/shared/tests/sharedLayerIsolation.test.tsx` 退出 0。该用例必须真的证明隔离：在 vitest 里把 `@/modules` 映射成一个「被导入即抛错」的桩模块，再导入并渲染 `src/shared/context/WebSocketContext.tsx` 与 `src/shared/index.ts`；桩模块的抛错计数必须为 0（正例对照：同一用例第二段显式导入该桩，计数变为 1，证明桩确实有区分力）。
- [x] 结构读数（外部工具，归档用）：对 `src` 跑一次新鲜 `archguard_detect_cycles(outputScope=package)`，SCC 成员里不再含任何 `shared/*` 包；同一查询报告 SCC 规模严格小于基线 42。贴出前后两次成员清单与规模（基线 42 记在正文）。该读数为 ArchGuard MCP 查询（待外部）。
- [x] `npm run typecheck` 退出 0，`npm run lint` 退出 0。
- [x] `git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件（不多一个）。

## DoD

真实落地的标准是「`shared` 在没有任何 feature 模块参与的情况下可加载、可渲染」，不是「移走了一行 import」。必须贴出：①`grep -rn "@/modules/" src/shared` 的前后计数（前 2、后 0）；②隔离判据的 `Test Files / Tests` 读数，以及桩模块抛错计数 0 与正例对照 1 两次读数；③`WebSocketContext.tsx` 新的 auth/device-name 获取方式原文（port 或注入值），并说明应用装配点在哪注入；④ArchGuard 的 SCC 前后成员清单与规模（42 → 实际值）；⑤typecheck / lint 退出码；⑥取假形态：把 `import { useAuth } from '@/modules/auth'` 临时加回 `WebSocketContext.tsx` ⇒ AC1 红（计数 1）且隔离判据红（桩被导入即抛错），还原后复绿，附两次读数。若隔离判据无法在不启动真实 WebSocket 的前提下渲染，允许把「渲染」降级为「导入并取默认导出」，但必须在完成记录写明降级理由，不得删掉桩的抛错计数。

## Touches

- src/shared/context/WebSocketContext.tsx（去掉 `@/modules/auth` 与 `@/modules/settings` 两条 import；auth 改为注入 `WebSocketAuthPort`，device-name 改从 shared 读取）
- src/shared/userSettings.ts（既存文件；新增 `readDeviceName` / `resolveDeviceName` / `MCP_DEVICE_NAME_STORAGE_KEY` 的共享实现）
- src/shared/index.ts (new)（导出共享读取）
- src/modules/settings/hooks/useMcpNavigationSettings.ts（`readDeviceName` 迁出，保留其余 policy 读取）
- src/modules/settings/index.ts（去掉 `readDeviceName` 的转出口）
- src/shared/tests/sharedLayerIsolation.test.tsx (new)（隔离判据：`@/modules` 桩抛错计数）
- src/App.tsx（应用装配点：`AuthenticatedWebSocket` 读取 `useAuth()` 并注入 auth port）
- src/modules/chat/hooks/useUiStateResponder.ts（`readDeviceName` 改从 `@/shared/userSettings` 导入）
- src/modules/settings/tests/mcpNavigationSettings.test.tsx（device-name 读取改从 shared 导入）
- src/modules/auth/tests/clientClockCannotExpireSession.test.tsx（`WebSocketProvider` 改为传注入的 auth port）
- src/shared/tests/deviceIdentity.test.ts（同上；device name 改由 shared reader 从 localStorage 读取）
- tasks/gap-src-shared-feature-layering-inversion.md (self)

## Completion Record

### ① `src/shared → @/modules` 计数

- 立案 commit `abc2b5ed9` 的**原始**命令 `grep -rn "@/modules/" src/shared --include='*.ts' --include='*.tsx'`：**9** 条（正文写的 2 条只数了生产 import）。分解：`WebSocketContext.tsx:3,4`（2 条生产 import）+ `tests/deviceIdentity.test.ts:24,31`、`tests/debug-agent-display-identity.test.ts:8`、`tests/voiceUpload16k.test.ts:30,31,192`（5 条测试引用）+ `voiceClientFrontend.ts:9`（1 条注释）。
- 修订后的生产口径（`from '@/modules/` 或 `import('@/modules/`，`--exclude-dir=tests`）：**2 → 0**，命令退出 0。
- 原始命令在本分支：**9 → 8**；剩余 8 条全在 `src/shared/tests/` 与注释，其中 `tests/sharedLayerIsolation.test.tsx` 的 3 条是 AC2 要求的桩声明本身（故字面原始命令与 AC2 不可同时满足）。
- 未改动的共享测试引用：`debug-agent-display-identity.test.ts` 是 GOAL-007 / AC-136 的 criterion（路径与内容被 `server/modules/debug-agent/tests/debug-agent-host-driver.test.ts` 钉住，不得移动），它读的是 sidebar 出货表达式 `PROVIDER_LABELS`；`voiceUpload16k.test.ts` 测 chat 的 `useVoiceInput`。移动/改写它们属于 GOAL-007 判据与 chat 测试的独立任务，不在本条的层序倒置修复范围内。

### ② 隔离判据读数

```
[shared-layer-isolation] (a) stub import count after barrel import + provider render: 0 (expected 0)
[shared-layer-isolation] (b) control stub import count: 1 (expected 1)
Test Files  1 passed (1)
     Tests  1 passed (1)
```

渲染未降级：`WebSocketProvider` 以注入的 auth port + fake `WebSocket` 真实 mount（不触发 `onopen`，不上线），并导入 `src/shared/index.ts` 取 `readDeviceName`。正例对照的导入被 vitest 包成 `Error: [vitest] There was an error when mocking a module…`，其 `Caused by: Error: shared layer imported a feature module` 证明桩自身的抛错被触发。

### ③ WebSocketContext 新的获取方式与装配点

```tsx
// src/shared/context/WebSocketContext.tsx
export type WebSocketAuthPort = {
  isLoading: boolean;
  token: string | null;
  user: unknown;
};
...
const useWebSocketProviderState = (auth: WebSocketAuthPort): WebSocketContextType => {
  ...
  const { isLoading: isAuthLoading, token, user } = auth;
...
export const WebSocketProvider = (
  { children, auth }: { children?: React.ReactNode; auth: WebSocketAuthPort },
) => { const webSocketData = useWebSocketProviderState(auth); ... }
```

device-name：

```tsx
import { readDeviceName } from '@/shared/userSettings'; // 纯共享读取，不经过 modules/settings
```

应用装配点在 `src/App.tsx`：`AuthenticatedWebSocket` 位于 `<AuthProvider>` 内，读 `useAuth()` 后注入：

```tsx
function AuthenticatedWebSocket({ children }: { children: ReactNode }) {
  const { isLoading, token, user } = useAuth();
  return <WebSocketProvider auth={{ isLoading, token, user }}>{children}</WebSocketProvider>;
}
```

`src/shared/userSettings.ts` 新增 `MCP_DEVICE_NAME_STORAGE_KEY`、`resolveDeviceName`、`readDeviceName`（User-Agent 粗粒度默认名逻辑一并迁入）；`src/shared/index.ts` 导出 `readDeviceName`。`modules/settings` 的 hook 改为从 shared 导入这三个符号，barrel 不再转出 `readDeviceName`。

### ④ ArchGuard SCC 前后

两次均为本次会话的新鲜 `archguard_analyze` + `archguard_detect_cycles(outputScope=package)`：

- **前**（临时 detached worktree 于 `develop` tip `d8f9ecc46`，scope key `e8201660`）：SCC **42** 成员，含 `shared/context`、`shared/ui`；成员逐字与正文基线一致。
- **后**（本 task worktree，scope key `0f3a87d9`）：SCC **31** 成员，**不再含任何 `shared/*`**；规模 42 → 31（严格小于基线）。另一个 3 成员 SCC（`modules/git-panel{,/changes,/history}`）前后不变。
- 后读数 31 成员：`modules/auth, chat, chat/audio, chat/composer, chat/export, chat/hooks, chat/outline, chat/tools, chat/tools/ContentRenderers, chat/transcript, chat/utils, chat/voice-realtime, onboarding, provider-auth, settings, settings/hooks, settings/tabs, settings/tabs/agents-settings, settings/tabs/agents-settings/sections, settings/tabs/agents-settings/sections/content, settings/tabs/api-settings, settings/tabs/api-settings/sections, settings/tabs/browser-use-settings, settings/tabs/git-settings, settings/tabs/tasks-settings, shell, standalone-shell, task-master, task-master/context, task-master/hooks, task-master/modals`。
- 移出 SCC 的成员（不再处于任何报告出的环）：`modules/chat/modals`、`code-editor{,/markdown}`、`command-palette{,/hooks}`、`mcp`、`plugins`、`prd-editor`、`skills`、`shared/context`、`shared/ui`。

### ⑤ typecheck / lint

- `npm run typecheck` → exit **0**
- `npm run lint` → exit **0**（仅既有 warning；本次改动未新增 warning）

### ⑥ 取假形态

把 `import { useAuth } from '@/modules/auth'` 临时加回 `WebSocketContext.tsx` 时，**另加 `void useAuth;`** 使该 import 成为活边：esbuild 会直接删掉未使用的 import（实测 transform 输出不含该行），未使用 import 不构成真实打包边。

| 形态 | 生产口径计数 | AC1 命令 | 隔离判据 |
|---|---|---|---|
| 假形态（import + `void useAuth`） | 1 | 非 0 退出（FAIL） | 套件 FAIL：`Caused by: Error: shared layer imported a feature module`（无测试可跑） |
| 还原后 | 0 | exit 0（PASS） | `Test Files 1 passed / Tests 1 passed` |

还原用 `git restore src/shared/context/WebSocketContext.tsx`，`git status --short` 为空。

### 其他验证

- 受影响的四个前端测试文件：`sharedLayerIsolation`、`deviceIdentity`、`mcpNavigationSettings`、`clientClockCannotExpireSession` → `Test Files 4 passed / Tests 20 passed`。
- 未运行全量 suite（由 fan-in 负责）。