---
id: gap-voice-config-store-encapsulation
title: VoiceConfigStore 封装：voiceConfig 的 8 个模块级
  let（config/hasHydrated/hydrationRequest/pendingWriteTimer/rawCapture*）收进带生命周期的类
status: todo
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22）**：同批「状态簇封装」机制，去重同 `gap-session-hosts-store-encapsulation`；granularity `peers: []` ⇒ **separate**。

### 现状

`src/shared/voiceConfig.ts` 有 **8 个模块级 `let`**（`config` / `hasHydrated` / `hydrationRequest` / `hydratedForToken` / `pendingWriteTimer` / `rawCaptureEnabled` / `rawCaptureToken` / `rawCaptureRequest`）——一个「语音配置 store」的 hydrate→read→debounced-write 生命周期，散在模块顶层。

### 改法

收成一个 `VoiceConfigStore` 类：私有字段、显式生命周期 `hydrate()/read()/write()/dispose()`、单一写路径。导出显式单例，消费方从实例读。**行为保持**：每个 key 的默认值与语义不变。

## Plan

1. 盘点 8 个 `let` 的读写点与 hydration/write 关系。
2. 定义 `VoiceConfigStore`（私有字段 + hydrate/read/write/dispose），逐字迁入。
3. 消费方改为从显式单例读；对外 API 不变。
4. 判据 + 收口。

## AC

- [ ] (a) **状态私有化 + 生命周期显式**：`grep -nE "^(let|var) " src/shared/voiceConfig.ts` 计数 = **0**；`grep -nE "class VoiceConfigStore|hydrate\(\)|dispose\(\)" src/shared/voiceConfig.ts` 命中。
- [ ] (b) **显式单例**：`grep -nE "new VoiceConfigStore" src/shared/voiceConfig.ts` 命中。
- [ ] (c) **既有行为不改一字仍绿**：`npx vitest run src/shared/tests/voiceConfig.test.ts src/shared/tests/voiceConfigHydration.test.ts` 退出 0（若文件名漂移用等价判据替换并记录）。
- [ ] (d) **静态门**：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npm run build:client` 退出 0。
- [ ] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「8 个模块级 `let` 收进了 `VoiceConfigStore` 私有字段、hydrate/read/write 生命周期由类显式表达」，不是「多了个类」。必须贴出：①(a)(b) grep 读数与类/单例行；②(c) 判据退出码；③(d) typecheck/lint/build；④纯位移核对（key 默认值与语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `src/shared/voiceConfig.ts`（8 个 let → VoiceConfigStore 私有字段 + 生命周期）
- `src/shared/tests/voiceConfig.test.ts`（既有判据，不改一字，作行为覆盖）
- `src/shared/tests/voiceConfigHydration.test.ts`（既有判据，不改一字，作行为覆盖）
- `tasks/gap-voice-config-store-encapsulation.md`（自触）
