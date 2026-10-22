import { useCallback, useEffect, useState } from 'react';

import type { AsrCapabilities, AsrRuntimeStatus } from '@shared/asr/asrRegistry';
import type { VoiceContextPackRuntimeSettings } from '@shared/voice/voiceSettingsRegistry';

import {
  installVoiceClientAsrEngine,
  voiceClientAsrReadiness,
} from '@/shared/voiceClientAsrWorker';
import { api, setVoiceProviderProfile, setVoiceProviderRows } from '@/shared/api';
import { setVoiceRuntimeConfig } from '@/shared/voiceRuntimeConfig';
import { useUiPreferences } from '@/shared/context/UiPreferencesContext';
import type { VoiceProviderRow } from '@/shared/types';
import {
  isVoiceClientAsrSelected,
  readVoiceConfig,
  VOICE_CONFIG_SYNC_EVENT,
  whenVoiceConfigReady,
} from '@/shared/voiceConfig';

// Voice UI is gated on the `voiceEnabled` UI preference (toggled in Quick Settings /
// the Settings modal) and a configured voice backend.
let healthRequest: Promise<boolean> | null = null;

/**
 * One row's capability declaration, or `null` when the row cannot say where it runs.
 *
 * THE LOCALITY IS CHECKED AND THE REST IS TRUSTED, on purpose: the declaration is the registry's own
 * object as the server republished it (see `voice.service.ts`'s `getHealth`), so there is nothing here
 * to re-derive — but a row whose declaration does not name one of the three localities is a row this
 * client cannot make a routing decision about, and the honest answer for one of those is "not
 * published" rather than a guess from the fields that happen to be present.
 */
function readCapabilities(value: unknown): AsrCapabilities | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const locality = (value as { locality?: unknown }).locality;
  if (locality !== 'remote' && locality !== 'local-server' && locality !== 'local-client') return null;
  return value as AsrCapabilities;
}

/** One row's runtime reading, or `null` when the row carries none (a remote recogniser's shape). */
function readRuntime(value: unknown): AsrRuntimeStatus | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { available, state, buildId, reason } = value as Record<string, unknown>;
  if (available === false) {
    return { available: false, state: 'unavailable', reason: typeof reason === 'string' ? reason : '' };
  }
  if (available !== true) return null;
  const usable = state === 'ready' || state === 'starting' || state === 'stopped' ? state : 'stopped';
  return { available: true, state: usable, buildId: typeof buildId === 'string' ? buildId : '' };
}

/** The health payload's provider list, as the routing decisions need it. */
function readProviderRows(payload: unknown): VoiceProviderRow[] {
  const rows = (payload as { providers?: unknown } | null)?.providers;
  if (!Array.isArray(rows)) return [];

  const published: VoiceProviderRow[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const { id, label, configured, capabilities, runtime } = row as Record<string, unknown>;
    if (typeof id !== 'string' || !id) continue;
    published.push({
      id,
      // A label is the server's to choose; the id is the honest fallback when it sent none, rather
      // than a name this client would have to keep in step with the registry.
      label: typeof label === 'string' && label ? label : id,
      configured: configured === true,
      capabilities: readCapabilities(capabilities),
      runtime: readRuntime(runtime),
    });
  }
  return published;
}

/**
 * Hands the health reading's effective provider to the shared API module, which is where the
 * direct path decides which endpoint a recording takes.
 *
 * The payload is read leniently and never throws: a response from an older server, or one
 * whose provider list is missing, must leave the previous profile in place cleared rather than
 * break a hook whose job is only to answer whether the microphone is available.
 *
 * THE WHOLE LIST IS PUBLISHED BESIDE THE PROFILE, and it is the same payload read twice rather than a
 * second request: the profile answers "what may this recording do" for the recogniser in use, while
 * the rows answer "which recognisers exist here" for a clip that recogniser could not take.
 */
function publishEffectiveProvider(payload: unknown): void {
  const health = (payload ?? {}) as { provider?: unknown; providers?: unknown };
  const providerId = typeof health.provider === 'string' ? health.provider : '';
  const providers = Array.isArray(health.providers) ? health.providers : [];
  const entry = providers.find(
    (candidate) => providerId !== '' && (candidate as { id?: unknown } | null)?.id === providerId,
  ) as { capabilities?: AsrCapabilities } | undefined;

  setVoiceProviderProfile(
    entry?.capabilities ? { id: providerId, capabilities: entry.capabilities } : null,
  );
  setVoiceProviderRows(readProviderRows(payload));
}

function checkVoiceHealth(): Promise<boolean> {
  if (healthRequest) return healthRequest;
  const request = api.voice.health()
    .then(async (response) => {
      if (!response.ok) throw new Error(`Voice health check failed (${response.status})`);
      const data = await response.json();
      publishEffectiveProvider(data);
      return data?.configured === true;
    })
    .finally(() => {
      healthRequest = null;
    });
  healthRequest = request;
  return request;
}

/** One in-flight runtime-config request, shared by every caller of {@link checkVoiceRuntimeConfig}. */
let runtimeConfigRequest: Promise<void> | null = null;

/**
 * The payload's `contextPack` block, read leniently, or `null` for a payload this client cannot use.
 *
 * Lenient on purpose: a server that predates the endpoint, or a proxy that answered HTML, must leave
 * the builder on its shipped defaults rather than fail a hook whose job is availability. The three
 * numbers are the only fields read — the endpoint's `source`/`warnings` are for an operator, not for
 * the decision this cache feeds.
 */
