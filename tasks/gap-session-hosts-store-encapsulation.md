---
id: gap-session-hosts-store-encapsulation
title: SessionHostsStore 封装：useSessionHosts 的 6 个模块级
  let（state/pollTimer/inFlight/coalesceTimer/appliedRev/connected）收进带生命周期的类，hook
  改为订阅显式单例
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22）**：机制词 grep「状态簇封装 / 生命周期类 / 模块级 let 收进类」→ 命中 3 均为行为/结构任务，**无一认领「把散落模块级状态收进带生命周期的类」**。granularity 报 `peers: []` ⇒ **separate**。

### 现状

`src/shared/hooks/useSessionHosts.ts` 有 **6 个模块级 `let`**（`state` / `pollTimer` / `inFlight` / `coalesceTimer` / `appliedRev` / `connected`）——这是一个「会话宿主轮询 store」的完整状态，散在模块顶层，无属主、无生命周期、无法实例化/注入/测试。这是全局可变单例，不是 React 组件状态。

### 改法

把 6 个 `let` + 操作它们的散函数收成一个 `SessionHostsStore` 类：私有字段、显式生命周期 `start()/stop()/subscribe()/refresh()`、单一写路径。导出**显式单例实例**（`export const sessionHostsStore = new SessionHostsStore()`），`useSessionHosts` hook 改为从该实例订阅。**行为保持**：hook 的对外签名与组件行为不变。

## Plan

1. 盘点 6 个 `let` 的读写点与 timer/订阅关系。
2. 定义 `SessionHostsStore`（私有字段 + start/stop/refresh/subscribe），逐字迁入逻辑。
3. hook 改为消费显式单例；对外 API 不变。
4. 判据 + 收口。

## AC

- [ ] (a) **状态私有化 + 生命周期显式**：`grep -nE "^(let|var) " src/shared/hooks/useSessionHosts.ts` 计数 = **0**；`grep -nE "class SessionHostsStore|start\(\)|stop\(\)" src/shared/hooks/useSessionHosts.ts` 命中。
- [ ] (b) **显式单例/可注入**：`grep -nE "new SessionHostsStore|sessionHostsStore" src/shared/hooks/useSessionHosts.ts` 命中（导出命名类 + 显式单例，不是散 let）。
- [ ] (c) **既有行为不改一字仍绿**：覆盖 useSessionHosts 的既有 vitest 判据窄跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [ ] (d) **静态门**：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npm run build:client` 退出 0。
- [ ] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「6 个模块级 `let` 收进了 `SessionHostsStore` 的私有字段、生命周期由类显式表达、hook 只是订阅者」，不是「多了个类」。必须贴出：①(a)(b) 的 grep 读数与类定义/单例导出行；②(c) 既有判据退出码；③(d) typecheck/lint/build 退出码；④纯位移核对（轮询/合并/刷新语义未变；无法收进类的状态逐条列出原因）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `src/shared/hooks/useSessionHosts.ts`（6 个 let → SessionHostsStore 私有字段 + 生命周期）
- `tasks/gap-session-hosts-store-encapsulation.md`（自触）
