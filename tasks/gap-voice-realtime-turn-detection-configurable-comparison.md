---
id: gap-voice-realtime-turn-detection-configurable-comparison
title: "上行 turn_detection 对照实验：把 silence_duration_ms: 400 的硬编码变成可配（纯解析器 +
  env，默认逐字节不变）并在真实上游实测 server_vad@400 / @800 / semantic_vad 三档，据读数定默认"
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（本 agent 今日逐文件重读，行号按当前树核对）

1. **我们不用平台默认，而是出货一个更激进的硬编码值。** `server/modules/voice-realtime/voice-realtime-dashscope-transport.ts:330` 的 `DEFAULT_SESSION_DEFAULTS.turn_detection = { type: 'server_vad', threshold: 0.5, silence_duration_ms: 400 }` 是**字面硬编码**：既不由环境变量解析，也不能经诊断路由覆盖。
2. **文档口径**（Aliyun 百炼 realtime，模型 `qwen3.8-omni-flash-realtime`）：`turn_detection.type` 支持 `server_vad`（默认）与 `semantic_vad`；`silence_duration_ms` 文档默认 **800**、有效区间 **[200, 6000]** —— 我们出货 400，比平台默认更激进；`threshold` 文档默认 0.5、区间 [-1.0, 1.0]，我们出货 0.5（一致）。`create_response` 与 `prefix_padding_ms` 只出现在服务端 `session.created` 的回显里、文档未列为客户端可设，按**未验证**处理。没有任何客户端事件能删除历史；连接内唯一的文档化上界是自动的媒体历史丢弃 —— 这句写在这里，是为了本条**不被误读成**「历史修复」。
3. **要治的症状**（`server.log` 连接 `d88c6722`，2026-10-10 实测）：4 句口述被**上游**检测器切成 **11 次 commit**（每句 2–3 次），其中一次转写为空串；全日志 38 commit / 16 utterance、**4 次空转写**。该部署上传的是连续音频（日志里 0 个 `ready` 帧 ⇒ 从未协商分段中继），所以切句的是上游 VAD。每次多余 commit 还会变成一个对话条目，整段会话在**每次响应**都被重读与重计费 —— 这正是「输入 token 拆分」与「响应数」要一起量的原因。
4. **缝已存在，但配置面不存在**：`server/modules/voice-realtime/voice-realtime-bridge.service.ts:69` 的 `session.turn_detection` 客户端消息载荷是 `'server_vad' | null`，在分段路径里以 `turnDetection: null` 发出（`:549`）；传输把它映射成一次**局部** `session.update`（`voice-realtime-dashscope-transport.ts:385-386`，`{...sessionDefaults, turn_detection}`）。⇒ 关掉检测器有缝，**调参数没有**。
5. **要照抄的 env 解析风格**：`server/modules/voice-realtime/voice-realtime-mode.ts` —— 纯解析器**不自己读 `process.env`**，返回解析值 + 一个 `invalid` 字段承载拼写错误，并配一个 `describe…` 函数让组装点与代理说**同一句话**。拼写错误绝不能静默当作有效配置。
6. **诊断路由**（`voice-realtime.routes.ts` 的 handler，本 agent 今日核对的 `:110-125`）现接受 `speed`/`quietMs`/`maxMs`/`turns`/`dryRun`，**没有任何 turn-detection 参数** ⇒ 今天无法经它驱动三档对照，必须先改代码。

<!-- dedup-ref --> **去重结论（机检索，2026-10-11）**：`turn_detection` / `silence_duration_ms` / `server_vad` / `turn-detection` / `turn detection` 逐词检索，无任何任务覆盖「把 `turn_detection` 参数变成可配并行为实测其影响」。同区域已 done 的相关任务机制各异：`gap-voice-segmented-relay-p0b-endpoint-history-cache`（AC-318 的 S4）只验证了 `semantic_vad` 的**控制面回声**——`semantic_vad` 与 `bogus_vad_type` 回显同一组字段（`echoDiscriminates=false`，verdict unsupported），**没有**测量任何行为读数；`gap-voice-segmented-relay-protocol-server-commit` 与 `gap-voice-segmented-relay-rollout-and-reconcile` 提供段协议与 `VOICE_REALTIME_MODE` 解析风格，不碰 `silence_duration_ms`。本条**正是**补那次缺失的**行为**测量。merge-candidate：当前唯一开放任务 `gap-ac317-upload-fixture-criterion-nondeterministic`（ready）的 Touches 是 e2e spec 与 `useVoiceRealtimeSession.ts` / `voice-realtime-ws-proxy.service.ts`，与本条不共享实质源文件 ⇒ 判 **separate（none found）**。

