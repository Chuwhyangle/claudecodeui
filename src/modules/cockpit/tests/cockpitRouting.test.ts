import { describe, expect, it, vi } from 'vitest';

import type { QuayFocusableObject } from '@/shared/types';
import {
  buildCockpitMessageBody,
  openCockpitSendGate,
  pinCockpitTargetSession,
  routeCockpitText,
} from '@/modules/cockpit/cockpitRouting';
import type {
  CockpitFleetPort,
  CockpitFleetReading,
  CockpitFleetWriteResult,
  CockpitRouteInput,
  CockpitSendPreview,
} from '@/modules/cockpit/cockpitRouting';
import type { CockpitProject } from '@/modules/cockpit/cockpitView';

/**
 * The cockpit's SECOND destination: an unmatched phrase routed to the focused project's target
 * conversation, previewed, and sent only on confirmation.
 *
 * Every external seam is bound here — the fleet registry read/write, the last-opened pointer, the
 * session title and the sender — so the assertions are about the routing rules rather than about
 * a server. The two fleet calls are counted, which is what makes "the pin went to the fleet and
 * nowhere else" and "nothing was sent before confirmation" readings instead of claims.
 */

const FOCUS_URI = 'quay://claudecodeui/task/x';
const PINNED_SESSION = 'session-pinned';
const RECENT_SESSION = 'session-recent';
const PROJECT_ID = 'p1';

/** The declaration the stage publishes for a focused in-flight task. */
const FOCUSABLE: QuayFocusableObject = {
  uri: FOCUS_URI,
  label: '①',
  display: { status: 'in_progress', color: 'blue', ordinal: 1, pos: { row: 1, column: 1 } },
};

const PROJECTS: CockpitProject[] = [
  {
    projectId: PROJECT_ID,
    name: 'claudecodeui',
    projectPath: '/work/claudecodeui',
    driverState: 'running',
    tasks: { total: 3, todo: 1, ready: 1, needsHuman: 0, done: 1 },
    cached: false,
    error: null,
  },
];

type FleetStub = {
  port: CockpitFleetPort;
  reads: string[];
  writes: Array<{ projectId: string; sessionId: string | null }>;
};

