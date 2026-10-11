---
id: gap-gemma4-p1-audio-semantic-smoke
title: Gemma 4 P1：Hugging Face 部署路径 discovery（零成本）——Inference Providers 可用性核查 +
  Dedicated Endpoint 定价评估，不建付费端点、不下载大权重到无 GPU 主机
status: superseded
labels:
  - gap
  - cancelled
parent: null
children: []
extra:
  schema: execution
  cancelledAt: 2026-10-11T12:26:43Z
  cancelledBy: yale
  cancelReason: 人 yale 2026-10-11 指示取消（原为其本人要求暂停的 Gemma 4 探索任务）。调研结论以本文件 Proposal
    的三节「现状」原样保留，不删；从未有 worker 被派发、无 worktree、experiments/gemma4-audio-semantic/
    从未创建，故无产物需要清理。
---
## Proposal

### 现状（第三次修正，2026-10-11，人 yale 要求暂停 —— 原因：未找到可用的在线音频托管服务商）

人 yale 明确要求：**暂停 Gemma 4 探索**。原因：本会话（含本次修正前的两轮调研）核实到——Google Gemini Developer API 不列 E2B/E4B；HF 上 `google/gemma-4-E2B-it`/`E4B-it` 均无任何 Inference Provider 托管，唯一路径是按 GPU 小时计费、需用户另行授权预算的 Dedicated Inference Endpoint，且其音频输入是否需要自定义 handler/容器仍未确认——即**没有找到一个可以零成本、免部署直接调用的在线音频推理服务商**。在此前提下继续往下推进（程序化 discovery、定价核实等）产生的边际信息有限，人 yale 选择先停下。

**本次暂停的执行范围**：仅本任务（Gemma 4 探索），不影响 P0.13（`gap-voice-turn-detection-p0-13-english-smart-turn-vs-turn1mini`）或任何其它在飞任务。

**暂停前的在飞状态核实**（本次操作前已检查，无需额外终止动作）：
- `.quay/worker-dispatch.json` 中**没有**本任务的条目——从未有 worker 被派发到本任务。
- `git worktree list` 中**没有**为本任务创建的 worktree。
- `experiments/gemma4-audio-semantic/`（本任务 Touches 里计划新建的目录）**不存在**——没有产生任何代码/脚本产物需要保留，已有调研成果全部以文字形式保留在本节及下方历史 `### 现状` 小节中。
- `.quay/promotion-outcome.jsonl` 显示本任务持续处于 `status=todo`、促升判定 `ineligible-not-fixed`（被跳过），`.quay/task-status-events.jsonl` 显示此前两次短暂促升到 `ready` 后均未被 dispatch 选中（worker-dispatch.json 的选择理由明确写过"gemma4 probe needs live network/keyed calls under a stop-and-report spending gate and would likely park"）。即：暂停前既无在飞 worker，也无排队中的派发，不存在需要"杀掉"的执行体。

**暂停动作**：本次把状态直接置为 `needs-human`（Quay ABI 里用于"非常规终止路径，需要人干预才能继续"的标记，machine-mechanical 的 promote/dispatch 循环不会把 `needs-human` 任务当作候选，等价于"blocked/on-hold"），并加 `blocked`/`on-hold` 标签便于检索；不触碰 AC/Plan/Touches 的既有内容（下方原样保留，供未来恢复时直接复用，不必重新调研一遍）。

**恢复条件**：未来如果发现可用的在线音频托管服务商（零成本或人 yale 明确批准预算后的付费 endpoint 均可），把本任务 `lifecycle_retreat`（needs-human→todo）后交还给促升/派发循环即可继续；届时应先重新核实本节列出的发现是否仍成立（HF provider 列表、定价、license 门槛均可能已变化）。

### 现状（第二次重大修正，2026-10-11，替换"Google Gemini 托管 API"方案）

人 yale 决定不用 Google Gemini Developer API（上一轮已查明该 API 只列 `gemma-4-31b-it`/`gemma-4-26b-a4b-it`，不含 E2B/E4B），改走 **Hugging Face** 路径。修正前本任务仍是 `ready`、`worker-dispatch.json` 无条目、无 worktree——**无在飞实现**，本次仍是干净替换任务体。

**核心限制**：本机无 GPU（已查，`nvidia-smi` 不存在）。HF 上有一个模型仓库，**不等于**有现成、免部署、按次计费的音频 Inference API 可以直接调——这正是本任务要先搞清楚的事，不能假定。

本会话已核实（WebFetch，2026-10-11）：

