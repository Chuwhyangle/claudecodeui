---
id: gap-continuous-experience-settle-window-mid-utterance
title: AC-361 再红：settle 生产者在人说话中途用 2.5s 窗投递 U2+U3 并重复 U3——settle
  边界须等上游回合关闭，恢复连续体验 e2e 全绿
status: done
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-361
---
## Proposal

### 现状（2026-10-18 判据直接重跑，确定性复现）

`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 在当前树红：首个失败在 `e2e/voice-realtime-continuous-experience.spec.ts:1232`（`test.describe.configure({ mode: 'serial' })`，后续用例未运行）：

```
Error: a silent utterance must be carried by no row: [..., {"style":"user","testid":null,"text":"嗯…那个… 我想想我想想然后跑一下测试"}, ...]
Expected: []
Received: [{"style":"user","testid":null,"text":"嗯…那个… 我想想我想想然后跑一下测试"}]
```

L1 半边是绿的：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts` → 15 pass / 0 fail / exit 0。

失败 run 的 gate evidence：`2026-10-17T18:54:21.499Z`，`acceptance failed (exit 1)`。

### 成因（读失败 run 的 journal，逐帧）

失败 run 的 journal（`~/.cache/quay-e2e-tmp/quay-e2e-ZcCSrH/voice-realtime-log/67374906-*.jsonl`）：

```
12.745  settle: no model response covered 2 heard item(s); delivering them verbatim
12.944  << input_audio_buffer.speech_stopped        (U4「然后跑一下测试」)
12.944  << transcription.completed "然后跑一下测试"
12.945  << function_call session_send {"message":"我想想然后跑一下测试"}
13.946  coalesced 2 relayed piece(s) into one message
13.948  session_send delivered ... message="嗯…那个… 我想想我想想然后跑一下测试"
```

- settle 窗是 `VOICE_SPAN_SETTLE_MS = 2500`（`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:421`），由每次 final 重新起表（`armSettleWindow`，同文件 `:4166`）。U3（「我想想」）的 final 在 10.245，表在 12.745 到期；U4 的 final 在 12.944、模型合并 response 紧随其后 1 ms 到达——settle 只赢了 199 ms。
- `settleHeardSpan`（同文件 `:4131`）只读「静音时长」，不读「上游回合是否仍开着」。U4 的 `speech_started` 早已到达，产品已在 `onUpstreamTurn` 里把它记成 `upstreamTalking = true`（同文件 `:3480` / `:4722`），但 settle 在 U4 说到一半时就把 U2+U3 逐字投递了。
- 随后的模型 response 又携带 U3（`wait` 策略的合并语义），与刚投递的逐字 span 落进同一个 1 s 合并窗（`coalesceMs`），`joinParts` 拼成 `嗯…那个… 我想想我想想然后跑一下测试`：未转发的 U2 被投递，U3 在同一句里出现两次。

### 前次修复为何没有保住

`gap-live-voice-stream-delivery-not-command`（done，2026-10-17，提交 `f06cf3ce1`）把投递裁判从模型改成确定性 settle 边界（R2）。它的 Touches 没有 `e2e/voice-realtime-continuous-experience.spec.ts`，因此 AC-361 的判据从未在新生产者上重跑；本 spec 仍按「模型不转发 ⇒ 无行 / 等待后合并 ⇒ 一条消息」的旧读数断言。R2/R3 本身没有被推翻——缺的是 settle 边界与「人还在说」之间的门：新生产者在**上游回合仍打开**时结算了 span，抢走了本该由模型合并 response 覆盖的质量臂。

### 要做的事

1. **settle 边界不得在人说话中途关闭**：`settleHeardSpan`（或 `armSettleWindow` 的到期回调）读产品已有的 `upstreamTalking`（`voice-realtime-ws-proxy.service.ts:3480`；由 bridge 的 `speech_started` / `speech_stopped` / `committed` 驱动）。回合仍开着 ⇒ 重新 arm，不投递；回合关闭后 2.5 s 内无模型 response 才走确定性逐字臂。这与同一文件里忙时静窗的既有规则同源（`:3544` 的 `return !upstreamTalking && …`）。
2. **覆盖判据**：在 `server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` 的 settle 段新增回归用例：
   - final 到达、settle 窗到期时上游回合仍开着（`speech_started` 后未 `speech_stopped` / `committed`）⇒ 不投递；
   - 回合关闭后窗到期 ⇒ 逐字投递一次；
   - 窗内模型 response 到达 ⇒ 用 response，span 不再逐字补发。
