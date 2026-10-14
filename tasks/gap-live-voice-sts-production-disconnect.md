---
id: gap-live-voice-sts-production-disconnect
title: 取消 createSilenceTailGate/VOICE_REALTIME_SILENCE_TAIL 的生产调用——默认原样透传，旧 env
  显式 deprecated/ignored，STS 模块与测试原样归档不删
status: ready
labels:
  - gap
  - P0
parent: null
children: []
extra:
  acceptance: test -f
    server/modules/voice-realtime/tests/voice-realtime-silence-tail-deprecated.test.ts
    && npx tsx --tsconfig server/tsconfig.json --test
    server/modules/voice-realtime/tests/voice-realtime-silence-tail-deprecated.test.ts
---
## Proposal

**人 yale 2026-10-14 裁定**：「STS 已证实无效，取消生产调用」——依据是本会话此前的只读架构审计：STS（`voice-realtime-silence-tail.ts`）是一套独立实现的自适应 RMS/dBFS 静音检测+上行抑制状态机，默认关，由 `VOICE_REALTIME_SILENCE_TAIL` 开启；人已看过其实测读数并裁定它不再值得在生产路径上保留。

**本任务只断开生产调用路径，不删除模块/测试/历史读数**。代码现状（本轮核实）：

- `server/index.ts:591-596` 在 `buildVoiceRealtimeSeams` 里调用 `resolveSilenceTail(process.env)` + `describeSilenceTail(...)` 并把说明行写日志。
- `server/index.ts:820-836`：**唯一**把 `silenceTail` 对象塞进 `seams.silenceTail` 的地方——条件是 `silenceTail.enabled && transportChoice !== 'continuous'`（这里 `transportChoice` 是单条连接的覆盖选择，不是部署级默认值；部署级默认现在已是 continuous，见 `voice-realtime-mode.ts`）。
- `voice-realtime-ws-proxy.service.ts:1769-1810`：`silenceTailOptions = seams.silenceTail === undefined || segmentedRelay ? null : seams.silenceTail`，非 null 时 `createSilenceTailGate(silenceTailOptions)` 真正构造门控；同一段还有"STS 与 uplinkVad 同时在场时 STS 赢、uplinkVad 被拒"的互斥分支（`uplinkVadRequested && silenceTail !== null` ⇒ 拒绝并记日志）。

**断开方式**：`server/index.ts` 的组装函数**永远不再**把 `silenceTail` 填进返回的 seams 对象，不论 `VOICE_REALTIME_SILENCE_TAIL` 取何值；`voice-realtime-ws-proxy.service.ts` 本身**不改**（它仍然"认识"`seams.silenceTail` 这个字段——这是 `uplinkVad` seam 已经验证过的同一个模式：字段存在、测试可以直接构造它，但生产组装根不再喂）。这样：

1. **默认行为**：未来任何连接，无论 env 怎么设，都只会走 `silenceTail === null && uplinkVad === null` 的快路径（`frame.audio` 原样 `bridge.sendAudioFrame`），与"STS 存在之前"逐字节相同。
2. **不形成双门控**：既然生产永远不填 `seams.silenceTail`，`voice-realtime-ws-proxy.service.ts` 里"STS 赢过 uplinkVad"的互斥分支在生产里永远不会被触发；而另一个门控（`uplinkVad`）在生产装配里同样没有 arm 点（见 AC4 的读数），所以两个门控在生产里**同时生效是不可能的**。
3. **旧 env 显式降级**：设置 `VOICE_REALTIME_SILENCE_TAIL` 时，生产日志必须打一行清楚的"deprecated / ignored"说明（不是沉默吞掉，也不是继续打印"已启用"式的旧文案），且实际转发字节不受这个 env 值影响。
4. **保留证据**：`voice-realtime-silence-tail.ts`、其既有测试（`voice-realtime-silence-tail-suppression.test.ts` 等）、`experiments/voice-realtime-silence-tail-suppression/`、`docs/operations/voice-realtime-silence-tail-suppression-probe.md` 等**原样保留，不删除、不改**——它们仍然证明 STS 模块本身在隔离测试下行为正确，只是生产不再调用它。

## Plan

