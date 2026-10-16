---
id: AC-394
title: 依赖环预算：server/ 非测试代码的目录级 import 图（静态加字面量动态）里，非平凡 SCC
  的成员集合不得超出现有三组（11/2/2），新增目录只许 import shared 与自己，server/shared 对 modules 零入边
status: active
kind: criterion
goal: GOAL-045
criterion: npx tsx --tsconfig server/tsconfig.json --test
  server/shared/tests/server-import-cycle-budget.test.ts
expect: 读数——(a) 扫描器：对 server/ 下全部非测试 .ts/.tsx（排除 /tests/ 与 *.test.ts），用
  TypeScript 取静态 import、export-from，以及**字面量**说明符的动态 `import()`（AST 取调用；`import
  type` 同算），解析 `@/` 别名与相对路径（`.js`→`.ts`、目录 index），节点为文件所在目录，边为跨目录的 import，Tarjan
  求强连通分量；打印 `files=<n> staticEdges=<n> dynamicEdges=<n> sccs=[<size>…]`。(b)
  基线（立案时在当前树与 GOAL-045 之前的 976ef03b1 上实测一致，AC-385 落地后复测不变，且与 archguard 0.1.40 的
  detect_cycles 逐成员相同；仅静态与静态加字面量动态两种口径得到同一结果，文件级已解析边 1246 与 1252）：三组非平凡 SCC——11
  个成员 {modules/mcp-gateway, modules/projects, modules/projects/services,
  modules/providers, modules/providers/list/claude, modules/providers/services,
  modules/session-hosts, modules/voice, modules/voice-realtime,
  modules/websocket, modules/websocket/services}；2 个成员 {modules/database,
  modules/database/repositories}；2 个成员 {server 根目录,
  modules/browser-use}。断言：每个非平凡 SCC 的成员集合都包含于上述某一组，只许缩小，不许新增成员，不许合并两组。(c)
  新目录规则：基线目录清单入库（立案时 46 个节点）；任何不在清单里的新目录，其 import 目标只许是 server/shared/**
  与它自身，对其它 server/modules/** 零入边零出边（求值叶子）。(d) shared 叶子断言（单独一条，不把 shared
  当普通目录默认安全）：**server/shared**（注意不是仓库根的 shared/）下全部非测试文件对 server/modules/** 的
  import（含动态）为 0；立案时实测为 0。(e) 非字面量动态说明符：只允许出现在点名的一处
  modules/voice-realtime/voice-realtime-uplink-vad.ts，该文件内计数不得超过
  1；出现在任何其它文件即红，总数不变也不行。内部说明符未解析数 ≤ 19（基线，只减不增；这 19 个落在环外目录或仓库根 shared/）。(f)
  扫描器防空转自检：已解析的文件级边数 ≥ 1000，且在真实树上复现 (b) 的三组，缺一即红。(g) 夹具（合成小目录树喂同一扫描器）：A→B→A 报出
  SCC；A→B 无环不报；新目录 import 某 SCC 成员报违规；**环外目录经字面量动态 import 回指环内成员（且环内已有静态边指向它）⇒
  该目录被卷入 SCC，判据必须红**，证明扫描器确实解析了动态 import 而不是空转；在 server/shared 里加一条回指 modules 的
  import ⇒ (d) 红。(h) 取假形态（真实树）：把一个环外目录卷入环 ⇒ (b) 红；用后还原。(i) 单文件单次运行 <
  30s。archguard 不是项目依赖（兄弟仓路径），判据不调用它。⚠️ 当前必红：该测试文件不存在。
origin: 2026-10-16 另一 Claude 会话「ClaudeCodeUI 局部重构方案」对 GOAL-045 做架构审视（archguard
  读数 + 代码核对），经本会话逐条核实（含在 GOAL 之前的提交 976ef03b1 上重跑 archguard 的环基线、对 13
  个账本写入点的读码），并经用户在会话中同意新增本条（用户答复「同意。」，针对提议的 A–E 五条 AC）。依据：driver 6193
  行且账本内联其中；RESIDENT_RUN_IS_TURN 在 driver 与 registry 各有一份读取；旧路径尚存；server/ 目录级
  import 图存在 11 成员 SCC（GOAL 之前即存在）。关联
  docs/proposals/resident-delivery-turn-ledger-SPEC.md §4.4 I6、§12、§14。
  2026-10-16 经对方会话对 AC 判据的对抗式复核（别名写绕过前缀计数、账本 delivery 类型夹带 driver 的 round 与
  lease 记账、动态 import 空转风险、shared 的求值叶子断言），并核实代码后修订本条期望文本；基线数字在 AC-385 落地后的 HEAD
  上复测不变。
activatedAt: 2026-10-16T13:42:06.257Z
---
