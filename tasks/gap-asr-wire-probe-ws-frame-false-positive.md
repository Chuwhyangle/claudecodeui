---
id: gap-asr-wire-probe-ws-frame-false-positive
title: AC-129 判据（线协议单实现边界探针）把语音实时模块的 WebSocket 帧解析误判成第二份实现：收窄响应半标记并补 WS 帧正面控制
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-129
---
## Proposal

<!-- dedup-ref --> 同机制去重结论：立案前对 `tasks/` 做过机制检索（`grep -rlE 'parsed-text-field|SECOND_IMPL|第二份实现|线协议' tasks/*.md`、`grep -lF scripts/asr-single-implementation-check tasks/*.md`），命中的任务都不是本机制。前身 `tasks/gap-asr-wire-single-implementation-boundary-probe.md`（`goal_ac: AC-129`，**done**）落的正是这条判据本身 —— 本条不是它的重复，而是它**没有保持绿**的证据：探针落地之后，语音实时模块新增一个文件，探针把它误判成第二份实现。相邻但**机制不同**：`tasks/gap-asr-capability-probe-third-wire.md`（`goal_ac: AC-132`，done）改的是另一支探针 `scripts/asr-capability-check.mjs`；`tasks/gap-voice-client-asr-feasibility-probe.md` 是浏览器 WASM 可行性探针。三条都只在溯源上相关，不构成任何前置。

### 现场：判据今红，而它要断言的保证其实成立

`node scripts/asr-single-implementation-check.mjs` 今天退出 1，两条判词：

```
FAIL paths differ: the consumers resolve to 2 different files: …/shared/asr/transcriptionWire.ts …/src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts
FAIL SECOND_IMPL src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts markers=parsed-text-field
```

这是**本轮的新红，不是旧账**。`.quay/gate-events.jsonl` 里 AC-129 在 2026-10-09T00:47Z / 02:05Z / 04:20Z / 05:38Z 连续四次 `verdict=pass`，07:46:54Z 首次 `fail`；把每个 gate 的 `treeSha` 逐个 `git cat-file -e <treeSha>:src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts` 核对，pass 的四棵树**都不含**该文件，fail 的两棵都含。引入该文件的提交是 `86fd9da5`（2026-10-09T04:49:27Z，"feat(voice-realtime): wire the browser's mic → editable intent → real session_send (AC-312)"）。

**但 AC-129 的保证今天为真。** 三处消费者仍全部解析到唯一一份实现：前端 `src/modules/chat/hooks/useVoiceInput.ts` 与 `src/shared/api.ts` → `@shared/asr/transcriptionWire`；服务端 `server/modules/voice/voice.service.ts` → `../../../shared/asr/transcriptionWire.js`；命令行 `experiments/voice-asr-cli/{transcribe,dryRun,offlineReplay}.ts` → `../../shared/asr/transcriptionWire.js`。仓库里也**没有**第二处构造 multipart、没有第二处解析 HTTP 转写响应（`grep -rn 'audio/transcriptions' src server shared` 的生产命中仍只有实现文件 `shared/asr/transcriptionWire.ts:28`，加两个只记 URL、不发送也不解析的 mention 文件 `shared/asr/asrInvariants.ts`、`shared/asr/asrRegistry.ts`）。

所以红军的是**探针的精度**，不是被断言的行为：`parsed-text-field` 标记把它不该认的东西认成了第二份实现。

### 根因：标记的正则把一个「声明」与一次相隔数行的「赋值」粘成一处

`RESPONSE_MARKERS` 的 `parsed-text-field`（`scripts/asr-single-implementation-check.mjs:102`）：

```
/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]{0,200})?=\s*JSON\.parse\([\s\S]{0,300}?\)[\s\S]{0,200}?\b\1\s*\??\.text\b/
```

`(?::[^=]{0,200})?` 的 `[^=]` **允许 `;` 与换行**，于是类型注解这一段能一路吞到下一个 `=`。把该正则对两个文件实测：

