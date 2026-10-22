---
id: gap-codex-runtime-state-encapsulation
title: CodexRuntimeState 封装：codex-runtime 的 activeCodexSessions Map 收进带私有字段的类
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22）**：第二批「可变容器封装」机制；granularity `peers: []` ⇒ **separate**。

### 现状

`codex-runtime.provider.ts` 有 **1 个模块级 `const ... = new Map`** 且运行时 mutate：`activeCodexSessions`——Codex 运行时的活跃会话状态，散在模块顶层。

### 改法

收成 `CodexRuntimeState` 类（私有字段 + 增删查），或并入既有的 codex 运行时 provider 实例字段。**行为保持**：活跃会话增删查语义不变。

## Plan

1. 盘点 `activeCodexSessions` 的全部读写点。
2. 定义 `CodexRuntimeState`（私有字段 + 增删查），逐字迁入。
3. provider 改经实例读写。
4. 判据 + 收口。

## AC

- [x] (a) **模块级可变容器归零**：`grep -nE "^const activeCodexSessions = new Map" server/modules/providers/list/codex/codex-runtime.provider.ts` 计数 = **0**。
- [x] (b) **类/实例持有状态**：`grep -nE "class CodexRuntimeState|activeCodexSessions" server/modules/providers/list/codex/codex-runtime.provider.ts` 命中（状态已进类字段）。
- [x] (c) **既有行为不改一字仍绿**：覆盖 codex-runtime 的既有 server 判据单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [x] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [x] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「`activeCodexSessions` 收进了 `CodexRuntimeState` 私有字段、有属主」，不是「多了个类」。必须贴出：①(a)(b) grep 读数与类/实例行；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/providers/list/codex/codex-runtime.provider.ts`（activeCodexSessions Map → CodexRuntimeState 私有字段）
- `tasks/gap-codex-runtime-state-encapsulation.md`（自触）
