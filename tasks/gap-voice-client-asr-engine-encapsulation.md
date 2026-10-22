---
id: gap-voice-client-asr-engine-encapsulation
title: VoiceClientAsrEngine 封装：voiceClientAsrWorker 的 4 个模块级
  let（installedEngine/preloadPromise/readinessRequest/lastProgress）收进带生命周期的类
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

`src/shared/voiceClientAsrWorker.ts` 有 **4 个模块级 `let`**（`installedEngine` / `preloadPromise` / `readinessRequest` / `lastProgress`）——一个「客户端 ASR 引擎」的 install→preload→ready 生命周期，散在模块顶层。

### 改法

收成一个 `VoiceClientAsrEngine` 类：私有字段、显式生命周期 `install()/preload()/ready()/dispose()`、单一写路径。导出显式单例。**行为保持**：预加载/就绪/进度语义不变。

## Plan

1. 盘点 4 个 `let` 的读写点。
2. 定义 `VoiceClientAsrEngine`（私有字段 + install/preload/ready/dispose），逐字迁入。
3. 消费方改经实例；对外 API 不变。
4. 判据 + 收口。

## AC

- [x] (a) **状态私有化 + 生命周期显式**：`grep -nE "^(let|var) " src/shared/voiceClientAsrWorker.ts` 计数 = **0**；`grep -nE "class VoiceClientAsrEngine|preload\(\)|dispose\(\)" src/shared/voiceClientAsrWorker.ts` 命中。
- [x] (b) **显式单例**：`grep -nE "new VoiceClientAsrEngine" src/shared/voiceClientAsrWorker.ts` 命中。
- [x] (c) **既有行为不改一字仍绿**：覆盖 voiceClientAsrWorker 的既有 vitest 判据窄跑退出 0（执行时以实测为准；若文件名漂移用等价判据替换并记录）。
- [x] (d) **静态门**：`npm run typecheck` 退出 0；`npm run lint` 退出 0；`npm run build:client` 退出 0。
- [x] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「4 个模块级 `let` 收进了 `VoiceClientAsrEngine` 私有字段、install/preload/ready 生命周期由类显式表达」，不是「多了个类」。必须贴出：①(a)(b) grep 读数与类/单例行；②(c) 判据退出码；③(d) typecheck/lint/build；④纯位移核对（预加载/就绪语义未变）；⑤`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `src/shared/voiceClientAsrWorker.ts`（4 个 let → VoiceClientAsrEngine 私有字段 + 生命周期）
- `tasks/gap-voice-client-asr-engine-encapsulation.md`（自触）
