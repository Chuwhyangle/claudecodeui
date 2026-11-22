/**
 * The second half of the endpoint map: user through notices.
 *
 * Composed with `apiCore` into the single `api` object in `client.ts`.
 */
import type { VoiceEditLabel } from '@/shared/voice/labels/voiceEditLabels';
import type { VoiceConfig } from '@/shared/api/voiceConfigType';
import type {
  DiagnosticsFailure,
  DiagnosticsFailuresResponse,
  DiagnosticsFeature,
  DiagnosticsFeaturesResponse,
  LogLine,
  LogLineLevel,
  LogSource,
  LogSourcesResponse,
  LogsResponse,
} from '@/shared/types';
import type {
  DraftRewriteErrorCode,
  DraftRewriteFailure,
  DraftRewriteFailureCategory,
  DraftRewriteRequest,
  DraftRewriteResponse,
  DraftRewriteResult,
} from '@/shared/replySuggestionsType';
import type {
  ReplySuggestionsEventInput,
  ReplySuggestionsRequest,
  ReplySuggestionsStatus,
  ReplySuggestionsSuggestResponse,
} from '@/shared/types';
import {
  DEFAULT_REPLY_SUGGESTIONS_MAX_CHIPS,
  authenticatedFetch,
  del,
  get,
  patch,
  pluginAssetPath,
  post,
  put,
  query,
  readReplySuggestionsResult,
  readReplySuggestionsStatus,
} from '@/shared/api/requests';
import type { ApiRequestOptions } from '@/shared/api/requests';
// The failed-draw reader is feature vocabulary, not transport plumbing: it lives in its
// own zero-transport leaf beside the reply-suggestions type leaf (see that file's header).
import { readReplySuggestionsFailure } from '@/shared/replySuggestionsFailure';

/** The failure states the health card knows; anything else reads as `unknown`-like `degraded`. */
const DIAGNOSTICS_FEATURE_STATES: readonly string[] = ['off', 'misconfigured', 'ready', 'degraded', 'ok'];

//---------------------------------------------------------------------------------------------
// Draft rewrite wire readers (the composer's ✦ candidate).
//
// Declared here, beside the endpoint, rather than in `requests.ts`: the shared request helpers
// are not this feature's leaf, and the draft surface is small enough to keep its parsing with
// its one caller. Every field is validated; an unreadable body is a typed failure, never a
// silent "no answer".
//---------------------------------------------------------------------------------------------

const DRAFT_REWRITE_ERROR_CODES: readonly DraftRewriteErrorCode[] = [
  'DRAFT_REWRITE_INPUT_TOO_LONG',
  'DRAFT_REWRITE_REJECTED',
  'REPLY_SUGGESTIONS_DISABLED',
  'REPLY_SUGGESTIONS_RATE_LIMITED',
  'REPLY_SUGGESTIONS_UPSTREAM_FAILED',
  'INVALID_REQUEST',
];

const DRAFT_REWRITE_FAILURE_CATEGORIES: readonly DraftRewriteFailureCategory[] = [
  'timeout', 'http', 'network', 'parse', 'shape', 'circuit-open', 'rate-limit', 'misconfigured',
  'truncated', 'empty-output', 'output-too-long', 'non-text', 'too-long', 'unknown',
];

function readDraftRewriteCode(value: unknown): DraftRewriteErrorCode | 'unknown' {
  return typeof value === 'string' && (DRAFT_REWRITE_ERROR_CODES as readonly string[]).includes(value)
    ? value as DraftRewriteErrorCode
    : 'unknown';
}

function readDraftRewriteCategory(value: unknown): DraftRewriteFailureCategory | null {
  return typeof value === 'string' && (DRAFT_REWRITE_FAILURE_CATEGORIES as readonly string[]).includes(value)
    ? value as DraftRewriteFailureCategory
    : null;
}

/** A coarse category for a body that carried none: its code and status are enough. */
function inferDraftRewriteCategory(
  code: DraftRewriteErrorCode | 'unknown',
  httpStatus: number | null,
): DraftRewriteFailureCategory {
  if (code === 'DRAFT_REWRITE_INPUT_TOO_LONG') return 'too-long';
  if (code === 'REPLY_SUGGESTIONS_RATE_LIMITED' || httpStatus === 429) return 'rate-limit';
  if (code === 'REPLY_SUGGESTIONS_DISABLED') return 'misconfigured';
  if (code === 'REPLY_SUGGESTIONS_UPSTREAM_FAILED') return httpStatus === null ? 'unknown' : 'http';
  if (httpStatus !== null) return 'http';
  return 'unknown';
}

