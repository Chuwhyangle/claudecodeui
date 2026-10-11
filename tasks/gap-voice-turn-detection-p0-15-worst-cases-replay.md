---
id: gap-voice-turn-detection-p0-15-worst-cases-replay
title: Live Voice P0.15：P0.13 最差实际样本真实重放——独立 worktree 重新拉音频/GT/逐样本概率，导出可审计
  worst-cases.jsonl + 错误报告
status: ready
labels:
  - gap
parent: null
children: []
extra:
  schema: execution
---
## Proposal

### 现状（2026-10-11 立案）

人 yale 要看 P0.13（`gap-voice-turn-detection-p0-13-english-smart-turn-vs-turn1mini`，已 `done`）里 Smart Turn v3.2 / turn-1-mini 的最差实际样本：音频路径、模型真实输出、GT。本会话已只读核实：`RESULT.json` 只有聚合统计（`denominator`/`gate`/`frontier`/`dense`），**没有任何 per-sample 记录**；原始音频（`data/eot-bench-audio/*.wav`、`datasets/real/` 的 LibriSpeech flac）、span manifest（`data/eot-bench-en-manifest.json`）、逐 cell/逐帧原始概率缓存（`_cache/scores-smart-turn-*.json`、`data/turn1mini-scores.json`）全部落在各自目录的 `.gitignore`（`data/`、`_cache/`、`.venv/`）里，P0.13 worktree 落地后已被 fan-in 回收删除，现在哪个路径下都不存在。**这不是许可问题**——两个语料都是 CC-BY-4.0（`eot-bench-en`: HF `livekit/eot-bench-data`，锁定 revision `ca9d98a9686b920a2d8c9eb984224ba9be74e4dd`，parquet sha256 `e475d435c8693912243e8a810bf7e34a59e01e208551ce5b362c9c778b0fdc4`/162,406,142 bytes；`librispeech-en-real`: OpenSLR SLR12），允许带署名重分发单个样本——纯粹是构建卫生策略把临时产物排除在仓库外。

人 yale 已明确同意：**本任务必须在独立新 worktree 里真实重新拉取音频/GT 并真实重新推理**，不得从 `RESULT.json` 的聚合数字倒推或编造 per-sample 记录。

**并发资源检查（本次立案前已查）**：`gap-voice-turn-detection-p0-14-chinese-zeroshot-and-ft-readiness` 当前 `status: ready`，worker（pid 2650807）已在独立 worktree `claudecodeui-worktrees/gap-voice-turn-detection-p0-14-chinese-zeroshot-and-ft-readiness` 里运行约 8 分钟，`ps` 实测仍只是顶层 claude agent 进程（3.7% CPU），**尚未**观察到它启动 `run-benchmark.mts`/`run-turn1mini.py`/`full-suite-runner.js` 这类重推理子进程。主机资源：128 核、246GiB 内存、67GiB 空闲/164GiB available（`free -h` 实测）。按此刻的快照，两个任务并发不会撞 OOM，但 P0.14 后续若也要跑中文全量 Smart Turn 推理（P0.13 同款单线程 8 秒窗口重推理，耗时约 78 分钟），两边可能短暂重叠——因此本任务的 Plan 里加一道机械的"重推理前先礁一眼"courtesy check（见 Plan 步骤 2），不依赖人持续盯着。

### 目标

在一个**全新、独立**的 git worktree 里（不复用、不触碰 P0.14 的 worktree），真实重新拉取 P0.13 锁定版本的音频+GT，真实重新跑一次 Smart Turn v3.2 与 turn-1-mini 推理，在明确非退化的工作点上找出两个模型各自的 top 10 误截断（GT HOLD→模型判 END）与 top 10 漏端点（GT END→模型判 HOLD/timeout）真实样本，连同可定位路径、sha256、真实模型输出、GT、触发差距，导出为**仓库里跟踪、可审计**的小型产物（不是只存在于会被清理的 gitignored scratch）。

### 边界 / 不做

- ⛔ **不改默认 Live Voice 生产链路**；`git diff develop -- server/modules/voice-realtime/ src/modules/chat/voice-realtime/` 必须为空。
- ⛔ **不训练、不微调**，不下载任何训练专用大权重。
- ⛔ **不触发任何付费 API**；只做本机 CPU ONNX 推理与公开语料（CC-BY-4.0）只读拉取。
- ⛔ **不触碰 P0.14 的 worktree 或其 Touches 路径**（`claudecodeui-worktrees/gap-voice-turn-detection-p0-14-chinese-zeroshot-and-ft-readiness/**`、`experiments/voice-turn-detection-compare/chinese-zeroshot-and-ft-readiness/**`）；也不触碰已落地的 P0.13 产物路径（`experiments/voice-turn-detection-compare/english-smart-turn-vs-turn1mini/**`），只读引用其脚本/pinned revision。
- ⛔ **Gemma 4 保持 `needs-human`/`blocked`/`on-hold` 不变**，本任务与之无关。
- ⛔ **不得编造 transcript**：GT 只能来自已有标注（`silence_spans`/eot-bench 的 label 规则，或 LibriSpeech 候选停顿点的既有标注），不得对音频做新的人工转写或臆测语义。
- ⛔ **不得把 gitignored scratch 文件当永久产物**：最终交付的 `worst-cases.jsonl`/错误报告/README 必须是 git 跟踪文件；若引用音频路径，必须同时给出"任何人任何时候都能用一条命令精确复现出相同字节（sha256 校验）"的方式，不能只说"去 `data/` 里找"。
- ⛔ **重推理前先做并发礁检查**（见 Plan 2），不得在检测到 P0.14 worktree 内有活跃的重推理子进程时无脑抢跑，造成资源竞争。

