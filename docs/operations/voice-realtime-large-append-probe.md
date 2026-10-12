# Live Voice 大帧 vs 分块 append 真实探针（AC-369 / RC-5）

本文件是 GOAL-043 / AC-369 的探针记录：在**真实** `qwen3.8-omni-flash-realtime` 上，用**实验脚本内**的手动提交（`turn_detection: null` + `input_audio_buffer.commit` + `response.create`，**不改产品代码**）
把同一段音频按单帧时长梯度 2/5/8/12/15/20 s 各 append，并与等长 **200 ms 分块**对照，读断线是否与单帧时长/字节数相关。
**这不是模型推演，是一次运行的读数。** 结论只允许「证实 / 否证 / 不足以判断」三选一。

运行时刻 2026-10-12T17:20:35.879Z；探针**直连上游**（raw WS，手动 commit），未起第二实例；:3001 只被读 pid，从未被重启。
执行面是**合成会话**：会话声明的 `session_send` 工具由脚本内的记录式执行器承接（dry-run），绝不落到任何真实会话。
本次运行目录 `/tmp/large-append-run`（journal 在 `journal/`）。

## 读数行（判据逐行检查）

单帧梯度：2s(帧=1, 64000字节/base64 85336, 断线 0/2)；5s(帧=1, 160000字节/base64 213336, 断线 0/2)；8s(帧=1, 256000字节/base64 341336, 断线 0/2)；12s(帧=1, 384000字节/base64 512000, 断线 0/2)；15s(帧=1, 480000字节/base64 640000, 断线 0/2)；20s(帧=1, 640000字节/base64 853336, 断线 0/2)。
分块对照：2s(帧=10×~200ms, 断线 0/2)；5s(帧=25×~200ms, 断线 0/2)；8s(帧=40×~200ms, 断线 0/2)；12s(帧=60×~200ms, 断线 0/2)；15s(帧=75×~200ms, 断线 0/2)；20s(帧=100×~200ms, 断线 0/2)。
断线读数：两臂全部 24 次尝试**均未断线**（单帧 12 次、分块 12 次）。
结论：否证。到 20 s 为止，单帧与分块两条臂都**没有**任何断线（单帧 12 次、分块 12 次），因此「单帧 append 时长/字节数导致断线」的 RC-5 在这组读数下不成立。
运行次数：1
花费：¥0.0500（上限 ¥0.05/连接；总上限 ¥1；触顶连接 0 条）
:3001 pid：运行前 297649 → 运行后 297649（**相同**，未重启）
执行面：dry-run（合成会话；会话声明工具由脚本内记录式执行器承接，调用只被记录、不执行，不落任何真实会话）；`--plan` 只打印计划、不连上游；本次为唯一一次真实运行。

## 单元格总览（断线数 / 尝试数）

| 时长 | 单帧 | 200 ms 分块 |
| --- | --- | --- |
| 2 s | 0/2 | 0/2 |
| 5 s | 0/2 | 0/2 |
| 8 s | 0/2 | 0/2 |
| 12 s | 0/2 | 0/2 |
| 15 s | 0/2 | 0/2 |
| 20 s | 0/2 | 0/2 |

## 每次尝试的读数与事件时间线摘录

### single@2s#1 — conn=03d07a2b-73ce-45c6-98a1-2af32cddd560

- conn=03d07a2b-73ce-45c6-98a1-2af32cddd560 mode=single 2s#1；字节=64000 base64=85336 帧数=1 最大帧base64=85336；committed=是(+394ms)；answered=true responses=2 转写=「看一下。」；断线=否；错误=无；花费=¥0.0014
- 时间线摘录：
  ```
  +   518ms (audio+0ms) ← session.created
  +   759ms (audio+2000ms) ← session.updated
  +   961ms (audio+2000ms) ← input_audio_buffer.committed
  +  1305ms (audio+2000ms) ← response.created
  +  1364ms (audio+2000ms) ← conversation.item.input_audio_transcription.completed
  +  1533ms (audio+2000ms) ← response.done
  +  1930ms (audio+2000ms) ← response.created
  +  1975ms (audio+2000ms) ← response.done
  ```

