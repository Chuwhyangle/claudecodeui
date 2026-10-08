# Realtime vs ASR→文本：四类歧义 / world-model 上的配对理解质量

**一句话**：在同一批 24 条冻结语料上，把「ASR→一句书面指令」（Arm A）与「桥在工具通道上的 Realtime
会话」（Arm B）放在**同一次运行**里对比，读数是 **A 10/24 · B 22/24**；两条臂的差距集中在**结构**上
（能不能读夹具、能不能读工具），不在「谁听写得更准」——本记录量到的就是这个结构差，以及它**没有**量
到什么。

- 日期：2026-10-09
- 运行 id：`run-voice-realtime-ambiguity-offline-1`（48 条读数**全部**带它；`--runs=straddle` 必须红）
- runner：`experiments/voice-realtime-ambiguity/run.mjs`
- 语料与打分口径：`experiments/voice-realtime-ambiguity/PREREG.md` + `fixtures/`（由
  `gap-voice-realtime-ambiguity-prereg` 在看过任何读数**之前**冻结；本任务一个字节都没改）
- 离线默认，不联网、零模型调用、不写 `out/`：`node experiments/voice-realtime-ambiguity/run.mjs`

> **本记录里的每一个质量数字都是一份读数，不是判据。** 它们不被任何闸引用，改动它们也不是回归。
> 这一句同时是 runner 的末行。

## 被测的两条通路（都经出货模块）

| | Arm A（ASR→文本） | Arm B（Realtime bridge） |
|---|---|---|
| 模块 | `shared/asr/asrRegistry.ts#resolve` → `shared/asr/list/dashscope-omni/dashscope-omni.asr-provider.ts#transcribe` | `server/modules/voice-realtime/index.ts#connect`（`voice-realtime-bridge.service.ts`） |
| 输入 | 一个 ASR 请求（适配器自己拼请求体、自己判 MIME/大小、自己解析答案） | `session.update` + 一串 `function_call`（经 bridge 自己的测试用假 WS 服务端送达） |
| 工具通道 | **没有**——`capabilities.honors.context === false`，契约里没有函数调用这一格 | `REALTIME_TOOLS` 的 6 个只读/写工具，路由由 bridge 自己做（executor 只回答「读到了什么」） |
| 上下文 | 不携带（这条臂的通道里没有上下文这一格） | 每个 entry 的冻结夹具状态 |

runner 的 `--probe` 打印的是**绝对路径 + 符号名**，并断言它们在出货树内、不在工装内；工装自扫里没有
第二份 ASR 请求构造、第二份 bridge、第二份假传输。**没有 `--live`**：联网 + 凭据 + 花钱的那条路不进
判据集，也不在本次读数里。

## 离线替身（这份读数的交换率，必须写在这里）

离线默认**不联网、零模型调用**，所以「模型的理解」由 runner 里一个**确定性替身**给出：它按每条 entry
的**脚本**与**夹具状态**（且只经出货工具的**返回形状**）做决定——把话解析到哪个实体、调哪个只读工具、
答什么状态、还是诚实说「读不到」。三条硬约束：

1. 替身**不读 gold**。标准答案是打分器的，不是替身的。
2. 替身只从**出货工具的真实返回**里找证据。同音类的证据来自 `ui_visible_context` 的小写子串；夹具里
   的 `note` / `diffExcerpt` / `repoNameSet` **不在**真实返回里，读了就等于给这条臂开了一条真模型没有
   的通道（`ctx-code-diff-key-variable` 的 `diffExcerpt` 逐字写着 "NOT the Quay task store"，正是要用
   来诱捕先验偏见的诱饵，不能当证据读）。
3. 替身只能调 bridge **广告过**的工具。计划里出现未广告的工具时进 `blocked`，并在本记录里作为**发现**
   登记（见下）。

因此这份离线读数量的是**两条通路的形状与接口**：Arm A 结构上拿不到工具、也拿不到上下文，Arm B 能。
**真实模型（`--live`）才会把「认知误差率」量出来**——本记录不做这个宣称。

## 四类读数（同一次运行，同一批 entry）

`node experiments/voice-realtime-ambiguity/run.mjs`，n=24（6 / 5 / 5 / 8）× 2 臂 = 48 条读数。

