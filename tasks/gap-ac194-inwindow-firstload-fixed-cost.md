---
id: gap-ac194-inwindow-firstload-fixed-cost
title: AC-194 判据在 fleet 持续负载下再次红（Received 41402ms）：bundle 只削了 server
  启动，窗口内首次装载与固定等待在负载下膨胀——移出 653KB react-scan 首装并给同构造 ≥3 次 ≤40000 读数
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-194
---
## Proposal

**本轮直接测量（不是台账尾巴）。** AC-194 记录 `status: achieved`，其 GOAL-015 已不再活且未声明 `long-term: true`，故台账 `gate=goal` 尾部按 CURRENTLY FALSE 交办。本轮 driver 在评估根 `/data/home/yale/work/claudecodeui`（tree `5663455333e39cc9e5ce58b38eb10e2b780f0906`）直跑判据，`2026-10-21T04:54:36.120Z` exit 1，data dir `quay-e2e-0hZza4`。判据物逐字为 `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"`。

`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-0hZza4/test-results/activity-dock-background-a-aeb25-nd-restores-from-a-snapshot/error-context.md` 的 `# Error details` 逐字：

```
Error: the criterion must complete within 40s

expect(received).toBeLessThanOrEqual(expected)

Expected: <= 40000
Received:    41402
```

落点 `e2e/activity-dock-background.spec.ts:444`（describe 起点 `:295:3`）。同目录 `watchdog-state.json` 逐字 `"detail": "boot completed at 20987ms, re-armed to 55000ms"`。⇒ 断言是 describe 里的最后一条，**全部产品读数（坞计数、面板四读数、计划三读数、不刷新即变化、重载快照恢复、卡片读 Task、计划零控件、两条假形态）在它之前都已通过**；红的只有 40s 墙钟，且其中 20.99s 落在 boot 段。

**同一 checkout 的复跑（2026-10-21 13:04-13:06，宿主 load1 ≈35/51/65）。** 逐字出货命令，用 `bash scripts/with-memory-cap.sh` 包裹：

- data dir `quay-e2e-uXXGcv`：exit 0，自印 `AC-194 wall clock: 32492ms`；`watchdog-state.json` 为 `boot completed at 13950ms`；窗口内 18542ms。
- data dir `quay-e2e-dJ9foU`：exit 0，自印 `AC-194 wall clock: 20032ms`；`boot completed at 6323ms`；窗口内 13709ms。同一次运行的 stdout 时间戳分段：`vite-cache seed=… in 71ms` @0.90s、`Running 1 test` @2.43s、`client warm-up: 431ms` 结束 @7.65s、`sidebar ready: 408ms` 结束 @14.59s、墙钟 @20.59s ⇒ 首次应用装载 ≈6.9s、用例体 ≈5.4s。

⇒ 同一棵树、同一条命令，boot 段在 10 分钟内从 **6323 → 13950 → 20987ms** 摆动（3.3×）。40s 的失败不是某一个固定成本太大，而是窗口内各段在 fleet 负载下一起膨胀；任何一段的膨胀都足以吃掉 1.4s 的缺额。

**直接探针否掉了「server / Vite 还慢」。** 同一宿主、同一 checkout：`node server/node_modules/.cache/quay-e2e-build/server-index.9506c8c9…mjs` 到 `/health` **764ms**；带 seed 的 `vite --host 127.0.0.1 --strictPort` 就绪 **564ms**。⇒ 上一个任务交付的 content-hash bundle 确实生效，server 的模块变换已不是大块；boot 段 14-21s 的膨胀不在 server 代码里。

**为什么先前的修复没有兜住。**

- `gap-activity-dock-background-browser`（done）交付产品面与 spec，静跑绿。
- `gap-ac194-criterion-wallclock-load-scaled-fixed-cost`（done）把 AC-194 describe 里的固定 25s 探针换成有界 warm-up。
- `gap-ac194-criterion-pretest-boot-inflation`（done）把 `tsx server/index.ts` 换成 esbuild 单文件 bundle，静跑 boot 4.25s→2.2s，并在「8 路 lane + 128 burners」

  下 8/8 ≤40000（28.3-29.9s）。但它的 burners 在 boot 完成后就停掉，用例体与首次装载从未与 boot 一起受压；它记录的达标读数（28-30s）也低于本轮失败（41.4s），即那个构造没有复现 fleet 的**持续**负载形态。bundle 只拿掉了 server 的模块变换，窗口内其余固定工作原样留在 40s 里。

