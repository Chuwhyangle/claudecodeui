---
id: gap-debug-agent-engine-state-encapsulation
title: DebugAgentReleaseRegistry 封装：debug-agent.engine 的 releaseStates Map（含
  waiters）收进带私有字段的类
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22）**：第二批「可变容器封装」机制；granularity `peers: []` ⇒ **separate**。注意与既有 `gap-debug-agent-engine-and-scenario-ops`（done）区分：那条是行为任务，本条是「把 `releaseStates` 收进类」的状态封装。

### 现状

`debug-agent.engine.ts` 有 **1 个模块级 `const ... = new Map`** 且运行时 mutate：`releaseStates`（`Map<string, { released: boolean; waiters: Array<() => void> }>`）——debug agent 的释放/等待并发状态，散在模块顶层。

### 改法

收成 `DebugAgentReleaseRegistry` 类（私有字段 + release/wait 方法），或并入 engine 实例字段。**行为保持**：release/wait 语义不变。

## Plan

1. 盘点 `releaseStates` 的全部读写点。
2. 定义 `DebugAgentReleaseRegistry`（私有字段 + release/wait），逐字迁入。
3. engine 改经实例读写。
4. 判据 + 收口。

## AC

- [ ] (a) **模块级可变容器归零**：`grep -nE "^const releaseStates = new Map" server/modules/debug-agent/debug-agent.engine.ts` 计数 = **0**。
- [ ] (b) **类/实例持有状态**：`grep -nE "class DebugAgentReleaseRegistry|releaseStates" server/modules/debug-agent/debug-agent.engine.ts` 命中（状态已进类字段）。
- [ ] (c) **既有行为不改一字仍绿**：覆盖 debug-agent.engine 的既有 server 判据单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [ ] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [ ] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「`releaseStates` 收进了 `DebugAgentReleaseRegistry` 私有字段、有属主」，不是「多了个类」。必须贴出：①(a)(b) grep 读数与类/实例行；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对（release/wait 语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/debug-agent/debug-agent.engine.ts`（releaseStates Map → DebugAgentReleaseRegistry 私有字段）
- `tasks/gap-debug-agent-engine-state-encapsulation.md`（自触）