### chunked@2s#1 — conn=f748e543-fe07-4152-907c-2dade5d6080b

- conn=f748e543-fe07-4152-907c-2dade5d6080b mode=chunked 2s#1；字节=64000 base64=85336 帧数=10 最大帧base64=8536；committed=是(+368ms)；answered=true responses=2 转写=「看一下。」；断线=否；错误=无；花费=¥0.0013
- 时间线摘录：
  ```
  +   255ms (audio+0ms) ← session.created
  +   403ms (audio+200ms) ← session.updated
  +  2473ms (audio+2000ms) ← input_audio_buffer.committed
  +  2642ms (audio+2000ms) ← conversation.item.input_audio_transcription.completed
  +  2805ms (audio+2000ms) ← response.created
  +  2897ms (audio+2000ms) ← response.done
  +  3176ms (audio+2000ms) ← response.created
  +  3222ms (audio+2000ms) ← response.done
  ```

### single@2s#2 — conn=b23c2e87-7e60-4561-8282-592ba3767c57

- conn=b23c2e87-7e60-4561-8282-592ba3767c57 mode=single 2s#2；字节=64000 base64=85336 帧数=1 最大帧base64=85336；committed=是(+405ms)；answered=true responses=2 转写=「看一下。」；断线=否；错误=无；花费=¥0.0014
- 时间线摘录：
  ```
  +   504ms (audio+0ms) ← session.created
  +   746ms (audio+2000ms) ← session.updated
  +   959ms (audio+2000ms) ← input_audio_buffer.committed
  +  1301ms (audio+2000ms) ← conversation.item.input_audio_transcription.completed
  +  1312ms (audio+2000ms) ← response.created
  +  1515ms (audio+2000ms) ← response.done
  +  1935ms (audio+2000ms) ← response.created
  +  1979ms (audio+2000ms) ← response.done
  ```

### chunked@2s#2 — conn=fe4c57ef-5db7-465f-8bd9-f75c07d53d07

- conn=fe4c57ef-5db7-465f-8bd9-f75c07d53d07 mode=chunked 2s#2；字节=64000 base64=85336 帧数=10 最大帧base64=8536；committed=是(+393ms)；answered=true responses=2 转写=「看一下。」；断线=否；错误=无；花费=¥0.0014
- 时间线摘录：
  ```
  +   484ms (audio+0ms) ← session.created
  +   753ms (audio+400ms) ← session.updated
  +  2728ms (audio+2000ms) ← input_audio_buffer.committed
  +  2862ms (audio+2000ms) ← conversation.item.input_audio_transcription.completed
  +  3126ms (audio+2000ms) ← response.created
  +  3304ms (audio+2000ms) ← response.done
  +  3697ms (audio+2000ms) ← response.created
  +  3787ms (audio+2000ms) ← response.done
  ```

### single@5s#1 — conn=379b93b2-dd5a-4c75-9c77-ad93ac2e818e

- conn=379b93b2-dd5a-4c75-9c77-ad93ac2e818e mode=single 5s#1；字节=160000 base64=213336 帧数=1 最大帧base64=213336；committed=是(+302ms)；answered=true responses=2 转写=「看一下。」；断线=否；错误=无；花费=¥0.0017
- 时间线摘录：
  ```
  +   195ms (audio+0ms) ← session.created
  +   336ms (audio+5000ms) ← session.updated
  +   547ms (audio+5000ms) ← input_audio_buffer.committed
  +   852ms (audio+5000ms) ← conversation.item.input_audio_transcription.completed
  +   888ms (audio+5000ms) ← response.created
  +  1066ms (audio+5000ms) ← response.done
  +  1383ms (audio+5000ms) ← response.created
  +  1427ms (audio+5000ms) ← response.done
  ```