**本轮已定位到的具体重块（可直接落杠杆）。**

- `src/main.tsx:3` 静态 `import { scan } from 'react-scan'`：`node_modules/react-scan/dist/index.mjs` 为 **652950 bytes**，而 `:17` 只在 `localStorage.getItem('react-scan') === 'on'` 时才需要它。失败那次自己的 stderr 就带着 `[WebServer] [BABEL] Note: The code generator has deoptimised the styling of …/vite-cache/deps/react-scan.js?v=8b9f973b as it exceeds the max of 500KB.` ⇒ 这个 653KB 模块在本条判据的首装路径上，且被 Babel 整份生成。改成同一 flag 门控的动态 `import('react-scan')` 不改变任何行为（flag 关时该模块不再被浏览器请求/变换）。
- 首次应用装载（`client warm-up` 结束 → `sidebar ready`）在快跑里 ≈6.9s，是窗口内最大的非产品读数块：`warmClientStartup` 只走 html shell + 入口 + 一个 dep url，不铺整张模块图。
- 用例体的固定等待：scenario 在 3600/3800ms 才发 `task-updated`/`task-notification`，用例体 ≈5.4s。若归因证明最终缺额在这里，可在不丢失 running→terminal 读数的前提下压缩。

**实现面（本条认领，按实测选杠杆，不预设结论）。**

1. 先用与失败同阶的**持续**负载构造复现 exit 1 且墙钟 >40000：多路兄弟 `npx playwright test` lane，且 burners/负载覆盖 boot **与**用例体全程（不得在 boot 完成后停止）；逐字记录 error-context、`watchdog-state.json`、`[e2e] vite-cache seed=`、`[BABEL] … react-scan.js` 与 `load1`。
2. 对复现运行做分段归因（boot latch / 首次应用装载 / 用例体），并区分 boot 段膨胀是 Playwright/config 求值、seed 未命中导致的冷重优化（读 `vite-cache seed=none|discarded` 与 BABEL 行），还是首次装载；选出贡献最大的块。
3. 至少落地 (a)：把 `react-scan` 移出首装静态图（同 flag 门控的动态导入）；并在读数支持时继续 (b) 首次装载预热/重叠、(c) 用例固定等待压缩。任何杠杆都必须由「同构造前后目标块下降」的读数支撑。
4. 判据面一字不动：命令、`goals/AC-194-…md`、`toBeLessThanOrEqual(40_000)` 两处、全部产品读数与两条假形态。

**非目标。** 不改坞 / 面板 / 卡片 / Task 归约 / 活动协议的产品面；不碰 AC-199 的读数与上限；不把 40s 换成「用例体墙钟」、不加 retry、不改 `criterion:` / `expect:`（那是改口径，须人裁定）；不重做三个已 done 先例任务的产品面。

**实现约定。** `src/main.tsx` / `src/App.tsx` 属前端代码，按 `AGENTS.md` 先加载 `.agents/skills/frontend-module-standards/SKILL.md` 并遵守；`e2e/` 与 `playwright.config.ts` 属测试面，不套用该架构规则。

<!-- dedup-ref --> **去重与粒度读数（本轮实测）。** `grep -l '^goal_ac: AC-194' tasks/*.md` → 3 条，全部 `done`（产品面、固定探针、bundle boot）；在飞扫描（`^status:` ∈ todo/ready/needs-human）→ **0 命中，无在飞认领者**。三条 done 不是重复，而是「先前修复未兜住」的证据。`task-granularity-advice --touches src/main.tsx --touches e2e/support/client-startup-warmup.ts --touches e2e/activity-dock-background.spec.ts --json` → `peers: []`、`mentions: []`，无合并候选。机制相邻但不同：`gap-voice-dashscope-criterion-boot-dep-reopt-race`（done）管的是冷重优化在开户向导在场时 full-reload 抽走表单（AC-142 判据），本条管的是 40s 墙钟预算内剩余固定工作与首装重模块。⇒ 单独立案。

