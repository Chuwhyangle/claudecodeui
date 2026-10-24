/**
 * The coarse utterance classifier — a PURE function, v0.
 *
 * It answers one question about a phrase a person typed or spoke: which of the
 * ten delegation-ladder categories it belongs to. The answer is a label on the
 * `utterance` event (`data.class`), never a decision: nothing in the UI reads it,
 * and no permission, route or send depends on it.
 *
 * WHY RULES, FOR NOW. The first version has to be auditable: the ladder's first
 * evidence must be reproducible from the same phrase list the probe used, and a
 * rule table can be read and argued with. A learned classifier arrives only after
 * the labels themselves have ground truth (the `shadow.prediction.outcome`
 * records this task starts collecting).
 *
 * ORDER IS LOAD-BEARING. A phrase can mention several things at once
 * (「用 MCP 浏览器检查是否已经落地可用」), so the rules are evaluated from the
 * most specific ACT to the most general: a browser check outranks the landing
 * check it is performing, a release outranks the build it runs, and an explicit
 * task-authoring verb outranks the progress check it contains. The last rule is
 * the fallback, `discussion`.
 *
 * Consumers: `context-events.module.ts` (writes `data.class` and feeds the
 * shadow predictor), and `tests/utterance-classifier.test.ts`.
 */

/** The ten categories of the delegation ladder's first probe. */
export const UTTERANCE_CLASSES = [
  'task-authoring',
  'build-restart',
  'landing-verification',
  'progress-check',
  'browser-verification',
  'release',
  'approval',
  'session-collaboration',
  'diagnosis',
  'discussion',
] as const;

/** One class label. `discussion` doubles as "other" in the v0 probe. */
export type UtteranceClass = (typeof UTTERANCE_CLASSES)[number];

/** The classification result; `rule` names the pattern that claimed the phrase. */
export type UtteranceClassification = {
  class: UtteranceClass;
  rule: string;
};

type Rule = { class: UtteranceClass; name: string; pattern: RegExp };

/**
 * The rule table, in evaluation order.
 *
 * Each pattern favours the verb a person uses for the ACT over a noun that can
 * appear in any sentence: 「检查是否已经落地可用」 is a landing check even though
 * it also contains 检查, and 「发布前先构建」 is a release turn even though it
 * also contains 构建.
 */
const RULES: readonly Rule[] = [
  {
    class: 'browser-verification',
    name: 'browser-act',
    pattern: /(mcp\s*浏览器|浏览器.{0,16}(访问|打开|点|看|验证|截图)|playwright|\bbrowser\b|截图|screenshot|用浏览器)/iu,
  },
  {
    class: 'release',
    name: 'release-verb',
    pattern: /(发布|发版|上线|\brelease\b|npm\s+publish|打包发|推送到\s*npm)/iu,
  },
  {
    class: 'build-restart',
    name: 'build-or-restart',
    pattern: /(\bbuild\b|构建|编译|安全重启|重启|restart|rebuild|重新构建)/iu,
  },
  {
    class: 'landing-verification',
    name: 'landing-or-availability',
    pattern: /(落地|可用性?核验|是否.{0,12}(落地|可用|生效)|已经.{0,8}(落地|可用|生效)|\bverify\b.{0,20}\b(landed|available)\b|\blanded\b|端到端核验|可用核验)/iu,
  },
  {
    class: 'task-authoring',
    name: 'task-authoring-verb',
    pattern: /(建.{0,24}任务|立.{0,6}任务|创建.{0,12}任务|提.{0,6}任务|开.{0,6}任务|拆.{0,8}任务|写.{0,6}任务|(task|ticket).{0,20}(create|file|add)|\bcreate\b.{0,20}\btasks?\b)/iu,
  },
  {
    class: 'session-collaboration',
    name: 'session-collaboration',
    pattern: /(跨会话|会话协作|和.{0,12}会话|让.{0,12}会话|另一个.{0,6}会话|(转发|转给|发到).{0,10}会话|通知.{0,8}(会话|agent)|\bpeer\b|lobby|relay|桥接.{0,6}会话)/iu,
  },
  {
    class: 'diagnosis',
    name: 'diagnosis-verb',
    pattern: /(为什么|为啥|排查|诊断|报错|错误原因|失败原因|怎么.{0,6}(失败|坏的|红的|挂了)|定位.{0,8}(问题|原因|失败)|\bdebug\b|\bdiagnos|root\s*cause|red\s*了|红了)/iu,
  },
  {
    class: 'progress-check',
    name: 'progress-question',
    pattern: /(进展|进度|到哪(了|一步)?|状态如何|现在怎么样|还在跑|跑完|做完了吗|做完了没|检查进展|\bstatus\b|进度如何)/iu,
  },
  {
    class: 'approval',
    name: 'approval',
    // A short standalone assent, or an explicit approval phrase in a longer
    // sentence. Anchoring the one-word arm keeps 「好的会话」 from becoming an
    // approval when it is really a session reference.
    pattern: /^(好|好的|好滴|行|可以|同意|批准|继续|推进|做吧|开始吧|按这个来|就这样|没问题|go|ok|yes|sure)[。.!！\s]*$|^(好|好的|行|可以|同意|批准)[，,]\s*(继续|推进|做吧|开始吧|按这个)|(同意|批准|继续推进|按计划推进|按这个方案)/iu,
  },
];

/**
 * Classifies one phrase. Whitespace-only text is `discussion` (the honest label
 * for "there is nothing to classify"), never a guessed act.
 */
export function classifyUtterance(text: string): UtteranceClassification {
  const trimmed = text.trim();
  if (trimmed === '') return { class: 'discussion', rule: 'empty' };
  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) return { class: rule.class, rule: rule.name };
  }
  return { class: 'discussion', rule: 'fallback' };
}

/** The ladder level this build assigns a category — the v0 baseline, hard-coded by design. */
export type LadderLevel = 'you-do' | 'system-suggests';

/**
 * The baseline ladder table.
 *
 * These are NOT promotion decisions: they are the level the first report prints
 * next to each category so the table has a fixed reference row. The categories a
 * person can hand over with no loss (progress, landing/availability checks,
 * approval bookkeeping) start as `system-suggests`; the categories whose output
 * is a judgement or an external action (authoring, building, releasing,
 * browser verification, collaboration, diagnosis) start as `you-do`.
 */
export const LADDER_BASELINE: Readonly<Record<UtteranceClass, LadderLevel>> = {
  'task-authoring': 'you-do',
  'build-restart': 'you-do',
  'landing-verification': 'system-suggests',
  'progress-check': 'system-suggests',
  'browser-verification': 'you-do',
  release: 'you-do',
  approval: 'system-suggests',
  'session-collaboration': 'you-do',
  diagnosis: 'you-do',
  discussion: 'system-suggests',
};
