---
id: gap-claude-resident-cancel-queued-capability-truth
title: 能力位 cancelQueuedInput 与 E9/E10-U4 实测一致：claude resident 置
  true，更正基于旧值的推理注释，不改运行时行为（D-11）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-350
---
## Proposal

### 现状（2026-10-12 复核）

- 能力矩阵 `server/modules/providers/services/provider-capabilities.service.ts:150` 写 `cancelQueuedInput: false, // not covered by E1–E8`。
- 但撤回能力已实现并实测：driver `claude-host-driver.provider.ts` `cancelQueuedInput()`（写 `cancel_async_message`，以 `state=cancelled` 为判据）、控制服务 `chat-control.service.ts` `cancelQueued`、MCP `session_cancel_queued`（AC-271）、聊天 UI `PendingResidentMessage.tsx` 撤回按钮。E9 实测撤回最新条目有效；E10/U4（`docs/proposals/claude-resident-sessions-experiments.md` §E10）实测撤回**非最新**条目有效。
- **无运行时代码读取该位**（服务端只有声明与类型 `server/shared/types.ts:3124`；前端 `useActivityControls.ts` 只读 `stopTask`/`backgroundTasks`）——它只在误导推理：`server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts:189` 的 "WHY IT CANNOT BE A CANCELLATION. The provider's `cancelQueuedInput` slot is `false` …" 注释，以及 SPEC 早期版本。

### 要做的事（SPEC §0.3 D-11）

把该位改为 `true`，注释引用 E9 与 E10/U4；更正 ws-proxy 那段注释（准入轴仍为字节预算，理由改写为「撤回是 UI 的确定性动作，不是准入手段」，不改任何行为）；新增判据文件钉住矩阵值；同步 `server/modules/session-hosts/tests/lifecycle-mode.test.ts:844` 等既有钉子。⛔ 不改任何运行时行为，不给语音模型加工具。

<!-- dedup-ref --> 机制去重：open 任务对 `cancelQueuedInput` 能力位 0 命中。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。

> 实施注记：本块的「不改能力位 `cancelQueuedInput`」与任务标题 / AC1 / D-11 直接冲突（D-11 正文明写「能力位 `cancelQueuedInput` 改为 `true`」）。共用 SCOPE BOUNDARY 是从「语音面不暴露撤单」那条 D-2 派生的整体约束，对本任务的取值任务不适用；本任务按**任务标题 + AC1 + SPEC D-11** 执行（详见 `## Notes`）。


## Plan

1. 改位 + 注释；2. 更正 ws-proxy 注释；3. 新判据文件 + 既有钉子；4. quay-test-script 钉子与基线；typecheck / lint。

## AC

- [x] AC1（取假形态排最前）：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/provider-capabilities-cancel-queued.test.ts` 退出 0；首条断言 `PROVIDER_CAPABILITIES.claude.residentFeatures.cancelQueuedInput === true`，文件内对「改回 false」的假形态断言会红。
- [x] AC2：该文件扫描 `voice-realtime-ws-proxy.service.ts`，断言不再含「slot is `false`」类推理表述。
- [x] AC3：`server/modules/session-hosts/tests/lifecycle-mode.test.ts` 及其余引用该位的既有测试（`claude-resident-control-queue.test.ts`、`chat-control-*.test.ts`、`debug-agent-host-driver.test.ts`、`mcp-not-found-semantics.test.ts`）退出 0。
- [x] AC4：`npm run typecheck`、`npm run lint`、`server/shared/tests/quay-test-script.test.ts` 退出 0。

## DoD

`GET` 能力矩阵（服务端读数或判据内直接读模块）显示 claude 的 `cancelQueuedInput: true`，且仓内无基于旧值的推理注释残留（`grep` 读数写入 `## Notes`）。

## Touches

- server/modules/providers/services/provider-capabilities.service.ts（能力位取值 + 出处注释）
- server/shared/types.ts（仅注释：`ResidentFeatures` 文档块两处把该位举为「未验证」示例）
- server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts（仅注释）
- server/modules/providers/tests/provider-capabilities-cancel-queued.test.ts (new)
- server/modules/session-hosts/tests/lifecycle-mode.test.ts（能力位钉子）
- server/modules/providers/tests/claude-resident-control-queue.test.ts（**未触碰**：该文件只引用驱动方法名 `cancelQueuedInput`，从不读能力位取值，故钉住旧值的情形不成立、无需改动；声明保留以备核对）
- server/shared/tests/quay-test-script.test.ts（新增测试文件计数钉子）
- scripts/suite-duration-baseline.tsv（新增测试文件基线行）
- tasks/gap-claude-resident-cancel-queued-capability-truth.md

