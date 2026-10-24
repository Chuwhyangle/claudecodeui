---
id: context-event-stream-and-shadow-predictor
title: P1 地基：主机级上下文事件流写入（CloudCLI 侧）+ 影子预测器 + 按类别命中率表
status: ready
labels:
  - context
  - delegation
  - contract
parent: null
children: []
extra: {}
---
## Proposal

决策出处：`docs/proposals/context-layers-and-delegation-ladder.md` 的 P1「地基」，用户 2026-10-24 确认立项。格式已与 quay-fleet 会话对齐，fleet 侧任务是 `fleet-context-event-stream-schema-and-read-port`，负责 schema、读口、contracts、保留期清理，以及「不外泄」不变式。

目标：建立唯一的事实来源，也就是主机级的统一交互事件流。在它之上跑一个**影子预测器**：只预测、只记录，不展示也不打扰。按操作类别产出命中率表，这就是委托阶梯的第一份证据。本任务不改变用户的任何操作体验。

**格式（已对齐，v0）**：
- 目录 `~/.quay-fleet/context/events/<YYYY-MM-DD>.jsonl`，只追加。每行是 `{v:0, id:<ulid>, at:<ISO>, source:"cloudcli", kind, project?:<fleet registry id>, session?:<cloudcli session id>, refs?:[uri], data:{…}}`。
- 唯一 schema 是 fleet 的 `config/context-event.schema.v0.json`，从已安装的 fleet release 读取，位置与 CLI 定位器解析到的安装一致。每个 kind 只有一个指定的生产方。
- 写入纪律：先在内存里把整行 JSON 组好，再用 O_APPEND 一次 `write(2)` 写入。单行 ≤ 16 KB，超长的文本字段截断并标记 `truncated: true`。不做逐事件 fsync。90 天的清理由 fleet 负责，CloudCLI 不删除任何文件。

**CloudCLI 负责的 kind**：`utterance`、`chip.shown`、`chip.picked`、`chip.redrawn`、`focus`、`reference.resolved`、`send.previewed`、`send.confirmed`、`send.cancelled`、`build.completed`、`service.restarted`、`correction`、`shadow.prediction`、`shadow.prediction.outcome`。（`task.status`、`fanin.*` 由 fleet 产出。）

方案：
1. **事件写入器**（新后端模块 `server/modules/context-events/`，遵循 backend-module-standards；新模块目录按 AC-394 棘轮的要求同时登记到 manifest 和 `MANIFEST_PIN`）：
   - `appendContextEvent(event)` 写入前按 schema 校验。
   - schema 不可用（fleet 未安装、或安装的版本还没有 schema）时，写入器进入 `disabled: schema-unavailable` 状态，不写任何文件，也不抛错。
   - 状态通过 `fleet-summary` 旁边的一个读数透出。
2. **接入生产点**（各处都只加一行调用，失败不影响主流程）：
   - 用户发送消息 → `utterance`（文本、来源是打字 / 语音 / chip、会话、项目）；
   - 回复建议用量日志的 shown / picked / redrawn / cleared 事件 → 对应的 `chip.*`（`reply-suggestions-usage.jsonl` 保持原样不动）；
   - 驾驶舱中枢的焦点变化、指代解析、发送预览 / 确认 / 取消 → `focus`、`reference.resolved`、`send.*`；
   - 构建和重启的回调接缝（由部署就绪任务引入；还不存在时就跳过）→ `build.completed`、`service.restarted`。
3. **话语粗分类器**（纯函数）：首版是规则分类，类别取探针里的 10 类：立任务、构建/重启、落地/可用核验、检查进展、浏览器验证、发布、同意/推进、会话协作、诊断、讨论/其他。分类结果写进 `utterance.data.class`。
4. **影子预测器**：
   - 每条 `utterance` 写入后，根据同一会话的上一类别，用转移计数预测下一条话语的类别，写一条 `shadow.prediction`（`{class, confidence, method:"transition-v0", basis}`）。转移计数从事件流和历史转写中统计，冷启动可以从会话转写回填（按用户消息的时间顺序统计相邻类别的转移）。
   - 同一会话的下一条 `utterance` 到来时，写 `shadow.prediction.outcome`（`{predictionId, actualClass, hit}`）。
   - 预测结果不出现在任何界面上。