### semantic_vad 臂的预期（先说清，避免把结论当预设）

P0b-S4 的实测是「回声不区分」，因此**不能**靠 `session.updated` 的字段证明 `semantic_vad` 生效；本任务对 `semantic_vad` 臂的判据只能是**行为读数**（commit 数 / 空转写 / 响应数 / token / 延迟），并把「回声无法区分」写进 artifact 的方法学一栏。若该臂的行为读数与 `server_vad@400` 无差别，如实登记为「无差别」，不强行给结论、也不删这一臂。

### 方案

1. **纯解析器**：新增 `server/modules/voice-realtime/voice-realtime-turn-detection.ts`，照 `voice-realtime-mode.ts` 的形状 —— `resolveTurnDetection(env)` 不读 `process.env`，返回 `{ turnDetection: { type, threshold, silence_duration_ms }, invalid: string | null }`；非法 `type`（非 `server_vad`/`semantic_vad`）与非法 silence（非整数或越界 [200, 6000]）**回落默认并报 `invalid`**；`describeTurnDetection(resolution)` 给出唯一一句话，供组装点与诊断路由共用。
2. **默认逐字节不变**：env 未设时解析结果逐字节等于今天 `:330` 的字面量 `{ type: 'server_vad', threshold: 0.5, silence_duration_ms: 400 }`；唯一组装点 `server/index.ts` 的 `buildVoiceRealtimeSeams` 把解析值作为 `sessionDefaults.turn_detection` 传给传输 —— **替换字面量但值不变**，传输自身的翻译逻辑不新增分支。
3. **诊断路由可携带覆写**：`POST /api/voice-realtime/diagnose` 新增可选字段（如 `turnDetection: { type?, silenceMs?, threshold? }`），经 `voice-realtime-diagnose.service.ts` 透传到该次运行传输的 `sessionDefaults`，使三档对照**无需逐臂改源码**；越界/非法值走与 AC1 **同一套**解析规则（默认 + `invalid`），不静默生效。
4. **实测三档**：同一段「多句口述」脚本（沿用 `experiments/voice-trim/fixtures/zh-d01-o85.wav` 一类多句音频，或用 `turns[]` 多句脚本），在**真实上游**各跑一条连接：`server_vad@400`（今天出货）、`server_vad@800`（平台文档默认）、`semantic_vad`。
5. **据读数定默认**：默认取读数选出的那一档；若读数为「无差别」或「改默认有风险（更慢的 `speech-end → session_send` 延迟换更少 commit）」，则**保持 400** 并在 body 里记录读数与理由 —— 任何情况下读者都能从记录的数字**独立复推**结论。
6. **artifact**：`experiments/voice-realtime-turn-detection/RESULT.json` + 驱动脚本 `compare.mts`；`scripts/voice-realtime-diagnose.mjs` 增 `--turn-detection` 旗标以便脚本化驱动三臂。

### 隔离配方（沿用 2026-10-10 已验证的 A/B 做法；两个坑必须写进每次 spawn）

- `git worktree` 取目标 commit + **COPY** 一份 `auth.db` 并把 DB 路径 env 指向副本 + 对该副本 mint 一个 JWT + **非 3001** 端口。
- ⚠️ 坑一：shell 已导出 `DATABASE_PATH` 与 `SERVER_PORT=3001`，**每次 spawn 都必须显式覆盖这两个**，否则会写到活库 / 占用 3001。
- ⚠️ 坑二：3001 上的常驻 UI 服务**绝不能重启**（它承载操作者的会话）。

## 边界 / 不做

