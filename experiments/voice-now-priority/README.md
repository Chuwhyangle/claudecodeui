# X3'：忙时语音的投递方式 × 第 1 层 hook —— 状态、臂定义、判据、命令（2026-10-15）

人 yale 的裁定（2026-10-15，出处见 `docs`/transcript 会话「Live Voice 使用中的问题」）：Live Voice 的问题不在中继断句太快，
而在 **Claude Code 前台被长时间占住，后面说的话只能排队**。改进分三层——本实验测第 1 层与第 3 层：

1. 长操作派后台，前台只做调度（第 1 层，`UserPromptSubmit` hook 注入规则；实验装置在 `../voice-foreground-background/`）；
2. 打断时只停前台，后台交给 Claude 自己（本实验不碰；`now`/`next` 都不杀后台——见机制读数）；
3. 忙时说的话更及时地送到 Claude（本实验的主变量：投递优先级 + 忙时合并窗口）。

本文件是**接手用**的单一入口：盘上有什么、臂是什么、判据是什么、命令怎么敲。改臂/改判据前先读「判据（预先写下）」。

## 机械读数（已复验，2026-10-15）

| 方式 | 效果 |
|---|---|
| SDK `interrupt()`（= 生产的 `session_interrupt`） | **会杀掉正在跑的后台 Agent**（3/3）；后台 Bash 不受影响 |
| `priority: next` | 在下一个工具边界**并入当前 turn**，约 3 s 后读到；不杀任何东西 |
| `priority: now` | 在下一个工具边界**切掉当前 turn**（原命令记为 `cancelled`），新开一个 turn；不杀后台 |
| `priority: later`（当时 driver 在用） | 等整个 turn 结束 |

两者都不打断正在跑的工具（有 30 s 命令在跑时要等它跑完）。更正两条旧说法：`now` 并入当前 turn 是错的（并入的是 `next`）；
「`next` 永不落地」在常驻会话条件下不成立（每次都落地）。每条插入消息都有 `command_lifecycle started` 事件（SDK 会滤掉，只有读 CLI 原始流才看得到）。

第 1 层阈值依据（`../voice-foreground-background/analyze-turns.mjs`，25 个语音会话 / 172 个语音触发的前台 turn）：
turn 时长 p50 **15.3 s**、> 20 s 的 turn 占 **45% 但占前台总时长的 90%**；前台时间的 **75% 是模型自己在想/写**，不是工具在跑。
⇒ 规则取「预计本轮 > 约 20 s → 第一步派后台 Agent；单条命令 > 约 10 s → 后台 Bash；≤ 20 s 前台做」。

## 臂定义（人 2026-10-15 批准；权威实现在 `x3-replay.mts` 头部与 `priorityFor/merges/hookOn`）

| 臂 | 第 1 层 hook | 忙时投递 | 回答什么 |
|---|---|---|---|
| **A** | 关 | 现状：各段缓冲，当前 turn 的 `result` 到达后合成一条，以 `later` 投递（新 turn） | 基线 |
| **B** | 开 | 现状（同上） | 只有第 1 层时效果多少 |
| **C** | 开 | 停说满 2 s（上游 `speech` stop 事件）且距最后一段 ≥ 0.8 s 才冲洗，20 s 封顶，包含式去重 → 以 `now` 投递 | 组合方案 `now` 版 |
| **D** | 开 | 同 C → 以 `next` 投递 | 组合方案 `next` 版 |
| **E** | 开 | 同 D，**再加 hook 的碎片规则**（`VOICE_MODE_RULES_VARIANT=fragments`：没说完的话只简短应一声、等后续） | 碎片规则能否压住「按半句话行动」 |

所有臂共有：空闲时 1 s 合并后投递（= 现状）；空段与截断 JSON 段丢弃（它们当时没被投递）；30 s 内逐字重复的段丢弃。
快照、沙箱与「与生产一致的启动参数」见 `resident-launch.mts`（直接调生产的 `buildResidentSdkOptions`，偏离逐条列在该文件里）。

## 片段集（10 个）

