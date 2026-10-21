---
id: gap-ac194-criterion-pretest-boot-inflation
title: AC-194 判据在并发 e2e 突发下红（Received 43937ms）：≈21.5s 花在 test runner 之前的 boot（静跑
  4.25s），vite 种子已生效、剩余是 tsx server 启动的 CPU 工作——削减 boot 并在同突发下复测 ≤40s
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

**本轮直接测量（不是台账尾巴）。** AC-194 记录 `status: achieved`，其 GOAL-015 已 `achieved`、不再活，且未声明 `long-term: true`，故台账 `gate=goal` 尾部按 CURRENTLY FALSE 交办。本轮 driver 在评估根 `/data/home/yale/work/claudecodeui`（主 checkout，tree `b6ef92c872e8fd28b3781fb8e8cfc68f43e91068`）直跑判据，`2026-10-21T02:51:10.350Z` exit 1，data dir `quay-e2e-D7LyT4`。判据物逐字为 `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"`。

`/data/home/yale/.cache/quay-e2e-tmp/quay-e2e-D7LyT4/test-results/activity-dock-background-a-aeb25-nd-restores-from-a-snapshot/error-context.md` 的 `# Error details` 逐字：

```
Error: the criterion must complete within 40s

expect(received).toBeLessThanOrEqual(expected)

Expected: <= 40000
Received:    43937
```

落点 `e2e/activity-dock-background.spec.ts:444`。**所有产品面读数都通过了**——坞计数、面板四读数、计划三读数、不刷新即变化、重载由快照恢复、卡片读 Task、计划零控件、两条假形态——红的只有最后一条墙钟。⇒ 产品面没坏；红在判据把整轮 `npx playwright test` 的启动也算进 40s 预算。

**同一 checkout、本轮静跑对照。** `bash scripts/with-memory-cap.sh npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"` 在 load1≈46.75（128 核）上 exit 0，自印 `AC-194 wall clock: 21783ms`；`Running 1 test using 1 worker` 出现在 4251ms，Vite 种子 `seed=…/quay-e2e-SIQmsk/vite-cache/deps in 69ms`，`client warm-up: 382ms`，`sidebar ready: 448ms`。⇒ 中等负载下余量约 18s；红是突发下的膨胀。

**红那次的分段（读 trace，不靠推断）。** `quay-e2e-D7LyT4/.../trace.zip` 的 `test.trace` 跨 monotonic 23241.6→46890.6，首行 `wallTime 1792551045634 ↔ monotonic 23241.6`；断言（`spec:444`，页面关闭前的最后一步）约在 monotonic 45600，对应墙钟起点 `QUAY_E2E_RUN_STARTED_AT` ≈ 02:50:24.1，而 test runner 的第一个 hook 在 02:50:45.65。**⇒ 43937ms 里约 21.5s 花在 test runner 开始之前**（npx + config 求值 + 两个 webServer 的 boot + runner 初始化），另有 beforeAll ≈14.3s（createAccount / armScenario / warm-up / goto）与用例体 ≈8s。静跑同段分别约 4.25s / 12s / 6s。⇒ +21.5s 的总增量里约 +17.2s 就是 test runner 之前的 boot（4.25s → ≈21.5s，5 倍）。

**Vite 依赖重优化不是这次的主项。** `quay-e2e-D7LyT4/vite-cache/deps` 里 2334 个文件同一 mtime（10:50:22），`_metadata.json` 与静跑相同：`lockfileHash 00573bde / configHash 1eff4809 / entries 95`；`vite-cache/.quay-e2e-root` 指向主 checkout。种子是成功的。⇒ 上一个任务的种子杠杆在工作；它自己留下的「load-dominating 的 server boot / client poll」残余正是这次的红。

**tsx server 启动的本轮实测。** 同一宿主（load1≈22）直启 `node_modules/.bin/tsx --tsconfig server/tsconfig.json server/index.ts`，`/health` 就绪 **4886ms**；上一任务在安静宿主的读数是 3.7s。这是 pre-test 段里可独立削减的最大 CPU 工作块。esbuild 打包可行性探针：`--bundle --platform=node --format=esm --packages=external --tsconfig=server/tsconfig.json` 用 76ms 产出 2.44MB；但把产物放到 repo 根直跑会以 `Error: Could not resolve server root` 退出——模块 URL 依赖的 server-root 解析必须保留，不能简单搬走入口。

**为什么先前的修复没有兜住。**
- `gap-activity-dock-background-browser`（done）交付产品面与 spec，静跑绿；
- `gap-ac194-criterion-wallclock-load-scaled-fixed-cost`（done）把 AC-194 describe 里固定 25s 探针换成 `warmClientStartup` + 有界 probe，但它的负载臂当年被裁定「本机不可达」，残余移交下一条；
- `gap-e2e-runner-boot-inflation-under-fan-in-concurrency`（done）削的是 Vite 依赖重优化（provenance 选 donor + 原子种子 + `.bin/tsx`），其 AC3 自己记了反例：`on2` 在 load1 160 时 boot 8147ms、与 off2 的 7988ms 持平，原文定性「dominated by server boot and client poll under contention, which the lever does not touch」。那条任务的分辨力口径是 28 路交错批次，达标即 done；**它从未削减 server 自身的启动工作**，所以突发一来（本轮 21.5s pre-test boot）红照旧复发。

**实现面（本条认领）。** 把 test runner 之前的 boot 做成负载不敏感，按实测选杠杆：

