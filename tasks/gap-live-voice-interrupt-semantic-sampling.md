---
id: gap-live-voice-interrupt-semantic-sampling
title: 语义中断抽样 F7：单次真实 Realtime 运行（dry-run 执行面、花费上限），报告召回率/精确率/花费，不设门槛（阶段 1e）
status: done
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
depends_on:
  - gap-live-voice-interrupt-after-revision-enqueued
  - gap-live-voice-interrupt-run-utterance-fence
goal_ac: AC-346
---
## Proposal

### 为什么

中断由 Realtime 模型语义判断（C-2、D-6），没有关键词可依，离线 scripted fake 只能证明「模型调用了中断时管线对不对」，证明不了「真模型会不会在该中断时中断」。需要一次**真实上游**抽样（SPEC §18.7 F7），只报读数，不设门槛。

### 做法

- 语料：语义取消/改向措辞 ≥10 条（必须含 2026-10-12 原句「你应当能够更主动地去取消已经在执行的这些动作，以更快地推进后面的操作」）、仅追加措辞 ≥10 条；用 TTS 或已有录音生成 16 kHz mono PCM16。
- **只跑一次付费运行**：备用端口起第二实例（不重启 :3001），设 `VOICE_REALTIME_MAX_CNY_PER_CONNECTION` 上限，执行面用 dry-run 执行器（`server/index.ts` 的 `dryRun` 分支：`session_send`/`session_interrupt` 只记录不执行），读 journal 的工具调用与 `intent`。
- 产出 `docs/operations/voice-realtime-interrupt-sampling.md`：`样本：`、`召回率：`、`精确率：`、`花费：` 行 + 逐条表（措辞、期望、实际调用、intent）。

### SCOPE BOUNDARY（GOAL-041 全体任务共用）

- ⛔ 不做 Steer / Fork / Rollback；不建独立 Active Intent Buffer（方案 B，SPEC §0.3 D-5）。
- ⛔ 模型工具面不暴露撤回 / 清空队列（D-2）；不改能力位 `cancelQueuedInput`。
- ⛔ 中断不调用 `stopTask`、不改后台任务 / cron 租约、不触碰任何 Quay worker / driver 进程或工作树（D-9）。
- ⛔ 不重启 :3001、不做生产发布；真实上游 / 真实二进制只在本任务 AC 明确要求处使用。
- 契约正本：`docs/proposals/voice-realtime-persistent-control-SPEC.md` §0.3、§18（Draft-3，提交 `0cbe53fc`）。


## Plan

1. 语料与音频；2. 实验脚本（备用端口、dry-run 执行器、花费上限）；3. 单次运行；4. 报告。

## AC

- [x] AC1：`f=docs/operations/voice-realtime-interrupt-sampling.md; grep -q "^召回率：" "$f" && grep -q "^精确率：" "$f" && grep -q "^花费：" "$f" && grep -q "^样本：" "$f"` 退出 0。
- [x] AC2：报告逐条表 ≥20 行，含原句，每行带 journal 证据（连接 id + 时间戳）。
- [x] AC3：报告写明运行次数 = 1、花费上限值与实际花费（CNY）、:3001 前后 pid 相同。
- [x] AC4：`npm run lint` 退出 0（若新增脚本）。

## DoD

真实 Realtime 上游跑过一次，执行面为 dry-run（未向任何真实会话注入消息或中断），读数完整；不设召回/精确门槛。

## Touches

- docs/operations/voice-realtime-interrupt-sampling.md (new)
- experiments/voice-realtime-interrupt-sampling/run.mts (new)
- experiments/voice-realtime-interrupt-sampling/corpus.json (new)
- tasks/gap-live-voice-interrupt-semantic-sampling.md

## Notes

立项：Opus 常驻架构会话，2026-10-12，人 yale 授权（GOAL-041 / AC-346）。依赖 AC-342、AC-343。真实花费只此一次（见记忆：勿反复真实上游测量）。

### 实施记录（2026-10-12，worker）

读数：样本 24 条；召回率 83.3%（TP=10 / FN=2）；精确率 100.0%（FP=0）；花费 ¥0.0964（每条连接独立封顶 ¥0.05，无一条触顶）；运行次数 1；:3001 pid 1933227 → 1933227 未变。两条漏判（`int-01` 原句、`int-09`）均判成 `session_send`；12 条仅追加语料 0 误判。

一处偏离、已在报告「方法与限制」如实记录：出货 relay journal（`voice-realtime-log.ts`）**只由浏览器 socket 的 recorder 写**，「读 journal 的工具调用与 `intent`」在 HTTP dry-run 面上不成立。本轮走的是任务点名的 dry-run 诊断路由，每条连接的记录由 `run.mts` 按「一条连接一个 JSONL」的形状（同一文件名形态、同一字段口径）落到运行目录，原始诊断报告另存；表里每行引用的连接 id 与时间戳都能对上。

`run.mts --report-only <运行目录>`：从 `<运行目录>/snapshot.json` 离线重出报告，不再调用上游——真实付费只此一次，报告侧返工不重跑。