## Notes

立项：Opus 常驻架构会话，2026-10-12，人 yale「按建议推进」（GOAL-041 / AC-350，SPEC D-11）。

### 落地（2026-10-12，worker 轮）

分支 `task/gap-claude-resident-cancel-queued-capability-truth`，实施提交 `2129c678 fix(providers): state cancelQueuedInput true, measured by E9 and E10/U4`；其后两次把 `develop` 并入：`1a8f0d4f`，以及本任务 `task_write` 落在 develop 之后的 `621a3969`（分派步骤 (2b)(i) 要求的那次预合并 —— 它同时把**工作树里**的任务体带到更正后的 `## Touches`，而 anti-drift 守卫读的正是工作树那份 `tasks/<id>.md`）。工作树干净。

改动面（7 个代码/数据文件 + 本文件）：

- `provider-capabilities.service.ts`：`cancelQueuedInput: false` → **`true`**，并补出 E9（2026-09-26，撤回**最新**排队项，CLI 答 `cancelled`）与 E10/U4（撤回**非最新**排队项，同一 `cancelled` 事件）两次实测的出处注释；同时把 `residentFeatures` 块头注释从「五条实测 + 未测条目」改写为「五条 E1–E8 + 后测的 `cancelQueuedInput` 各带实验号，唯一未测的 `authoritativeLeases` 取保守值」，并把 `stopTask` 的 doc 里「与 `cancelQueuedInput` 同款未实测纪律」的反例改成 `authoritativeLeases`。
- `voice-realtime-ws-proxy.service.ts`：仅注释。原段落以「`cancelQueuedInput` 槽为 `false` ⇒ 已交给 CLI 的话撤不回」论证字节预算，改为「供给方确有该动词（E9/E10-U4 实测），但中继两半都不占：模型工具面按 D-2 不给撤回，且中继句不带调用方可命名的 id；故本守卫约束的是 `session_send` **之前**的准入决策，不是撤回」。
- `server/shared/types.ts`：仅注释。`ResidentFeatures` 文档块里两处把 `cancelQueuedInput`（及 `liveReconfigure`）举为「未验证」示例，收敛为只剩 `authoritativeLeases`。
- `session-hosts/tests/lifecycle-mode.test.ts`：既有钉子 `assert.equal(features.cancelQueuedInput, false)` → `true`，注释补 E9/E10-U4 出处并同步「其余**三**条无实测者取保守值」。
- `providers/tests/provider-capabilities-cancel-queued.test.ts`（新）：AC1 + AC2 两条。
- `shared/tests/quay-test-script.test.ts`：新增测试文件计数钉子 `known=3 unknown=301→302`、`known=1 unknown=303→304`（收集数 304→305）。
- `scripts/suite-duration-baseline.tsv`：追加新文件行 `950<TAB>server/modules/providers/tests/provider-capabilities-cancel-queued.test.ts`，并把表头覆盖数 276/304 → 277/305。

### 取假形态（为什么 AC1 不是断言）

AC1 的假形态写在判据文件内、紧挨首位断言：把**发行模块**的单个字段赋值 `cancelQueuedInput: true,` 复制成 `__criterion-falsify-cancel-queued-<pid>.ts`（该前缀已被 `server/tsconfig.json` 的 `"./**/__criterion-falsify-*"` exclude 排除在 program 之外），用 `pathToFileURL` 动态 import，同一条表达式读该副本必须答 `false`，最后在 `finally` 里删除并断言已删。已实测：把发行值改回 `false` ⇒ AC1 红（exit 1）；恢复后绿。命中数用全局 `match` 计数而非 `String.split`——后者会把正则捕获组拼进结果数组，同一 pattern 会多报一次幻影命中。

AC2 同样双侧：负向断言 `voice-realtime-ws-proxy.service.ts` 中没有任何一行把 `cancelQueuedInput` 与旧值绑在一起，正向对照断言该段落仍在、且仍写出实测值（防止「删掉段落」空过负向）。已实测：把旧句子放回 ⇒ AC2 红（exit 1）；恢复后绿。

### AC 读数（全部在合并 develop 后的树上复跑）

