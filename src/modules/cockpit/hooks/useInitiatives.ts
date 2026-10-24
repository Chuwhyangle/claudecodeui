import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type {
  InitiativeDecisionOutcome,
  InitiativeDecisionRequest,
  InitiativeReadingAnswer,
  InitiativeReadingDocument,
  InitiativeReadingUnavailable,
} from '@/modules/cockpit/cockpitView';

/**
 * The initiative view's client half.
 *
 * The server owns the reading: it asks the fleet for the active initiatives, reads the
 * `initiative-decision` attention entries and relays each initiative's decision ledger. This
 * hook only fetches once per activation and keeps four honest states — loading, loaded,
 * unavailable (the fleet CLI could not answer, with its reason) and error (the HTTP call
 * failed) — so the page never draws an empty board for a fleet that did not answer.
 *
 * `isActive` keeps the cockpit's other views from paying for a read they do not render.
 */

/** The four-state reading the page branches on. */
export type InitiativeReadingView =
  | { status: 'loading' }
  | { status: 'loaded'; reading: InitiativeReadingDocument }
  | { status: 'unavailable'; reading: InitiativeReadingUnavailable }
  | { status: 'error'; message: string };

/** Reads `/api/quay/initiatives`; a non-2xx is an error, a `{ok:false}` body is unavailable. */
export async function fetchInitiativeReading(): Promise<InitiativeReadingAnswer> {
  const response = await api.quayInitiatives();
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return (await response.json()) as InitiativeReadingAnswer;
}

/**
 * Records one human ruling through the server's decide route.
 *
 * The transport is the page's only write. `by`/`kind` travel explicitly so an accidental
 * liaison-shaped request is refused by the server's own validation rather than silently
 * recorded as the person's.
 */
export async function decideInitiative(
  request: InitiativeDecisionRequest,
): Promise<InitiativeDecisionOutcome> {
  const response = await api.quayInitiativeDecide(request.initiative, {
    question: request.question,
    options: request.options,
    chosen: request.chosen,
    rationale: request.rationale,
    refs: request.refs,
    by: request.by,
    kind: request.kind,
  });
  const body = (await response.json().catch(() => null)) as unknown;
  if (body !== null && typeof body === 'object' && (body as { ok?: unknown }).ok === true) {
    return { ok: true };
  }
  const record = (body ?? {}) as Record<string, unknown>;
  return {
    ok: false,
    reason: typeof record.reason === 'string' ? record.reason : `http-${response.status}`,
    ...(typeof record.detail === 'string' ? { detail: record.detail } : {}),
  };
}

export type InitiativeReadingConnection = {
  view: InitiativeReadingView;
  reload: () => Promise<void>;
};

export function useInitiativeReading(isActive: boolean): InitiativeReadingConnection {
  const [view, setView] = useState<InitiativeReadingView>({ status: 'loading' });

  const load = useCallback(async () => {
    // A re-read keeps the last reading on screen while it is in flight: replacing it with
    // `loading` would unmount the decision queue and erase the echo of the ruling that just
    // triggered the read.
    setView((previous) =>
      previous.status === 'loaded' || previous.status === 'unavailable'
        ? previous
        : { status: 'loading' },
    );
    try {
      const reading = await fetchInitiativeReading();
      if (reading.ok) {
        setView({ status: 'loaded', reading });
      } else {
        setView({ status: 'unavailable', reading });
      }
    } catch (error) {
      setView({
        status: 'error',
        message: error instanceof Error ? error.message : 'Failed to read the initiatives',
      });
    }
  }, []);

  useEffect(() => {
    if (!isActive) return;
    void load();
  }, [isActive, load]);

  return { view, reload: load };
}
