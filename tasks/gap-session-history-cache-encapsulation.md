---
id: gap-session-history-cache-encapsulation
title: SessionHistoryCache 封装：session-history-cache 的 loadContexts Map 收进带私有字段的类
status: todo
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

`session-history-cache.service.ts` 有 1 个模块级 `const loadContexts = new Map()` 且运行时 `.set()`（2 处）——历史加载上下文缓存，散在模块顶层，无属主、无失效生命周期。

### 改法

收成 `SessionHistoryCache` 类（私有 Map 字段 + get/put/invalidate），导出显式单例。**行为保持**：缓存命中/写入语义不变。

## Plan

1. 盘点 `loadContexts` 的读写点与失效时机。
2. 定义 `SessionHistoryCache`（私有字段 + get/put/invalidate），逐字迁入。
3. 消费方改经实例。
4. 判据 + 收口。

## AC

- [ ] (a) **模块级可变容器归零**：`grep -nE "^const loadContexts = new Map" server/modules/providers/services/session-history-cache.service.ts` 计数 = **0**。
- [ ] (b) **类存在且持有状态**：`grep -nE "class SessionHistoryCache" server/modules/providers/services/session-history-cache.service.ts` 命中。
- [ ] (c) **既有行为不改一字仍绿**：覆盖 session-history-cache 的既有 server 判据单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [ ] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [ ] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「`loadContexts` 收进了 `SessionHistoryCache` 私有字段、有属主」，不是「多了个类」。必须贴出：①(a)(b) grep 读数；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对（缓存语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/providers/services/session-history-cache.service.ts`（loadContexts Map → SessionHistoryCache 私有字段）
- `tasks/gap-session-history-cache-encapsulation.md`（自触）
