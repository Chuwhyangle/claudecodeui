---
id: gap-voice-provider-cycle-port-break
title: 把 modules/voice 拉出 8 成员依赖环：voice-lexicon.ts 对 providers 的动态 import
  改经端口注入（ports 手法 + 复用 AC-394 扫描器判据），voice 出环、环缩为 7
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22，HEAD d6c4d45c77ab）**：机制词 grep `grep -rlE '8.*成员环|初始化环|SCC.*拆|cycle.*(拆|break|ports|叶子)' tasks/*.md` → 命中多条，逐条读：`gap-ac394-server-import-cycle-budget`（done）是**环棘轮**（只测不拆）；`gap-server-provider-websocket-init-cycle-ports`（done）用 ports 拆过 provider/websocket/mcp-gateway/session-hosts 初始化环，是本条**手法样板**但不是同一环；`gap-database-connection-directory-cycle`、`gap-server-root-browser-use-cycle-relocate-mcp-entry`、`gap-mcp-contract-extract` 各拆自己的环。**无一认领「把 modules/voice 拉出当前 8 成员环」**。合并候选（granularity-advice `--touches server/modules/voice/voice-lexicon.ts --touches server/modules/websocket/services/chat-websocket.service.ts`）报 `peers: []` ⇒ **separate**。

### 现状（立案时实测，2026-10-22，archguard server scope 新鲜读数）

- server 唯一目录环 = 8 成员：`modules/projects / modules/projects/services / modules/providers / modules/providers/list/claude / modules/providers/services / modules/voice / modules/websocket / modules/websocket/services`。
- `modules/voice` 在环里只有**两条**边：出边 `voice → providers`（1 处，`server/modules/voice/voice-lexicon.ts:298` 的 `await import('@/modules/providers/index.js')`，只为取 `sessionsService.fetchHistory`）；入边 `websocket/services → voice`（1 处，`chat-websocket.service.ts:21`）。其余出边只到 `database`/`shared`。
- `voice-lexicon.ts` 的注释自述：这条动态 import 是为了避免**模块求值期**闭环（chat dispatch 已使 voice→websocket、providers→websocket），但**字面量动态 import 仍被环扫描器计入**（AC-394 扫描器「import type 同算」、archguard detect_cycles 亦计）——所以它在环里。
- 手法样板已有：`server/shared/ports/*.port.ts`（`installVoiceRulesPort` 等）与 `gap-server-provider-websocket-init-cycle-ports`（done）。

### 改法

把 voice-lexicon 对 providers 的运行时依赖改经**端口注入**：assembly（`server/index.ts`）把 `listHumanMessagesFromSessionIndex` 所需的 `fetchHistory`（或整个函数）经端口注入 voice-lexicon，voice-lexicon 不再 import providers（含动态字面量）。拉出后 `modules/voice` 只剩 `database`/`shared` 出边，退出 SCC，8 成员环缩为 7。**行为保持**：该能力只在 import 路由被调用，注入后语义不变。

⛔ 护栏：端口文件落在 `server/shared/ports/`（既有多成员目录，不新建模块目录）；判据**复用** AC-394 的扫描器（`server/shared/import-graph.ts` 的 `strongComponents` / `collectServerSources`），不另写一份。

<!-- dedup-ref --> 相关但不同机制：`gap-ac394-server-import-cycle-budget`（done）是环棘轮（只测不拆），本条的判据要**复用**它提取出的扫描器；`gap-server-provider-websocket-init-cycle-ports`（done）是本条的 ports 手法样板。两者均不构成本条前置。

## Plan

