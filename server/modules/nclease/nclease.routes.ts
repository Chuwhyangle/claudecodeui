/**
 * The NC-lease sidebar panel's HTTP face.
 *
 *   GET  /api/nclease/status  — the three slots, their leases and live probes
 *   POST /api/nclease/release — release one slot, with a required note
 *
 * Releasing is the only mutation: acquiring stays with the AI that does the
 * work, so a click here can never hand an instance to the wrong session.
 *
 * Consumers: `nclease.module.ts` (mounts this router) and the module's route
 * criterion, which injects fake service functions.
 */
import express, { type Request, type Response, type Router } from 'express';

import type { NcReleaseRequest } from '@/shared/types.js';

import {
  isReleasable,
  readNcLeaseStatus,
  releaseNcLease,
  type ReleaseLeaseInput,
} from './nclease.service.js';

// The closed sets the route accepts. Plain readonly arrays rather than module-level
// `Set`s: the architecture ratchet counts a module-scope mutable container as state
// that needs a lifecycle owner, and these are fixed vocabulary, not mutable state.
const SLOTS: readonly string[] = ['nc1', 'nc2', 'nc3'];
const OUTCOMES: readonly string[] = ['ok', 'failed', 'abandoned'];

function parseRelease(body: unknown): ReleaseLeaseInput | null {
  if (!body || typeof body !== 'object') return null;
  const raw = body as Partial<NcReleaseRequest>;
  if (typeof raw.slot !== 'string' || !SLOTS.includes(raw.slot)) return null;
  const outcome = raw.outcome === undefined ? 'ok' : raw.outcome;
  if (!OUTCOMES.includes(outcome)) return null;
  const note = typeof raw.note === 'string' ? raw.note.trim().slice(0, 240) : '';
  return { slot: raw.slot, outcome: outcome as ReleaseLeaseInput['outcome'], note: note || undefined };
}

export type NcLeaseRoutesDeps = {
  /** Injected by tests so a route test never shells out to the real ledger. */
  readStatus?: typeof readNcLeaseStatus;
  release?: typeof releaseNcLease;
};

export function createNcLeaseRoutes(deps: NcLeaseRoutesDeps = {}): Router {
  const readStatus = deps.readStatus ?? readNcLeaseStatus;
  const release = deps.release ?? releaseNcLease;
  const router = express.Router();

  router.get('/status', async (_req: Request, res: Response) => {
    res.json(await readStatus());
  });

  router.post('/release', async (req: Request, res: Response) => {
    const input = parseRelease(req.body);
    if (!input) {
      res.status(400).json({ ok: false, error: 'slot must be nc1|nc2|nc3, outcome ok|failed|abandoned' });
      return;
    }
    // A panel release is always forced, so it is limited to leases that look
    // abandoned; a live lease must be released by its holder in the CLI.
    const status = await readStatus();
    if (status.degraded) {
      res.status(409).json({ ok: false, error: '账本不可读，无法确认租约状态' });
      return;
    }
    const instance = status.instances.find((item) => item.id === input.slot);
    const verdict = isReleasable(instance?.lease, instance?.probe);
    if (!verdict.ok) {
      res.status(409).json({ ok: false, error: verdict.reason, releasable: false });
      return;
    }
    const result = await release(input);
    res.status(result.ok ? 200 : 409).json(result);
  });

  return router;
}
