import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/shared/utils';
import type {
  InitiativeAuditDecision,
  InitiativeCounterVoicePort,
  InitiativeCounterVoiceReading,
  InitiativeDecidePort,
  InitiativeQueueItem,
} from '@/modules/cockpit/cockpitView';

/**
 * The cockpit's 裁定队列: what a person must decide, plus a sample of what the liaisons
 * decided on their own.
 *
 * TWO GROUPS, TWO DIFFERENT QUESTIONS. The first group is a REPORT — an escalation the fleet
 * wrote into the `initiative-decision` attention category, carrying typed options. The person
 * picks one, and nothing is recorded until the preview is confirmed; that is the whole reason
 * the preview exists (「预览确认后执行」), and a click on an option is not a decision.
 *
 * The second group is an AUDIT. Decisions with `kind ∈ {inference, llm}` were made by a
 * liaison session, not by a person. A fraction of them (the server's `auditRatio`, shipped
 * 1/5) is drawn in front of the person to agree with or object to. An objection is itself a
 * human decision — it goes through the same `decide` call with `by: human`, `kind: fact` — so
 * the ledger keeps 「联络这么定了」 and 「人不同意，理由是…」 as two facts, in order.
 *
 * The sampling is deterministic (every `1/ratio`-th entry, per initiative), so the same
 * ledger always draws the same spot-check set; a random sample would make 「上次看到的那条」
 * unreferenceable.
 *
 * Consumers: `CockpitPage` (rendered beside the initiative rows).
 */

/** Every string a ledger may carry as an option id; the audit group has no labels. */
function optionsForLabels(ids: readonly string[]): { id: string; label: string }[] {
  return ids.map((id) => ({ id, label: id }));
}

/**
 * The spot-check sample: every `1/ratio`-th self-decision, counted per initiative.
 *
 * A ratio outside (0, 1] reads as the shipped 1/5. Counting per initiative keeps a talkative
 * liaison from crowding every other initiative out of the sample — the audit is about each
 * project's own self-decisions.
 */
export function sampleAuditDecisions(
  decisions: readonly InitiativeAuditDecision[],
  ratio: number,
): InitiativeAuditDecision[] {
  const fraction = Number.isFinite(ratio) && ratio > 0 && ratio <= 1 ? ratio : 0.2;
  const counters = new Map<string, number>();
  const sampled: InitiativeAuditDecision[] = [];
  for (const decision of decisions) {
    const index = counters.get(decision.initiative) ?? 0;
    counters.set(decision.initiative, index + 1);
    // True exactly when the cumulative fraction crosses an integer at this entry.
    if (Math.floor((index + 1) * fraction) > Math.floor(index * fraction)) {
      sampled.push(decision);
    }
  }
  return sampled;
}

/** One pending item plus the option the person is considering. */
type Draft = {
  item: InitiativeQueueItem;
  optionId: string;
};

/** One card's 「反方」 slot: still being generated, or the server's answer. */
type CounterVoiceEntry = { state: 'loading' } | InitiativeCounterVoiceReading;

export type DecisionQueueProps = {
  items: readonly InitiativeQueueItem[];
  /** Every `kind ∈ {inference, llm}` decision the server relayed; the sample is drawn here. */
  audit: readonly InitiativeAuditDecision[];
  /** The server's configured spot-check fraction. */
  auditRatio: number;
  /** The only write: one human ruling, recorded through the fleet's own decide verb. */
  decide: InitiativeDecidePort;
  /**
   * The 「反方」 seam. Asked once per visible card (the server generates on the first ask and
   * caches), never awaited before a ruling; an unavailable answer is drawn as its reason.
   */
  counterVoice: InitiativeCounterVoicePort;
};

