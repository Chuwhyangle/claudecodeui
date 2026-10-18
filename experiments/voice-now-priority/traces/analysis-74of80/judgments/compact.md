# 语义判读·压缩表（读者 2/3/4 的 RUN 行摘要；完整原文见各自 reader 输出）

格式：`片段 arm rep | dropped | derailed | delivered`

## 164c3087@10-14T15:16:43（9 段几乎全 ADD-frag + 末段 ADD；无 REMARK/NOISE ⇒ derailed 一律 na）
A 0 | no | na | yes(推断，无日志证据；8 条半句被逐条追问「请接着说完」)
A 1 | no | na | yes(转向「更像输入框听写」，碎片驱动方向改变最明显)
B 0 | no | na | partial(27.4s 派后台查切句，未回收；84.9 只说「有假设没证据」)
B 1 | no | na | yes(唯一自己翻 server.log 查出 106s 忙时 hold + 三句被吞)
C 0 | no | na | yes(后台 agent 比末段语音早 0.4s 出发；结论＝busy hold)
C 1 | no | na | yes(agent 在 [ADD] 之后才起；只能拿昨晚日志当旁证)
D 0 | no | na | yes(碎片被记成 4 条读数、没按半句执行；唯一「已确认/推测分开」)
D 1 | no | na | yes(agent 早 1.9s 出发；结论落回原任务)
E 0 | no | na | yes(碎片只换 4–6 字回执；首个工具都在末段 ADD 之后)
E 1 | no | na | partial(结论全押后台 agent、整轮没回收)

## 57279cc1@10-11T15:42:32（2 段：ADD-frag + ADD；无噪声 ⇒ na）
A 0 | no | na | yes(自己读日志，39.5s 交付完整结论；无后台 agent)
A 1 | na | na | no  ❌限额死（整轮零工作）
B 0 | no | na | yes(唯一把半句「是不是因为最近在 VAD」问回去；结论带提交号)
B 1 | na | na | no  ❌限额死
C 0 | no | na | yes(agent 比末段语音早 0.3s；碎片顺手并进 agent 的检查项)
D 0 | no | na | yes(同构；额外提议把「忙时扣留过长」立成缺陷任务)
E 0 | no | na | yes(agent 早 0.8s；碎片只换「嗯，你接着说」；主动标出旁证局限)
E 1 | no | na | yes(碎片只换一句；结论与人假设相反——VAD 没问题)
（C-1/D-1 无文件，未跑）

## 99df08d8@10-12T01:24:07（8 段全 REMARK/NOISE）
A 0 | no | no | partial(唯一「评论→工具」：queue-REMARK→翻日志目录，不跑题；自认没现场数据)
A 1 | no | no | partial(靠 git 兜住环境确认；零语音侧日志，只给预判)
B 0 | no | no | yes(断言「队列行显示没及时清掉」，全程未读日志)
B 1 | no | no | yes(同款解释，收尾承认 cancel 只能靠服务端日志核对)
C 0 | no | no | yes ⚠️凭空造出「第二句丢失」并当主结论（语义缺陷）
C 1 | no | no | yes(判成「队列行没更新」，与 C-0 结论不一致)
D 0 | no | no | partial(唯一明确声明「分不出来」)
D 1 | no | no | yes(与 D-0 结论相反 —— 同类旁白没有稳定答案)
E 0 | no | no | yes(碎片规则把 8 段压成一句短确认；零工具零推测，唯一没去猜成因)
E 1 | no | no | yes(极简应答；唯一主动提出可选排查项但不执行)

## 99df08d8@10-12T01:26:18（开场 prompt 本身就是上一片段噪声的拼接；后 3 段 ADD/ASK ⇒ derailed na）
A 0 | no | na | partial(三段被在跑的 Bash 堵到 34.2s 才 turn-end 落地；后转任务板)
A 1 | yes | na | no  ❌限额死
B 0 | no | na | yes(10.5s 就交付真实 journal 结论：排队在中继层、投递只 6ms)
B 1 | yes | na | no  ❌限额死
C 0 | no | na | yes(9.2s 交付：等 2 分 07 秒、03:54:49 放行；对 ADD 无取消动作)
C 1 | yes | na | no  ❌限额死
D 0 | no | na | yes(开场核对最完整，含「没有丢句」；显式披露对「这个任务」的假设)
D 1 | yes | na | no  ❌限额死
E 0 | yes | na | no(答应「读日志核对」却一次没读，被 ADD-frag 拽到任务板)
E 1 | yes | na | no(唯一真去读了日志；结论停在「还没看到」，被 ADD 带走后再没回来)

## a175e6cd@10-14T18:23:50（DUP+REMARK+NOISE+ASK-superseded+ASK）
A 0 | no | no | yes ⚠️turn-end(8.0s) 投递晚于模型首次作答 ⇒ 白烧一个重复回合(12.1)
A 1 | no | no | yes ⚠️同型：空转追问(16.5)
B 0 | no | no | yes ⚠️同型(10.8)
B 1 | no | no | yes ⚠️同型(11.4)
C 0 | no | no | yes(5.6s 并进当前回合，只答一次；14.0 收掉)
C 1 | no | no | yes ⚠️把 REMARK 里的「用 DeepSeek 跑」记成事实，无人核对
D 0 | no | no | yes(唯一真的对外部会话动手：12.3 SendMessage 停止请求，并披露是推断)
D 1 | no | no | yes(明确拒绝凭猜测停别人会话；归因「我们自己的合并 hold」与 D-0 相反)
E 0 | no | no | yes(对 NOISE「哎。」压成「嗯，你接着说。」)
E 1 | no | no | yes(极简应答 + 单回合收掉 DUP)
共同代价：NOISE「哎。」在每一臂都白烧一个回合；被标 superseded 的 ASK 十次都占满一回合。

## af12cbaf@10-14T09:52:44（REDIRECT + REMARK×2 + ASK）
A 0 | no | no | yes ⚠️REDIRECT turn-end(34.0s) 才投，30s 任务已跑完；不知情下反问用户「表现怎么样」；改道后 10s 任务照跑
A 1 | na | na | no  ❌限额死
B 0 | no | no | yes(同 A 的 turn-end 34.8s；差别只是 ASK 挤进同一批，一段答完)
B 1 | na | na | no  ❌限额死
C 0 | no | no | yes(11.5s 投到工具边界，比 A/B 早约 23s；但命令没被打断；作答顺序错位)
C 1 | na | na | no  ❌限额死
D 0 | no | no | yes(逐句对账最干净：说清每句何时收到，拆开「送达≠气泡可见」)
D 1 | na | na | no  ❌限额死
E 0 | no | no | yes(唯一把「被Q了→被kill了」标成推断并给出验证路径 transcription.completed)
E 1 | no | no | yes(rep1 里唯一跑完的一次；对「看不见」只声明查不到原因)
⚠️ 20 份 digest 里 B/C/D/E 无一处 [ BG] —— hook 没把 30 秒 sleep 派后台（阈值规则未被执行）
