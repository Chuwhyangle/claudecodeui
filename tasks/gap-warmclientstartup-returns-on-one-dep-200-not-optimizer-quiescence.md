---
id: gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence
title: "gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence:
  warmClientStartup returns when a single dep URL answers 200, which does not
  prove Vite's optimizer stopped committing, so first load can hit a
  full-document replacement (15.1s cold vs 2–4s warm), reds AC-153 budget"
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

来源：`gap-ac153-criterion-wallclock-load-headroom` 的 `## Evidence`（人工 2026-10-09 裁定接受「重标守则 + 如实登记」为该条交付，并要求把「优化器静默」另立一条，即本条）。

**机制（该条 Evidence「机制登记」一节逐字登记、未修）**：各 e2e spec 内的 `warmClientStartup` 在「某一个」`/@fs/<cacheDir>/deps/<dep>.js?v=<hash>` 请求答 200 时即返回。这**不证明** Vite 的依赖优化器已停止提交：服务器已开始服务之后若再提交一次（重）优化，Vite 会向已连接客户端推 `full-reload`，整份文档被替换。预热「成功」后首载仍可能落在这一次提交上。

**实测读数（取自 AC-153 条 Evidence 的安静臂，净 worktree HEAD `c64e9e7f`，出货命令逐字三跑）**：首载段（首次 goto + 账户表单渲染）= **2075ms / 4055ms / 15125ms**（暖 / 暖 / 冷）；第 3 跑整轮 `criterion-wall-ms=46282`，`exit 1`，`legs=4 passed=4`，红只在任务自加的 45000ms 整轮守则（`Expected: < 45000 / Received: 46282`，`load1≈84`）。暖 2.1–4.1s 对冷 15.1s，约 7 倍。四条腿读数在冷路径上也是对的 ⇒ 红是预算红，不是判据为假。

**AC-153 条已经排除、本条不得重走的杠杆**（逐字见其 `### 已排除项`）：(1) 模块图预取 `AC153_WARM_GRAPH`：不是配对 A/B，且负载下会吃掉共享的 30s `CLIENT_WARM_DEADLINE_MS`，新增 `fetch failed` 形态（`legs=0 criterion-wall-ms=11253`）；(2) 单纯缩短首个有界 probe：热路径上可能多触发一次 reload；(3) 仅改 warm 的时点/对象而无配对读数支撑。本条的新杠杆是**把返回条件从「一个 URL 200」换成「优化器静默」**：在连续一个有界窗口内，`_metadata.json` 的 `browserHash` 不再变化（并且 entry 转写里取到的 dep url 哈希稳定），才算预热完成。

<!-- dedup-ref --> 同族与去重读数：`gap-voice-dashscope-criterion-boot-dep-reopt-race`（done，AC-142）在 `e2e/voice-dashscope-written.spec.ts` 里照抄了 `warmClientStartup` 的形状（出处 `gap-transcript-follow-criterion-boot-dep-reopt-race`，AC-108，`e2e/transcript-follow.spec.ts`），其完成记录已登记「单撤预热不足以红、`noDiscovery` 形态每次重优化铸新哈希、走图追不上」；本条不回退它们的修法，只收紧返回条件。机制去重：`task_list` 对 `warmClientStartup` 在 `todo` / `ready` 两个状态下 0 命中，`needs-human` 下只命中 AC-153 条本身（即本条的来源），故不是重复。

**范围**：`warmClientStartup` 目前在各 spec 内各有一份拷贝，没有共享 helper（`e2e/voice-error-messages.spec.ts` 的 import 只有 `node:fs`、`node:path`、`@playwright/test`）。本条先在 AC-153 的判据 spec 上做出可测的「优化器静默」返回条件并拿到配对读数；若实现落成一个共享 helper，则它的位置须在 `## Touches` 里登记，不得无登记越界。不动 `playwright.config.ts` 的 `seedViteCache` donor 选择，不动 `SINGLE_SPEC_CEILING_MS` 与 60 秒判据门，不改任何一条腿的读数。

## Plan