| 类别 | n | 冻结最小值 | Arm A | Arm B |
|---|---|---|---|---|
| 同音实体歧义 `homophone-entity-ambiguity` | 6 | 5 | **3/6** | **6/6** |
| 自我更正 `self-correction` | 5 | 4 | **5/5** | **5/5** |
| 指代消解 `coreference` | 5 | 4 | **0/5** | **3/5** |
| world-model / 状态查询 `world-model` | 8 | 6 | **2/8** | **8/8** |
| **合计** | **24** | — | **10/24** | **22/24** |

### 1. 同音实体歧义（A 3/6 · B 6/6）

**结论**：**上下文把这一类从「必须先问」变成「能直接定」。** 三条无上下文的脚本（`hom-01/03/05`，
gold `ambiguity`）Arm A/B 都只能**提出澄清问题或先读证据**才 pass——Arm A 无上下文通道，其唯一合法
行为就是问；三条有上下文的（`hom-02/04/06`，gold `Quay` / `access-token` / `Claude`）**Arm A 全灭**
（`resolution` 恒为 null），Arm B 靠 `ui_visible_context` 唯一命中候选（`selectedProject: "quay"` →
Quay；`session-token-rotation` → access-token；`session-claude-resident` → Claude）。这正是 PREREG
里「ambiguous 也是一种合法 resolution」的判据在起作用：**无证据地锁定任一具体实体是编造**，所以
Arm A 在无上下文那三条上不是「答错了」，是「问了」——问是这一类里正确的行为。

### 2. 自我更正（A 5/5 · B 5/5）

**结论**：**这一类不需要任何工具通道，两条臂打平。** 自我更正是**文本内**的性质：反悔标记（`——不对，`
/ `嗯不对，` / `换成` / `还是`）把脚本切成「被撤回的一段」与「收敛后的一段」，收敛段的内容锚点必须在
最终意图里、被撤回的一段必须缺席。两条臂的书面指令都完整携带了脚本，所以在五条上全对。
**没有位移不是「这一类不重要」，而是它证明了前两类的位移不是共模的**：如果 runner 只会「Arm B 全赢」，
这份读数就没有信息量；自我更正这一行是**内部对照**。

### 3. 指代消解（A 0/5 · B 3/5）

**结论**：这是**差距最大、也最需要如实说明**的一类。指代消解依赖一个「当前选中/可见内容」夹具状态，
纯音频不可解。Arm A 0/5（通道里没有读工具）。Arm B 3/5，**不是 5/5**，因为——

> **发现（登记，不是判据）：出货 bridge 的 `REALTIME_TOOLS` 里没有 `ui_selected_text`。**
>
> 语料里 `co-01` / `co-04` 的 `requiredReads` 就是 `ui_selected_text`（夹具 `ui-selection-function` 的
> 选区里躺着 `sendMessage` 的函数体）。bridge 广告的 6 个工具是
> `ui_visible_context / session_send / session_get / run_get / approvals_list / session_background`，
> 选区读**不在其中**；MCP 网关自己**是**注册了这个读工具的（`server/modules/mcp-gateway/mcp-gateway.read-tools.ts`
> 的读工具表，`mcp-ui-visible-context.ts` 的 `ui_selected_text` 注册），是 bridge 的镜像集合没有带上它。
> 因此这两条 entry 在 Arm B 上**不可解**，判词逐字写着
> `did not call ui_selected_text before resolving the reference (not advertised by the shipped bridge: ui_selected_text)`。
> `--probe` 每次运行都重算并打印这个覆盖差（`NOT advertised: ui_selected_text`）。
>
> 这不是本任务该修的东西（bridge 的工具集是兄弟任务的交付面），但它是 GO/NO-GO 的一个**输入**：在把
> 语音控制面接到 Realtime 会话之前，bridge 的广告工具集需要补上选区读，否则「把这一段改成 async 的」
> 这类指令在真实会话里同样落不了地。

Arm B 拿下的三条（`co-02/03/05`）靠 `ui_visible_context`：`selectedSession` → `session-quay-backlog`；
`currentDiff.files[0]` → `server/modules/mcp-gateway/mcp-run-get.ts`。两条 `must-not-invent` 负对照
（无选区 / 选区 `withheld`）在 Arm B 上是**诚实说读不到**（pass）——但注意这里也受同一个发现影响：
「选区是 null」与「选区被 withheld」的区别本身只有 `ui_selected_text` 能看见，bridge 上看不到，
Arm B 的诚实回答是「本通路调不到 `ui_selected_text`，读不到依据」。**结论仍然成立**（诚实 > 编造），
但**「这两条能区分 null 与 withheld」不能被本读数宣称**。

### 4. world-model / 状态查询（A 2/8 · B 8/8）

