---
id: quay-uri-resolve-project-not-registered-reason
title: 解引用区分 project-not-registered：fleet summary 对未登记项目的拒绝现被误报为 reader-unavailable
status: done
labels:
  - wall
  - contract
  - quay
parent: null
children: []
extra: {}
---
## Proposal

决策出处：2026-10-23 quay-fleet 会话的接线提醒（fleet commit `ec30781`）。`quay-uri-resolve-drop-temporary-fleet-adapter` 已落地（`formatFleetAddress` 已删，原样传 `quay://<project>/…`），但它落地早于这条提醒，没有处理第三种回落原因。

fleet 的事实：`wall resolve` 是纯解析、不查 registry，任何 slug 形状的项目段都接受；项目未登记的拒绝只发生在 `wall summary` / `wall probe`，以非零退出并给出 reason `project-not-registered`。CloudCLI 现在把 summary 的非零退出一律读成 `reader-unavailable`，于是「项目没登记」被误报成「读口坏了」。

方案：`server/modules/quay/quay-uri-resolve.ts` 解析 fleet summary 的失败输出，reason 为 `project-not-registered` 时作为独立回落原因透出，与 `no-summary`、`reader-unavailable` 并列；不依赖 resolve 判断项目是否登记。其他非零退出仍为 `reader-unavailable`。

## AC

- [x] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/quay-uri-resolve.test.ts` exit 0——桩 summary 以非零退出并给出 `project-not-registered` 时，结果 reason 为 `project-not-registered`；给出其他 reason 或无法解析时为 `reader-unavailable`；`no-summary` 用例不弱化。
- [x] AC2: `npm run typecheck` 通过。

## DoD

- 用真实 `quay-fleet` 对一个未登记项目（如 `quay://cantus/task/x`）走一次解引用，贴出 reason 为 `project-not-registered` 的读数；再对 `quay://claudecodeui/task/<真实 id>` 走一次，确认 L1 来自 fleet。

## Touches

- server/modules/quay/quay-uri-resolve.ts
- server/modules/quay/tests/quay-uri-resolve.test.ts
- tasks/quay-uri-resolve-project-not-registered-reason.md
