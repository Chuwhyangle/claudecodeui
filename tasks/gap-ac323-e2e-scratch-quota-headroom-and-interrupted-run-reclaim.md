---
id: gap-ac323-e2e-scratch-quota-headroom-and-interrupted-run-reclaim
title: AC-323 判据红在宿主 XFS 用户配额耗尽（EDQUOT −122，余量 0.49 GiB）：e2e 暂存池 82 GiB 里 98.6%
  是未收尾运行留下的 trace 残留，选择器只读 statfs（仍报 1739 GiB）看不见配额 ⇒ 运行中途写 trace 失败、以「End of
  central directory record signature not found」冒名成 PC
  用例红；把余量读数换成配额余量、按收尾状态分流回收，并把判据三条命令复跑为绿
status: todo
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-323
---
## Proposal

<!-- dedup-ref --> 机制去重读数（本轮立案实测，2026-11-13T03:00Z，checkout `/data/home/yale/work/claudecodeui`，`git rev-parse HEAD` = `8daea217572862dbae2b18dd0e6a04a6b34b04d8`，tree `35d49bc0dfa2949d8c58314b369387194fd65f32`，`git status --porcelain` 为空）：`task_list` 的 `todo` / `ready` / `needs-human` 三个池子各 0 条；`grep -rl '^goal_ac: *AC-323' tasks/*.md` 22 份认领者的 `status` 全是 `done`（最近一份 `gap-ac323-webserver-timeout-not-scaled-with-run-budget`）⇒ 没有在飞认领者，本条按「done 不算重复、是更早修法没兜住」立新条。同族但不同机制的历史条目：`gap-e2e-data-dir-has-no-reclaimer`（AC-153，done：给运行目录加 TTL + 有界清扫）、`gap-e2e-data-dir-lands-on-a-full-root-fs`（AC-122，done：给数据目录的选择加 statfs 余量地板）、`gap-ac153-ledger-red-is-host-quota` 与 `gap-ac175-criterion-ledger-red-is-host-boot-death`（done：配额耗尽在判据启动前冒名成红的归因）。本条认领的是它们都没覆盖的那一格：**回收的尺寸假设与「还剩多少可写」的读数本身都错了** —— 6h TTL × 本轮实测 824 MiB/次 ≈ 80 GiB 稳态（设计时按 ~106 MiB/次估的），且 XFS usrquota 下 statfs 仍报 1739 GiB 可用，把 0.49 GiB 的真实余量藏掉了。

### 一、本轮直接测量：判据不是 UI 退化，是运行中途写盘失败

（1）台账尾部那一拍（`gate=goal`，`2026-11-13T02:50:32.291Z`）逐字：

```
acceptance failed (exit 1) — … [truncated, 14416 chars of stdout omitted] cac0d70efb1bfa4de-c95019001a3e43b94a56-recording34.network' Error: End of central directory record signature not found. Either not a zip file, or file is truncated. 1 failed e2e/voice-realtime-live-session-send.spec.ts:716:3 › voice realtime live session send › PC: entering Live Voice swaps out the composer, captures continuously through Mute and execution, and a send lands with no draft step 3 did not run 15 passed (4.2m)
```

`recording34.network` 是 Playwright trace 的第 34 个分块，报错文案是 yauzl 读一个被截断的 zip 时给出的；三段 spec 共 4 + 8 + 7 = 19 条用例，读数正好是 `15 passed + 1 failed + 3 did not run = 19`。红的那条是 CMD1 的 PC 用例，判据自己的断言（双入口 / 紧凑栏 / 断线）一条都没有跑到失败。

（2）同一棵树上、早 5 分钟的另一次运行留下了真正的错误（`~/.cache/quay-e2e-tmp/quay-e2e-pzBMMW/test-results/*/error-context.md`，两条不同的 spec 目录各一份，逐字）：

```
Error: browserContext._wrapApiCall: Unknown system error -122: Unknown system error -122, write
```

errno −122 是 Linux 的 `EDQUOT`（用户配额耗尽）。失败用例目录 `voice-realtime-live-sessio-21270-nd-lands-with-no-draft-step/` 是空的（没有 `trace.zip`、没有 `error-context.md`），`.last-run.json` 记 `status: "failed"` 和四个 test id ⇒ 写盘在 trace 保存阶段就断了。台账那一拍的失败目录 `quay-e2e-vTcce2` 同形：失败用例目录空、trace 一个字节都没留下。

（3）配额台账与环境读数（2026-11-13T03:00Z 实测）：

