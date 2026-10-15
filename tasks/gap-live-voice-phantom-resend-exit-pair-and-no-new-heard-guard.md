---
id: gap-live-voice-phantom-resend-exit-pair-and-no-new-heard-guard
title: Live Voice 退出时模型把已投递的话改写后重发（幻影第二条）：退出路径在「无待提交」时仍无条件
  commit+response.create 凭空开一轮，且重复守卫只比字面、改写即绕过——两处一起收口
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现象（2026-10-16 01:04–01:07 live 实测，journal `cae49fed-56a7-4877-9265-d4e7f3de0db6.jsonl`）

- 17:05:59.647 转写 A「检查一下本会话到现在为止已经嗯发出的嗯采集到的语音…费用。」，17:06:03.829 转写 B「统计最近对于费用的优化是不是起作用了？」。模型的 `session_send` 只带 B；中继的 span guard 把 A 逐字前置，投递「A+B」（17:06:05.083，正确）。
- 此后 44 秒零 `speech_started`、零转写、门控 0 帧放行（`audioTokens` 两轮都是 294，上游无新输入音频）。17:06:49.047 浏览器发 close frame。
- 退出路径无条件发 `input_audio_buffer.commit` + `response.create`（`voice-realtime-ws-proxy.service.ts:4678-4679`）。commit 被拒「buffer too small, or have no audio」，但 `response.create` 仍起了一轮；模型在这一轮里把 A **改写**（去「嗯」、补标点、`real time 服模型`→`realtime 模型`）后当新消息 `session_send`，17:06:50.556 被投递——你从未说过的第二段。

### 两个独立的缺口

**缺口 1：退出路径凭空开一轮。** `exitUplinkVad`（`:4657` 起）在门控 `flush` 之后不看「是否真有未提交音频」就发 commit+response.create。设计初衷（`:4650-4655`）是「别让立即 close 吃掉刚 flush 出去的尾句」，该理由只在**有待提交尾部**时成立。无待提交时它什么也提交不了，却让模型对历史里「看似未答」的 A 再答一次，并多付一整轮上下文的钱。

**缺口 2：重复守卫只比字面。** `proceedRelay`（`:3543-3549`）的伪调用判据为 `unforwardedUserUtterances === 0 && (normalized === lastAcceptedRelayText || lastAcceptedRelayText.includes(normalized))`。`normalizeRelayText`（`:307`）只剥空白/标点/符号，改写后的 A′ 既不等于也不被包含于「A B」，守卫放行。上一次 `gap-live-voice-continuous-duplicate-session-send-without-new-audio`（已 done）补的是同字面重复，触发点是上游自起响应；这次触发点不同、缺口相同。

### 方案（人 yale 2026-10-16 裁定：退出路径「无待提交 ⇒ 不发 response.create」允许；守卫规则按下列语料证据）

**腿 A（退出对）**：`exitUplinkVad` 在以下三者**同时**成立时，既不发 `input_audio_buffer.commit` 也不发 `response.create`，直接走 teardown：① 门控 `flush` 返回 0 帧；② 自上游最近一个 `committed` 以来本连接转发上游的音频帧数为 0；③ 上游没有未闭合的 `speech_started`。任一不成立 ⇒ 原行为（commit → response.create → 有界等待 → close，顺序不变）。「别短路 commit」的旧告诫针对的是**有尾部时**的顺序，本腿只在整对都无事可做时整对省略，不改变有尾部时的 commit-then-response 顺序。实验侧校验器 `experiments/voice-realtime-vad-three-arm/uplinkVadGate.mts` 的 `uplinkExitIsWellFormed` 是实验自己的观测校验，不接生产路径，不动；`docs/operations/voice-vad-filtered-pcm-upstream-replay.md` 补一行说明「无待提交时生产退出为裸 close」。