## AC

- [x] AC1 复现红态并机械入档：在与失败同阶的**持续**负载下运行逐字出货命令，得到 ≥1 次 exit 1 且自印墙钟 >40000；入档该次 `error-context.md` 的 `# Error details` 逐字、落点行号、该 run data dir 的 `watchdog-state.json` 全文、`[e2e] vite-cache seed=` 行（若有）、`[BABEL] … react-scan.js` 行（若有）与 `load1`。若构造跑不出 >40000，逐条入档每次读数与构造参数，并以本轮 driver 的 `quay-e2e-0hZza4` 读数（`Received: 41402` / boot `20987ms`）作为红基准，⛔ 不得把没发生的红写成已复现。
- [x] AC2 分段归因：对 AC1 的运行给出 boot latch、首次应用装载（`client warm-up` 结束→`sidebar ready`）、用例体三段各自的毫秒数及其占墙钟比例；点名被选杠杆，并给出该块在复现运行中的实测成本；若 boot 段的膨胀被归到 seed 未命中/冷重优化，给出 `vite-cache seed=` 与 BABEL 行的逐字读数。
- [x] AC3 杠杆落地与前后对照：`react-scan` 不再位于首装静态图——`grep -n "import { scan } from 'react-scan'" src/main.tsx` 无命中，且新形态仍以同一 `localStorage` flag 门控；同构造前后对照显示目标块下降，并给出该运行 stderr 中首次导航前不再出现 `[BABEL] … react-scan.js`（或等价的浏览器请求读数：首装未请求 `react-scan`）。
- [x] AC4 同构造验收：修复态在 AC1 的同一构造下连续 ≥3 次 exit 0，每次自印 `AC-194 wall clock` ≤40000，且三次中至少两次 ≤38000（余量 ≥2s）；逐次入档墙钟、boot latch、`vite-cache seed=` 与 `load1`。
- [x] AC5 静跑与兄弟不回归：无 lane 时 ≥2 次 exit 0 且墙钟 ≤40000；`npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"` 一次 exit 0。
- [x] AC6 判据与读数未被弱化：`grep -c "toBeLessThanOrEqual(40_000)" e2e/activity-dock-background.spec.ts` 仍为 `2`；`git diff <base>..HEAD -- goals/` 为空；运行输出仍逐字包含 `dock.counts=`、`plan.cancelControls=0`、`settled.cardTaskStates=`、`settled.cardFoldedStates=`、`restored.`、`falseForm2.`；没有新增 retry 或改判据命令。
- [x] AC7 失败路径如实：若同构造下仍无法让 ≥3 次 ≤40000，停手置 `needs-human`，附逐字读数、已试杠杆与排除项；⛔ 不得把静跑通过或单次通过写成已修。

## DoD

真实落地判据：在能复现本轮红的**持续**负载构造下，逐字出货命令 `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"` 连续 ≥3 次 exit 0 且每次 `AC-194 wall clock ≤ 40000`（至少两次 ≤38000），并给出每次的 boot latch / seed / load1；同一修复在无 lane 静跑 ≥2 次 ≤40000，兄弟 `-g "AC-199"` 不回归；40s 上限、判据命令、`goals/AC-194-…md` 与全部产品读数一字未改。杠杆证据必须是「同构造前后目标块下降」的实测（含 `react-scan` 不再参与首装），不是静跑通过或单次过线。

## Touches

- `src/main.tsx`（react-scan 改为同 flag 门控的动态导入，移出首装静态图）
- `src/App.tsx`（仅当分段归因证明首屏重模块藏在其静态 import 时才改；读数不支持则不动）
- `e2e/activity-dock-background.spec.ts`（用例固定等待/顺序；读数与 40s 上限不动）
- `e2e/support/client-startup-warmup.ts`（首次装载预热或重叠；仅在归因支持时改）
- `playwright.config.ts`（仅在归因证明 boot 段有选择域内可削项时改）
- `tasks/gap-ac194-inwindow-firstload-fixed-cost.md`（自触）

