# 实验 F「feed-through 恢复」结果（2026-10-17）

**问题**：forced commit 之后、`committed` 无 `speech_stopped` 时，持续补真实尾音能否勾出端点的 `speech_stopped` + response？

**结论：否。补音频（0–6000 ms 真实静音）不触发 `speech_stopped`，也不产生 response。**

## 读数（8 run，B/C × 4 臂，全部一致）

| 段 | feed | speech_stopped | response | committed | 转写 |
|---|---|---|---|---|---|
| B | 0 / 2000 / 4000 / 6000 ms | 全否 | 全否 | 是 | 正确 |
| C | 0 / 2000 / 4000 / 6000 ms | 全否 | 全否 | 是 | 正确 |

- 花费 ≈ ¥0（无 response，成本估算只计 response.done；实际音频成本为分数量级），墙钟 ~52 s。
- feed=0 臂稳定复现了 prod 的 bug 签名：`committed` 有、`speech_stopped` 无、无 response。

## 机制解释

端点的 `server_vad` 只在**同一段未提交缓冲**里检测「语音 → 静音」转折才 fire：

1. commit 会冻结缓冲。缓冲若以静音结尾，server_vad 可能仍晚一拍 fire（对照：commit 前带 2000 ms 干净尾音时，B 在 commit 前 0.5 s、C 在 commit 后 2 s 各自自然闭段）。
2. commit 后补的音频进入**新缓冲**；纯静音的新缓冲没有「语音 → 静音」转折，server_vad 永不 fire。

所以「commit 之后补音频」这条路在机制上就不可行——不是量不够，是时序错了。

## 设计含义（改道）

- ❌ **feed-through（commit 后补音频）**：证伪。放弃。
- ✅ **补音频必须在 commit 之前**（= 延长 hold-open）——但这正是 gate 已在做的（head-keep 1000 + hold-open 2000 ms），prod 里失败是因为那段「静音」其实是端点听成语音的噪声，延长同类帧无益。
- ✅ 可行的恢复只剩两条，都回到 proxy 侧：
  1. **`response.create`（状态驱动）**：判据「`committed` 到来时无 `speech_stopped`」精确区分「端点不会自答」，此时补发 `response.create` 强制生成 response；有 `speech_stopped` 的 4/6 正常情形不发，避开 71e53da5 的双重响应。
  2. **逐字兜底（时间驱动）**：已转写但超时无 response 的 item，走 `MODEL_TEXT_REPLY` 的 unanswered 逐字投递（10s 为评价指标，非原则）。

## response.create 臂（动作验证，2026-10-17）

协议：带 session_send 工具 → 语音 → commit（贴语音末尾）→ 等 committed → 确认无 speech_stopped → 发 response.create → 测 response / session_send / 重复。

| 段 | committed 无 stop（判据状态） | response.created | session_send 携带句子 | response.done | errors |
|---|---|---|---|---|---|
| B | ✅ | 1（无重复） | ✅ 整句 | completed | 0 |
| C | ✅ | 1（无重复） | ✅ 整句 | completed | 0 |

**结论：`response.create` 在「committed 无 speech_stopped」状态下，恰好产出一个干净 response，模型照常 `session_send` 整句，无双响应、无 concurrency conflict、无 Unknown call id。方案动作已验证。**

至此方案三条腿全部有实验背书：
1. 判据状态真实可复现（feed=0 臂 100% 复现）；
2. 替代方案（feed 音频）证伪；
3. 动作（response.create）干净有效。

花费合计 ≈ ¥0.003。

## 附带发现（方法学）

- **capture `.wav` 与 timeline/journal 偏移有漂移**：端点的 `speech_started` VAD 迟滞 1–8 s，且采集缓冲随时间漂移，timeline 的 `offsetMs` 不能用来定位 wav 内容。本次用 **sensevoice token 时间戳**重新定位各段（B 实际在 ~225.6 s、C 在 ~303 s，而非 timeline 的 230.7 s / 306.9 s）。后续任何 replay 探针都应先 sensevoice 定位，不要信 timeline 偏移。