### chunked@5s#1 — conn=e05d4a4c-a7aa-4c00-872a-22e7c7555704

- conn=e05d4a4c-a7aa-4c00-872a-22e7c7555704 mode=chunked 5s#1；字节=160000 base64=213336 帧数=25 最大帧base64=8536；committed=是(+386ms)；answered=true responses=2 转写=「看一下。」；断线=否；错误=无；花费=¥0.0017
- 时间线摘录：
  ```
  +   486ms (audio+0ms) ← session.created
  +   737ms (audio+400ms) ← session.updated
  +  5723ms (audio+5000ms) ← input_audio_buffer.committed
  +  5895ms (audio+5000ms) ← conversation.item.input_audio_transcription.completed
  +  6098ms (audio+5000ms) ← response.created
  +  6279ms (audio+5000ms) ← response.done
  +  6670ms (audio+5000ms) ← response.created
  +  6738ms (audio+5000ms) ← response.done
  ```

### single@5s#2 — conn=e8e4474e-2ae0-492b-85a6-6b23a7518786

- conn=e8e4474e-2ae0-492b-85a6-6b23a7518786 mode=single 5s#2；字节=160000 base64=213336 帧数=1 最大帧base64=213336；committed=是(+407ms)；answered=true responses=2 转写=「看一下。」；断线=否；错误=无；花费=¥0.0017
- 时间线摘录：
  ```
  +   521ms (audio+0ms) ← session.created
  +   766ms (audio+5000ms) ← session.updated
  +   978ms (audio+5000ms) ← input_audio_buffer.committed
  +  1313ms (audio+5000ms) ← response.created
  +  1353ms (audio+5000ms) ← conversation.item.input_audio_transcription.completed
  +  1605ms (audio+5000ms) ← response.done
  +  1991ms (audio+5000ms) ← response.created
  +  2036ms (audio+5000ms) ← response.done
  ```

### chunked@5s#2 — conn=de4a298b-5d1a-4e36-9555-6ac9c2601a4c

- conn=de4a298b-5d1a-4e36-9555-6ac9c2601a4c mode=chunked 5s#2；字节=160000 base64=213336 帧数=25 最大帧base64=8536；committed=是(+298ms)；answered=true responses=2 转写=「看一下。」；断线=否；错误=无；花费=¥0.0017
- 时间线摘录：
  ```
  +   204ms (audio+0ms) ← session.created
  +   345ms (audio+200ms) ← session.updated
  +  5353ms (audio+5000ms) ← input_audio_buffer.committed
  +  5517ms (audio+5000ms) ← conversation.item.input_audio_transcription.completed
  +  5754ms (audio+5000ms) ← response.created
  +  5847ms (audio+5000ms) ← response.done
  +  6144ms (audio+5000ms) ← response.created
  +  6167ms (audio+5000ms) ← response.done
  ```

### single@8s#1 — conn=5cd72d79-187d-4511-a388-ebec92254d2b

- conn=5cd72d79-187d-4511-a388-ebec92254d2b mode=single 8s#1；字节=256000 base64=341336 帧数=1 最大帧base64=341336；committed=是(+295ms)；answered=true responses=2 转写=「看一下。Useless.」；断线=否；错误=无；花费=¥0.0019
- 时间线摘录：
  ```
  +   246ms (audio+0ms) ← session.created
  +   422ms (audio+8000ms) ← session.updated
  +   593ms (audio+8000ms) ← input_audio_buffer.committed
  +   978ms (audio+8000ms) ← response.created
  +  1013ms (audio+8000ms) ← conversation.item.input_audio_transcription.completed
  +  1159ms (audio+8000ms) ← response.done
  +  1461ms (audio+8000ms) ← response.created
  +  1530ms (audio+8000ms) ← response.done
  ```

### chunked@8s#1 — conn=c3c264ec-a303-4fa1-a4b2-fc903d71f5df

