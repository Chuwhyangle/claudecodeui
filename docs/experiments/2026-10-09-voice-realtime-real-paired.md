# 真实音频 paired 对比：ASR→文本 vs 真实 Qwen Realtime（四类歧义 / world-model）

**一句话**：在 GOAL-029 冻结的同一批 24 条语料上，把**同一段真实 TTS 音频**分别喂给「真实 DashScope
ASR→一句书面指令」（Arm A）与「真实 `qwen3.8-omni-flash-realtime` Realtime 会话 + Task A bridge」
（Arm B），在**同一次运行**里读一次真正的 paired 读数——这条记录把 GOAL-029 的"结构优势"读数换成
「真实模型在这两条真通路上的分数」，并如实登记两条风险类别（未按要求调用 / 工具·参数幻觉）在读数里
的位置。

- 日期：2026-10-09
- 运行 id：`run-voice-realtime-paired-live-1`（全部读数与两条臂都带它；`--runs=straddle` 必须红）
- runner：`experiments/voice-realtime-ambiguity/run-real.mjs`
- 语料与打分口径：`experiments/voice-realtime-ambiguity/PREREG.md` + `fixtures/`（GOAL-029 在看过任何
  读数**之前**冻结；本任务一个字节都没改）；打分**复用** `run.mjs` 的导出，一行都没改
- 冻结读数：`experiments/voice-realtime-ambiguity/fixtures/real-paired.json`（`--live` 取数 → `--freeze`
  冻结；缓存 `out/` 不入库）
- 默认离线重算（**不联网、零模型调用**）：`node experiments/voice-realtime-ambiguity/run-real.mjs`

> **本记录里的每一个质量数字都是一份读数，不是判据**——`quality numbers are a reading and are NOT a
> criterion`。它们不被任何闸引用，改动它们也不是回归。这一句同时是**本记录**与 runner（`run-real.mjs`）
> 的末行。

## 被测的两条真实通路（都经出货模块）

| | Arm A（ASR→文本） | Arm B（Realtime bridge） |
|---|---|---|
| 模块 | `shared/asr/asrRegistry.ts#resolve('dashscope-omni')` → `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts#transcribe` | `server/modules/voice-realtime/index.ts#connect`（`voice-realtime-bridge.service.ts`）+ `createDashscopeTransport` |
| 线上端点 | `https://dashscope.aliyuncs.com`（`compatible-mode`，联网 + 凭据 + 花钱） | `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`，模型 `qwen3.8-omni-flash-realtime`，`voice: "Tina"` |
| 输入 | 一段真实音频（16 kHz 单声道 WAV）→ 适配器自己拼请求、自己解析答案 | 同一段真实音频（PCM16 base64 帧）+ `session.update`（广告 6 个只读/写工具） |
| 工具通道 | **没有**——`capabilities.honors.context === false`，契约里没有函数调用这一格 | 模型**自主**对 `REALTIME_TOOLS` 发起 `function_call`；**路由由 bridge 自己做**，executor 只回答「这个工具读到什么」 |
| executor 回填 | — | GOAL-029 冻结的**夹具状态**（不是真实 `ChatControlService`） |

`--probe` 打印**绝对路径 + 符号名**，并断言它们在出货树内、不在工装内；工装自扫里没有第二份 ASR 请求
构造、第二份 bridge、第二份 transport。运行时的证据一并打印：Arm A 每行的 `providerId` 由出货适配器
自己盖章；Arm B 每一次模型调用要么被 bridge 路由成 `function_call_output`、要么带着一条 `onError`
——没有第三条出口。

## 真实音频（`fixtures/audio/`，本任务合成并提交）

全部 30 条（24 条语料 + 6 条有音频的负对照）由 Microsoft Edge TTS（`zh-CN-XiaoxiaoNeural`）按语料的
`script` 合成，**16 kHz 单声道 WAV**，落 `experiments/voice-realtime-ambiguity/fixtures/audio/<id>.wav`，
并把每条的字数、时长与 **sha256** 写进冻结快照。runner 在默认离线路径**只读**这些 wav，不联网、不合成。

- 同一段音频喂两条臂：**这是「配对」的字面意思**。
- `hom-01`/`hom-02` 共享同一个 sha256（同音组是「同一条音、有无项目上下文」两种条件）。
- 合成的是**朗读式**语音，不含真人口误、重复、韵律断裂——见「诚实的范围声明」。

