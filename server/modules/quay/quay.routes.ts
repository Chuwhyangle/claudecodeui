/**
 * QUAY DISPLAY ROUTES
 * ===================
 *
 * Endpoints that expose a project's quay state to the CloudCLI UI:
 * - `GET  /api/quay/fleet-summary`                        — the eager cross-project reading.
 * - `GET  /api/quay/resolve`                              — dereference one `quay://` reference.
 * - `GET  /api/quay/summary`                              — a reference's summary reading.
 * - `GET  /api/quay/last-opened-session`                  — the browser's last-opened pointer.
 * - `GET  /api/quay/:projectId/status`                    — Tier 1, whether `.quay/config.yml` exists.
 * - `GET  /api/quay/:projectId/snapshot`                  — Tier 2, task/goal/ADR/driver counts.
 * - `GET  /api/quay/:projectId/lanes`                     — the title bar's lanes-only gantt read.
 * - `GET  /api/quay/:projectId/session-mentions`          — what this session's prose names.
 * - `GET  /api/quay/:projectId/interface-session`         — the fleet's pinned target conversation.
 * - `PUT  /api/quay/:projectId/interface-session`         — pin that conversation.
 * - `DELETE /api/quay/:projectId/interface-session`       — un-pin it.
 *
 * The routes only parse the id, call the service and format the response; all filesystem and
 * subprocess work lives in `quay.service.ts` / `quay-fleet-registry.ts`. The interface-session
 * verbs are the ONE write surface here, and they exist because the cockpit's「钉选为目标会话」
 * must land in the fleet registry (the authority) rather than in a second local store.
 */

import express from 'express';

import { readCockpitEnabled } from '@/shared/ports/cockpit-enabled.port.js';
import { asyncHandler } from '@/shared/utils.js';

import { createCounterVoice, type CounterVoiceService } from './counter-voice.js';
import type { QuayFleetRegistryService } from './quay-fleet-registry.js';
import { createQuayInitiatives } from './quay-initiatives.js';
import type {
  InitiativeDecisionInput,
  InitiativeDecisionOption,
  QuayInitiativesService,
} from './quay-initiatives.js';
import type { QuayUriErrorCode } from './quay-uri-resolve.js';
import type { SessionMentionsService } from './session-mentions.service.js';
import type { SessionTaskChainService } from './session-task-chain.service.js';
import type { createQuayService } from './quay.service.js';

/** The browser's last-opened session, as the server's pointer store answers it. */
export type QuayLastOpenedSession = { sessionId: string; openedAt: number };

type QuayRouterDependencies = {
  quayService: ReturnType<typeof createQuayService>;
  /**
   * The fleet registry seam behind the cockpit's pinned-target read/write.
   *
   * OPTIONAL so a display-only composition stays valid (and a criterion that mounts the router
   * with just the display service keeps its shape). Absent answers `fleet-cli-unavailable`, which
   * is the same document the fleet CLI produces when it cannot be reached — the cockpit's fallback
   * then applies unchanged. Production (`quay.module.ts`) always binds it.
   */
  fleetRegistry?: QuayFleetRegistryService;
  /** Reads the `ui_last_opened_session` pointer; absent means no fallback target. */
  readLastOpenedSession?: () => QuayLastOpenedSession | null;
  /**
   * The initiative view / decision queue seam (M6). Absent composes the production service
   * with the shipped sampling ratio; a criterion injects an exec seam instead.
   */
  initiatives?: QuayInitiativesService;
  /**
   * The decision queue's 「反方」 seam. Absent composes the production service (the server
   * settings file's `cockpit.counterVoice` block, the reply-suggestions gateway and its usage
   * ledger); a criterion injects a stub completion instead.
   */
  counterVoice?: CounterVoiceService;
  /**
   * The session → task flow chain reading. Absent answers `session-task-chain-unavailable`
   * for a display-only composition; production (`quay.module.ts`) always binds it.
   */
  sessionTaskChain?: SessionTaskChainService;
  /**
   * The session's task/goal mention reading (what the prose names, not what it wrote). Absent
   * answers `session-mentions-unavailable`; production always binds it.
   */
  sessionMentions?: SessionMentionsService;
  /**
   * The cockpit switch behind the routes that exist only for the cockpit.
   *
   * OPTIONAL so a display-only harness keeps its shape; absent reads the process-wide port
   * `server/index.ts` installs (fail-closed before installation). Production passes nothing
   * and therefore reads the ONE boot-time value the WebSocket gate and the client's feature
   * reading use.
   */
  cockpitEnabled?: () => boolean;
};