- conn=c3c264ec-a303-4fa1-a4b2-fc903d71f5df mode=chunked 8s#1；字节=256000 base64=341336 帧数=40 最大帧base64=8536；committed=是(+407ms)；answered=true responses=2 转写=「看一下。Useless.」；断线=否；错误=无；花费=¥0.0019
- 时间线摘录：
  ```
  +   489ms (audio+0ms) ← session.created
  +   745ms (audio+400ms) ← session.updated
  +  8745ms (audio+8000ms) ← input_audio_buffer.committed
  +  8913ms (audio+8000ms) ← conversation.item.input_audio_transcription.completed
  +  9102ms (audio+8000ms) ← response.created
  +  9308ms (audio+8000ms) ← response.done
  +  9711ms (audio+8000ms) ← response.created
  +  9844ms (audio+8000ms) ← response.done
  ```

### single@8s#2 — conn=b0cc1175-2844-40c7-9542-d4e7e4b0bec3

- conn=b0cc1175-2844-40c7-9542-d4e7e4b0bec3 mode=single 8s#2；字节=256000 base64=341336 帧数=1 最大帧base64=341336；committed=是(+612ms)；answered=true responses=2 转写=「看一下。Useless.」；断线=否；错误=无；花费=¥0.0019
- 时间线摘录：
  ```
  +   529ms (audio+0ms) ← session.created
  +   773ms (audio+8000ms) ← session.updated
  +  1191ms (audio+8000ms) ← input_audio_buffer.committed
  +  1464ms (audio+8000ms) ← response.created
  +  1644ms (audio+8000ms) ← response.done
  +  1652ms (audio+8000ms) ← conversation.item.input_audio_transcription.completed
  +  2041ms (audio+8000ms) ← response.created
  +  2086ms (audio+8000ms) ← response.done
  ```

### chunked@8s#2 — conn=dbc9a1f2-3872-4d6f-98af-34a1f8bbbd61

- conn=dbc9a1f2-3872-4d6f-98af-34a1f8bbbd61 mode=chunked 8s#2；字节=256000 base64=341336 帧数=40 最大帧base64=8536；committed=是(+521ms)；answered=true responses=2 转写=「看一下。Useless.」；断线=否；错误=无；花费=¥0.0019
- 时间线摘录：
  ```
  +   511ms (audio+0ms) ← session.created
  +   763ms (audio+400ms) ← session.updated
  +  8883ms (audio+8000ms) ← input_audio_buffer.committed
  +  9057ms (audio+8000ms) ← conversation.item.input_audio_transcription.completed
  +  9162ms (audio+8000ms) ← response.created
  +  9413ms (audio+8000ms) ← response.done
  +  9832ms (audio+8000ms) ← response.created
  +  9882ms (audio+8000ms) ← response.done
  ```

### single@12s#1 — conn=ab96d8fa-998f-47a7-91b2-c8c4de48e327

- conn=ab96d8fa-998f-47a7-91b2-c8c4de48e327 mode=single 12s#1；字节=384000 base64=512000 帧数=1 最大帧base64=512000；committed=是(+291ms)；answered=true responses=2 转写=「看一下。useless。input这个。」；断线=否；错误=无；花费=¥0.0022
- 时间线摘录：
  ```
  +   177ms (audio+0ms) ← session.created
  +   296ms (audio+12000ms) ← session.updated
  +   519ms (audio+12000ms) ← input_audio_buffer.committed
  +   922ms (audio+12000ms) ← response.created
  +  1107ms (audio+12000ms) ← response.done
  +  1132ms (audio+12000ms) ← conversation.item.input_audio_transcription.completed
  +  1389ms (audio+12000ms) ← response.created
  +  1433ms (audio+12000ms) ← response.done
  ```

### chunked@12s#1 — conn=543b3acc-628d-42a7-be3b-5bcdbdc61ea4