1. 建隔离 worktree，打印路径、`git rev-parse HEAD`、`HEAD^{tree}`，确认 `git status --porcelain` 空；读出 `e2e/voice-error-messages.spec.ts` 里 `warmClientStartup` 的当前返回条件与 `CLIENT_WARM_DEADLINE_MS`。
2. 造出可配对的冷路径：用强制冷建私有缓存的手段（参照 `gap-voice-dashscope-criterion-boot-dep-reopt-race` 完成记录里的 `optimizeDeps.force` 做法）让首载段稳定落在冷路径，记录改动前首载段毫秒读数 ≥3 次（与 AC-153 条「冷 15125ms」同口径）。
3. 实现「优化器静默」返回条件：预热在某个 dep url 200 之后，继续观察私有缓存的 `_metadata.json` 的 `browserHash` 在一个有界静默窗口内不变才返回；窗口与总预算有界，预算耗尽时按名字报出 url、哈希轨迹与状态码，不得无限等待。
4. 同路径配对复测：同一冷构造下改动后首载段 ≥3 次，打印改动前后读数与削减额；再在安静宿主上跑出货命令 ≥3 次全部 exit 0。
5. 负载臂：≥20 路兄弟 `npx playwright test` 构造下重跑 ≥2 次，记录 `load1`、`criterion-wall-ms`、`watchdog-line`；若仍撞 55s 看门狗，如实登记，不把安静通过写成已修。
6. 未弱化与类型检查：`git diff <base> -- goals/` 为空，四条腿断言逐字未动，`npx tsc --noEmit -p tsconfig.json` exit 0。

## AC

- [ ] AC1 冷路径可配对复现：强制冷建私有缓存的构造下，对 `npx playwright test e2e/voice-error-messages.spec.ts` 取改动前首载段读数 ≥3 次并逐次入档（毫秒、`criterion-wall-ms`、exit），至少 1 次首载段 ≥10000ms（正控：证明冷路径真的被走到，否则本条空洞）。
- [ ] AC2 返回条件已换成「优化器静默」：`grep -n` 能在 `e2e/voice-error-messages.spec.ts` 里指认出对 `_metadata.json` 的 `browserHash` 稳定窗口的检查，且该检查有界（总预算与静默窗口各有具名常量）；预算耗尽的失败信息含 url、哈希轨迹与状态码，由一次故意缩短预算的运行（退出码非 0，原文入档）证明，之后还原。
- [ ] AC3 同路径配对削减：同一冷构造下改动后首载段 ≥3 次，三次全部低于改动前冷读数的一半，并打印改动前后读数与削减额；若削减不成立，如实登记并置 `needs-human`，不得写成已修。
- [ ] AC4 安静臂全绿：出货命令 `npx playwright test e2e/voice-error-messages.spec.ts` 逐字跑 ≥3 次，全部 `exit 0`，自印 `legs=4 passed=4 watchdog-line=false`，逐次入档 `criterion-wall-ms`。
- [ ] AC5 负载臂实测：≥20 路并发兄弟 `npx playwright test` 下重跑 ≥2 次，入档 `load1`、`criterion-wall-ms`、`watchdog-line`；若在该负载下仍撞 55s 看门狗，逐字入档并置 `needs-human`。
- [ ] AC6 读数与判据未弱化：`git diff $(git merge-base HEAD develop)..HEAD -- goals/ | wc -c` 输出 `0`；`CRITERION_BUDGET_MS` 仍小于 `SINGLE_SPEC_CEILING_MS` 与 60 秒门；`npx vitest run src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx` 与 `npx playwright test e2e/voice-dashscope-written.spec.ts` 退出 0；`npx tsc --noEmit -p tsconfig.json` 退出 0。

## DoD

真实落地：在**冷路径被真实走到**的条件下（AC1 的正控读数），出货命令逐字不变、退出 0，且首载段读数相对同路径改动前可见下降（AC3 的配对读数）；由执行读数证明，不由段落文字声明。承重性：(a) 红是预算红而非判据为假，四条腿读数在冷路径上本来就是对的（AC-153 条 Evidence 已登记）；(b) 返回条件的改变是机制修复，不是更长的等待、不是 `retries`、不是放宽任何上限；(c) 没有把安静通过写成「已修」——负载臂若仍撞看门狗，如实置 `needs-human`（AC5）。

**前提与未确证项如实登记**：「优化器在预热返回之后又提交一次」是由 AC-153 条的冷路径读数（15125ms）与同族 AC-142 条的两次文档加载读数推出的主假设，尚无直接读到 `full-reload` 帧的证据；本条 AC1/AC3 的配对读数就是确认它的实验，若读到别的来源，完成记录写那一个，不得照抄假设。

**L_D / L_G 该轴仍暗，理由**：本条只改 e2e 判据的预热返回条件，不新增领域数据能力，读数是毫秒与退出码，不是生成质量轴读数。

## Touches

- e2e/voice-error-messages.spec.ts
- e2e/voice-dashscope-written.spec.ts
- e2e/transcript-follow.spec.ts
- src/modules/chat/tests/voiceErrorNoticePersistence.test.tsx
- tasks/gap-warmclientstartup-returns-on-one-dep-200-not-optimizer-quiescence.md