## Plan

1. **查重**：已查 `tasks/` 无既有 P0.15/worst-case 同题任务（唯一命中的两个文件名含"worst"的任务与本题无关）。worker 入场后应创建**全新独立**的 worktree（不是 P0.13、不是 P0.14 的）。
2. **并发礁检查（courtesy check，机械化，不是一次性人工看一眼）**：在启动本任务自己的重推理（Smart Turn 逐 cell / turn-1-mini 流式）之前，`ps aux` grep 一次 `run-benchmark.mts|run-turn1mini.py|full-suite-runner.js` 是否有命令行包含 P0.14 worktree 路径的进程在跑；若有，记录发现时间并等待（短轮询，不超过 10 分钟一次，累计等待时长写进 `RESULT.json`），直到不再命中或超过合理上限后如实记录"仍检测到但继续执行"及理由；这个检查结果本身要写进交付物（AC6）。
3. **复原音频 + GT**（在新 worktree 里）：
   - 调用/复用 P0.13 的 `fetch-eot-bench-english.py`（原样复制或 import，不改动其 pinned `REVISION`/`PARQUET_SHA256`）拉 eot-bench-en；调用/复用 `datasets/fetch-real-samples.mjs` 拉 librispeech-en-real。
   - 加载模型复用 P0.13 pinned revision：Smart Turn `pipecat-ai/smart-turn-v3`@`f766f81d3cfdf7737ac64aad813d91bbfd56bf93`（onnx sha256 `2bb026316b14a660486a75b1733cd3fbab8c2fd0314dc9af7be49f8cca967e4f`）；turn-1-mini `p99lab/turn-1-mini`@`076c86d1744a231d3a4cce31f3bbbd1211b4c281`（onnx sha256 `e747b182d685c7db489a3ea2e12bdcd65bac506fcddec00ed3cd0bf9f209fd11`，`p99turn` 1.2.3）。
   - 校验：parquet/wav/checkpoint 的 sha256 与上面锁定值逐一比对；`group_of(turn_id)` 的 speaker/session 分组与 P0.13 manifest 的 `groups` 计数一致；两语料的许可署名字符串（CC-BY-4.0 + LibriSpeech/`livekit/eot-bench-data` 的署名文本）在交付物里原文记录。
4. **固定两个非退化工作点，逐 span 重算判定**：
   - 复用 P0.13 `CONCLUSION.md` §2b 已给出的余量点（不新选阈值）：**`threshold=0.13, actionDelaySeconds=1, timeoutSeconds=3.5`**——Smart Turn 与 turn-1-mini 在 P0.13 的 `merged` 视图上都在这个精确点被报告过（分别 cutoff 4.68%/missed 6.75%、cutoff 4.54%/missed 3.50%），同一个策略元组保证两模型在同一批 span 上做的是严格可比的判定。
   - 额外对照基线：**纯固定等待**（即 `threshold=0`，已知的退化策略——不依赖模型分数，只用 `actionDelay/timeout` 判定，等价 VAD/定时器基线）在同一 `actionDelay=1,timeout=3.5` 下重算一次，证明两个模型是否真的比"完全不看模型分数"强。
   - 对每个 span 重算 fire 判定：GT=hold 但判定 END → **误截断**；GT=eot 但判定 HOLD/timeout → **漏端点**。
5. **排序与导出 top 10**：误截断按"触发时刻距真实静音开始的提前量"（越早越严重）排序；漏端点按"距 timeout 的裕量"（如完全不触发=最严重）排序；每条记录：`sampleId`（即 manifest 的 `id`/turn_id 或 librispeech 的 `sampleId`）、`speaker`/`group`、`label`（GT）、`wav` 仓库相对路径模板 + 精确复现方式（revision/row index/字节范围）+ 实测 sha256、真实模型概率轨迹关键点（触发时刻的 p_eot、相邻几个采样点）、决策事件时刻、GT 时刻、触发差距（秒）、该模型在此点的 decision。两模型 top 10 分别列，另给"同一 span 两模型都错 / 只一个模型错 / 基线也错"的交叉对照表（AC3）。
6. **一致性自检**：在 `threshold=0.13, actionDelay=1, timeout=3.5` 这个精确点上，本任务重算出的 k（误截断事件数）、k（漏端点事件数），在 `eot-bench-en` 与 `merged` 两个视图上，必须与 P0.13 `RESULT.json`/`CONCLUSION.md` §2b 表里报告的数字（Smart Turn 33/27、turn-1-mini 32/14，分母 705/400）**完全一致**；不一致则必须查出原因（版本漂移/非确定性/口径差）并如实写出，不得静默吞掉。
7. **交付**：`worst-cases.jsonl`（每行一条记录，git 跟踪）、`ERROR-REPORT.md`（可读的错误案例报告，含两模型异同对照、与基线对照）、`README.md`（复现步骤：如何用固定脚本重新拉出一模一样的字节、如何重新跑出同样的判定）、若决定打包少量实际音频样本（见 AC4），放在**不受 `.gitignore` 排除**的新子目录下作为明确的"已提交审计产物"，并在 README 写清许可署名。

