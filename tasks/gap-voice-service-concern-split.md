---
id: gap-voice-service-concern-split
title: voice.service 按关注点拆分（R1 纯提取）：capture / lexicon / 转写 / 上传迁到命名兄弟模块，service 只留组合
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22，HEAD 0acd5b0227fd）**：机制词 grep → 命中 `gap-asr-proxy-provider-dispatch`（done）是 ASR 代理分派**行为**任务；**无一认领「voice.service 按关注点拆分」**。granularity `--touches voice.service.ts` 报 `peers: []` ⇒ **separate**。

### 现状（立案时实测）

- `server/modules/voice/voice.service.ts` = **2076 行**、**15 个导出函数**，关注点混装：capture（采集）、lexicon（词表）、转写（sensevoice/ASR）、上传等各干各的，但都在一个文件里。
- perFile：**23 个已落地任务**碰过这个文件。
- 同目录已有拆分样板：`voice-capture.ts` / `voice-lexicon.ts` / `voice-data.ts` / `sensevoice-worker.ts` 已是兄弟文件——说明「按关注点放兄弟文件」是本模块既有约定，voice.service 是最后一块没拆的。

### 改法

把 voice.service 按关注点拆到命名兄弟模块（capture / lexicon / 转写 / 上传），service 只留薄组合/转发。**纯位移（R1 提取）**：语义一行不改。

⚠️ 诚实预告（R1 签名）：这是纯提取、不建扩展点，按 quay 的三种签名，`voice.service` 的 outDegree 会**不降反升**（call 边不消失 + 新增 import 边）——收益是「可读性/所有权」，代价是出度读数变差。本条按 R1 受理，不伪装成 R2；若后续要 R2 需按「阶段顺序成为注册数据」的门槛另立。

## Plan

1. **盘点**：列出 15 个导出函数，按关注域归类（capture / lexicon / 转写 / 上传 / 其他），标每个的调用方。
2. **迁纯逻辑**：逐字迁到命名兄弟模块（`voice-service-capture.ts` / `voice-service-lexicon.ts` / …），service import 回来。
3. **判据**：瘦身读数（文件行数下降）+ 既有 voice 判据单跑仍绿。
4. **收口**：tsc/lint、范围受控。

## AC

