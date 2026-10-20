---
id: gap-server-provider-websocket-init-cycle-ports
title: Break the server provider/websocket/mcp-gateway/session-hosts
  initialization cycle with ports
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

F3（架构校准报告 2026-10-20，ArchGuard 0.1.40 加独立源码扫描，HEAD `abc2b5ed9`）：服务端有一个环绕 providers / websocket / mcp-gateway / session-hosts / voice-realtime 的 11 包初始化环。

度量：单个 SCC 含 11 个包、26 条内部包边，其中 19 条跨越顶层模块边界，涉及 7 个顶层模块；独立源码扫描复现出完全相同的 11 成员集合。

成员：`modules/{mcp-gateway,projects,projects/services,providers,providers/list/claude,providers/services,session-hosts,voice,voice-realtime,websocket,websocket/services}`。

已验证的边：
- `server/modules/mcp-gateway/mcp-session-host-control.ts:44,50` → `@/modules/session-hosts/index.js`；反向 `server/modules/session-hosts/session-hosts.routes.ts:45` → `@/modules/mcp-gateway/mcp-session-host-control.js`。短环：`mcp-gateway ↔ session-hosts`。
- `server/modules/mcp-gateway/mcp-gateway.transport.ts:19` → `@/modules/projects/index.js`；`:21` → `@/modules/websocket/index.js`；`mcp-approvals.ts:41`、`mcp-session-background.ts:42`、`mcp-gateway.write-tools.ts:45` → `@/modules/providers/index.js`。
- 反向：`server/modules/websocket/services/chat-run-registry.service.ts:4`、`chat-control.service.ts:6`、`shell-websocket.service.ts:8` → `@/modules/providers/index.js`。
- `server/modules/providers/list/claude/claude.provider.ts:21` → `@/modules/websocket/services/websocket-state.service.js`；闭合 `websocket/services → providers → providers/list/claude → websocket/services`。
- `server/modules/providers/services/{mcp,sessions,session-synchronizer,skills,provider-auth,provider-models,provider-runtime}.service.ts`（第 1/2/4/5/9 行）→ `@/modules/providers/provider.registry.js`；`providers/index.ts` 再导出这些 service ⇒ `providers ↔ providers/services`。
- `server/modules/voice-realtime/voice-realtime-live-executor.ts:59` → `@/modules/mcp-gateway/index.js`。
- `server/modules/providers/list/claude/claude-host-driver.provider.ts:1826` 动态导入 `@/modules/voice-realtime/index.js`；`:1801-1816` 的注释记录：改成静态导入会抛 `ReferenceError: Cannot access 'ClaudeResidentHostDriver' before initialization`。

为什么重要：这个环已经对加载顺序敏感——一条边被迫改成延迟动态导入并留长注释；其余边仍约束初始化顺序。任何跨这些模块的新静态导入都可能造成进程启动失败，而单元测试抓不到。

改法（报告给出的 remediation）：在这些接缝处引入 port（`SessionHostControlPort`、`ChatRunRegistryPort`、`ProviderRegistryPort`），port 归中性模块所有（`server/shared/` 或各模块的 `*-port.ts`），实现由 `server/index.ts` 注入；至少把 `provider.registry.ts` 的使用挪到注入的访问器之后，使 `providers/services` 不再导入父目录文件。

<!-- dedup-ref --> 相关但不同机制：`gap-ac394-server-import-cycle-budget`（done）是目录图的棘轮与基线（只数 SCC、只让环缩小），不是本条的修复；本条的验收是启动期导入图真的能在无动态导入兜底的情况下加载，且三条点名边消失。去重检索实测：`SessionHostControlPort` → 0，`ProviderRegistryPort` → 0，`before initialization` 的命中均为 resident/registry 语义任务（done，机制不同），`import cycle` 的命中只有 AC-394 与其兄弟棘轮。

## AC