1. **读边**：确认 `voice-lexicon.ts:298` 与 `chat-websocket.service.ts:21` 是 voice 仅有的两条环边（以当前树为准，若漂移则按实测更新）。
2. **定义端口**：`server/shared/ports/voice-lexicon.port.ts` 暴露 install/uninstall + 取能力函数；assembly 处安装。
3. **接线**：voice-lexicon 改为经端口取能力，删除 providers 动态 import；调用方路径不变。
4. **判据**：复用 AC-394 扫描器断言 `modules/voice` 不在任何非平凡 SCC；AC-394 棘轮自身仍绿。
5. **收口**：既有 voice/websocket 判据单跑仍绿、tsc/lint、collateral、范围受控。

## AC

- [ ] (a) **voice 不再 import providers**：`grep -rn "@/modules/providers" server/modules/voice --include='*.ts'` 计数 = **0**（含动态 `import('@/modules/providers…')` 字面量）；`grep -n "voice-lexicon" server/index.ts` 命中（assembly 安装端口）。
- [ ] (b) **端口存在**：`test -f server/shared/ports/voice-lexicon.port.ts` 退出 0；`grep -q "voice-lexicon" server/index.ts` 退出 0。
- [ ] (c) **判据存在且跑通（voice 出环）**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice/tests/voice-provider-cycle.test.ts` 退出 0；其 import AC-394 的 `strongComponents` / `collectServerSources`（`server/shared/import-graph.ts`），打印 `voiceInAnyScc=false`（并打印每段非平凡 SCC 成员，`modules/voice` 不在其中）。
- [ ] (d) **AC-394 棘轮仍绿**：`npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/server-import-cycle-budget.test.ts` 退出 0（其 G1/G2/G3 逐成员仍包含于基线；若 `modules/voice` 出环使 G1 缩小，属允许的缩小，不属红）。
- [ ] (e) **既有行为判据不改一字仍绿**：`server/modules/voice/tests/voice-lexicon.test.ts` 与 `server/modules/websocket/tests/` 下既有判据单跑、各自退出 0（若 `voice-lexicon.test.ts` 不存在则用等价 voice 判据替换并在完成记录写明）。
- [ ] (f) **静态门**：`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [ ] (g) **collateral**：新增一个 `server/**/*.test.ts` ⇒ 先复量 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（执行时以实测为准），按 `server/shared/tests/quay-test-script.test.ts` 两条计数 pin 各 +1 并改写其上方注释算术；`scripts/suite-duration-baseline.tsv` 仅当 AC7 覆盖率地板跌破 90% 才追加一行；单文件复跑 quay-test-script.test.ts 退出 0。
- [ ] (h) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列。

## DoD

真实落地的标准是「`modules/voice` 真的**退出了目录环**、且退出是经端口注入（不是静默把依赖塞到别处）」，不是「多了一个端口文件」。必须贴出：①(a)(b) 的 grep/test 读数与端口安装行原文；②(c) 判据打印的逐段 SCC 成员与 `voiceInAnyScc=false` 读数（并写明扫描器复用自 `server/shared/import-graph.ts`）；③(d) AC-394 判据单跑退出码与其自打印的 G1/G2/G3 逐成员（证明 voice 出环后仍是基线的子集）；④(e) 既有判据退出码；⑤(f) tsc/lint；⑥(g) collateral；⑦纯位移核对（voice-lexicon 取能力的方式从动态 import 改为端口注入，业务语义不变）。运行结束不重启 :3001、不发布。

## Touches

- `server/modules/voice/voice-lexicon.ts`（providers 动态 import 改经端口注入，业务语义不变）
- `server/shared/ports/voice-lexicon.port.ts` (new)（install/uninstall + 取能力函数）
- `server/index.ts`（assembly 处安装 voice-lexicon 端口）
- `server/modules/voice/tests/voice-provider-cycle.test.ts` (new)（判据：复用 AC-394 扫描器断言 voice 出环）
- `server/shared/tests/quay-test-script.test.ts`（collateral：两条计数 pin 各 +1 及注释算术）
- `scripts/suite-duration-baseline.tsv`（collateral：仅当覆盖率地板跌破 90%）
- `tasks/gap-voice-provider-cycle-port-break.md`（自触）
