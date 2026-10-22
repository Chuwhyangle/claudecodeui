---
id: gap-claude-runtime-state-encapsulation
title: ClaudeRuntimeState 封装：claude-runtime 的 3 个模块级 const
  Map/Set（activeSessions/pendingToolApprovals/abortedSessionIds）收进带私有字段的类
status: todo
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

`claude-runtime.provider.ts` 有 **3 个模块级 `const ... = new Map/Set`** 且运行时 mutate：`activeSessions`（Map）、`pendingToolApprovals`（Map）、`abortedSessionIds`（Set）——这是 Claude 运行时的核心会话状态（活跃会话 / 待批准工具 / 已中止会话），散在模块顶层。

### 改法

收成一个 `ClaudeRuntimeState` 类（3 个容器作私有字段 + 增删查方法），运行时 provider 持有一个实例。**行为保持**：会话/批准/中止的增删查语义不变。

## Plan

1. 盘点 3 个容器的全部读写点。
2. 定义 `ClaudeRuntimeState`（私有字段 + 增删查），逐字迁入。
3. provider 改经实例读写。
4. 判据 + 收口。

## AC

- [ ] (a) **模块级可变容器归零**：`grep -nE "^const (activeSessions|pendingToolApprovals|abortedSessionIds) = new (Map|Set)" server/modules/providers/list/claude/claude-runtime.provider.ts` 计数 = **0**。
- [ ] (b) **类存在且持有状态**：`grep -nE "class ClaudeRuntimeState" server/modules/providers/list/claude/claude-runtime.provider.ts` 命中。
- [ ] (c) **既有行为不改一字仍绿**：覆盖 claude-runtime 的既有 server 判据单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [ ] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [ ] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「3 个模块级容器收进了 `ClaudeRuntimeState` 私有字段、有属主、可实例化」，不是「多了个类」。必须贴出：①(a)(b) grep 读数与类/实例行；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对（增删查语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/providers/list/claude/claude-runtime.provider.ts`（3 个 const Map/Set → ClaudeRuntimeState 私有字段）
- `tasks/gap-claude-runtime-state-encapsulation.md`（自触）
