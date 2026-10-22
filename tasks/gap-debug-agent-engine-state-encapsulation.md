---
id: gap-debug-agent-engine-state-encapsulation
title: DebugAgentReleaseRegistry 封装：debug-agent.engine 的 releaseStates Map（含
  waiters）收进带私有字段的类
status: done
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

- [x] (a) **模块级可变容器归零**：`grep -nE "^const releaseStates = new Map" server/modules/debug-agent/debug-agent.engine.ts` 计数 = **0**。
- [x] (b) **类/实例持有状态**：`grep -nE "class DebugAgentReleaseRegistry|releaseStates" server/modules/debug-agent/debug-agent.engine.ts` 命中（状态已进类字段）。
- [x] (c) **既有行为不改一字仍绿**：覆盖 debug-agent.engine 的既有 server 判据单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [x] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [x] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「`releaseStates` 收进了 `DebugAgentReleaseRegistry` 私有字段、有属主」，不是「多了个类」。必须贴出：①(a)(b) grep 读数与类/实例行；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对（release/wait 语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/debug-agent/debug-agent.engine.ts`（releaseStates Map → DebugAgentReleaseRegistry 私有字段）
- `tasks/gap-debug-agent-engine-state-encapsulation.md`（自触）

## Evidence

① (a) `grep -cE "^const releaseStates = new Map" server/modules/debug-agent/debug-agent.engine.ts` ⇒ **0**。 (b) `grep -nE "class DebugAgentReleaseRegistry|releaseStates"` ⇒ L350 `class DebugAgentReleaseRegistry {`；私有字段 L351 `private readonly states = new Map<string, DebugAgentReleaseState>();`；显式单例 L449 `const releaseRegistry = new DebugAgentReleaseRegistry();`；方法 L362 `register` / L379 `release` / L404 `awaitRelease` / L443 `discard`；engine 调用点 L515 `releaseRegistry.register(appSessionId)`、L894 `await releaseRegistry.awaitRelease(appSessionId)`、L910 `releaseRegistry.discard(appSessionId)`，导出动词 L459 `return releaseRegistry.release(appSessionId)`。
② (c) `bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test --test-concurrency=1 server/modules/debug-agent/tests/debug-agent-typed-turn.test.ts` ⇒ **退出 0**（tests 4 / pass 4 / fail 0，14045ms，含 `an await-release step holds the walk until the release is stated, and then lets it go`）；`… tests/debug-agent-control-plane.test.ts` ⇒ **退出 0**（tests 4 / pass 4 / fail 0，33942ms）。
③ (d) `npx tsc --noEmit -p server/tsconfig.json` ⇒ **退出 0**；`npm run lint` ⇒ **退出 0**（仅既有 warning）。
④ 纯位移核对：`releaseDebugAgentRun` 的三序语义（已释放 ⇒ 0；等待中 ⇒ 唤醒并返回 waiter 数；之后 ⇒ 0）逐字搬入 `DebugAgentReleaseRegistry.release`；`awaitRelease` 的「超时先从 waiters 摘除自己再以 `DEBUG_AGENT_RELEASE_TIMEOUT` 拒绝」逐字搬入；run 开始时 carry-over `released` 标志、run 结束时 delete 逐字搬入 `register` / `discard`。未改任何分支、定时数值、错误码或注释语义。无法收进类的状态：无（唯一可变 Map 已成私有字段；只读常量 `DEBUG_AGENT_RELEASE_CEILING_MS` 留在模块级）。
⑤ (e) `git diff --name-only $(git merge-base HEAD develop) HEAD` ⇒ 仅 `server/modules/debug-agent/debug-agent.engine.ts`（实现提交 e3588c7a0），均在 Touches 内；`anti-drift-touches-check.js --merge-target develop` ⇒ **退出 0**（1 actual file(s)，all within declared Touches）。

## Blocker

**2026-10-22T10:23:15.924Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - src/modules/architecture/tests/layoutAspect.test.tsx: AssertionError [ERR_ASSERTION]: aspectRatio 0.53 must fold the flat overview into a portrait canvas; got 3.266 (0 0 1789.96 548) [baseline A/B: HARD RED (changed-assertion) — the task's red set is NOT a subset of the develop baseline red set: added=- changed=src/modules/architecture/tests/layoutAspect.test.tsx]
- run_id：wk-prod-anchor
- session_id：aac6c121-b5ab-433c-8eeb-6e29d6809e2b
