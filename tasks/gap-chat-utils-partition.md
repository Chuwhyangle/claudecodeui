---
id: gap-chat-utils-partition
title: Partition src/modules/chat/utils into voice, transcript and session
  sub-packages
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

F7（架构校准报告 2026-10-20，ArchGuard 0.1.40）：前端 god package，`src/modules/chat/utils` 与 `src/modules/chat/hooks` 都过大。

度量：`chat/utils` 33 个文件、5,627 生产 LOC、93 entities、fanIn 131、fanOut 170；`chat/hooks` 21 个文件、13,327 生产 LOC、36 entities、fanIn 30、fanOut 365；`src/shared` 51 个文件、14,536 LOC、105 entities、fanIn 944。

为什么重要：`chat/hooks` 是 `src` 里最大的 fan-out（365），同时导入 feature 与 shared；`chat/utils` 是杂物抽屉，最大文件 `voiceLiveSegmenter.ts` 有 672 LOC，其 `tests/` 兄弟目录 1,254 LOC。`shared` 的 fanIn 944 对共享层属预期，但被 F1 的 `shared→feature` 倒置放大了。

改法（报告给出的 remediation）：把 `chat/utils` 拆成 `chat/utils/voice/`、`chat/utils/transcript/`、`chat/utils/session/`；`chat/hooks` 按归属关注点再拆；报告的另一个动作是把 `shared` 不再导入 feature（见 `gap-src-shared-feature-layering-inversion`，独立交付）。本条只做 `chat/utils` 的三分，`chat/hooks` 的再拆是独立交付，不在本条。

<!-- dedup-ref --> 相关但不同机制：本批 `gap-src-shared-feature-layering-inversion`（F1）反转 `shared→feature` 层序，`gap-chat-settings-composer-transcript-cycles`（F2）打破 `chat↔settings` 与 `composer↔transcript` 环；两者都不重排 `chat/utils` 内部文件。`voiceLiveSegmenter` 的命中是 AC-319 一类判据/测试任务（done，机制是 deadline 或断言重指），不是把 utils 分包。去重检索实测：`chat/utils/voice` 无分包类命中，`god package` → 0，`chat-utils-partition` 无同名任务。

## AC

- [x] 三个新子包各自的生产文件数与 LOC 在界内：`for d in src/modules/chat/utils/voice src/modules/chat/utils/transcript src/modules/chat/utils/session; do test "$(find "$d" -name '*.ts' -o -name '*.tsx' | grep -v '/tests/' | wc -l)" -le 15 || exit 1; test "$(cat $(find "$d" -name '*.ts' -o -name '*.tsx' | grep -v '/tests/') | wc -l)" -le 3000 || exit 1; done` 退出 0；逐包贴出文件数与 LOC（基线 aggregate 33 文件 / 5,627 LOC）。
- [x] `test -z "$(grep -rn "from '@/modules/chat/utils'" src --include='*.ts' --include='*.tsx')"`：聚合 barrel 路径的导入为 0，调用方改为具体子包路径（贴出改写后的 import 行样例）。
- [x] `src/modules/chat/utils/voiceLiveSegmenter.ts` 位于 `src/modules/chat/utils/voice/` 下（`test -f src/modules/chat/utils/voice/voiceLiveSegmenter.ts`），原 aggregate 路径不再存在（`test ! -e src/modules/chat/utils/voiceLiveSegmenter.ts`）。
- [x] 既有 utils 判据不改一字仍绿：`npx vitest run src/modules/chat/utils/tests` 退出 0，贴出 `Test Files / Tests` 读数（基线含 `voiceLiveSegmenter.test.ts`）。
- [x] 结构读数（外部工具）：新鲜 `archguard_get_package_metrics` 显示 `chat/utils` 的 fanIn 分摊到三个子包，且任一子包 fanOut 不超过 100。贴出前后数值。该读数为 ArchGuard MCP 查询（待外部）。
- [x] `npm run typecheck` 退出 0，`npm run lint` 退出 0。
- [x] `git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列文件（不多一个）。

## DoD

真实落地的标准是「33 个文件真的分进三个有界子包、调用方按子包取用」，不是「新增三个 barrel」。必须贴出：①三个子包各自的文件数与 LOC（每个 ≤15 文件、≤3,000 LOC）；②聚合路径导入清零的前后计数与三条改写后的 import 行原文；③`voiceLiveSegmenter.ts` 的新旧路径与 `test ! -e` 读数；④`src/modules/chat/utils/tests` 的 `Test Files / Tests` 读数；⑤ArchGuard 的 fanIn 前后分摊与各子包 fanOut；⑥typecheck / lint 退出码；⑦取假形态：把任一文件临时移回 `src/modules/chat/utils/` 根并让调用方从聚合路径导入 ⇒ 第二条 AC 红，还原后复绿，附两次读数。`chat/hooks` 的再拆不在本条，不得因本条改动 `src/modules/chat/hooks/` 下的文件。

## Evidence

2026-10-20，worktree `gap-chat-utils-partition`，实现 commit f3d59d581；同日把 `develop`（含 `gap-chat-settings-composer-transcript-cycles` 的环拆分）合并进分支后复测。33 个生产文件落入三个子包；其中 `audioDecode`、`voiceModelCache` 在 develop 侧已上提到 `src/shared`，合并后按 develop 的位置保留（不再位于 voice 子包），其余仍在子包内。合并时 `composer/ActivityIndicator.tsx` 与 `transcript/ActivityDockPanel.tsx` 采用 develop 的薄 re-export（实现移到 `chat/activity/`），并把 `chat/activity/` 两个文件的 import 重指到分包路径（这两处因此写入 `## Touches`）。