/** What the router answers when no fleet registry was composed in. */
const UNAVAILABLE_FLEET: QuayFleetRegistryService = {
  readInterfaceSession: async () => ({ ok: false, reason: 'fleet-cli-unavailable' }),
  writeInterfaceSession: async () => ({ ok: false, reason: 'fleet-cli-unavailable' }),
};

/** A non-empty trimmed string, or `null`. */
function readNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** One typed option, or `null` when the row is not `{id,label}`. */
function parseDecisionOption(value: unknown): InitiativeDecisionOption | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const id = readNonEmptyString(record.id);
  const label = readNonEmptyString(record.label);
  return id === null || label === null ? null : { id, label };
}

/**
 * The one write the initiative view performs: a human ruling.
 *
 * `by`/`kind` are checked rather than defaulted. The cockpit is a person's surface, so a
 * request that tries to record a liaison's self-decision through it is refused — 「谁裁定的」
 * is a field, and this transport only carries the person's.
 */
function parseInitiativeDecisionBody(
  body: unknown,
): { ok: true; value: InitiativeDecisionInput } | { ok: false; reason: string } {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'decision-body-required' };
  }
  const record = body as Record<string, unknown>;
  if (record.by !== 'human' || record.kind !== 'fact') {
    return { ok: false, reason: 'human-fact-required' };
  }
  const question = readNonEmptyString(record.question);
  if (question === null) return { ok: false, reason: 'question-required' };
  const rationale = readNonEmptyString(record.rationale);
  if (rationale === null) return { ok: false, reason: 'rationale-required' };
  const chosen = readNonEmptyString(record.chosen);
  if (chosen === null) return { ok: false, reason: 'chosen-required' };
  if (!Array.isArray(record.options)) return { ok: false, reason: 'options-required' };
  const options = record.options
    .map((option) => parseDecisionOption(option))
    .filter((option): option is InitiativeDecisionOption => option !== null);
  if (options.length !== record.options.length || options.length === 0) {
    return { ok: false, reason: 'options-invalid' };
  }
  if (!options.some((option) => option.id === chosen)) {
    return { ok: false, reason: 'chosen-not-an-option' };
  }
  const refs = Array.isArray(record.refs)
    ? record.refs.filter((ref): ref is string => typeof ref === 'string' && ref.trim() !== '')
    : [];
  return {
    ok: true,
    value: { question, options, chosen, rationale, refs, by: 'human', kind: 'fact' },
  };
}

