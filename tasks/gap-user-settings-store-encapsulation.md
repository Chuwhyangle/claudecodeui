---
id: gap-user-settings-store-encapsulation
title: UserSettingsStore 封装：userSettings 的 4 个模块级
  let（preferences/pendingServerWrites/serverWriteTimer/hasHydrated）收进带生命周期的类
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

`src/shared/userSettings.ts` 有 **4 个模块级 `let`**（`preferences` / `pendingServerWrites` / `serverWriteTimer` / `hasHydrated`）——一个「用户设置 store」的 hydrate→read→debounced-write 生命周期，散在模块顶层。

### 改法

收成一个 `UserSettingsStore` 类：私有字段、显式生命周期 `hydrate()/read()/write()/dispose()`、单一写路径。导出显式单例，消费方从实例读。**行为保持**：写合并与 debounce 语义不变。

## Plan

1. 盘点 4 个 `let` 的读写点。
2. 定义 `UserSettingsStore`（私有字段 + hydrate/read/write/dispose），逐字迁入。
3. 消费方改经实例；对外 API 不变。
4. 判据 + 收口。

## AC

- [ ] (a) **状态私有化 + 生命周期显式**：`grep -nE "^(let|var) " src/shared/userSettings.ts` 计数 = **0**；`grep -nE "class UserSettingsStore|hydrate\(\)|dispose\(\)" src/shared/userSettings.ts` 命中。
- [ ] (b) **显式单例**：`grep -nE "new UserSettingsStore" src/shared/userSettings.ts` 命中。
- [ ] (c) **既有行为不改一字仍绿**：覆盖 userSettings 的既有 vitest 判据窄跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [ ] (d) **静态门**：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npm run build:client` 退出 0。
- [ ] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「4 个模块级 `let` 收进了 `UserSettingsStore` 私有字段、hydrate/read/write 生命周期由类显式表达」，不是「多了个类」。必须贴出：①(a)(b) grep 读数与类/单例行；②(c) 判据退出码；③(d) typecheck/lint/build；④纯位移核对（写合并/debounce 语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `src/shared/userSettings.ts`（4 个 let → UserSettingsStore 私有字段 + 生命周期）
- `tasks/gap-user-settings-store-encapsulation.md`（自触）