`x3-labels.json` 逐个片段人工标注；`traces/x3-candidates.json` 是从真实语音会话里切出的候选 turn。
`x3-analyze.mjs` 用「deliverable 段落逐字等于标注文本」把每个标注集**唯一**对上一个候选，得到 10 个 intended episode
（分钟精度前缀会命中同一连接的其他 turn——那 25 次是**非预期运行**，留在盘上但分析时被 `INTENDED` 过滤掉）：

`faeb9c61@10-11T11:22:24` · `164c3087@10-14T15:16:43` · `99df08d8@10-12T01:24:07` · `a175e6cd@10-14T18:23:50` ·
`b33412ea@10-14T17:09:44` · `d4c9bfc4@10-14T01:36:53` · `99df08d8@10-12T01:26:18` · `af12cbaf@10-14T09:52:44` ·
`b5d01c21@10-13T15:59:28` · `57279cc1@10-11T15:42:32`

每次运行：一次性 git worktree（checkout 到该 turn 开始前的 `develop` 提交，`node_modules` 符号链接到主仓）→ 把原 session 的
transcript 复制进该 worktree 的 project 目录 → `resume + resumeSessionAt(prompt 的父消息) + forkSession` → 重发开启该 turn 的
原 prompt → 按臂把语音段按**原时间偏移**推进去。沙箱（`PreToolUse`）拦下 worktree 外的写入、网络、测试/构建、`:3001`、
`kill/systemctl/quay`、`git push/commit` 等。

## 命令

```bash
cd /data/home/yale/work/claudecodeui
# 全量（A–D × 10 片段 × 2 次 = 80 次；E 单独一批 20 次）
setsid nohup npx tsx --tsconfig=server/tsconfig.json experiments/voice-now-priority/x3-replay.mts \
  --episodes 'faeb9c61@10-11T11:22:24,164c3087@10-14T15:16:43,99df08d8@10-12T01:24:07,a175e6cd@10-14T18:23:50,b33412ea@10-14T17:09:44,d4c9bfc4@10-14T01:36:53,99df08d8@10-12T01:26:18,af12cbaf@10-14T09:52:44,b5d01c21@10-13T15:59:28,57279cc1@10-11T15:42:32' \
  --arms A,B,C,D --reps 2 --parallel 6 --model <模型> \
  > /tmp/x3-full.log 2>&1 &
```

- `--model`：**模型名会原样进 CLI 的 `--model`**。2026-10-15 已落盘的 94 次全部用 `sonnet`；其内层会话 transcript 里的 `message.model`
  是 `claude-sonnet-5` ⇒ 这一档实际由 Anthropic Sonnet 服务（走网关 `127.0.0.1:26510`）。⚠️ **不要改用 `v4.1flash`（DeepSeek 组）**，原因见下节。
- `--rep-offset N`：重复轮的起始编号，补跑缺失轮时用它，避免覆盖已有的 rep0。
- `--parallel`：并发路数；`--cap`（默认 480000 ms）单次上限。
- `--models A=haiku,B=sonnet`：按臂覆盖模型。
- **输出目录**：每次调用新建 `traces/x3-<ISO时间戳>/`，文件名 `<episode>-<arm>-<rep>.json`，每次运行一行 stdout（wall/turns/delivers/blocked/bg）。
- 收尾行 `out <dir>` = 正常跑完；**没有这一行 = 被杀**（2026-10-15 那次就是）。

读数：

```bash
node experiments/voice-now-priority/x3-analyze.mjs <dir1> <dir2> …    # digests 与 summary.json 落在 dir1
```

指标定义在 `x3-analyze.mjs` 头部（投递延迟、首个反应、到达即空闲、前台忙占比、派后台次数与首次派发 D、碎片单独投递 / 据其行动、未投递段）。

## 判据（预先写下，跑完再看——不要事后改）

- **C 或 D 相对 A**：语音「被读到」的中位数 ≤ **5 s**、p90 ≤ **20 s**；被评论/噪声带偏的次数**不多于 A**；原任务完成率**不低于 A**。
- **C 与 D 之间**：先比被带偏次数与原任务完成率；这两项打平再比延迟。
- 语义判读按会话里定的 4 个问题逐条读 digest：接住没有 / 原任务有没有被丢下 / 有没有被评论带偏 / 处理时机对不对。
- 结果的「完成率、带偏」是**语义**读数，机械指标只是代理（首个反应也可能只是原任务的下一步）。

