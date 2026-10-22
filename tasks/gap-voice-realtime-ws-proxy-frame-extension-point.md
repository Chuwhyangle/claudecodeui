---
id: gap-voice-realtime-ws-proxy-frame-extension-point
title: voice-realtime-ws-proxy.service.ts 扩展点重构：入站帧路由改成可注册分派（frame registry +
  同目录兄弟文件 + 负对照判据），连接处理只留路由骨架
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

**机制与去重（立案时实测，2026-10-22，HEAD c0ef2d4b3919）**：机制词 grep `grep -rlE 'voice-realtime-ws-proxy|ws-proxy.*(拆|扩展|registry|handler)|frame.?handler|分帧|入站帧.*注册' tasks/*.md` → 大量 voice/live-voice 命中，逐条读均为**行为/协议**任务（协议切换、caption、interrupt、queue、narrator、VAD 等），无一认领「把 ws-proxy 的入站帧路由做成可注册分派（扩展点）」这一结构机制；`gap-omission-fill-wire-into-ws-proxy`（done）是把 omission-fill 接进 ws-proxy 的**行为**任务，不是拆结构。合并候选（granularity-advice `--touches voice-realtime-ws-proxy.service.ts`）报 `peers: []` ⇒ **separate**。

### 现状（立案时实测，2026-10-22，HEAD c0ef2d4b3919）

- `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` = **6718 行**（函数模块，非类）；`handleVoiceRealtimeConnection` 出度 **65**（server scope 第二，仅次 driver 的 203）。
- 入站帧路由内联在 `handleVoiceRealtimeConnection`（:2537）与 `readVoiceRealtimeInboundFrame`（:2417）：hello / audio / segment_start / segment_end / context / narrator_done / run_output / close 各是一段 if/else；出站响应与状态注入（caption / tts_audio / state / error / queued / refused / stopped）同样内联。
- perFile：**67 个已落地任务**碰过这个文件，中位每任务改 **97 行**、中位 2 轮——「任何 voice-realtime 特性都往这个 6718 行文件加函数」的再加工磁石。
- F6 报告已点名 voice-realtime 是 god package（36 文件 / 148 实体 / fanOut 291），「四分」是报告建议但未落地；本条只取 ws-proxy 这一份 god file 的第一刀。

### 改法

给 ws-proxy 引入入站帧的可注册分派（frame handler 注册表：一个帧类型 = 一个 handler，name + source + handle(frame, context)），handler 落在 `server/modules/voice-realtime/` 同目录兄弟文件、从 ws-proxy 之外注册；`handleVoiceRealtimeConnection` 只做连接生命周期（握手/排队/忙重试）并**经注册表路由帧**，不再内联每个帧类型的处理。**行为保持**：不改变任何行为判据。

⛔ 范围护栏：新文件一律落在 `server/modules/voice-realtime/` 同目录，**不新建 `server/modules/**` 目录**（避免 AC-394 目录棘轮）。

<!-- dedup-ref --> 相关但不同机制：`gap-omission-fill-wire-into-ws-proxy`（done）是把 omission-fill 行为接进 ws-proxy，与本条「把入站帧路由改成可注册分派」不是同一机制，不构成本条前置；`gap-mcp-gateway-tool-registration-extract`（superseded）的「拆出子包触 AC-394 棘轮被 revert」教训作为本条的护栏。`gap-claude-host-driver-extension-point`（done）是本条同款机制在**另一个 god 文件**上的样板，验收口径一致，但不构成本条前置。

## Plan

1. **盘点**：列出全部入站帧类型与其处理段、出站响应/状态注入函数，记录公开签名与调用方。
2. **定义 frame-handler 注册表**：帧类型 union（闭集）+ register/unregister/dispatch；未注册返回 null 不抛（镜像 driver 第一刀的 `ClaudeResidentOutcomeRegistry` 纪律）。
3. **迁 handler**：每个帧类型的处理体**逐字**迁到兄弟 handler 文件，装配处注册；`handleVoiceRealtimeConnection` 改为经注册表路由。纯位移。
4. **判据**：正臂（非 ws-proxy 文件注册的帧 handler 在对应帧上被触发）、负臂（未注册不触发 + 内存注入形态打红同一条断言函数）、行为保持 spot 断言。
5. **收口**：既有 voice-realtime 判据单跑仍绿、tsc/lint、collateral、centralΔ 基线（`centralΔ/(centralΔ+nonCentralΔ)`）。

## AC

- [x] (a) **扩展点存在且 ws-proxy 经它路由**：`test -f server/modules/voice-realtime/voice-realtime-frame-registry.ts` 退出 0；`grep -q "voice-realtime-frame-registry" server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts` 退出 0。
- [x] (b) **判据存在且跑通（正臂）**：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-frame-registry.test.ts` 退出 0；其打印读数显示「注册自非 `voice-realtime-ws-proxy.service.ts` 文件的帧 handler 在对应帧上被触发」。
- [x] (c) **负对照**：同一判据含「未注册的帧 handler 不被触发」断言，且该断言在内存注入形态下打红同一条断言函数（判据单跑自动执行并打印读数）。
- [x] (d) **中心文件瘦身 + 静态门**：`test "$(wc -l < server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts)" -lt 6718` 退出 0（基线=立案实测 6718）；`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run lint` 退出 0。
- [x] (e) **既有行为判据不改一字仍绿**：三个文件各自单跑、各自退出 0（命令一律 `npx tsx --tsconfig server/tsconfig.json --test <file>`）：`server/modules/voice-realtime/tests/voice-realtime-ws-proxy.protocol-simulation.test.ts`、`voice-realtime-bridge.test.ts`、`voice-realtime-scripted-scenarios.test.ts`。
- [x] (f) **collateral**：新增一个 `server/**/*.test.ts` ⇒ 先复量 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l`（执行时以实测为准），按 `server/shared/tests/quay-test-script.test.ts` 两条计数 pin 各 +1 并改写其上方注释算术；`scripts/suite-duration-baseline.tsv` 仅当 AC7 覆盖率地板跌破 90% 才追加一行；单文件复跑 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0。
- [x] (g) **范围受控**：`git diff --name-only $(git merge-base HEAD develop) HEAD` 的集合 ⊆ `## Touches` 所列。