```
$ xfs_quota -c 'quota -u yale' /data
Filesystem              Blocks      Quota      Limit  Warn/Time      Mounted on
/dev/vdb             523772148  471859200  524288000   00  [6 days] /data
# 余量 = 524288000 - 523772148 = 515852 KiB ≈ 0.492 GiB

$ node -e "statfsSync(process.env.HOME+'/.cache/quay-e2e-tmp')"   # 选择器的 fsAvailableBytes
statfs-bavail-GiB 1739.2
```

同一个文件系统，选择器读到 1739.2 GiB、配额只剩 0.492 GiB：`DEFAULT_MIN_FREE_MB = 1024`（1 GiB）的地板因此**永远放行**，运行带着不到 1 GiB 的余量开始写一个要 0.8–0.9 GiB 的暂存目录。

（4）暂存池本身（同一时刻）：

```
$ du -sh ~/.cache/quay-e2e-tmp      # 82G
$ ls ~/.cache/quay-e2e-tmp | wc -l  # 118
```

按 `test-results/.last-run.json` 在不在分成两类（本轮实测）：

```
interrupted (无 .last-run.json): n=100 total=82460MB avg=824MB   ← 98.6% 的字节
completed   (有 .last-run.json): n=15  total=1203MB avg=80MB
```

一个未收尾运行目录的构成（`quay-e2e-kzXriM`）：`test-results/.playwright-artifacts-0/traces` = 890 MB 的 `*.network` / `*.trace` 分块、7078 个文件，顶层没有 `.last-run.json` ⇒ runner 在 `onEnd` 之前被杀，Playwright 的正常清理（passing 用例的 trace 删除）一次都没发生。118 个目录里 100 个是这种。

（5）当前回收策略的尺寸（`scripts/e2e-data-dir-retention.mjs` / `scripts/e2e-data-dir-selection.mjs`）：`DEFAULT_RETENTION_TTL_HOURS = 6`、`DEFAULT_RECLAIM_BUDGET_MS = 2000`、`DEFAULT_MIN_FREE_MB = 1024`。6 小时 × 实测约 19 个目录/小时 × 824 MiB ≈ 80 GiB 稳态 —— 这就是池子现在的大小；而回收的年龄判据全部按创建时间，未收尾运行与已完成运行一视同仁，前者才是字节来源。

### 二、机制链与本条的修法

机制链（前四段是读数，最后一段是推断，落地时可在 trace/日志里复核）：配额余量 0.49 GiB → 选择器的 statfs 地板放行 → 运行中写 trace 分块 → 中途 EDQUOT → trace zip 被截断（`End of central directory…`）→ 该用例在 tracing teardown 里报错、worker 随之结束（与队列里 3 条 `did not run` 的读数形状一致）→ CMD1 exit 1、CMD2/CMD3 因 `&&` 未跑。

修法（一条机制，四段）：

1. **先止血**：手工入口 `npm run e2e:reclaim` 新增「收到目标余量为止」的紧急臂（默认关闭），按最老优先回收**已死**目录，报告删除的目录数与字节数；本轮用它在真实池子上把余量与目录数拉回安全区。
2. **余量读数换成可写配额余量**：选择器的地板从「文件系统的 bavail」改为「本用户在该文件系统上还能写多少」——优先读 XFS 用户配额台账（`xfs_quota -c 'quota -u <uid>' <挂载点>`，本机非 root 可读，本轮已实测），读不到时回落 statfs 并把「用了哪一种读数」印在 `[e2e]` 行上；余量 < 地板时在**启动服务器之前**拒绝，文案逐字给出余量、地板与缺口。
3. **回收按收尾状态分流**：`test-results/.last-run.json` 存在 ⇒ 运行已结束，15 分钟即可回收；不存在 ⇒ 运行被杀，60 分钟回收。60 分钟不是拍的：`goals/*.md` 里最大的判据 `timeoutMs` 是 600000 ms（10 分钟，正是 AC-323 自己），60 分钟是它的 6 倍，任何仍活着的 playwright 运行都过不了自己的闸门。两个 TTL 都可被环境覆盖，并在报告里打印。
4. **余量触发清扫**：每次运行前按年龄规则扫一遍后**重读**余量；仍低于地板时按最老优先继续回收（run path 仍受既有预算约束并报告 `budgetReached`），只有候选耗尽仍不足才拒绝。手工入口同一条规则，无预算上限。

取假形态：(a) 把余量读数退回 statfs ⇒ AC2 的「抬高地板必须拒绝」在真实路径上不成立（会放行）；(b) 未收尾目录仍用 6h TTL ⇒ 真实池子回收后仍 ~80 GiB，AC5 的 `du`/配额读数红；(c) 不要「先扫后重读」⇒ 余量不足时直接拒绝或死等，AC4 的余量触发用例红；(d) 为了绿去改判据 spec/删既有用例 ⇒ AC7 的「只允许新增」diff 检查红。

