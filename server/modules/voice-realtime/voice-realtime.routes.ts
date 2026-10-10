/**
 * The module's two HTTP routes.
 *
 * `POST /api/voice-realtime/diagnose` — the HTTP-layer way to exercise Live Voice.
 *
 * Takes an audio file instead of a microphone, runs it through the same proxy a
 * browser connection uses (see `voice-realtime-diagnose.service.ts`), and returns what
 * the upstream heard and what the model did. The route only parses and validates
 * transport input and formats the response; the work is the service's.
 *
 * `DELETE /api/voice-realtime/log` — clears the live relay's on-disk journal (see
 * `voice-realtime-log.ts`) and answers how many connection records were removed. The
 * store is injected, so the route itself knows only the shape of the answer.
 *
 * Body (JSON):
 *   sessionId   string   required — the session the run is bound to
 *   audioBase64 string   required — a mono 16 kHz PCM16 WAV, or raw PCM16 with format "pcm16"
 *   format      "wav" | "pcm16"   default "wav"
 *   dryRun      boolean  default true — when true `session_send` is recorded, not delivered,
 *                         so a diagnosis never injects a message into a real conversation
 *   speed       number   default 1 (real time), 0.25–8
 *   turns       array    optional multi-turn script: [{ audioBase64, gapMs? }, …] (max 8, WAV only),
 *                         spoken in order on ONE connection; replaces audioBase64
 *   quietMs     number   default 5000 — end once the upstream has been quiet this long
 *   maxMs       number   default 90000, ceiling 180000
 *
 * Consumers: `server/index.ts`, which mounts it behind `authenticateToken`.
 */
import express, { type Router } from 'express';

import {
  parseWavPcm16,
  type VoiceRealtimeDiagnosisInput,
  type VoiceRealtimeDiagnosisReport,
} from './voice-realtime-diagnose.service.js';

/** What the route needs from the composition root. */
export type VoiceRealtimeRoutesDeps = {
  diagnose(input: VoiceRealtimeDiagnosisInput, options: { dryRun: boolean; userId: number }): Promise<VoiceRealtimeDiagnosisReport>;
  /**
   * Removes the relay journal and answers how many connection records went with it.
   *
   * OPTIONAL, and the route has to keep working without it: a deployment that wired no log store (and
   * a double in a leaf test) has nothing to clear, which reads the same as a clear that found no
   * records — `{ deleted: 0 }` — rather than as a missing route.
   */
  clearLog?(): { deleted: number };
};

const clampNumber = (value: unknown, fallback: number, min: number, max: number): number => {
  const parsed = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, parsed));
};

/** Builds the router. Consumed by `server/index.ts`. */
export function createVoiceRealtimeRouter(deps: VoiceRealtimeRoutesDeps): Router {
  const router = express.Router();

  router.post('/diagnose', async (request, response) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    if (typeof body.sessionId !== 'string' || body.sessionId.length === 0) {
      response.status(400).json({ error: 'sessionId is required' });
      return;
    }

    // A multi-turn script replaces the single clip.
    let turns: Array<{ pcm16: Buffer; gapMs: number }> | undefined;
    if (body.turns !== undefined) {
      if (!Array.isArray(body.turns) || body.turns.length === 0 || body.turns.length > 8) {
        response.status(400).json({ error: 'turns must be a list of 1 to 8 clips' });
        return;
      }
      turns = [];
      for (const [index, entry] of (body.turns as Array<Record<string, unknown>>).entries()) {
        if (typeof entry?.audioBase64 !== 'string' || entry.audioBase64.length === 0) {
          response.status(400).json({ error: `turns[${index}].audioBase64 is required` });
          return;
        }
        const parsedTurn = parseWavPcm16(Buffer.from(entry.audioBase64, 'base64'));
        if ('error' in parsedTurn) {
          response.status(400).json({ error: `turns[${index}]: unusable WAV: ${parsedTurn.error}` });
          return;
        }
        turns.push({ pcm16: parsedTurn.pcm16, gapMs: clampNumber(entry.gapMs, 1_500, 0, 60_000) });
      }
    } else if (typeof body.audioBase64 !== 'string' || body.audioBase64.length === 0) {
      response.status(400).json({ error: 'audioBase64 is required' });
      return;
    }

    const raw = Buffer.from(typeof body.audioBase64 === 'string' ? body.audioBase64 : '', 'base64');
    let pcm16: Buffer;
    if (turns !== undefined) {
      pcm16 = turns[0]!.pcm16;
    } else if (body.format === 'pcm16') {
      pcm16 = raw;
    } else {
      const parsed = parseWavPcm16(raw);
      if ('error' in parsed) {
        response.status(400).json({ error: `unusable WAV: ${parsed.error}` });
        return;
      }
      pcm16 = parsed.pcm16;
    }
    if (pcm16.length < 3_200) {
      response.status(400).json({ error: 'audio is shorter than 0.1 s' });
      return;
    }

    try {
      const report = await deps.diagnose(
        {
          boundSessionId: body.sessionId,
          pcm16,
          speed: clampNumber(body.speed, 1, 0.25, 8),
          quietMs: clampNumber(body.quietMs, 5_000, 500, 60_000),
          maxMs: clampNumber(body.maxMs, turns === undefined ? 90_000 : 600_000, 5_000, 900_000),
          ...(turns === undefined ? {} : { turns }),
        },
        {
          dryRun: body.dryRun !== false,
          // The authenticated principal, as the websocket upgrade derives it.
          userId: Number((request as unknown as { user?: { userId?: number; id?: number } }).user?.userId ?? (request as unknown as { user?: { id?: number } }).user?.id ?? 0),
        },
      );
      response.json(report);
    } catch (error) {
      response.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  // THE RELAY JOURNAL, CLEARABLE IN ONE REQUEST. The same verb, the same resource shape and the same
  // answer as the recordings store's `DELETE /api/voice/data`: a count rather than `204`, because the
  // store is the only thing that knows how many connection records were on disk, and the caller could
  // not have computed that for itself.
  //
  // A `DELETE` OF THE WHOLE COLLECTION rather than of one file: a connection's id is the uuids of
  // connections that have already ended, so there is no id a client could be holding to name one. The
  // operator's action is "start over", and the journal is small enough that losing it whole is the
  // point.
  //
  // `{ deleted: 0 }` AT `200` IS A NORMAL ANSWER — nothing to clear is a clear that succeeded, and a
  // deployment with no store wired has nothing to clear either.
  router.delete('/log', (_request, response) => {
    response.json(deps.clearLog?.() ?? { deleted: 0 });
  });

  return router;
}
