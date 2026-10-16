---
id: AC-397
title: 生产装配守护：server/index.ts 在模块顶层、先于监听，把 sessionHostManager 的 turn opener 与
  unattended opener 接到 chatRunRegistry，且装配表达式真能开出 run
status: active
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/shared/tests/composition-root-wiring.test.ts
expect: 读数——(a) 结构读数（TypeScript AST，不是文本 grep；注释里提到这些名字不算）：解析
  server/index.ts，必须在模块顶层（不在任何函数、条件、try 之内）各有恰好一条表达式语句
  `sessionHostManager.setTurnOpener(<箭头函数>)` 与
  `sessionHostManager.setUnattendedRunOpener(<箭头函数>)`；箭头函数恰有一个形参，函数体是对
  `chatRunRegistry.openTurn` 或 `chatRunRegistry.openUnattendedRun`
  的单次调用，并把该形参原样作为唯一实参（不是桩、不是丢弃输入）。打印 `wiring turnOpener=<line>
  unattendedOpener=<line>`；立案时实测分别在 index.ts:1063 与 :1054。(b)
  先于监听：这两条语句在源码顺序上都先于 index.ts 里全部 `.listen(` 调用（立案时 :1909，在 startServer
  之内），且自身不在 startServer 之内；它们在模块加载时执行，而 startServer() 在文件末尾（立案时 :2019）才调用。(c)
  行为读数（装配的是真的）：取出 index.ts 里这两个箭头函数的源码文本，经 ts.transpileModule 转成
  JS（将来加类型标注也不会失效），绑定到一个隔离的 `createChatRunRegistry()` 实例，装进一个新的
  `createSessionHostManager()`；经 manager 自己的 `openTurn({appSessionId,
  provider:'claude', providerSessionId:null, userId:1, kind:'delivered',
  deliveryIds:[…]})` 取得 `{runId, writer}`，且该注册表里 `getRunById(runId)` 为 running；经
  manager 的 `openUnattendedRun` 取得 writer，且注册表出现 source=unattended 的
  run。反向对照：没有装配的新 manager 上 `openTurn` 与 `openUnattendedRun` 都返回 null——manager
  的设计就是静默返回 null，所以删掉装配不会报错，只会让 run=turn 永远开不出 run，这正是本条要钉住的。(d)
  取假形态，全部在内存源码上做，不改仓库文件：把 index.ts 里的 setTurnOpener 语句删除 ⇒ (a) 红；把它挪进 `if
  (process.env.X) { … }` ⇒ (a) 红；把它改成注释 ⇒ (a) 红；箭头函数改成 `() => null` 或丢弃形参 ⇒ (a)
  红且 (c) 红；把它移进 startServer 函数体或放到 `.listen(` 之后 ⇒ (b) 红。对
  setUnattendedRunOpener 同形各做一遍。(e) 本条读的是真实 index.ts
  的结构并执行其中的装配表达式，不依赖服务正在运行；它不证明部署状态或开关取值——那是部署读数，不属于判据。(f) 单文件单次运行 < 20s。⚠️
  当前必红：该测试文件 server/shared/tests/composition-root-wiring.test.ts 不存在。
origin: 2026-10-17 用户在会话「LiveWire 第一次测试会话的 Working… 状态」（transcript
  1d9b5177-b11a-4bda-894f-ec522fad82c0）中指示：新增一条判据，断言 index.ts 装配了
  setTurnOpener，并激活。依据：GOAL-045 达成后的接线检查（本会话）做了变异实验——在临时 worktree 里删掉
  server/index.ts:1063 的 sessionHostManager.setTurnOpener(...) 一行，AC-382 的
  chat-run-turn-semantics 与 AC-384 的 processing-single-writer
  两条判据仍全绿，因为它们在测试里各自调用 setTurnOpener，没有任何判据读取或执行真实的 composition root；而
  manager.openTurn 在未装配时静默返回 null，所以误删这一行不会报错，只会让 run=turn 在生产里永远开不出 run。对照：无人
  turn 的 setUnattendedRunOpener
  只有一处读数式的守护（claude-resident-unattended-turn.test.ts 读 index.ts 那一行打印），且不执行它。关联
  docs/proposals/resident-delivery-turn-ledger-SPEC.md §6.1、§12 S2。
activatedAt: 2026-10-16T17:17:37.893Z
statusLog:
  - at: 2026-10-16T17:17:37.893Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
fidelity:
  verdict: faithful
  reason: "fidelity judge: faithful"
  at: 2026-10-16T17:17:37.892Z
---
