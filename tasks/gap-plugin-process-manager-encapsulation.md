---
id: gap-plugin-process-manager-encapsulation
title: PluginProcessManager 封装：plugin-process 的 2 个模块级 const
  Map（runningPlugins/startingPlugins）收进带生命周期的类
status: todo
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

- [ ] (a) **模块级可变容器归零**：`grep -nE "^const (runningPlugins|startingPlugins) = new Map" server/modules/plugins/plugin-process.service.ts` 计数 = **0**。
- [ ] (b) **类存在且持有状态 + 生命周期**：`grep -nE "class PluginProcessManager|start\(\)|stop\(\)" server/modules/plugins/plugin-process.service.ts` 命中。
- [ ] (c) **既有行为不改一字仍绿**：覆盖 plugin-process 的既有 server 判据单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [ ] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [ ] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「2 个模块级 Map 收进了 `PluginProcessManager` 私有字段、启停生命周期由类显式表达」，不是「多了个类」。必须贴出：①(a)(b) grep 读数与类/实例行；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对（启停语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/plugins/plugin-process.service.ts`（2 个 const Map → PluginProcessManager 私有字段 + 生命周期）
- `tasks/gap-plugin-process-manager-encapsulation.md`（自触）
