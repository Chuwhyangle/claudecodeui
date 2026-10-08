---
id: gap-voice-realtime-ambiguity-prereg
title: 四类歧义/world-model 场景的预注册语料、标准答案与打分口径（AC-306）
status: ready
labels:
  - gap
parent: null
children: []
extra: {}
goal_ac: AC-306
---
## Proposal

<!-- dedup-ref --> 立案时 `grep -rli "voice-realtime" tasks/*.md goals/*.md` 只命中本任务同批次立案的 GOAL-029 与姊妹任务，无同机制重复。本任务是 GOAL-029 的第二块，和 `gap-voice-realtime-bridge-offline-provable` 并行、互不依赖；两者都完成后 `gap-voice-realtime-ambiguity-paired-record` 才能开始。

### 背景

`docs/proposals/voice-native-control-plane.md` §10.1/§10.3 把 prototype 的验证范围定在四类场景：同音实体歧义、自我更正、指代消解、world-model/状态查询。延续本仓库 `experiments/voice-draft` 系列一贯的纪律——取数前把语料、标准答案、打分口径、负对照全部写死提交，再跑真实对比（`gap-voice-realtime-ambiguity-paired-record` 的事）。本任务**只**产出这份预注册材料，不跑任何识别/推理，不花一分钱网络调用。

### 方案

1. `experiments/voice-realtime-ambiguity/PREREG.md`：四类场景各一节，写明：语料条数、标准答案的判定口径、打分规则（含"不知道"算什么——尤其 world-model 类，诚实说不知道应该算对，编造应该算错）、至少一条负对照及其预测方向。
2. `experiments/voice-realtime-ambiguity/fixtures/`：四类场景各自的语料条目（文本脚本 + 标准答案 + 可选的 TTS 音频占位路径），JSON/markdown 形式，供 Task 3 的 runner 直接读取。
   - 同音实体歧义：复用本仓库自己的真实易混词（"Quay" / "key" 一类），覆盖有/无项目上下文两种条件。
   - 自我更正：复用 `experiments/voice-draft` 已验证过的"改一下 A——不对，是 B"句式结构，不重新发明。
   - 指代消解：句子依赖一个"当前选中/可见内容"的夹具状态（模拟 `ui_visible_context`/`ui_selected_text` 的返回），不是纯音频能解的。
   - world-model/状态查询：句子依赖一个"当前 run/排队/后台任务/挂起 approval/最近完成任务"的夹具状态（模拟 `session_get`/`run_get`/`approvals_list`/`session_background` 的返回）；标准答案区分"有正确答案"和"工具夹具里压根没有这个信息，必须诚实说不知道"两种子情形。
3. `experiments/voice-realtime-ambiguity/check-prereg.mjs`：自检脚本，断言四类场景都有条目、都达到预先写定的最小条数、都至少有一条负对照；不做任何网络调用。

### 边界（不做）

不跑任何真实识别/推理（零模型调用，零网络）；不生成真实 TTS 音频（语料先以文本脚本形式冻结，音频合成是 Task 3 取数时的事，若音频生成本身引入随机性需要在 Task 3 自己的 runner 里处理，不在本任务）；不判断 Qwen 路径还是现有路径更好（本任务不产生任何比较性读数）。

## AC

- [x] AC1 `experiments/voice-realtime-ambiguity/PREREG.md` 存在，四类场景各一节，每节写明语料条数、标准答案口径、打分规则、负对照及预测方向。
- [x] AC2 `fixtures/` 下四类场景各有对应条目，条数达到 PREREG 写定的最小值；`node experiments/voice-realtime-ambiguity/check-prereg.mjs` 退出 0。
- [x] AC3 每类场景至少一条负对照，预测方向在 PREREG 里写死（取数前）。取假变体：删掉某一类的负对照 ⇒ 自检脚本必须红并指名缺的类别。
- [x] AC4 空读数不是绿：任一类场景的语料条目为空 ⇒ 自检脚本退出非 0，判词指名空的类别。取假变体：清空某一类 `fixtures/` 条目 ⇒ 必须红。
- [x] AC5 零网络/零模型调用：本任务不包含任何真实 API 调用；`check-prereg.mjs` 里不出现任何 `fetch`/HTTP 客户端引用。
- [x] AC6 world-model 类的标准答案区分"有答案"与"夹具里没有这个信息，必须诚实说不知道"两种子情形，且后一种在打分口径里明确不算编造的同义词（即"不知道"不能被打分口径误判为失败）。
- [x] AC7 静态门：`npm run typecheck` 与 `npm run lint` 退出 0（`check-prereg.mjs` 与 fixtures 若含 TS/JS 代码需过门）。
- [x] AC8 不进判据：`check-prereg.mjs` 末行自陈"this script only checks prereg completeness, not answer quality"，不输出任何可能被误当成质量阈值的数字。

## DoD

真实落地判据：不是"有一份 PREREG.md"，是**这份材料真的能在 Task 3 取数前把判定口径钉死、且这件事可以被机械检查**——AC3/AC4 的取假变体证明自检脚本真的在查"完整性"而不是摆设。本任务完成之后，Task 3 唯一允许做的事是"读这份材料跑对比"，不允许在取数时再改判定口径（若发现口径有缺陷，按偏离记录处理，不静默改）。

## Touches

- experiments/voice-realtime-ambiguity/PREREG.md (new)
- experiments/voice-realtime-ambiguity/fixtures/ (new)
- experiments/voice-realtime-ambiguity/check-prereg.mjs (new)
- tasks/gap-voice-realtime-ambiguity-prereg.md (self)