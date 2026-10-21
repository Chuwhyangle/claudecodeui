import { useCallback, useEffect, useState } from 'react';

import { api } from '@/shared/api';

/**
 * The speaker tracker's CAM++ model reading, as `GET /api/voice-realtime/speaker-model` answers it.
 *
 * The client does not compute any of these fields: the state (`missing`/`downloading`/`installed`/
 * `invalid`/`failed`) is the server's verified reading, and the path is the one its settings file
 * resolved. Kept beside the hook rather than in `src/shared/types.ts` because the hook and the
 * settings tab that renders it are this module's only two consumers.
 */
export type SpeakerModelStatus = {
  /** What the server found at the resolved path. */
  state: 'missing' | 'downloading' | 'installed' | 'invalid' | 'failed';
  /** The resolved checkpoint path, or `null` when the settings named an unusable one. */
  path: string | null;
  /** The file name the path ends in. */
  fileName: string;
  /** The pinned checkpoint length, used as the progress denominator. */
  expectedBytes: number;
  /** The pinned digest, shown so an operator can verify independently. */
  sha256: string;
  /** The fixed download source. */
  sourceUrl: string;
  /** The weights' licence. */
  license: string;
  /** Who the weights are. */
  attribution: string;
  /** The file's size on disk, when one exists. */
  bytes: number | null;
  /** Bytes received by the running download; `null` when none is running. */
  receivedBytes: number | null;
  /** The running download's total; `null` when none is running. */
  totalBytes: number | null;
  /** The running download's average rate, bytes per second; `null` when none is running. */
  bytesPerSec: number | null;
  /** The running download's start time (ms since epoch); `null` when none is running. */
  startedAt: number | null;
  /** The readable reason a reading is `invalid`/`failed`; `null` otherwise. */
  error: string | null;
};

/** What the settings tab reads. */
export type UseSpeakerModelStatus = {
  /** The latest server reading, or `null` before the first answer. */
  status: SpeakerModelStatus | null;
  /** The reason the last REQUEST failed (not the model's own `error`), or `null`. */
  error: string | null;
  /** True until the first reading lands, so the tab can avoid flashing `missing`. */
  loading: boolean;
  /** Re-reads the status now. */
  refresh: () => Promise<void>;
  /** Starts (or joins) the download and shows the progress it returns. */
  download: () => Promise<void>;
};

/** How often the tab re-reads a running download. One second is the progress-bar cadence. */
const POLL_INTERVAL_MS = 1_000;

/** Whether a parsed body is a reading this hook can render. */
function isSpeakerModelStatus(value: unknown): value is SpeakerModelStatus {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as { state?: unknown; path?: unknown };
  return (
    typeof candidate.state === 'string'
    && ['missing', 'downloading', 'installed', 'invalid', 'failed'].includes(candidate.state)
    && (candidate.path === null || typeof candidate.path === 'string')
  );
}

/** The server's own sentence from a failed response, else the request's failure. */
async function readFailure(response: Response, fallback: string): Promise<string> {
  const body = await response.json().catch(() => null);
  if (body !== null && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
    return (body as { error: string }).error;
  }
  return `${fallback} (HTTP ${response.status})`;
}

/** Converts an unknown throw into the sentence the panel shows. */
function describeError(error: unknown): string {
  return error instanceof Error && error.message !== '' ? error.message : String(error);
}

/**
 * Reads the speaker model's provisioning state, and polls while a download runs.
 *
 * Used by the settings module's Live Voice tab. The hook exists rather than a fetch inside the
 * component for two reasons: the download's progress is a SERVER fact that changes while the panel
 * is open, so the reading has to survive re-renders; and the poll must stop the moment the state
 * leaves `downloading`, which a component-local timer would have to reproduce.
 *
 * The download call itself sends NO input: the server owns the source URL and the destination path,
 * so there is nothing for this client to choose.
 */
export function useSpeakerModelStatus(): UseSpeakerModelStatus {
  // The last reading the server gave. It is state rather than a derived value because no prop or
  // other state on this page can produce it — it changes on the server (a finished download) and
  // only a poll can observe that.
  const [status, setStatus] = useState<SpeakerModelStatus | null>(null);
  // A transport/HTTP failure, kept apart from the model's own `error` field: the panel shows both,
  // and "the request never landed" is not a claim about what is on disk.
  const [error, setError] = useState<string | null>(null);
  // True until the first answer lands. Without it, the panel would render `missing` — and offer a
  // download — for the frame before the real reading arrives.
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const response = await api.voiceRealtime.speakerModelStatus();
      if (!response.ok) {
        setError(await readFailure(response, 'could not read the speaker model status'));
        return;
      }
      const body: unknown = await response.json().catch(() => null);
      if (!isSpeakerModelStatus(body)) {
        setError('the server answered with an unrecognised speaker model reading');
        return;
      }
      setStatus(body);
      setError(null);
    } catch (requestError) {
      setError(describeError(requestError));
    } finally {
      setLoading(false);
    }
  }, []);

  const download = useCallback(async (): Promise<void> => {
    try {
      const response = await api.voiceRealtime.speakerModelDownload();
      const body: unknown = await response.json().catch(() => null);
      if (!response.ok) {
        setError(await readFailure(response, 'the download could not be started'));
        return;
      }
      if (isSpeakerModelStatus(body)) {
        setStatus(body);
        setError(null);
        return;
      }
      // A deployment that answered without the reading still gets polled: the POST's side effect
      // is the download, and the next status call is what reports it.
      await refresh();
    } catch (requestError) {
      setError(describeError(requestError));
    }
  }, [refresh]);

  // The first reading, once on mount.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // THE POLL RUNS ONLY WHILE THERE IS SOMETHING TO WATCH. Each answer schedules the next read; the
  // cleanup cancels it when the component unmounts or the state changes, so an installed/failed
  // reading leaves no timer behind.
  useEffect(() => {
    if (status?.state !== 'downloading') return;
    const timer = setTimeout(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearTimeout(timer);
  }, [status, refresh]);

  return { status, error, loading, refresh, download };
}