1. 在 `server/index.ts` 的 `buildVoiceRealtimeSeams` 里：保留 `resolveSilenceTail`/`describeSilenceTail` 的调用（如实读出 env 值），但把原有的"启用时打印说明"替换/追加为一条明确的 deprecation 日志（当 `silenceTail.enabled` 为真时）；删除第 820-836 行那段把 `silenceTail` 塞进返回对象的条件分支，改成**永远不**包含该字段。
2. 不触碰 `voice-realtime-ws-proxy.service.ts`、`voice-realtime-silence-tail.ts` 本身——二者的互斥分支与门控逻辑继续存在，只是生产不再喂给它们非 null 的 seam。
3. 新测试 `voice-realtime-silence-tail-deprecated.test.ts`：按 AC1 选定的入口形态取证（把组装函数抽成可导入的模块并直接调用它，**或**用既有的源码区间读法——两者择一，在 `## Evidence` 写明选了哪条与理由）。
4. 既有 STS 测试（`voice-realtime-silence-tail-suppression.test.ts` 及同名 criterion）单文件运行必须保持退出 0——它们直接构造 `voice-realtime-ws-proxy.service.ts` 的 seam（不经过 `server/index.ts`），不受本次改动影响；本任务需要实际跑一次确认，不能只靠推理。
5. 若 `describeSilenceTail` 的既有导出被其他模块/测试原样依赖其旧文案，不改它本身，deprecation 文案在 `server/index.ts` 里新增，不改 `voice-realtime-silence-tail.ts` 的导出契约。

## AC

- [x] AC1 任意 `VOICE_REALTIME_SILENCE_TAIL` 取值（包括合法启用值）下，组装函数**不再**把 `silenceTail` 填进它返回的 seams 对象。**入口形态（二选一，写入 Evidence）**：(i) 把该组装函数抽成可导入的模块并直接调用 —— 于是断言 `'silenceTail' in seams === false`；(ii) 用本仓既有的源码区间读法 —— 切 `const buildVoiceRealtimeSeams` 到 `function resolveIdleRotateMs` 之间（**先断言该区间可定位**，证非空洞），断言区间内**不存在** `silenceTail:` 这个属性键（`resolveSilenceTail(` / `describeSilenceTail(` 的出现不算命中）。取假形态：恢复第 820-836 行的旧分支 ⇒ 本断言红。
- [x] AC2 `VOICE_REALTIME_SILENCE_TAIL` 设为真值时，日志回调/组装点输出里包含"deprecated"或"ignored"（中英文皆可，但必须清楚表达"不再生效"），且**不再**出现旧的"已启用 tailMs=... prerollMs=..."式文案；未设该 env 时不打印任何相关行（沉默=未配置，与今天行为一致）。
- [x] AC3 **逐字节不变**：用同一串浏览器帧跑 `voice-realtime-ws-proxy.service.ts` 的生产路径，`VOICE_REALTIME_SILENCE_TAIL` 设为真值 vs 不设，两次喂进 `bridge.sendAudioFrame` 的帧序列**逐帧逐字节相同**（用"缝引入前一个 revision 的真实 proxy"作对照的做法已有先例，可复用）；取假形态：若断开不完整（仍偶尔构造门控）⇒ 两次序列不同，本断言红。
- [x] AC4 **不形成双门控（在当前装配下即可判定，⛔ 不需要任何其它任务先落地）**：两个门控 seam 在生产组装里**都不可能同时非 null** —— (a) `silenceTail` 不被填入，由 AC1 的读数证明；(b) `uplinkVad` 在生产装配里没有 arm 点：给出 `grep -rn 'uplinkVad' server/index.ts` 的读数（当前为空）与 `seams.uplinkVad` 仅在测试里被构造的读数。⇒ `voice-realtime-ws-proxy.service.ts` 的「STS 赢过 uplinkVad」互斥分支在生产里**不可达**。⛔ 不得为构造「两者同时在场」的场景去改生产装配、不得新增 arm 点、不得把本条写成依赖另一条任务才能完成。
- [x] AC5 `localSpeechGate.observe` 的调用点、`bridge.noteLocalActivity?.()` 的调用条件、`turn_detection` 的解析（`resolveTurnDetection`）**逐字节未改**——给出 diff 读数（这三者所在的代码段不在本次 diff 里）。
- [x] AC6 既有 STS 测试文件（列出具体文件名）单文件运行退出 0，证明历史证据未被破坏。
- [x] AC7 未重启 `:3001`（pid 前后相同，写出读数）、未改线上 `.env`。

## Evidence

