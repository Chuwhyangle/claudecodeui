---
id: gap-ac345-client-root-serves-live-checkout-hmr
title: AC-345 判据红：client webServer 无 cwd、Vite 直接服务主检出，fan-in ff 写
  src/shared/api.ts 即触发 HMR 整页重载打断在跑的 case——把 client 源码根换成 run-scoped 真拷贝快照
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-345
---
## Proposal

**机制（不是症状）**：`playwright.config.ts` 的第二个 `webServer`（client / Vite）**没有声明 `cwd`**，Playwright 因此以 config 所在目录（主检出 `CONFIG_DIR`）为 root 启动 `vite`；第一个 `webServer`（应用 server）有 `cwd: envFreeServerRoot`。现有一切隔离只做了 server bundle 与 per-run `VITE_CACHE_DIR`，**没有做 client 的源码树**。quay 的 criterion 就在主检出里跑（gate 事件的 `evaluationRoot=/data/home/yale/work/claudecodeui`），而 fan-in 的 `ff` 步骤按设计往同一个主检出写 `src/`：一次 landing 就会在正在跑的用例中途触发 Vite HMR；对 `src/shared/api.ts` 这类非 self-accepting 模块，更新冒泡到入口并**整页 reload**（JSON 模块是 self-accepting，locale JSON 当探针不会动页面——本轮实测确认：07:08:06Z 追加 en/`codeEditor.json`，页面无任何反应，8 个 case 照跑）。

**本轮红与直接复跑**：
- 红：gate event `4982fc93-2560-4840-b3aa-d28b1d4c9209`，2026-10-21T07:01:50.076Z，`verdict=fail`、exit 1，`treeSha 0733726…`（= `4cb7c9bbc` 的树；与现 develop 树的差异只在 `goals/*.md`，spec 与 server 代码是同一份）。
- 同一棵树的直接复跑（无并发写入）：`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-intent-control.spec.ts` → `8 passed (1.6m)`，exit 0（07:03Z）。
- 时间线：run 的首个 `[WebServer]` 行 07:00:47.932Z；并发 fan-in `gap-files-tab-unfiltered-decouple-index` 的 `ff` 在 **07:01:16.572Z**（`.quay/fan-in-gap-files-tab-unfiltered-decouple-index-wk-prod-anchor.log` 逐字），其 delta 含 **`src/shared/api.ts`** 与 `src/modules/file-tree/hooks/*`；gate 在 07:01:50.076Z 记红，相差 33.5s ≈ 一次 30s 可见性等待 + teardown。该红在约 62s 内结束，远低于本文件 360s 的 run ceiling ⇒ watchdog 没触发，红在 case 内。

**判别实验（本轮两臂都跑了，探针文件跑后已 sha256 复原）**：run 进行到 case 6 时（07:09:15Z）向 run 所服务的 checkout 的 `src/shared/api.ts` 末尾追加一行注释 ⇒ **同一秒** Vite 输出 `ws proxy error: write EPIPE` 与 `ws proxy socket error`；case 6 在 41.0s 红：`Error: the client must report the malformed call as recoverable`，摘要 `5 passed / 1 failed / 2 did not run`，exit 1。对照臂（同一文件、不动 checkout）`8 passed`、exit 0。探针前后用备份 `cat` 还原并 `sha256sum` 比对一致（`src/shared/api.ts` `de112a0b…`，`codeEditor.json` `e2d096fb…`），工作树复原（主检出只剩既有的未跟踪 `experiments/voice-tse-eval/*`）。

**既往修复为何没兜住**：`gap-ac345-run-ceiling-crossed-under-fanin-suite-load` 把本文件预算抬到 360s，只兜整轮 watchdog；`7b00fe6c0` 的有界 reload 只覆盖 `openSession` 的导航，导航之后的中途重载不在其内；`gap-ac345-omission-fill-race-and-loaded-criterion-budget` 修的是 case 4 的顺序。同族 `gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout` 已归因同一机制，但当时的 remedy 是「别在判据跑时保存主检出」——对 fan-in 的自动 `ff` 不成立，因为它就是往主检出写。

