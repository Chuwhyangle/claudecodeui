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

## Evidence

**①(a) 状态私有化 + 生命周期显式**

- `grep -nE "^(let|var) " src/shared/voiceClientAsrWorker.ts` → 0 命中（grep 退出 1）。
- merge-base（5e8d3195e）版本的同一 grep 读到 4 个模块级 `let`：`206: let readinessRequest`、`927: let lastProgress`、`1135: let installedEngine`、`1165: let preloadPromise` —— 即本任务被点名的 4 个，全部消失。
- `grep -nE "class VoiceClientAsrEngine|preload\(\)|dispose\(\)"` 命中：`1137: export class VoiceClientAsrEngine {`、`1192: preload(): Promise<AsrRuntimeStatus> {`、`1251: dispose(): void {`。
- 单一写路径核对：4 个状态只作为类私有字段存在（`1139 private readinessRequest`、`1142 private lastProgress`、`1145 private installed`、`1148 private preloadPromise`），写点全部经方法（`1159 ready()` / `1167 install()` / `1195,1199,1202 preload()` / `1221 noteProgress()` / `1253-1256 dispose()`），模块层再无裸名写入。

**①(b) 显式单例**

- `1261: export const voiceClientAsrEngineInstance = new VoiceClientAsrEngine();` —— 导出的门函数（`voiceClientAsrReadiness` / `installVoiceClientAsrEngine` / `voiceClientAsrEngine` / `preloadVoiceClientAsrEngine` / `observeVoiceClientAsrEngine` / `voiceClientAsrProgress`）都是对它的薄委托。

**②(c) 既有行为判据窄跑**

- `bash scripts/with-memory-cap.sh ./node_modules/.bin/vitest run src/modules/chat/tests/voiceClientAsrRouting.test.ts` → 退出码 **0**；`Test Files 1 passed (1)`、`Tests 17 passed (17)`（该文件即唯一覆盖 `voiceClientAsrWorker` 的既有 vitest 判据）。

**③(d) 静态门**

- `npm run typecheck` → 退出码 **0**（tsconfig / server / scripts 三份）。
- `npm run lint` → 退出码 **0**（仅既有 warning，无 error）。
- `npm run build:client` → 退出码 **0**（`✓ built in 24.02s`）。

**④纯位移核对**

- `git diff --stat`：`src/shared/voiceClientAsrWorker.ts | 230 +++++---`，156 插 / 74 删，全部集中在 4 个 `let` 的读写点附近（4 个 hunk）。
- 语义逐处对照：`voiceClientAsrReadiness` 的 memo 语义原样迁入 `ready()`（`if (this.readinessRequest === null) this.readinessRequest = readClientAssetReading()`）；`install()` 保持「已装即返回」的幂等；`preload()` 保持同一 promise 复用 + 失败/不可用时清 memo 以允许重试；worker 的 `progress` 消息仍写入同一个 mirror（改由 `noteProgress()` 作唯一写点）；对外导出函数签名与返回值未变。
- 新增的 `dispose()` 是原模块级状态无处安放的显式生命周期端点（生产路径不调用，仅供测试还原），不改变既有语义。

**⑤范围受控**

- `git diff --name-only $(git merge-base HEAD develop) HEAD` → 仅 `src/shared/voiceClientAsrWorker.ts`，⊆ Touches。
- 驱动同款防漂移门：`anti-drift-touches-check --task gap-voice-client-asr-engine-encapsulation --worktree … --merge-target develop` → `ANTI-DRIFT OK: 1 actual file(s), all within declared Touches (2 glob(s))`，退出 0。

**运行环境**：未重启 :3001、未发布。

## Blocker

**2026-10-22T09:55:16.400Z — worker 未落地（exited-not-landed）**

- 未落地原因：AC 未全勾（checked 0/5，剩余未勾 5）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：6e8d8520-8148-463f-ac7f-ed1cdea1f748