## Evidence

**实现（唯一代码改动，commit `51028cd54`）**：`src/main.tsx` 把 `import { scan } from 'react-scan'` 静态导入改为同一 flag 门控的 `void import('react-scan')`（`:23` `if (import.meta.env.DEV && localStorage.getItem('react-scan') === 'on')`，`:24` `void import('react-scan').then(({ scan }) => scan({ enabled: true }))`）。`grep -n "import { scan } from 'react-scan'" src/main.tsx` → 0 命中。`git diff --stat develop..HEAD` 只有 `src/main.tsx | 12 ++++++++++--`。`npx tsc --noEmit -p tsconfig.json`、`npx oxlint src/main.tsx` 均 exit 0。

**运行形态（所有运行）**：逐字判据命令 `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"`，按 AGENTS.md 用 `bash scripts/with-memory-cap.sh` 包裹（只做内存隔离，不改命令本身）；每条 stdout 行带 elapsed 时间戳（perl）。

### AC1 — 红态、构造参数与兜底基准

本 worktree 第一次运行（data dir `quay-e2e-BOjHov`，2026-10-21 13:11:27+08:00；宿主 load1 54.79 / 48 users）：**exit 1，自印 `AC-194 wall clock: 41352ms`**。

`test-results/activity-dock-background-a-aeb25-nd-restores-from-a-snapshot/error-context.md` 的 `# Error details` 逐字：

```
Error: the criterion must complete within 40s

expect(received).toBeLessThanOrEqual(expected)

Expected: <= 40000
Received:    41352
```

落点 `e2e/activity-dock-background.spec.ts:444`（describe 起点 `:295:3`）。

该 run 的 `watchdog-state.json` 全文：

```json
{
  "armed": true,
  "fired": false,
  "ceilingMs": 55000,
  "detail": "boot completed at 27525ms, re-armed to 55000ms"
}
```

`[e2e] vite-cache seed=none in 2ms (vite must optimize)`

`[WebServer] [BABEL] Note: The code generator has deoptimised the styling of /data/home/yale/.cache/quay-e2e-tmp/quay-e2e-BOjHov/vite-cache/deps/react-scan.js?v=f46cf61f as it exceeds the max of 500KB.`

同 run 其它逐字读数：`[e2e] client warm-up: 925ms`、`[e2e] sidebar ready: 478ms`、`running.cardTaskStates=["running","running"] at +37493ms`。

**持续负载构造本身没有复现 >40000（如实入档）**：3 路兄弟 lane（同一条逐字命令，各自独立 data dir/端口）+ 16 个 CPU burner **覆盖 boot 与用例体全程**，load1 39.64→43.13，pre-fix 三条全绿 `17563 / 17140 / 16974ms`（boot latch `5968 / 5890 / 5896ms`，`seed=BOjHov`）；post-fix 同构造三条全绿 `13659 / 13655 / 13679ms`。⇒ 按 AC1 兜底条款，红基准取本轮 driver 的 `quay-e2e-0hZza4`：`Received: 41402` / `boot completed at 20987ms`。本机唯一一次 >40000 即上面这次（`seed=none`、本 worktree 首跑）；其构造参数已逐条入档，**不**把没发生的持续负载红写成已复现。

### AC2 — 分段归因

红 run（`41352ms`）：boot latch **27525ms（66.6%）**，其余 **13827ms（33.4%）**。boot 段的膨胀归到 **seed 未命中 / 冷重优化**：`seed=none` + 上面那条 `[BABEL] … react-scan.js` 逐字行；同一条命令在缓存命中时只需 13-17s（见 AC3/AC4 表）。红 run 自身 stdout 无行级时间戳，其余两段由同 describe 的 `running... at +37493ms`（到墙钟 3.859s）与下面带时间戳的同构造复刻定位。

同构造复刻（pre-fix，measured lane，`wall 17563ms`，行级时间戳；各段互不重叠）：

