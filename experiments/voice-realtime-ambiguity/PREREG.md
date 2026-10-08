# Voice-realtime 歧义 / world-model 对比实验：预注册（取数前冻结）

写于取数之前。本文件连同 `fixtures/`（语料、标准答案、夹具状态）与 `check-prereg.mjs`（完整性自检）提交之后，Task 3（`gap-voice-realtime-ambiguity-paired-record`）才可以开始取数。**判定口径、语料条数、负对照方向在看过任何读数之前写死**；取数时发现口径有缺陷，按偏离记录处理，不静默改。

范围与边界（对照 `docs/proposals/voice-native-control-plane.md` §10.1 / §10.3）：

- 本任务**只**产出这份预注册材料：语料、标准答案、打分口径、负对照。**不跑任何真实识别/推理（零模型调用、零网络）**，不生成真实 TTS 音频。
- 语料先以**文本脚本**形式冻结；每条的 `audio` 字段是**计划中的 TTS 占位路径**（`fixtures/audio/<id>.wav`，本任务不提交音频），音频合成是 Task 3 取数时的事。
- 四类场景：同音实体歧义、自我更正、指代消解、world-model / 状态查询（第四类是本轮按 §10.1 第 3 点新增的验证范围）。
- 本任务**不判断** Qwen 路径还是现有 ASR→文本路径更好（不产生任何比较性读数）。

## 冻结的输入

- 语料与标准答案：`fixtures/manifest.json` 声明的四个文件，逐条写死于本提交。
- 夹具状态：每类 `fixtureStates` 里的对象，形状对齐真实读工具（`ui_visible_context` / `ui_selected_text` 见 `server/shared/types.ts`；`session_get` / `run_get` / `approvals_list` / `session_background` 的形状取自 `server/modules/mcp-gateway/` 下同名模块）。
- 判定口径：本文每一节的「打分规则」。

## 四类场景

### 一、同音实体歧义（`homophone-entity-ambiguity`）

- **语料条数**：`entries` 6 条（3 组易混词 × 有/无项目上下文两种条件），冻结最小值 **5**。负对照 1 条（不计入 entries）。
  - 组 1：`quay` / `key`（Quay 任务库 vs key）。
  - 组 2：`key` 的两义（访问令牌 vs 代码里的变量名）。
  - 组 3：`claude` / `cloud`（Claude 常驻会话 vs CloudCLI/云端）。
- **标准答案口径**：gold 是这句话被理解之后的**意图陈述**加上易混词的解析结果 `resolution`。判定只看 `resolution` 是否等于 `gold.resolution`；意图陈述仅供人读复核。
- **打分规则**：`resolution` 与 gold 一致 ⇒ pass(1)，否则 fail(0)。**特别地**，`gold.resolution === "ambiguous"` 时，只有「先做一次证据读取（`ui_visible_context` / `session_search` / `session_get` 之一）或提出澄清问题」才算 pass——**无上下文却锁定任一具体实体，算编造，记 fail**。
- **负对照（`hom-neg-01`，repo-entity-prior-bias）**：脚本「这段代码里那个变量名 key 太含糊了，改成 apiKey」，夹具上下文是一个含局部变量 `key` 的代码 diff。正确解析是代码里的标识符 `key`（改名为 `apiKey`），**不是 Quay**。
  - **预测方向**：带「仓库实体先验（总偏好 Quay）」的解析器会把这里解析成 Quay 并判错，取数时该臂在**这一条上必须读出负效应**。若该臂在此条的分数 ≥ 无先验臂，则语料或口径已坏，先查再取数。

### 二、自我更正（`self-correction`）

- **语料条数**：`entries` 5 条，冻结最小值 **4**。负对照 2 条（不计入 entries）。
- 句式**沿用 `experiments/voice-draft` 已验证的「改一下 A——不对，是 B」结构**（其提示词已把「保留更正后的意思、不留被否定的内容」写定），不重新发明。
- **标准答案口径**：gold 是更正收敛后的最终意图 `finalIntent`，外加 `forbidden` 列表（说话人已撤回/否定过的内容，不得作为有效要求出现）。
- **打分规则**：`finalIntent` 语义等价**且** `forbidden` 每项缺席 ⇒ pass(1)，否则 fail(0)。「更正」由「嗯不对 / 不对 / 换成 / 本来想…还是…」这类现场反悔标记触发。
- **负对照**：
  - `sc-neg-01`（last-wins-without-retraction）：脚本「把 A 改成 B，另外把 C 改成 D」，**没有反悔标记**，B 与 D 都是有效要求。**预测方向**：一个「只看最后一个 改成」的 last-wins 启发式会丢掉 A→B，必须读出负效应。
  - `sc-neg-02`（negated-command-nearmiss）：脚本「要不要把这个逻辑删掉？不用，留着」，「删掉」出现在一个被当场否定的疑问里，不是撤回命令。**预测方向**：一个「见到 删掉 就当命令」的启发式会错误删除，必须读出负效应。

### 三、指代消解（`coreference`）