## DoD

真实落地的标准是「一个新的入站帧 handler 真的**从 ws-proxy 文件之外注册并生效**，未注册的不触发，既有行为不变」，不是「多了两个文件」。必须贴出：①(b) 判据打印的原样输出；②正臂与负臂两臂的逐字读数（负臂=未注册不触发 + 内存注入形态打红的红读数与还原后绿读数）；③(e) 三条判据各自单跑的退出码；④(d) 的 `wc -l` 前后读数与 typecheck / lint 退出码；⑤迁移是**纯位移**的核对（ws-proxy 仅把帧处理体改为经注册表路由、公开导出签名未动；若发现无法原样迁的段——隐式依赖模块级状态/闭包——逐条列出，不得悄悄改写语义）；⑥`git diff` 只含 `## Touches` 所列文件。运行结束不重启 :3001、不发布。

## Evidence

- (b) 正臂读数（判据原样输出）：
  `(b) positive-arm: frame=context handler=criterion.probe.context source=/…/server/modules/voice-realtime/tests/voice-realtime-frame-registry.test.ts wsProxySource=/…/server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`
  `(b) positive-arm: triggered=1 frameText=the plan`
  四个用例全绿：`pass 4 / fail 0`，退出码 0。
- (c) 负对照读数：
  `(c) negative-arm(registry): triggered=0 handlerRegistered=false`
  `(c) negative-arm(injected): red=yes triggered=1 message=unregistered frame handler criterion.probe.context was invoked (0 -> 1)`
  `(c) negative-arm(restored): triggered=1 handlerRegistered=true`
  同一 `assertUnregisteredFrameHandlerNotInvoked` 被真实注册表与内存注入形态共同驱动；注入形态打红，还原后绿。
- (e) 三条既有判据单跑退出码：protocol-simulation = 0（pass 24）、bridge = 0（pass 16）、scripted-scenarios = 0（pass 31）。另以 `with-memory-cap.sh --test --test-concurrency=4` 跑完全部 57 个驱动 `handleVoiceRealtimeConnection` 的文件：580/580 通过。
- (d) `wc -l voice-realtime-ws-proxy.service.ts`：6718 → **6576**（< 6718）；`npx tsc --noEmit -p server/tsconfig.json` 退出 0；`npm run typecheck`（client+server+scripts）退出 0；`npm run lint` 退出 0（仅存量 warning）。
- (f) 复量 `find server -name '*.test.ts' -o -name '*.test.js' | grep -v node_modules | wc -l` = **398**；`quay-test-script.test.ts` 两条 pin 改为 `unknown=395` / `unknown=397` 并同步注释算术；AC7 覆盖率实测 358/398 = 89.95% < 90%，故 `scripts/suite-duration-baseline.tsv` 追加一行 `1977	server/modules/voice-realtime/tests/voice-realtime-frame-registry.test.ts`；单文件复跑退出 0（pass 14）。
- ⑤ 纯位移核对：八个帧处理体的表达式、早退分支、日志文本与顺序逐字保留；仅把原闭包里的局部变量改为显式 `context` / `state` 读取（`state` 是访问器视图，仍指向 ws-proxy 自己的同名局部）。没有任何段因隐式模块级状态无法迁移。公开导出签名未改（只新增可选的 `VoiceRealtimeProxySeams.frameRegistry` 注入缝）。
- ⑥ 两条既有 source-anchored 假形态判据（segmented-default 的 hello 声明门、uplink-vad-seam 的 fast path/activity/local-gate/close-exit 四条）因其锚点文本随分支迁到兄弟文件，已改为对 handler 文件做变异并把 proxy 副本的 import 重定向到变异后的 handler 副本；判据语义与红读数不变。

## Touches

- `server/modules/voice-realtime/voice-realtime-ws-proxy.service.ts`（入站帧路由改经注册表，公开导出签名不变）
- `server/modules/voice-realtime/voice-realtime-frame-registry.ts` (new)（帧类型 union + register/unregister/dispatch）
- `server/modules/voice-realtime/voice-realtime-frame-handlers.ts` (new)（迁出的帧 handler，装配处注册）
- `server/modules/voice-realtime/tests/voice-realtime-frame-registry.test.ts` (new)（判据：正臂 + 负对照 + 行为保持）
- `server/modules/voice-realtime/tests/voice-realtime-segmented-default.test.ts`（collateral：hello 声明门的假形态锚点改读 handler 文件）
- `server/modules/voice-realtime/tests/voice-realtime-uplink-vad-seam.test.ts`（collateral：audio/close 分支四条假形态锚点改读 handler 文件）
- `server/shared/tests/quay-test-script.test.ts`（collateral：两条计数 pin 各 +1 及注释算术）
- `scripts/suite-duration-baseline.tsv`（collateral：AC7 覆盖率跌破 90%，追加一行）
- `tasks/gap-voice-realtime-ws-proxy-frame-extension-point.md`（自触）