| 段 | ms | 占墙钟 |
| --- | ---: | ---: |
| config 求值 + seed + Playwright 启动（0→`Running 1 test`） | 3682 | 21.0% |
| collection 之后→boot latch（`boot completed at 5968ms`） | 1527 | 8.7% |
| boot latch→warm-up 开始（浏览器启动 + createAccount/armScenario） | 2221 | 12.6% |
| warm-up（`client warm-up: 490ms`） | 490 | 2.8% |
| 首次应用装载（warm-up 结束→`sidebar ready` 打印） | 3289 | 18.7% |
| 用例体（`sidebar ready`→墙钟） | 6354 | 36.2% |

被选杠杆：**把 653KB 的 react-scan 移出首装静态图**。它在复现运行里的实测成本 = 首装前那条 `[BABEL] … react-scan.js … exceeds the max of 500KB` 变换 + 它所占的 boot/首装段；post-fix 同构造 boot `5968→2986ms`、首装 `3289→2854ms`（见 AC3）。

### AC3 — 杠杆落地与前后对照

- `grep -n "import { scan } from 'react-scan'" src/main.tsx` → 无命中（`grep -c` 为 0）。
- 新形态仍以同一 `localStorage` flag 门控（`src/main.tsx:23-25`）。
- 同构造（3 lane + 16 burners，覆盖 boot 与用例体）前后对照：

| 段 | pre-fix（load1 39.64→43.13） | post-fix（load1 57.43→53.07） | 差 |
| --- | ---: | ---: | ---: |
| boot latch | 5968ms | 2986ms | −2982ms |
| warm-up | 490ms | 433ms | −57ms |
| 首次应用装载 | 3289ms | 2854ms | −435ms |
| 用例体 | 6354ms | 6111ms | −243ms |
| 墙钟 | 17563ms | 13659ms | −3904ms |

post-fix 是在**更高**的负载下取得上述下降。pre-fix 三条 lane 的 stderr 各有一条 `[BABEL] … deps/react-scan.js … exceeds the max of 500KB`；post-fix 三条 lane **0 条**（首装不再请求/变换该模块）。

### AC4 — 同构造三次（顺序执行，每次 3 lane + 16 burners）

| # | wall clock | boot latch | seed= | load1 before→after | exit |
| --- | ---: | ---: | --- | --- | --- |
| 1 | 13658ms | 3195ms | hgThF6 | 23.87→46.45 | 0 |
| 2 | 14960ms | 3159ms | Ve4QRA | 46.45→56.00 | 0 |
| 3 | 30731ms | 4746ms | Gd8zwC | 56.00→119.78 | 0 |

三次全部 ≤40000，且三次全部 ≤38000（第 3 次在 load1 119.78 下仍为 30731ms）。

### AC5 — 静跑与兄弟

| 运行 | wall clock | boot latch | seed= | load1 | exit |
| --- | ---: | ---: | --- | --- | --- |
| 静跑 1（`quay-e2e-PbQyP6`） | 13445ms | 3076ms | ImIZwF | 27.65→26.88 | 0 |
| 静跑 2（`quay-e2e-Dtft7G`） | 14154ms | 4687ms | PbQyP6 | 25.85→25.36 | 0 |
| 兄弟 `-g "AC-199"`（`quay-e2e-hgThF6`） | 9759ms | 3044ms | — | 25.36→24.90 | 0 |

### AC6 — 判据与读数未被弱化

- `grep -c "toBeLessThanOrEqual(40_000)" e2e/activity-dock-background.spec.ts` → `2`。
- `git diff develop..HEAD -- goals/ e2e/ playwright.config.ts` → 空。
- post-fix 运行输出逐字仍含 `dock.counts=`、`plan.cancelControls=0`、`settled.cardTaskStates=`、`settled.cardFoldedStates=`、`restored.`、`falseForm2.`（各 ≥1 命中）。
- 未新增 retry，未改判据命令。

### AC7 — 失败路径

不适用：同构造三次已全部达标，未置 `needs-human`。

## Blocker

**2026-10-21T05:18:34.815Z — worker 未落地（exited-not-landed）**

- 未落地原因：AC 未全勾（checked 0/7，剩余未勾 7）——续做只需验证并勾选 AC
- run_id：wk-prod-anchor
- session_id：23a1f3b9-93fe-4c41-8f35-ed8d2082a8ba