**入口形态（AC1，二选一）**：选 **(ii) 源码区间读法**。理由：`buildVoiceRealtimeSeams` 是 `server/index.ts` 的**局部 const，未导出**，无法被直接调用；本仓既有同类判据（`voice-realtime-transport-opt-in.test.ts` 的 "AC1 wiring" 腿）亦只在源码文本层面读 `server/index.ts`。(i) 需要把整个组装函数从 `server/index.ts` 抽成可导入模块，是一处远大于本任务范围的重构，且会与声明改同一函数的并行任务冲突。新测试 `voice-realtime-silence-tail-deprecated.test.ts` 切 `const buildVoiceRealtimeSeams` → `function resolveIdleRotateMs` 区间，**先断言两标记可定位且区间非空**，再断言区间内无 `silenceTail:` 键。

**AC1**：新测试 `voice-realtime-silence-tail-deprecated.test.ts` 的 AC1 腿通过。区间内 `resolveSilenceTail(`/`describeSilenceTail(` 均在（证非空洞），`silenceTail:` 不在。假形态：把恢复的 820-836 旧分支文本喂给同一谓词 `fillsSilenceTailSeam` ⇒ 返回 true（本断言非恒真）；函数调用串喂给同一谓词 ⇒ false（AC 的 `resolveSilenceTail(`/`describeSilenceTail(` 豁免显式成立）。

**AC2**：新测试 AC2 腿通过。区间正则 `if \(silenceTail\.enabled\) \{\s*input\.log\?\.\(` 命中（deprecation 行只在 `silenceTail.enabled` 守卫后）；文案含 `DEPRECATED and IGNORED` 与 `forwards every captured frame unchanged`；区间内无 `tailMs=`/`prerollMs=`（旧 enabled 式文案不存在）。`resolveSilenceTail({}).enabled===false`（未设 ⇒ 守卫假 ⇒ 不打印任何行）、`{[SILENCE_TAIL_ENV]:'1'}.enabled===true`。

**AC3**：新测试 AC3 腿通过。60 帧同一语料（底噪 5 + 语音 5 + 底噪 50，每帧 payload 唯一）喂真 proxy（生产形态 seam，**无** `silenceTail`），`VOICE_REALTIME_SILENCE_TAIL=1` 与 unset 两次喂进上游的 `input_audio_buffer.append` 帧序列 `deepEqual`，且逐帧等于浏览器帧（恒等中继）。对照臂：同一 harness 把 seam 真填（`{tailMs:40,prerollMs:20,keepaliveMs:0}`，即断连前的装配）⇒ 序列更短：证明本 harness 能感知门控，"两次相同"非真空。

**AC4**：新测试 AC4 腿通过。读数：`grep -rn 'uplinkVad' server/index.ts` → 空（exit 1）；`grep -rn 'uplinkVad:' server/ --include=*.ts` → 构造点只有 `voice-realtime-ws-proxy.service.ts:1787`（局部变量 `let uplinkVad: UplinkVadGate | null`，非 seam）与 `tests/voice-realtime-uplink-vad-seam.test.ts`（测试直接构造 `seams.uplinkVad`），**生产装配无 arm 点**。`silenceTail` 不被填由 AC1 证明 ⇒ 互斥分支条件 `uplinkVadRequested && silenceTail !== null` 的 `silenceTail !== null` 在生产恒假 ⇒ **不可达**。测试同时断言该分支源码仍在（本任务只退调用点，不删分支）。

**AC5**：读数——`git diff develop --stat -- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` **为空** ⇒ `localSpeechGate.observe`（:3717）与 `bridge.noteLocalActivity?.()`（:3729）逐字节未改；`resolveTurnDetection` 的调用点（`server/index.ts`、`voice-realtime-ws-proxy.service.ts:1795`）与其解析实现（`voice-realtime-turn-detection.ts`）均不在本 diff——`git diff develop -- server/index.ts | grep -E 'resolveTurnDetection|localSpeechGate|noteLocalActivity'` 无命中。本次 `server/index.ts` 的 diff 只删/改 STS 那两处。

**AC6**：文件 `server/modules/voice-realtime/tests/voice-realtime-silence-tail-suppression.test.ts` 单文件运行 **13 pass / 0 fail，退出 0**（合并 develop 后复跑仍退出 0）。

**AC7**：`:3001` pid 前后同为 **2908057**（`ss -ltnp` 读数），未重启；`git status` 无任何 `.env*` 改动（`.env` 本就被 `.gitignore` 忽略，未写入）。