**结论**：**这一类是「有没有读工具」的干净对照。** 8 条里 5 条 `has-answer`（`run_get` /
`approvals_list` / `session_background` / `session_get` 的夹具读到 `running` / `completed` / `approval`
/ `background` / `running`），3 条 `no-info`（没有队列读工具、run 记录已过期 `RUN_NOT_FOUND`、别的客户端
排的队看不见）。PREREG 的 toolRule 是「没读工具就直接作答，无论对错都记 fail（瞎猜不算）」，所以
Arm A 在 5 条 `has-answer` + `wm-07` 上全部因为**没读工具**而 fail（判词：
`answered without reading run_get (the toolRule: a guess is not an answer)`）；它拿下 `wm-06` / `wm-08`
（这两条本来就不需要读工具，诚实说不知道即 pass）。Arm B 8/8：读工具 → 状态 / 诚实说读不到。
**`no-info` 那三条是 AC6 的核心**：诚实说「不知道」记 pass，编造一个具体值记 fail——见下面的
`wm-neg-02`。

## 负对照（取数**之前**写下方向，7/7 按预测方向移动）

`node .../run.mjs` 每次运行都重算这 7 条并在**同一次运行里**跑四条变异。方向全部是 `down`（带偏置的
那一侧分数更低）。

| 对照 | 类别 | 被变异的启发式 | 无偏置 | 偏置 | 判词 |
|---|---|---|---|---|---|
| `hom-neg-01` | 同音 | 仓库实体先验（总偏好 Quay） | pass | fail | `resolution "Quay" ≠ gold "code-identifier"` |
| `sc-neg-01` | 自我更正 | last-wins（只看最后一个「改成」） | pass | fail | 缺 `"A"`, `"B"`（丢掉了 A→B 那个改动） |
| `sc-neg-02` | 自我更正 | 见到「删掉」就当撤回命令 | pass | fail | 执行了被当场否定的命令（「不用，留着」） |
| `co-neg-01` | 指代 | 总是把「这一段」解析到某个对象 | pass | fail | 编造了一个 referent |
| `co-neg-02` | 指代 | 把 `withheld` 当作「有文本」 | pass | fail | 编造了一个 referent |
| `wm-neg-01` | world-model | 只要有 run 行就答「还在跑」 | pass | fail | `state "running" ≠ gold-backed "aborted"` |
| `wm-neg-02` | world-model | **打分器层面**：凡非空回答都算对 | pass | fail | 诚实打分器给编造记 0；被拒绝的那种口径会给同一个编造记 **pass** |

`wm-neg-02` 没有「臂」可偏置，它的两侧是**同一个诚实打分器面对两个答案**：一个诚实说「读不到」的
答案（pass）与一个编造出具体条数的答案（fail）。runner 把被拒绝的那种口径的读数一起打印出来
（`the rubric this class rejects would score the same fabrication pass`）——这样「本类拒绝的是哪一种
打分器」不是一句声明，而是一个每次运行都重算的量。

### 四条自检变异（都必须非零退出，且红在预期位置）

| 变异 | 退出码 | 理由（逐字） |
|---|---|---|
| `--corpus=empty` | 1 | `[n] the corpus is EMPTY — n=0 × 2 arm(s) = 0 readings, and an empty reading is not a green one` |
| `--control=absent` | 1 | `[control] --control=absent: every negative control was removed from the table, so nothing in this run was falsifiable` |
| `--control=inverted` | 1 | 7 条全部 `朝预测的**反方向**移动`，每条判词**指名**是哪个对照、预测方向 `down` |
| `--runs=straddle` | 1 | `[pairing] the readings come from 2 different runs (1970-01-01T00:00:00.000Z (1 reading(s)); run-voice-realtime-ambiguity-offline-1 (47 reading(s)))` |

默认运行本身必须**绿**（exit 0），这四条变异才有意义：一个永远返回红的 checker 也能通过全部变异。

## 未解释 / 未验证（本记录不能宣称的东西）

1. **没有合成 TTS 音频。** PREREG 的 `audioPlan.note` 写明音频要由本任务（Task 3）合成到
   `fixtures/audio/<id>.wav`，`--live` 那条路才真正需要它。本次读数是**离线确定性**的，读的是
   **脚本文本 + 夹具状态**，一个 `.wav` 都没合成、没提交。**偏离登记**：音频未合成。后果是这份读数
   对「识别错的字怎么影响歧义解析」**零信息**——「quay/key 同音」这一类的**声学侧**没有被量到，被量到
   的是「拿到文本之后，有没有通道把它解对」。