/** Reads the `sessionId` out of a PUT body; `null` when it is absent or not a usable id. */
function parseInterfaceSessionId(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const value = (body as { sessionId?: unknown }).sessionId;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Maps a dereference failure code to its transport status. The resolver returns failures as
 * VALUES (never throws), so the only 5xx here is the honest "the fleet read port is down and
 * this reference has no fallback" — an invalid or unknown reference is a 400, never a 500.
 */
function uriErrorStatus(code: QuayUriErrorCode): number {
  switch (code) {
    case 'not-a-quay-uri':
    case 'missing-project':
    case 'unknown-type':
    case 'empty-id':
    case 'malformed':
      return 400;
    case 'unknown-project':
    case 'task-not-found':
      return 404;
    case 'fleet-unavailable':
    case 'snapshot-unavailable':
      return 503;
  }
}

/** The `uri` query parameter, or `''` when it is absent or repeated. */
function readUriQuery(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * The gate for the routes the cockpit alone uses (initiative view / ruling / counter-voice,
 * and the pinned-target triple).
 *
 * A disabled feature answers 404, not 403: the routes are supposed to look absent. The gate
 * is a real handler rather than an unmounted router because the SPA catch-all is mounted
 * after every API route and would answer an unmounted extensionless path with `index.html`
 * 200 — a "missing" API that looks like a success.
 */
function requireCockpit(
  cockpitEnabled: () => boolean,
): (req: express.Request, res: express.Response, next: express.NextFunction) => void {
  return (_req, res, next) => {
    if (cockpitEnabled()) {
      next();
      return;
    }
    res.status(404).json({ error: 'Not found' });
  };
}

/** Creates the Quay routes; mounted by the server entrypoint behind auth. */
export function createQuayRouter(dependencies: QuayRouterDependencies): express.Router {
  const { quayService } = dependencies;
  const fleetRegistry = dependencies.fleetRegistry ?? UNAVAILABLE_FLEET;
  const readLastOpenedSession = dependencies.readLastOpenedSession ?? (() => null);
  const initiatives = dependencies.initiatives ?? createQuayInitiatives();
  const counterVoice = dependencies.counterVoice ?? createCounterVoice();
  const cockpitEnabled = dependencies.cockpitEnabled ?? readCockpitEnabled;
  const cockpitOnly = requireCockpit(cockpitEnabled);
  const router = express.Router();

  // Declared before the `/:projectId/...` routes so the static segment is never mistaken
  // for a project id (Express matches in declaration order).
  router.get(
    '/fleet-summary',
    asyncHandler(async (_req, res) => {
      // One aggregated reading of every quay project. The service owns the fan-out,
      // the per-project TTL and the concurrency ceiling; the route only relays it.
      const summary = await quayService.getFleetSummary();
      return res.json(summary);
    }),
  );

  // The wall's dereference entry points. `uri` must arrive as one query value (a `#ac-<n>`
  // fragment has to be percent-encoded as `%23`, since a real URL fragment never reaches the
  // server). The route only validates the transport and maps the service's value-result;
  // every read and every fallback decision lives in the service.
  router.get(
    '/resolve',
    asyncHandler(async (req, res) => {
      const uri = readUriQuery(req.query.uri);
      if (uri === '') {
        return res.status(400).json({
          ok: false,
          error: { code: 'missing-uri', message: 'the `uri` query parameter is required' },
        });
      }

      const result = await quayService.resolveQuayUri(uri);
      return res.status(result.ok ? 200 : uriErrorStatus(result.error.code)).json(result);
    }),
  );

  router.get(
    '/summary',
    asyncHandler(async (req, res) => {
      const uri = readUriQuery(req.query.uri);
      if (uri === '') {
        return res.status(400).json({
          ok: false,
          error: { code: 'missing-uri', message: 'the `uri` query parameter is required' },
        });
      }

      const result = await quayService.getQuayUriSummary(uri);
      return res.status(result.ok ? 200 : uriErrorStatus(result.error.code)).json(result);
    }),
  );

  // One segment, so it can never be read as a project id by the routes below.
  router.get(
    '/last-opened-session',
    asyncHandler(async (_req, res) => {
      const record = readLastOpenedSession();
      return res.json({
        sessionId: record?.sessionId ?? null,
        openedAt: record?.openedAt ?? null,
      });
    }),
  );

  /**
   * The cockpit's initiative view: every active initiative (charter, member cells, dependency
   * edges with their blocking reading) plus the `initiative-decision` queue and the liaison
   * self-decisions eligible for spot-checking. An unavailable fleet is answered as
   * `{ok:false, available:false, reason}` with HTTP 200 — the page states why, and the queue
   * (read from the fleet home) survives a fleet CLI that cannot be spawned.
   */
  router.get(
    '/initiatives',
    cockpitOnly,
    asyncHandler(async (_req, res) => {
      const reading = await initiatives.read();
      return res.json(reading);
    }),
  );

  /**
   * One human ruling, recorded by the fleet's own `initiative decide`. The route validates the
   * transport and relays the fleet's value-result; a refusal keeps the fleet's own reason so
   * the queue can say why nothing was written.
   */
  router.post(
    '/initiatives/:slug/decide',
    cockpitOnly,
    asyncHandler(async (req, res) => {
      const slug = typeof req.params.slug === 'string' ? req.params.slug : '';
      const parsed = parseInitiativeDecisionBody(req.body);
      if (!parsed.ok) {
        return res.status(400).json({ ok: false, reason: parsed.reason });
      }
      const result = await initiatives.decide(slug, parsed.value);
      return res.status(result.ok ? 200 : 502).json(result);
    }),
  );

  /**
   * The counter-voice (「反方」) for one pending ruling.
   *
   * The subject is looked up in the SERVER's own queue reading rather than accepted from the
   * caller: the model must see the question, options and evidence references exactly as the
   * queue holds them, never text a request could inject into its prompt. The reading is
   * generated on first ask and cached by the service, so the card can poll without paying
   * again; a spent budget or a failed call is answered as `{state:'unavailable', reason}` and
   * the ruling itself stays available.
   */
  router.get(
    '/initiatives/:attentionId/counter-voice',
    cockpitOnly,
    asyncHandler(async (req, res) => {
      const attentionId = typeof req.params.attentionId === 'string' ? req.params.attentionId : '';
      if (attentionId === '') {
        return res.status(400).json({ state: 'unavailable', kind: 'none', reason: '未生成：缺少裁定项 id' });
      }
      const reading = await initiatives.read();
      const item = reading.decisionQueue.find((candidate) => candidate.attentionId === attentionId);
      if (item === undefined) {
        return res
          .status(404)
          .json({ state: 'unavailable', kind: 'none', reason: '未生成：未知的裁定项' });
      }
      const counter = await counterVoice.read({
        attentionId: item.attentionId,
        initiative: item.initiative,
        question: item.question,
        options: item.options,
        evidence: item.evidence,
      });
      return res.json(counter);
    }),
  );

  /**
   * The project's pinned 「对人接口会话」. The answer is the fleet CLI's own document, relayed
   * verbatim: a caller that gets `{ok:false, reason}` must be able to state why (the fleet is not
   * installed, the project is not registered, …) instead of reading every failure as "no pin".
   */
  router.get(
    '/:projectId/interface-session',
    cockpitOnly,
    asyncHandler(async (req, res) => {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const reading = await fleetRegistry.readInterfaceSession(projectId);
      return res.json(reading);
    }),
  );

  // The one write surface: the cockpit's pin un-pins with DELETE, and a refusal keeps the fleet's
  // own reason (`interface-session-is-dev-session`, `unknown-project`, …) so the UI can show it.
  router.put(
    '/:projectId/interface-session',
    cockpitOnly,
    asyncHandler(async (req, res) => {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const sessionId = parseInterfaceSessionId(req.body);
      if (sessionId === null) {
        return res.status(400).json({ ok: false, reason: 'session-id-required' });
      }
      const result = await fleetRegistry.writeInterfaceSession(projectId, sessionId);
      return res.json(result);
    }),
  );

  router.delete(
    '/:projectId/interface-session',
    cockpitOnly,
    asyncHandler(async (req, res) => {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const result = await fleetRegistry.writeInterfaceSession(projectId, null);
      return res.json(result);
    }),
  );

  router.get(
    '/:projectId/status',
    asyncHandler(async (req, res) => {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const status = quayService.getQuayStatus(projectId);
      if (!status) {
        return res.status(404).json({ error: 'Project not found', projectId });
      }

      return res.json(status);
    }),
  );

  router.get(
    '/:projectId/snapshot',
    asyncHandler(async (req, res) => {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
      // The Loop pulse window rides the same request rather than a second endpoint: the card
      // is one reading of one snapshot, and a separate route would let the two disagree.
      const windowHours = typeof req.query.hours === 'string' ? req.query.hours : undefined;
      const snapshot = await quayService.getQuaySnapshot(projectId, { forceRefresh, windowHours });
      if (!snapshot) {
        return res.status(404).json({ error: 'Project not found', projectId });
      }

      return res.json(snapshot);
    }),
  );

  /**
   * The session → task flow chain: every task this conversation created or edited, with the
   * stage its store + git + deploy reading places it at. Read-only; the route parses the id
   * and relays the service's value (`null` = unknown project).
   */
  router.get(
    '/:projectId/session-task-chain',
    asyncHandler(async (req, res) => {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const sessionId = readNonEmptyString(req.query.sessionId);
      if (sessionId === null) {
        return res.status(400).json({ ok: false, reason: 'session-id-required' });
      }
      if (dependencies.sessionTaskChain === undefined) {
        return res.status(503).json({ ok: false, reason: 'session-task-chain-unavailable' });
      }

      const reading = await dependencies.sessionTaskChain.readSessionTaskChain({
        projectId,
        sessionId,
      });
      if (reading === null) {
        return res.status(404).json({ ok: false, reason: 'project-or-session-not-found' });
      }

      return res.json(reading);
    }),
  );

  /**
   * The session's mention reading: every task and goal the conversation's own message text
   * names. Read-only; the route parses the query and relays the service's value (`null` =
   * unknown project or session).
   */
  router.get(
    '/:projectId/session-mentions',
    asyncHandler(async (req, res) => {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const sessionId = readNonEmptyString(req.query.sessionId);
      if (sessionId === null) {
        return res.status(400).json({ ok: false, reason: 'session-id-required' });
      }
      if (dependencies.sessionMentions === undefined) {
        return res.status(503).json({ ok: false, reason: 'session-mentions-unavailable' });
      }

      const reading = await dependencies.sessionMentions.readSessionMentions({ projectId, sessionId });
      if (reading === null) {
        return res.status(404).json({ ok: false, reason: 'project-or-session-not-found' });
      }

      return res.json(reading);
    }),
  );

  /**
   * The lanes-only reading behind the title bar's mini gantt: one `quay lanes` child, nothing
   * else. `hours` is normalised to the closed set 1/3/6/12 by the service, so a stray value
   * reads as the default rather than widening the read.
   */
  router.get(
    '/:projectId/lanes',
    asyncHandler(async (req, res) => {
      const projectId = typeof req.params.projectId === 'string' ? req.params.projectId : '';
      const windowHours = typeof req.query.hours === 'string' ? req.query.hours : undefined;
      const reading = await quayService.getQuayLanes(projectId, windowHours);
      if (reading === null) {
        return res.status(404).json({ ok: false, error: 'Project not found', projectId });
      }

      return res.json(reading);
    }),
  );

  return router;
}
