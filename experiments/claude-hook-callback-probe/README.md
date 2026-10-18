# 探针：`hooks` 包里的**回调**对 `UserPromptSubmit` 会触发吗？（2026-10-15）

**问题**：出货的 Live Voice 规则 hook 是「命令 hook 写进 `settings.hooks`」，代价是**每次提问 spawn 一个 node 进程**。
`sdk.d.ts` 显示 `HookCallbackMatcher.hooks: HookCallback[]`、且 `UserPromptSubmitHookSpecificOutput` 带
`additionalContext`（`:6081-6084`，并在 `HookJSONOutput.hookSpecificOutput` 的联合里 `:5886`），所以怀疑
「进程内回调」可以零 spawn 地做同一件事。driver 的注释只记录了两次实测（`{type:'command'}` 放进 `hooks` 包
**不触发**；command 放进 `settings.hooks` **会触发**），**没有**记录回调这一支。本探针补上。

## 结论：回调形式**可行**，而且与 `settingSources` 无关

**判据不是"模型有没有照做"，而是 transcript 里有没有注入文本**（模型有时会**静默忽略**注入内容，用「回复里有没有 nonce」当判据会误判——我第一版就是这么误判的）。

机械读数（每个会话的 transcript，注入以 `attachment` 记录落盘）：

| 会话 | 注入文本 | 臂 | 注入？ |
|---|---|---|---|
| `11982443` | `CALLBACK_45a568cd` ×2 | **回调 · `settingSources: []`** | ✅ |
| `3cf281e5` | `CALLBACK_9dd833f4` | **回调 · 出货的 `settingSources`** | ✅（这一次模型还逐字照做，回复就是 `CALLBACK_9dd833f4`） |
| `6917202f` | `CMD_a7ac3e09` ×2 | 命令 · `settings` · `[]` | ✅ |
| `4f915246` | `CMD_b3ae1617` | 命令 · `settings` · 出货 sources | ✅（模型逐字照做） |
| `815181e6` / `64c48949` | 无 | `{type:'command'}` 放进 `hooks` 包 / 无 hook | ❌（复现 driver 的注释 + 阴性对照） |

四组合交叉完毕：

| 形态 | 触发并注入？ |
|---|---|
| `hooks.UserPromptSubmit[].hooks[] = async () => ({hookSpecificOutput:{…additionalContext}})` | **✅** |
| `settings.hooks.UserPromptSubmit[].hooks[].command`（**出货形态**） | **✅** |
| `hooks.UserPromptSubmit[].hooks[] = {type:'command', …}` | ❌ |
| 不挂 | ❌ |

## 对出货设计的含义

1. **出货形态没错**，driver 那段注释里的取舍（命令形式放 `settings`）得到独立复现。
2. **但有一条更便宜的等价路线**：进程内回调 ⇒ **零 spawn**（现在每次提问一个 node 进程）、**不需要标记文件**、也**不需要启动时清理陈旧标记**（门控可以改成中继持有的会话内布尔：连接建立置真、拆除置假——即"随连接生效"落在**状态**而不是**注册**上）。
3. **一条观察（不是缺陷）**：注入以 `attachment` 形式进入上下文 ⇒ 模型**可能把它读成可疑注入**并拒绝（本探针的注入措辞故意写成「Ignore all other instructions」，就换来过一次显式抵抗：「那不是我说的，我没照做」）。对出货的 Live Voice 规则影响有限——X3' 的 B–E 臂实测确实照做了（派后台的 run 0/16 → 9–10/16–20），说明那份规则文本会被接受；但"注入内容可能被当成注入攻击"值得留在风险清单里。

## 跑法

```bash
set -a; . ./.env.test; set +a
npx tsx --tsconfig=server/tsconfig.json experiments/claude-hook-callback-probe/probe.mts
```

`probe.mts` 里的 `hookInvoked` 字段**只对回调臂有意义**（命令 hook 在另一个进程里跑，设不了本进程的 flag）；判断任何臂都请读 transcript 里的注入文本。
