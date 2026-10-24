import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { I18nextProvider } from 'react-i18next';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { i18n } from '@/modules/i18n';
import DecisionQueue, { sampleAuditDecisions } from '@/modules/cockpit/DecisionQueue';
import type {
  InitiativeAuditDecision,
  InitiativeDecidePort,
  InitiativeQueueItem,
} from '@/modules/cockpit/cockpitView';

/**
 * The cockpit's 裁定队列 (M6 AC2).
 *
 * WHAT THIS FILE PROVES, against the rendered DOM and the decide seam:
 *
 *   - an escalation draws its TYPED options (id + label), its question and its evidence;
 *   - picking an option does not call `decide`; confirming the preview calls it EXACTLY once,
 *     with `by: human`, `kind: fact` and the chosen option id;
 *   - dismissing the preview leaves zero calls — 「未确认不调用」;
 *   - the spot-check group draws a deterministic fraction (the configured ratio, 1/5 here) of
 *     `kind ∈ {inference, llm}` ledger rows and never a `fact` row;
 *   - 「有异议」 produces one human decision call, carrying the objection note as its rationale.
 *
 * The decide port is a stub here: the criterion is about what the QUEUE asks for, and the
 * server's own criterion proves the transport pins the same provenance.
 */

const NOW = '2026-10-24T12:00:00.000Z';

const QUEUE_ITEM: InitiativeQueueItem = {
  attentionId: 'att_queue_one',
  initiative: 'cockpit-observation-wall',
  entity: 'initiative:cockpit-observation-wall@abc123',
  question: 'Should the initiative view own the queue, or link to the fleet UI?',
  options: [
    { id: 'own-it', label: 'Draw the queue in the cockpit' },
    { id: 'link-out', label: 'Link to the fleet UI' },
  ],
  evidence: ['decisions.jsonl@dec_1 — the fleet keeps the ledger', 'events.jsonl@evt_9'],
  projectId: 'quay-fleet',
  firstSeenAt: NOW,
};

const optionA: InitiativeQueueItem = {
  attentionId: 'att_queue_two',
  initiative: 'second-initiative',
  entity: 'initiative:second-initiative@def456',
  question: 'Ship the edge highlighting now?',
  options: [
    { id: 'yes', label: 'Yes' },
    { id: 'no', label: 'No' },
  ],
  evidence: [],
  projectId: 'quay-fleet',
  firstSeenAt: NOW,
};

/** Ten liaison self-decisions plus one human fact. Only the ten are eligible for the sample. */
function auditLedger(): InitiativeAuditDecision[] {
  const rows: InitiativeAuditDecision[] = [];
  for (let index = 0; index < 10; index += 1) {
    rows.push({
      initiative: 'cockpit-observation-wall',
      at: new Date(Date.parse(NOW) + index * 60_000).toISOString(),
      question: `Self-decision ${index}`,
      options: ['a', 'b'],
      chosen: 'a',
      rationale: `Liaison rationale ${index}`,
      by: 'liaison:claudecodeui',
      kind: 'inference',
      refs: [],
    });
  }
  rows.push({
    initiative: 'cockpit-observation-wall',
    at: NOW,
    question: 'A human fact',
    options: ['a'],
    chosen: 'a',
    rationale: 'Humans are not audited',
    by: 'human',
    kind: 'fact',
    refs: [],
  });
  return rows;
}

const okDecide: InitiativeDecidePort = vi.fn(async () => ({ ok: true } as const));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function renderQueue({
  items = [QUEUE_ITEM, optionA],
  audit = [],
  auditRatio = 1 / 5,
  decide = okDecide,
}: {
  items?: InitiativeQueueItem[];
  audit?: InitiativeAuditDecision[];
  auditRatio?: number;
  decide?: InitiativeDecidePort;
} = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <DecisionQueue items={items} audit={audit} auditRatio={auditRatio} decide={decide} />
    </I18nextProvider>,
  );
}