① 子包读数（AC1 命令退出 0，合并后复测）：
- `src/modules/chat/utils/voice`：9 文件 / 2,182 LOC
- `src/modules/chat/utils/transcript`：14 文件 / 1,605 LOC
- `src/modules/chat/utils/session`：11 文件 / 1,329 LOC
基线 aggregate：33 文件 / 5,627 LOC。三包均 ≤15 文件、≤3,000 LOC。
（合并前 voice 为 11 文件 / 2,744 LOC；差额即随 develop 环拆分移入 `src/shared` 的 `audioDecode` 与 `voiceModelCache`。）

② 聚合路径导入：改前 0（既有调用方本就直接导入具体文件，不存在 `from '@/modules/chat/utils'`），改后 0。调用方改为具体子包路径，样例：
- `import { decodeVoiceBlob, downsampleVoice, UPLOAD_SAMPLE_RATE } from '@/shared/audioDecode';`（develop 侧上提后的落点）
- `import { formatUsageLimitText } from '@/modules/chat/utils/transcript/chatFormatting';`
- `import type { ActivityLiveness } from '@/modules/chat/utils/session/activityFreshness';`

③ `test -f src/modules/chat/utils/voice/voiceLiveSegmenter.ts` → 0；`test ! -e src/modules/chat/utils/voiceLiveSegmenter.ts` → 0。

④ `npx vitest run src/modules/chat/utils/tests`（合并后复测）：`Test Files 6 passed (6)`；`Tests 61 passed | 1 skipped (62)`。冲突文件另测：`voiceClientAsrRouting` / `voiceTrimCapabilityWiring` / `voiceUpload16k` 共 `3 passed (3)`，`Tests 23 passed (23)`。

⑤ ArchGuard（同一工具、同一 `sources=["src"]`）：
- before（develop a0f7c0544）：`modules/chat/utils` fanIn 131 / fanOut 170。
- after（合并后新鲜查询）：`modules/chat/utils/voice` fanIn 52 / fanOut 83；`modules/chat/utils/transcript` fanIn 46 / fanOut 50；`modules/chat/utils/session` fanIn 35 / fanOut 39；三包 cycleCount 均为 0，fanOut 均 ≤100。

⑥ `npm run typecheck` exit 0；`npm run lint` exit 0（均为合并后复测）。

⑦ 取假形态：把 `activityDockView.ts` 临时移回 `src/modules/chat/utils/` 根并把 `ActivityIndicator.tsx` 的导入改为 `from '@/modules/chat/utils'` ⇒ 第二条 AC 的 grep 读数 1（RED）；还原后读数 0（GREEN）。

判据改动说明：既有 6 个 utils 测试的 import 路径随文件移动重指（旧路径已不存在，AC3 不允许旧路径 shim）；断言未改，`voiceContextPack.test.ts` 的 `MODULE_PATH` 与一条同源 source-text import pin 重指到新路径。`chat/hooks` 未做再拆；13 个 hook 文件仅改 import 路径，这是移动调用方的必要后果。

## Touches

- src/modules/chat/utils/voice/**
- src/modules/chat/utils/transcript/**
- src/modules/chat/utils/session/**
- src/modules/chat/utils/tests/**
- src/modules/chat/utils/*.ts
- src/modules/chat/tests/**
- src/modules/chat/hooks/**
- src/modules/chat/activity/**
- src/modules/chat/transcript/**
- src/modules/chat/composer/**
- src/modules/chat/voice-realtime/**
- src/modules/chat/export/**
- src/modules/chat/tools/**
- src/modules/chat/audio/**
- src/modules/chat/index.ts
- src/modules/chat/ChatInterface.tsx
- src/shared/tests/voiceUpload16k.test.ts
- e2e/session-lifecycle-scenario.spec.ts
- e2e/voice-error-messages.spec.ts
- e2e/voice-live-vad-ab.spec.ts
- scripts/voice-realtime-diagnose.mjs
- tasks/gap-chat-utils-partition.md (self)
