---
id: gap-browser-use-runtime-encapsulation
title: BrowserUseRuntime 封装：browser-use 的 3 个模块级
  let（installPromise/lastInstallMessage/runtimeProbeCache）收进带生命周期的类
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

`server/modules/browser-use/browser-use.service.ts` 有 **3 个模块级 `let`**（`installPromise` / `lastInstallMessage` / `runtimeProbeCache`）——一个「browser-use 运行时」的 install→probe 生命周期 + 缓存，散在模块顶层。

### 改法

收成一个 `BrowserUseRuntime` 类：私有字段、显式生命周期 `install()/probe()/dispose()`、单一写路径。导出显式单例。**行为保持**：安装去重与探针缓存语义不变。

## Plan

1. 盘点 3 个 `let` 的读写点。
2. 定义 `BrowserUseRuntime`（私有字段 + install/probe/dispose），逐字迁入。
3. 消费方改经实例；对外导出签名不变。
4. 判据 + 收口。

## AC

- [ ] (a) **状态私有化 + 生命周期显式**：`grep -nE "^(let|var) " server/modules/browser-use/browser-use.service.ts` 计数 = **0**；`grep -nE "class BrowserUseRuntime|install\(\)|probe\(\)" server/modules/browser-use/browser-use.service.ts` 命中。
- [ ] (b) **显式单例/可注入**：`grep -nE "new BrowserUseRuntime" server/modules/browser-use/browser-use.service.ts` 命中。
- [ ] (c) **既有行为不改一字仍绿**：覆盖 browser-use 的既有 server 判据单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [ ] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [ ] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「3 个模块级 `let` 收进了 `BrowserUseRuntime` 私有字段、install/probe 生命周期由类显式表达」，不是「多了个类」。必须贴出：①(a)(b) grep 读数与类/单例行；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对（安装去重/缓存语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/browser-use/browser-use.service.ts`（3 个 let → BrowserUseRuntime 私有字段 + 生命周期）
- `tasks/gap-browser-use-runtime-encapsulation.md`（自触）