- [x] 新增 `server/shared/tests/server-composition-startup.test.ts`，`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-composition-startup.test.ts` 退出 0。该用例导入组合根（`server/index.ts` 的模块图或等价的装配函数）并显式断言没有抛出 `ReferenceError: Cannot access ... before initialization`；读数须先打印模块加载清单再断言。
- [x] 至少一侧为 0：`test -z "$(grep -rn 'modules/mcp-gateway' server/modules/session-hosts --include='*.ts')"` 或 `test -z "$(grep -rn 'modules/session-hosts' server/modules/mcp-gateway --include='*.ts')"` 退出 0（当前 session-hosts 侧命中 `session-hosts.routes.ts:45`）；贴出两侧计数。
- [x] `grep -rn "@/modules/websocket" server/modules/providers/list/claude --include='*.ts'` 在注释之外返回 0 命中（当前 `claude.provider.ts:21` 命中）；用不匹配注释行的口径（例如 `grep -rn "@/modules/websocket" ... | grep -v '^[^:]*:[0-9]*: *//'`）并把实际计数贴出。
- [x] `test -z "$(grep -nE "import\(.@/modules/voice-realtime" server/modules/providers/list/claude/claude-host-driver.provider.ts)"`：该文件不再有指向 voice-realtime 的 import（静态或动态，单双引号均可），命令退出 0；且该文件仍保留 1 处说明接缝归属的注释（`grep -c "voice-realtime" <file>` 至少 1）。
- [x] 结构读数（外部工具）：新鲜 `archguard_detect_cycles(outputScope=package)` 在 server 上报告的 SCC 规模严格小于基线 11；贴出前后成员清单（基线 11 成员记在正文）。该读数为 ArchGuard MCP 查询（待外部）。
- [x] `npm run typecheck` 退出 0；`npm run build:server` 退出 0。
- [x] `git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件（不多一个）。

## DoD

真实落地的标准是「组合根真的能在去除延迟导入兜底后完成模块初始化」，不是「port 文件存在」。必须贴出：①启动判据的 `tests / pass / fail` 与它打印的模块加载清单，含明确断言无 `ReferenceError ... before initialization`；②三条点名边（mcp-gateway↔session-hosts、providers/list/claude→websocket、driver 的 voice-realtime import）的前后 grep 计数；③`server/index.ts` 注入 port 实现的装配行原文（哪个实现对象交给哪个 port）；④ArchGuard 的 SCC 前后成员清单与规模（11 → 实际值）；⑤typecheck / build:server 退出码；⑥取假形态：把一条被移除的静态边临时加回（例如让 `session-hosts.routes.ts` 重新静态导入 `mcp-gateway`），启动判据必须红且红在 `ReferenceError ... before initialization` 或对应的循环边断言上；还原后复绿，附两次读数。若启动判据无法直接导入 `server/index.ts`（例如它会监听端口），允许抽出一个纯装配函数供判据调用，但必须指出该函数在生产启动路径上被真实调用。

## Result

落点提交：`b992bd0a9`（worktree `gap-server-provider-websocket-init-cycle-ports`）。

### ① 启动判据

`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-composition-startup.test.ts` → **tests 1 / pass 1 / fail 0**。先打印的模块加载清单：

```
[composition-startup] requested=7
[composition-startup] 1. @/modules/providers/index.js loaded
[composition-startup] 2. @/modules/websocket/index.js loaded
[composition-startup] 3. @/modules/session-hosts/index.js loaded
[composition-startup] 4. @/modules/projects/index.js loaded
[composition-startup] 5. @/modules/voice/index.js loaded
[composition-startup] 6. @/modules/mcp-gateway/index.js loaded
[composition-startup] 7. @/modules/voice-realtime/index.js loaded
[composition-startup] loaded=7 failures=0
[composition-startup] forbiddenEdges=[] providerScc=8
```

用例在打印之后 `assert.deepEqual(failures, [])`、`assert.equal(loaded.length, 7)`，并显式 `assert.doesNotMatch(joined, /ReferenceError: Cannot access .* before initialization/)`。它导入的是 `server/index.ts` 的静态模块图（同样七个 barrel，同样顺序）；不直接导入 `server/index.ts` 的原因是该文件顶层调用 `startServer()` 会监听端口。

### ② 三条点名边的前后计数

| 边 | 前 | 后 |
|---|---|---|
| `modules/mcp-gateway` in `server/modules/session-hosts` | 1（`session-hosts.routes.ts:45`） | **0** |
| `@/modules/websocket` in `server/modules/providers/list/claude` | 1（`claude.provider.ts:21`） | **0**（注释口径也为 0） |
| `import(@/modules/voice-realtime` in `claude-host-driver.provider.ts` | 1 | **0**；`grep -c voice-realtime` = 11（接缝说明保留） |

另一侧 `modules/session-hosts` 在 `server/modules/mcp-gateway` 仍为 22（网关持有到 session-hosts 的单向依赖）；AC 要求「至少一侧为 0」，session-hosts 侧已为 0。

### ③ `server/index.ts` 装配行

```ts
installProviderRegistryPort(providerRegistry);
installChatRunRegistryPort(chatRunRegistry);
installConnectedClientsPort({ count: () => connectedClients.size });
installVoiceRulesPort({ isSessionActive: isVoiceSessionActive, rulesFor });
```

除正文点名的三个 port 外，另抽出 `ConnectedClientsPort`（claude provider 的浏览器计数接缝）与 `VoiceRulesPort`（resident driver 的 Live Voice 规则接缝）；各属主模块在自身求值时也安装同一实现，直接导入该模块的 criterion 无需额外装配。

### ④ ArchGuard SCC

`archguard_analyze(projectRoot=<worktree>, sources=["server"], lang=typescript)` 后 `archguard_detect_cycles(outputScope=package)`，新鲜读数 `evaluated:true`：

- 基线（正文）：**11** 成员 — mcp-gateway, projects, projects/services, providers, providers/list/claude, providers/services, session-hosts, voice, voice-realtime, websocket, websocket/services。
- 现在：**8** 成员 — projects, projects/services, providers, providers/list/claude, providers/services, voice, websocket, websocket/services（另两组既有 2 元环 `. ↔ browser-use`、`database ↔ database/repositories` 未变）。

同时把 AC-394 棘轮 `CYCLE_GROUPS` 与 baseline JSON 的 G1 由 11 下调为 8（只缩不涨），并把新目录 `shared/ports` 登记为已知叶子目录（manifest + MANIFEST_PIN，nodeCount 48）。

### ⑤ typecheck / build

`npm run typecheck` → **exit 0**；`npm run build:server` → **exit 0**。

### ⑥ 假形态

在 `session-hosts.routes.ts` 临时加回 `import { MCP_GATEWAY_PATH } from '@/modules/mcp-gateway/index.js'`：

- 红读数：`[composition-startup] forbiddenEdges=["modules/session-hosts -> modules/mcp-gateway"] providerScc=10`，**tests 1 / pass 0 / fail 1**（红在循环边断言）。
- 还原后：`forbiddenEdges=[] providerScc=8`，**tests 1 / pass 1 / fail 0**。

该树在假形态下不再抛 TDZ（ESM 允许导入求值中模块的绑定，只有求值时读取才抛），因此判据的第二条读数就是 DoD 允许的「对应的循环边断言」。备份与还原均在 worktree 内完成。

## Touches

- server/shared/ports/session-host-control.port.ts (new)（`SessionHostControlPort` 定义）
- server/shared/ports/chat-run-registry.port.ts (new)（`ChatRunRegistryPort` 定义）
- server/shared/ports/provider-registry.port.ts (new)（`ProviderRegistryPort` 定义）
- server/shared/ports/connected-clients.port.ts (new)（浏览器连接计数访问器）
- server/shared/ports/voice-rules.port.ts (new)（Live Voice 规则访问器）
- server/modules/mcp-gateway/mcp-session-host-control.ts（改为经 port 取宿主控制）
- server/modules/session-hosts/session-hosts.routes.ts（去掉对 mcp-gateway 的直接导入）
- server/modules/session-hosts/index.ts（注释去掉旧路径字面量）
- server/modules/session-hosts/tests/lifecycle-mode.test.ts（注释去掉旧路径字面量）
- server/modules/mcp-gateway/mcp-gateway.transport.ts（装配期经注入 port）
- server/modules/mcp-gateway/mcp-approvals.ts
- server/modules/mcp-gateway/mcp-session-background.ts
- server/modules/mcp-gateway/mcp-gateway.write-tools.ts
- server/modules/mcp-gateway/tests/mcp-gateway-wiring.test.ts（AC-253 判据接受 port 接缝）
- server/modules/websocket/services/chat-run-registry.service.ts（经 port 取 provider 访问器）
- server/modules/websocket/services/chat-control.service.ts
- server/modules/websocket/services/shell-websocket.service.ts
- server/modules/websocket/services/websocket-state.service.ts（安装 ConnectedClientsPort）
- server/modules/providers/list/claude/claude.provider.ts（去掉对 websocket/services 的静态导入）
- server/modules/providers/list/claude/claude-host-driver.provider.ts（voice-realtime 接缝改为 port 注入）
- server/modules/providers/provider.registry.ts（模块求值时安装 ProviderRegistryPort）
- server/modules/providers/index.ts（不再转出口 service 造成父目录环）
- server/modules/providers/services/provider-runtime.service.ts（不再直接导入 `provider.registry.js`）
- server/modules/voice-realtime/voice-realtime-live-executor.ts
- server/modules/voice-realtime/index.ts（模块求值时安装 VoiceRulesPort）
- server/index.ts（port 实现的唯一装配点）
- server/shared/tests/server-composition-startup.test.ts (new)（启动导入图判据）
- server/shared/tests/quay-test-script.test.ts（新增 server 测试文件 ⇒ 两条计数 pin 各上移一个）
- server/shared/tests/server-import-cycle-budget.test.ts（AC-394 棘轮 G1 由 11 下调为 8）
- server/shared/tests/server-import-cycle-budget.baseline.json（AC-394 基线下调并登记 shared/ports）
- scripts/suite-duration-baseline.tsv（新增 server 测试文件的时长行）
- tasks/gap-server-provider-websocket-init-cycle-ports.md (self)