/** Reads one failed draft rewrite into the typed failure the controller shows. */
function readDraftRewriteFailure(
  status: number,
  body: unknown,
  fallbackMessage = `HTTP ${status}`,
): DraftRewriteFailure {
  const envelope = body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
  const error = envelope.error && typeof envelope.error === 'object' && !Array.isArray(envelope.error)
    ? envelope.error as Record<string, unknown>
    : {};
  const details = error.details && typeof error.details === 'object' && !Array.isArray(error.details)
    ? error.details as Record<string, unknown>
    : {};
  const code = readDraftRewriteCode(error.code);
  const httpStatus = typeof details.httpStatus === 'number' && Number.isInteger(details.httpStatus)
    ? details.httpStatus
    : null;
  return {
    at: new Date().toISOString(),
    code,
    category: readDraftRewriteCategory(details.category) ?? inferDraftRewriteCategory(code, httpStatus),
    httpStatus,
    requestId: typeof details.requestId === 'string' && details.requestId !== '' ? details.requestId : null,
    model: typeof details.model === 'string' && details.model !== '' ? details.model : null,
    message: typeof error.message === 'string' && error.message !== '' ? error.message : fallbackMessage,
  };
}

/** Reads the success body: exactly one non-empty string, or null when the shape is unusable. */
function readDraftRewriteResult(body: unknown): DraftRewriteResult | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (typeof record.rewrittenText !== 'string' || record.rewrittenText.trim() === '') return null;
  return { rewrittenText: record.rewrittenText };
}

/** Reads one failure row, or null when the shape is unusable. */
function readDiagnosticsFailure(value: unknown): DiagnosticsFailure | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== 'string' || typeof record.featureId !== 'string') return null;
  return {
    at: record.at,
    featureId: record.featureId,
    feature: typeof record.feature === 'string' ? record.feature : record.featureId,
    requestId: typeof record.requestId === 'string' ? record.requestId : '',
    category: typeof record.category === 'string' ? record.category : 'unknown',
    httpStatus: typeof record.httpStatus === 'number' ? record.httpStatus : null,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : 0,
    model: typeof record.model === 'string' ? record.model : '',
    protocol: typeof record.protocol === 'string' ? record.protocol : '',
  };
}

/** Reads one feature row, or null when the shape is unusable. */
function readDiagnosticsFeature(value: unknown): DiagnosticsFeature | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string') return null;
  const state = typeof record.state === 'string' && DIAGNOSTICS_FEATURE_STATES.includes(record.state)
    ? record.state as DiagnosticsFeature['state']
    : 'degraded';
  return {
    id: record.id,
    label: typeof record.label === 'string' ? record.label : record.id,
    state,
    enabled: record.enabled === true,
    problems: Array.isArray(record.problems)
      ? record.problems.filter((problem): problem is string => typeof problem === 'string')
      : [],
    lastSuccessAt: typeof record.lastSuccessAt === 'string' ? record.lastSuccessAt : null,
    lastFailure: readDiagnosticsFailure(record.lastFailure),
    configSource: typeof record.configSource === 'string' ? record.configSource : null,
  };
}

/** Reads the `/features` answer, dropping unusable rows rather than failing the whole read. */
function readDiagnosticsFeatures(body: unknown): DiagnosticsFeaturesResponse {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { features: [] };
  const record = body as Record<string, unknown>;
  const features = Array.isArray(record.features)
    ? record.features.map(readDiagnosticsFeature).filter((feature): feature is DiagnosticsFeature => feature !== null)
    : [];
  return { features };
}

/** Reads the `/recent-failures` answer, dropping unusable rows. */
function readDiagnosticsFailures(body: unknown): DiagnosticsFailuresResponse {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { failures: [] };
  const record = body as Record<string, unknown>;
  const failures = Array.isArray(record.failures)
    ? record.failures.map(readDiagnosticsFailure).filter((failure): failure is DiagnosticsFailure => failure !== null)
    : [];
  return { failures };
}

/** The three severities the window stores; anything else reads as `info`. */
const LOG_LINE_LEVELS: readonly string[] = ['info', 'warn', 'error'];

