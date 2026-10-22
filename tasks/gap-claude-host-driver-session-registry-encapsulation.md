---
id: gap-claude-host-driver-session-registry-encapsulation
title: ClaudeResidentSessionRegistries 封装：driver 的 5 个模块级 const
  Map（sessionDeliveryReadings/Signatures/TurnRunReadings/Lookups/ProcessingReadings）收进带私有字段的类
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22）**：第二批「可变容器封装」机制；去重无认领；granularity `peers: []` ⇒ **separate**。

### 现状

`claude-host-driver.provider.ts` 有 **5 个模块级 `const ... = new Map`**，且都运行时 `.set()`：`sessionDeliveryReadings` / `sessionDeliverySignatures` / `sessionTurnRunReadings` / `sessionDeliveryLookups` / `sessionProcessingReadings`——这是 driver 的**按会话读数注册表**，散在模块顶层、被 free function（:2321/:2325）与类方法（:4495/:4508/:4516）两处读写。刀1/2 迁走了 handler 逻辑，但这 5 个注册表状态没动。

### 改法

收成一个 `ClaudeResidentSessionRegistries` 类（5 个 Map 作私有字段 + register/lookup 方法），driver 持有一个实例；free function 与 method 都改经实例读写。**行为保持**：按会话读数的注册/查找语义不变。

## Plan

1. 盘点 5 个 Map 的全部 `.set`/`.get`/`.delete` 点与调用方。
2. 定义 `ClaudeResidentSessionRegistries`（私有 Map 字段 + 注册/查找/清除），逐字迁入。
3. driver 实例持有 registries；free function 改为经实例（或改造成方法）。
4. 判据 + 收口。

## AC

- [x] (a) **模块级可变 Map 归零**：`grep -nE "^const (sessionDeliveryReadings|sessionDeliverySignatures|sessionTurnRunReadings|sessionDeliveryLookups|sessionProcessingReadings) = new Map" server/modules/providers/list/claude/claude-host-driver.provider.ts` 计数 = **0**。
- [x] (b) **类存在且持有状态**：`grep -nE "class ClaudeResidentSessionRegistries" server/modules/providers/list/claude/claude-host-driver.provider.ts` 命中（或等价独立文件），且 driver 持实例。
- [x] (c) **既有行为不改一字仍绿**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/claude-resident-reconcile.test.ts` 与 `claude-resident-outcome-registry.test.ts` 各自单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [x] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [x] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「5 个模块级 Map 收进了 `ClaudeResidentSessionRegistries` 私有字段、有属主、可实例化」，不是「多了个类」。必须贴出：①(a)(b) grep 读数与类/实例行；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对（注册/查找语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/providers/list/claude/claude-host-driver.provider.ts`（5 个 const Map → ClaudeResidentSessionRegistries 私有字段）
- `tasks/gap-claude-host-driver-session-registry-encapsulation.md`（自触）