- 真实现 `shared/asr/transcriptionWire.ts:174` 命中 `const parsed = JSON.parse(responseText) as { text?: unknown }; … parsed.text` —— 声明、赋值、读取在同一小段，正确。
- 误报 `src/modules/chat/voice-realtime/useVoiceRealtimeSession.ts:206` 命中 `let frame: ServerFrame; try { frame = JSON.parse(event.data) as ServerFrame; } catch { return; } … frame.text` —— 正则把**声明** `let frame: ServerFrame;` 与相隔数行（跨 `try`/`catch` 与若干 `if`）的**赋值** `frame = JSON.parse(event.data)` 粘成一处，再把 WS 帧的 `frame.text` 当成了转写响应里的 `.text`。

`useVoiceRealtimeSession.ts` 是 `/voice-realtime` **WebSocket** 的客户端（`src/modules/chat/voice-realtime/`）：第 208 行 `JSON.parse(event.data)` 解析的是网关推来的服务端帧 `{ type:'intent', text }`（模型提议的意图文本，第 221 行 `setIntent(frame.text)`），既不是 HTTP `Response` 的体，也不是转写服务的响应包络 —— 与 AC-129 的「线协议」（HTTP multipart 请求 + 转写响应解析）无关。探针自己的注释（:96-105）写着这条标记「不是任何 `.text` 靠近 `JSON.parse`」，本次误报正是那条自划的界线被一次新落地跨过。

### 方案：让响应半标记只认「HTTP 转写响应」的解析，并补一条 WS 帧的正面控制

1. **收窄 `parsed-text-field`**，使它匹配的是**转写响应体**的解析，而不是任意 `JSON.parse` 后读 `.text`。要求的可观测形态由 AC 机械钉住，落点与自由度如下：
   - **绿**：WS 帧解析 —— 含**紧凑写法** `const frame = JSON.parse(event.data) as ServerFrame; … frame.text`（不只是「声明与赋值分离」那一种；只修 `[^=]` 吞换行这一处，对紧凑写法仍会误报，故不足以完成本条）。
   - **红**：真正的响应半复制 —— 带 HTTP 出处的 `const responseText = await response.text(); const parsed = JSON.parse(responseText) as { text?: unknown }; … parsed.text`（即实现文件 lenient 分支逐字，无请求侧）。
   - 建议机制二选一，由实证选定并记入 Evidence：**(a) 出处判定** —— 要求 `JSON.parse` 的操作数来自一次 HTTP `.text()` 读取；**(b) 操作数形态** —— 要求操作数是**裸标识符**而非成员表达式（`event.data` 是成员表达式，`responseText` 是裸标识符）。两条都能同时满足上面的红/绿。
2. **保留全部既有可红性**：per-side 复制 ⇒ `paths differ`；逐字复制 ⇒ `SECOND_IMPL`；只抄 multipart 半 ⇒ `SECOND_IMPL`；空工装根 ⇒ `no implementation`；两个只记 URL 的 mention 文件保持绿。既有 `node --test` 用例与新增控制同跑，全绿。
3. **禁止用「排除路径」买绿**：不得通过改 `PRODUCTION_GLOBS` / `CONSUMER_GROUPS` 把 `src/modules/chat/voice-realtime/**` 排除掉来消除误报（那会让「把真复制放进该目录」瞎掉）。AC4 用一条控制钉住：在工装根的该目录下放一份**完整**的第二实现（请求半 + 响应半），探针必须 `SECOND_IMPL` 红。
4. **不改出货代码**：缺陷在探针，`useVoiceRealtimeSession.ts` 保持原样（AC8 用 git 钉住），不把它的解析改写成「认不出来」的形状来躲标记。

### 边界（不做）

不重写 `CONSUMER_GROUPS` 的三处分组口径；不动 `shared/asr/transcriptionWire.ts`；不做 AC-130 的逐字节基线；不把 `.mjs` 测试接进 scoped 门或 suite（前身已如实登记该 lane 归属，超出本条写入面）。

## AC

