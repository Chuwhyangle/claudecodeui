import assert from 'node:assert/strict';

import { act, fireEvent, render, screen } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeEach, test, vi } from 'vitest';

import type { Goal, GoalAc, GoalDetail, GoalEvidence, GoalRound } from '@/shared/goalLoopType';
import enCommon from '@/modules/i18n/locales/en/common.json';
import { GoalPanel } from '@/modules/goals';

/**
 * The Goals tab, exercised through its two seams: the REST helpers (mocked) and
 * the panel's own props. The cases pin what the sibling scenario script depends
 * on — the `data-testid` contract — plus the readings that are easy to get
 * wrong: a badge that must print the status verbatim, criterion dots coloured by
 * evidence rather than by AC status, and a poll that must run ONLY while a goal
 * is active and the tab is on screen.
 */

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    goals: {
      list: vi.fn(),
      detail: vi.fn(),
      create: vi.fn(),
      addAc: vi.fn(),
      activate: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      abandon: vi.fn(),
      runRound: vi.fn(),
    },
  },
}));

vi.mock('@/shared/api', () => ({
  api: apiMock,
  // The real one throws on a failed response; every case here either answers a
  // success envelope or rejects the helper's own promise, so echoing the body is
  // enough and keeps the envelope unwrapping under test.
  readApiJson: async (response: { json: () => Promise<unknown> }) => response.json(),
}));

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  resources: { en: { common: enCommon } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

/** One success envelope, shaped as `readApiJson` reads it. */
function jsonOk(data: unknown) {
  return { ok: true, status: 200, json: async () => ({ success: true, data }) };
}

const GOAL_ID = 'goal-1';

function makeGoal(patch: Partial<Goal> = {}): Goal {
  return {
    id: GOAL_ID,
    userId: 7,
    projectId: 'proj-1',
    sessionId: null,
    worktreePath: null,
    branch: null,
    title: 'Ship the goal loop',
    objective: 'The loop runs a criterion and records evidence.',
    exitConditions: [],
    status: 'draft',
    budget: { maxRounds: 20, maxWallClockMs: 7_200_000, maxNoProgress: 3 },
    createdAt: '2026-11-11T00:00:00.000Z',
    activatedAt: null,
    achievedAt: null,
    ...patch,
  };
}

function makeAc(id: string, patch: Partial<GoalAc> = {}): GoalAc {
  return {
    id,
    goalId: GOAL_ID,
    title: `Criterion ${id}`,
    criterion: `node --test ${id}.test.mjs`,
    expect: 'it fails while the feature is missing',
    status: 'active',
    createdAt: '2026-11-11T00:00:00.000Z',
    ...patch,
  };
}

function makeRound(seq: number, outcome: GoalRound['outcome'], endedAt: string | null = '2026-11-11T00:01:00.000Z'): GoalRound {
  return {
    id: `${GOAL_ID}-round-${seq}`,
    goalId: GOAL_ID,
    seq,
    startedAt: '2026-11-11T00:00:30.000Z',
    endedAt,
    outcome,
    diffDigest: null,
    promptDigest: null,
  };
}

function makeEvidence(acId: string, verdict: GoalEvidence['verdict']): GoalEvidence {
  return {
    id: `${acId}-evidence`,
    roundId: `${GOAL_ID}-round-1`,
    acId,
    exitCode: verdict === 'pass' ? 0 : 1,
    timedOut: false,
    outputDigest: 'digest',
    outputExcerpt: verdict === 'pass' ? 'ok' : 'AssertionError: expected true',
    verdict,
    at: '2026-11-11T00:01:00.000Z',
  };
}

/** The list read answers `goals`; each goal's detail read answers `details[goalId]`. */
function stubLoad(goals: Goal[], details: Record<string, GoalDetail> = {}) {
  apiMock.goals.list.mockResolvedValue(jsonOk(goals));
  apiMock.goals.detail.mockImplementation(async (goalId: string) =>
    jsonOk(details[goalId] ?? { goal: goals[0], acs: [], rounds: [], evidence: [] }),
  );
}

const PANEL_PROPS = { projectId: 'proj-1', projectPath: '/repo/proj-1', isActive: true };

beforeEach(() => {
  for (const fn of Object.values(apiMock.goals)) {
    fn.mockReset();
  }
});

afterEach(() => {
  vi.useRealTimers();
});

/** Renders the panel and waits for the loaded branch; returns the render result for rerenders. */
async function renderLoaded(goals: Goal[], details: Record<string, GoalDetail> = {}) {
  stubLoad(goals, details);
  const rendered = render(<GoalPanel {...PANEL_PROPS} />);
  await screen.findByTestId('goal-panel-loaded');
  return rendered;
}

/** Fills the create form's required fields, leaving the three budget limits untouched. */
function fillRequiredFields() {
  fireEvent.change(screen.getByTestId('goal-create-title'), { target: { value: 'Ship the goal loop' } });
  fireEvent.change(screen.getByTestId('goal-create-objective'), { target: { value: 'The loop records evidence.' } });
  fireEvent.change(screen.getByTestId('goal-create-ac-title-0'), { target: { value: 'Loop test passes' } });
  fireEvent.change(screen.getByTestId('goal-create-ac-criterion-0'), { target: { value: 'node --test loop.test.mjs' } });
  fireEvent.change(screen.getByTestId('goal-create-ac-expect-0'), { target: { value: 'fails while the driver is missing' } });
}

test('shows the loading state, then the listed goal with its title', async () => {
  stubLoad([makeGoal()]);

  render(<GoalPanel {...PANEL_PROPS} />);

  // The first paint is the loading branch: the list has not answered yet.
  assert.ok(screen.getByTestId('goal-panel-loading'), 'the panel must show a loading state before the list answers');

  const card = await screen.findByTestId(`goal-card-${GOAL_ID}`);
  assert.match(card.textContent ?? '', /Ship the goal loop/, 'the card must name the goal it draws');
  assert.ok(apiMock.goals.detail.mock.calls.some(([id]) => id === GOAL_ID), 'ACs/rounds live in the detail read, so it must be read for the listed goal');
});

test('prints the lifecycle status verbatim in the status badge', async () => {
  await renderLoaded([makeGoal({ status: 'paused' })]);

  const badge = screen.getByTestId(`goal-status-${GOAL_ID}`);
  assert.equal((badge.textContent ?? '').trim(), 'paused', 'the scenario script reads the status text, so it must be the raw value');
});

test('colours each criterion by its evidence verdict, not by the AC status', async () => {
  const passingAc = makeAc(`${GOAL_ID}-AC-001`);
  const failingAc = makeAc(`${GOAL_ID}-AC-002`);
  const neverRunAc = makeAc(`${GOAL_ID}-AC-003`);

  await renderLoaded(
    [makeGoal({ status: 'active' })],
    {
      [GOAL_ID]: {
        goal: makeGoal({ status: 'active' }),
        acs: [passingAc, failingAc, neverRunAc],
        rounds: [makeRound(1, 'progress')],
        // Both criteria carry status `active`; only the evidence tells them apart.
        evidence: [makeEvidence(passingAc.id, 'pass'), makeEvidence(failingAc.id, 'fail')],
      },
    },
  );

  fireEvent.click(screen.getByTestId(`goal-expand-${GOAL_ID}`));

  const greenDot = screen.getByTestId(`goal-ac-dot-${passingAc.id}`);
  const redDot = screen.getByTestId(`goal-ac-dot-${failingAc.id}`);
  const noReadingDot = screen.getByTestId(`goal-ac-dot-${neverRunAc.id}`);

  assert.match(greenDot.className, /bg-green-500/, 'a passing reading must be green');
  assert.match(redDot.className, /bg-red-500/, 'a failing reading must be red');
  assert.doesNotMatch(noReadingDot.className, /bg-(green|red)-500/, 'a never-run criterion is not a failure');

  assert.equal(screen.getByTestId(`goal-ac-row-${passingAc.id}`).getAttribute('data-verdict'), 'pass');
  assert.equal(screen.getByTestId(`goal-ac-row-${failingAc.id}`).getAttribute('data-verdict'), 'fail');
  assert.equal(screen.getByTestId(`goal-ac-row-${neverRunAc.id}`).getAttribute('data-verdict'), 'none');

  // The progress reading counts only real passes.
  assert.equal((screen.getByTestId(`goal-ac-progress-${GOAL_ID}`).textContent ?? '').trim(), '1/3 criteria passing');
  // The criterion body and the evidence tail are both on the row.
  assert.match(screen.getByTestId(`goal-ac-criterion-${passingAc.id}`).textContent ?? '', /node --test/);
  assert.match(screen.getByTestId(`goal-ac-evidence-${failingAc.id}`).textContent ?? '', /AssertionError/);
});

test('a draft goal activates through the API with the default provider', async () => {
  await renderLoaded([makeGoal({ status: 'draft' })]);
  apiMock.goals.activate.mockResolvedValue(jsonOk({ goal: makeGoal({ status: 'active' }) }));

  fireEvent.click(screen.getByTestId(`goal-activate-${GOAL_ID}`));

  await act(async () => {});
  assert.equal(apiMock.goals.activate.mock.calls.length, 1, 'clicking Activate must call the activate endpoint');
  assert.deepEqual(apiMock.goals.activate.mock.calls[0], [GOAL_ID, 'claude'], 'claude is the default the card offers');
});

test('the provider picker is offered only on a draft and its choice reaches the activation', async () => {
  const draft = makeGoal({ status: 'draft' });
  const active = makeGoal({ id: 'goal-2', status: 'active', title: 'Second goal' });
  await renderLoaded([draft, active], {
    [GOAL_ID]: { goal: draft, acs: [], rounds: [], evidence: [] },
    'goal-2': { goal: active, acs: [], rounds: [], evidence: [] },
  });
  apiMock.goals.activate.mockResolvedValue(jsonOk({ goal: makeGoal({ status: 'active' }) }));

  const picker = screen.getByTestId(`goal-provider-${GOAL_ID}`);
  assert.ok(picker, 'a draft shows the picker next to Activate');
  assert.equal(screen.queryByTestId('goal-provider-goal-2'), null, 'the choice is made once, before activation, so only a draft offers it');

  const options = Array.from(picker.querySelectorAll('option')).map((option) => option.value);
  assert.deepEqual(options, ['claude', 'codex', 'cursor', 'opencode'], 'every CLI the server accepts is offered');

  fireEvent.change(picker, { target: { value: 'codex' } });
  fireEvent.click(screen.getByTestId(`goal-activate-${GOAL_ID}`));

  await act(async () => {});
  assert.deepEqual(apiMock.goals.activate.mock.calls[0], [GOAL_ID, 'codex'], 'the activation must carry the selected provider');
});

test('an active goal offers pause and one round; a paused goal offers resume', async () => {
  const active = makeGoal({ status: 'active' });
  const paused = makeGoal({ id: 'goal-2', status: 'paused', title: 'Second goal' });
  await renderLoaded([active, paused], {
    [GOAL_ID]: { goal: active, acs: [], rounds: [], evidence: [] },
    'goal-2': { goal: paused, acs: [], rounds: [], evidence: [] },
  });

  apiMock.goals.pause.mockResolvedValue(jsonOk(paused));
  apiMock.goals.runRound.mockResolvedValue(jsonOk({}));
  apiMock.goals.resume.mockResolvedValue(jsonOk(active));

  fireEvent.click(screen.getByTestId(`goal-pause-${GOAL_ID}`));
  await act(async () => {});
  assert.equal(apiMock.goals.pause.mock.calls.length, 1);

  fireEvent.click(screen.getByTestId(`goal-run-round-${GOAL_ID}`));
  await act(async () => {});
  assert.equal(apiMock.goals.runRound.mock.calls.length, 1);

  fireEvent.click(screen.getByTestId('goal-resume-goal-2'));
  await act(async () => {});
  assert.equal(apiMock.goals.resume.mock.calls.length, 1);

  // The verbs a status does not allow are not offered at all.
  assert.equal(screen.queryByTestId(`goal-resume-${GOAL_ID}`), null, 'an active goal cannot be resumed');
  assert.equal(screen.queryByTestId('goal-activate-goal-2'), null, 'a paused goal cannot be activated again');
});

test('abandon is offered on an unfinished goal and calls the abandon endpoint', async () => {
  await renderLoaded([makeGoal({ status: 'draft' })]);
  apiMock.goals.abandon.mockResolvedValue(jsonOk(makeGoal({ status: 'abandoned' })));

  fireEvent.click(screen.getByTestId(`goal-abandon-${GOAL_ID}`));
  await act(async () => {});

  assert.deepEqual(apiMock.goals.abandon.mock.calls, [[GOAL_ID]]);
});

test('the round timeline draws every round oldest-first with its outcome', async () => {
  const active = makeGoal({ status: 'active' });
  await renderLoaded([active], {
    [GOAL_ID]: {
      goal: active,
      acs: [],
      rounds: [
        // Deliberately out of order: the timeline's meaning comes from `seq`, not array order.
        { ...makeRound(2, 'no-progress'), startedAt: '2026-11-11T00:05:00.000Z' },
        makeRound(1, 'progress'),
      ],
      evidence: [],
    },
  });

  fireEvent.click(screen.getByTestId(`goal-expand-${GOAL_ID}`));

  const timeline = screen.getByTestId('goal-round-timeline');
  const rounds = Array.from(timeline.querySelectorAll('[data-outcome]')).map((row) =>
    row.getAttribute('data-outcome'),
  );
  assert.deepEqual(rounds, ['progress', 'no-progress'], 'rounds are ordered by seq, not by arrival');

  // The newest round is the one the collapsed card names.
  assert.match(screen.getByTestId(`goal-latest-round-${GOAL_ID}`).textContent ?? '', /#2/);
});

test('an activation refusal is reported in place of an error page', async () => {
  await renderLoaded([makeGoal({ status: 'draft' })]);
  apiMock.goals.activate.mockResolvedValue(
    jsonOk({ refusal: 'Activation refused: goal-1-AC-001 already passes', greenAcIds: [`${GOAL_ID}-AC-001`] }),
  );

  fireEvent.click(screen.getByTestId(`goal-activate-${GOAL_ID}`));

  const notice = await screen.findByTestId('goal-panel-notice');
  assert.match(notice.textContent ?? '', /already passes/);
  // The refusal names WHICH criteria already pass, so the person can decide whether the goal is
  // already met or the criterion must be rewritten. Dropping the ids would make the refusal a
  // sentence with nowhere to go.
  const greenAcLine = screen.getByTestId('goal-panel-refusal-green-acs');
  assert.match(greenAcLine.textContent ?? '', new RegExp(`${GOAL_ID}-AC-001`));
  // A refusal is not a failed read: the list stays on screen.
  assert.ok(screen.getByTestId('goal-panel-loaded'));
  assert.equal(screen.queryByTestId('goal-panel-error'), null);
});

test('an empty project shows the empty state, with the create form one click away', async () => {
  await renderLoaded([]);

  assert.ok(screen.getByTestId('goal-panel-empty'), 'no goals is an empty state, not an error');
  assert.equal(screen.queryByTestId(`goal-card-${GOAL_ID}`), null);

  fireEvent.click(screen.getByTestId('goal-create-button'));
  assert.ok(screen.getByTestId('goal-create-form'), 'the create button opens the authoring form');
});

test('the empty state offers its own create entry, not only the header button', async () => {
  await renderLoaded([]);

  // The empty body is the first thing a person reads on a fresh project; the create entry must be
  // reachable there, not only in the header they may have scrolled past.
  fireEvent.click(screen.getByTestId('goal-empty-create'));

  assert.ok(screen.getByTestId('goal-create-form'), 'the empty-state entry opens the authoring form');
});

test('a failed read shows the error state with the server message and a retry', async () => {
  apiMock.goals.list.mockRejectedValue(new Error('goals store is unavailable'));

  render(<GoalPanel {...PANEL_PROPS} />);

  const error = await screen.findByTestId('goal-panel-error');
  assert.match(error.textContent ?? '', /goals store is unavailable/);
  assert.equal(screen.queryByTestId('goal-panel-loaded'), null);

  stubLoad([makeGoal()]);
  fireEvent.click(screen.getByTestId('goal-panel-retry'));
  await screen.findByTestId('goal-panel-loaded');
});

test('creating a goal posts the goal, then one AC per authored row', async () => {
  await renderLoaded([]);
  apiMock.goals.create.mockResolvedValue(jsonOk(makeGoal()));
  apiMock.goals.addAc.mockResolvedValue(jsonOk(makeAc(`${GOAL_ID}-AC-001`)));

  fireEvent.click(screen.getByTestId('goal-create-button'));
  fillRequiredFields();

  await act(async () => {
    fireEvent.submit(screen.getByTestId('goal-create-form'));
  });

  assert.equal(apiMock.goals.create.mock.calls.length, 1, 'submit must create exactly one goal');
  const [body] = apiMock.goals.create.mock.calls[0];
  assert.equal(body.projectId, 'proj-1');
  assert.equal(body.projectPath, '/repo/proj-1');
  assert.equal(body.title, 'Ship the goal loop');
  // AC ids are minted server-side, so the exit conditions cannot be named yet.
  assert.deepEqual(body.exitConditions, []);

  assert.deepEqual(apiMock.goals.addAc.mock.calls[0], [
    GOAL_ID,
    { title: 'Loop test passes', criterion: 'node --test loop.test.mjs', expect: 'fails while the driver is missing' },
  ]);
});

test('the budget fields are prefilled with the defaults and converted on submit', async () => {
  await renderLoaded([]);
  apiMock.goals.create.mockResolvedValue(jsonOk(makeGoal()));
  apiMock.goals.addAc.mockResolvedValue(jsonOk(makeAc(`${GOAL_ID}-AC-001`)));

  fireEvent.click(screen.getByTestId('goal-create-button'));
  const rounds = screen.getByTestId('goal-create-budget-rounds') as HTMLInputElement;
  const hours = screen.getByTestId('goal-create-budget-hours') as HTMLInputElement;
  const noProgress = screen.getByTestId('goal-create-budget-no-progress') as HTMLInputElement;
  assert.deepEqual([rounds.value, hours.value, noProgress.value], ['20', '2', '3'], 'the form states the defaults it suggests');

  fillRequiredFields();
  // Hours are converted to milliseconds; rounds and no-progress are sent as typed.
  fireEvent.change(rounds, { target: { value: '5' } });
  fireEvent.change(hours, { target: { value: '1.5' } });
  fireEvent.change(noProgress, { target: { value: '4' } });

  await act(async () => {
    fireEvent.submit(screen.getByTestId('goal-create-form'));
  });

  assert.deepEqual(apiMock.goals.create.mock.calls[0][0].budget, {
    maxRounds: 5,
    maxWallClockMs: 5_400_000,
    maxNoProgress: 4,
  });
});

test('clearing a budget field leaves it out, so the store default applies', async () => {
  await renderLoaded([]);
  apiMock.goals.create.mockResolvedValue(jsonOk(makeGoal()));
  apiMock.goals.addAc.mockResolvedValue(jsonOk(makeAc(`${GOAL_ID}-AC-001`)));

  fireEvent.click(screen.getByTestId('goal-create-button'));
  fillRequiredFields();
  fireEvent.change(screen.getByTestId('goal-create-budget-hours'), { target: { value: '' } });

  await act(async () => {
    fireEvent.submit(screen.getByTestId('goal-create-form'));
  });

  const [body] = apiMock.goals.create.mock.calls[0];
  assert.deepEqual(body.budget, { maxRounds: 20, maxNoProgress: 3 });
  assert.equal('maxWallClockMs' in body.budget, false, 'a blank limit must not be sent as 0');
});

test('a non-numeric budget field blocks submission instead of being silently dropped', async () => {
  await renderLoaded([]);
  apiMock.goals.create.mockResolvedValue(jsonOk(makeGoal()));

  fireEvent.click(screen.getByTestId('goal-create-button'));
  fillRequiredFields();
  fireEvent.change(screen.getByTestId('goal-create-budget-rounds'), { target: { value: '0' } });

  await act(async () => {
    fireEvent.submit(screen.getByTestId('goal-create-form'));
  });

  assert.equal(apiMock.goals.create.mock.calls.length, 0, 'the route only accepts positive limits');
  assert.match(screen.getByTestId('goal-create-incomplete').textContent ?? '', /positive/);
});

test('polls every 5 s only while a goal is active and the tab is on screen', async () => {
  vi.useFakeTimers();
  const active = makeGoal({ status: 'active' });
  stubLoad([active], { [GOAL_ID]: { goal: active, acs: [], rounds: [], evidence: [] } });

  const view = render(<GoalPanel {...PANEL_PROPS} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  assert.equal(apiMock.goals.list.mock.calls.length, 1, 'the first read happens on mount');

  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  assert.equal(apiMock.goals.list.mock.calls.length, 2, 'an active goal re-reads every 5 s');

  // Switching the tab away stops the interval even though a goal is still active.
  view.rerender(<GoalPanel {...PANEL_PROPS} isActive={false} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  assert.equal(apiMock.goals.list.mock.calls.length, 2, 'a hidden tab must not poll');
});

test('a non-active goal is read once and never polled', async () => {
  vi.useFakeTimers();
  const paused = makeGoal({ status: 'paused' });
  stubLoad([paused], { [GOAL_ID]: { goal: paused, acs: [], rounds: [], evidence: [] } });

  render(<GoalPanel {...PANEL_PROPS} />);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });

  assert.equal(apiMock.goals.list.mock.calls.length, 1, 'only an active goal polls');
});

test('the card never prints the whole goal id, only a short form inside Details', async () => {
  const UUID_GOAL_ID = '0f3c2a91-7b64-4d0e-9f18-2b6e5a4c1d33';
  const goal = makeGoal({ id: UUID_GOAL_ID, status: 'draft' });
  const ac = makeAc(`${UUID_GOAL_ID}-AC-001`, {
    goalId: UUID_GOAL_ID,
    // A real criterion's title and command do not repeat the id; the row itself is
    // the only place that could.
    title: 'Loop test passes',
    criterion: 'node --test loop.test.mjs',
  });
  await renderLoaded([goal], { [UUID_GOAL_ID]: { goal, acs: [ac], rounds: [], evidence: [] } });

  const card = screen.getByTestId(`goal-card-${UUID_GOAL_ID}`);
  assert.doesNotMatch(card.textContent ?? '', new RegExp(UUID_GOAL_ID), 'the UUID beside the title was unreadable noise');

  fireEvent.click(screen.getByTestId(`goal-expand-${UUID_GOAL_ID}`));
  // A criterion id is `<goalId>-AC-001`, so the row would otherwise reprint the UUID.
  assert.doesNotMatch(card.textContent ?? '', new RegExp(UUID_GOAL_ID), 'expanding must not bring the UUID back');
  assert.match(card.textContent ?? '', /AC-001/, 'the criterion still names itself, by its own half of the id');

  const idLine = screen.getByTestId(`goal-id-${UUID_GOAL_ID}`);
  assert.equal(idLine.getAttribute('title'), UUID_GOAL_ID, 'the full id stays reachable as the tooltip');
  assert.match(idLine.textContent ?? '', /0f3c2a91/, 'the visible part is the short form');
  assert.doesNotMatch(idLine.textContent ?? '', new RegExp(UUID_GOAL_ID));
});

test('each criterion shows its newest evidence: verdict, exit code, timeout and output tail', async () => {
  const judgedAc = makeAc(`${GOAL_ID}-AC-001`);
  const neverRunAc = makeAc(`${GOAL_ID}-AC-002`);
  const olderPass = makeEvidence(judgedAc.id, 'pass');
  // Same criterion, later and failing: the newer reading must win over the pass.
  const newestReading: GoalEvidence = {
    ...makeEvidence(judgedAc.id, 'fail'),
    exitCode: null,
    timedOut: true,
    outputExcerpt: 'timed out after 600000ms',
    at: '2026-11-11T00:05:00.000Z',
  };

  await renderLoaded([makeGoal({ status: 'active' })], {
    [GOAL_ID]: {
      goal: makeGoal({ status: 'active' }),
      acs: [judgedAc, neverRunAc],
      rounds: [makeRound(1, 'progress')],
      evidence: [olderPass, newestReading],
    },
  });
  fireEvent.click(screen.getByTestId(`goal-expand-${GOAL_ID}`));

  assert.equal(screen.getByTestId(`goal-ac-row-${judgedAc.id}`).getAttribute('data-verdict'), 'fail');
  assert.match(screen.getByTestId(`goal-ac-dot-${judgedAc.id}`).className, /bg-red-500/);

  const line = screen.getByTestId(`goal-ac-evidence-line-${judgedAc.id}`).textContent ?? '';
  assert.match(line, /fail/, 'the verdict is spelled out, not only coloured');
  assert.match(line, /—/, 'a run with no exit code prints a dash instead of a number');
  assert.match(line, /timed out/);
  assert.match(screen.getByTestId(`goal-ac-evidence-output-${judgedAc.id}`).textContent ?? '', /timed out after 600000ms/);

  assert.ok(screen.getByTestId(`goal-ac-no-reading-${neverRunAc.id}`), 'a criterion no round has judged says so');
  assert.equal(screen.queryByTestId(`goal-ac-evidence-${neverRunAc.id}`), null, 'and shows no reading block');
});
