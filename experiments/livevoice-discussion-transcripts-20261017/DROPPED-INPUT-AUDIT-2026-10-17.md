# Live Voice 丢输入审计（2026-10-17）

口径：把每个 journal（`~/.cloudcli/voice-realtime-log/<connectionId>.jsonl`）里的
`transcription.completed` 与 `function_call session_send` / `session_send delivered` 逐条对齐。
「丢失」= 该段被听到并转写，但在同一连接里没有任何投递消息覆盖它。时间均为本地时间（UTC+8）。

## 一、今天各轮读数

| 本地时间 | journal | 听到段 | 投递 | 丢失 | 丢的是哪一段 |
|---|---|---|---|---|---|
| 02:05–02:08 | `aa8388a1` | 7 | 6 | **1** | 「我发现上面的操作不像后台跑的。」（用户当场发现：「我注意到你丢了一句话。」） |
| 11:20–11:22 | `2c1c9412` | 4 | 4 | 0 | —（第二次测试） |
| 11:51–11:52 | `7aee9bd9` | 3 | 1（2 段合并） | **1** | 「现在的行为其实已经不错了。」 |
| 13:40–13:42 | `764f0c7a` | 5 | 2 | **3** | 「让我们讨论 Live Voice 的进一步改进及语音输出。」「它应当具有更好的实时性……」「另一方面呢……不需要特别大的模型……」 |
| 15:27–15:28 | `a5b80226` | 4 | 2 | **2** | 「让我们再讨论一下关于语音输出问题。」「嗯，你检索一下最近差不多六个小时……」；另有一句被改写后投递（见 C） |
| 15:35–15:36 | `e2b96f7b` | 9 | 2（合并） | **0** | 本轮 `VOICE_REALTIME_SPAN_GUARD=on`；1 处预期内重复，1 个模型自造片段（见 D/E） |

13:40 那轮的 3/5 与代码注释里的记录一致：
`voice-realtime-ws-proxy.service.ts`（span guard 段）写着「the 2026-10-17 continuous run `764f0c7a` dropped 3 of 5 sentences under the shipped rule」。

## 二、丢是怎么发生的

**A. committed 之后紧跟 speech_started，端点不给这一段开 response。**
`speech_stopped` 后几毫秒内又 `speech_started`，这一段虽然被提交、被转写，却没有
`response.created`；下一段的 response 只覆盖最新 span。`MODEL_TEXT_REPLY` 分支本来会把
unanswered 句子逐字投递，但只在模型「以文字结束、没有调用」时才跑；模型一旦调用
`session_send`，这条兜底就不走。今天的 4 段丢失属于这一类。

**B. `truncated-by-turn` 之后并没有真的 re-send。**
模型正在写 `session_send` 参数时用户继续说话，response 被 `turn_detected` 取消。journal 文案说
「it re-sends it」，但两处（05:40:26、07:27:57）都没有 re-send——下一段的 call 直接取代了它，
被截断的那段从此没有 disposition。

**C. 语义改写不会被判成丢失。**
07:28:11 听到「有一次讨论中，我们**丢**了不少语音输入」，模型投递成「我们**修**了不少的语音输入」。
当时 span guard 是 off，改写与遗漏无法区分，意义反转就这样过去了。

**D. span guard on 的实际效果（15:35 这轮）。**
- 「嗯，还要写，做做优化，就是我们现在定性为一个完整的。」被逐字前置；模型消息里同时也有
  「……所以我们现在并没有一个完整的……」，于是「一个完整的」出现两次 —— 这正是「宁愿重复」。
- ASR 把「现在是第五次测试」听成「刘晓红是第五次诉讼」，这句误听也被逐字前置。guard 分不清
  「模型修好了 ASR 的误听」和「模型漏了这句」，所以按设计投递了低保真版本。这与代码注释里
  记录的 `3d2d3b2c` 重复风险是同一件事。

**E. 短句盲区 + 模型自造片段。**
`voice-realtime-fragment-coverage.ts` 的 `MIN_JUDGED_CHARACTERS = 5`：少于 5 个字的句子不判。
「所以说。」（3 字）没有被 guard 补，模型为它投递了「非常……」—— 一个在转写里根本没有对应文本的
片段（模型直接听音频生成）。「最近。」（2 字）则并进了下一句。代码明确接受这个代价（「好的。」这类
真丢句不会在这里被恢复），但今天的「非常……」说明盲区里除了「丢短句」还会出现「投递一个没有转写
依据的短片段」。

## 三、结论

1. **丢输入在今天仍然是真实发生的**，不是错觉：六轮里四轮有丢，最严重的一轮 5 丢 3。
2. **两条主因都在「提交后没有 response」/「response 被 turn_detected 截断」**，而不是模型听到了不投递。
3. **`VOICE_REALTIME_SPAN_GUARD=on` 是目前唯一把 A/B 两类损失捞回来的机制**：15:35 这轮 0 丢失，
   代价是一处重复和一处 ASR 误听被原样投递。以「宁愿重复一些输入」为准则，这个开关应当保持 on。
4. 剩余未覆盖的只有两类：**短句（<5 字）**和**模型投递了没有转写依据的片段**（「非常……」）。
   前者是明确的已知代价；后者建议至少加一条 `session_send ungrounded` 读数（消息与 span 内任何
   听到句子零字对重合时记一行），让它在 journal 里可见。

## 四、可选的下一步（未实施）

- 保持 `VOICE_REALTIME_SPAN_GUARD=on` 跑完整测试；把每轮的「heard / delivered / duplicated / ungrounded」
  四个计数作为固定的收尾读数。
- 对 `truncated-by-turn` 之后 span 仍包含被截断项的情况，在 guard 之外再记一条
  `truncated-item-recovered` / `truncated-item-lost`，把「它说会 re-send」变成可核对的账。
- 「非常……」这类零重合片段：先只记录、不改投递，避免把正常改写误伤。