- [ ] AC1 `node scripts/asr-single-implementation-check.mjs` 退出码 0；stdout 恰有一条 `implementation path=…/shared/asr/transcriptionWire.ts`（realpath 同）；三组 `consumer=frontend|server|cli` 的 `realpath` 都等于该实现 realpath；含 `SECOND_IMPL none`；且**没有**任何 `implementation` 或 `SECOND_IMPL` 行点名 `useVoiceRealtimeSession.ts`。
- [ ] AC2 紧凑 WS 帧形态为绿（本条核心控制）：`node --test scripts/asr-single-implementation-check.test.mjs` 退出码 0，且其中一条用例在工装根放入一个模仿 `useVoiceRealtimeSession.ts` 的 WebSocket 帧解析文件（形如 `const frame = JSON.parse(event.data) as ServerFrame; … frame.text`，**紧凑声明**，不依赖「声明与赋值分离」），断言未变异工装根为绿、加入该文件后仍绿。
- [ ] AC3 真响应半仍红：同一测试文件内一条用例，把实现的 lenient 响应半（`await response.text()` + `JSON.parse(responseText)` + `.text`）复制成 `src/shared/` 下一份新文件（无请求侧），断言探针非零退出且判词含 `SECOND_IMPL` 与 `parsed-text-field`；移除后工装根恢复绿。
- [ ] AC4 不许靠排除路径买绿：同一测试文件内一条用例，在工装根 `src/modules/chat/voice-realtime/` 下放一份**完整**的第二实现（multipart 构造 + 响应解析），断言探针非零退出且判词含 `SECOND_IMPL`。
- [ ] AC5 既有可红性不变：`node --test scripts/asr-single-implementation-check.test.mjs` 退出码 0，其中既有的 per-side 复制（`paths differ`）、逐字复制（`SECOND_IMPL`）、只抄 multipart（`SECOND_IMPL`）、空工装根（`no implementation`）四条控制仍各判红，两个只记 URL 的 mention 文件仍为绿。
- [ ] AC6 该测试跑的 lane 是绿的：`npm run test:scripts` 退出码 0（`node scripts/list-script-tests.mjs` + `node --test "scripts/**/*.test.mjs"`，这是 `scripts/**/*.test.mjs` 唯一被执行的 lane）。
- [ ] AC7 探针在 lint 面内且不新增红：`npm run lint` 退出码 0。
- [ ] AC8 出货代码未动：`git diff --name-only develop...HEAD` 只含 `scripts/asr-single-implementation-check.mjs`、`scripts/asr-single-implementation-check.test.mjs`、`tasks/gap-asr-wire-probe-ws-frame-false-positive.md`；`git diff --name-only develop...HEAD -- src server shared experiments` 为空。

## DoD

真实落地判据：不是「探针文件改了一行」，而是**判据命令在今天的树上真的绿了，且它对 WS 帧的形状不再误报、同时对真正的第二份转写响应实现仍然必红**。三组正面读数：

(a) **判据本身** —— `node scripts/asr-single-implementation-check.mjs` 退出 0，唯一实现 `shared/asr/transcriptionWire.ts`，三处消费者同路径（AC1）；`.quay/gate-events.jsonl` 里 AC-129 的下一轮 sweep 应因此翻回 `pass`。

(b) **误报已消，且不是靠把标记收窄到「什么都认不出」** —— 紧凑 WS 帧形态绿（AC2），且完整第二实现放进 `voice-realtime/` 目录仍红（AC4）；只修「声明/赋值分离」那一处不算完成，因为紧凑写法仍会误报。

(c) **可红性未被削弱** —— 响应半复制仍 `SECOND_IMPL`（AC3），既有四条取假形态全绿（AC5）。

不证明线上行为 —— 本任务只改探针与其测试，出货代码逐字不动（AC8）。

L_D 该轴仍暗，理由：只修一条判据探针，不新增领域数据能力、没有可读出的领域读数。

L_G 该轴仍暗，理由：目标层判据（换识别服务不改路由与 UI）由 GOAL-008 其余判据承担；本条只承担「实现只有一份、三处同一路径」这条判据的保真。

## Touches

- scripts/asr-single-implementation-check.mjs
- scripts/asr-single-implementation-check.test.mjs
- tasks/gap-asr-wire-probe-ws-frame-false-positive.md
