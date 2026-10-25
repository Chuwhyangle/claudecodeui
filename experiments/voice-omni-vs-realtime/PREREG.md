# Realtime relay vs non-realtime omni flash：真实 live voice 音频上的消融

状态：取数前写定（2026-10-22）。本文件之后才调用付费接口；判定规则与预测不在看过读数后修改。

## 要回答的问题

把真实 live voice 的一段音频、它当时看到的 C2 上下文、以及当时 realtime relay 的产出放在一起：

1. **非 realtime 的 `qwen3.8-omni-flash` 能否把 realtime relay 的「转写 + 改写」做到接近？**
2. 如果能，差在哪些形态（标点/大小写、术语、指代、增删内容）？
3. 把「当时的上下文」交给它，是帮助还是像 A2 那样造成泄漏/竞争者替换？
4. 如果一次调用做不到，前作（`voice-draft` S1）的「两阶段：先听、再带上下文只输出可校验替换表」能补回多少？

## 数据

8 条真实 utterance，来自 5 个 live voice connection（2026-10-21 ~ 10-22）：

| key | connection | 时长 | 现象 |
|---|---|---|---|
| referent-architecture-tab | 6c76e1cf | 11.5s | R 把「RTX TM 这个图」改成「architecture tab」 |
| referent-live-voice-test | 711e54cc | 2.9s | R 把「外界测试」改成「live voice 测试」 |
| term-live-voice-case | bf517472 | 21.1s | R 把「Live模式下」规范成「Live Voice 模式下」 |
| long-punctuation | e8df1709 | 18.2s | 长句，R 只补标点/重复词逗号 |
| short-subject-add | e8df1709 | 4.0s | R 补主语「你」 |
| list-punctuation | e8df1709 | 6.9s | R 把「commit，build」改成「commit、build」 |
| case-normalization | acf7fc73 | 5.8s | R 小写「Live Voice」并去逗号 |
| long-driving-live-voice | 262537d7 | 9.6s | 长句，R 修重复并把「Live Voice」大写 |

- **音频**：从 `~/.cloudcli/voice-realtime-capture/<connection>.wav` 按 timeline 的 `speech_started`/`speech_stopped` 切出，前滚 300ms、尾 500ms；16 kHz mono PCM16。
- **上下文**：按浏览器 `buildVoiceContextPack` 的同一规则（newest-first、600 字/行、2000 字预算）从 app 的 session history 重建；每一步都与 proxy journal 的 `context received chars=/rows=` **逐字节对账**，8 条全部精确相等。上下文原文在 `out/fixtures.json`。
- **参照 R**：当时 proxy journal 里真正 delivered 的 `session_send.message`（按时间与 `transcription.completed` 1:1 配对，10s 窗口）。R **不是 ground truth**，只是「realtime 当时实际产出的样子」。

## 臂

| 臂 | 做法 | 上下文 |
|---|---|---|
| **R** | realtime relay 当时的 delivered message（不重新调用） | 当时注入 instructions 的 C2 |
| **N0** | 非 realtime omni flash + relay 风格 prompt（修明显听错、接碎句、不转述、不加内容、只输出整理后的文字） | 无 |
| **N1** | 同 N0，但把当时的 C2 按 realtime 的 header/template 放进 system message | 有（正确） |
| **N1-wrong** | 同 N1，但用**另一条 utterance 的上下文**（负对照，仅两条指代类） | 有（错误） |
| **N2** | 出货 `dashscope-omni` 适配器：E 组两步 JSON（转写 + 书面化指令），`reasoning_effort=low` | 无 |
| **T** | 两阶段：取 N0 文本 + 正确上下文 → `qwen3.8-flash` 只输出替换表 `{replacements:[{from,to}]}`，本地四条机械校验后应用 | 有（文本阶段） |

- N0/N1/N1-wrong：`qwen3.8-omni-flash`，`reasoning_effort=none`，`temperature=0`（若服务拒绝则省略并登记）。
- N2：出货适配器，promptVersion `written-e-2026-09-24`。
- T：`qwen3.8-flash`，`enable_thinking=false`；机械校验：`from` 在 N0 文本里逐字出现；`to` 在上下文或仓库名字集里；`from` 与 `to` 的归一编辑距离 / 较长者 ≤ 0.5；`from` 本身不是仓库已存在的合法名字（与 voice-draft D 臂同规则）。
- 重复：N0/N1/N2/T 每格 2 次；N1-wrong 每格 1 次。

## 指标

1. **相对 R 的语义等价**（人读，主读数）：2 = 同义/同指令（标点、大小写、无意义口头禅差异不算）；1 = 部分/可靠上下文恢复；0 = 误导或换了内容。
2. **逐字距离**：归一化（去标点/空白/大小写）后的 CER vs R；只作描述，不单独判定。
3. **标识符/术语保真**：拉丁词、文件名、数字、`Live Voice`、`architecture tab` 等，候选 vs R、vs ASR。
4. **上下文泄漏**：候选里出现上下文中的 8 字以上片段或专有名字，而 R/ASR 都没有；人读确认。
5. **增/删内容**：候选相对 ASR 增加或删除了实质内容（人读）。
6. **延迟** p50/p90；**成本**（usage/cost，若返回）。
7. **负对照**：N1-wrong 在两条指代类上不得比 N0 更接近 R；若更接近，说明判据/上下文没有区分力。

## 预测（取数前）

- **P1**：N0 在「R 只做标点/大小写/去口头禅」的条目上语义等价 ≥ 4/8；这些条目不需要上下文。
- **P2**：两条指代类（architecture tab、live voice 测试）N0 会丢/保留错词，N1 可能修回，但 N1 在至少一条上出现上下文泄漏或竞争者替换（与 A2 方向一致）。
- **P3**：N1 的总体语义等价不高于 N0；上下文不是免费的。
- **P4**：N2（书面化指令）会比 N0 更偏离 R：它会删口头禅、重排句子、把疑问/陈述改写成指令，且可能压缩标识符。
- **P5**：T 能修拼写/术语类，但修不了「RTX TM → architecture tab」这种编辑距离大的语义替换；T 的总体不会显著高于 N0。
- **P6**：延迟 N0/N1 p90 > 10s，明显慢于 realtime 的流式体验；T 每次再加约 1–3s。

## 判定

- 若 **N0 ≥ 6/8 语义等价 R**，且 N1/T 没有稳定增益：结论是「非 realtime omni + relay prompt 已足够做听写；不需要 realtime dictation 管线」。
- 若 **N0 只在指代类失分，N1 或 T 能修回且无泄漏**：结论是「两阶段/带上下文的一次调用可用，但需要泄漏护栏」。
- 若 **N0 明显低于 6/8，或 N1 修回的同时泄漏/替换**：结论是「realtime 的上下文+改写不是一次 batch 调用能替代的，realtime dictation 才有意义」。
- 任何结论都只针对这 8 条真实音频与这两个模型；不外推到全部口述。

## 局限（取数前）

- n=8，单次采样每格 2 次；只报方向与逐条差异，不做显著性。
- R 是 realtime 的产出，不是人工真值；R 自己也会加主语/换术语（本实验会逐条标注）。
- 音频是单条 utterance 的切段，不是 realtime 当时听到的整段连续流；跨段上下文/自我更正可能因此不同。
- 上下文重建已与 journal 的 chars/rows 对账，但 journal 不保存 pack 正文；同一连接的历史在取数后仍可能被后续消息改变（本实验用的是取数时的 history dump）。
- 只测 `qwen3.8-omni-flash` / `qwen3.8-flash`，不外推到其他模型。
