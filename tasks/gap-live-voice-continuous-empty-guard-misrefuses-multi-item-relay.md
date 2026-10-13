---
id: gap-live-voice-continuous-empty-guard-misrefuses-multi-item-relay
title: continuous 空转写守卫只看「最后一个已转写条目」，模型把多段合成一次 session_send 时被末尾 0.37 s
  空碎片整条误拒——改为按上次转发以来的归属区间判定
status: ready
labels:
  - gap
  - P0
parent: null
children: []
extra:
  acceptance: test -f
    server/modules/voice-realtime/tests/voice-realtime-continuous-empty-guard-span.test.ts
    && npx tsx --tsconfig server/tsconfig.json --test
    server/modules/voice-realtime/tests/voice-realtime-continuous-empty-guard-span.test.ts
---
## Proposal

**现象（2026-10-13 真实 live voice，journal `b5d01c21`，continuous）**——人说的「几步的延迟都有点大，包括识别延迟」机械性丢失：

```
56:57.740 transcription.completed "几步的延迟都有点大。"
56:57.815 function_call session_send {"message": "      ← response cancelled (turn_detected)，MALFORMED_FUNCTION_CALL
57:01.504 transcription.completed "包括识别脸识。"
57:01.794 transcription.completed ""                   ← 57:01.323–01.695 的 0.37 s 碎片
57:02.324 function_call session_send {"message": "几步的延迟都有点大，包括识别延迟，然后……"}
57:02.324 session_send not-delivered (empty-transcript)
```