## 打分：复用 GOAL-029 冻结口径（不改一行）

`run-real.mjs` 从 `run.mjs` **import** `scoreEntry` / `applyBias` / `readControl` / `controlVerdict` /
`printControls` / `straddle` / `assertSingleRun` / `decide` / `baselineCapabilities` / `DISCLAIMER`，
一行都没改。真实输出 → 冻结 `decision` 形状的映射由 runner 里一个**声明的机械读取器**给出：机器只做
**子串 / 结构性子检查**，语义等价那一半是**人读**（记录与 runner 输出都逐条贴出模型的原始输出）。

### 负对照：为什么这一层**不**换成真实模型

负对照被测的是**打分器 + 那个命名启发式变换**本身（GOAL-029 已经把这层冻住了）。所以这一层**不改**：
无偏置那侧走冻结替身读取器 `decide(entry, bridgeCaps, readFixture)`，偏置那侧只多一次 `applyBias`
——位移是单变量的。把对照层也换成真实模型会把被测对象从「打分器是否可证伪」挪成「模型答不答得对那
七条对照条目」，那是另一件事，而且会让默认读数变红（`scoreHomophone` 的对照条目 gold 是
`code-identifier`；真实模型会说「改成 apiKey」= `access-token`，无偏置那侧就已经 fail，负对照根本
没有可位移的空间）。真实模型在对照条目上的读数另有打印（见下），但它**不参与**对照判词。

## 读数（同一次运行，同一批 24 条 × 2 臂 × 3 次重复）

### 总体与四类场景（每格 = 通过数 / 该格读数数）

| 场景类 | 条数 | Arm A（ASR→文本） | Arm B（Realtime + 工具） |
|---|---|---|---|
| 同音 / 实体歧义 `homophone-entity-ambiguity` | 6 | **9/18** | **10/18** |
| 自我更正 `self-correction` | 5 | **6/15** | **4/15** |
| 指代 `coreference` | 5 | **0/15** | **7/15** |
| world-model | 8 | **6/24** | **11/24** |
| **合计** | **24** | **21/72（29.2%）** | **32/72（44.4%）** |

Arm A 每格无工具通道（`functionCall` 恒为 `null`）；Arm B 为模型 + 工具。**总体 B 高于 A**，但四类里
B **不是处处**高——下面逐类给结论。

#### 1. 同音 / 实体歧义：**基本打平（B +1，噪声内）**

A 9/18，B 10/18。这一类不需要工具就能答，考的是「听清没听清 + 认不认得项目实体」。真实读数里两边**都
没稳定把字面同音词解析到项目所指**：

- Arm A 会**听错**：`hom-02` rep2 把 `key` 识别成 `kiwi`（`把 kiwi 里还没做完的 task 拉起来`）；`hom-05`
  rep2 把 `cloud` 识别成 `Claude`。听错即判错。
- Arm B **很少主动去读**：6 条里 5 条的 `requiredReads` 为空，模型大多只回一句「无法确认」；`hom-03`/
  `hom-04` 三次重复**一次工具都没调**，直接给了「我没法换 Key」——句面完全正确，但没解决歧义。

**结论**：工具通道在这一类上几乎没被触发，B 与 A 打平。**同音歧义没有被 Realtime 通路解决。**

#### 2. 自我更正：**A 赢（A 6/15 vs B 4/15）**

这一类**不需要工具**，纯粹是「听懂自我更正序列」（`改成 A……不对，改成 B`）的语言理解题。两支都能听清
音频（脚本无口误），差别全在模型：

- `sc-02`（`端口从 3000 改成 3002`）B 答「好的，端口已更新为 3002」——没按 gold 的书面形式落地，判 fail。
- `sc-04`（`在浏览器里按停顿切段，每段单独上传`）B 回了「当前没有浏览器会话」——把一条**陈述/指令**误当成
  需要读状态的查询，A 反而答对。
- `sc-01` 两支都 fail（`上面那个函数` 无指代对象）。

**结论**：**在不需要工具、纯语言理解的那一类上，真实 Realtime 没有优势，反而更弱。** 这是本记录里最不
利于「Realtime 更好」这个叙事的读数，如实登记。

#### 3. 指代：**B 的 +7 是结构性的，不是理解更好**