/** Binds the fleet port to one answer (or a throw) and counts every call. */
function stubFleet(answer: CockpitFleetReading | Error): FleetStub {
  const reads: string[] = [];
  const writes: Array<{ projectId: string; sessionId: string | null }> = [];
  const settle = async (): Promise<CockpitFleetReading> => {
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const writeOk = async (): Promise<CockpitFleetWriteResult> => ({ ok: true });
  return {
    reads,
    writes,
    port: {
      readInterfaceSession: async (projectId) => {
        reads.push(projectId);
        return settle();
      },
      writeInterfaceSession: async (projectId, sessionId) => {
        writes.push({ projectId, sessionId });
        return writeOk();
      },
      clearInterfaceSession: async (projectId) => {
        writes.push({ projectId, sessionId: null });
        return writeOk();
      },
    },
  };
}

/** One submission against the fixture; each case overrides only the seam it is about. */
function submission(
  fleet: CockpitFleetPort,
  overrides: Partial<CockpitRouteInput> = {},
): CockpitRouteInput {
  return {
    text: '把这个任务改短一点',
    visible: [FOCUSABLE],
    projects: PROJECTS,
    focusUri: FOCUS_URI,
    fleet,
    recentSessionId: () => null,
    ...overrides,
  };
}

/** Asserts a decision is a preview and returns it. */
async function previewOf(input: CockpitRouteInput): Promise<CockpitSendPreview> {
  const decision = await routeCockpitText(input);
  expect(decision.kind).toBe('preview');
  if (decision.kind !== 'preview') throw new Error('unreachable');
  return decision.preview;
}

describe('AC1: an unmatched phrase is routed to the project\'s target conversation', () => {
  it('uses the fleet-pinned session and carries the focus URI in the pack', async () => {
    const fleet = stubFleet({ ok: true, interfaceSessionId: PINNED_SESSION });

    const preview = await previewOf(submission(fleet.port));

    expect(preview.sessionId).toBe(PINNED_SESSION);
    expect(preview.source).toBe('pinned');
    expect(preview.focusUri).toBe(FOCUS_URI);
    expect(preview.pack.focus?.uri).toBe(FOCUS_URI);
    expect(preview.messageBody).toContain(FOCUS_URI);
    expect(fleet.reads).toEqual([PROJECT_ID]);
  });

  it('falls back to the last-opened session when the fleet has nothing pinned, and says so', async () => {
    const fleet = stubFleet({ ok: true, interfaceSessionId: null });

    const preview = await previewOf(
      submission(fleet.port, { recentSessionId: () => RECENT_SESSION }),
    );

    expect(preview.sessionId).toBe(RECENT_SESSION);
    expect(preview.source).toBe('recent');
    // "Nothing pinned" is ordinary, not an outage: the reason stays null and the source is what
    // tells the bar which sentence to draw.
    expect(preview.fleetUnavailableReason).toBeNull();
  });

  it('falls back with the stated reason when the fleet read port cannot answer', async () => {
    const fleet = stubFleet(new Error('fleet CLI is not installed'));

    const preview = await previewOf(
      submission(fleet.port, { recentSessionId: () => RECENT_SESSION }),
    );

    expect(preview.sessionId).toBe(RECENT_SESSION);
    expect(preview.source).toBe('recent');
    expect(preview.fleetUnavailableReason).toBe('unavailable');
  });

  it('pins through the fleet write function only, with no local persistence', async () => {
    const fleet = stubFleet({ ok: true, interfaceSessionId: null });
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    const result = await pinCockpitTargetSession(fleet.port, PROJECT_ID, PINNED_SESSION);

    expect(result).toEqual({ ok: true });
    expect(fleet.writes).toEqual([{ projectId: PROJECT_ID, sessionId: PINNED_SESSION }]);
    expect(fleet.reads).toEqual([]);
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });

  it('produces no send when neither a pin nor a last-opened session exists', async () => {
    const fleet = stubFleet({ ok: true, interfaceSessionId: null });
    const send = vi.fn();

    const decision = await routeCockpitText(submission(fleet.port));

    expect(decision).toMatchObject({ kind: 'no-target', reason: 'no-session' });
    expect(send).not.toHaveBeenCalled();
  });

  it('acts on a recognised intent instead of routing it', async () => {
    const fleet = stubFleet({ ok: true, interfaceSessionId: PINNED_SESSION });

    const decision = await routeCockpitText(submission(fleet.port, { text: '全部项目' }));

    expect(decision).toEqual({ kind: 'intent', intent: { kind: 'view', view: { type: 'fleet' } } });
    expect(fleet.reads).toEqual([]);
  });

  it('routes nothing when no object is focused', async () => {
    const fleet = stubFleet({ ok: true, interfaceSessionId: PINNED_SESSION });

    const decision = await routeCockpitText(submission(fleet.port, { focusUri: null }));

    expect(decision).toMatchObject({ kind: 'no-target', reason: 'no-focus' });
    expect(fleet.reads).toEqual([]);
  });
});

describe('AC2: nothing is sent before confirmation', () => {
  it('sends exactly once on confirm, with the focus URI in the body', async () => {
    const fleet = stubFleet({ ok: true, interfaceSessionId: PINNED_SESSION });
    const preview = await previewOf(submission(fleet.port));
    const send = vi.fn();

    const gate = openCockpitSendGate(preview, send);
    expect(send).toHaveBeenCalledTimes(0);

    expect(gate.confirm()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(PINNED_SESSION, expect.stringContaining(FOCUS_URI));

    // A second confirmation is a no-op rather than a second message.
    expect(gate.confirm()).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends nothing when the preview is cancelled', async () => {
    const fleet = stubFleet({ ok: true, interfaceSessionId: PINNED_SESSION });
    const preview = await previewOf(submission(fleet.port));
    const send = vi.fn();

    const gate = openCockpitSendGate(preview, send);
    gate.cancel();
    expect(gate.confirm()).toBe(false);
    expect(send).toHaveBeenCalledTimes(0);
  });

  it('builds a body that lists the reference URIs under the spoken text', () => {
    const body = buildCockpitMessageBody('把这个改短', ['quay://claudecodeui/task/x']);

    expect(body.startsWith('把这个改短')).toBe(true);
    expect(body.split('\n')).toContain('- quay://claudecodeui/task/x');
  });
});