**机制（代码已核）**：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` `sessionSend` 的 continuous 分支（约 :2705–2718）只问 `itemTranscriptEmpty.get(lastTranscribedItemId)`。模型一次调用覆盖了**上次转发以来的多个条目**（这里 3 个，两个有字），守卫却只按最后一个条目（空碎片）裁决 ⇒ 有文本的转发被整条拒绝。前一次同内容调用因 `turn_detected` 被截断（MALFORMED），两者叠加 ⇒ 整句丢失。

人 yale 2026-10-14 批准（复盘 P0-2）：**按归属水位/区间修正**。

## Plan

1. 在 proxy 维护 continuous 的**转发水位**：记录上一次被接受（或被判定处理完）的 `session_send` 时刻已转写到的条目位置；本次调用的**归属区间** = 水位之后到当前为止已 `transcription.completed` 的全部条目。
2. 守卫改为：区间内**全部**条目转写为空（且 `message` 本身已由 `EMPTY_RELAY_TEXT` 判非空）才拒；区间内只要有一条非空 ⇒ 放行。区间为空集（还没有任何转写）沿用现行「unknown 不是 empty」放行。
3. 水位推进点：被接受投递、被判空拒绝、MALFORMED 截断——三者语义分别写清；MALFORMED 截断**不推进**水位（其内容会由模型重发）。
4. segmented 路径的 seq-keyed 守卫不动。
5. 测试：新文件 `voice-realtime-continuous-empty-guard-span.test.ts`，用 b5d01c21 的**逐字事件序列**（3 条转写含 1 条空 + 截断调用 + 合并调用）驱动假上游。

## AC

- [x] AC1 回放 b5d01c21 56:57.740–57:02.324 的事件序列（逐字转写与逐字 `arguments`）⇒ `session_send delivered`，投递文本为 `几步的延迟都有点大，包括识别延迟，然后……`；取假形态：守卫改回只看 `lastTranscribedItemId` ⇒ 本用例红（`not-delivered (empty-transcript)`）。
- [x] AC2 区间内全部为空（如单个空碎片后紧跟一次转发）⇒ 仍 `not-delivered (empty-transcript)`，现有 `voice-realtime-empty-transcript-guard.test.ts` 单文件运行退出 0。
- [x] AC3 水位推进：被接受的转发之后再来一条空碎片 + 转发 ⇒ 拒（不被更早的非空条目「借票」放行）；取假形态：水位不推进 ⇒ 红。
- [x] AC4 MALFORMED 截断不推进水位：截断 → 新转写 → 重发 ⇒ 重发的归属区间包含截断前的条目。
- [x] AC5 segmented 路径行为不变：segmented 相关守卫测试单文件运行退出 0。
- [x] AC6 用 capture `b5d01c21….wav`（sha256 前缀 `0f2bd51fbbb28c9f`）对应区间在备用端口实例或探针上做一次真实上游回放（花费上限 ¥0.1，未重启 :3001、pid 前后相同），把读数（转录条目、调用、守卫裁决）写入 Notes；真实上游未复现同一切分时如实写「未复现，仅脚本证据」。

## DoD

continuous 模式下，一次覆盖多个条目的转发只在其归属区间全空时被拒；b5d01c21 的丢句形态在合入后的代码上被投递；空碎片单独转发仍被拒。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-empty-transcript-guard.test.ts
- server/modules/voice-realtime/tests/voice-realtime-continuous-empty-guard-span.test.ts (new)
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-live-voice-continuous-empty-guard-misrefuses-multi-item-relay.md

## Notes

**查重（2026-10-14）**：`gap-voice-realtime-empty-transcript-delivery-guard`（done）引入投递点守卫；SPEC §10 / 决策文档 §12.5「按条目自身空转写判定」引入 continuous 的 item-scoped 分支——本任务修正其「最后条目」近似，不是重复。无未完成同机制任务。

**证据**：journal `~/.cloudcli/voice-realtime-log/b5d01c21-3f53-4228-a28e-d18b7cb967f7.jsonl`、capture 同 id。

**实现（2026-10-14，分支 `task/gap-live-voice-continuous-empty-guard-misrefuses-multi-item-relay`）**——`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`：

- 删去 `lastTranscribedItemId`，改为 `transcribedSinceWatermark: string[]`：**区间本身就是水位**——压入即「水位之后新增」，排空即「推进」，所以水位不需要自己的序号，数组也不会随连接时长增长。
- 压入点：`onCaption` 的 final 转写处，仅 continuous（`if (!segmentedRelay)`）；segmented 分支字节不变。
- 判定：`transcribedSinceWatermark.every((itemId) => itemTranscriptEmpty.get(itemId) === true)` 才拒；区间为空集放行（「unknown 不是 empty」），区间内任一条目读数缺失同样读作放行。
- 两个推进点：`sessionSend` 判空拒绝之后、`proceedRelay` 接受投递之后（后者用 `if (!segmentedRelay && segmentSeq === null)` 包住，segmented 路径字节不变）。
- MALFORMED 截断不推进**无需额外代码**：截断调用在 bridge 的 `handleFunctionCall` 抛 `MALFORMED_FUNCTION_CALL`，根本不进入 `sessionSend`/`proceedRelay`。
- 新测试 `server/modules/voice-realtime/tests/voice-realtime-continuous-empty-guard-span.test.ts`（7 例）；两条假形态按本目录既有约定写成 `__criterion-falsify-span-*`（base + mutant 各一份，`finally` 删除，另有残留测试守着）。

**验证读数（2026-10-14，第一轮）**：

- 新测试文件单跑：7 passed / 0 failed，exit 0；合入 develop 后重跑同读数。
- `voice-realtime-empty-transcript-guard.test.ts` 单跑：17 passed / 0 failed，exit 0（AC2 后半 + AC5）。
- `voice-realtime-segmented-protocol.test.ts` 单跑：21 passed / 0 failed，exit 0（AC5）。
- continuous 相邻判据单跑全绿：`unforwarded-disposition` 4、`replay` 1、`delivery-boundary` 4、`follow-up-credit` 5、`caption-item-attribution` 13、`scripted-scenarios` 28、`teardown-races` 3，均 exit 0。
- `npx tsc --noEmit -p server/tsconfig.json` exit 0；`npx oxlint` 两个改动文件 exit 0。
- `git merge --no-edit develop` 无冲突；anti-drift Touches 检查：OK（2 个实际文件均在声明内）。

**AC6 真实上游回放（2026-10-14）**：

- capture `b5d01c21-….wav`，sha256 `0f2bd51fbbb28c9f60bc381684fa7b4f38aa845c07f2d79b4f17ed8b08696e33`（与 AC 中的前缀一致）。
- 探针 `/data/home/yale/work/quay-scratch/ac6-b5d01c21-probe/probe.mts`：worktree 的 shipping `handleVoiceRealtimeConnection` + 真实 `createDashscopeTransport`（`voice=Tina`，`server_vad` 0.5 / 400 ms），executor 为记录桩（守卫裁决在 proxy 侧，早于 executor），spendGuard 0.05 CNY / 30 s。
- :3001 未重启：pid **766174**，两次回放前后相同。
- 跑 1（区间 33.0–45.0 s，2× 速率）：转写条目 5 条——`包括识别的延迟。` / `然后。` / `识别到。` / `实际执行的时间。` / `都比较长。`，**全部非空**；模型 3 次 `session_send` 全部 `delivered`；**复现了「截断」那一半**——`function_call session_send {"message": "包括识别延迟。` 之后紧跟 `MALFORMED_FUNCTION_CALL`（arguments are not JSON … position 21）与 `response.done status=cancelled reason=turn_detected`，与 journal 56:57.815 同形态。
- 跑 2（区间 37.0–43.5 s，1× 实时）：2 条非空条目，2 次投递全部 `delivered`，无空碎片。
- **同一「切分」未复现**：真实上游这两次都没有在该区间切出 0.37 s 的空转写碎片，「有文本的转发被 `not-delivered (empty-transcript)` 整条误拒」这一形态在真实上游上未被观测到——**未复现，仅脚本证据**（正证据＝AC1 的逐字回放与 journal `b5d01c21` 本身）。真实上游的读数与修复方向一致：全程无任何 `not-delivered (empty-transcript)`，且「截断 → 再发」这一段（AC4 形态）被投递。
- 花费：两次合计约 ¥0.01–0.02（输入 ~9.5k token、其中音频 ~240 token，输出 ~140 token），低于 ¥0.1 上限。

**第二轮（2026-10-14，worker 重入）——上一轮 suite 红的真因，逐条查证**：

上一轮的判词 `[baseline A/B: HARD RED (changed-assertion) — added=quay-test-script.test.ts changed=voice-realtime-uplink-vad.test.ts]` 把三件事混在一起。复跑单文件取证后分成三条：

- **`server/shared/tests/quay-test-script.test.ts`（`added`）＝ 真回归，本任务引入，本轮已修**。本任务新增一个 server 测试文件 `voice-realtime-continuous-empty-guard-span.test.ts`，collect 列表 323 → 324，把该文件三条读数从 develop 的绿推到红：AC7 覆盖率地板 `baseline covers 291/324 collected files (< 90%)`（291/323 恰是 90.09%，只多一个文件就掉到 89.81%），以及两条按 collect 列表计数的 dispatch pin `known=3 unknown=320`、`known=1 unknown=322`（实测 321、323）。修复：把新文件的一行 `1142\t…voice-realtime-continuous-empty-guard-span.test.ts`（单跑实测 `duration_ms 1142.8`）追加到 `scripts/suite-duration-baseline.tsv`（292/324 = 90.12%），同步两条 pin，并把两条仍在指名上一个分支文件（`voice-realtime-uplink-vad.test.ts`，它在 develop 上已在 collect 列表里）的陈旧注释改成指本任务新文件；另按该文件的记账惯例把头部 `291/322` 改成 `292/324` 并补一条 row-by-task 注记。修后单跑该文件：**14 passed / 0 failed, exit 0**（修前 11/3）。
- **`server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts`（`changed`）＝ 环境红，develop 既有，本任务改不动**。develop 的 baseline 单文件重跑同样红（`.quay/fan-in-suite-gap-live-voice-continuous-empty-guard-misrefuses-multi-item-relay~wk-prod-anchor~baseline-1791911360406-ef6075.log`：`passed=false exit=1`）；红因是 `silero is not available on this machine: optional dependency onnxruntime-node could not be loaded … Cannot find package 'onnxruntime-node'`（5 例：AC2/AC3/AC5/AC6 与 windowed-backends）。真因在**主检出的 node_modules**：`onnxruntime-node` / `sherpa-onnx-node` / `webrtcvad` 三条 `optionalDependencies` 在 `package.json`、`package-lock.json`、`node_modules/.package-lock.json` 里都**在册**，但磁盘上不存在（`node_modules/.package-lock.json` mtime `2026-10-13 23:55`，与同族任务接连拿到 `changed-assertion` 的时间吻合）；模型权重 `/data/home/yale/work/voice-vad-engines/silero/silero_vad.onnx` 在磁盘上。worktree 的 `node_modules` 是指向主检出的符号链接（`dispatch-worktree-setup.sh` 的既定行为：主检出缺件时不做 per-worktree 安装），所以这是**共享环境缺件**，与 `scripts/`、`server/` 的任何 delta 无关。
- **`changed-assertion` 这一判词本身是结构性假阳性（判据侧，在本仓库之外）**。worker-driver 的 `parseFailureSignatures`（`SIG_ASSERTION_LOOKAHEAD = 8`，`scripts/dist/worker-driver.js`）在全量 suite 日志里取不到 marker：`scripts/test.sh` 把 `not ok -` 行攒到日志末尾（本任务 suite 日志里 `__PERFILE__ …uplink-vad` 在第 332 行、对应的 `not ok -` 在第 550 行），8 行窗口里只有别的文件的 `__PERFILE__` 行 ⇒ marker 文本取成 `""`；而 baseline 是单文件重跑，`__PERFILE__` 与 `not ok -` 相邻 ⇒ marker 有真实文本。于是同一个 develop 既有红在两侧 `signatureKey` 不等 ⇒ 落到 `changed`。逐字比对：断言文本两侧都是 `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:`，**完全一致**。同轮兄弟任务 `gap-live-voice-function-call-output-rejected-after-speech-resume` 拿到同形态（`added=[] changed=[…uplink-vad.test.ts]`）。
- **三分**：真回归 1（本轮已修）／环境红 1（develop 既有，本任务不可修）／判据假阳性 1（marker 取法在仓库外的 `scripts/dist/worker-driver.js`）。
- **明确未做（越界）**：没有去主检出跑 `npm install` 补那三个 optional 依赖——那是共享 `node_modules` 的机器级修复（会与并发 session 相互干扰，且不在本任务 Touches 内），留给管理者/人决定；也没有为了过门去改 `scripts/test.sh`、baseline 的判定语义或 `voice-realtime-uplink-vad.test.ts`（那是另一个已 done 任务的判据，放宽断言就是 gaming）。
- **预期**：本轮修完 `quay-test-script.test.ts` 后，本任务的 suite 红集预计收缩为 `{voice-realtime-uplink-vad.test.ts}`，其 `added` 为空、`changed` 仍是那条环境红 ⇒ 判词预计仍是 `HARD RED (changed-assertion)`。要真落地需先解决共享 `node_modules` 的 optional 依赖缺件（本轮之后 develop 的全量 suite 对所有 code-delta 任务都是同一个阻塞点）。

**第二轮验证读数（2026-10-14）**：本任务 acceptance 命令（`test -f …voice-realtime-continuous-empty-guard-span.test.ts && npx tsx --tsconfig server/tsconfig.json --test …`）单跑 7 passed / 0 failed exit 0；`quay-test-script.test.ts` 单跑 14 passed / 0 failed exit 0；`npx tsc --noEmit -p server/tsconfig.json` exit 0；`npx oxlint` 两个改动文件 exit 0；`git merge --no-edit develop` 无冲突（自带入 develop 侧在本任务正文追加的 `## Blocker` 段）。

## Blocker

**2026-10-13T17:10:40.229Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: not ok - server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts:   AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: [baseline A/B: HARD RED (changed-assertion) — the task's red set is NOT a subset of the develop baseline red set: added=server/shared/tests/quay-test-script.test.ts,server/shared/tests/quay-test-script.test.ts changed=server/modules/voice-realtime/tests/voice-realtime-uplink-vad.test.ts]
- run_id：wk-prod-anchor
- session_id：d053eb2e-df38-46cc-a14a-93870906f2c3