## 当前进度（2026-10-15 15:1x 实测）

10 片段 × 5 臂 × 2 次 = **100 次；已落盘 94，其中 10 次被会话限额打死（无效）⇒ 有效 84**（A 16 / B 16 / C 16 / D 16 / E 20）。
⚠️ 因此**补齐时要重跑 10 + 6 = 16 格**（缺的 6 格 + 限额致死那 10 格），否则 A–D 永远停在 16 而 E 是 20。

| 目录 | 内容 | digests/summary |
|---|---|---|
| `traces/x3-2026-10-15T06-32-18-235Z` | A–D 主批（72 个文件，含非预期） | 有 |
| `traces/x3-2026-10-15T06-55-16-240Z` | E 批（28，正常跑完） | 无 |
| `traces/x3-2026-10-15T07-03-03-822Z` | rep1 补批（18，被杀） | 无 |
| `traces/x3-2026-10-15T06-25-07-471Z` | **X1' haiku 门槛批 —— 分析时必须排除** | 有 |
| `traces/x3-2026-10-15T05-20-11-263Z` | 早期单跑（旧臂名 `N2next`），历史遗留 | 无 |

缺的正好 6 次：`b5d01c21@10-13T15:59:28` rep1 × {A,B,C,D}（整队没轮到）＋ `57279cc1@10-11T15:42:32` rep1 × {C,D}（在飞被杀）。

**两件事同时发生，别只记一件**（2026-10-15 更正，早期版本只记了后者、并把前者说反了）：

1. **账号 5h 限额**：约 07:08Z 起，内层 sonnet 会话开始撞 `You've hit your session limit` —— **13 次运行**事件里带这条错，
   其中 **10 次零工作（无效）**：`57279cc1` A/B rep1、`99df08d8@10-12T01:26:18` A–D rep1、`af12cbaf` A–D rep1；
   另 3 次在投递跑完之后才死（`b33412ea` E-1、`b5d01c21` E-1、`d4c9bfc4` C-1）。⇒ **有效运行 84/100**（读数脚本 `x3-exclude-dead.mjs` 已按此剔除）。
   早先"限额只打 Opus、sonnet 健康"的说法**是错的**。
2. **父会话之死**：15:09 撞限额 → 15:11 重启换 deepseek-flash → 进程重启后首条消息 422（`tool_definition`，litellm→DeepSeek 的确定性杀手）
   → 会话结束，**挂在它 `run_in_background` 里的两个 tsx 进程被连坐杀掉**（`/tmp/x3-fill.log` 停在 07:10:28，无 `out` 行）。⇒ 长 fan-out 一律 `setsid` 分离。
3. 两件事叠加才解释了补批的形状：限额先打死后半批 → 父会话再死、把剩下的在飞运行一起带走（缺的那 6 格就是没轮到的）。

## ⛔ 补齐批次只能用 Anthropic 模型名（`--model sonnet`）——两个 DeepSeek 组都实测过，是结构性的

2026-10-15 15:2x/15:3x 各跑了 1 次探针（`b5d01c21` A-1，`setsid` 分离）：**`--model v4.1flash` 与 `--model v4.1flash-anthropic` 都在内层会话立即 422**，
与杀死父会话的是同一个形态，且两次请求的 `column` 相同（92885）⇒ 确定性、不可重试（`gateway-422-tool-definition-inline-tools-kills-session` 记的就是这条）：

```
API Error: 422 litellm.BadRequestError: DeepseekException - ... messages[4].content:
unknown variant `tool_definition`, expected `tool_reference` ... at line 1 column 92885
```