- conn=543b3acc-628d-42a7-be3b-5bcdbdc61ea4 mode=chunked 12s#1；字节=384000 base64=512000 帧数=60 最大帧base64=8536；committed=是(+286ms)；answered=true responses=2 转写=「看一下。Useless。Input这个。」；断线=否；错误=无；花费=¥0.0022
- 时间线摘录：
  ```
  +   201ms (audio+0ms) ← session.created
  +   340ms (audio+200ms) ← session.updated
  + 12338ms (audio+12000ms) ← input_audio_buffer.committed
  + 12472ms (audio+12000ms) ← conversation.item.input_audio_transcription.completed
  + 12732ms (audio+12000ms) ← response.created
  + 12913ms (audio+12000ms) ← response.done
  + 13190ms (audio+12000ms) ← response.created
  + 13313ms (audio+12000ms) ← response.done
  ```

### single@12s#2 — conn=8c5621a4-cd66-407e-9594-dad5a6dd337c

- conn=8c5621a4-cd66-407e-9594-dad5a6dd337c mode=single 12s#2；字节=384000 base64=512000 帧数=1 最大帧base64=512000；committed=是(+436ms)；answered=true responses=2 转写=「看一下。useless。input这个。」；断线=否；错误=无；花费=¥0.0022
- 时间线摘录：
  ```
  +   186ms (audio+0ms) ← session.created
  +   349ms (audio+12000ms) ← session.updated
  +   674ms (audio+12000ms) ← input_audio_buffer.committed
  +  1053ms (audio+12000ms) ← response.created
  +  1140ms (audio+12000ms) ← conversation.item.input_audio_transcription.completed
  +  1167ms (audio+12000ms) ← response.done
  +  1478ms (audio+12000ms) ← response.created
  +  1567ms (audio+12000ms) ← response.done
  ```

### chunked@12s#2 — conn=78ad0a4f-069a-4b91-8477-8d24621e207f

- conn=78ad0a4f-069a-4b91-8477-8d24621e207f mode=chunked 12s#2；字节=384000 base64=512000 帧数=60 最大帧base64=8536；committed=是(+399ms)；answered=true responses=2 转写=「看一下。useless。input这个。」；断线=否；错误=无；花费=¥0.0022
- 时间线摘录：
  ```
  +   506ms (audio+0ms) ← session.created
  +   757ms (audio+400ms) ← session.updated
  + 12754ms (audio+12000ms) ← input_audio_buffer.committed
  + 12879ms (audio+12000ms) ← conversation.item.input_audio_transcription.completed
  + 13145ms (audio+12000ms) ← response.created
  + 13325ms (audio+12000ms) ← response.done
  + 13722ms (audio+12000ms) ← response.created
  + 13791ms (audio+12000ms) ← response.done
  ```

### single@15s#1 — conn=beb80a8b-7af0-4f62-884a-8689c80279d3

- conn=beb80a8b-7af0-4f62-884a-8689c80279d3 mode=single 15s#1；字节=480000 base64=640000 帧数=1 最大帧base64=640000；committed=是(+924ms)；answered=true responses=1 转写=「看一下。useless。input这个。」；断线=否；错误=无；花费=¥0.0012
- 时间线摘录：
  ```
  +   487ms (audio+0ms) ← session.created
  +   712ms (audio+15000ms) ← session.updated
  +  1463ms (audio+15000ms) ← input_audio_buffer.committed
  +  1757ms (audio+15000ms) ← response.created
  +  1869ms (audio+15000ms) ← response.done
  +  2002ms (audio+15000ms) ← conversation.item.input_audio_transcription.completed
  ```

### chunked@15s#1 — conn=1761f6c7-3761-4aea-ad52-10f12cbea6e7