A **0/15**、B 7/15。A 的 0 不是模型答错，而是**结构上不可能对**：指代类条目的 `requiredReads` 是
`ui_selected_text` / `ui_visible_context`——A 臂是纯文本 ASR，**没有任何工具/上下文通道**，契约里这一格
就是空的。所以 0→7 量的是**「有没有工具通道」**，不是「模型理解指代更好」。

而且即便有工具，B 也只到 7/15，且**扣分点正是指代工具**：`co-01`/`co-04` 的 gold 读数是 `ui_selected_text`，
但 bridge 广告的工具集里**没有** `ui_selected_text`，模型只能退而调 `ui_visible_context` → 记
`called_wrong_tool`（见工具表）。`co-03`/`co-05` 走 `ui_visible_context` 就答对了。

**结论**：**这一类的优势来自结构（A 没有通道），不是模型理解更强**；且 bridge 工具集缺 `ui_selected_text`
在 `co-01`/`co-04` 上**直接扣分**（与 GOAL-029 的登记一致）。

#### 4. world-model：**B 更好，但两支都弱，且 B 有退化读数**

A 6/24、B 11/24。B 的优势主要来自**会用工具去读状态**（`wm-02` 调 `run_get` 答对进度、`wm-05` 调
`session_get` 答「运行中」、`wm-07` 调 `run_get` 后**诚实说读不到**），以及**诚实拒绝**被记分器认可
（`wm-07`）；A 没有工具，只能凭空猜，`wm-02`/`wm-04` 之类直接 fail。但 B 也**不是稳的**：

- `wm-04` B 答「后台还有一个非循环任务 bg-1 在跑」，与 gold 不符 → fail。
- `wm-08` 三次重复两次**空回答**（rep1 45 s 超时、rep2 参数被 schema 拒后不答）。
- `wm-03` rep1 45 s 超时、rep2 的 `function_call` 发了 36.6 s 才回但正文为空。

**结论**：**B 更好，但「world-model 题答得对」不成立——两支都远没到能用**；B 的读数里混着连接/超时退化。

### 工具调用行为（Arm B，与最终正确率**分开**统计，AC5）

| 类别 | 计数 |
|---|---|
| `called_as_required`（按需调用且命中） | 22 |
| `not_called_as_required`（**该调没调**） | 1 |
| `called_wrong_tool`（调了但错的工具） | 10 |
| `tool_or_param_hallucination`（**工具/参数幻觉**） | 1 |
| `called_but_not_required`（本不需要却调了） | 22 |
| `no_call_needed`（不需要也没调） | 16 |

- 在 **33 条确实需要工具**的读数里：**未按要求调用 = 1**（`wm-03` rep1：该调 `approvals_list` 没调）；**工具/
  参数幻觉 = 1**（`wm-08` rep2：调 `session_get` 但**漏了 `session` 参数**，被 bridge 的 schema 拒
  ——`TOOL_ARGUMENT_SCHEMA_VIOLATION`）。
- 两类风险**都在读数里出现了**（各 1 次），不是「未观察到」；AC-308/AC-309 点名要独立登记的两类，如实落
  在这张表里。
- `called_wrong_tool` 10 次里，6 次集中在 `co-01`/`co-04`（gold 要 `ui_selected_text`，bridge 没广告）。
- **传输/连接错误不计入工具行为**（单独打印，避免污染工具表）：`UNKNOWN_EVENT×2878`、
  `CONNECTION_LOST×3`——它们与「模型叫没叫工具」无关。

### 延迟长尾（ms，三节点，每臂 p50/p90/max，AC6）

| 臂 | 节点 | p50 | p90 | max | n |
|---|---|---|---|---|---|
| A | firstResponse | 4357 | 14301 | 56769 | 72 |
| A | functionCall | — | — | — | 0 |
| A | finalIntent | 4357 | 14301 | 56769 | 72 |
| B | firstResponse | 1045 | 14766 | 45085 | 72 |
| B | functionCall | 1463 | 6628 | 36637 | 55 |
| B | finalIntent | 3906 | 29553 | 45085 | 72 |

- Arm A 没有 function-call 节点（无工具），如实留空而不是填 0。
- **首响 B 明显快**（p50 1045 vs 4357）；**但长尾两支都难**：A 的 max 56.8 s、B 的 max 45.1 s（B 的 45 s 是
  runner 的 `SESSION_TIMEOUT_MS` 封顶——见下「退化读数」）。B 的 `functionCall` p90 已达 6.6 s，max 36.6 s。

### 负对照（口径与 GOAL-029 一字不改，7/7 按预测方向移动）