**原因不在 wrapper/env，而在本实验的形状本身**：每次回放都是「复制原 transcript → `resume + forkSession`」，即**带既有 transcript 的进程启动**，
而 CLI 的 inline-tools 路径正是在这种情况下把延迟加载的工具重新内联成 `{type:"tool_addition",tool:{type:"tool_definition",…}}`
（fork 里的 `deferred_tools_delta` / `deferred_tools_record` 记录确在，含 `mcp__claude_ai_Claude_Docs__*`）。DeepSeek 的 Anthropic 兼容层只认
`tool_reference` ⇒ 必炸。`claude-deepseek`（直连 `api.deepseek.com/anthropic`）是同一个上游，同样不行。

**判据（别再试第三遍）**：读内层会话 transcript 的 `api-request.params.model`，比网关 `GET /v1/models` 的组列表。

| | 请求里的 model | 结果 |
|---|---|---|
| 已落盘的 94 次（`--model sonnet`） | **`claude-sonnet-5-5`**（带 `oauth-2025-04-20` beta）⇒ 真 Anthropic 模型 id，走订阅 | 全部正常 |
| `--model v4.1flash` | `v4.1flash` ⇒ DeepSeek 组 | 422 |
| `--model v4.1flash-anthropic` | `v4.1flash-anthropic` ⇒ **也是 DeepSeek 组**（`-anthropic` 指的是 DeepSeek 的 Anthropic 兼容**接口**，不是 Anthropic 服务） | 422 |

网关（`127.0.0.1:26510`）的组列表：`v4.1flash` `v4.1flash-anthropic` `v4pro` `v4pro-anthropic` `glm-5.2` `glm-5.3` `gpt-5.6-luna/sol/terra`
`gpt-6-astra` `qwen3.8-flash/max` —— **全部非 Anthropic**。所以 `ANTHROPIC_DEFAULT_*_MODEL` 那三个环境变量不决定回放用哪个模型：
`--model sonnet` 走的是别名解析（→ `claude-sonnet-5-5`），不是 `ANTHROPIC_DEFAULT_SONNET_MODEL`。

⇒ 补齐 6 次只能沿用 `--model sonnet`（与已落盘 74 次同源、可比）。两次探针都没有留下 trace 文件（被杀时未落盘），worktree / project 目录已清理。

## 补齐那 6 格 + 重出读数（2026-10-15 18:40 之后执行）

人 2026-10-15 裁定：先以 **74/80** 出结论（`REPORT.md`，已注明不平衡），6 格由人在 18:40（Opus 限额重置）之后用 **sonnet** 补。补完重跑读数即可，脚本与判据都不用改：

**要重跑的是 16 格**：缺的 6 格（`b5d01c21` A–D rep1、`57279cc1` C/D rep1）+ 限额致死的 10 格（`57279cc1` A/B rep1、`99df08d8@10-12T01:26:18` A–D rep1、`af12cbaf` A–D rep1）。

```bash
cd /data/home/yale/work/claudecodeui
# 1a) 缺的 6 格（拆两条，避免产出重复文件：57279cc1 的 A/B rep1 已在盘上——但见 1b，它们本来也要重跑）
setsid nohup npx tsx --tsconfig=server/tsconfig.json experiments/voice-now-priority/x3-replay.mts \
  --episodes 'b5d01c21@10-13T15:59:28' --arms A,B,C,D --reps 1 --rep-offset 1 --parallel 4 --model sonnet \
  > /tmp/x3-tail-a.log 2>&1 < /dev/null &
# 1b) 限额致死的 10 格（57279cc1 A,B 也在这里重跑，所以 1a 只跑 C,D 就够）
setsid nohup npx tsx --tsconfig=server/tsconfig.json experiments/voice-now-priority/x3-replay.mts \
  --episodes '57279cc1@10-11T15:42:32' --arms A,B,C,D --reps 1 --rep-offset 1 --parallel 4 --model sonnet \
  > /tmp/x3-tail-b.log 2>&1 < /dev/null &
setsid nohup npx tsx --tsconfig=server/tsconfig.json experiments/voice-now-priority/x3-replay.mts \
  --episodes '99df08d8@10-12T01:26:18,af12cbaf@10-14T09:52:44' --arms A,B,C,D --reps 1 --rep-offset 1 --parallel 6 --model sonnet \
  > /tmp/x3-tail-c.log 2>&1 < /dev/null &
# 2) 每个日志末尾要出现 `out <dir>` 才算跑完（没有这行＝被杀）。⚠️ 现在会同时有并发 14 路，
#    按 cgroup 8G 与历史 6 路的经验，建议串行分批、每批 ≤6 路。
#    新文件与旧无效文件同名同 key：读数时用 x3-exclude-dead.mjs 按 key 剔除旧的 10 个无效 key，新的才被计入。
# 3) 重出读数：新目录追加到最后一个参数；⚠️ 06-25 那个 haiku 门槛批**不要**传进来
node experiments/voice-now-priority/x3-analyze.mjs \
  experiments/voice-now-priority/traces/analysis-74of80 \
  experiments/voice-now-priority/traces/x3-2026-10-15T06-32-18-235Z \
  experiments/voice-now-priority/traces/x3-2026-10-15T06-55-16-240Z \
  experiments/voice-now-priority/traces/x3-2026-10-15T07-03-03-822Z \
  experiments/voice-now-priority/traces/x3-<新目录A> experiments/voice-now-priority/traces/x3-<新目录B>
```