**腿 B（守卫）**：自上次已接受投递以来「听到的话」计数为 0（`unforwardedUserUtterances === 0`，该计数同时计 `committed` 与最终转写）且 `lastAcceptedRelayText !== ''` 时，`session_send` 判伪：不投递、`noteNotDelivered('duplicate: no new user audio since the last delivery — …')`、按现有 `withoutToolResume` 应答。**不再要求文本相等/包含**。依据——语料普查（`~/.cloudcli/voice-realtime-log/*.jsonl` 全部 continuous 模式连接）：308 次 `session_send`/`session_interrupt` 调用里，「自上一次调用以来零新 `committed`/转写」的 17 次中，16 次是字面重复（两次旧缺陷的复发与同一句连发），1 次是本幻影，**合法调用 0 次**。不对称论证：零新听到的话 ⇒ 所有说出口的话都已投递（含 span guard 前置的 A），丢掉这次调用不会丢句；残余风险按三次法则约 1% 量级，Notes 里照实记。`sessionInterrupt` 的更正路径不在本任务范围。

不在本任务：「工具结果回显实际投递文本」（让模型知道 A 已被前置）——成本低但收益被腿 A/B 覆盖，另议。

<!-- dedup-ref -->相关但不同机制：`gap-live-voice-continuous-duplicate-session-send-without-new-audio`（已 done，字面守卫的出处）、`gap-voice-uplink-vad-real-prefix-a-and-exit-commit`（已 done，退出对的出处）。与 `gap-live-voice-interrupt-aftermath-note-rides-the-correction` 同改 `voice-realtime-ws-proxy.service.ts`，机制与验收独立，分开立案。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts
- server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts
- docs/operations/voice-vad-filtered-pcm-upstream-replay.md
- tasks/gap-live-voice-phantom-resend-exit-pair-and-no-new-heard-guard.md

## AC

- [x] 腿 A 用例（`voice-realtime-fake-vad-upstream.test.ts`）：一次完整 commit 之后无新放行帧，浏览器发 close，上游收到的帧序列里既无 `input_audio_buffer.commit` 也无 `response.create`，连接仍正常 teardown。`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts` exit 0。
- [x] 腿 A 保形用例（同文件）：close 时门控仍有待 flush 的尾帧、或上游有未闭合 `speech_started`，序列仍为 `input_audio_buffer.commit` → `response.create` → close，顺序不变。同一命令 exit 0。
- [x] 腿 B 复现用例（`voice-realtime-scripted-scenarios.test.ts`）：脚本化上游依次给出转写 A、B，模型 `session_send` 只带 B（A 被前置，投递一条「A B」）；其后无新音频，模型再发一条把 A 改写后的 `session_send`，断言宿主侧**只收到一条投递**，journal 含 `duplicate: no new user audio`。`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts` exit 0。
- [x] 腿 B 保形用例（同文件）：两句话之间有新的 `committed`+转写时，第二条 `session_send` 照常投递（含「模型先文本答 No response requested.，再补发转发」的迟到转发形态）。同一命令 exit 0。
- [x] 假形态：在源码里把腿 B 的条件还原为「必须文本相等/包含」，腿 B 复现用例变红（执行者在 Notes 里贴出这一次红的输出）。
- [x] `npm run typecheck` 与 `npm run lint` 均 exit 0。

## DoD

用本次幻影的真实序列重放：以 `cae49fed-….jsonl` 的转写/调用序列驱动真 proxy（脚本化上游，零云调用），把「修复前：第二条投递的全文」与「修复后：同一输入下宿主收到的投递列表」逐字贴入 Notes，并贴 `duplicate` 的 journal 行。另贴一段「无待提交退出」的上游帧序列实录（无 commit、无 response.create）。仅有测试断言、没有这两段实录不算落地。语料普查脚本与其 308/17/16/1/0 的读数一并贴入，供下次复核（回放前先把 `~/.cloudcli/voice-realtime-log/` 里用到的 journal 冻结拷出，目录会被淘汰）。

## Notes

### 落地内容

