---
id: gap-provider-capabilities-registry-encapsulation
title: ProviderCapabilitiesRegistry 封装：provider-capabilities 的
  RUNTIME_PROVIDER_CAPABILITIES Map 收进带私有字段的类
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

`provider-capabilities.service.ts` 有 1 个模块级 `const RUNTIME_PROVIDER_CAPABILITIES = new Map()` 且运行时 `.set()`——运行时 provider 能力注册表，散在模块顶层。

### 改法

收成 `ProviderCapabilitiesRegistry` 类（私有 Map 字段 + 注册/查询），导出显式单例。**行为保持**：能力注册/查询语义不变。

## Plan

1. 盘点 `RUNTIME_PROVIDER_CAPABILITIES` 的读写点。
2. 定义 `ProviderCapabilitiesRegistry`（私有字段 + 注册/查询），逐字迁入。
3. 消费方改经实例。
4. 判据 + 收口。

## AC

- [ ] (a) **模块级可变容器归零**：`grep -nE "^const RUNTIME_PROVIDER_CAPABILITIES = new Map" server/modules/providers/services/provider-capabilities.service.ts` 计数 = **0**。
- [ ] (b) **类存在且持有状态**：`grep -nE "class ProviderCapabilitiesRegistry" server/modules/providers/services/provider-capabilities.service.ts` 命中。
- [ ] (c) **既有行为不改一字仍绿**：覆盖 provider-capabilities 的既有 server 判据单跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [ ] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [ ] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「`RUNTIME_PROVIDER_CAPABILITIES` 收进了 `ProviderCapabilitiesRegistry` 私有字段、有属主」，不是「多了个类」。必须贴出：①(a)(b) grep 读数；②(c) 判据退出码；③(d) tsc/lint；④纯位移核对（注册/查询语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/providers/services/provider-capabilities.service.ts`（RUNTIME_PROVIDER_CAPABILITIES Map → ProviderCapabilitiesRegistry 私有字段）
- `tasks/gap-provider-capabilities-registry-encapsulation.md`（自触）
