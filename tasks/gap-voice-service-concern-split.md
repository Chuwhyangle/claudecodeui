---
id: gap-voice-service-concern-split
title: voice.service 按关注点拆分（R1 纯提取）：capture / lexicon / 转写 / 上传迁到命名兄弟模块，service 只留组合
status: todo
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

- [ ] (a) **兄弟模块存在且 service 引用**：`test -f server/modules/voice/voice-service-capture.ts`（及同级的 lexicon/transcribe/upload 兄弟模块，具体名以盘点为准）退出 0；`grep -qE "voice-service-(capture|lexicon|transcribe|upload)" server/modules/voice/voice.service.ts` 退出 0。
- [ ] (b) **中心文件瘦身**：`test "$(wc -l < server/modules/voice/voice.service.ts)" -lt 2076` 退出 0（基线=立案实测 2076）。
- [ ] (c) **既有行为判据不改一字仍绿**：`server/modules/voice/tests/` 下覆盖 voice.service 的既有判据各自单跑退出 0（至少 `voice-capture-secrets.test.ts`；若文件名漂移用等价判据替换并在完成记录写明）。
- [ ] (d) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [ ] (e) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` ⊆ `## Touches`。

## DoD

真实落地的标准是「15 个导出函数的**逻辑体真的住进了命名兄弟模块**、service 只留组合」，不是「多了几个文件」。必须贴出：①(a) 各兄弟模块导出的符号清单与 service 的 import 行；②(b) `wc -l` 前后读数；③(c) 既有判据单跑退出码；④(d) tsc/lint；⑤纯位移核对（`git diff` 对迁出函数是纯移动；无法原样迁的段逐条列出，不得悄悄改写语义）；⑥`git diff` 只含 Touches。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/voice/voice.service.ts`（按关注点迁出，公开导出签名不变）
- `server/modules/voice/voice-service-capture.ts` (new)
- `server/modules/voice/voice-service-lexicon.ts` (new)
- `server/modules/voice/voice-service-transcribe.ts` (new)
- `server/modules/voice/voice-service-upload.ts` (new)
- `server/modules/voice/tests/voice-capture-secrets.test.ts`（既有判据，不改一字，作行为覆盖）
- `tasks/gap-voice-service-concern-split.md`（自触）
