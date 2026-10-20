---
id: AC-376
title: P1 切分与协议（第二段，原链 CMD3）：旧连续 audio 帧协议兼容的浏览器 e2e ——
  voice-realtime-upload-fixture 与 voice-realtime-live-session-send 两条 spec 全绿
status: achieved
kind: criterion
goal: GOAL-034
criterion: npx playwright test e2e/voice-realtime-upload-fixture.spec.ts
  e2e/voice-realtime-live-session-send.spec.ts --workers=1
expect: >-
  读数——(a) 两条既有 e2e spec
  全绿：`e2e/voice-realtime-upload-fixture.spec.ts`（上传/协议模拟路径的既有用例）与

  `e2e/voice-realtime-live-session-send.spec.ts`（真实 session-send 路径），即 AC-319 原
  criterion 三命令 `&&` 链的

  **第三条**（`npx playwright test e2e/voice-realtime-upload-fixture.spec.ts
  e2e/voice-realtime-live-session-send.spec.ts

  --workers=1`），逐字未改。


  (b) 本段承载的是 AC-319 的「**兼容**：旧的连续 `audio` 帧协议路径行为不变（既有 protocol-simulation 与两个
  e2e spec

  全绿）」这一承重项——两条 spec 的既有断言在切分/分段实现落地后仍全绿。


  (c) **拆分口径**（照人 yale 2026-10-11 对 AC-331 的裁定同形处理）：原三命令 `&&` 串行链的绿灯 floor 实测
  131s

  （CMD1 34.4s + CMD2 10.9s + CMD3 85.8s），恒高于 goal driver 的 `CRITERION_TIMEOUT_MS
  = 120000`

  （`plugin/scripts/goal-driver.ts` 用它 spawn `quay goal gate`，到 120000ms 对 spawn
  发 SIGKILL，记录上的

  `timeoutMs` 管不到那一刀）；而原记录无 `timeoutMs` ⇒ 闸用默认 `DEFAULT_ACCEPTANCE_TIMEOUT_MS =
  60000`

  ⇒ 可行区间 `floor < timeoutMs < 120000` 为空，单条记录结构性写不出 `pass`。故按闸把链切成两段、并集与原链

  **逐条相同**：本记录承载 floor 最大的 CMD3（实测 85.8s），声明 `timeoutMs: 115000`（> floor
  85.8s，余量 25% = 1 − 85.8/115.0，即声明值是实测 floor 的 1.34 倍 ⇒ 相对 floor 的余量为
  +34%，满足「≥30% 相对余量」；30% 相对余量的下界是 1.3 × 85.8s = 111.6s，而 115000 仍 < 120000
  硬闸，故按实测取 115000）；

  CMD1+CMD2 留在 AC-319（`timeoutMs: 118000`，其串行 floor 45.3s，余量 61%）。⛔
  未删／未弱化／未合并成更短命令。


  (d) 取假形态：在实现树上注入一个被测回归（改坏 relay 档的最小段长/停顿参数、或去掉段合并）⇒ 本条或它的兄弟段

  AC-319 必红；`git checkout --` 还原后复绿。
origin: >-
  2026-10-13 拆分立案（任务 gap-ac319-criterion-serial-over-driver-spawn-cap-split；照人
  yale 2026-10-11 对 AC-331

  的裁定「按拆分推进」同形处理）。依据：AC-319 原 criterion 是一条三命令 `&&` 串行链，同日 clean task worktree

  @ develop `6ee4b5b5` 用 `scripts/with-memory-cap.sh` 逐条实测 CMD1 34.4s / CMD2
  10.9s / CMD3 85.8s（串行 floor

  131s，三条各自 exit 0），而 goal driver 的 `CRITERION_TIMEOUT_MS = 120000` 在 120000ms
  对判据 spawn 发 SIGKILL、

  记录 frontmatter 里的 `timeoutMs` 只作用于闸自己的 runner；AC-319 又未声明 `timeoutMs` ⇒ 闸默认
  60000ms

  （账本 `.quay/goal-round.jsonl` rounds 75/76 逐字：`not-evaluated (timeout):
  acceptance timed out after 60000ms`）

  ⇒ `floor < timeoutMs < 120000` 区间为空，该 AC 结构性写不出 pass，与被测功能对不对无关。故按闸切段：本记录

  承载原链第三条（两条 e2e spec），AC-319 保留前两条并各声明 `timeoutMs`；两段并集与原链逐条相同。人 yale 同日

  裁定：AC-319 的判据与 timeoutMs 只落到该记录、不动 GOAL-034 的其它记录与主检出在途 WIP。
activatedAt: 2026-10-13T02:26:40.180Z
statusLog:
  - at: 2026-10-20T13:46:40.611Z
    from: active
    to: achieved
    actor: goal-cli
    reason: quay goal gate AC-376 verdict=pass (acceptance passed, exit 0)
      @2026-10-20T13:46:35.575Z
timeoutMs: 115000
---