**方向**：给 client `webServer` 一个 run-scoped 源码根。在 config 求值时把 Vite 要服务的树做一份**真拷贝**（不是 `cp -al` 硬链接：硬链接下主检出的原地写会穿透，本轮探针正是原地写；`src/` + `public/` + 根配置约 11M，或 `git archive HEAD` + 必要未跟踪文件）到一个 run 目录，`webServer.cwd` 指向它，`node_modules` 用符号链接（沿用 `envFreeServerRoot` 的形态）。快照读的是**起跑瞬间**的树，判据语义不变。voice selection 下可与 server 的 shadow 同源，但 shadow 现在是 `cp -al`，需要真拷贝；`.env` 缺失时 `envFreeServerRoot` 直接返回 `CONFIG_DIR`，隔离同样不成立，需一并处理。不改任何用例断言/读数、不加 `test.skip`、不放宽 `expect` 预算。

<!-- dedup-ref -->
同族参考（只作追溯，非前置）：`gap-ac345-run-ceiling-crossed-under-fanin-suite-load`、`gap-ac175-criterion-red-is-mid-run-hmr-of-live-edited-main-checkout`、`gap-ac171-criterion-red-is-mid-run-hmr-load-stabilize`。

## AC

- [x] AC1 红臂（改前，能取假）：脚本化探针在判据跑到第 6 个 case 之后（以 log 出现 `✓  5 ` 或 `reading.refusedQueueWords` 为触发）向**本 run 所服务的 checkout**（playwright config 的 `CONFIG_DIR`）的 `src/shared/api.ts` 末尾追加一行注释；`DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-intent-control.spec.ts` 退出非 0，贴出 Playwright 的失败 case 名与首条断言，以及同一秒的 Vite `ws proxy` 行；跑后还原并贴 `sha256sum` 一致的读数。本轮已有一条同形读数（case 6 41.0s `the client must report the malformed call as recoverable`，exit 1），worker 须在自己的树上重取。
- [x] AC2 隔离臂（改后）：同一探针、同一命令 exit 0 且 `8 passed`；贴输出。控制臂：把 client root 临时退化回 `CONFIG_DIR` 时同探针必须仍红——绿来自隔离，不是探针失效。
- [x] AC3 快照免疫原地写：run 打印 client root（形如 `[e2e] client-root=<abs>`）；探针写主检出后，`sha256sum <client-root>/src/shared/api.ts` 与备份一致（硬链接实现下此断言会红，正是要挡的）；同时贴出 `<client-root>` ≠ `CONFIG_DIR` 的读数。
- [x] AC4 清理：run 结束（绿/红/异常任一路径）后 client 快照目录被删除；`ls <parent> | grep -c envfree`（或 client-root 父目录的计数）与运行前读到的数相同。
- [x] AC5 回归与不变量：无并发写入时 `DASHSCOPE_API_KEY= npx playwright test e2e/voice-realtime-intent-control.spec.ts` exit 0、`8 passed`；`git diff $(git merge-base develop HEAD)..HEAD -- e2e/voice-realtime-intent-control.spec.ts` 不含任何 `expect(` / `timeout:` 数值改动；`node --test scripts/e2e-client-root.test.mjs` exit 0。

## DoD

真实落地：在最终 HEAD 上跑通 AC1 的红臂与 AC2/AC3 的绿臂，读数落盘（运行输出、client-root 路径、sha256 比对）；一次真实 fan-in 窗口内（并发 `ff` 往主检出写 `src/` 时）`goal_gate AC-345` 读 pass（或 `.quay/gate-events.jsonl` 新增一条 AC-345 `verdict=pass`）；快照在绿/红/异常三条路径都被清理；读数的 `cloud.strayHosts=[]`、`cloud.webSockets=[]` 不变。失败路径：若真拷贝成本或 Vite root 语义使隔离不可行，置 `needs-human` 并附两臂读数与已试杠杆。

## Touches

- `playwright.config.ts`（client `webServer` 的 `cwd`/root 改为 run-scoped 快照；发布 `[e2e] client-root=` 读数）
- `scripts/e2e-client-root.mjs`（新增：快照的创建/清理/路径解析）
- `scripts/e2e-client-root.test.mjs`（新增：快照对原地写免疫、清理覆盖绿/红/异常）
- `tasks/gap-ac345-client-root-serves-live-checkout-hmr.md`（自触）