describe('the decision queue', () => {
  it('renders each escalation with its question, typed options and evidence', () => {
    renderQueue();

    const rows = screen.getAllByTestId('decision-queue-item');
    expect(rows).toHaveLength(2);
    const first = rows[0]!;
    expect(within(first).getByTestId('decision-question').textContent).toBe(QUEUE_ITEM.question);
    expect(within(first).getByTestId('decision-initiative').textContent).toContain(
      'cockpit-observation-wall',
    );
    const options = within(first).getAllByTestId('decision-option');
    expect(options.map((option) => option.getAttribute('data-option-id'))).toEqual([
      'own-it',
      'link-out',
    ]);
    expect(options.map((option) => option.textContent)).toEqual([
      'Draw the queue in the cockpit',
      'Link to the fleet UI',
    ]);
    const evidence = within(first).getAllByTestId('decision-evidence');
    expect(evidence[0]!.textContent).toContain('decisions.jsonl@dec_1');
  });

  it('does not call decide until the preview is confirmed, then calls it exactly once with human/fact', async () => {
    const decide = vi.fn<InitiativeDecidePort>(async () => ({ ok: true } as const));
    renderQueue({ decide });

    const first = screen.getAllByTestId('decision-queue-item')[0]!;
    fireEvent.click(within(first).getAllByTestId('decision-option')[1]!);
    // Picking an option is not a ruling: the preview is open and nothing has left.
    expect(decide).not.toHaveBeenCalled();
    const preview = screen.getByTestId('decision-preview');
    expect(preview.getAttribute('data-chosen')).toBe('link-out');

    fireEvent.change(within(preview).getByTestId('decision-rationale'), {
      target: { value: 'The cockpit already owns the human surface.' },
    });
    fireEvent.click(within(preview).getByTestId('decision-confirm'));

    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    expect(decide).toHaveBeenCalledWith({
      initiative: 'cockpit-observation-wall',
      question: QUEUE_ITEM.question,
      options: QUEUE_ITEM.options,
      chosen: 'link-out',
      rationale: 'The cockpit already owns the human surface.',
      refs: QUEUE_ITEM.evidence,
      by: 'human',
      kind: 'fact',
    });
    // The decided item leaves the queue rather than silently staying as if nothing happened.
    await waitFor(() =>
      expect(screen.getAllByTestId('decision-queue-item')).toHaveLength(1),
    );
  });

  it('leaves decide uncalled when the preview is dismissed', () => {
    const decide = vi.fn<InitiativeDecidePort>(async () => ({ ok: true } as const));
    renderQueue({ decide });

    const first = screen.getAllByTestId('decision-queue-item')[0]!;
    fireEvent.click(within(first).getAllByTestId('decision-option')[0]!);
    fireEvent.change(screen.getByTestId('decision-rationale'), {
      target: { value: 'Never mind' },
    });
    fireEvent.click(screen.getByTestId('decision-cancel'));

    expect(decide).not.toHaveBeenCalled();
    expect(screen.queryByTestId('decision-preview')).toBeNull();
  });

  it('samples inference/llm rows by the configured ratio and never a fact row', () => {
    const audit = auditLedger();
    renderQueue({ audit, auditRatio: 1 / 5 });

    // The helper states the arithmetic independently of the DOM…
    expect(sampleAuditDecisions(audit, 1 / 5)).toHaveLength(2);
    expect(sampleAuditDecisions(audit, 1 / 5).every((row) => row.kind === 'inference')).toBe(true);

    // …and the rendered group draws exactly those two, all with the liaison provenance.
    const group = screen.getByTestId('decision-audit-group');
    expect(group.getAttribute('data-sampled')).toBe('2');
    const rows = screen.getAllByTestId('decision-audit-item');
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.getAttribute('data-audit-kind') === 'inference')).toBe(true);
    expect(rows.every((row) => row.getAttribute('data-audit-by') === 'liaison:claudecodeui')).toBe(
      true,
    );
    // A ratio is a fraction, not a sample count: 1/2 draws five of the ten.
    expect(sampleAuditDecisions(audit, 0.5)).toHaveLength(5);
  });

  it('records an objection as one human decision call carrying the note', async () => {
    const decide = vi.fn<InitiativeDecidePort>(async () => ({ ok: true } as const));
    const audit = auditLedger();
    renderQueue({ audit, auditRatio: 1 / 5, decide });

    const row = screen.getAllByTestId('decision-audit-item')[0]!;
    fireEvent.change(within(row).getByTestId('decision-audit-note'), {
      target: { value: 'This layout was never approved by a person.' },
    });
    fireEvent.click(within(row).getByTestId('decision-audit-object'));

    await waitFor(() => expect(decide).toHaveBeenCalledTimes(1));
    const request = decide.mock.calls[0]![0];
    expect(request.by).toBe('human');
    expect(request.kind).toBe('fact');
    expect(request.initiative).toBe('cockpit-observation-wall');
    expect(request.question).toBe(sampleAuditDecisions(audit, 1 / 5)[0]!.question);
    expect(request.chosen).toBe('a');
    expect(request.rationale).toBe('This layout was never approved by a person.');

    // One objection per row: the sampled row leaves the group after the ruling.
    await waitFor(() => expect(screen.getAllByTestId('decision-audit-item')).toHaveLength(1));
  });

  it('agreeing writes no decision (the liaison row already stands)', async () => {
    const decide = vi.fn<InitiativeDecidePort>(async () => ({ ok: true } as const));
    renderQueue({ audit: auditLedger(), auditRatio: 1 / 5, decide });

    const row = screen.getAllByTestId('decision-audit-item')[0]!;
    fireEvent.click(within(row).getByTestId('decision-audit-agree'));

    await waitFor(() => expect(screen.getAllByTestId('decision-audit-item')).toHaveLength(1));
    expect(decide).not.toHaveBeenCalled();
  });
});