- conn=1761f6c7-3761-4aea-ad52-10f12cbea6e7 mode=chunked 15s#1；字节=480000 base64=640000 帧数=75 最大帧base64=8536；committed=是(+293ms)；answered=true responses=2 转写=「Useless. Input this.」；断线=否；错误=无；花费=¥0.0026
- 时间线摘录：
  ```
  +   196ms (audio+0ms) ← session.created
  +   343ms (audio+200ms) ← session.updated
  +  1607ms (audio+1400ms) ← conversation.item.input_audio_transcription.failed
  + 15340ms (audio+15000ms) ← input_audio_buffer.committed
  + 15488ms (audio+15000ms) ← conversation.item.input_audio_transcription.completed
  + 15694ms (audio+15000ms) ← response.created
  + 15899ms (audio+15000ms) ← response.done
  + 16205ms (audio+15000ms) ← response.created
  + 16272ms (audio+15000ms) ← response.done
  ```

### single@15s#2 — conn=d3fe5151-f6c5-4b7c-bead-cb7e3d3b4f2e

- conn=d3fe5151-f6c5-4b7c-bead-cb7e3d3b4f2e mode=single 15s#2；字节=480000 base64=640000 帧数=1 最大帧base64=640000；committed=是(+385ms)；answered=true responses=2 转写=「看一下。useless。input这个。」；断线=否；错误=无；花费=¥0.0026
- 时间线摘录：
  ```
  +   181ms (audio+0ms) ← session.created
  +   331ms (audio+15000ms) ← session.updated
  +   617ms (audio+15000ms) ← input_audio_buffer.committed
  +   913ms (audio+15000ms) ← response.created
  +  1075ms (audio+15000ms) ← conversation.item.input_audio_transcription.completed
  +  1116ms (audio+15000ms) ← response.done
  +  1418ms (audio+15000ms) ← response.created
  +  1462ms (audio+15000ms) ← response.done
  ```

### chunked@15s#2 — conn=0274c2af-72a4-4863-a071-5549a0dc5b9c

- conn=0274c2af-72a4-4863-a071-5549a0dc5b9c mode=chunked 15s#2；字节=480000 base64=640000 帧数=75 最大帧base64=8536；committed=是(+290ms)；answered=true responses=2 转写=「看一下。useless。input这个。」；断线=否；错误=无；花费=¥0.0026
- 时间线摘录：
  ```
  +   190ms (audio+0ms) ← session.created
  +   326ms (audio+200ms) ← session.updated
  + 15330ms (audio+15000ms) ← input_audio_buffer.committed
  + 15462ms (audio+15000ms) ← conversation.item.input_audio_transcription.completed
  + 15760ms (audio+15000ms) ← response.created
  + 15940ms (audio+15000ms) ← response.done
  + 16230ms (audio+15000ms) ← response.created
  + 16318ms (audio+15000ms) ← response.done
  ```

### single@20s#1 — conn=c5c208d3-b095-435a-8aad-95a0a597390c

- conn=c5c208d3-b095-435a-8aad-95a0a597390c mode=single 20s#1；字节=640000 base64=853336 帧数=1 最大帧base64=853336；committed=是(+794ms)；answered=true responses=2 转写=「看一下。useverse。input这个。hook。」；断线=否；错误=无；花费=¥0.0029
- 时间线摘录：
  ```
  +   490ms (audio+0ms) ← session.created
  +   740ms (audio+20000ms) ← session.updated
  +  1337ms (audio+20000ms) ← input_audio_buffer.committed
  +  1629ms (audio+20000ms) ← response.created
  +  1803ms (audio+20000ms) ← conversation.item.input_audio_transcription.completed
  +  1846ms (audio+20000ms) ← response.done
  +  2226ms (audio+20000ms) ← response.created
  +  2270ms (audio+20000ms) ← response.done
  ```

### chunked@20s#1 — conn=11f41688-643b-4822-b3ac-d79b195ec888

