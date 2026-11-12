---
id: gap-ac447-codex-app-server-child-bounded-stop
title: AC-447 判据：Codex app-server 子进程组有界停止，消除 CODEX_HOME 拆除竞态
status: ready
labels:
  - gap
  - defect
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-447
---
## Proposal

**现象与读数（本立案轮实测，不是 ledger 尾巴）。** AC-447 的 criterion 是 `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/session-edit-continuity.test.ts`。`.quay/gate-events.jsonl` 里同一棵树 `treeSha=71db8ef01e5d413dcb076d5cb2cdc9edc180caee` 在 2026-11-12 连续被判 5 次：21:01:05 fail、21:02:31 pass、21:04:46 pass、21:06:29 pass、21:08:44 fail（criterionHash `e9f59deab6fa33dd`）。两次 fail 是同一条用例 `Codex resident: the old host is closed before the real fork, and the replacement continues on the new binding`，报错 `ENOTEMPTY: directory not empty, rmdir '/tmp/session-edit-continuity-<id>/.codex'`。本轮在 TaskStart 树上直跑原命令：顺序 10/10 exit 0；4 份并发 × 3 轮 12/12 exit 0（host load1≈16 / 128 核）⇒ 不是功能回归，而是拆除窗口里的负载相关竞态；空闲时几乎不触发，所以上一轮验收没看见。

**根因（实测进程树，打包 CLI 0.166）。** `server/modules/providers/list/codex/app-server/codex-app-server.client.ts` 的 `withAppServer()` 在 `finally` 只做 `reader.close(); child.kill()`（337-338 行）。实测进程树：直接子进程 `codex app-server`（`bin/codex.js` 在 Node 24 上 `execve` 成原生二进制，保留 pid）→ `git -c safe.bareRepository=explicit ls-remote https://github.com/openai/plugins.git HEAD` → `git remote-https` → `git-remote-https`。向直接子进程发 SIGTERM 后直接子进程 ≤20ms 退出，但 plugins 同步的 git 链被重新挂到别的父进程继续存活 0.4–1.0s（探针读数：t+20/174/447ms `surviving=[git…]`，t+1031ms `surviving=[]`），期间在 `$CODEX_HOME/.tmp/plugins-clone-*`、`plugins.sync.lock` 等路径写/删。`withScenario()` 的 `finally` 用 `rm(home,{recursive:true,force:true})` 拆同一个 `$home/.codex`；遍历完 `.codex` 到 rmdir 之间只要有新条目出现就 ENOTEMPTY。启动时 `$CODEX_HOME` 会写入 95 个条目（四个 sqlite 及其 -wal/-shm、`skills/.system/**`、`.tmp/plugins-clone-*`、`installation_id`），所以 `.codex` 根一直是活写目标。

**为什么上一轮的修复没兜住。** `gap-session-edit-continuity-e2e`（done）交付了这个跨模块判据与有界入口，但它的 Codex 两臂走真实打包 CLI 的 `thread/fork`，正落在 `withAppServer()` 的 fire-and-forget `child.kill()` 上：只杀直接子进程、不等退出、不杀进程组。空闲宿主上 git 链在断言与历史读取期间就结束了，验收绿；goal sweep 并发跑门时窗口被拉长，同一棵树就红。保证本身没变，是「判据可复现地绿」没有成立。

**去重与粒度（本轮实测）。** `grep -l '^goal_ac: *AC-447' tasks/*.md` → 只有 `gap-session-edit-continuity-e2e`，status `done`；无 todo/ready/needs-human 认领该 AC ⇒ done 不是重复，按机制立新任务。机制关键词 `ENOTEMPTY|app-server.*(kill|child|exit)` 无在飞命中；相邻但不同机制的 `gap-ac440-codex-app-server-protocol-gate`、`gap-ac441-codex-resident-host-lifecycle`、`gap-codex-resident-closehost-orphans-other-sessions` 均 `done`。`task-granularity-advice.js --root /data/home/yale/work/claudecodeui --touches <计划的四个源/测试文件> --json` → peers=[]、mentions=[]、reasons=[] ⇒ 无合并候选，separate。本任务不改渲染/历史读侧，浏览器故事与 sealed 证据不重发（见 DoD 的残留下限）。

