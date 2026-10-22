---
id: gap-session-filter-compiler-encapsulation
title: SessionFilterCompiler 封装：session-name-filter 的 compiledStoredFilterCache
  Map 收进带私有字段的类
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

`session-name-filter.service.ts` 有 1 个模块级 `const compiledStoredFilterCache = new Map()` 且运行时 `.set()`——已编译过滤器缓存，散在模块顶层。

### 改法

收成 `SessionFilterCompiler` 类（私有 Map 字段 + compile/get），导出显式单例。**行为保持**：编译/缓存命中语义不变。

## Plan

1. 盘点 `compiledStoredFilterCache` 的读写点。
2. 定义 `SessionFilterCompiler`（私有字段 + compile/get），逐字迁入。
3. 消费方改经实例。
4. 判据 + 收口。

## AC

- [x] (a) **模块级可变容器归零**：`grep -nE "^const compiledStoredFilterCache = new Map" server/modules/projects/services/session-name-filter.service.ts` 计数 = **0**。
- [x] (b) **类存在且持有状态**：`grep -nE "class SessionFilterCompiler" server/modules/projects/services/session-name-filter.service.ts` 命中。
- [x] (c) **既有行为不改一字仍绿**：覆盖 session-name-filter 的既有 server 判据单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [x] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [x] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「`compiledStoredFilterCache` 收进了 `SessionFilterCompiler` 私有字段、有属主」，不是「多了个类」。必须贴出：①(a)(b) grep 读数；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对（编译/缓存语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Evidence

- 2026-10-23（worktree `gap-session-filter-compiler-encapsulation`，HEAD 已 merge develop）：(a) `grep -nE "^const compiledStoredFilterCache = new Map" server/modules/projects/services/session-name-filter.service.ts` → **0 命中**；(b) `grep -nE "class SessionFilterCompiler" …` → `90:export class SessionFilterCompiler {`（count=1），私有字段 `private readonly cache = new Map<string, (sessionName: string) => boolean>()`（第 91 行），显式单例 `export const sessionFilterCompiler = new SessionFilterCompiler()`。
- (c) `npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/projects/tests/session-name-filter.service.test.ts` → **exit 0**，tests 6 / pass 6 / fail 0。
- (d) `npx tsc --noEmit -p server/tsconfig.json` → **exit 0**；`npm run lint` → **exit 0**（输出仅既有 warning，无 error）。
- 纯位移核对：键仍是 stored JSON 原文（`get(storedJson)`），miss 时仍走 `compileSessionFilter(parseStoredSessionFilter(...))`，仍保留 `size > 200` 先 `clear()` 再 `set()` 的清扫，null 与解析失败仍返回 no-op matcher；`compileStoredSessionFilter` 只改为委派 `sessionFilterCompiler.compile(...)`，逐行同语义。
- (e) `git diff --name-only $(git merge-base HEAD develop) HEAD` → `server/modules/projects/services/session-name-filter.service.ts`（⊆ Touches）。

## Touches

- `server/modules/projects/services/session-name-filter.service.ts`（compiledStoredFilterCache Map → SessionFilterCompiler 私有字段）
- `tasks/gap-session-filter-compiler-encapsulation.md`（自触）