- ⛔ 不改分段中继的协议、不改桥的 `session.turn_detection: null` 分段缝；不改 `VOICE_REALTIME_MODE` 语义。
- ⛔ 不靠改线协议去「证明」`semantic_vad` 生效（S4 已证回声不可区分，行为读数才是判据）。
- ⛔ 不为调参而放宽/删除任何既有断言；不动 `playwright.config.ts`；不新增 retries/skip。
- ⛔ 不改「历史」相关行为（无客户端事件可删历史，见现状 2）——本条是**切句阈值**的调参，不是历史修复。

## Plan

1. 写解析器 + env（`voice-realtime-turn-detection.ts`），单测覆盖：默认逐字节不变、合法覆写落到**实际帧**、非法值回落 + `invalid` 非空。
2. 在唯一组装点（`server/index.ts` 的 `buildVoiceRealtimeSeams`）接线，把 `sessionDefaults.turn_detection` 换成解析值；默认值逐字节不变。
3. 诊断路由 + 诊断服务承载 `turnDetection` 覆写；加路由测试（从假上游回读外发帧）。
4. 用隔离配方在真实上游跑三档，逐档采集六类读数。
5. 汇总 artifact（`RESULT.json` + `compare.mts`）—— 每档登记真实 session/connection id 与估算花费。
6. 据读数定默认或记录理由；回归：默认配置帧序列逐帧不变 + 静态门 + 服务端测试文件数钉子同步。

## AC

- [x] AC1 解析器 + 默认逐字节不变：`npx tsx --tsconfig server/tsconfig.json --test server/modules/voice-realtime/tests/voice-realtime-turn-detection.test.ts` 退出 0。用例断言：env 未设时传输**真正外发**的 `session.update` 帧里 `turn_detection` 逐字节等于今天 `:330` 的字面量 `{type:'server_vad',threshold:0.5,silence_duration_ms:400}`（断言落在**实际帧**上，不是断言解析器内部值）；合法覆写（如 `silence=800`）落到帧上；非法值（未知 type / 非整数 / 越界）**回落默认且 `invalid` 非空**，绝不静默生效。
- [x] AC2 诊断路由可携带覆写：`server/modules/voice-realtime/tests/voice-realtime-diagnose.test.ts` 里一条用例证明请求体的 `turnDetection`（type / silenceMs / threshold）**到达**该次运行传输外发的 `session.update` 帧（从假上游回读帧）；越界值按 AC1 同一套规则处理（默认 + `invalid`），不改变今天默认。
- [x] AC3 三档对照落盘（真实上游）：`experiments/voice-realtime-turn-detection/RESULT.json` 已提交，逐档（server_vad@400 / server_vad@800 / semantic_vad）含：per-utterance commit 数、空转写数、响应数、input tokens 且**带文本/音频拆分**、每句 relay 覆盖、`speech-end → session_send` 延迟；每档记录含**真实 endpoint 分配的 session / connection id**（证明不是夹具回放）。
- [x] AC4 默认由读数决定（或记录为何保持）：artifact（或 body）内有该默认的**来源行**；默认值等于读数选出的那一档，或明确记录读数与「保持 400」的理由 —— 读者能从记录的数字**独立复推**结论。
- [x] AC5 线中立（回归守卫）：默认配置下，同一段 ON 回放的帧序列与改动前**逐帧相同**（含 `session.update` 里 `turn_detection` 逐字节相等）；取假形态：把默认值改回非 400 ⇒ 该用例必红。
- [x] AC6 负控（env 不能被用来静默关掉中继）：新增 env 旋钮的取值域**不包含**「关掉检测器」—— 试图经该旋钮把 `turn_detection` 置空 / 关闭时**被拒绝并报 `invalid`**（关检测器只有既有 `session.turn_detection: null` 分段缝一条路）；取假形态：让该旋钮接受 `null` 并静默应用 ⇒ 该用例必红。
- [x] AC7 静态门：`npm run typecheck` 与 `npm run lint` 退出 0；新增服务端测试文件后 `npx tsx --tsconfig server/tsconfig.json --test server/shared/tests/quay-test-script.test.ts` 退出 0（同步文件数钉子与 `scripts/suite-duration-baseline.tsv`）。

