---
id: gap-sessions-watcher-encapsulation
title: SessionsWatcher 封装：sessions-watcher 的 5 个模块级
  let（pendingWatcherUpdate/flushTimer/refreshInFlight/reschedule）收进带生命周期的类
status: ready
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

- [x] (a) **状态私有化 + 生命周期显式**：`grep -nE "^(let|var) " server/modules/providers/services/sessions-watcher.service.ts` 计数 = **0**；`grep -nE "class SessionsWatcher|start\(\)|stop\(\)|flush\(\)" server/modules/providers/services/sessions-watcher.service.ts` 命中。
- [x] (b) **显式单例/可注入**：`grep -nE "new SessionsWatcher" server/modules/providers/services/sessions-watcher.service.ts` 命中。
- [x] (c) **既有行为不改一字仍绿**：覆盖 sessions-watcher 的既有 server 判据单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [x] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [x] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「5 个模块级 `let` 收进了 `SessionsWatcher` 私有字段、debounce/flush/refresh 生命周期由类显式表达」，不是「多了个类」。必须贴出：①(a)(b) grep 读数与类/单例行；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对（debounce/reschedule 语义未变；无法收进类的状态逐条列出）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/providers/services/sessions-watcher.service.ts`（5 个 let → SessionsWatcher 私有字段 + 生命周期）
- `tasks/gap-sessions-watcher-encapsulation.md`（自触）

## Evidence

① (a) `grep -nE "^(let|var) " …sessions-watcher.service.ts` ⇒ **0**；`grep -nE "class SessionsWatcher|start\(\)|stop\(\)|flush\(\)"` ⇒ L614 `class SessionsWatcher {`、L630 `async start(): Promise<void>`、L668 `async stop(): Promise<void>`、L732 `async flush(): Promise<void>`。
② (b) `grep -nE "new SessionsWatcher"` ⇒ L781 `const sessionsWatcher = new SessionsWatcher();`。
③ (c) `bash scripts/with-memory-cap.sh tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/providers/tests/sessions-watcher-mode.test.ts` ⇒ **退出 0**（tests 6 / pass 6 / fail 0，16919ms）。
④ (d) `npx tsc --noEmit -p server/tsconfig.json` ⇒ **退出 0**；`npm run lint` ⇒ **退出 0**（仅既有 warning）。
⑤ 纯位移：`PROJECTS_UPDATE_DEBOUNCE_MS=500` / `PROJECTS_UPDATE_MAX_WAIT_MS=2000`、in-flight 时置 `rescheduleAfterRefresh` 并提前返回、`finally` 中一次 reschedule 的条件与顺序逐段搬入类方法；未改任何分支或定时数值。无法收进类的状态：无（5 个 `let` 全部成为私有字段；只读常量 `PROVIDER_WATCH_PATHS` / `WATCH_*` / `POLL_*` 留在模块级）。附带把原模块级 `const watchers` 数组收为类私有字段，`readActiveWatcherModes`/`initializeSessionsWatcher`/`closeSessionsWatcher` 对外签名不变。
⑥ (e) `git diff --name-only $(git merge-base HEAD develop) HEAD` ⇒ 仅 `server/modules/providers/services/sessions-watcher.service.ts` 与（task_write 自提交的）`tasks/gap-sessions-watcher-encapsulation.md`，均在 Touches 内。