/** Reads one log line, or null when the shape is unusable. */
function readLogLine(value: unknown): LogLine | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.at !== 'string' || typeof record.text !== 'string') return null;
  const level = typeof record.level === 'string' && LOG_LINE_LEVELS.includes(record.level)
    ? record.level as LogLineLevel
    : 'info';
  return {
    at: record.at,
    level,
    source: typeof record.source === 'string' ? record.source : 'other',
    text: record.text,
  };
}

/** Reads one source tab, or null when the shape is unusable. */
function readLogSource(value: unknown): LogSource | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== 'string') return null;
  return {
    id: record.id,
    label: typeof record.label === 'string' ? record.label : record.id,
    count: typeof record.count === 'number' ? record.count : 0,
    lastAt: typeof record.lastAt === 'string' ? record.lastAt : null,
  };
}

/** Reads the `/logs/sources` answer, dropping unusable rows. */
function readLogSources(body: unknown): LogSourcesResponse {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { sources: [] };
  const record = body as Record<string, unknown>;
  const sources = Array.isArray(record.sources)
    ? record.sources.map(readLogSource).filter((source): source is LogSource => source !== null)
    : [];
  return { sources };
}

/** Reads the `/logs` answer; a malformed body reads as an empty, untruncated window. */
function readLogs(body: unknown): LogsResponse {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { lines: [], truncated: false, window: { maxLines: 0, maxBytes: 0 } };
  }
  const record = body as Record<string, unknown>;
  const lines = Array.isArray(record.lines)
    ? record.lines.map(readLogLine).filter((line): line is LogLine => line !== null)
    : [];
  const windowRecord = record.window !== null && typeof record.window === 'object'
    ? record.window as Record<string, unknown>
    : {};
  return {
    lines,
    truncated: record.truncated === true,
    window: {
      maxLines: typeof windowRecord.maxLines === 'number' ? windowRecord.maxLines : 0,
      maxBytes: typeof windowRecord.maxBytes === 'number' ? windowRecord.maxBytes : 0,
    },
  };
}

