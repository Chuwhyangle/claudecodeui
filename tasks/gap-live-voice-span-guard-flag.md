---
id: gap-live-voice-span-guard-flag
title: live-voice 用 flag（默认 off）接回被删的补录跨度守卫：VOICE_REALTIME_SPAN_GUARD=on 时把模型漏掉的
  heard 句逐字补在 session_send 前面，供 A/B 实测
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**目标**：把 2026-10-16 删掉的「补录未覆盖句」跨度守卫接回，套在一个默认 off 的部署开关后面，供 A/B 实测——默认行为不变，只有 `VOICE_REALTIME_SPAN_GUARD=on` 才恢复旧守卫。

**为什么现在做**：删除那次的裁定（见下方 dedup）选了「有 response 就只用 response、不补 transcript」，其代价臂在 2026-10-17 现测（journal `764f0c7a`，会话 `a34987d6`「Claude Code 语音输出设计」）完整暴露：continuous 模式 5 句转写、只投 2 句，丢的 3 句正好是两条投递各自的开头（句 1「让我们讨论Live Voice的进一步改进及语音输出。」6.1s；句 3「它应当具有更好的实时性…」23.9s；句 4「另一方面呢…」30.4s；合计约 60s / 全程约 109s）。两个丢失机制：句 1 的 call 被 `turn_detected` 截断、重发只带最新句；句 3/4 模型根本没发 call，只对最后一句发了一次。当前唯一兜底 `MODEL_TEXT_REPLY` 只在模型回文本时触发，欠投递的 `session_send` 不触发，故前面句子静默蒸发。

**机制（不重造测度）**：从 `0b9e9abba^` 原样恢复 `voice-realtime-fragment-coverage.ts`（`selectUncoveredFragments`，相邻字对覆盖率阈值 `COVERED_PAIR_SHARE=0.5`、`MIN_JUDGED_CHARACTERS=5`），在 `sessionSend` 的 continuous-span 分支、空 span 拒绝之后，当 flag on 时把「水印之后、模型话未覆盖的 heard 句」逐字拼到模型 message 前面，同一 `proceedRelay` 送出一条投递（`relayArgs = { ...args, message: joinParts([...left, modelMessage]) }`）。只恢复 `sessionSend` 一处，不碰 `sessionInterrupt` 的 correction 守卫（本次观察的是纯 relay 场景）。

**flag 形态**：`VOICE_REALTIME_SPAN_GUARD=on|off`，默认 `off`（= 现行行为，字节不变）。纯 resolver `resolveVoiceRealtimeSpanGuard(env)`（`on`→true、`off`/未设/空→false、其他拼写→invalid 并报告按 off）+ `describeVoiceRealtimeSpanGuard` 启动行，仿 `resolveVoiceRealtimeMode`；seam 加 `spanGuard?: boolean`（默认 false），由 `server/index.ts` 读 env 传入。读一次/进程，restart 生效。

**已知风险（必须随代码注释写明）**：`on` 时重现 `3d2d3b2c` 的重复投递——模型把 ASR 错听修对了，字对覆盖率 <0.5 ⇒ 判未覆盖 ⇒ 同一段音频两条文本进 CLI，第二条是低保真错听、盖在修正前。这正是 A/B 要观察的那一臂。

**与现行回声守卫兼容**：`proceedRelay` 的 `relayRestatesDelivery` 当初就是针对「投递带出 A B 这种前置补录」写的；补录发生在 `proceedRelay` 之前、回声判定在它之后，顺序正确，不打架。

<!-- dedup-ref -->
**dedup / granularity**：按机制 grep 全库（`span guard` / `补录` / `selectUncoveredFragments` / `fragment-coverage`），唯一同机制任务是 `gap-live-voice-one-text-per-segment-prefer-response`（已 done，即删掉本守卫的那次裁定）；本任务是「加 flag、默认 off、不改默认行为」，机制是开关而非推翻裁定，故独立立案不合并，并 backlink 该 id 作为被本 flag 反转默认的那个裁定。`task-granularity-advice --touches …` 返回 `peers: []` / `mentions: []` ⇒ 无同文件开放任务，不合并。

## AC

- [x] AC1 测度 + resolver + flag 两臂的单测退出 0：`npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test server/modules/voice-realtime/tests/voice-realtime-partial-relay-fragments.test.ts`；该文件新增 `selectUncoveredFragments` 测度用例（夹具逐字含本轮丢失句「让我们讨论Live Voice的进一步改进及语音输出。」与「它应当具有更好的实时性」）+ `resolveVoiceRealtimeSpanGuard` 四读法（`on`/`off`/未设/拼错）。`grep -c "selectUncoveredFragments" server/modules/voice-realtime/tests/voice-realtime-partial-relay-fragments.test.ts` ≥ 1。
- [x] AC2 flag 默认 off = 现行行为：flag-off 的 proxy 用例断言 `session_send` 只送模型自己的话、不产生 `delivered verbatim in front` 日志行（即该文件已 repurposed 的「no prepend」读数保持为 off 臂）。
- [x] AC3 flag on 补录：flag-on 的 proxy 用例断言同一条 `session_send` 投递的 `message` = 未覆盖 heard 句逐字 + 模型话（`joinParts([...left, modelMessage])`），且是**一条** send 不是两条；日志行 `session_send left N heard sentence(s) out` 恰好出现一次。
- [x] AC4 空 span 拒绝在 flag on 下仍成立：flag-on 且 span 内全空 ⇒ `empty-transcript` 拒绝、不注入任何文本（不因 flag 而把空 span 当补录）。
- [x] AC5 判别性（false form）：把守卫短路（如 `if (false && spanGuardEnabled)`）后 AC3 的补录断言**红**；假形态已还原、`git status --porcelain` 干净。
- [x] AC6 编译 + scoped 门 + 无悬空：`npm run typecheck` 退出 0；`bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --import ./scripts/undici-blocked-ports-preload.mjs --test "server/modules/voice-realtime/tests/voice-realtime-partial-relay-fragments.test.ts" "server/modules/voice-realtime/tests/voice-realtime-continuous-empty-guard-span.test.ts"` 退出 0；`grep -rn "fragment-coverage" server/ e2e/` 只命中新模块与其 import（无悬空 import）。

## DoD

真落地 = 同一 scripted 连接各跑一臂、读数可判：flag off 的投递 `message` 逐字等于模型 call 的参数、日志无 `delivered verbatim in front`；flag on 的同一形态投递 `message` = 未覆盖 heard 句 + 模型话、日志出现一次 `session_send left …`，且该形态下空 span 仍被 `empty-transcript` 拒绝（不注入文本）。单测绿是必要条件非充分条件；不许删掉空 span 拒绝来凑「补录」，也不许把 `MODEL_TEXT_REPLY` 兜底一并动掉。默认 off 由 resolver 未设/off 双读法钉住，shipped 行为在未翻 flag 时字节不变。落地后由人 yale 用 `VOICE_REALTIME_SPAN_GUARD=on` 实测一臂、off 实测另一臂（这是任务外的人工体验，不是本任务的 AC）。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/voice-realtime-fragment-coverage.ts
- server/modules/voice-realtime/voice-realtime-span-guard.ts
- server/modules/voice-realtime/index.ts
- server/index.ts
- server/modules/voice-realtime/tests/voice-realtime-partial-relay-fragments.test.ts
- tasks/gap-live-voice-span-guard-flag.md
