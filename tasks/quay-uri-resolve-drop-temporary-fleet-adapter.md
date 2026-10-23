---
id: quay-uri-resolve-drop-temporary-fleet-adapter
title: 删除 C 片临时适配 formatFleetAddress：fleet 已改为只认带项目段的 URI，现主路径全部被拒并静默回落
status: done
labels:
  - wall
  - contract
  - quay
  - regression
parent: null
children: []
extra: {}
---
## Proposal

决策出处：2026-10-23 进展核查时发现的回归。quay-fleet 的 `fleet-wall-uri-project-segment-fix` 已落地：`quay-fleet wall resolve 'quay://claudecodeui/task/foo'` 现在返回 ok；不带项目段的 `quay://task/foo` 被拒绝（`missing-project-segment`，exit 2）。

但 CloudCLI develop 上的 `server/modules/quay/quay-uri-resolve.ts` 仍保留 C 片的**临时**适配函数 `formatFleetAddress()`，把项目段去掉再调用 fleet（第 613、629、665 行）。结果：解引用主路径对每个 URI 都被 fleet 拒绝，全部回落到 snapshot 并标 `reader-unavailable`——功能看起来还能用，实际上 fleet 主路径完全失效，属于静默降级。

方案：
1. 删除 `formatFleetAddress()`，调用 fleet 时直接传原样的 `quay://<project>/…`（用已有的 `formatQuayAddress`）。
2. `wall summary` 仍可带 `--root`（fleet 侧把它保留为可选覆盖），但项目段已由 fleet 按 registry 解析，`--root` 只在 CloudCLI 已知 root 时作为一致性覆盖传入；两者不一致时以项目段为准并记录告警。
3. 增加一条防回归测试：fleet 调用参数里的 URI 必须带项目段。

## AC

- [x] AC1: `npx tsx --tsconfig server/tsconfig.json --test server/modules/quay/tests/quay-uri-resolve.test.ts` exit 0——桩 fleet 读口收到的 URI 与调用方传入的 `quay://<project>/…` 逐字相等（含 `#ac-<n>`）；不再出现无项目段形式；既有 no-summary / reader-unavailable 两条 reason 用例不弱化。
- [x] AC2: `git grep -n "formatFleetAddress" -- server` 无命中。
- [x] AC3: `npm run typecheck` 通过。

## DoD

- 用真实 `quay-fleet`（`/data/home/yale/work/quay-fleet/bin/quay-fleet.mjs`）对 `quay://claudecodeui/task/<一个真实任务 id>` 走一次解引用，结果 `source` 不是 snapshot-fallback 的 `reader-unavailable`（L1 来自 fleet；L2 目前若为 absent 则 reason 为 `no-summary`），贴出读数。

## Touches

- server/modules/quay/quay-uri-resolve.ts
- server/modules/quay/tests/quay-uri-resolve.test.ts
- tasks/quay-uri-resolve-drop-temporary-fleet-adapter.md
