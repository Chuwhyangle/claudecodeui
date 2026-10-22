---
id: gap-session-scope-slice-caps-encapsulation
title: ClaudeSessionScope 封装：claude-session-scope 的 appliedSliceCaps Set 收进带私有字段的类
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-23）**：第三批「缓存封装」机制；granularity `peers: []` ⇒ **separate**。

### 现状

`claude-session-scope.service.ts` 有 1 个模块级 `const appliedSliceCaps = new Set()` 且运行时 `.add()`——「已施加切片上限」的状态集，散在模块顶层。

### 改法

收进 scope service 的类实例私有字段（`ClaudeSessionScope` 类，含 appliedSliceCaps 字段 + 施加/查询方法）。**行为保持**：上限施加去重语义不变。

## Plan

1. 盘点 `appliedSliceCaps` 的读写点。
2. 收进 `ClaudeSessionScope` 类私有字段（或独立类），逐字迁入。
3. 消费方改经实例。
4. 判据 + 收口。

## AC

- [x] (a) **模块级可变容器归零**：`grep -nE "^const appliedSliceCaps = new Set" server/modules/providers/services/claude-session-scope.service.ts` 计数 = **0**。
- [x] (b) **状态进类**：`grep -nE "class ClaudeSessionScope" server/modules/providers/services/claude-session-scope.service.ts` 命中，且 `appliedSliceCaps` 在类私有字段内。
- [x] (c) **既有行为不改一字仍绿**：覆盖 claude-session-scope 的既有 server 判据单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [x] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [x] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「`appliedSliceCaps` 收进了 `ClaudeSessionScope` 私有字段、有属主」，不是「多了个字段」。必须贴出：①(a)(b) grep 读数；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对（去重语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/providers/services/claude-session-scope.service.ts`（appliedSliceCaps Set → ClaudeSessionScope 私有字段）
- `tasks/gap-session-scope-slice-caps-encapsulation.md`（自触）