export const apiTail = {
  user: {
    gitConfig: () => get('/api/user/git-config'),
    updateGitConfig: (gitName: string, gitEmail: string) =>
      post('/api/user/git-config', { gitName, gitEmail }),
    onboardingStatus: () => get('/api/user/onboarding-status'),
    completeOnboarding: () => post('/api/user/complete-onboarding'),

    // Preferences and chat drafts live server-side so they follow the user
    // from one device to another. `savePreferences` is a merge-patch: only the
    // keys it is given are written.
    preferences: () => get('/api/user/preferences'),
    savePreferences: (updates: Record<string, unknown>) =>
      patch('/api/user/preferences', updates),
    drafts: () => get('/api/user/drafts'),
    saveDraft: (scope: string, draft: { text: string; queuedMessage?: unknown }) =>
      put('/api/user/drafts', { scope, ...draft }),
    deleteDraft: (scope: string) => del('/api/user/drafts', { scope }),
  },

  // Server-side settings: personal access tokens, stored credentials, notifications, web push
  settings: {
    // The server-level switches read from the boot-time settings file. The cockpit's entry
    // points read this before rendering; a failed or absent answer is treated as "off".
    serverFeatures: () => get('/api/settings/features'),
    accessTokens: () => get('/api/settings/access-tokens'),
    // The advanced, read-only OAuth-token list beside the PAT list. GET only: there
    // is no create/revoke here on purpose (OAuth tokens are revoked via grants).
    oauthTokens: () => get('/api/settings/oauth-tokens'),
    createAccessToken: (payload: { name: string; expiresInDays: number; scopes: string[] }) =>
      post('/api/settings/access-tokens', payload),
    revokeAccessToken: (tokenId: number) => del(`/api/settings/access-tokens/${tokenId}`),
    mcpGatewayStatus: () => get('/api/settings/mcp-gateway'),

    // The cockpit's new-conversation launch selection, saved in the server settings file.
    // GET reports the saved values beside the running process's effective ones; the save
    // carries the version it was based on, so a stale editor gets a 409 rather than an
    // overwrite. A successful save is PENDING until the server restarts.
    cockpitSessionStart: () => get('/api/settings/cockpit/session-start'),
    saveCockpitSessionStart: (payload: {
      model: string;
      effort?: string;
      expectedVersion: string;
    }) => put('/api/settings/cockpit/session-start', payload),

    // The OAuth surface the "connected apps" and "OAuth clients (advanced)" sections manage:
    // the signed-in user's own consent grants (list/revoke) and the registered clients
    // (list/disable), plus the manual-client creation whose secret is returned exactly once.
    oauthGrants: () => get('/api/settings/oauth-grants'),
    revokeOAuthGrant: (grantId: number) => del(`/api/settings/oauth-grants/${grantId}`),
    oauthClients: () => get('/api/settings/oauth-clients'),
    disableOAuthClient: (clientId: string) => patch(`/api/settings/oauth-clients/${clientId}/disable`),
    createOAuthClient: (payload: { clientName: string; redirectUris: string[] }) =>
      post('/api/oauth/clients', { client_name: payload.clientName, redirect_uris: payload.redirectUris }),

    credentials: (type: string) => get(`/api/settings/credentials${query({ type })}`),
    createCredential: (payload: {
      credentialName: string;
      credentialType: string;
      credentialValue: string;
      description?: string;
    }) => post('/api/settings/credentials', payload),
    deleteCredential: (credentialId: string) => del(`/api/settings/credentials/${credentialId}`),
    toggleCredential: (credentialId: string, isActive: boolean) =>
      patch(`/api/settings/credentials/${credentialId}/toggle`, { isActive }),

    notificationPreferences: () => get('/api/settings/notification-preferences'),
    saveNotificationPreferences: (preferences: unknown) =>
      put('/api/settings/notification-preferences', preferences),

    push: {
      vapidPublicKey: () => get('/api/settings/push/vapid-public-key'),
      subscribe: (subscription: { endpoint?: string; keys?: unknown }) =>
        post('/api/settings/push/subscribe', subscription),
      unsubscribe: (endpoint: string) => post('/api/settings/push/unsubscribe', { endpoint }),
    },
  },

  plugins: {
    list: () => get('/api/plugins'),
    install: (url: string) => post('/api/plugins/install', { url }),
    uninstall: (name: string) => del(`/api/plugins/${encodeURIComponent(name)}`),
    update: (name: string) => post(`/api/plugins/${encodeURIComponent(name)}/update`),
    toggle: (name: string, enabled: boolean) =>
      put(`/api/plugins/${encodeURIComponent(name)}/enable`, { enabled }),
    // Plugin bundles/icons are fetched with auth headers and handed to the
    // browser as blobs, so a bare asset URL is never requested unauthenticated.
    asset: (pluginName: string, assetFile: string) => get(pluginAssetPath(pluginName, assetFile)),
    // Exposed so the icon cache can key on the resolved asset path.
    assetUrl: pluginAssetPath,
    rpc: (pluginName: string, method: string, path: string, body?: unknown) =>
      authenticatedFetch(
        `/api/plugins/${encodeURIComponent(pluginName)}/rpc/${String(path).replace(/^\//, '')}`,
        {
          method: method || 'GET',
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        },
      ),
  },

  browserUse: {
    status: () => get('/api/browser-use/status'),
    settings: () => get('/api/browser-use/settings'),
    saveSettings: (settings: unknown) => put('/api/browser-use/settings', settings),
    sessions: () => get('/api/browser-use/sessions'),
    stopSession: (sessionId: string) => post(`/api/browser-use/sessions/${sessionId}/stop`),
    deleteSession: (sessionId: string) => del(`/api/browser-use/sessions/${sessionId}`),
    installRuntime: () => post('/api/browser-use/runtime/install'),
  },

  // Live Voice's speaker tracker (Phase 1, shadow). The model is a runtime artifact the SERVER
  // installs from one fixed source: the client reads the resolved path/state and asks for the
  // download by its own verb. Neither call carries a URL, a directory or a file name — the server's
  // settings file owns those, and a request field that named one would be a client choosing what
  // the server writes to disk.
  // Reply suggestions: the LLM tier of the composer's empty-box chips. The three endpoints are
  // declared here and nowhere else — the composer's hooks call these and never assemble a URL.
  // `suggest` and `status` parse and validate before returning, so callers never touch a
  // `Response`: a refused or unreadable answer is the typed `ok:false` failure (carrying
  // its code/status/requestId), never a `null` that hides which of the two happened.
  // `event` is the ledger's write path and answers whether the server accepted the row.
  replySuggestions: {
    status: async (): Promise<ReplySuggestionsStatus | null> => {
      const response = await get('/api/reply-suggestions/status');
      if (!response.ok) return null;
      const body = await response.json().catch(() => null) as unknown;
      return readReplySuggestionsStatus(body);
    },
    /**
     * The OPT-IN local debug ledger switch. `PUT { enabled }` -> `{ debugLog }`.
     *
     * Unlike `status` (which reads "off" on any refusal), a failed write THROWS: the Settings
     * switch must be able to roll back to the previous value and show a visible error rather
     * than silently pretending the write landed.
     */
    setDebugLog: async (enabled: boolean): Promise<boolean> => {
      const response = await put('/api/reply-suggestions/debug-log', { enabled });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const body = await response.json().catch(() => null) as unknown;
      const record = body !== null && typeof body === 'object' && !Array.isArray(body)
        ? body as Record<string, unknown>
        : {};
      return record.debugLog === true;
    },
    suggest: async (
      request: ReplySuggestionsRequest,
      options: { maxChips?: number } = {},
    ): Promise<ReplySuggestionsSuggestResponse> => {
      const response = await post('/api/reply-suggestions', request);
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        return { ok: false, failure: readReplySuggestionsFailure(response.status, body) };
      }
      const result = readReplySuggestionsResult(
        body,
        options.maxChips ?? DEFAULT_REPLY_SUGGESTIONS_MAX_CHIPS,
      );
      if (result === null) {
        return {
          ok: false,
          failure: readReplySuggestionsFailure(response.status, body, 'unreadable reply-suggestions response'),
        };
      }
      return { ok: true, result };
    },
    event: async (event: ReplySuggestionsEventInput): Promise<boolean> => {
      const response = await post('/api/reply-suggestions/events', event);
      return response.ok;
    },
    /**
     * The draft rewrite endpoint: `{ text, retry? }` -> `{ rewrittenText }`.
     *
     * The composer sends only the draft snapshot; the server owns the model, provider, prompt and
     * budget. A refusal is the typed discriminated failure, so the controller can keep the draft
     * and offer a retry instead of conflating "refused" with "empty".
     */
    draftRewrite: async (request: DraftRewriteRequest): Promise<DraftRewriteResponse> => {
      const response = await post('/api/reply-suggestions/draft-rewrite', request);
      const body = await response.json().catch(() => null) as unknown;
      if (!response.ok) {
        return { ok: false, failure: readDraftRewriteFailure(response.status, body) };
      }
      const result = readDraftRewriteResult(body);
      if (result === null) {
        return {
          ok: false,
          failure: readDraftRewriteFailure(response.status, body, 'unreadable draft-rewrite response'),
        };
      }
      return { ok: true, result };
    },
  },

  // Diagnostics & logs: the Settings page's low-frequency operator entry. Three
  // read-only GETs; every value is redacted on the server, so the client only
  // validates and displays. A refusal throws, which the diagnostics controller
  // turns into its visible error state rather than an empty "all healthy" page.
  diagnostics: {
    features: async (): Promise<DiagnosticsFeaturesResponse> => {
      const response = await get('/api/diagnostics/features');
      if (!response.ok) throw new Error(`diagnostics features request failed with HTTP ${response.status}`);
      return readDiagnosticsFeatures(await response.json().catch(() => null) as unknown);
    },
    recentFailures: async (limit = 50): Promise<DiagnosticsFailuresResponse> => {
      const response = await get(`/api/diagnostics/recent-failures${query({ limit })}`);
      if (!response.ok) throw new Error(`diagnostics recent-failures request failed with HTTP ${response.status}`);
      return readDiagnosticsFailures(await response.json().catch(() => null) as unknown);
    },
    bundle: async (): Promise<string> => {
      const response = await get('/api/diagnostics/bundle');
      if (!response.ok) throw new Error(`diagnostics bundle request failed with HTTP ${response.status}`);
      return response.text();
    },
    // The process-local window. Both reads are already redacted on the server;
    // the client only validates and displays. A refusal throws, which the drawer
    // controller turns into its visible error state.
    logSources: async (): Promise<LogSourcesResponse> => {
      const response = await get('/api/diagnostics/logs/sources');
      if (!response.ok) throw new Error(`diagnostics log sources request failed with HTTP ${response.status}`);
      return readLogSources(await response.json().catch(() => null) as unknown);
    },
    logs: async (filter: {
      source?: string;
      level?: LogLineLevel;
      since?: string;
      limit?: number;
    } = {}): Promise<LogsResponse> => {
      const search = query({ source: filter.source, level: filter.level, since: filter.since, limit: filter.limit });
      const response = await get(`/api/diagnostics/logs${search}`);
      if (!response.ok) throw new Error(`diagnostics logs request failed with HTTP ${response.status}`);
      return readLogs(await response.json().catch(() => null) as unknown);
    },
  },

  voiceRealtime: {
    // The reading the settings page renders: state, resolved path, pinned digest, source, licence,
    // and — while a download runs — received/total/rate.
    speakerModelStatus: () => get('/api/voice-realtime/speaker-model'),
    // Start the download, or join the one already in flight for the same resolved path. `202` and
    // `200` both answer with the current reading.
    speakerModelDownload: () => post('/api/voice-realtime/speaker-model/download', {}),
  },

  voice: {
    health: () => get('/api/voice/health'),
    // The server's reading of the browser recogniser's own deployment: whether a model directory is
    // configured and whether it holds the two files. Read before the client path downloads anything,
    // so a deployment that is not provisioned answers `ENGINE_UNAVAILABLE` with an actionable reason
    // instead of spending a 239 MB download to discover the same thing.
    clientAssets: () => get('/api/voice/client-assets'),
    transcribe: (formData: FormData, headers: Record<string, string> = {}) =>
      authenticatedFetch('/api/voice/transcribe', {
        method: 'POST',
        headers,
        body: formData,
      }),
    // The raw (pre-VAD) corpus upload, its own endpoint and its own transport method: the bytes it
    // carries are not sent on to any recogniser, so it is not a second call of `transcribe`.
    captureRaw: (formData: FormData, headers: Record<string, string> = {}) =>
      authenticatedFetch('/api/voice/capture/raw', {
        method: 'POST',
        headers,
        body: formData,
      }),
    // The deployment's own raw-capture switch, read once per session (see `voiceConfig.ts`). Its own
    // endpoint rather than a field on `health`, which is a per-user provider reading.
    capture: () => get('/api/voice/capture'),
    // THE USER'S OWN KEPT RECORDINGS: the one action the settings page's clear button sends. Its own
    // DELETE rather than a settings write, because what it removes is not a setting — it is every
    // record the store holds — and the response's `deleted` count is how many there were.
    clearData: () => del('/api/voice/data'),
    // THE CORRECTION GOES BACK. A transcription answers with a `recordId`; when the user then edits
    // the box and sends, this writes the text they sent and the `heard → final` pairs their edit
    // produced onto that same record. Its own `PATCH` of the resource `clearData` removes, because
    // the audio half of the record is not being replaced — only the two keys the correction owns.
    //
    // A `404` is a NORMAL answer here (the ceiling may have evicted the record, or the user may have
    // cleared it, since the listen), so the caller is expected to let it go rather than surface it:
    // the correction was not kept, and the message the user asked to send was sent regardless. See
    // `writeSentLabels` in `useVoiceInput`.
    writeLabels: (recordId: string, body: { finalText: string; labels: VoiceEditLabel[] }) =>
      patch(`/api/voice/data/${encodeURIComponent(recordId)}`, body),
    tts: (text: string, options: ApiRequestOptions = {}) => post('/api/voice/tts', { text }, options),
    // The deployment's runtime knobs for the context pack (rows / character budget / per-row cap).
    // Its own endpoint rather than a field on `health`, which is a per-user provider reading that
    // can 503; this one describes the process and always answers.
    runtimeConfig: () => get('/api/voice/runtime-config'),
    // The user's own backend settings, stored per user so they follow the
    // account rather than the browser profile they were typed in.
    config: () => get('/api/voice/config'),
    saveConfig: (settings: VoiceConfig) => put('/api/voice/config', settings),
  },

  system: {
    update: () => post('/api/system/update'),
    /** What is running, what is built, and what a build would apply (the cockpit deploy strip). */
    deployReadiness: () => get('/api/system/deploy-readiness'),
    /** The one confirmed action: build, then restart only if the build succeeded. */
    deploy: () => post('/api/system/deploy'),
  },

  notices: {
    /** This user's active notices and the ones already dismissed at their current revision. */
    list: () => get('/api/notices'),
    /** Records that the user has seen `revision` of `id`; 409 means the notice moved on. */
    dismiss: (id: string, revision: string) =>
      post(`/api/notices/${encodeURIComponent(id)}/dismiss`, { revision }),
  },
};