**修复方向。** 把 spawn/stop 抽成 `codex-app-server-process.ts` 工厂：`detached: true` 起独立进程组；`stop()` = 组 SIGTERM → 有界轮询组内是否清空（`process.kill(-pid, 0)`）→ 未清空则组 SIGKILL → 再等；幂等，返回 `{ groupEmpty, escalated }`。`withAppServer()` 的 `finally` await `stop()`。调用方拿到 fork/read/model-list 结果时，CLI 进程组已空，`$CODEX_HOME` 不再有后续写入者。

## Plan

1. 新增 `server/modules/providers/list/codex/app-server/codex-app-server-process.ts`：工厂 `startCodexAppServerProcess(launcher, args, { env, cwd, graceMs, killMs })`，返回带 `pid`/`child`/`stop()` 的 owner；状态在闭包内，无模块级可变绑定。`stop()` 幂等；Linux 用 `process.kill(-pid, signal)`，非 POSIX 平台退回 `child.kill()` 并在结果里标注 `groupStop: false`；组清空判定用 `process.kill(-pid, 0)`（ESRCH 即清空），再以 `Number.MAX_SAFE_INTEGER` 的有界轮询等待，绝不裸 await 永不 settle 的 promise。SIGTERM 宽限（建议 750ms）后升级 SIGKILL，再 750ms 上限；超限返回 `groupEmpty:false` 供调用方记诊断，但不把成功的 fork 结果改成失败。
2. 改 `codex-app-server.client.ts`：`spawn(...)` 改为经工厂启动（保留 `spawn(process.execPath,[launcher,'app-server',...])` 的启动形态与 env/cwd 语义，加 `detached:true`）；`finally` 中 `reader.close()` 后 `await stop()`，删除裸 `child.kill()`。JSON-RPC、超时、错误包装语义保持不变。
3. 新增判据 `server/modules/providers/tests/codex-app-server-process.test.ts`，四臂见 AC-2。负向对照臂用同一夹具走裸 `child.kill()`，断言孙进程仍存活，证明正向断言有区分力；真实产品臂用临时 `CODEX_HOME` 调 `codexAppServer.listModels()`（打包 CLI 已装则非 null），返回后按 `/proc/<pid>/environ` 扫残留。JSDoc/注释里不要写出会提前闭合块注释的路径写法。
4. 判据与拆除复验：原 criterion 连续与并发跑（AC-1）；若仍出现 ENOTEMPTY，继续沿进程树定位，⛔ 不得只给 `rm` 加 `maxRetries` 或 skip 用例冒充完成。
5. 有界回归与静态门：AC-4/5/6。新增测试文件会改变 server 测试收集数，按既有规则同步 `scripts/suite-duration-baseline.tsv` 与 `server/shared/tests/quay-test-script.test.ts` 的两条 unknown pin（用合并后实测值）。
6. 若 `codex-message-editing.test.ts` / `session-edit-real-cli.test.ts` 的临时 home 拆除也需同样的有界化，先经 task_write 把对应文件补进 Touches 再改；不改 `codex-app-server.connection.ts` 的同步 `terminate()`（长驻 host close 不在本判据路径），在 Evidence 记为同类残留与后续候选。
7. Evidence 描述证据分层：合成探针/单测、真实打包 CLI 产品臂、真实 criterion 重复与并发读数；贴命令、逐次 rc、load1 与耗时。浏览器/场景本任务不重发，理由写清楚（不改渲染/历史读侧；sealed 证据仍属上一轮），不得用一个旧报告或 skip 声称新的浏览器达成。

## AC

- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/websocket/tests/session-edit-continuity.test.ts` exit 0；连续 10 次全部 exit 0；再 4 份并发 × 3 轮（12 次）全部 exit 0；任一输出不得含 `ENOTEMPTY`。贴命令、逐次 rc、load1 与单次耗时。
- [ ] `npx tsx --tsconfig server/tsconfig.json --test server/modules/providers/tests/codex-app-server-process.test.ts` exit 0，且含四条可区分臂：(a) 组内孙进程随 `stop()` 一起消失，返回瞬间逐个断言 `/proc/<pid>` 不存在；(b) 忽略 SIGTERM 的子进程在有界期限内被升级 SIGKILL，结果为 `escalated===true` 且进程已消失；(c) 负向对照：同一夹具改用裸 `child.kill()`（旧行为）后孙进程仍存活，随后再用组 `stop()` 清理；(d) 产品臂：临时 `CODEX_HOME` 上调用 `codexAppServer.listModels()` 返回后，`/proc/<pid>/environ` 中含该 `CODEX_HOME=` 的进程数为 0，且对该 home 的一次 `rm(recursive)` 成功、无重试。
- [ ] 负向控制（源码级）：临时把 client 的 `finally` 还原成旧的 fire-and-forget，重跑 AC-2(d) 与 AC-1 判据并记录红读数；随后逐字节还原并复绿。两次读数都贴。
- [ ] 相关单文件有界回归逐条执行并贴 pass/fail：`codex-app-server-protocol.test.ts`、`codex-message-editing.test.ts`、`session-edit-real-cli.test.ts`、`codex-session-fork.test.ts`、`codex-host-driver-persistent.test.ts`、`chat-edit-preparation.test.ts`、`chat-edit-send.test.ts`（后两者用本仓既有路径；存在即跑，命令写全）。
- [ ] `bash scripts/with-memory-cap.sh npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/architecture-ratchet.test.ts` 6/6、`server/shared/tests/server-import-cycle-budget.test.ts` 12/12、`server/shared/tests/quay-test-script.test.ts` 全绿；新增测试文件已按实测更新 `scripts/suite-duration-baseline.tsv` 与两条 unknown pin。
- [ ] `npm run typecheck`、`npm run lint`、`npm run build` 均 exit 0（贴尾部输出）。

## DoD

真实落地以「旧行为能复现的残留在新行为下消失」为准，不以文件存在或静态字符串判绿：AC-2(c) 的裸 kill 臂必须真的留下孙进程，AC-2(a)/(d) 必须真的把它清零；AC-1 的 criterion 必须在负载下仍绿（记录 load1、逐次耗时，不用单次空闲绿代替）。生产代码经工厂组合，状态在 owner 内，跨模块只走 barrel，新文件远低于 800 行棘轮且无模块级可变绑定。不改 `codex-app-server.connection.ts` 的同步 `terminate()`，在 Evidence 明确写为同类残留 + 后续候选，不声称已修。浏览器与场景：本任务不改渲染、历史读取或 wire，AC-447 的浏览器与场景证据仍以 `gap-session-edit-continuity-e2e` 的 sealed 证据为准，本任务不重发也不冒充新的浏览器达成；若执行者选择重跑，只能用隔离实例与自建 seed，不得改活库或重启承载用户会话的共享实例。证据分层写清（合成探针 / 真实打包 CLI / 真实 criterion），命令与读数逐条贴出。

## Touches

- server/modules/providers/list/codex/app-server/codex-app-server-process.ts
- server/modules/providers/list/codex/app-server/codex-app-server.client.ts
- server/modules/providers/tests/codex-app-server-process.test.ts
- server/modules/websocket/tests/session-edit-continuity.test.ts
- server/modules/providers/tests/codex-message-editing.test.ts
- server/modules/providers/tests/session-edit-real-cli.test.ts
- scripts/suite-duration-baseline.tsv
- server/shared/tests/quay-test-script.test.ts
- tasks/gap-ac447-codex-app-server-child-bounded-stop.md

## 约束

遵守 AGENTS.md 与 `.agents/skills/backend-module-standards/SKILL.md`：工厂 + 注入、状态封装在生命周期 owner 内、无模块级可变状态、跨模块只走 barrel、单文件约 260 行上限（新文件保持小）。只在会话内跑单文件或有界 runner，不跑全量 suite（fan-in 承担）。不新增 provider id 分支，不动 `providers/list/` 之外的边界。不得用 `rm` 重试、skip 或用例删除掩盖竞态；只改测试不改生产进程生命周期视为未完成。不重启共享实例、不修改活会话 transcript 或线上库。
