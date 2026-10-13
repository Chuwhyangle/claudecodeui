# Live Voice 连接历史 + 空闲间隔真实探针（AC-369 / RC-5 之后的诊断）

本文件是对 2026-10-13 第三次语音测试里 4 段真实断线（journal `0d2e6d93…`/`10f039d0…`，17.06/19.66/18.12/10.52 s，全部发生在已处理过至少一轮、且前面有 ~17–19 s 空闲的连接上）的诊断探针，在**真实** `qwen3.8-omni-flash-realtime` 上跑。
AC-369 已经在**全新连接**上否证「单帧 append 时长/字节数导致断线」（RC-5，2–20 s 单帧 24 次 0 断线）。本探针变的是 AC-369 没变过的那个量——连接的历史/空闲——对照 fresh（全新连接直发大单帧，= AC-369 方法论）与 history（先一轮+空闲再发同样大小单帧）。
**这不是模型推演，是一次运行的读数。** 结论只允许「证实 / 否证 / 不足以判断」三选一。

运行时刻 2026-10-13T01:26:32.680Z；探针**直连上游**（raw WS，手动 commit），未起第二实例；:3001 只被读 pid，从未被重启。
执行面是**合成会话**：会话声明的 `session_send` 工具由脚本内的记录式执行器承接（dry-run），绝不落到任何真实会话。
本次运行目录 `/tmp/idle-history-probe`（journal 在 `journal/`）。

## 读数行（判据逐行检查）

fresh 臂（全新连接，直发 18s 单帧）：断线 0/3。
history 臂（先 2s 一轮，空闲 18000ms，再发 18s 单帧）：断线 0/3。
结论：否证。两条臂共 6 次尝试均未断线（fresh 3 次、history 3 次），本轮读数不支持「连接历史+空闲导致断线」。
运行次数：1
花费：¥0.0140（上限 ¥0.05/连接；总上限 ¥1；触顶连接 0 条）
:3001 pid：运行前 828651 → 运行后 828651（**相同**，未重启）
执行面：dry-run（合成会话；会话声明工具由脚本内记录式执行器承接，调用只被记录、不执行，不落任何真实会话）；`--plan` 只打印计划、不连上游；本次为唯一一次真实运行。

## 每次尝试的读数与事件时间线摘录

### fresh#1 — conn=f8e93848-44ed-42f5-af2c-d171927545d1

- conn=f8e93848-44ed-42f5-af2c-d171927545d1 arm=fresh#1；第二段 committed=true answered=true 转写=「Useless. Input这个。Hook.」；断线=否；错误=无；花费=¥0.0028
- 时间线摘录：
  ```
  +   523ms (audio+0ms) ← session.created
  +  1005ms (audio+18000ms) ← session.updated
  +  3395ms (audio+18000ms) ← input_audio_buffer.committed
  +  3713ms (audio+18000ms) ← response.created
  +  4033ms (audio+18000ms) ← conversation.item.input_audio_transcription.completed
  +  4053ms (audio+18000ms) ← response.done
  +  4466ms (audio+18000ms) ← response.created
  +  4601ms (audio+18000ms) ← response.done
  ```

### fresh#2 — conn=5ba5ff7b-7877-41db-95b0-46cced01c5cf

- conn=5ba5ff7b-7877-41db-95b0-46cced01c5cf arm=fresh#2；第二段 committed=true answered=true 转写=「Useless. Input这个。Hook.」；断线=否；错误=无；花费=¥0.0013
- 时间线摘录：
  ```
  +   179ms (audio+0ms) ← session.created
  +   318ms (audio+18000ms) ← session.updated
  +   525ms (audio+18000ms) ← input_audio_buffer.committed
  +   920ms (audio+18000ms) ← response.created
  +   989ms (audio+18000ms) ← response.done
  +   995ms (audio+18000ms) ← conversation.item.input_audio_transcription.completed
  ```

### fresh#3 — conn=fe1e28a3-c67d-435a-a5a4-90f144f23eb1

- conn=fe1e28a3-c67d-435a-a5a4-90f144f23eb1 arm=fresh#3；第二段 committed=true answered=true 转写=「Useless. Input这个。Hook.」；断线=否；错误=无；花费=¥0.0013
- 时间线摘录：
  ```
  +   186ms (audio+0ms) ← session.created
  +   343ms (audio+18000ms) ← session.updated
  +   711ms (audio+18000ms) ← input_audio_buffer.committed
  +  1187ms (audio+18000ms) ← conversation.item.input_audio_transcription.completed
  +  1224ms (audio+18000ms) ← response.created
  +  1293ms (audio+18000ms) ← response.done
  ```

### history#1 — conn=649e1cb2-21e1-4ddd-a442-d1b0f951df55

- conn=649e1cb2-21e1-4ddd-a442-d1b0f951df55 arm=history#1；第一轮 committed=true answered=true；第二段 committed=true answered=true 转写=「Useless. Input这个。Hook.」；断线=否；错误=无；花费=¥0.0028
- 时间线摘录：
  ```
  +   540ms (audio+0ms) ← session.created
  +   791ms (audio+2000ms) ← session.updated
  +  1046ms (audio+2000ms) ← input_audio_buffer.committed
  +  1345ms (audio+2000ms) ← response.created
  +  1521ms (audio+2000ms) ← response.done
  +  1934ms (audio+2000ms) ← response.created
  +  2003ms (audio+2000ms) ← response.done
  +  2250ms (audio+2000ms) ← conversation.item.input_audio_transcription.failed
  + 20587ms (audio+20000ms) ← input_audio_buffer.committed
  + 20911ms (audio+20000ms) ← response.created
  + 20981ms (audio+20000ms) ← response.done
  + 21151ms (audio+20000ms) ← conversation.item.input_audio_transcription.completed
  ```