5. **命中率表**：`scripts/shadow-prediction-report.mjs`（同时提供 `--json`）读取事件流，按类别输出样本数、命中率、置信度分桶的校准情况（每个置信区间的实际命中率），以及每个类别目前所在的阶梯级别（首版写死为「你自己做」或「系统建议」，作为基线）。

## AC

- [x] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/context-events/tests/context-event-writer.test.ts` exit 0——在临时 HOME 和夹具 schema 下：合法事件追加成一行，内容可以解析；不合法的事件被拒绝且不写入；超过 16 KB 的文本被截断并带 `truncated: true`；schema 文件缺失时状态为 `schema-unavailable`，且 0 次写入；并发 50 次追加后，行数恰好为 50 且每行都能解析。
- [x] AC2: `npx tsx --tsconfig server/tsconfig.json --test server/modules/context-events/tests/utterance-classifier.test.ts` exit 0——10 个类别各有至少 2 条正例，以及若干落入「讨论/其他」的反例；例句直接写在测试夹具里（可取材自用户真实话语，如「检查进展。」「建 A、B、C 三个修复任务」「Build + 安全重启。」「检查是否已经落地可用」「用 MCP 浏览器访问……截图」）。
- [x] AC3: `npx tsx --tsconfig server/tsconfig.json --test server/modules/context-events/tests/shadow-predictor.test.ts` exit 0——给定转移计数，预测输出概率最高的类别及其置信度；下一条话语到来后恰好产生一条 outcome，hit 判定正确；会话之间互不串扰；预测器在界面层不可见（不经过任何 websocket 帧）。
- [x] AC4: `node --test scripts/shadow-prediction-report.test.mjs` exit 0——夹具事件流产出的按类别命中率与校准分桶，与手算结果一致；坏行被跳过并计数。
- [x] AC5: 各生产点接入的单测：发送一条消息恰好产生 1 条 `utterance`；chip 的 picked 恰好产生 1 条 `chip.picked`；写入器抛错时发送流程照常完成。`npm run typecheck` 通过。

## DoD

- 在隔离实例（复制的数据库、关闭 residentRestore、临时 HOME 指向夹具 fleet 安装）上实际走一遍：发几条消息、点一次 chip，读回事件文件内容和预测、outcome 的成对记录，贴出来。
- 用历史转写回填后跑一次命中率报告，贴出按类别的表格，并与探针结论对照（单步命中率约 20–30%）。
- 线上 :3001 上的真实写入要等 fleet 的 schema 发布并安装后才会发生；届时由会话或用户读回当天事件文件的前几行，确认 source、kind 和单行格式（待外部）

## Notes

- `utterance` 会保存用户的原话，只留在本机。fleet 侧用不变式加负控夹具保证：通知 / outbox 的读取集合永远不包含 `context/`。
- 本任务不做任何晋级，也不做任何界面展示；阶梯的晋级提议在后续阶段实现。

## Touches

- server/modules/context-events/index.ts (new)
- server/modules/context-events/context-events.module.ts (new)
- server/modules/context-events/context-event-writer.ts (new)
- server/modules/context-events/utterance-classifier.ts (new)
- server/modules/context-events/shadow-predictor.ts (new)
- server/modules/context-events/tests/context-event-writer.test.ts (new)
- server/modules/context-events/tests/utterance-classifier.test.ts (new)
- server/modules/context-events/tests/shadow-predictor.test.ts (new)
- server/modules/context-events/tests/production-wiring.test.ts (new)
- server/modules/websocket/services/chat-control.service.ts
- server/modules/reply-suggestions/reply-suggestions-usage-log.ts
- server/modules/reply-suggestions/index.ts
- server/modules/cockpit/cockpit-hub.service.ts
- server/modules/quay/quay.service.ts
- server/modules/quay/quay.module.ts
- server/index.ts
- server/shared/tests/server-import-cycle-budget.test.ts
- server/shared/tests/server-import-cycle-budget.baseline.json
- server/shared/tests/quay-test-script.test.ts
- scripts/shadow-prediction-report.mjs (new)
- scripts/shadow-prediction-report.test.mjs (new)
- scripts/suite-duration-baseline.tsv
- tasks/context-event-stream-and-shadow-predictor.md
