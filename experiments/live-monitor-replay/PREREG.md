# Live Monitor 48h 历史事件回放 — 预注册

写于跑任何回放之前（2026-10-11）。阈值与判据在看到结果前固定；看到结果后若改，必须在
RESULT.md 里单列「事后修改」并给出前后两组读数。

## 问题

一个跨项目 Live Monitor 若只看 Quay 已有的载体（不新增埋点），在过去 48h 的真实事件上：

1. 原始事件里有多少是机械噪声（心跳、重复、抖动）？
2. 「失败→自愈」能否被合并成一条 Record，而不是 N 条告警？
3. Ignore / Record / Notify / Escalate 分级后，通知量多少、误报漏报多少、延迟多少？
4. 哪些判断在现有数据上**做不出来**（数据缺口）？

## 数据（只读，不伪造）

窗口 = `[now-48h, now]`，`now` 取运行时刻。项目 = `~/work/*` 中带 `.quay/config.yml` 的
CloudCLI 项目（排除 `quay.bak`、`quay-ci-repro`、`quay-dogfood-*`、`voice-capture-false-forms-*`
这些副本/夹具目录）。

| 源 | 用途 |
|---|---|
| `.quay/worker-round.jsonl`、`promotion-round.jsonl` | 驱动心跳：`needs_human` 集合、`halted`、`error`、`stop_reason` 类 |
| `.quay/worker-outcome.jsonl` | 每次派发结局：`final_state`、`mechanical_fan_in.outcome`、`failure_reason`、`session_id` |
| `.quay/verification-round.jsonl` | 每轮 suite：`state` red/green、`taskId` |
| `.quay/fan-in-ff-escalations.jsonl` | ff 升级事件 |
| `.quay/task-status-events.jsonl` | 结构化状态迁移（目前只记 promote） |
| `git log develop -- tasks/` 的 `status:` 行 diff | 全部状态迁移（含 needs-human 进出、done） |
| `tasks/*.md` 当前正文 | `（待外部）`/发布字样（发布依赖）、对其它项目 task id 的引用（跨项目依赖） |
| `~/.claude/projects/-data-home-yale-work-<proj>*/*.jsonl` | 关联会话：worker（session_id 命中）与非 worker 会话（正文提到该 task id） |

每条规范化事件带 `evidence`：`{file, line}` 或 `{repo, sha}`，可回查原始记录。

## 管线（固定顺序）

1. **机械去重去抖**
   - 心跳源只保留「状态投影变化」的轮次（投影 = needs_human 集合 + halted + error 有无 +
     stop_reason 类别）；同投影连续轮次丢弃（dedup）。
   - 去抖：变化后的投影须持续 ≥2 轮**且** ≥120s 才算成立，否则记为 flap 丢弃。
   - 同 `(project, source, entity, kind, key)` 60s 内的重复丢弃。
2. **失败恢复合并**：同一 task 的失败（outcome ∈ exited-not-landed/failed/killed/spawn-failed，
   或 suite red）若在 `T_recover = 6h` 内出现 landed/green，合并为一条
   `recovered(failures=N)`。未恢复的保持为开放失败链。
3. **语义增量**：每个实体维护上次发出的语义状态，只有语义状态变了才放行：task 状态迁移、
   needs-human 进/出、失败链开/关、驱动 halted 变化。纯计数/负载变化不放行。
4. **分级**

| 级别 | 规则 |
|---|---|
| Ignore | 无语义变化的心跳；机械 promote todo→ready；派发本身 |
| Record | task done/landed；失败链在 T_recover 内恢复；red→green |
| Notify | 进入 needs-human（人工决策）；失败链开放超过 T_recover；引用的上游（他项目）task 落地 ⇒ 下游可继续；发布依赖类 task 停在 needs-human/未落地 |
| Escalate | needs-human 持续 ≥ `T_expire = 24h` 无出口（过期）；失败链 ≥3 次仍未落地；驱动 halted/error 持续 ≥30min |

## 评分（结局派生标签，非人工标注）

- **应通知（GT+）**：窗口内进入过 needs-human 的 task；或窗口结束时有 ≥1 次失败、未落地、
  且 6h 内无新尝试（卡死）的 task。
- **不应通知（GT−）**：有失败但最终在无 needs-human 的情况下自行落地的 task。
- 误报 = 对 GT− 发 Notify/Escalate；漏报 = GT+ 从未得到 Notify/Escalate，或首通知晚于其出口。
- 对照基线 = 「天真监视器」：每条失败/red/needs-human 原始事件各发一条通知。
- 指标：每级条数、相对原始事件压缩比、precision/recall（对两种监视器）、GT+ 的首通知延迟中位数。

结局标签本身是启发式；人工抽检样本列在 RESULT.md 的「待人工复核」里，不计入自动读数。

## 运行前修正（看结果之前）

- 读载体样本发现：worker/promotion 心跳里的 `needs_human` 是「本轮新停派的 task」，不是常驻集合。
  于是心跳投影改为 `halted + error 有无 + stop_reason 类`，`needs_human` 每项拆成一条
  `nh-signal` 事件，由语义增量层去掉后续轮次的回声。needs-human 的**出口**只来自 git 状态史。