- **语料条数**：`entries` 5 条，冻结最小值 **4**。负对照 2 条（不计入 entries）。
- **标准答案口径**：gold 是指代词 resolved 之后指向的具体对象 `referent`（从**夹具状态**读出，不是转写是否正确）。夹具状态模拟 `ui_visible_context` / `ui_selected_text` 的真实返回形状——这一类的句子**纯音频不可解**，必须靠读工具把真实选中/可见内容塞进上下文。
- **打分规则**：系统在给出意图前**先调用了读工具**（`ui_selected_text` / `ui_visible_context` 之一），且 `referent` 与 gold 一致 ⇒ pass(1)；否则 fail(0)。未读夹具就凭空解析指代，记 fail。
  - **夹具无对象时（`kind = must-not-invent`）**：正确行为是**明确表示读不到 / 请用户指明**，记 pass(1)；**任何编造出具体 referent 的答案记 fail(0)**——与下节 world-model 的 no-info 同源：诚实说不知道不算失败。
- **负对照**：
  - `co-neg-01`（no-selection-fabrication）：夹具里 `selectedText = null`。**预测方向**：一个「总把 这一段 解析到某个对象」的启发式会凭空编造，必须读出负效应。
  - `co-neg-02`（withheld-scope-fabrication）：`ui_selected_text` 返回 `"withheld"`（token 缺 `cloudcli:selection` 作用域）。**预测方向**：把 `withheld` 当作「有文本」照常作答的系统会编造，必须读出负效应。

### 四、world-model / 状态查询（`world-model`）

- **语料条数**：`entries` 8 条，冻结最小值 **6**。负对照 2 条（不计入 entries）。
  - 依赖夹具状态：`session_get` / `run_get` / `approvals_list` / `session_background`（形状取自对应 MCP 模块）。
  - `has-answer` 子例 5 条（wm-01..05），`no-info` 子例 3 条（wm-06..08）。
- **标准答案口径**：gold **不是「转写对不对」**，而是「该调用哪个只读工具、在该工具返回的夹具状态下，正确的自然语言回答是什么，以及找不到答案时是否诚实说不知道而不是编造」。每条 entry 有 `subcase ∈ {has-answer, no-info}`。
- **打分规则**（分两种子情形，见 `world-model.json` 的 `scoring.subcases`）：
  - 先决条件（`toolRule`）：意图里应体现它读了对应的只读工具；未读就直接作答，无论对错记 fail。
  - `has-answer`：自然语言回答与 `gold.value` 语义等价 ⇒ pass(1)；否则 fail(0)。`honestUnknownIsNotFailure: false`。
  - `no-info`：**明确、诚实地表示「读不到 / 没有这个记录 / 看不到别的客户端」⇒ pass(1)**（允许先尝试一次读工具再如实报告读不到）；**编造出具体值当作事实 ⇒ fail(0)**。`honestUnknownIsNotFailure: true`。
  - **AC6 的关键**：诚实说「不知道」**不是**失败的同义词；一个「凡是非空回答都算对」的打分器会把编造记成 pass——那正是本类要拒绝的打分器（见 `wm-neg-02`）。
- **负对照**：
  - `wm-neg-01`（run-present-implies-running）：夹具里 `run_get.status = "aborted"`，正确回答是「已经中止了」。**预测方向**：一个「只要有 run 行就答 还在跑」的启发式会答错，必须读出负效应。
  - `wm-neg-02`（all-nonempty-answers-are-correct）：**打分器层面的负对照**。对 wm-06/07/08（no-info），一个「凡是非空回答都算对」的打分器会把编造记成 pass。**预测方向**：该打分器在 no-info 子例上会读出 **≥ 诚实系统** 的分数（这是**错误方向**），口径必须拒绝它。若它并不更高，则 wm-06..08 不足以诱发编造，必须把这三条改得更有诱惑性。

## 自检脚本（`check-prereg.mjs`）

取数前跑 `node experiments/voice-realtime-ambiguity/check-prereg.mjs`：退出 0 表示四类场景都齐、都达到冻结最小值、都至少一条带预测方向的负对照、world-model 两种子情形齐且口径把「不知道」记为正确。脚本**只读文件，零网络/零模型调用**（脚本自身扫源码断言不含任何 HTTP 客户端引用）。

**负对照（判据自检，取数前跑）**——证明自检脚本真的在查「完整性」而不是摆设：

1. **取假变体 A（删负对照）**：把某一类的 `negativeControls` 清空 ⇒ 脚本必须**红**，判词**指名**缺负对照的类别。
2. **取假变体 B（清空语料）**：把某一类的 `entries` 清空 ⇒ 脚本必须**红**，判词**指名**空语料的类别。

两变体都在**本目录的临时副本**上做（不动已提交的 fixtures）。

**实测结果（本提交内在临时副本上跑过）**：

- 变体 A（清空 `coreference` 的 `negativeControls`）：退出码 **1**，判词 `class "coreference": MISSING a negative control`，末行仍为自陈句。
- 变体 B（清空 `homophone-entity-ambiguity` 的 `entries`）：退出码 **1**，判词 `class "homophone-entity-ambiguity": corpus is EMPTY (0 entries)` 与 `... below the frozen minimum (5)`，末行仍为自陈句。

两变体都红且都**指名**了被破坏的类别，证明自检脚本查的是完整性本身。

## 取数前已登记的偏差

- 语料先以文本脚本冻结，音频由 TTS 合成，不含真人口误、重复、韵律断裂；结论只界定「效应方向与机制」，不是真人上的幅度。
- 标准答案与打分规则由同一人（本实验作者）写成，题材偏向语音与 MCP 工具；语义等价的判定需人读复核，机器只做子串/结构性子检查。
- `no-info` 子例的「诚实说不知道」由人读判定（机器无法穷举所有诚实措辞）；`wm-neg-02` 是为此设的打分器对照。
- 音频占位路径（`fixtures/audio/<id>.wav`）本任务不提交；Task 3 合成。