3. **恢复 AC-361 判据**：单测 + e2e 两边 exit 0；e2e 的 X-1..X-7 读数表恢复（U2 无行、U3+U4 一条合并消息、U5 一条）。**不得削弱断言**：不加 `expectKnownDefect` / `test.fail` / skip，不删「每句一个可见处置、静默丢失 = 0」的腿。若产品语义确有合法变化导致某腿必须改，先按当前读数写进 `## Notes` 并 park，不得直接放宽。
4. 若 guard 会破坏 R2 的「未回答 span 必须投递」，用 protocol-simulation 里已有的 `764f0c7a` 回放证明：回合关闭后仍会逐字投递。

## Plan

1. 复现：跑 e2e 取首个失败行；跑 protocol-simulation 既有 settle 用例。
2. 先写红：新增「上游回合开着时 settle 窗到期不投递」用例，在未修树上红，记录逐字失败行。
3. 实现 `upstreamTalking` guard（最小改动，只动 settle 路径）。
4. 单测 + e2e 全绿；三次运行 + `QUAY_CONTINUOUS_EXPERIENCE_DUMP` 归一化读数比对；假形态（去掉 guard 行）重跑新用例应红。
5. 跑 typecheck / lint；把读数写 `## Notes`。

## AC

- [x] AC1（假形态排最前）：新增的「上游回合开着的 settle 窗到期不投递」用例在**去掉 guard 行**的树上红（逐字失败行记入 `## Notes`），恢复 guard 后绿；同一次假形态下 e2e 的 X-1 读出 U2 行与 U3 重复（登记一次读数）。
- [x] AC2：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts` 退出 0，且包含新用例。
- [x] AC3：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-fake-vad-upstream.test.ts` 退出 0（L1 半边）。
- [x] AC4：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` 退出 0，11 个用例全部运行（无 did not run / skipped）。
- [x] AC5：X-1/X-2 读数成立且为直接断言：`grep -n "a silent utterance must be carried by no row" e2e/voice-realtime-continuous-experience.spec.ts` 命中，其后仍是 `toEqual([])`（无包装）；`grep -n "the merged delivery must be visible as delivered" e2e/voice-realtime-continuous-experience.spec.ts` 命中且为直接断言；e2e 绿即两者成立。journal 里没有一条 delivered message 的 `message` 字段把同一句文本包含两次（机械核对并记 `## Notes`）。
- [x] AC6：同一种子连续 3 次运行，`QUAY_CONTINUOUS_EXPERIENCE_DUMP` 归一化读数一致（沿用上一任务的归一集；sha256 记 `## Notes`），零外联读数 `dials:1, blocked:false`。
- [x] AC7：`npm run typecheck`、`npm run lint` 退出 0；`npx oxlint e2e/voice-realtime-continuous-experience.spec.ts` 退出 0。
- [x] AC8：spec 未被削弱：`grep -c "expectKnownDefect\|test\.fail\|test\.skip\|fixme" e2e/voice-realtime-continuous-experience.spec.ts` = 0，用例数仍为 11。

## DoD

产品端真实落地：真实 e2e（真浏览器 fake mic → 真 proxy/bridge → 脚本化声学上游）下，「人还在说话时 settle 不结算」这条规则**在运行中被执行**——journal 显示 settle 不在 U4 说到一半时投递，模型的合并 response 到达后只交付一条 `我想想然后跑一下测试`，U2 不被补发；同一规则在 protocol-simulation 单测里可被假形态证伪。AC-361 判据（单测 + e2e）重新为真，三次读数一致；不削弱任何既有断言，不放宽 X-1 / X-2 / X-4。

## Touches

- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts
- server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts
- e2e/voice-realtime-continuous-experience.spec.ts
- tasks/gap-continuous-experience-settle-window-mid-utterance.md

## Notes

立案：gap 轮 2026-10-18。GOAL-044 / AC-361 在 GOAL achieved 后离开 reverify scope，判据重跑为 fail（evidence `2026-10-17T18:54:21.499Z`，exit 1）。复现命令与 journal 行见 Proposal；L1 单测 15/15 绿。worker 须先读 `.agents/skills/backend-module-standards/SKILL.md`（AGENTS.md 对 `server/` 改动的硬要求）。

<!-- dedup-ref --> 机制去重：`gap-live-voice-stream-delivery-not-command`（done，settle 生产者落地，本次红的前置变更）；`gap-live-voice-continuous-experience-spec-realign-after-watermark` / `...-after-caption-row-drop` / `...-after-ac355`（均 done，历史 spec 重锚；本次不是投影重锚，而是 settle 生产者与「回合开着」的边界缺失，故立新任务）。merge-candidate：`task-granularity-advice.js --touches server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts --touches server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts --touches e2e/voice-realtime-continuous-experience.spec.ts --json` → `peers: []`、`mentions: []`，无同文件在飞任务，**separate**。

