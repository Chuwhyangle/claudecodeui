---
id: AC-333
title: MCP 目标解析的优先级：精确 id、规范化完整路径、唯一精确标题依次优先于子串；写工具只接受精确目标，子串只用于只读发现
status: achieved
kind: criterion
goal: GOAL-039
criterion: for f in server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts
  server/modules/mcp-gateway/tests/mcp-resolve-target-precedence.test.ts; do [
  -f "$f" ] || { echo "缺判据文件：$f" >&2; exit 1; }; done; npx tsx --tsconfig
  server/tsconfig.json --test
  server/modules/mcp-gateway/tests/mcp-resolve-target.test.ts
  server/modules/mcp-gateway/tests/mcp-resolve-target-precedence.test.ts
expect: 读数（新判据文件 mcp-resolve-target-precedence.test.ts，项目夹具含
  quay、quay-web、foo-quay、Quay-Two 与两个同名 app）——(a) 精确 id 仍最先胜出（回归）；(b)
  项目参数等于某项目规范化后的绝对路径（path.resolve 并去掉末尾分隔符）时直接命中，即使它的标题子串有多个命中；(c)
  去首尾空白后区分大小写的精确标题唯一命中时解析成功——project 取 quay 命中 quay，而不是因 quay-web 与 foo-quay 报
  TARGET_AMBIGUOUS；(d) 区分大小写无命中时，不区分大小写的精确标题唯一命中也解析成功（QUAY 命中
  quay），但区分大小写层先行（夹具同时有 Quay 与 quay 时 quay 取 quay）；(e) 两个项目精确同名（两个 app）时报
  TARGET_AMBIGUOUS，候选逐条带 id、title、path 与 matchType 为 exact_title；(f)
  只读工具上子串唯一命中仍解析（AC-246 (a) 不变），多个子串命中报 TARGET_AMBIGUOUS，项目候选带 path 与 matchType
  为 substring；(g) 写工具（tools/list 中 readOnlyHint 为 false
  的全部工具，从注解表派生而不是手写名单）收到只靠子串才命中的目标时拒绝，错误码沿用 TARGET_AMBIGUOUS，details.reason 为
  exact_target_required，candidates 恰为那一条，注入服务的调用计数为 0；同一目标改用
  id、完整路径或精确标题时正常到达处理函数；(h) 会话目标同样适用 (a)(c)(d)(f)(g)，会话没有路径层。既有
  mcp-resolve-target.test.ts 全部通过，其 (f) 正向对照改用精确标题，断言强度不降。取假形态（先提交实现再变异，逐条记录变异
  diff、逐字失败行与恢复命令）——(i) 删去精确标题层 ⇒ (c)(d) 必须红；(ii) 写工具接受子串 ⇒ (g) 必须红；(iii)
  先做不区分大小写再做区分大小写 ⇒ (d) 的 Quay 与 quay 对照必须红；(iv) 写工具名单改成手写常量并漏掉一个 ⇒ (g)
  必须红。红先行：当前判据文件不存在，存在性闸以退出码 1 输出缺失的文件名。
origin: 外部 Agent 2026-10-11 裁定 D1、D2 后激活
activatedAt: 2026-10-11T10:08:02.588Z
statusLog:
  - at: 2026-10-11T10:08:02.588Z
    from: draft
    to: active
    actor: goal-cli
    reason: ""
  - at: 2026-10-11T10:33:09.366Z
    from: active
    to: achieved
    actor: goal-driver
    reason: "I2: criterion pass"
fidelity:
  verdict: not-evaluated
  reason: no judge configured
  at: 2026-10-11T10:08:02.587Z
---