## AC

- [x] AC1 真实复原与校验：parquet/wav/checkpoint 的 sha256 与 P0.13 锁定值逐一比对通过（记录比对结果，不是"假设一致"）；speaker/session 分组数与 P0.13 manifest 一致；两语料许可署名原文记入交付物。
- [x] AC2 固定工作点逐 span 重算：`threshold=0.13, actionDelaySeconds=1, timeoutSeconds=3.5` 对两模型分别给出误截断 top 10 与漏端点 top 10（各自可能少于 10 条则如实写出实际条数，不得凑数或编造）；每条含 `sampleId`/`speaker`/`group`/`label`/wav 可定位路径与复现方式/wav sha256/模型真实概率轨迹/决策事件时刻/GT 时刻/触发差距；按严重程度可解释的规则排序（规则写明）；不编造 transcript。
- [x] AC3 跨模型与基线对照：同一批 span 上，两模型的错误交叉表（都错/只一个错）+ 固定等待基线（`threshold=0`，同 actionDelay/timeout）的错误率对照，给出"模型是否真的比基线强"的结论。
- [x] AC4 可审计产物（非 scratch）：`worst-cases.jsonl`/`ERROR-REPORT.md`/`README.md` 为 git 跟踪文件；若打包部分实际音频字节，放在不受 `.gitignore` 排除的子目录，文件头/README 注明 CC-BY-4.0 署名与来源 revision+sha256；若不打包字节，README 必须给出"一条命令精确复现同一字节内容"的脚本调用方式，并附该次复现已实测验证通过的 sha256（不是理论上应该一致，要跑一次给证据）。
- [x] AC5 一致性自检：固定工作点上重算出的 k/n（误截断、漏端点，`eot-bench-en` 与 `merged` 两视图）与 P0.13 `RESULT.json` 对应数字逐一比对，记录是否一致；不一致须写出排查结论。
- [x] AC6 并发礁检查记录：Plan 步骤 2 的 courtesy check 执行记录（检测时间、是否命中、等待时长）写入 `RESULT.json`；未检测到冲突或等待后清空方可继续全量重推理。
- [x] AC7 零训练零付费零生产不越界：机械证据证明未下载训练权重、零付费 API 调用、生产三路径 diff 为空；未触碰 P0.14 worktree/Touches 路径与 P0.13 已落地产物路径；全新独立 worktree（非复用 P0.13/P0.14）。
- [x] AC8 静态门：`npm run typecheck` 退出 0；若新增 server/** 测试文件，同步 `server/shared/tests/quay-test-script.test.ts` 文件数钉子与耗时基线（预期本任务只涉及 `experiments/**`，通常不触发）。

## DoD

Top 10 误截断/漏端点样本必须来自本任务在独立新 worktree 里真实重新拉取音频+GT、真实重新推理得到的结果，不得从 P0.13 `RESULT.json` 的聚合数字反推或编造；每条记录的 sha256/路径/概率轨迹均须是实测值；固定工作点上的 k/n 必须与 P0.13 已发布数字核对一致（或给出排查结论）；交付物必须是 git 跟踪的可审计文件,不是指向会被清理的 gitignored scratch；若涉及重推理前的资源礁检查，须有记录证明确实执行过而非假设安全；全程零训练、零付费、零生产改动；未触碰 P0.14 在飞的 worktree 或 Touches。

## Touches

- experiments/voice-turn-detection-compare/worst-cases-replay/fetch-and-verify.mjs (new)
- experiments/voice-turn-detection-compare/worst-cases-replay/extract-worst-cases.mts (new)
- experiments/voice-turn-detection-compare/worst-cases-replay/worst-cases.jsonl (new)
- experiments/voice-turn-detection-compare/worst-cases-replay/ERROR-REPORT.md (new)
- experiments/voice-turn-detection-compare/worst-cases-replay/README.md (new)
- experiments/voice-turn-detection-compare/worst-cases-replay/RESULT.json (new)
- experiments/voice-turn-detection-compare/worst-cases-replay/.gitignore (new)
- experiments/voice-turn-detection-compare/worst-cases-replay/fetch-eot-bench-english.py (new)
- experiments/voice-turn-detection-compare/worst-cases-replay/run-turn1mini.py (new)
- experiments/voice-turn-detection-compare/worst-cases-replay/requirements.txt (new)
- tasks/gap-voice-turn-detection-p0-15-worst-cases-replay.md (new)