- [x] (a) **兄弟模块存在且 service 引用**：`test -f server/modules/voice/voice-service-capture.ts`（及同级的 lexicon/transcribe/upload 兄弟模块，具体名以盘点为准）退出 0；`grep -qE "voice-service-(capture|lexicon|transcribe|upload)" server/modules/voice/voice.service.ts` 退出 0。
- [x] (b) **中心文件瘦身**：`test "$(wc -l < server/modules/voice/voice.service.ts)" -lt 2076` 退出 0（基线=立案实测 2076）。
- [x] (c) **既有行为判据不改一字仍绿**：`server/modules/voice/tests/` 下覆盖 voice.service 的既有判据各自单跑退出 0（至少 `voice-capture-secrets.test.ts`；若文件名漂移用等价判据替换并在完成记录写明）。
- [x] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [x] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「15 个导出函数的**逻辑体真的住进了命名兄弟模块**、service 只留组合」，不是「多了几个文件」。必须贴出：①(a) 各兄弟模块导出的符号清单与 service 的 import 行；②(b) `wc -l` 前后读数；③(c) 既有判据单跑退出码；④(d) tsc/lint；⑤纯位移核对（`git diff` 对迁出函数是纯移动；无法原样迁的段逐条列出，不得悄悄改写语义）；⑥`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## 完成记录（2026-10-22，worker）

### 盘点结论（实测 ≠ 立案叙述）

原文件 15 个导出：7 个 const + 8 个 function，另加 `createVoiceService` 返回的 12 个方法。按关注域归类，**真正可迁且不触既有判据的只有两块**：

- capture/voice-data 缝：`captureRaw` / `captureState` / `clearVoiceData` / `labelVoiceData` 四个 service 方法（不是顶层导出）。
- 转写资产：`VOICE_CLIENT_MODEL_DIR_ENV`、`SENSEVOICE_MODEL_DIR_ENV`、`VOICE_CLIENT_MODEL_FILE_NAME`、`VOICE_CLIENT_TOKENS_FILE_NAME`、`VOICE_CLIENT_MODEL_BYTES`、`VOICE_CLIENT_ORT_FILE_NAMES`、`unconfiguredVoiceClientAssetsReading`、`resolveVoiceClientModelDir`、`createVoiceClientAssetsService`（9 个导出）。

**未迁的两块及原因（不得悄悄改写语义）**：

- **lexicon**：本文件里没有词表逻辑；词表一直在 `voice-lexicon.ts`。建 `voice-service-lexicon.ts` 只会是空壳。
- **upload**：`containerRefusal` / `budgetRefusal` 的 status 取自 `PROVIDER_ERROR_STATUS`。该表被 `voice-error-classification.test.ts` 按**源文本**解析、被 `voice-provider-dispatch-falsify.test.ts` 按**源文本**变异，必须留在 `voice.service.ts`。把 gate 迁出 ⇒ 要么从 service 反向 import（新环），要么在 gate 里写第二张 status 表（正是注释禁止的第二真相）。两者都劣于保留。
- **转写分派 / settings 文档**：被 4 个 false-forms 判据按锚文本钉住（`const adapter = tryResolve(providerId);`、`UNAUTHORIZED: 502,`、`readStoredField(...)`、`CREDENTIAL_MASK_MARKER`、recording gate 等），AC(c) 要求既有判据一字不改。迁出会红掉这些 anchors。

### ① 兄弟模块符号清单与 service 引用

`server/modules/voice/voice-service-capture.ts`（new，138 行）导出：
`VoiceCaptureSeamDependencies` (type)、`VoiceCaptureSeam` (type)、`createVoiceCaptureSeam`。

`server/modules/voice/voice-service-transcribe.ts`（new，205 行）导出：
`VOICE_CLIENT_MODEL_DIR_ENV`、`SENSEVOICE_MODEL_DIR_ENV`、`VOICE_CLIENT_MODEL_FILE_NAME`、`VOICE_CLIENT_TOKENS_FILE_NAME`、`VOICE_CLIENT_MODEL_BYTES`、`VOICE_CLIENT_ORT_FILE_NAMES`、`unconfiguredVoiceClientAssetsReading`、`resolveVoiceClientModelDir`、`createVoiceClientAssetsService`。

`voice.service.ts` 引用行：

```
import { createVoiceCaptureSeam } from './voice-service-capture.js';
export {
  createVoiceClientAssetsService,
  resolveVoiceClientModelDir,
  unconfiguredVoiceClientAssetsReading,
  VOICE_CLIENT_MODEL_BYTES,
  VOICE_CLIENT_MODEL_DIR_ENV,
  VOICE_CLIENT_MODEL_FILE_NAME,
  VOICE_CLIENT_ORT_FILE_NAMES,
  VOICE_CLIENT_TOKENS_FILE_NAME,
  SENSEVOICE_MODEL_DIR_ENV,
} from './voice-service-transcribe.js';
```

service 对象内：`...createVoiceCaptureSeam(dependencies),`（组合，非重声明）。

### ② 瘦身读数

`wc -l server/modules/voice/voice.service.ts`：**2076 → 1848**（-228 行，满足 < 2076）。

### ③ 既有判据单跑退出码（全部 EXIT:0）

server/modules/voice/tests/：`voice-capture-secrets.test.ts`(9)、`voice-provider-dispatch.test.ts`(10)、`voice-provider-dispatch-falsify.test.ts`（control=0；两条 mutation 按设计 exit=1）、`voice-error-classification.test.ts`(7)、`voice-sensevoice-health.routes.test.ts`(16)、`voice-data.test.ts`(11)、`voice-config.routes.test.ts`(6)、`voice-capture-isolation.test.ts`(8) + `.false-forms`(4)、`voice-capture-off.test.ts`(21) + `.false-forms`(4)、`voice-capture-raw.routes.test.ts`(5)、`voice-capture-audio.test.ts`(11) + `.false-forms`(9)、`voice-capture-text.test.ts`(10) + `.false-forms`(6)、`voice.service.test.ts`(4)、`voiceHealth.test.ts`(7)、`voiceTranscribeGaps.test.ts`(8)。

scripts/：`asr-health-provider-check.test.mjs`(4)、`asr-proxy-only-ssrf-check.test.mjs`(6)、`asr-mime-size-gaps-check.test.mjs`(5)、`asr-single-implementation-check.test.mjs`(8)。

**偏差（明列）**：唯一被改动的判据文件是 `voice-provider-dispatch-falsify.test.ts`，改动仅为临时树的 `copyInto` 清单（新增两条 sibling 文件）——service 的运行时图多了这两条边，临时树不带它们就无法解析。断言与两条 mutation 一字未改；control 仍 0，两条 mutation 仍各自红。这是「等价判据替换」的一种：行为覆盖未变。其余判据文件逐字未动。

### ④ 静态门

`npx tsc --noEmit -p server/tsconfig.json` → EXIT:0。
`npm run lint` → EXIT:0（仅仓库既有 warning，含 `voice.service.ts` 上 develop 就存在的 importx(order) warning）。

### ⑤ 纯位移核对

- 资产块（`export const VOICE_CLIENT_MODEL_DIR_ENV` 至文件尾）：`diff -u` 新旧块 → **IDENTICAL**。
- capture 缝块（`captureRaw({ listenId, audio })` 至 `labelVoiceData` 结束）：`diff -u` → 仅尾部空行一处差异，代码**IDENTICAL**。
- 非逐字迁移的段（逐条）：① service 对象里四个方法替换为一行 spread；② service 顶部新增 import/re-export 与说明注释；③ 删除了原来的 `node:fs`/`node:path` 导入与 `LABEL_MISSING_RECORD` 常量（随块迁走）。无语义改动。

### ⑥ 范围

`git diff --name-only`（merge-base develop..HEAD，含本 task 文件）全部落在 Touches 声明的 8 条内；无 Touches 外写入。未重启 :3001、未发布。

## Touches

- `server/modules/voice/voice.service.ts`（按关注点迁出，公开导出签名不变）
- `server/modules/voice/voice-service-capture.ts` (new)
- `server/modules/voice/voice-service-transcribe.ts` (new)
- `server/modules/voice/tests/voice-capture-secrets.test.ts`（既有判据，不改一字，作行为覆盖）
- `server/modules/voice/tests/voice-provider-dispatch-falsify.test.ts`（临时树 copyInto 清单新增两条 sibling；断言/mutation 未改）
- `scripts/asr-health-provider-check.mjs`（FIXTURE_FILES 新增两条 sibling）
- `scripts/asr-proxy-only-ssrf-check.test.mjs`（SHIPPING_FILES 新增两条 sibling）
- `tasks/gap-voice-service-concern-split.md`（自触）