1. **先量**：用与先前任务同构的并发构造（多路兄弟 `npx playwright test` lane）复现红/膨胀，记录 `Running 1 test` 之前的分段（npx+config、server 就绪、client 就绪、runner 初始化）与宿主 `load1`；复现不出膨胀就加大 lane 数或降低起点，直到 boot 段 ≥2× 静跑。
2. **削减 server 启动的 CPU 工作**（首选，按 (1) 的读数定）：把 `server/index.ts` 的整图预先打成单文件产物（esbuild bundle，按源码内容 hash 缓存），webServer 用 `node <bundle>` 启动；必须保留 server-root 解析（上面的 `Could not resolve server root` 是已知坑），并让开发态源码仍是唯一事实源（hash 变则重建，⛔ 不得回落到可能过期的 `dist-server`）。
3. **若 (2) 的收益不足**，再在同一次测量里评估其它 boot 工作块（如 Playwright runner / 浏览器启动、client 侧启动），但任何杠杆都必须由「同突发下 boot 段下降」的读数支撑。
4. 全程不改判据命令、不改 `goals/AC-194-…md` 的 `criterion:` / `expect:`、不放宽 40s 上限、不删除或弱化任何一条读数与假形态。

**非目标。** 不改坞 / 面板 / 卡片 / Task 归约 / 活动协议的产品面；不碰 AC-199 的读数与上限；不把 40s 墙钟改成「用例体墙钟」、不加 retry 来掩盖（那是改口径，须人裁定）；不重做已 done 的三个先例任务的产品面。

<!-- dedup-ref --> **去重与粒度读数（本轮实测）。** `grep -l '^goal_ac: AC-194' tasks/*.md` → 2 条：`gap-activity-dock-background-browser`（done，产品面）与 `gap-ac194-criterion-wallclock-load-scaled-fixed-cost`（done，启动探针）；在飞扫描（`^status:` ∈ todo/ready/needs-human 且认领 AC-194）→ **0 命中，无在飞认领者**；两条 done 不是重复，而是「早先修复未兜住」的证据。机制上最接近的 `gap-e2e-runner-boot-inflation-under-fan-in-concurrency`（done，无 `goal_ac`）只削 Vite 依赖重优化，明确不碰 server 启动；本条的机制是 **test runner 之前的启动工作**，与它不同。`task-granularity-advice --touches playwright.config.ts --touches e2e/activity-dock-background.spec.ts --json` → `peers: []`、`mentions: []`，无合并候选。⇒ 单独立案。

## AC

- [ ] AC1 红态与本轮对照机械入档：`quay-e2e-D7LyT4/.../error-context.md` 的 `# Error details` 逐字入档（`Expected: <= 40000` / `Received: 43937`），落点 `e2e/activity-dock-background.spec.ts:444`；同一 checkout 的静跑对照 exit 0 且自印 `AC-194 wall clock: 21783ms`；写明红那次由 `test.trace` 推导的 pre-test ≈21.5s / beforeAll ≈14.3s / 用例体 ≈8s 与静跑 4.25s / ≈12s / ≈6s。
- [ ] AC2 boot 分段读数：在复现构造下记录至少两次膨胀运行的 `Running 1 test` 之前分段（npx+config、server 就绪、client 就绪、runner 初始化）与宿主 `load1`，并证明 boot 段 ≥ 静跑的 2 倍（否则构造没复现，换构造再测）。
- [ ] AC3 杠杆落地：给出被选中杠杆的前后对照（同一构造、同等 `load1` 量级），boot 段可见下降；若选 bundle，入档 bundle 生成耗时、命中/重建判据与 server-root 解析保持方式；`grep` 证明 `goals/AC-194-…md` 的 `criterion:` / `expect:` 与 `e2e/activity-dock-background.spec.ts` 的 40s 断言未被改动。
- [ ] AC4 同突发下判据达标：修复态在同一并发构造下 ≥2 次运行、出货命令逐字不变、exit 0 且 `AC-194 wall clock ≤ 40000`，入档每次 lane 数、`load1`、boot 段与墙钟。
- [ ] AC5 静跑不回归：无 lane 在飞时 ≥3 次 exit 0 且 `AC-194 wall clock ≤ 40000`；同文件兄弟 `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-199"` 一次 exit 0。
- [ ] AC6 未弱化任何东西：`grep -n "toBeLessThanOrEqual(40_000)" e2e/activity-dock-background.spec.ts` 仍命中两处（`:444`、`:922`）；`git diff <base>..HEAD -- goals/` 为空；spec 里 `dock.counts`、`running.tasks` / `running.plans`、`settled.*`、`restored.*`、`plan.cancelControls=0`、`settled.cardFoldedStates` 与两条假形态的读数逐字仍在（没有加 retry、没有改判据命令）。
- [ ] AC7 失败路径如实：若同突发下仍 >40000ms，停手置 `needs-human`，附逐字读数、已试杠杆与排除项；⛔ 不得把静跑通过写成已修。

## DoD

真实落地判据：在能复现本轮红的并发构造（多路兄弟 `npx playwright test` lane，boot 段 ≥2× 静跑）下，出货命令 `npx playwright test e2e/activity-dock-background.spec.ts -g "AC-194"` 逐字不变、≥2 次 exit 0 且自印 `AC-194 wall clock ≤ 40000`；同一修复在无 lane 的静跑 ≥3 次同样 ≤40000，兄弟 `-g "AC-199"` 不回归；40s 上限、判据命令、`goals/AC-194-…md` 与全部功能读数一字未改。杠杆的证据必须是「同构造前后 boot 段下降」的实测，不是静跑通过。

## Touches

- `playwright.config.ts`（webServer 启动命令 / test runner 之前的 boot 侧杠杆与缓存）
- `e2e/activity-dock-background.spec.ts`（判据本体；只在确有必要时改读侧，读数与上限不动）
- `tasks/gap-ac194-criterion-pretest-boot-inflation.md`（自触）