补完后 A–D 各 20 次、E 20 次，`REPORT.md` 里标注为「74/80」的段落需要按新读数改写（语义判读的 digest 也会重新生成在那两个新目录的 `digests/`——注意 analyzer 只往 **dirs[0]** 写 digest，所以 digest 仍在 `analysis-74of80/digests/`）。

## 分析注意

- **排除 `06-25` 目录**：那 6 个 B 臂是 X1' 的 **haiku** 门槛跑，episode id 与正式跑逐字相同，混进去会把 haiku 混进 sonnet 的 B 臂聚合。
- **B 臂有重复**：3 个片段的 B-0/B-1 同时存在于 `06-25` 与 `06-32`（同因），聚合时只认一个。
- 补齐批若用不同模型，**必须在报告里单列**，不可与 sonnet 那 74 次合并成同一读数。

## 收尾清单（报告里要写明的偏差 + 待清理）

- 沙箱误拦：`> /dev/null` 这类写法被 `writes` 正则误判成写文件，拦掉少量只读命令（Claude 会换个写法重试）。为避免中途改变四臂条件，未在跑动中修；报告里给出各臂 `blocked` 计数。
- DashScope 花费 **¥0.53**，超预算 ¥0.5 共 ¥0.03（并发运行时预算闸只在越线后关 socket）。本实验（X3'）不用 DashScope。
- E2 首轮**误用 opus**（22 次）——人随后裁定实验一律用最便宜的模型，重跑用 haiku；其遵从率只能作参考。
- 待清理（删前先列清单给人看）：E2 在本项目会话目录留下的 **55 个会话记录**；各实验留下的 **40 多个 `-tmp-*` 项目目录**；被杀批次遗留的 **12 个 `/tmp/x3wt/*` worktree**（`git worktree list | grep x3wt`）。
- 落地未做：第 1 层 hook 与投递策略**只在 `experiments/` 里**。生产接线需要中继在 Live Voice 连接建立/拆除时写/删 `~/.cloudcli/voice-active/<claude session id>`（`../voice-foreground-background/hook/voice-mode-context.mjs` 的门控就是读它）；结论出来后才谈改代码。

## 相邻实验

- `../voice-foreground-background/`：第 1 层 hook 本体（`hook/voice-mode-context.mjs`）、E1/E1b/E1c（interrupt 存活、`priority` 软改道）、E2（hook 遵从率）、E3（中继 prompt「更多打断」臂）、`analyze-turns.mjs`（阈值依据）。X3' 的 B–E 臂用的就是它那个 hook 文件。
- `../voice-realtime-closing-turn/`、`../voice-realtime-turn-detection-live/`、`../voice-realtime-prefix-history-pruning/`：断句窗口/收尾那条线。人 2026-10-15 明确「快本身是想要的」，该线**退居次要**（读数：句中停顿中位数 410 ms 正卡在 400 ms 窗口上，44 s 的话被切成 15 段；窗口 800 ms → 7 段、1000 ms → 2 段，花费只差约 10%）。