2. **替身在拿到证据后是一个完美读者。** 它按固定规则解析，没有认知误差率。所以 Arm B 的 22/24 是
   **能力上限的形状**，不是真实模型的分数。真实分数只有 `--live` 才量得到。
3. **单次运行只给方向，不给区间。** n=24 是冻结语料的大小，没有重复采样、没有 Wilson 区间；
   10/24 vs 22/24 的差落在哪些 entry 上是逐条可查的，但「差多少个百分点」这种说法在本记录里不成立。
4. **Arm A「不能调工具」是从出货声明读出来的**（`capabilities.honors.context === false`，且适配器契约
   里没有函数调用这一格）；runner 在每次运行里断言这一点，一旦有人把适配器的上下文能力翻成 true，
   运行会红，逼着重推这条臂的能力。
5. **`sc-01` 的机检形态只查子串。** gold 的区分点是「上面那个函数」（而不是「当前选区那个函数」），
   runner 查的锚点正是 `上面那个函数`——它能抓住「更正没生效」这个失败，**抓不住**「上面那个函数到底
   是不是 `createSession`」（那要读 `noteUpstream`，而 `noteUpstream` 不在真实工具返回里）。语义等价
   那一半是**人读**的，见 paired outputs 一节。
6. **PREREG 的 `forbidden` 逐字串在这里不可用。** 例如 `sc-02` 的 `forbidden: ["3000","三千"]`，
   而「三千」是正确答案「三千零二」的**子串**——逐字子串检查既不充分也会误伤（`sc-02` 的 Arm A 答案是
   「三千零二。」，会被逐字检查判红）。**偏离登记**：机械形态取 `forbidden` 的**构造来源**——按反悔
   标记把脚本切开的「被撤回的那一段」不得出现在最终意图里，同时收敛段必须携带内容锚点。这是更严的
   形态（它连「空答案」也一起拒了）。
7. **`ui_selected_text` 不在 bridge 工具集里**（见「指代消解」一节的发现框）。本轮 Arm B 的 3/5 里，
   有两条是**结构上不可解**，不是「解析错了」。
8. **Arm B 的两条 `must-not-invent` 对照是诚实说读不到，但用的理由是「工具调不到」**，不是「选区是
   null / 被 withheld」。在补上 `ui_selected_text` 之前，本读数**不能**宣称桥能区分这两种夹具。

## GO / NO-GO（人读的一句话，**不是**任何机械判据的输入）

**方向：Go（结构上）** —— 工具通道带来的理解能力增量是**大且分类清晰**的（world-model +6、指代
+3、同音 +3，而唯一不需要工具的自我更正是打平而不是倒退），所以把语音控制面接到 Realtime 会话上这
条路值得走；但 **Go 带一个前置条件**：出货 bridge 的广告工具集必须先补上 `ui_selected_text`，否则
「把这一段改成 async 的」这类最自然的语音指令在真实会话里会静默地落不了地。

这句话是**人读的**：它不被任何闸引用，也不会让任何机械判据变红或变绿。把它写进本记录是为了让下一个人
能复核，而不是为了让流水线读它。

## 诚实的范围声明（AC9）

本任务只回答一个问题：**「在四类难场景上，带工具通道的通路理解质量是不是更好」**——答案是**是**
（22/24 vs 10/24，且差异集中在结构性的三类上）。

本任务**不**回答**「Realtime 的生产接入顺不顺」**：没有真实 WS 客户端、没有 DashScope Realtime 的
凭据与计费、没有音频合成、没有延迟/成本/断线重连的量、没有真实模型的误差率。生产线上的任何问题都
不在本记录的读数范围内。

## 复现

```bash
# 默认离线读数（确定性，不联网，不写 out/）
node experiments/voice-realtime-ambiguity/run.mjs

# 只打印所驱动的出货模块与工具集覆盖读数
node experiments/voice-realtime-ambiguity/run.mjs --probe

# 四条自检变异（都必须非零退出）
node experiments/voice-realtime-ambiguity/run.mjs --corpus=empty
node experiments/voice-realtime-ambiguity/run.mjs --control=absent
node experiments/voice-realtime-ambiguity/run.mjs --control=inverted
node experiments/voice-realtime-ambiguity/run.mjs --runs=straddle
```

语料的完整性由 `experiments/voice-realtime-ambiguity/check-prereg.mjs` 单独自检（它只查预注册是否完整，
不查答案质量，末行逐字是 `this script only checks prereg completeness, not answer quality`）。