/** The decision queue and its spot-check group. */
export default function DecisionQueue({
  items,
  audit,
  auditRatio,
  decide,
  counterVoice,
}: DecisionQueueProps) {
  const { t } = useTranslation();
  // The item whose preview is open, and the option the person picked. `null` means nothing is
  // being confirmed — the list alone is drawn, and no ruling can leave by accident.
  const [draft, setDraft] = useState<Draft | null>(null);
  // The preview's rationale. It lives in the preview (not the row) so abandoning the preview
  // abandons the words too; an empty rationale cannot be confirmed.
  const [rationale, setRationale] = useState('');
  // True while a decide request is in flight: the confirm button must not fire twice.
  const [pending, setPending] = useState(false);
  // The last ruling's outcome, shown beside the queue. `null` until something is decided.
  const [notice, setNotice] = useState<{ kind: 'done' | 'refused'; text: string } | null>(null);
  // The ids already ruled on, so a decided item leaves the queue instead of reappearing as if
  // nothing happened (the server's next read is what would normally drop it; this keeps the
  // current render honest while that read is in flight).
  const [ruled, setRuled] = useState<ReadonlySet<string>>(() => new Set());
  // Each audit row's objection note, keyed by its ledger address. Agreeing needs no note; an
  // objection's note is what makes the human decision explain itself.
  const [objectionNotes, setObjectionNotes] = useState<Record<string, string>>({});
  // Each queue card's 「反方」, keyed by attentionId. `loading` is its own state so an expanded
  // card can say work is in flight rather than draw an empty body; `unavailable` carries the
  // server's reason and leaves the ruling untouched.
  const [counterVoices, setCounterVoices] = useState<Record<string, CounterVoiceEntry>>({});
  // The cards whose 「反方」 body is open. Default collapsed: the entry is an offer, not a wall.
  const [openCounterVoices, setOpenCounterVoices] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // 「已看反方」 per card. When ticked, the ruling's rationale carries the marker, so the
  // decision ledger can tell 「看过反方后仍然这么裁」 from a ruling that never opened it.
  const [seenCounterVoices, setSeenCounterVoices] = useState<Record<string, boolean>>({});
  // The ids already asked for. A ref, not state: re-reading it must neither render nor restart
  // the request, and a card that leaves and returns keeps its one generated answer.
  const counterVoiceRequested = useRef<Set<string>>(new Set());

  const sampledAudit = useMemo(
    () => sampleAuditDecisions(audit, auditRatio),
    [audit, auditRatio],
  );

  const visibleItems = useMemo(
    () => items.filter((item) => !ruled.has(item.attentionId)),
    [items, ruled],
  );
  const visibleAudit = sampledAudit.filter(
    (decision) => !ruled.has(auditKey(decision)),
  );

  // ASK ON FIRST DISPLAY, NOT ON FIRST CLICK. The server generates from a fresh context and
  // caches per item; starting the ask when the card appears means the body is usually ready by
  // the time someone opens it. The ask is never awaited here, so no ruling waits for a model.
  useEffect(() => {
    for (const item of visibleItems) {
      if (counterVoiceRequested.current.has(item.attentionId)) continue;
      counterVoiceRequested.current.add(item.attentionId);
      setCounterVoices((previous) => ({
        ...previous,
        [item.attentionId]: { state: 'loading' },
      }));
      void counterVoice(item.attentionId)
        .then((reading) => {
          setCounterVoices((previous) => ({ ...previous, [item.attentionId]: reading }));
        })
        .catch((error: unknown) => {
          setCounterVoices((previous) => ({
            ...previous,
            [item.attentionId]: {
              state: 'unavailable',
              kind: 'none',
              reason: `未生成：${error instanceof Error ? error.message : 'request failed'}`,
            },
          }));
        });
    }
  }, [counterVoice, visibleItems]);

  const toggleCounterVoice = useCallback((attentionId: string) => {
    setOpenCounterVoices((previous) => {
      const next = new Set(previous);
      if (next.has(attentionId)) {
        next.delete(attentionId);
      } else {
        next.add(attentionId);
      }
      return next;
    });
  }, []);

  const openPreview = useCallback((item: InitiativeQueueItem, optionId: string) => {
    setDraft({ item, optionId });
    setRationale('');
    // A fresh preview starts with no claim about having read the counter-voice.
    setSeenCounterVoices((previous) => ({ ...previous, [item.attentionId]: false }));
    setNotice(null);
  }, []);

  const confirm = useCallback(async () => {
    if (draft === null || pending) return;
    const trimmed = rationale.trim();
    if (trimmed === '') return;
    setPending(true);
    try {
      // 「已看反方」 is recorded IN the rationale rather than beside it: the fleet's ledger row
      // carries one sentence, and the marker travelling with it is what makes the claim
      // legible after the fact.
      const seenMarker =
        seenCounterVoices[draft.item.attentionId] === true
          ? ` ${t('cockpit.counterVoiceSeenMarker')}`
          : '';
      const outcome = await decide({
        initiative: draft.item.initiative,
        question: draft.item.question,
        options: draft.item.options,
        chosen: draft.optionId,
        rationale: `${trimmed}${seenMarker}`,
        refs: draft.item.evidence,
        by: 'human',
        kind: 'fact',
      });
      if (outcome.ok) {
        setRuled((previous) => new Set(previous).add(draft.item.attentionId));
        setDraft(null);
        setRationale('');
        setNotice({ kind: 'done', text: t('cockpit.decisionDone') });
      } else {
        setNotice({
          kind: 'refused',
          text: `${t('cockpit.decisionFailed')} ${outcome.reason}`,
        });
      }
    } catch (error) {
      // A request that never reached the server is still a refusal the person must see: an
      // unhandled rejection here would leave the preview open with no reading at all.
      setNotice({
        kind: 'refused',
        text: `${t('cockpit.decisionFailed')} ${error instanceof Error ? error.message : 'request failed'}`,
      });
    } finally {
      setPending(false);
    }
  }, [decide, draft, pending, rationale, seenCounterVoices, t]);

  const ruleAudit = useCallback(
    async (decision: InitiativeAuditDecision, objection: boolean) => {
      if (pending) return;
      const key = auditKey(decision);
      if (!objection) {
        // Agreeing records nothing in the ledger: the liaison's decision already stands, and
        // inventing a second "yes" row for every sample would add noise, not provenance.
        setRuled((previous) => new Set(previous).add(key));
        setNotice({ kind: 'done', text: t('cockpit.decisionAuditAgreed') });
        return;
      }
      const note = (objectionNotes[key] ?? '').trim();
      setPending(true);
      try {
        const outcome = await decide({
          initiative: decision.initiative,
          question: decision.question,
          options: optionsForLabels(decision.options),
          chosen: decision.chosen,
          rationale: note === '' ? t('cockpit.decisionAuditObjectionDefault') : note,
          refs: decision.refs,
          by: 'human',
          kind: 'fact',
        });
        if (outcome.ok) {
          setRuled((previous) => new Set(previous).add(key));
          setNotice({ kind: 'done', text: t('cockpit.decisionAuditObjected') });
        } else {
          setNotice({
            kind: 'refused',
            text: `${t('cockpit.decisionFailed')} ${outcome.reason}`,
          });
        }
      } catch (error) {
        setNotice({
          kind: 'refused',
          text: `${t('cockpit.decisionFailed')} ${error instanceof Error ? error.message : 'request failed'}`,
        });
      } finally {
        setPending(false);
      }
    },
    [decide, objectionNotes, pending, t],
  );

  /**
   * One card's counter-voice: a collapsed 「反方」 entry, and when opened the three segments —
   * what the leaning direction ignores, the strongest counter-example, and what would falsify
   * it — or the honest reason none was produced. Nothing here gates the option buttons beside
   * it: the ruling is the person's, and the counter-voice is an offer.
   */
  const renderCounterVoice = (item: InitiativeQueueItem) => {
    const entry = counterVoices[item.attentionId];
    const open = openCounterVoices.has(item.attentionId);
    return (
      <div className="mt-1" data-testid="decision-counter-voice" data-attention-id={item.attentionId}>
        <button
          type="button"
          onClick={() => toggleCounterVoice(item.attentionId)}
          aria-expanded={open}
          className="rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent"
          data-testid="decision-counter-voice-toggle"
        >
          {open ? t('cockpit.counterVoiceCollapse') : t('cockpit.counterVoice')}
        </button>
        {open && (
          <div
            className="mt-1 rounded border border-border/40 bg-muted/30 p-2"
            data-testid="decision-counter-voice-body"
            data-kind={entry !== undefined && entry.state === 'ready' ? entry.kind : 'none'}
          >
            {entry === undefined || entry.state === 'loading' ? (
              <p className="text-muted-foreground" data-testid="decision-counter-voice-loading">
                {t('cockpit.counterVoiceLoading')}
              </p>
            ) : entry.state === 'unavailable' ? (
              <p
                className="text-amber-700 dark:text-amber-300"
                data-testid="decision-counter-voice-unavailable"
              >
                {entry.reason}
              </p>
            ) : (
              <div className="space-y-1">
                <p
                  className="text-[11px] text-muted-foreground"
                  data-testid="decision-counter-voice-advisory"
                >
                  {entry.advisory} · {entry.kind}
                </p>
                <div data-testid="counter-voice-ignored">
                  <p className="font-medium text-foreground">{t('cockpit.counterVoiceIgnored')}</p>
                  <ul className="list-disc pl-4 text-muted-foreground">
                    {entry.ignored.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </div>
                <div data-testid="counter-voice-strongest">
                  <p className="font-medium text-foreground">{t('cockpit.counterVoiceStrongest')}</p>
                  <p className="text-muted-foreground">{entry.strongestCounter}</p>
                </div>
                <div data-testid="counter-voice-falsifier">
                  <p className="font-medium text-foreground">{t('cockpit.counterVoiceFalsifier')}</p>
                  <p className="text-muted-foreground">{entry.falsifier}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-col gap-3 overflow-y-auto p-3" data-testid="decision-queue">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('cockpit.decisionQueue')}
        </h3>
        {visibleItems.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="decision-queue-empty">
            {t('cockpit.decisionQueueEmpty')}
          </p>
        ) : (
          <ul className="mt-1 space-y-2" data-testid="decision-queue-items">
            {visibleItems.map((item) => (
              <li
                key={item.attentionId}
                className="rounded border border-border/60 bg-background p-2 text-xs"
                data-testid="decision-queue-item"
                data-attention-id={item.attentionId}
                data-initiative={item.initiative}
              >
                <p className="font-medium text-foreground" data-testid="decision-question">
                  {item.question}
                </p>
                <p className="text-muted-foreground" data-testid="decision-initiative">
                  {t('cockpit.decisionInitiative', { slug: item.initiative })}
                </p>
                <div className="mt-1 flex flex-wrap gap-1" data-testid="decision-options">
                  {item.options.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => openPreview(item, option.id)}
                      aria-pressed={draft?.item.attentionId === item.attentionId && draft.optionId === option.id}
                      className={cn(
                        'rounded border px-2 py-0.5',
                        draft?.item.attentionId === item.attentionId && draft.optionId === option.id
                          ? 'border-foreground bg-foreground text-background'
                          : 'border-border/60 text-foreground hover:bg-accent',
                      )}
                      data-testid="decision-option"
                      data-option-id={option.id}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
                {item.evidence.length > 0 && (
                  <ul className="mt-1 space-y-0.5 text-muted-foreground" data-testid="decision-evidence">
                    {item.evidence.map((evidence) => (
                      <li key={evidence} className="truncate" title={evidence}>
                        {evidence}
                      </li>
                    ))}
                  </ul>
                )}
                {renderCounterVoice(item)}
              </li>
            ))}
          </ul>
        )}

        {draft !== null && (
          <div
            className="mt-2 rounded border border-foreground/30 bg-muted/40 p-2 text-xs"
            data-testid="decision-preview"
            data-chosen={draft.optionId}
            data-initiative={draft.item.initiative}
          >
            <p className="font-medium text-foreground" data-testid="decision-preview-question">
              {draft.item.question}
            </p>
            <p className="text-muted-foreground" data-testid="decision-preview-choice">
              {t('cockpit.decisionPreviewChoice', {
                choice:
                  draft.item.options.find((option) => option.id === draft.optionId)?.label ??
                  draft.optionId,
              })}
            </p>
            <label className="mt-1 block text-[11px] text-muted-foreground">
              {t('cockpit.decisionRationale')}
              <textarea
                value={rationale}
                onChange={(event) => setRationale(event.target.value)}
                placeholder={t('cockpit.decisionRationalePlaceholder')}
                className="mt-0.5 w-full rounded border border-border/60 bg-background p-1 text-xs text-foreground"
                data-testid="decision-rationale"
              />
            </label>
            <label className="mt-1 flex items-center gap-1 text-[11px] text-muted-foreground">
              <input
                type="checkbox"
                checked={seenCounterVoices[draft.item.attentionId] === true}
                onChange={(event) =>
                  setSeenCounterVoices((previous) => ({
                    ...previous,
                    [draft.item.attentionId]: event.target.checked,
                  }))
                }
                data-testid="decision-counter-seen"
              />
              {t('cockpit.counterVoiceSeen')}
            </label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => void confirm()}
                disabled={pending || rationale.trim() === ''}
                className="rounded bg-foreground px-2 py-0.5 text-[11px] text-background disabled:opacity-50"
                data-testid="decision-confirm"
              >
                {t('cockpit.decisionConfirm')}
              </button>
              <button
                type="button"
                onClick={() => {
                  setDraft(null);
                  setRationale('');
                }}
                className="rounded border border-border/60 px-2 py-0.5 text-[11px]"
                data-testid="decision-cancel"
              >
                {t('cockpit.decisionCancel')}
              </button>
            </div>
          </div>
        )}
      </div>

      <div data-testid="decision-audit-group" data-sampled={visibleAudit.length} data-ratio={auditRatio}>
        <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t('cockpit.decisionAuditGroup')}
        </h3>
        {visibleAudit.length === 0 ? (
          <p className="mt-1 text-xs text-muted-foreground" data-testid="decision-audit-empty">
            {t('cockpit.decisionAuditEmpty')}
          </p>
        ) : (
          <ul className="mt-1 space-y-2">
            {visibleAudit.map((decision) => {
              const key = auditKey(decision);
              return (
                <li
                  key={key}
                  className="rounded border border-border/60 bg-background p-2 text-xs"
                  data-testid="decision-audit-item"
                  data-audit-initiative={decision.initiative}
                  data-audit-kind={decision.kind}
                  data-audit-by={decision.by}
                >
                  <p className="font-medium text-foreground" data-testid="decision-audit-question">
                    {decision.question}
                  </p>
                  <p className="text-muted-foreground" data-testid="decision-audit-choice">
                    {t('cockpit.decisionAuditChoice', {
                      chosen: decision.chosen,
                      by: decision.by,
                      kind: decision.kind,
                    })}
                  </p>
                  {decision.rationale !== '' && (
                    <p className="text-muted-foreground" data-testid="decision-audit-rationale">
                      {decision.rationale}
                    </p>
                  )}
                  <textarea
                    value={objectionNotes[key] ?? ''}
                    onChange={(event) =>
                      setObjectionNotes((previous) => ({ ...previous, [key]: event.target.value }))
                    }
                    placeholder={t('cockpit.decisionAuditNotePlaceholder')}
                    aria-label={t('cockpit.decisionAuditNote')}
                    className="mt-1 w-full rounded border border-border/60 bg-background p-1 text-xs text-foreground"
                    data-testid="decision-audit-note"
                  />
                  <div className="mt-1 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void ruleAudit(decision, false)}
                      disabled={pending}
                      className="rounded border border-border/60 px-2 py-0.5 text-[11px] disabled:opacity-50"
                      data-testid="decision-audit-agree"
                    >
                      {t('cockpit.decisionAuditAgree')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void ruleAudit(decision, true)}
                      disabled={pending}
                      className="rounded border border-amber-500/60 px-2 py-0.5 text-[11px] text-amber-800 disabled:opacity-50 dark:text-amber-200"
                      data-testid="decision-audit-object"
                    >
                      {t('cockpit.decisionAuditObject')}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {notice !== null && (
        <p
          role="status"
          className={
            notice.kind === 'refused'
              ? 'text-xs text-amber-700 dark:text-amber-300'
              : 'text-xs text-muted-foreground'
          }
          data-testid="decision-notice"
          data-notice-kind={notice.kind}
        >
          {notice.text}
        </p>
      )}
    </div>
  );
}

/** A stable ledger address for one self-decision: initiative + timestamp + question. */
function auditKey(decision: InitiativeAuditDecision): string {
  return `${decision.initiative}|${decision.at}|${decision.question}`;
}