- `huggingface.co/google/gemma-4-E2B-it`：**没有任何 Inference Provider 托管此模型**，页面原文"This model isn't deployed by any Inference Provider"，只给了"Ask for provider support"的申请入口。无 license 门槛（Apache-2.0，无"Agree and access repository"按钮）。有"Deploy"按钮但页面本身不显示价格/GPU 信息。模型页标注"Model size: 5B params"、"Tensor type: BF16"。
- `huggingface.co/google/gemma-4-E4B-it`：同样**没有 Inference Provider**、同样无 license 门槛（Apache-2.0）、同样只有"Deploy"按钮无价格信息。标注"Model size: 8B params"。
- **这两点意味着：没有现成的、免部署的音频 Inference API 可以零成本直接调**——"Deploy"按钮指向的是 **HF Dedicated Inference Endpoint**（按 GPU 小时计费，官方定价页 `huggingface.co/docs/inference-endpoints/en/pricing` 列出 AWS `nvidia-t4 x1` $0.5/hr、`nvidia-l4 x1` $0.8/hr、`nvidia-a10g x1` $1/hr 等），**只要有一个副本在跑就按整点计费，不是按次付费**；第三方资料还提示计费口径（按小时 vs 按分钟、月结）在不同文档间有出入，需要任务自己读官方账单页核实，不能只信一份摘要。
- 本机 `.env.test` 目前**没有 `HF_TOKEN`**（已查变量名，只有 `GEMINI_API_KEY`/`OPENROUTER_API_KEY`/`DASHSCOPE_API_KEY`）。公开仓库的只读 discovery（模型元数据、`pipeline_tag`、是否 gated）通常不需要 token 就能查，但建 Endpoint、更高速率限制等操作需要——这是任务范围内"能做"和"需要人补 token 才能做"的分界线，必须在报告里写清楚。

### 目标

在**零付费**的前提下，用 HF 官方 API（不是只读网页摘要）做一次程序化 discovery，回答三个问题：

1. `gemma-4-E2B-it`/`gemma-4-E4B-it` 现在是否被任何 Inference Provider 托管、是否接受原始音频+文本请求——用 `https://huggingface.co/api/models/google/gemma-4-E2B-it`（及 E4B）之类的官方端点程序化核实，不是凭网页摘要下结论。
2. 若确认无现成 provider（预期如此，但要用程序化调用再确认一次），评估 **Dedicated Inference Endpoint** 路径：真实读一次官方定价页得到当前数字、是否需要自定义 `handler.py`/容器（音频+文本多模态输入是否被默认的 text-generation-inference 任务类型支持，还是需要自定义推理代码——这是一个需要在 HF 文档/模型卡里找证据的具体问题，不能假设"能部署就等于能跑通"）。
3. 给出人 yale 必须亲自在 HF 网站完成的步骤清单（见下方"人工步骤"一节），**任务本身不执行任何会产生费用的操作**。

### 边界 / 不做

- ⛔ **不下载任何 Gemma 4 大型权重到本机**（无 GPU，禁止重演上一版方案的错误）。
- ⛔ **未经人 yale 明确批准预算前，不得创建任何付费的 HF Dedicated Inference Endpoint**，不得调用任何会触发计费的 HF API（创建 endpoint、扩容副本等）。本任务只做只读 discovery（模型元数据查询、定价页读取），这些本身不产生费用。
- ⛔ **不得假设** E2B/E4B 的音频能力可以通过默认部署方式直接跑通；若文档/模型卡没有明确说明如何处理音频输入（自定义 handler、特定容器镜像等），必须如实记为"未确认，需要进一步调研或联系 Google/HF 支持"，不得拍板"能部署=能用音频"。
- ⛔ **日志/artifact 绝不打印任何 token 值**（HF_TOKEN 若存在，或本任务范围内不涉及的其它 key）；只记录"是否存在该变量"，不记录其内容。
- ⛔ 不改默认 Live Voice 生产链路；`git diff develop -- server/modules/voice-realtime/voice-realtime-bridge.service.ts server/modules/voice-realtime/voice-realtime-dashscope-transport.ts src/modules/chat/voice-realtime/` 必须为空。
- ⛔ 只改 `experiments/` 与 `docs/`，零生产变更。
- ⛔ 不碰 `gap-voice-turn-detection-p0-13-*` 的 worktree 或目录。
- ⛔ 不编造 provider 可用性、定价数字或 handler 要求；缺信息就明确写"未查到/需人工到 HF 网站确认"。

## Plan