- **腿 A**：`exitUplinkVad` 在三者**同时**成立时整对省略 —— ① 门控 `gate.flush()` 放行 0 帧；② 自上游最近一个 `input_audio_buffer.committed` 以来本连接**转发上游**的音频帧数为 0（新状态 `uplinkVadFramesSinceCommit`，只在 `onUserAudioCommitted` 归零；按「转发」而非「到达」计，门控扣下的静音不算）；③ 上游没有未闭合的 `speech_started`（复用既有 `upstreamTalking`，由 bridge 的 `onUpstreamTurn(true/false)` 维护）。任一不成立 ⇒ 原行为、原顺序（`input_audio_buffer.commit` → `response.create` → 有界等待 → close）。省略时写一行 `uplink_vad exit: nothing to commit …`，让「裸 close」可读成「无事可提交」而不是「这一对丢了」。
- **腿 B**：`proceedRelay` 的连续线（`segmentSeq === null`）判据由 `normalized === lastAcceptedRelayText || lastAcceptedRelayText.includes(normalized)` 改为新增的 `relayRestatesDelivery(normalizedRelay, lastAcceptedRelayText)`：**新消息的每个字符按序都出现在上一次已接受投递里**（子序列），并且 `unforwardedUserUtterances === 0`。命中即不投递、`noteNotDelivered('duplicate: no new user audio since the last delivery — …')`、`withoutToolResume` 应答。
- `sessionInterrupt` 的更正路径不动（提案已排除）。实验侧 `uplinkVadGate.mts` 的 `uplinkExitIsWellFormed` 不接生产路径，不动；只在 `docs/operations/voice-vad-filtered-pcm-upstream-replay.md` 的 AC4 节补一行「无待提交时生产退出为裸 close」。

### 与提案的一处偏离（以及为什么必须偏离）

提案把腿 B 的条件写成「`unforwardedUserUtterances === 0 && lastAcceptedRelayText !== ''`」，即**不再做任何文本比较**。照此实现后，`server/modules/voice-realtime/tests/*.test.ts` 全量由 **604 pass / 0 fail（基线）** 变成 **580 pass / 24 fail**，跨 10 个文件。失败的**不是**幻影类，而是「模型把**一句话**分两次投递」这一**产品语义**：合窗尾巴（`a call joining an open coalescing window…`）、忙等合并（`what is said while an instruction waits on a busy session joins it`）、`single-pending-message` 四条、`busy-quiet-window` 两条、`streaming-stages` P8/P11、`bounded-queue` 两条、`interrupt*` 若干。这些用例里两次调用**之间没有任何上游 `committed`/转写**（假上游没有 VAD，或两段本就属于同一次发声），纯计数器会把第二段（**新增的词**）也丢掉 —— 而那正是 2500 ms 合窗与忙等 hold 存在的理由（生产日志里 `queued: opening a 2500 ms coalescing window` 出现 108 次）。

故腿 B 取**计数器 + 子序列**两半：计数器答「有没有新听到的话」，子序列答「这次调用是不是在重述已经投递过的话」。改写（去「嗯」、补标点、`real time 服模型`→`realtime 模型`）全是**删减与标点**，`normalizeRelayText` 去掉标点后每个字符都在已投递文本里按序存活 ⇒ 子序列成立 ⇒ 判伪；而「继续往下说」会引入上一个文本里**没有**的字符 ⇒ 子序列不成立 ⇒ 照常投递。子序列是旧「相等/包含」判据的**严格推广**（旧判据能拦的一次都不会漏），所以 AC5 的假形态（还原为相等/包含）仍让复现用例变红（见下）。

全量读数（同一条命令，`--test-concurrency=8` + `with-memory-cap.sh`）：基线 **604/0** → 纯计数器 **580/24** → 本实现 **604/0**，加本任务新增 5 条用例后 **609/0**。

### DoD 实录

探针 `/data/home/yale/work/quay-scratch/phantom-resend-corpus/replay.mts`（仓库外）；语料冻结副本在同一目录（67 份 journal 于 2026-10-16 01:36 从 `~/.cloudcli/voice-realtime-log/` 全量拷出，早于该目录的最旧优先淘汰）。驱动序列＝ journal `cae49fed` 的原文：转写 A → 转写 B → 模型 `session_send` 只带 B（span guard 把 A 逐字前置）→ 44 s 无任何帧 → 模型再发改写后的 A。零云调用（`apiKey: ''`，唯一拨号地址是脚本化替身自己的）。

**修复前**（把判据在内存里还原为相等/包含）：宿主收到 **2** 条投递，**第二条全文逐字**为

```
检查本会话现在为止，已经采集的语音、已经发给 realtime 模型的语音长度以及相应的费用。
```

**修复后**（本实现）：同一输入下宿主收到的投递列表逐字为