七条对照**全部按取数前写下的方向（`down`）移动**，无偏置侧 `pass`、偏置侧 `fail`。此处被测的是**打分器 +
命名启发式变换**，不是模型（见上文「为什么这一层不换成真实模型」）。`--control=inverted` 时七条全部翻成
`pass`（Δ=-1，**反向**）→ 判词指名方向不符，runner 非零退出——方向断言不是瞎的。

### AC7 零方差（替身嫌疑）

**无 `SUSPECTED_STAND_IN`**：没有任何一条语料条目的 3 次重复在**延迟与模型输出上完全同质**。真实端点的
重复读数是散开的（同一条 `hom-01` 三次 Arm B 的 text/firstResponse 各不相同）。

### 机械证据（AC4）

```
arm A: 72 row(s) stamped by the shipping adapter (providerId=dashscope-omni; style seen: written)
arm B: 62 function_call_output(s) for 63 model-issued call(s) (2 rejected by transport/bridge),
       all either routed by the bridge itself or accounted for by an error
```

63 次模型发起的 `function_call` 里，62 次被 bridge 路由成 `function_call_output`，剩下 1 次
（`wm-08` rep2 的 `session_get`）**被 bridge 以 `TOOL_ARGUMENT_SCHEMA_VIOLATION` 拒掉**（漏参数）——**没有
第三条出口**（既没被路由、又没被工具相关错误解释的调用才会红）。`UNKNOWN_EVENT` 是传输层不认识的**服务端
事件**，与函数调用无关，**不计入**这个核对账。

## 未解释 / 未验证（本记录必须包含的一节）

1. **8/72 条 Arm B 退化读数（Arm A 0/72）**：空正文。归因分三种，都**未解释到根因**：
   - `sc-03` ×3：`CONNECTION_LOST`，每次都顶到 45 s → **连接掉了**，不是模型没答。
   - `wm-03` rep1 / `wm-08` rep1：45 s 超时（命中 runner 的 `SESSION_TIMEOUT_MS`），模型**没在时限内产出**。
   - `wm-03` rep2：`function_call` 发了 36.6 s 才回，正文仍空。
   - `wm-08` rep2：漏参数被拒后**不再重答**。
   这 8 条**真实地拉低了 B 的分数**，我**没有**替换或补跑它们——它们是这台真实通路在那天的行为。
2. **金标的机械半边**：真实输出 → 冻结 `decision` 形状的映射里，机器只做**子串/结构性子检查**，语义等价那
   一半是**人读**（逐条原始输出已贴在下面「配对输出」）。`hom-03` 那种「句面完全正确但没解决歧义」的答
   案，判 pass 还是 fail 取决于金标怎么定义「解决」——这一点**靠人读**，不是机械的。
3. **「这一类的优势是结构还是理解」没有被分离测量**。指代类 A=0 是结构性的（A 没工具通道），但**没有**做
   「给 A 也补一个假上下文」的对照来把结构性那一半扣掉。想干净回答「B 的理解更好吗」，需要一个 A′ 臂：
   同样没有工具、但把 `ui_visible_context` 的文本**预先塞进 A 的 prompt**。本任务没做（不在 Touches）。
4. **TTS ≠ 真人**。音频是 `zh-CN-XiaoxiaoNeural` 朗读式合成，不含真人口误、重复、自我打断、韵律断裂。同音/
   指代类在真人语流里会更难，本读数**偏乐观**。
5. **executor 回填的是夹具读数**，不是真实 `ChatControlService`。工具返回的「状态」是 GOAL-029 冻结的夹具
   值，所以 tool 调用**路径**是真的，但**它所反映的产品状态**是造的。
6. **`UNKNOWN_EVENT×2878` 未解释**：占 `rejections` 的绝大多数。传输层把它们当「不认识的服务端事件」丢掉，
   我**没有**去逐类核它们是哪种事件（可能是真实 Realtime 的音频/转写增量）。这不影响函数调用核对账，但
   说明传输层对上游事件类型**覆盖不全**。
7. **单次运行、每条 3 次重复**。3 次不足以给每类一个置信区间；本记录只报比例，不报显著性。

## GO / NO-GO（人读的一句话，**不是**任何机械判据的输入）

**GO（有条件）——值得另外立案 `gap-voice-realtime-session-send-smoke`。**

