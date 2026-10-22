---
id: gap-browser-use-session-state-encapsulation
title: BrowserUseSessionRegistry 封装：browser-use 的 2 个模块级 const
  Map（sessions/handles）收进 BrowserUseRuntime 私有字段
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22）**：第二批「可变容器封装」机制；承接 `gap-browser-use-runtime-encapsulation`（done）的已知后续——那条只收了 3 个 `let`，本条的 2 个 `const Map` 是立案时遗漏。granularity `peers: []` ⇒ **separate**。

### 现状

`server/modules/browser-use/browser-use.service.ts` 有 **2 个模块级 `const ... = new Map`** 且运行时 mutate：`sessions`（`Map<string, BrowserUseSession>`）/ `handles`（`Map<string, RuntimeHandle>`）——browser-use 的会话与运行时句柄注册表，散在模块顶层（:79/:80），在 `BrowserUseRuntime` 类（:229）之外。

### 改法

把 `sessions`/`handles` 收进 `BrowserUseRuntime` 实例私有字段（或独立 `BrowserUseSessionRegistry`），提供增删查方法。**行为保持**：会话/句柄增删查语义不变。

## Plan

1. 盘点 2 个 Map 的全部读写点。
2. 收进 `BrowserUseRuntime` 私有字段（或独立 registry 类），逐字迁入。
3. 消费方改经实例。
4. 判据 + 收口。

## AC

- [ ] (a) **模块级可变容器归零**：`grep -nE "^const (sessions|handles) = new Map" server/modules/browser-use/browser-use.service.ts` 计数 = **0**。
- [ ] (b) **状态进类**：`grep -nE "class BrowserUseRuntime" server/modules/browser-use/browser-use.service.ts` 命中，且 `sessions`/`handles` 在类私有字段内。
- [ ] (c) **既有行为不改一字仍绿**：覆盖 browser-use 的既有 server 判据单跑退出 0。
- [ ] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [ ] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「2 个模块级 Map 收进了 `BrowserUseRuntime` 私有字段、有属主」，不是「多了个字段」。必须贴出：①(a)(b) grep 读数；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对（会话/句柄增删查语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/browser-use/browser-use.service.ts`（2 个 const Map → BrowserUseRuntime 私有字段）
- `tasks/gap-browser-use-session-state-encapsulation.md`（自触）