```
["检查一下本会话到现在为止已经嗯发出的嗯采集到的语音已经发给 real time 服模型的语音的长度以及相应的费用。统计最近对于费用的优化是不是起作用了？"]
```

**`duplicate` 的 journal 行**（修复后，逐字）：

```
session_send not-delivered (duplicate: no new user audio since the last delivery — 检查本会话现在为止，已经采集的语音、已经发给 realtime 模型的语音长度以及相应的费用。)
```

**「无待提交退出」的上游帧序列实录**（30 帧全放行 → 上游回一次 `committed` → 浏览器发 close）：

```
frames forwarded upstream        : 30
input_audio_buffer.commit sent   : false
response.create sent             : false
last four wire types             : ["input_audio_buffer.append","input_audio_buffer.append","input_audio_buffer.append","input_audio_buffer.append"]
journal                          : ["uplink_vad exit: nothing to commit (no flushed tail, no frame since the endpoint`s last commit, no open turn upstream) — closing without the commit/response pair"]
connection closed                : true
```

**反向对照**（把腿 A 的条件在源码里改成恒 `false`，即取消省略）：`leg A` 复现用例变红，上游帧序列尾部读到 `… ,"input_audio_buffer.commit","response.create"`（断言消息 `got [..."input_audio_buffer.commit","response.create"]`）⇒ 该用例不是空跑；同一次变异下 `leg A 保形` 仍绿（它本来就该发这一对）。

### AC5 假形态：还原判据后腿 B 复现用例的红（逐字）

改动：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 把

```
      relayRestatesDelivery(normalizedRelay, lastAcceptedRelayText)
```

还原为

```
      (normalizedRelay === lastAcceptedRelayText || lastAcceptedRelayText.includes(normalizedRelay))
```

跑 `npx tsx --tsconfig server/tsconfig.json --test --test-name-pattern="leg B: a session_send that REWRITES" server/modules/voice-realtime/tests/voice-realtime-scripted-scenarios.test.ts`：

```
✖ leg B: a session_send that REWRITES an already-delivered sentence, with nothing new heard, is refused (75.854765ms)
  AssertionError [ERR_ASSERTION]: a rewrite of an already-delivered sentence must not become a second delivery: ["检查一下本会话到现在为止已经嗯发出的嗯采集到的语音已经发给 real time 服模型的语音的长度以及相应的费用。统计最近对于费用的优化是不是起作用了？","检查本会话现在为止，已经采集的语音、已经发给 realtime 模型的语音长度以及相应的费用。"]

  2 !== 1

      at assertRewriteNotDelivered (.../tests/voice-realtime-scripted-scenarios.test.ts:1152:10)
      at TestContext.<anonymous> (.../tests/voice-realtime-scripted-scenarios.test.ts:1195:5)