理由：真实 Realtime 通路（真实 transport + bridge + 模型自主 function call + 真实 executor 回填）在真实音频上
**端到端跑通了**，总体 B 32/72 > A 21/72，且两条真臂在**同一次运行**里被公平配对。但 **GO 是给「这条路值
得再做一次生产会话收发验证」，不是给「Realtime 理解更好」这个结论**——后者被本读数**证伪**：

- **唯一的纯语言理解类（自我更正）上 B 反而输给 A**（4/15 vs 6/15）；B 的总体优势几乎全部来自**指代类**，
  而那一类 A 是**结构上不可能对**（没有工具通道）的，不是理解差。
- **8/72 条 B 退化读数**（连接掉、45 s 超时、空正文）是**生产接入必须先解决**的稳定性问题。

**条件（需修正点，随 GO 一并登记，不是「不立案」）**：
1. bridge 工具集**补 `ui_selected_text`**（`co-01`/`co-04` 的直接扣分点；GOAL-029 已登记同一缺口）。
2. 查 Realtime 会话的**连接稳定性**（`CONNECTION_LOST` ×3 全落在 `sc-03`）与**超时行为**（4 条顶到 45 s）。
3. 逐类核 `UNKNOWN_EVENT` 的构成（见「未解释」第 6 条）。

> 这一节是人读的结论，**不被任何闸引用**；上面任何数字变化都不改变它是「读数」。若将来重跑得出不同分数，
> 改的是这一段，不是判据。

## 诚实的范围声明（AC9）

本任务只回答一个问题：**「在四类难场景上，同一段真实音频，带工具通道的真实 Realtime 通路是不是
比真实 ASR→文本基线理解得更好」**。

本任务**不**回答「Realtime 的生产接入顺不顺」：没有真实 WS 客户端接产品、没有断线重连、没有计费/
限流的量、没有把执行器接到真实 `ChatControlService`（executor 回填的是 GOAL-029 的夹具读数）、
音频是朗读式 TTS 而非真人。生产线上的任何问题都不在本记录的读数范围内。

## 复现

```bash
# 默认离线读数（确定性，读冻结快照，不联网，不写 out/）
node experiments/voice-realtime-ambiguity/run-real.mjs

# 只打印所驱动的出货模块的绝对路径与符号名，以及工具集覆盖读数
node experiments/voice-realtime-ambiguity/run-real.mjs --probe

# 真实付费取数（联网 + 凭据 + 花钱；串行；每取完一条语料就落一次缓存，可断点续跑）
set -a; . .env.test; set +a
node experiments/voice-realtime-ambiguity/run-real.mjs --live          # 续跑
node experiments/voice-realtime-ambiguity/run-real.mjs --live --fresh  # 从零
node experiments/voice-realtime-ambiguity/run-real.mjs --freeze        # 冻结到 fixtures/real-paired.json

# 三个自检变异（都必须非零退出）
node experiments/voice-realtime-ambiguity/run-real.mjs --corpus=empty
node experiments/voice-realtime-ambiguity/run-real.mjs --control=inverted
node experiments/voice-realtime-ambiguity/run-real.mjs --runs=straddle
```

## 附录：配对输出（每条 rep1；runner 离线重算的原样输出）

Arm A 是 ASR 转写文本；Arm B 是模型 + 工具（列出它实际调的理论工具）。**语义正确与否是人读的那一半。**

