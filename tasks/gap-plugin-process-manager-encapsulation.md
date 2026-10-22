---
id: gap-plugin-process-manager-encapsulation
title: PluginProcessManager 封装：plugin-process 的 2 个模块级 const
  Map（runningPlugins/startingPlugins）收进带生命周期的类
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22）**：第二批「可变容器封装」机制；granularity `peers: []` ⇒ **separate**。

### 现状

`plugin-process.service.ts` 有 **2 个模块级 `const ... = new Map`** 且运行时 mutate：`runningPlugins` / `startingPlugins`——插件进程的运行/启动状态，散在模块顶层。

### 改法

收成一个 `PluginProcessManager` 类（2 个 Map 作私有字段 + start/stop/status 方法，显式生命周期）。**行为保持**：插件启停与状态查询语义不变。

## Plan

1. 盘点 2 个 Map 的全部读写点与进程生命周期。
2. 定义 `PluginProcessManager`（私有字段 + start/stop/status），逐字迁入。
3. 消费方改经实例；对外导出签名不变。
4. 判据 + 收口。

## AC

- [x] (a) **模块级可变容器归零**：`grep -nE "^const (runningPlugins|startingPlugins) = new Map" server/modules/plugins/plugin-process.service.ts` 计数 = **0**。
- [x] (b) **类存在且持有状态 + 生命周期**：`grep -nE "class PluginProcessManager|start\(\)|stop\(\)" server/modules/plugins/plugin-process.service.ts` 命中。
- [x] (c) **既有行为不改一字仍绿**：覆盖 plugin-process 的既有 server 判据单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [x] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [x] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「2 个模块级 Map 收进了 `PluginProcessManager` 私有字段、启停生命周期由类显式表达」，不是「多了个类」。必须贴出：①(a)(b) grep 读数与类/实例行；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对（启停语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/plugins/plugin-process.service.ts`（2 个 const Map → PluginProcessManager 私有字段 + 生命周期）
- `tasks/gap-plugin-process-manager-encapsulation.md`（自触）

## Evidence

**2026-10-22 第 2 轮 worker（worktree `gap-plugin-process-manager-encapsulation`，merge develop 后）**

- ①(a) `grep -nE "^const (runningPlugins|startingPlugins) = new Map" server/modules/plugins/plugin-process.service.ts` → **0 hit（exit 1）**。
- ①(b) `class PluginProcessManager` @ `plugin-process.service.ts:23`；私有字段 `runningPlugins` :25、`startingPlugins` :27；单实例 `const pluginProcessManager = new PluginProcessManager()` :178；生命周期方法 `start` :35、`stop` :116、`getPort` :143、`isRunning` :150、`stopAll` :157。
- ②(c) 仓库**无**直接覆盖 `plugin-process.service.ts` 的 server 判据（`grep -rln "plugin-process|PluginProcessManager" server --include=*.test.ts` 无命中）；按 AC 的「等价判据替换并记录」取插件域既有 server 判据 `server/modules/plugins/tests/plugins.service.test.ts` 单跑 → `TEST_EXIT=0`（tests 1 / pass 1 / fail 0）。另跑导出面 smoke：`getPluginPort(none)=null`、`isPluginRunning(none)=false`、`stopPluginServer(none)` resolve `undefined`、`stopAllPlugins()=[]`，六个导出名不变。
- ③(d) `npx tsc --noEmit -p server/tsconfig.json` → **0**；`npx oxlint src/ server/ scripts/ shared/` → **0**（本文件无 finding）。
- ④ 纯位移：develop 版 `startPluginServer/stopPluginServer/getPluginPort/isPluginRunning/stopAllPlugins` 的函数体逐行迁入 `PluginProcessManager` 同名方法，仅 `runningPlugins→this.runningPlugins` / `startingPlugins→this.startingPlugins`；ready 行解析、10s 就绪超时、error/exit 清理、并发合并、SIGTERM+5s SIGKILL 强制 kill 语义均不变，导出签名不变。
- ⑤(e) `git diff --name-only develop...HEAD` → 仅 `server/modules/plugins/plugin-process.service.ts`；`anti-drift-touches-check --merge-target develop` → `ANTI-DRIFT OK: 1 actual file(s), all within declared Touches`（exit 0）。
- 前一轮 suite 红根因（**非本任务 delta**）：共享 `node_modules/@yalehwang/plantuml-js` 仍是 0.1.0，`aspectRatio` 不折叠；该包已于 18:35 换成 0.3.0，`src/modules/architecture/tests/layoutAspect.test.tsx` 单跑 7/7 passed（连续 5 次），两个 worktree 共享同一 node_modules。