### history#2 — conn=833741bb-cd1d-4042-afc3-2dee31b55905

- conn=833741bb-cd1d-4042-afc3-2dee31b55905 arm=history#2；第一轮 committed=true answered=true；第二段 committed=true answered=true 转写=「Useless. Input这个。Hook.」；断线=否；错误=无；花费=¥0.0028
- 时间线摘录：
  ```
  +   190ms (audio+0ms) ← session.created
  +   323ms (audio+2000ms) ← session.updated
  +   526ms (audio+2000ms) ← input_audio_buffer.committed
  +   768ms (audio+2000ms) ← conversation.item.input_audio_transcription.completed
  +   866ms (audio+2000ms) ← response.created
  +  1049ms (audio+2000ms) ← response.done
  +  1331ms (audio+2000ms) ← response.created
  +  1419ms (audio+2000ms) ← response.done
  + 19702ms (audio+20000ms) ← input_audio_buffer.committed
  + 20041ms (audio+20000ms) ← conversation.item.input_audio_transcription.completed
  + 20070ms (audio+20000ms) ← response.created
  + 20116ms (audio+20000ms) ← response.done
  ```

### history#3 — conn=3201cdc3-13f3-4aa9-9a9e-a215df32d0c3

- conn=3201cdc3-13f3-4aa9-9a9e-a215df32d0c3 arm=history#3；第一轮 committed=true answered=true；第二段 committed=true answered=true 转写=「Useless. Input这个。Hook.」；断线=否；错误=无；花费=¥0.0029
- 时间线摘录：
  ```
  +   168ms (audio+0ms) ← session.created
  +   295ms (audio+2000ms) ← session.updated
  +   501ms (audio+2000ms) ← input_audio_buffer.committed
  +   738ms (audio+2000ms) ← conversation.item.input_audio_transcription.completed
  +   842ms (audio+2000ms) ← response.created
  +  1051ms (audio+2000ms) ← response.done
  +  1326ms (audio+2000ms) ← response.created
  +  1441ms (audio+2000ms) ← response.done
  + 19681ms (audio+20000ms) ← input_audio_buffer.committed
  + 20036ms (audio+20000ms) ← conversation.item.input_audio_transcription.completed
  + 20086ms (audio+20000ms) ← response.created
  + 20176ms (audio+20000ms) ← response.done
  ```

## 方法与限制（如实记录）

- 音频源：`experiments/voice-trim/fixtures/zh-d03-o45.wav`（29.12 s，16 kHz 单声道 PCM16）；第一轮取 [0, 2s)，第二段取 [2s, 20s)——两段互不重叠。
- 手动提交：`session.update{session.turn_detection: null}` → `input_audio_buffer.append` → `input_audio_buffer.commit` → `response.create`。
- history 臂的空闲窗口（18000ms）里不发任何帧，也不发任何控制帧——与真实「用户说完一句、隔了快 20 s 才再开口」逐帧一致。
- 每条尝试 = 一条全新连接（fresh 与 history 各自独立起新连接，不复用）。
- 花费按出货 `estimateRealtimeCostCny` 在每条 `response.done` 上累计；每连接封顶 `--cap`。

## 复现

```bash
set -a; . ./.env.test; set +a
npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-idle-history-probe/probe.mts --plan
npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-idle-history-probe/probe.mts --work /tmp/idle-history-probe
```

## 本轮之外：诊断现状（2026-10-13，未解决，人 yale 裁定先停在这里）

**两个已测变量都被否证，断线机制仍未定位：**

- 帧大小/时长（RC-5）：AC-369 否证（fresh 连接，2–20 s 单帧，24/24 无断线）。
- 连接历史 + 空闲（本探针）：否证（fresh/history 两臂共 6/6 无断线）。

**为什么不直接判定「不是本地实现的问题」：**

1. **样本太薄，测不出中等概率的间歇性故障。** 3 次重复若真实断线率在 40–50% 量级，0/3 全部走运的概率约
   12.5%，不是可忽略的小概率。真实 journal 里同一条连接的 5 个可提交段也只断了 2 个（seq2/3），不是
   100% 复现。
2. **「空闲」的时长算法有滑动。** 本探针固定 18000 ms；真实断线前的 wire-idle（上一次收发帧到下一次
   append）用时间戳倒推分别约 15.6–25 s，而真实**没**断线的 seq5→6 间隔（~15.4 s）比某些断线间隔还短——
   原始数据里没有一条干净的阈值。
3. **本轮没测到「上一段刚断线重连过」这种历史形状。** 真实 conn1 的 seq=3 断线，发生在 seq=2 刚断线、
   经 3 次重连耗尽、紧接着又提交一个大段之后——这与「干净的一轮对话 + 空闲」是不同的连接历史，本轮
   history 臂没有复现它。

**结论（人裁定，不继续花真钱测更多假设）：疑似间歇性上游故障，具体机制未定位。** 不归因为「本地实现的
bug」（已检查过 `voice-realtime-bridge.service.ts` 的 `handleTransportClose`：只在真实收到意外 `close`
事件时触发，没有本地 idle/ping 看门狗会主动断开），也不归因为「上游服务本身必然如此」（两个最直接的
假设都被否证）。后续若要继续查，候选方向（未执行，按花费从低到高排）：
加大本探针重复次数以检验间歇性假设、复现「断线重连后紧跟大段提交」的连接历史、或在真实 segmented 生产
路径上加细粒度日志（而非探针）等到下一次真实断线自然发生时捕捉完整上下文。