## DoD

真实落地判据：三档读数必须来自**真实 DashScope 上游**（每档一条真实连接、同一段多句脚本、真实 endpoint 分配的 session / connection id 入档），不是夹具或单测；出货默认必须反映那份读数（改成读数选出的档，或保持 400 并记录读数与理由）。单测通过是**必要不充分**。任何人按体里的隔离配方能在同一 checkout 复跑；artifact 的可读性以「读者能从数字独立复推结论」为准。花费有界：三档合计估算登记在 artifact 里，上限 ≤ ¥0.05。

## 实测读数与默认来源（AC4）

默认**保持 `server_vad@400`**。来源行：`server/modules/voice-realtime/voice-realtime-turn-detection.ts:70` 的 `export const DEFAULT_TURN_DETECTION`。机械读数（artifact 的 `suggestedDefault`）指向 `server_vad@800`；据同一份读数**保持 400**，理由如下（数字均在 artifact 里，读者可独立复推）。

真实上游三档读数（`qwen3.8-omni-flash-realtime`，同一段 15.733 s 单条多句 clip，每档一条真实连接）：

| 臂 | session id | commits | 空转写 | responses | input tokens（文本/音频） | coverage | speech-end→session_send | CNY |
|---|---|---|---|---|---|---|---|---|
| server_vad@400 | sess_K9PJHoZzBHbjSjnt2OmwT | 5 | 0 | 4 | 2068（1956/112） | 3/5 | 264/217/212/220 ms | 0.004105 |
| server_vad@800 | sess_K1ZCYlJRSd2sLUMY7YsDd | 3 | 0 | 3 | 1479（1374/105） | 4/5 | 244/230/232 ms | 0.003083 |
| semantic_vad | sess_Timjpw6KtAguYTii2RXzY | 4 | 0 | 3 | 1501（1396/105） | 3/5 | 258/235/245 ms | 0.003106 |

（三档合计 ¥0.010294 ≤ DoD 上限 ¥0.05；`guardTriggered: false`。）

1. **每臂仅一条真实连接，是单次抽样**：同一 400 ms 设置在 2026-10-10 的 `server.log` 里切出 11 次 commit，本次只切出 5 次 —— 档间差异（5 vs 3）小于档内漂移（11 vs 5），不足以支撑改一个部署级默认。
2. **`fragmentCoverage` 是连续包含判定，分不清「丢语气词」与「丢内容」**：`semantic_vad` 得 3/5 只丢了语气词（呃/嗯），`server_vad@400` 同样 3/5 却把「就是在那个设置页面」切断成「在。那个设置页面。」—— 同一分数，两种严重性。
3. **旋钮已就位，采纳 800 是一次一行部署改动**（`VOICE_REALTIME_TURN_DETECTION_SILENCE_MS=800`），或对单次诊断用 `turnDetection:{silenceMs:800}`；风险收益不对称时无须现在改默认。

复访条件（写入 artifact 的 `decision.revisitWhen`）：≥3 条连接/臂、≥2 段 clip 的重复对照再现 commit 差异时再改默认。

## Touches

- server/modules/voice-realtime/voice-realtime-turn-detection.ts (new)
- server/modules/voice-realtime/voice-realtime-dashscope-transport.ts
- server/modules/voice-realtime/voice-realtime-diagnose.service.ts
- server/modules/voice-realtime/voice-realtime.routes.ts
- server/modules/voice-realtime/index.ts
- server/index.ts
- server/modules/voice-realtime/tests/voice-realtime-turn-detection.test.ts (new)
- server/modules/voice-realtime/tests/voice-realtime-dashscope-transport.test.ts
- server/modules/voice-realtime/tests/voice-realtime-diagnose.test.ts
- experiments/voice-realtime-turn-detection/compare.mts (new)
- experiments/voice-realtime-turn-detection/RESULT.json (new)
- scripts/voice-realtime-diagnose.mjs
- server/shared/tests/quay-test-script.test.ts
- scripts/suite-duration-baseline.tsv
- tasks/gap-voice-realtime-turn-detection-configurable-comparison.md