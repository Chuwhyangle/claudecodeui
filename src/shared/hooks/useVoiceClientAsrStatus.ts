import { useCallback, useEffect, useState } from 'react';

import type { AsrRuntimeStatus } from '@shared/asr/asrRegistry';
import {
  CLIENT_ASR_FALLBACK_EVENT,
  installVoiceClientAsrEngine,
  observeVoiceClientAsrEngine,
  preloadVoiceClientAsrEngine,
  voiceClientAsrEngine,
  voiceClientAsrProgress,
  type VoiceClientFallbackDetail,
} from '@/shared/voiceClientAsrWorker';
import type { VoiceModelProgress } from '@/shared/voiceModelCache';

/**
 * The client recogniser's state, as the settings panel needs to show it.
 *
 * Consumed by the settings module's voice panel (`VoiceSettingsTab`), which is the
 * surface that shows a first download's progress and the reason a clip had to leave
 * the device. It lives in `shared` because the engine it reads is chat's (the
 * composer installs it and transcribes with it), and settings may not import chat.
 *
 * WHY THIS IS A HOOK AND NOT A RETURN OF `useVoiceAvailable`. Availability is one bit
 * — may the microphone be offered — and this is everything the user needs to judge a
 * recogniser that runs on their own machine: how far its first download has come,
 * whether it ever finished, and, when a clip had to leave the device, why. Folding
 * these into the availability boolean would make every consumer of that boolean
 * re-render on every model chunk.
 *
 * THE FALLBACK DETAIL COMES OFF THE WINDOW EVENT rather than from this hook's own
 * transcription calls, because the clips that fall back are not transcribed by the
 * panel — they are transcribed by the chat composer, on another render. The event is
 * the one channel between the two, so a give-up that happened while the user was
 * typing is still on screen when they open settings.
 */
export type VoiceClientAsrPanel = {
  /** The engine's own reading, or null before anything installed one. */
  engine: AsrRuntimeStatus | null;
  /** The latest download reading, or null before the first byte of the model. */
  progress: VoiceModelProgress | null;
  /** The last fallback announced on this page, or null when nothing has left the device. */
  fallback: VoiceClientFallbackDetail | null;
  /** Starts (or joins) the download now and answers with the engine's reading when it settles. */
  preload: () => Promise<AsrRuntimeStatus>;
};

export function useVoiceClientAsrStatus(): VoiceClientAsrPanel {
  const [engine, setEngine] = useState<AsrRuntimeStatus | null>(
    () => voiceClientAsrEngine()?.status() ?? null,
  );
  const [progress, setProgress] = useState<VoiceModelProgress | null>(voiceClientAsrProgress);
  const [fallback, setFallback] = useState<VoiceClientFallbackDetail | null>(null);

  useEffect(() => {
    // Installing here rather than requiring the caller to have done it first: a panel that shows the
    // download is a panel that must be able to start one, and the installer is memoised, so a page
    // where the composer already installed one pays nothing for this line.
    installVoiceClientAsrEngine();
    setEngine(voiceClientAsrEngine()?.status() ?? null);
    // Seeded from the module's last reading as well as fed by the observer, so a panel opened midway
    // through a download shows the position it is already at rather than an empty bar until the next
    // chunk — which on a stalled connection could be a long time.
    setProgress(voiceClientAsrProgress());
    observeVoiceClientAsrEngine({
      onProgress: (reading) => setProgress(reading),
    });

    const onFallback = (event: Event) => {
      setFallback((event as CustomEvent<VoiceClientFallbackDetail>).detail ?? null);
    };
    window.addEventListener(CLIENT_ASR_FALLBACK_EVENT, onFallback);
    return () => window.removeEventListener(CLIENT_ASR_FALLBACK_EVENT, onFallback);
  }, []);

  // STABLE IDENTITY, because its caller is an effect. The settings panel starts a download from an
  // effect keyed on the selection, and a fresh function on every render would either re-run that
  // effect infinitely or force the panel to reach for a ref to keep it quiet. The memo it calls is
  // what actually guarantees one load; this only keeps the caller's dependency list honest.
  const preload = useCallback(() => preloadVoiceClientAsrEngine().then((reading) => {
    // The reading the load settled on is the whole answer, including a load that FAILED: `preload`
    // catches a rejected `ensureReady` into `{available:false, reason}`, and re-reading the port's own
    // status would instead show whatever it believed mid-flight (`starting`) — a panel frozen on
    // "downloading" for a download that is never coming back.
    setEngine(reading);
    return reading;
  }), []);

  return { engine, progress, fallback, preload };
}
