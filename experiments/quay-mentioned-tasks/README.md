# quay-mentioned-tasks

扫描本项目最近的 Claude 会话 transcript,统计 **task/goal 完整 id** 出现在
`user`/`assistant` 消息正文(排除 tool 调用)中的情况,以及这些提及在 transcript
中的深度分布——用于回答「展开面板取数该扫全量 transcript 还是最近 N 条」。

## 运行

```bash
python3 scan_mentions.py \
  --project-root /data/home/yale/work/claudecodeui \
  --transcript-dir ~/.claude/projects/-data-home-yale-work-claudecodeui \
  --recent 250 --out report.json
```

- 词汇表 = `tasks/*.md` 的 slug(1078 个)+ `goals/*.md` 的 `GOAL-NNN` 前缀(49 个);
  `AC-*` 明确排除。
- 「正文」= `user`/`assistant` 条目的 `text` 块;`tool_use`、`tool_result`、
  `thinking` 块丢弃。
- 匹配 = 按非 id 字符切词后对闭集做大小写不敏感精确匹配(不模糊、不前缀)。
- 「body 单元」= 一条 user 消息或一个 assistant text 块,作为位置的计数单位。

## 结论(2026-10-24,详见 docs/experiments/2026-10-24-quay-mentioned-tasks.md)

- 最近 250 个会话中 **96.8%** 的正文至少提到一个 task/goal id;人类会话 94%(中位
  2 个 distinct id),worker 会话 100%(中位 1 个,即自己被分发的任务)。
- tool 块里的提及是正文的 ~10 倍(18795 vs 1812),排除 tool 调用是必要的降噪。
- 提及深度分布很散:最近 500 条 body 单元才覆盖 70% 的提及;只扫最近 20 条会有
  **12%** 的会话显示空列表。⇒ **必须扫全量**;好在人类会话很短(中位 15 单元),
  worker 会话虽长但 server 已有增量 transcript reader 可缓存。
- goal id 在正文里几乎不出现(32 vs task 1190)⇒ 列表以 task 为主;goal 更适合由
  task 的 frontmatter join 得出,而非正文提及。
