---
id: AC-351
title: 语音待投递条目逐条撤回：Live Voice 中已入 CLI 队列未出队的话语行带 UI 撤回按钮，走既有 cancelQueued
  链路，撤回后不进入任何一轮；模型无撤回工具、无清空队列
status: superseded
kind: criterion
goal: GOAL-041
criterion: f=src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx;
  [ -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; npx vitest run "$f"
expect: 读数——(a) 语音投递且 queued 的话语渲染为可撤回的待执行行（与打字的 PendingResidentMessage
  同一链路或同等语义），started 后撤回按钮消失；(b) 点撤回 ⇒ 调用 cancelQueued(sessionId,
  queuedMessageUuid)，outcome=cancelled 时该行标记已撤回、深度读数减一；already-started
  时诚实提示无法撤回；(c) 语音工具面仍恰为
  session_send/session_interrupt/session_status，无撤回/清空工具；(d) 撤回不触发
  abort。取假形态——撤回按钮不调 cancelQueued ⇒ (b) 红。
origin: 人 yale 2026-10-12「按建议推进」续裁 D-10/D-11（SPEC §0.3，提交 d09c4bc9）；证据 E9 +
  E10/U4（docs/proposals/claude-resident-sessions-experiments.md）。
activatedAt: 2026-10-12T07:31:58.743Z
statusLog:
  - at: 2026-10-12T07:31:58.743Z
    from: draft
    to: active
    actor: goal-cli
    reason: D-11 立项：任务同批建立
  - at: 2026-10-12T12:54:28.564Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
  - at: 2026-10-14T18:57:14.244Z
    from: achieved
    to: superseded
    actor: worker:gap-ac351-supersede
    reason: 人 yale 2026-10-14 裁定「屏上唯一一张合并卡」：逐行撤回控件随其行一并退役，Live Voice
      不留撤回/中断的可按控件；落地提交 9ccdc6eb7 删除了 useVoicePendingWithdraw.ts /
      VoicePendingUtterance.tsx / voicePendingWithdraw.test.tsx 与
      e2e/voice-pending-utterance-withdraw.spec.ts，判据文件不在树上故判据必红；本记录置
      superseded，后继读数载体
      src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx（撤回能力本身无后继）
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-12T07:31:58.743Z
---
## 退役记录（2026-10-15）

AC-351 置 `superseded`：它断言的**「逐条撤回」这一能力本身**已由 2026-10-14 的人裁定退出本仓意图，`criterion` 现在必红（判据文件不在树上，存在性闸 exit 1）——这正是退役的理由，不是被改绿的对象。

- **裁定**：人 yale 2026-10-14 裁定「屏上唯一一张合并卡」——待投递的话在屏上只呈现为**一张只读的合并卡**，Live Voice 不留任何撤回/中断的可按控件；逐行撤回控件随它所绘的逐句行一并退役。
- **落地提交**：`9ccdc6eb7`（2026-10-14 16:38:11 +0800，`feat(voice): hold ONE merged pending message in the relay (ruling 2026-10-14)`）删除了 `useVoicePendingWithdraw.ts`、`VoicePendingUtterance.tsx`、`src/modules/chat/voice-realtime/tests/voicePendingWithdraw.test.tsx` 与 `e2e/voice-pending-utterance-withdraw.spec.ts`（四者在该提交的 `--stat` 里均为删除），改为 relay 侧一条合并 hold + 页面一张只读卡 `src/modules/chat/voice-realtime/VoicePendingMessageCard.tsx`。其提交信息逐字：「The per-utterance withdrawal control is retired with the per-sentence rows it drew: the ruling allows no withdraw/interrupt affordance in Live Voice.」
- **后继读数载体**：`src/modules/chat/voice-realtime/tests/voicePendingMessageCard.test.tsx`（钉住「the held-message card offers no control」）+ 浏览器面 AC-345 / `e2e/voice-realtime-intent-control.spec.ts`（要求屏上是唯一一张合并的 pending 卡）。**撤回能力本身无后继**：它按裁定不再属于本仓意图，SPEC §0.3 D-2「模型工具面不暴露撤回/清空队列」不变。
- **不改 `criterion`**：判据是「它当时断言了什么」的记录；本记录只改状态、加书面理由，`criterion` 行逐字未动。