# composer-input-suggestions — 量化分析脚本

支撑 `docs/proposals/composer-empty-input-suggestions.md` 的数据口径。**脚本只读 `~/.claude/projects/*/*.jsonl`，
输出落在 `/tmp/suggest-analysis/`；其中 `prompts.jsonl` 是用户输入原文，禁止提交进仓库。**

```bash
mkdir -p /tmp/suggest-analysis && cp *.py /tmp/suggest-analysis/ && cd /tmp/suggest-analysis
python3 -I extract.py      # 近 7 天的用户输入 + 其前一条 assistant 回复的特征 → prompts.jsonl
python3 -I stats.py        # 体量、长度分位、精确重复率、高频短语
python3 -I analysis2.py    # 输入分类、与前序 assistant 回复的关系
python3 -I sim.py          # 检索类策略按时间顺序回放的 hit@3
python3 -I llm_eval.py     # haiku 生成 + 判官（40 例，约 80 次调用，≈$0.07；需要本机 claude CLI）
```

口径要点：剔除自动化提示词（quay worker/gate 模板、语音 relay 的 `UTTERANCE`、任务通知、重复模板前缀）与
`[Request interrupted by user]`；回放时每条输入只能用它之前的历史；`llm_eval.py` 的判官偏宽松，
复核后严格命中率约为判官口径的 2/3。