**构建/静态**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npx oxlint server/index.ts server/modules/voice-realtime/tests/voice-realtime-silence-tail-deprecated.test.ts` 退出 0。anti-drift Touches 硬门：`ANTI-DRIFT OK: task gap-live-voice-sts-production-disconnect — 2 actual file(s), all within declared Touches (3 glob(s))`，退出 0。

## DoD

生产组装根不再有任何路径能让 `createSilenceTailGate` 被调用；旧 env 变量被显式标注为 deprecated/ignored 而非静默失效；默认转发行为逐字节不变；STS 模块代码、测试、实验文档原样保留；`localSpeechGate`/`noteLocalActivity`/`turn_detection` 未受影响。

## Touches

- server/index.ts
- server/modules/voice-realtime/tests/voice-realtime-silence-tail-deprecated.test.ts (new)
- tasks/gap-live-voice-sts-production-disconnect.md

## Notes

**查重（2026-10-14）**：`gap-live-voice-silence-tail-suppression`、`gap-live-voice-silence-tail-suppression-probe`、`gap-voice-server-vad-three-arm-replay-on-third-test-corpus` 均 `done`，是 STS **落地与实测**本身，不是"取消生产调用"——无重复。

**显式不做**：不删除 `voice-realtime-silence-tail.ts`、不删除其测试、不删除 `experiments/voice-realtime-silence-tail-suppression/` 或相关 `docs/operations/*silence-tail*`；不改 `voice-realtime-ws-proxy.service.ts` 内部对 `seams.silenceTail` 的处理逻辑本身（保留给未来可能的测试/实验直接构造）。

### 2026-10-14 改写记录（AC4，兼 AC1 的入口形态）

**为什么改写**：原 AC4 要求「构造一个同时满足『uplinkVad 已请求』与『STS env 设为真值』的生产场景，走 `buildVoiceRealtimeSeams` 的真实返回值」，并自我声明要等另一条任务落地后由其回归测试接着验证。两处都不成立：(1) 该句尾的「等它落地后」正是本仓 `ready-pool-check` 的 `UNSATISFIABLE_AC_DECLARATION_PHRASES` 会拦的自我声明 ⇒ `eligible=false`，promotion/dispatch 连续 3 轮被挡，任务被标 `needs-human`；(2) `buildVoiceRealtimeSeams` 是 `server/index.ts:538` 的**局部 const，未导出**（既有的同类判据都用「读源码区间」而非调用它），而 `uplinkVad` 在生产装配里根本没有 arm 点 ⇒「同时在场」的生产场景**不可能构造**。

**改写方向**：把 AC4 变成"在当前装配下判定不可能同时生效"的读数（`silenceTail` 不被填 + `uplinkVad` 无 arm 点 ⇒ 互斥分支不可达），并给 AC1 明确两条可用的入口形态。⛔ 不新增 arm 点、不改生产装配去凑场景。

**顺序关系（裸写 id，避免被读成未声明的边）**：arm-point 那条任务（gap-live-voice-uplink-vad-production-arm-point）在它自己的 frontmatter 里声明了「本任务先行」的边，理由是两者会改同一个函数 `buildVoiceRealtimeSeams`、避免冲突。本任务**不**依赖那条任务，也不等它落地——AC4 的读数已按当前装配写成自足形态。

## Needs-Human

**执行 2026-10-14T00:17:26.421Z — 连续修满重试上限仍不合格（标 needs-human）**

- 阻碍原因：unsatisfiableUnannotatedAc=[AC4 **不形成双门控**：构造一个同时满足"uplinkVad 已请求"与"STS env 设为真值"的生产场景（走 `buildVoiceRealtimeSeams` 的真实返回值），断言 `voice-realtime-ws-proxy.service.ts` 里旧的"STS 赢"日志行**不出现**——因为 `seams.silenceTail` 从未非 null，`uplinkVadRequested` 分支里该 if 分支天然不触发；该 AC 暂时只能断言"日志不出现"，等 `gap-live-voice-uplink-vad-production-arm-point` 落地后由那边的回归测试接着验证 uplinkVad 本身正常工作。]（连续 3 轮被结构上不可派的拦截挡住 ⇒ 作者/人改写；⛔ 不派 fix worker）

**2026-10-14 处置**：按上节改写 AC4（并给 AC1 明确入口形态）后，本条不再自我声明依赖另一条任务，可从 todo 重新晋升并派发。

## Blocker

**2026-10-14T00:35:05.973Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: __PERFILE__ duration_ms=71069 server/shared/tests/quay-test-script.test.ts passed=false end_ms=1791937779415
- run_id：wk-prod-anchor
- session_id：094b95bf-a89a-4417-b418-77069a5b8b50