## AC

- [ ] AC1 `node --test scripts/e2e-data-dir-selection.test.mjs` exit 0，且新增用例至少三条，逐字覆盖：`quota-headroom-below-floor`（拒绝文案含余量、地板与缺口字节）、`quota-headroom-above-floor`（接受）、`quota-reading-unavailable-falls-back`（回落 statfs 且 `[e2e]` 行标明读数来源）。
- [ ] AC2 真实配置路径（不是单测）：`QUAY_E2E_DATA_DIR_MIN_FREE_MB=<实测余量+1MiB>` 跑一次真实 `playwright test --list`，exit ≠ 0、输出逐字含配额余量与缺口，且没有任何 `webServer` 启动行；同一条命令把地板设 0 ⇒ exit 0 并打印实际读数来源与余量。
- [ ] AC3 `node --test scripts/e2e-data-dir-retention.test.mjs` exit 0，新增用例逐字覆盖：completed+15min ⇒ selected；completed+5min ⇒ not；interrupted+60min ⇒ selected；interrupted+20min ⇒ not；current-run 永远 excluded；常量断言 `INTERRUPTED_MIN_AGE_MS >= 6 * 600_000`。
- [ ] AC4 余量触发清扫：注入「低于地板」的余量读数 + N 个候选 ⇒ 按最老优先选到余量 ≥ 地板或候选耗尽，run-path 预算仍生效并报告 `budgetReached`；注入健康余量 ⇒ 不越过年龄规则多删（同 `scripts/e2e-data-dir-retention.test.mjs`，exit 0）。
- [ ] AC5 真实池子被拉回安全区：执行紧急臂后逐字贴出 before/after 的 `du -sh ~/.cache/quay-e2e-tmp`、`ls | wc -l`、`xfs_quota -c 'quota -u yale' /data`，要求 after 的 `du ≤ 25G` 且配额余量 `≥ 20 GiB`，并贴出删除的目录数与字节数。
- [ ] AC6 判据三条命令在落地树上真跑并 exit 0：CMD1 `19 passed`；CMD2 贴 passed 数；CMD3 `6 passed`（`@<w> idle` 六格）；每条都贴摘要行与运行打印的 `[e2e]` 余量行。任一条仍红 ⇒ 本条不得 done。
- [ ] AC7 没有放松断言：`git diff <merge-base(HEAD,develop)> -- e2e/voice-realtime-live-session-send.spec.ts e2e/voice-realtime-upload-fixture.spec.ts e2e/voice-realtime-composer-embedded.spec.ts e2e/mobile-workspace-composer-layout.spec.ts scripts/e2e-data-dir-selection.test.mjs scripts/e2e-data-dir-retention.test.mjs` 中删除行（`^-`，去掉 `---` 文件头）为空；两个脚本测试文件里既有 15 + 14 条 `^test(` 全部仍在。

## DoD

- [ ] 判据三条命令在落地树（合入后）真跑：贴 CMD1/CMD2/CMD3 的 exit code、摘要行、`[e2e]` 余量行；不是 stand-in、不是单跑某个用例。
- [ ] 拒绝臂在真实配置上真跑一次（抬高地板）：贴 exit≠0、逐字文案、以及证明 servers 未 spawn（无启动行 / 无端口监听行）。
- [ ] 回收在真实池子上真跑：贴 before/after 的 `du`、目录数、配额台账与删除字节数。
- [ ] 放行臂不是靠把地板调 0 得来的：回收后原样跑一条真实判据命令（默认地板），贴 `[e2e]` 余量行与 exit 0。
- [ ] 断言未放松：贴 AC7 的 diff 检查输出（删除行为空）与新测试文件 `^test(` 计数（≥ 15 / ≥ 14）。
- [ ] 若任一读数是「外面还有别的进程在写配额」之类的环境噪声，写进完成记录并说明它如何被读数排除；不得把未跑的命令记成通过。
- [ ] 完成记录里逐字保留本轮 Proposal 的机制读数与复跑读数，方便下一轮独立复核。

## Touches

- scripts/e2e-data-dir-selection.mjs
- scripts/e2e-data-dir-selection.test.mjs
- scripts/e2e-data-dir-retention.mjs
- scripts/e2e-data-dir-retention.test.mjs
- playwright.config.ts
- tasks/gap-ac323-e2e-scratch-quota-headroom-and-interrupted-run-reclaim.md