- AC1：`npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/provider-capabilities-cancel-queued.test.ts` ⇒ exit 0，2 pass；`[cancel-queued] claude.residentFeatures.cancelQueuedInput=true (false form on the flipped copy: false, measured by E9 + E10/U4)`。
- AC2：同上文件第二条 ⇒ pass（`ws-proxy: 1 line(s) cite the slot, 0 tie it to `false``）。
- AC3：`session-hosts/tests/lifecycle-mode.test.ts` 9 pass；`chat-control-{wiring,busy,access,ownership}.test.ts` + `mcp-not-found-semantics.test.ts` 计 21 pass；`providers/tests/claude-resident-control-queue.test.ts` 2 pass；`debug-agent/tests/debug-agent-host-driver.test.ts` 5 pass；均 exit 0。
- AC4：`npm run typecheck` exit 0；`npm run lint`（oxlint，非 eslint）exit 0；`server/shared/tests/quay-test-script.test.ts` 11 pass exit 0。
- **最终合并树复跑（`621a3969`）**：以上四组在合并树（而非验证时的旧树）上逐条重跑，读数一致 —— AC1/AC2 2 pass；AC3 计 37 pass（9+21+2+5）；AC4 typecheck / lint 均 exit 0、quay-test-script 11 pass。`scripts/test.sh` 收集数 305（304 + 本任务新增 1），与钉子 302/304 相符。
- anti-drift 守卫预跑：`node anti-drift-touches-check.js --task gap-claude-resident-cancel-queued-capability-truth --worktree <wt> --merge-target develop` ⇒ `ANTI-DRIFT OK: … 7 actual file(s), all within declared Touches (9 glob(s))`（首次预跑为 `out-of-declared: server/shared/types.ts`，即本次补进声明的那个文件）。

### DoD grep 读数（2026-10-12，合并后树）

矩阵读数：`grep -n "cancelQueuedInput: " server/modules/providers/services/provider-capabilities.service.ts` ⇒ 唯一命中 `166:      cancelQueuedInput: true, // E9 (newest queued), E10/U4 (non-newest queued)`。

旧值推理残留 grep：`grep -rn "cancelQueuedInput" . | grep -E 'cancelQueuedInput[^\n]*\bfalse\b|slot is `?false`?'`。**代码面 0 命中**（`server/` 下无任何发行文件仍把该位与旧值绑在一起；ws-proxy 那段已改写）。剩余命中分三类，均在 Touches 之外且都不是「基于旧值的推理注释」：

1. 本判据文件自身（`provider-capabilities-cancel-queued.test.ts` 的 AC2 检测正则与两条 doc/标题的字面复述）——检测器必须持有该 pattern，属判据本体而非残留推理。
2. 历史设计记录 `docs/proposals/`：`claude-session-activity-dock.md:136`（立项时的「默认 false」惯例）、`voice-realtime-persistent-control-SPEC.md:139` 与 `:365`（清空队列/撤单的「不支持」判据）。其中 `:93` 的能力表条目**本就**自标「⚠️ 能力位过时」并已在同格记录 E9 实测——SPEC 自己先把这次取值登记在案，故 D-11 落地不需要改这几处历史文本。
3. 其他任务体 / 立项记录：`tasks/gap-live-voice-bounded-queue-refusal-visible.md`（:18、:42 明写「**不改其值**」，其机制结论「上限必须在入队前强制」与本任务取值无关、不受影响）、`tasks/gap-live-voice-voice-terminated-interrupt.md:21`、`tasks/gap-chat-stop-task-event-confirmed.md:33`（描述 `stopTask` 沿用「未实测不开」纪律的当时状态）、`tasks/gap-ac287-not-found-semantics.md:33`（同名驱动方法的语义讨论，与能力位无关）、以及本任务体 `## Proposal` 的「现状」快照。

### 待跟进（不属本任务，未改）

- `docs/proposals/voice-realtime-persistent-control-SPEC.md:139`、`:365` 与 `claude-session-activity-dock.md:136` 是历史设计的当时状态记录；若要收口，应由 SPEC 的后续修订（或 GOAL-041 的收尾任务）统一处理，而不是本取值任务越界改提案文本。
- `tasks/gap-live-voice-bounded-queue-refusal-visible.md:18`、`:42` 的「claude 该槽为 `false`」前提在本任务落地后已过时（其**结论**——上限在入队前强制——仍成立，且与 D-11 不矛盾：D-11 只放开 UI 单条撤回，不放开模型面撤单）。该任务若仍 open，其正文前提需由其自身复核轮更新。
