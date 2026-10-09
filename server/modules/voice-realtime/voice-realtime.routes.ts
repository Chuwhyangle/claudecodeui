/**
 * `POST /api/voice-realtime/diagnose` — the HTTP-layer way to exercise Live Voice.
 *
 * Takes an audio file instead of a microphone, runs it through the same proxy a
 * browser connection uses (see `voice-realtime-diagnose.service.ts`), and returns what
 * the upstream heard and what the model did. The route only parses and validates
 * transport input and formats the response; the work is the service's.
 *
 * Body (JSON):
 *   sessionId   string   required — the session the run is bound to
 *   audioBase64 string   required — a mono 16 kHz PCM16 WAV, or raw PCM16 with format "pcm16"
 *   format      "wav" | "pcm16"   default "wav"
 *   dryRun      boolean  default true — when true `session_send` is recorded, not delivered,
 *                         so a diagnosis never injects a message into a real conversation
 *   speed       number   default 1 (real time), 0.25–8
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
    if (typeof body.audioBase64 !== 'string' || body.audioBase64.length === 0) {
      response.status(400).json({ error: 'audioBase64 is required' });
      return;
    }

    const raw = Buffer.from(body.audioBase64, 'base64');
    let pcm16: Buffer;
    if (body.format === 'pcm16') {
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
          maxMs: clampNumber(body.maxMs, 90_000, 5_000, 180_000),
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

  return router;
}