- conn=11f41688-643b-4822-b3ac-d79b195ec888 mode=chunked 20s#1；字节=640000 base64=853336 帧数=100 最大帧base64=8536；committed=是(+540ms)；answered=true responses=2 转写=「看一下。useverse。input这个。hook。」；断线=否；错误=无；花费=¥0.0030
- 时间线摘录：
  ```
  +   529ms (audio+0ms) ← session.created
  +   800ms (audio+400ms) ← session.updated
  + 20919ms (audio+20000ms) ← input_audio_buffer.committed
  + 21026ms (audio+20000ms) ← conversation.item.input_audio_transcription.completed
  + 21163ms (audio+20000ms) ← response.created
  + 21390ms (audio+20000ms) ← response.done
  + 21817ms (audio+20000ms) ← response.created
  + 21908ms (audio+20000ms) ← response.done
  ```

### single@20s#2 — conn=7caad00c-c145-49ec-9896-72243e95799c

- conn=7caad00c-c145-49ec-9896-72243e95799c mode=single 20s#2；字节=640000 base64=853336 帧数=1 最大帧base64=853336；committed=是(+894ms)；answered=true responses=2 转写=「看一下。useverse。input这个。hook。」；断线=否；错误=无；花费=¥0.0030
- 时间线摘录：
  ```
  +   519ms (audio+0ms) ← session.created
  +   773ms (audio+20000ms) ← session.updated
  +  1465ms (audio+20000ms) ← input_audio_buffer.committed
  +  1770ms (audio+20000ms) ← response.created
  +  1983ms (audio+20000ms) ← conversation.item.input_audio_transcription.completed
  +  2070ms (audio+20000ms) ← response.done
  +  2514ms (audio+20000ms) ← response.created
  +  2630ms (audio+20000ms) ← response.done
  ```

### chunked@20s#2 — conn=35139a29-dc7f-45e5-a875-717562b2e68c

- conn=35139a29-dc7f-45e5-a875-717562b2e68c mode=chunked 20s#2；字节=640000 base64=853336 帧数=100 最大帧base64=8536；committed=是(+392ms)；answered=true responses=2 转写=「看一下。useless。input这个。hook。」；断线=否；错误=无；花费=¥0.0030
- 时间线摘录：
  ```
  +   490ms (audio+0ms) ← session.created
  +   723ms (audio+200ms) ← session.updated
  + 20732ms (audio+20000ms) ← input_audio_buffer.committed
  + 20851ms (audio+20000ms) ← conversation.item.input_audio_transcription.completed
  + 21111ms (audio+20000ms) ← response.created
  + 21360ms (audio+20000ms) ← response.done
  + 21770ms (audio+20000ms) ← response.created
  + 21815ms (audio+20000ms) ← response.done
  ```

## 方法与限制（如实记录）

- 音频源：`experiments/voice-trim/fixtures/zh-d03-o45.wav`（29.12 s，16 kHz 单声道 PCM16），取**前 N 秒**作各档音频。
  因此各档共享同一前缀，**时长/内容一同变化**——本探针问的正是「时长/字节数」，这是它的自变量，不是混淆。
- 手动提交：`session.update{session.turn_detection: null}` → `input_audio_buffer.append` → `input_audio_buffer.commit` → `response.create`。
- 单帧档：整段音频**一次** append（1 帧）；分块档：每 200 ms 一帧、**按实时墙钟**逐帧推进（近似浏览器流式上传）。
  分块档唯一与单帧不同处是「帧多大/发得多快」，总字节数完全相同。
- 等待策略：commit 后等断线 / `response.done`(+3000ms 收尾) / 45000ms 超时。
- 每次尝试 = 一条**全新连接**，断线无法归因到上一条的残留状态。
- 取数前管线预检：取数前用 --smoke 跑过一条 single@2s 连接（committed/answered/转写 均到、探针自身以 code 1000 收尾关闭）以证明管线；该连接不计入本报告读数。
- 花费按出货 `estimateRealtimeCostCny` 在每条 `response.done` 上累计；每连接封顶 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION`。

## 复现

```bash
set -a; . ./.env.test; set +a
npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-large-append-probe/probe.mts --plan
npx tsx --tsconfig server/tsconfig.json experiments/voice-realtime-large-append-probe/probe.mts --work /tmp/large-append-probe
```