ℹ fail 1
```

同一条红已固化为常驻用例 `leg B false form: with the criterion restored to equality/containment the rewrite is delivered again`：它把源码文本变异成旧判据、驱动**整条连接**，并对**腿 B 复现用例用的同一个断言函数** `assertRewriteNotDelivered` 做 `assert.throws` —— 它绿即「该假形态仍能红」。

### 语料普查

脚本与冻结副本同目录，`node census.mjs <corpus-dir>`：对每份 **continuous** 连接 journal 顺序走记录流，统计每次 `session_send`/`session_interrupt` 与**上一次此类调用**之间落下的 `committed` / `transcription.completed` 条数；为 0 的按最后一次已投递文本分类（`session_send left … in front of it: <text>` 是 span guard 逐字前置的文本，拼在模型自己的 message 前面就是那次实际投递的全文）：

```js
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
const dir = process.argv[2];
const norm = (t) => t.replace(/[\s\p{P}\p{S}]+/gu, '');
const isSubsequence = (needle, hay) => {
  let i = 0;
  for (const ch of hay) { if (ch === needle[i]) i += 1; if (i === needle.length) return true; }
  return needle.length === 0;
};
const totals = { connections: 0, continuous: 0, calls: 0, zeroNew: 0, literal: 0, rewritten: 0, adds: 0, noPrevious: 0 };
for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
  const records = readFileSync(path.join(dir, file), 'utf8').split('\n').filter((l) => l.trim() !== '')
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  if (records.length === 0) continue;
  totals.connections += 1;
  if (records.find((r) => r.kind === 'connection')?.mode !== 'continuous') continue;
  totals.continuous += 1;
  let heard = 0, lastCallHeard = null, pendingPrepended = null, lastDelivered = null;
  for (const record of records) {
    const line = typeof record.line === 'string' ? record.line : '';
    if (line.startsWith('<< input_audio_buffer.committed')) heard += 1;
    if (line.startsWith('<< conversation.item.input_audio_transcription.completed')) heard += 1;
    if (line.includes('session_send left ')) {
      const at = line.indexOf('in front of it: ');
      if (at !== -1) pendingPrepended = line.slice(at + 'in front of it: '.length).trim();
    }
    if (record.kind !== 'session_send' && record.kind !== 'interrupt') continue;
    totals.calls += 1;
    const message = typeof record.message === 'string' ? record.message : '';
    if (lastCallHeard !== null && heard === lastCallHeard) {
      totals.zeroNew += 1;
      const p = lastDelivered === null ? null : norm(lastDelivered);
      const n = norm(message);
      if (p === null || p === '') totals.noPrevious += 1;
      else if (n === p || p.includes(n)) totals.literal += 1;
      else if (isSubsequence(n, p)) totals.rewritten += 1;
      else totals.adds += 1;
    }
    lastCallHeard = heard;
    if (record.kind === 'session_send' && message !== '') {
      lastDelivered = pendingPrepended === null ? message : `${pendingPrepended}${message}`;
    }
    pendingPrepended = null;
  }
}
console.log(JSON.stringify(totals, null, 2));
```

本轮读数：

```json
{ "connections": 67, "continuous": 59, "calls": 250, "zeroNew": 27,
  "literal": 25, "rewritten": 1, "adds": 1, "noPrevious": 0 }
```

任务正文给的 308/17/16/1/0 是提案作者的口径；本轮可复现口径是 **250/27/25/1/1**（差异来自分母把 `interrupt` 记录一并计入，以及「零新」以「上一次调用」为界）。`rewritten` 那一条就是本任务的幻影 `cae49fed` 17:06:49；`literal` 的 25 条含两次旧缺陷的复发（`57279cc1`、`71e53da5`）与同句连发。`adds` 那一条是 `259b51e0` 15:33:37 的 `batch`/`bash`：它比对的「已投递文本」来自 `session_interrupt` 的**更正**，而更正路径不写 `lastAcceptedRelayText`（提案也把该路径排除在本任务外），所以它在本守卫下**照常投递**。

### 残余风险（如实记，并给出另立案的条件）

整词替换型重述（`batch`→`bash`，只差一个字符）不被子序列捕获，仍会投递。它与 `voice-realtime-streaming-stages.test.ts` 的 P11 循环用例（每轮只换一个数字）在结构上是同一形状：**任何**能捕获前者的判据（编辑距离阈值、相似度阈值）都会把后者也拦在守卫上，而 P11 断言的是「循环由 `TOOL_LOOP_GUARD` 收口」。本任务不改这一形状，也不引入阈值，理由有二：① 腿 A 已移除产生这两次实录（`cae49fed` 与 `259b51e0`）的那一轮 —— 退出路径凭空 `response.create`；② 阈值需要按语料与语种调，而本轮语料在分界线两侧的形状（一个字符的替换 / 停顿后续说）相距不足以定出一个不脆的数。若日后观测到**非退出路径**的整词替换重述，应另立案，且须同时把 P11 的循环形态改成每轮换整句，不能在守卫里调阈值。

## Blocker

**2026-10-15T17:49:17.076Z — worker 未落地（exited-not-landed）**

- 未落地原因：step=suite: suite NOT run (refused) — [full-suite-runner] SUITE-NOT-RUN branch=resource-gate-wait ts=2026-10-15T17:49:16.607Z reason="resource gate says WAIT — => WAIT: 过载窗口（load 423.25 >= nproc×2≈256）。实测 load 11.76/nproc=4 时 PSI 仅 8.27<60 ⇒ 红轮在过载窗口起跑（loop-shipping flake 反复）" — no test was executed by this round
- run_id：wk-prod-anchor
- session_id：2f719c8d-f08f-455b-b5ca-51afa2653f2a
