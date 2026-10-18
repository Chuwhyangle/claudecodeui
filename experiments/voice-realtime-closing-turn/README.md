# 收尾「OK」轮与 `session_send` schema 瘦身：生产形状回放（2026-10-15）

**总花费 ¥0.488**（限额 ¥0.5）。未改任何实现。

```
PROBE_BUDGET_CNY=0.25 npx tsx --tsconfig server/tsconfig.json \
  experiments/voice-realtime-closing-turn/run.mts --windows W1,W2 --arms K,N0,N1,N2,S,NS --reps 1
node experiments/voice-realtime-closing-turn/show.mjs [traces/run-*.json]
```

## 问题

四条已对账连接（¥0.3217）里，46% 的钱花在工具结果之后那条只回 "OK" 的收尾响应上。单独关掉它试过两次，都回退了：一次是线上（`server/index.ts` 的 `respondToToolOutputs` 注释：5 句里 3 句没转发），一次是回放（`experiments/voice-realtime-relay-mode-replay` 的 AN 臂：6 次文本回复、丢 4 个单元）。**两次中工具结果都还写着 "Reply with the single word OK"**，prompt 在打断之后也要求回 "OK"。所以"把要求和收尾轮一起改"从没试过。

## 形状

- 真实 capture 实时回放，16 kHz / 20 ms，过生产的 silero 上行门控。
- 上游 `server_vad` 0.5/400 自己决定轮次。
- 原 journal 的 `status injected` 时间线重放进 instructions。
- 每个窗口都含一次真人当时说的打断。

| 窗口 | 来源 | 内容 |
|---|---|---|
| W1 | 86559798 0–75 s | 4 句 + "停下它" |
| W2 | a175e6cd 20–82 s | 打断后紧跟一句；"停下来以后就没有再去调…" **不是**打断 |
| W3 | 73f2622b 78–135 s | 打断那句在 wav 里没对上，两臂都没听到 |
| W4 | 71e53da5 80–120 s | "OK，现在可以终止它了" |
| L2 | a175e6cd 0–200 s | 约 12 个单元，含 W2 全部 |

## 臂（每臂只动一个变量）

| 臂 | 内容 |
|---|---|
| K | 生产现状：出货 prompt、出货工具、有收尾响应、结果写 "Reply … OK" |
| N0 | K 去掉收尾响应（曾回退的形态） |
| N1 | N0 再去掉两处 "回 OK" 的要求：工具结果改成 "Nothing more is needed from you: say nothing and wait for the user to speak again."，prompt 里打断后的 "Then reply with the single word OK and say nothing else." 改成 "Then say nothing more." |
| N2 | N0 加上中继在每个工具结果后自己追加 `{role: assistant, text: "OK"}` 条目（不付响应费） |
| S | K 加上瘦身的 `session_send`：`{message}` + 一行描述，去掉网关通用描述和 `waitSeconds`/`correlationId`/`session` |
| NS | N1 + S |

## 结果（逐条读交付文本）

| 臂 | 跑批 | 真实单元丢失 | 打断 | 非打断误判 | 打断后紧跟的那句 | 单跑花费对比 K |
|---|---|---|---|---|---|---|
| K | W1 W2 W3 W4 | 0 | 3/3 | 0 | 2/2 送达 | — |
| S | W1 W2 W3 W4 | 1（W3，截断调用后没并回） | 3/3 | 0 | 2/2 送达 | −10% ~ −12% |
| N0 | W1 W2 L2 | **1（L2 打断后那句变成文本 "OK"）** | 3/3 | 0 | **1/2** | ≈ −50% |
| **N1** | W1 W2 L2 | **0** | 3/3 | 0（L2 的反例正确走 send） | **2/2 送达** | **−37% ~ −50%** |
| N2 | W1 W2 W4 | **1（W2 打断后那句变成文本 "OK"）** | 3/3 | 0 | 1/2 | ≈ −50% |
| NS | W2 | 0 | 1/1 | 0 | 1/1 送达 | −52% |

- **N0 的失败形态正是假设的机制。** 没有收尾轮时，打断后 prompt 要求的那句 "OK" 被挪到了下一句话的响应里，那一句于是没被转发。N1 去掉这个要求后，同一位置 2/2 送达。
- 噪声片段 "Six."（生产当时也没转发）：K 和 S 发出了无意义的 "这个是。"/"这个。"；N1 回了一句不交付的文本 "No response requested."。对 Claude Code 而言，N1 这样更好。
- 各臂共有、与本实验无关的：调用被 `turn_detected` 截断；打断的工具结果偶尔报 "Unknown function call id"；"Okay." 被改写成 "停。"（K 和 NS 各一次）。

## 结论

- **N1（去掉收尾轮，同时去掉"回 OK"的要求）是目前最好的候选**：每次回放约省一半，且在这批数据里没有丢句、没有误打断。
- N0（只关收尾轮）和 N2（中继追加 OK 条目）都在"打断后紧跟的那句"上丢过句，**不要用**。
- S 行为与 K 相当，约省 10%。W3 那 1 次丢句发生在两臂共有的截断缺陷上，K 碰巧靠合并恢复了。不足以判定是 S 造成的。

## 局限

- N1 只有 3 次回放（W1、W2、L2），长窗只有 L2 一个。L1 两个长窗因预算闸关 socket、旧代码抛错，记录丢失（约 ¥0.075 白花，已修：中断时保留部分记录）。
- 早先 AN 的回退是在整场 5–6 分钟会话里出现的，所以至少要再在 2–3 场完整会话上复验 N1。
- 回放 harness 用的是出货 transport + bridge，**不经过 ws-proxy**（重复守卫、合并窗、忙时 hold、follow-up 计数）。实现时要核对这些逻辑在没有收尾响应时的行为。proxy 里还有 6 处结果文本写着 "Reply with the single word OK"，都要一起改。
- 单一来源说话人。

## 花费

| 批次 | 花费 | trace |
|---|---|---|
| smoke W4/N2 | ¥0.010650 | `run-2026-10-15T02-54-24-214Z.json` |
| tier 1 W1,W2 × K,N0,N1,N2,S | ¥0.219457 | `run-2026-10-15T02-55-58-749Z.json`（W2/N1 记录因 usage=null 丢失） |
| W3,W4 × K,S | ¥0.066990 | `run-2026-10-15T02-57-46-984Z.json` |
| L1,L2 × N0,N1 | ¥0.152979 | `run-2026-10-15T03-00-56-131Z.json`（L1 两跑丢失） |
| W2 × N1,NS | ¥0.037893 | `run-2026-10-15T03-03-05-169Z.json` |
| **合计** | **¥0.487969** | |