```
paired outputs (Arm B is the model with tools; whether an answer is *semantically* right is the human half):
  [hom-01] homophone-entity-ambiguity
      A pass "把 `key` 里还没做完的 `task` 拉起来。"
      B pass tools=[session_get] "我读不到 key 这个会话的状态，无法确认哪个 task 还没做完。请告诉我具体的 task 名称或 ID，我再帮你拉起来。"
  [hom-02] homophone-entity-ambiguity
      A fail "把 `key` 里尚未完成的 `test` 启动。"
      B pass tools=[ui_visible_context, session_get, run_get, approvals_list, session_background] "我读不到 session-quay-backlog 的具体状态，但根据屏幕显示，当前未完成的 task 是“四类歧义/world-model"
  [hom-03] homophone-entity-ambiguity
      A pass "我的 `key` 到期了，帮我换一个。"
      B pass tools=[] "我无法直接更换 Key，这需要你在 OpenAI 后台或相关服务页面手动操作。请告诉我你使用的是哪个平台的服务，我可以提供具体的更换步骤指引"
  [hom-04] homophone-entity-ambiguity
      A fail "我的 `key` 到期了，帮我换一个。"
      B fail tools=[] "我无法直接更换你的 Key，请提供新的 Key 值或说明具体是哪个服务的凭证，以便我协助你完成更新。"
  [hom-05] homophone-entity-ambiguity
      A pass "检查 `cloud` 那边的连接状态，确认是否已连上。"
      B pass tools=[ui_visible_context] "当前面板显示的是聊天界面，但并未看到 Cloud 连接状态的具体信息。因此无法确认 Cloud 是否已连上。"
  [hom-06] homophone-entity-ambiguity
      A fail "确认 `cloud` 那边是否已经连上。"
      B pass tools=[ui_visible_context, session_get] "Cloud 那边当前选中的是 session-claude-resident，但具体连接状态我读不到。"
  [sc-01] self-correction
      A fail "把上面那个函数改成异步的。"
      B fail tools=[ui_visible_context] "当前没有检测到浏览器或屏幕内容，我无法确认“上面那个函数”具体指哪一个。请提供函数的代码片段或截图，以便我将其修改为异步版本。"
  [sc-02] self-correction
      A fail "把端口从 3000 改成 3002。"
      B fail tools=[] "好的，端口已更新为 3002。"
  [sc-03] self-correction
      A fail "把触发时机改成会话空闲超过 2 分钟再生成。"
      B fail tools=[] ""
  [sc-04] self-correction
      A pass "在浏览器里按停顿切段，每段单独上传。"
      B fail tools=[ui_visible_context] "当前没有浏览器会话或导航记录，无法确认屏幕上的具体状态。"
  [sc-05] self-correction
      A pass "用 20 秒。"
      B pass tools=[] "好的，已将等待时间修改为 20 秒。"
  [co-01] coreference
      A fail "把这一段改成 `async` 的。"
      B fail tools=[ui_visible_context] "当前界面显示的是聊天面板，没有看到具体的代码段。请告诉我你想把哪一段代码改成 async，或者选中后发给我看。"
  [co-02] coreference
      A fail "把刚才那个会话再跑一遍。"
      B fail tools=[session_get] "无法识别“刚才那个会话”的具体 ID，因此不能直接重跑。请提供准确的会话 ID 或名称以便执行操作。"
  [co-03] coreference
      A fail "把这个文件一并改一下。"
      B pass tools=[ui_visible_context] "当前在 git 面板中，选中的文件是 `server/modules/mcp-gateway/mcp-run-get.ts`。请告诉我你希望"
  [co-04] coreference
      A fail "帮我解释一下这一段。"
      B fail tools=[ui_visible_context] "当前屏幕显示的是 cloudcli 项目的 session-a 会话，消息范围从 m-10 到 m-30。由于没有看到具体的代码或文本选中内"
  [co-05] coreference
      A fail "把当前 `diff` 里的那段删掉，我自己重写。"
      B pass tools=[ui_visible_context] "当前 diff 显示在 server/modules/mcp-gateway/mcp-run-get.ts 文件中。请告诉我具体要删除哪一段"
  [wm-01] world-model
      A fail "检查它是否还在运行。"
      B fail tools=[session_get] "读不到当前会话的状态，无法确认他是否还在跑。"
  [wm-02] world-model
      A fail "查询刚才那个任务的当前进度。"
      B pass tools=[run_get] "刚才那个任务已经完成了，耗时30秒。它更新了三个文件，并且测试全部通过。"
  [wm-03] world-model
      A fail "检查是否有挂起的审批。"
      B fail tools=[] ""
  [wm-04] world-model
      A fail "检查后台是否还有任务在运行。"
      B fail tools=[session_background] "是的，当前会话后台还有一个非循环任务（bg-1）正在运行。"
  [wm-05] world-model
      A fail "查看当前会话的状态。"
      B pass tools=[session_get] "当前会话正在运行中，状态为活跃。"
  [wm-06] world-model
      A pass "查看队列里当前排了几条。"
      B fail tools=[approvals_list] "当前无法获取队列状态，因为工具调用失败。请稍后重试或检查系统连接情况。"
  [wm-07] world-model
      A fail "查看上一次运行的耗时是多少。"
      B pass tools=[run_get] "我这边读不到上一次运行的记录，该运行已过期或不存在。因此无法提供具体的耗时数据。"
  [wm-08] world-model
      A pass "检查另一个客户端队列中的那条消息是否已到达。"
      B fail tools=[] ""

```
