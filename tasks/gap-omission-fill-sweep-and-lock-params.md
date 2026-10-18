---
id: gap-omission-fill-sweep-and-lock-params
title: 遗漏补发规则 v2：扫 H/G 与阈值、锁定参数文件、接上人工标注精确率，建立回放门（--check / --check-labels）
status: ready
labels:
  - gap
  - voice
  - experiment
parent: null
children: []
extra:
  schema: execution
goal_ac: AC-398
---
## Proposal

GOAL-046 第一个任务，免费、只动 `experiments/` 与 SPEC，不碰 `server/`。

规则 v2 见 `docs/proposals/voice-realtime-omission-fill-SPEC.md`，参考实现是 `experiments/voice-relay-qb/replay_rule.py`（`policy_R2`）。2026-10-18 回放读数：47 连接/583 条，丢失 ≥7 字 2.4%、识别原文 14%、模型与补发各一次 2.4%，但补发延迟 p50 = p90 = H = 12 s（多数补发要等满 H 才确认模型不会再覆盖它）。

要做的：

1. **扫参**：在 `replay_rule.py` 加 `--sweep`，对 H ∈ {4,6,8,10,12} s、G ∈ {1,2,3,5} s、SCORE_T ∈ {0.15,0.25,0.35}、权重门槛 ∈ {6,7,8} 扫一遍，输出表（丢失 ≥7 字、识别原文占比、重复、补发延迟 p50/p90）。目标：补发延迟 p50 明显低于 H，且重复 ≤ 3.6%（当前 2.4% 的 1.5 倍），丢失 ≥7 字 ≤ 3%。
2. **数字删除的副作用**：当前把中文数字串整体删掉，会把"一些、一下"的"一"也删了，使 6~7 字短句掉出资格。试"只删连续 ≥2 个数字字符"或"仅在量词前后删"，用回放比较，选一种写进 SPEC。
3. **冻结清单与参数文件**：把用于判定的 continuous 连接前缀清单（`~/.cloudcli/voice-realtime-log/` 下的日志，当前 47 个）与选定参数写入 `experiments/voice-relay-qb/omission-fill-params.json`，含阈值与理由。清单一经冻结不随日志增长而变（否则 AC 读数漂移）。
4. **`--check`**：读参数文件，只回放清单里的连接，断言 AC-398 的 expect。参数文件缺失、日志缺失、断言失败均非零退出并打印读数。
5. **`--check-labels`**：由 `flagged-for-review.md` 的 64 条重新生成标注集（排序与抽取方式与复核单一致，不手抄），把 R2 补发对到 `labels.json` 的 O/D，断言：标注集上实际补发 ≥ 15 条，其中 O ≥ 80%，打印被判 D 的补发明细。
6. 把选定的 H、G、阈值与"数字处理方式"回写 SPEC 的规则与「待验证」表，并把 `OMISSION_FILL_RULE.md`（v1 草案）标为已被 SPEC 取代。

取假形态（AC 的一部分）：SCORE_T=1.1（全补）与 =0（全不补）都必须使 `--check` 或 `--check-labels` 变红。

## AC

- [ ] `python3 -I experiments/voice-relay-qb/replay_rule.py --check` 退出码 0（即 GOAL-046 的 AC-398）。
- [ ] `python3 -I experiments/voice-relay-qb/replay_rule.py --check-labels` 退出码 0（即 AC-399）。
- [ ] `python3 -I experiments/voice-relay-qb/replay_rule.py --sweep` 退出码 0 并在标准输出打印扫参表，表中至少含 H=4 与 H=12 两行，且每行带丢失 ≥7 字、识别原文占比、重复、补发延迟 p50。

## DoD

在冻结清单上运行 `--check` 与 `--check-labels` 均退出 0，且 `--sweep` 的输出表已回写进 SPEC，选定的参数、拒绝的参数各有读数依据；SPEC 里"数字处理方式"已改成实际采用的那种。读数取自脚本输出，不取自叙述。

## Touches

- experiments/voice-relay-qb/replay_rule.py
- experiments/voice-relay-qb/omission-fill-params.json
- experiments/voice-relay-qb/OMISSION_FILL_RULE.md
- docs/proposals/voice-realtime-omission-fill-SPEC.md
- tasks/gap-omission-fill-sweep-and-lock-params.md

## Notes

日志在仓库之外（`~/.cloudcli/voice-realtime-log/`），所以清单只存前缀，`--check` 缺任何一个连接日志就红，不能静默跳过。
