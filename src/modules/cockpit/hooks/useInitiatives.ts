import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';
import type {
  InitiativeCounterVoicePort,
  InitiativeCounterVoiceReading,
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

/** A reason the card can state verbatim; the server's own sentences start the same way. */
function counterVoiceFailure(reason: string): InitiativeCounterVoiceReading {
  return { state: 'unavailable', kind: 'none', reason: `未生成：${reason}` };
}

/**
 * Asks the server for one pending ruling's 「反方」.
 *
 * The transport never throws: a failed request, a non-JSON body or an unexpected shape answers
 * a stated reason, so the queue can draw the card and keep its ruling buttons usable. A
 * `ready` reading keeps the server's `advisory` (「仅作建议」) untouched — the annotation is the
 * engine's, not a label this client may drop.
 */
export const requestInitiativeCounterVoice: InitiativeCounterVoicePort = async (attentionId) => {
  let response: Response;
  try {
    response = await api.quayInitiativeCounterVoice(attentionId);
  } catch (error) {
    return counterVoiceFailure(error instanceof Error ? error.message : 'request failed');
  }

  const body = (await response.json().catch(() => null)) as unknown;
  if (body !== null && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    if (
      record.state === 'ready' &&
      record.kind === 'llm' &&
      Array.isArray(record.ignored) &&
      record.ignored.every((line) => typeof line === 'string') &&
      typeof record.strongestCounter === 'string' &&
      typeof record.falsifier === 'string' &&
      typeof record.advisory === 'string'
    ) {
      return {
        state: 'ready',
        kind: 'llm',
        ignored: record.ignored as string[],
        strongestCounter: record.strongestCounter,
        falsifier: record.falsifier,
        advisory: record.advisory,
      };
    }
    if (record.state === 'unavailable' && typeof record.reason === 'string') {
      return { state: 'unavailable', kind: 'none', reason: record.reason };
    }
  }
  return counterVoiceFailure(`HTTP ${response.status}`);
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
