# `dashscope-omni-relay` 的 `pauseCues: 'neutral'` 证据记录

**一句话**：`dashscope-omni-relay` 与 `dashscope-omni` 是**同一个服务、同一个模型**，裁剪只作用于音频，而 relay
只改了提示词与上下文位置，所以 `pauseCues: 'neutral'` 沿用 `docs/experiments/2026-09-24-omni-written.md`
的成对测量。**本文件不冒充一次新的音频轴运行**；它记录的是这次继承为什么成立，以及它什么时候不再成立。

**为什么需要一份自己的记录。** `scripts/asr-pause-cues-source-check.mjs` 的
「every registered provider names its OWN paired experiment」把两个 provider 指向同一份记录读成
「其中一个没有测量」——这是 ADR-004 决策 1 的纪律形状。relay 行因此需要一份属于它自己的记录；记录的
**内容**仍是同一次服务/模型测量，因为音频轴上没有第二个变量。

## 继承的是什么

`2026-09-24-omni-written.md` 在同一批 8 条 TTS 片段上跑了四条臂：

| 条件 | 语义满分 | 说明 |
|---|---|---|
| `omni|raw|none` | 7/8 | 参照条件，原始音频 |
| `omni|trim|none` | 6/8 | 出货 `trimVoiceAudio` 之后再送；裁剪没有赢，反而少了一条满分 |
| `omni|head|none`（负对照） | 0/8 | 只保留开头 2 秒；量具对音频损伤敏感 |

`dashscope-omni-relay` 的请求在音频轴上与 `omni|raw|none` / `omni|trim|none` 完全相同：

- 同一个 `qwen3.8-omni-flash` 模型；
- 同一个 `compatible-mode/v1/chat/completions` 端点与 `input_audio` data URI；
- 同一个容器白名单与整请求 10 MB 预算；
- 唯一的不同是 system turn 的提示词和是否带上下文，这两者都不改变送上去的音频字节，也不改变服务
  对「停顿被剪掉」的声学反应。

因此这条行声明 `pauseCues: 'neutral'`（照原样上传），依据是上表里 `trim` 没有优于 `raw` 的读数。

## 什么时候这条继承不再成立

以下任何一项变化都需要 relay 行自己的成对运行，并更新本文件：

- 换服务、换模型或换端点；
- 在客户端对音频做 relay 专属的预处理（降噪、重采样、增益、裁剪）；
- 服务的 `input_audio` 编码方式改变，导致同一段音频的字节不再与 E 组相同。

提示词、上下文内容或上下文位置变化**不**在此列：它们改变的是返回文本，不是音频轴。

## 与 relay 文本质量实验的关系

`experiments/voice-omni-vs-realtime/` 的 24 条真实 Live Voice 片段测量的是 **relay 提示词 + 上下文** 的文本
质量，不是 `pauseCues`。那份读数（human-preference 下 N1 19/24、oracle-strict 23/24、best-of 24/24）不能拿来
当裁剪证据，本文件也不把它算作第二条音频轴测量。
