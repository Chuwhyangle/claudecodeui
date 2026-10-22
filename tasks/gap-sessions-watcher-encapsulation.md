---
id: gap-sessions-watcher-encapsulation
title: SessionsWatcher 封装：sessions-watcher 的 5 个模块级
  let（pendingWatcherUpdate/flushTimer/refreshInFlight/reschedule）收进带生命周期的类
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22）**：同批「状态簇封装」机制；granularity `peers: []` ⇒ **separate**。

### 现状

`server/modules/providers/services/sessions-watcher.service.ts` 有 **5 个模块级 `let`**（`pendingWatcherUpdate` / `pendingWatcherUpdateStartedAt` / `pendingWatcherFlushTimer` / `watcherRefreshInFlight` / `watcherRescheduleAfterRefresh`）——一个「会话监视器」的 debounce→flush→refresh 生命周期，散在模块顶层。

### 改法

收成一个 `SessionsWatcher` 类：私有字段、显式生命周期 `start()/stop()/scheduleUpdate()/flush()/refresh()`、单一写路径。导出显式单例（或经既有装配注入）。**行为保持**：debounce/flush/reschedule 语义不变。

## Plan

1. 盘点 5 个 `let` 的读写点与 timer 关系。
2. 定义 `SessionsWatcher`（私有字段 + start/stop/scheduleUpdate/flush），逐字迁入。
3. 消费方改经实例；对外导出签名不变。
4. 判据 + 收口。

## AC

- [ ] (a) **状态私有化 + 生命周期显式**：`grep -nE "^(let|var) " server/modules/providers/services/sessions-watcher.service.ts` 计数 = **0**；`grep -nE "class SessionsWatcher|start\(\)|stop\(\)|flush\(\)" server/modules/providers/services/sessions-watcher.service.ts` 命中。
- [ ] (b) **显式单例/可注入**：`grep -nE "new SessionsWatcher" server/modules/providers/services/sessions-watcher.service.ts` 命中。
- [ ] (c) **既有行为不改一字仍绿**：覆盖 sessions-watcher 的既有 server 判据单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [ ] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [ ] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「5 个模块级 `let` 收进了 `SessionsWatcher` 私有字段、debounce/flush/refresh 生命周期由类显式表达」，不是「多了个类」。必须贴出：①(a)(b) grep 读数与类/单例行；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对（debounce/reschedule 语义未变；无法收进类的状态逐条列出）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/providers/services/sessions-watcher.service.ts`（5 个 let → SessionsWatcher 私有字段 + 生命周期）
- `tasks/gap-sessions-watcher-encapsulation.md`（自触）