## Notes

实现在 `scripts/e2e-client-root.mjs`：`resolveClientRoot` 在 config 求值时把 `src/`、`shared/`、`public/` 与 Vite 读的根配置文件真拷贝到检出根**兄弟目录**（`.<checkout>-clientroot-XXXXXX`），`node_modules` 走符号链接；首个求值者经 `QUAY_E2E_CLIENT_ROOT` 发布路径，worker 复用；`exit`/SIGINT/SIGTERM/SIGHUP 清理；`QUAY_E2E_CLIENT_ROOT=off` 为控制臂（`removeClientSnapshot` 只删带 marker 名的目录，控制臂不可能删到检出）。client `webServer` 现在 `cwd: clientRoot`；`mcp-settings` 单文件选择不启动该对 server，故跳过快照。

读数（worktree `…-worktrees/gap-ac345-client-root-serves-live-checkout-hmr`，日志 `/tmp/ac345-probe/`）：

- AC1 红臂（未改的 develop `15ef1ccd6`，`red-arm-pristine-pass5-d4.log`）：触发 `✓  5` 后 4s 写 `<tree>/src/shared/api.ts`，写入时刻 `2026-10-21T07:24:01.946Z`；同一秒 Vite `[WebServer] 3:24:02 PM [vite] ws proxy error: Error: write EPIPE`（及 `ws proxy socket error`）；失败 case `✘ 6 … a malformed function call during a correction is recoverable and the next correction still delivers (22.8s)`，首条断言 `Error: the client must report the malformed call as recoverable` / `Expected: >= 1` / `Received: 0`；`1 failed / 2 did not run / 5 passed (1.3m)`，exit 1；还原后 `sha256=de112a0b7317828c964342d37c6c91296d918c7506b1ef2e141c45f00a2655ed matches=true`（写前 `nlink=1`）。
- AC2/AC3 绿臂（最终 HEAD，`green-arm-final-head.log`）：同一探针 `reading.refusedQueueWords` 触发，`8 passed (1.6m)`，exit 0；`[e2e] client-root=/data/home/yale/work/claudecodeui-worktrees/.gap-ac345-client-root-serves-live-checkout-hmr-clientroot-uSEYlo config-root=/data/home/yale/work/claudecodeui-worktrees/gap-ac345-client-root-serves-live-checkout-hmr`（`distinct=true`）；写主检出后 `served-copy sha256=de112a0b… matches-backup=true`。以 `✓  5`+4s 触发的绿臂（`green-arm.log`）同样 `8 passed`、exit 0。
- AC2 控制臂（最终 HEAD，`control-arm-refused.log`，`QUAY_E2E_CLIENT_ROOT=off`）：同一探针 `✘ 5 … Test timeout of 120000ms exceeded`，`1 failed / 3 did not run / 4 passed (2.8m)`，exit 1；`served-copy sha256=4d6c57a3… matches-backup=false`（读到的就是被写的检出本身）。
- AC4：绿臂 `post-run client-root-exists=false`、父目录 `*clientroot*` 计数 `before=0 after=0`；真实红路径（`playwright test … -g no-such-case-ac345` → `Error: No tests found`，exit 1）同样 `before=0 after=0`；异常路径由 `scripts/e2e-client-root.test.mjs` 的真实子进程用例（exit 0 / exit 1 / uncaught throw）覆盖。
- AC5：最终 HEAD 无写入跑 `8 passed (1.6m)`、exit 0，`cloud.dialed=1 cloud.strayHosts=[] cloud.webSockets=[]`；`git diff $(git merge-base develop HEAD)..HEAD -- e2e/voice-realtime-intent-control.spec.ts` 为 0 行；`node --test scripts/e2e-client-root.test.mjs` → `tests 9 / pass 9 / fail 0`，exit 0；`tsc --noEmit -p scripts/tsconfig.json` exit 0。
- fan-in 窗口内的 `goal_gate AC-345` 读数由 driver 的 mechanical fan-in 在合并后取得（本 worker 不跑 suite / fan-in）。