function readRuntimeConfig(payload: unknown): VoiceContextPackRuntimeSettings | null {
  const block = (payload as { contextPack?: unknown } | null)?.contextPack;
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const { maxRows, budgetChars, rowCapChars } = block as Record<string, unknown>;
  if (typeof maxRows !== 'number' || typeof budgetChars !== 'number' || typeof rowCapChars !== 'number') {
    return null;
  }
  return { maxRows, budgetChars, rowCapChars };
}

/**
 * Fetches the deployment's runtime knobs and publishes them for the context-pack builders.
 *
 * DECOUPLED FROM HEALTH, deliberately: `/health` is a per-user provider reading that can 503 while
 * the deployment's own settings file is perfectly readable, and the pack budget must not disappear
 * with the recogniser. A failed fetch publishes `null`, which every builder reads as the shipped
 * defaults — never as a value this client invented.
 */
function checkVoiceRuntimeConfig(): Promise<void> {
  if (runtimeConfigRequest) return runtimeConfigRequest;
  const request = api.voice.runtimeConfig()
    .then(async (response) => {
      if (!response.ok) throw new Error(`Voice runtime config failed (${response.status})`);
      setVoiceRuntimeConfig(readRuntimeConfig(await response.json()));
    })
    .catch(() => {
      setVoiceRuntimeConfig(null);
    })
    .finally(() => {
      runtimeConfigRequest = null;
    });
  runtimeConfigRequest = request;
  return request;
}

export function useVoiceAvailable(): boolean {
  // Read through the shared preferences owner. This used to re-parse the
  // preferences blob and register its own storage + sync listeners, once per
  // assistant message row.
  const { voiceEnabled: enabled } = useUiPreferences();
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    let requestId = 0;

    const check = async () => {
      if (!enabled) {
        setAvailable(false);
        return;
      }
      const id = ++requestId;
      try {
        // The settings load from the server now, so "no base URL" is only a
        // real answer once they have arrived. Deciding earlier would hide the
        // microphone on every load for a user who configured their own backend,
        // which is the failure this whole move exists to remove.
        await whenVoiceConfigReady();
        if (!active || id !== requestId) return;

        // The client path answers for itself, and it is the SERVER that says whether it can: the
        // reading is `ready` on the deployment's model directory (`GET /api/voice/client-assets`),
        // not whether the model has been downloaded in THIS tab yet. A provisioned deployment is
        // available the moment the page loads — the download happens on the first segment, or the
        // explicit init — while an unprovisioned one stays hidden, because the adapter behind it can
        // only answer `ENGINE_UNAVAILABLE`. Reading readiness rather than the engine's own `available`
        // is what keeps a 239 MB download from being spent to discover a file that was never there.
        //
        // Installing here is what makes the engine exist at all, and it is safe on every render of the
        // effect: the installer is memoised. The download's progress and notices have no consumer in
        // this hook on purpose — it is a boolean — and `observeVoiceClientAsrEngine` is where the
        // surface that can show them attaches.
        if (isVoiceClientAsrSelected()) {
          installVoiceClientAsrEngine();
          // The health reading is asked for on THIS path too, and it carries a second job the direct
          // path does not need: it is what PUBLISHES the recogniser rows the fallback resolver reads
          // (`resolveVoiceFallbackProvider`). Returning after the readiness read alone left the client
          // path — the one path whose whole purpose is that it CAN hand a clip off — the single path
          // with no fallback table at all, so the hand-off had no address to dial and the clip was
          // dropped instead. Fired beside it rather than after it so the two requests overlap, and its
          // failure is swallowed for the same reason as below: a deployment that cannot answer health
          // must not take the microphone away, it just leaves the fallback table empty.
          const [reading] = await Promise.all([
            voiceClientAsrReadiness(),
            checkVoiceHealth().catch(() => false),
            // The pack budget describes the deployment, not the recogniser, so it is asked beside
            // the provider reading rather than after it — and its failure is already swallowed.
            checkVoiceRuntimeConfig(),
          ]);
          if (active && id === requestId) setAvailable(reading?.ready === true);
          return;
        }

        if (readVoiceConfig().baseUrl.trim()) {
          setAvailable(true);
          // The health reading is asked for on this path too, even though its answer is not what
          // decides availability here. It is what PUBLISHES the effective provider, and that
          // publication is the only place the client learns what the recogniser declares — the
          // container gate and the trim gate both read it. Returning without asking left an
          // install with its own endpoint, which is the shipped shape, holding no declaration at
          // all: `effectivePauseCuesDeclaration()` answered `null`, and the trim gate reads `null`
          // as "this recogniser's pauses are worth keeping".
          //
          // Awaited rather than fired and forgotten, so a capture started immediately still sees
          // the declaration; its failure is swallowed rather than folded into `available`, because
          // a user whose own endpoint answers must keep their microphone whether or not this
          // server can be reached. A server that cannot answer leaves the profile unpublished,
          // which is the "do not trim" answer this path gave before — never a broken mic.
          await checkVoiceHealth().catch(() => {});
          // Same reason as the client path above: the pack budget is a deployment reading and does
          // not depend on the user's own endpoint answering.
          await checkVoiceRuntimeConfig();
          return;
        }

        const [result] = await Promise.all([checkVoiceHealth(), checkVoiceRuntimeConfig()]);
        if (active && id === requestId) setAvailable(result);
      } catch {
        if (active && id === requestId) setAvailable(false);
      }
    };

    void check();
    window.addEventListener(VOICE_CONFIG_SYNC_EVENT, check);
    return () => {
      active = false;
      window.removeEventListener(VOICE_CONFIG_SYNC_EVENT, check);
    };
  }, [enabled]);

  return enabled && available;
}