1. **程序化 discovery（无需 token，公开只读）**：对 `google/gemma-4-E2B-it`、`google/gemma-4-E4B-it` 调 HF 官方 `api/models/<repo>` 端点，记录真实返回的 `pipeline_tag`、`gated` 字段、`inference` 相关字段（若有）、`siblings`（文件列表及大小，不下载，只读元数据）；同时检查是否有任何 Inference Provider 字段/列表。
2. **定价与部署方式核实**：真实读取 `huggingface.co/docs/inference-endpoints/en/pricing`（或其 API 若有）当前的 GPU 小时价格表；在模型卡/HF 文档/`transformers` 相关 issue 中查找"E2B/E4B 音频输入是否需要自定义 handler 或特定部署镜像"的证据，记录找到或找不到的结论与来源链接。
3. **Token 现状核查（不读值）**：确认 `.env.test` 中 `HF_TOKEN`（或 `HUGGINGFACE_API_TOKEN`/`HUGGING_FACE_HUB_TOKEN` 等常见命名）是否存在；若不存在，在交付物里明确列为"人工步骤待办"，不阻塞其它只读 discovery 的完成。
4. **人工步骤清单**（写入 `CONCLUSION.md`，供人 yale 执行，本任务不代为操作）：
   - 在 huggingface.co 注册/登录账号。
   - 确认 `google/gemma-4-E2B-it`/`E4B-it` 当前是否仍为 Apache-2.0 无门槛（本任务已查当前无门槛，但许可证条款可能变化，建议部署前人工再确认一次）。
   - 创建一个 **fine-grained read token**（只读 discovery/下载权限足够；**不需要**写权限，除非后续要通过 API 自动创建 endpoint）。
   - 把该 token 以 `HF_TOKEN=<value>` 的形式加进本机已有的 `.env.test`（该文件已 0600、已 gitignore，沿用既有 `experiments/voice-gemini-paired-quality/run.mjs` 式的读取惯例，不新建机制）。
   - 只有在**决定实际部署** Dedicated Endpoint 时才需要：在 HF 账号开通 billing、在创建 endpoint 页面确认具体 GPU 型号与每小时价格（认账单页实时数字，不是本任务里记录的某个历史快照）、确认是否需要自定义 handler（若 3 的调研有明确答案，在此处给出建议；若没有，建议先用 HF 的"Deploy"向导走一次只读到"预览价格"的步骤而不点确认创建，看页面是否给出模型特定的 handler/容器提示）。
   - 部署后（若决定部署）记得查看是否有"按副本数常驻计费"的提示，评估是否要设置自动缩容到 0（若 HF 支持）以避免空闲计费。
5. **交付物**：`RESULT.json`（discovery 的真实 API 返回与定价页读数）、`CONCLUSION.md`（一页摘要：是否有现成 provider、Dedicated Endpoint 的真实价格区间、handler/容器开放问题的调研结论、token 现状、人工步骤清单）。

## AC

- [ ] AC1 程序化 discovery：对 E2B-it/E4B-it 的 HF API 真实调用记入 artifact（`pipeline_tag`/`gated`/文件列表等字段的真实返回，不是网页摘要转述）。
- [ ] AC2 Provider 可用性结论：明确记录"当前是否有 Inference Provider 托管这两个模型、是否接受音频输入"，基于本任务自己的真实查询，不是照抄此前的网页快照（网页可能已变化，需要任务执行时重新确认）。
- [ ] AC3 定价真实读取：Dedicated Inference Endpoint 当前的 GPU 小时价格表来自真实读取官方定价页（记录读取时间，价格会变化），计费口径（按小时/按分钟/是否整点起算/空闲是否计费）有明确记录或明确标注"文档未说清，需人工在创建页面确认"。
- [ ] AC4 Handler/容器开放问题：对"E2B/E4B 音频输入是否需要自定义部署方式"给出调研结论（有证据则给出来源链接；没找到证据则明确写"未确认"，不得猜测一个答案）。
- [ ] AC5 Token 现状：记录 `.env.test` 中是否存在 `HF_TOKEN`/等价变量名（只查名称，不读值）；artifact 与日志经自检确认不包含任何 token 的值。
- [ ] AC6 人工步骤清单完整：`CONCLUSION.md` 含上述 Plan 第 4 步列出的全部步骤，且明确哪些步骤本任务已做、哪些只能由人 yale 亲自在 HF 网站完成。
- [ ] AC7 零付费、零下载：机械证据（grep 日志/代码）证明未创建任何付费 endpoint、未下载任何模型权重文件到本机、未产生任何计费 API 调用。
- [ ] AC8 范围边界：`git diff develop` 对三个生产路径为空；未触碰 P0.13 的 worktree 或目录。
- [ ] AC9 静态门：`npm run typecheck` 退出 0；若新增 server/** 测试文件，同步 `server/shared/tests/quay-test-script.test.ts` 文件数钉子与耗时基线。

## DoD

Discovery 结果必须来自本任务真实发出的 HF API 调用，不是转述本会话已查到的网页快照（网页内容可能已经变化，任务执行时必须自己再查一次）；定价数字必须来自真实读取的官方页面并记录读取时间；handler/容器问题要么有证据支持的结论要么明确"未确认"；token 只记录是否存在，绝不记录或打印其值；全程零付费 API 调用、零权重下载、零生产改动；人工步骤清单完整且可执行。

## Touches

- experiments/gemma4-audio-semantic/discover-hf-models.mjs (new)
- experiments/gemma4-audio-semantic/check-endpoint-pricing.mjs (new)
- experiments/gemma4-audio-semantic/RESULT.json (new)
- experiments/gemma4-audio-semantic/CONCLUSION.md (new)
- experiments/gemma4-audio-semantic/.gitignore (new)
- tasks/gap-gemma4-p1-audio-semantic-smoke.md