### 落地读数（2026-10-18，worktree `task/gap-continuous-experience-settle-window-mid-utterance`，提交 `e602e1760`）

- **修复**：`settleHeardSpan` 在 `upstreamTalking` 为真时重新 arm、不投递；`onUpstreamTurn(false)` 在回合关闭时把窗口从关闭那一刻重新计时。另加一条同源修复：模型 `session_interrupt` 是同一窗口里的 response（R2 质量臂）——成功执行后 `clearSettleWindow()` 并推进 watermark。没有这一条时，U5（final `19:02:05.781`，2 ms 后的 stop 只带 `intent`、不带 `message`）的窗口一直开着，settle 在 stop 之后 2.5 s 才投递 U5，X-2 / X-5 红——这是被 X-1 首个红遮住的、同一生产者的第二处红（serial spec：首个红中止后续用例）。
- **AC1 假形态（先红，已恢复）**：删掉 `settleHeardSpan` 的 `if (upstreamTalking) { armSettleWindow(); return; }` 后，`--test-name-pattern="settle boundary"` 红在 `voice-realtime-ws-proxy.protocol-simulation.test.ts:895`：`actual ['嗯…那个… 我想想'] / expected []`。同一次假形态下 e2e X-1 红在 `e2e/voice-realtime-continuous-experience.spec.ts:1235`，实际 rows 含 `{"style":"user","testid":null,"text":"嗯…那个… 我想想我想想然后跑一下测试"}`（U2 行 + U3 重复），dump `QUAY_CONTINUOUS_EXPERIENCE_DUMP=/tmp/quay-ce-dumps/falseform.json`。恢复 guard 后两处均绿。
- **AC2**：protocol-simulation → **25 pass / 0 fail / exit 0**，含新增 3 例（mid-utterance expiry 不投递 / 回合关闭后逐字投递一次 / 窗口内 response 消费 span）。
- **AC3**：`voice-realtime-fake-vad-upstream.test.ts` → **15 pass / 0 fail / exit 0**。
- **AC4**：`npx playwright test e2e/voice-realtime-continuous-experience.spec.ts` → **11 passed（11 run，无 did not run / skip）/ exit 0**，连续 3 次（run2/3/4）均同。
- **AC5**：`grep -n "a silent utterance must be carried by no row"` 命中 `:1234` / `:1361` / `:1536`，均紧接 `.toEqual([])`；`grep -n "the merged delivery must be visible as delivered"` 命中 `:1266`，为 `.toHaveLength(1)` 的直接断言。三份 dump 的全体 `routing.sends[].message` 机械扫描无相邻重复子串；投递集合三次均为 `["把 server 的日志贴出来","我想想然后跑一下测试"]`。
- **AC6**：同一种子连续 3 次 `QUAY_CONTINUOUS_EXPERIENCE_DUMP` 归一化读数（沿用上一任务归一集：detector 处置表/items/forwarded/三次计数、`transcript.rows`、routing 的消息/文本/计数、`commits`、`declaredSegmented`、`phase`、journal `mode`、status、`caption`、`fold{resolved,lastInFlight}`、`pageErrors`、`egress{logExists,blocked,dials,authorizationSeen}`、dock 状态**集合**）sha256 三次逐字相同 = `308909d01ae04145cfc1822b455ca084336e109a39255ca7bc96e5999a0341d9`。零外联：`{logExists:true, blocked:false, dials:1, authorizationSeen:false}`，被拒 URL 全为非 loopback（`fonts.googleapis.com`、`api.github.com`）。
- **AC7**：`npm run typecheck` exit 0；`npm run lint` exit 0（仅既有 warning）；`npx oxlint e2e/voice-realtime-continuous-experience.spec.ts` exit 0。
- **AC8**：`grep -c "expectKnownDefect\|test\.fail\|test\.skip\|fixme"` = **0**；`grep -c "^  test("` = **11**。spec 未被改动；本任务只改产品 + protocol-simulation 单测。
- **DoD journal（run2）**：`20.648` U3 final 起表（到期 `23.148`）；`21.848` U4 `speech_started`；`23.148` 到期时 `upstreamTalking=true` ⇒ 重新 arm，**整份 journal 无任何 `settle:` 行**；`23.348` U4 `speech_stopped`；`23.349` 模型合并 response，`24.353` 只投递一条 `我想想然后跑一下测试`；`26.548` U5 final、`26.549` `session_interrupt {"intent":"方向改成跑 lint"}`，stop 之后无任何投递。
- **anti-drift**：`anti-drift-touches-check.js --task … --worktree … --merge-target develop` → `ANTI-DRIFT OK — 2 actual file(s), all within declared Touches`。
