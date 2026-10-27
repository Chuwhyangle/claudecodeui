import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import type { Project, ProjectSession, SessionHostLease, SessionHostsSnapshot, VoiceClientAssetPaths } from '@/shared/types';

//----------------- DEPLOYMENT MODE ------------

/**
 * Indicates whether the app runs in Platform mode (hosted) or OSS mode (self-hosted).
 * Read it to hide or gate features that only exist in one of the two deployments.
 */
export const IS_PLATFORM = import.meta.env?.VITE_IS_PLATFORM === 'true';

// ---------------------------

//----------------- TAILWIND CLASS COMPOSITION ------------

/**
 * Merges conditional class names and resolves conflicting Tailwind utilities so the
 * last-specified utility wins. Use it for every className built from props or state.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------

//----------------- CLIPBOARD ------------

/**
 * Copies text with `document.execCommand`, the only path that works in browsers or
 * contexts where the async Clipboard API is unavailable. Private to `copyTextToClipboard`.
 */
function fallbackCopyToClipboard(text: string): boolean {
  if (!text || typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}

/**
 * Copies text to the clipboard, falling back to a hidden textarea when the Clipboard API
 * is blocked. Resolves to whether the copy succeeded so callers can show copied feedback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }

  let copied = false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    copied = fallbackCopyToClipboard(text);
  }

  return copied;
}

// ---------------------------

//----------------- NOTIFICATION SOUND ------------

/** localStorage key holding the user's completion-sound preference. Private to the sound helpers. */
const NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = 'notificationSoundEnabled';

/** The browser's AudioContext constructor, including the webkit-prefixed fallback; undefined outside a browser. */
const AudioContextConstructor =
  typeof window !== 'undefined'
    ? window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : undefined;

/** Lazily created and reused, because browsers cap how many AudioContexts a page may open. */
let audioContext: AudioContext | null = null;

/** Reports whether the user has left completion sounds on; defaults to on when unset. */
export const isNotificationSoundEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') {
    return true;
  }

  return localStorage.getItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY) !== 'false';
};

/** Persists the user's completion-sound preference; call it from settings toggles. */
export const setNotificationSoundEnabled = (enabled: boolean): void => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, String(enabled));
};

/** Returns the shared AudioContext, creating it on first use. Private to the sound helpers. */
const getAudioContext = (): AudioContext | null => {
  if (!AudioContextConstructor) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContextConstructor();
  }

  return audioContext;
};

/** Schedules one synthesized sine tone on the shared context. Private to `playNotificationSound`. */
const playTone = (
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number,
  peakVolume: number,
): void => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startsAt);

  // Shape the volume so the synthesized tone starts and stops cleanly.
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(peakVolume, startsAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.02);
};

/**
 * Plays the two-tone notification chime, honouring the user's preference unless `force`
 * is set (settings previews pass `force` so the user can hear the sound while it is off).
 */
export const playNotificationSound = async ({ force = false } = {}): Promise<void> => {
  if (!force && !isNotificationSoundEnabled()) {
    return;
  }

  const context = getAudioContext();
  if (!context) {
    return;
  }

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }

    const now = context.currentTime;
    playTone(context, 740, now, 0.12, 0.075);
    playTone(context, 988, now + 0.11, 0.16, 0.06);
  } catch (error) {
    // Browsers may block audio until the page receives a user gesture.
    console.warn('Unable to play notification sound:', error);
  }
};

/** Plays the chime for a finished assistant turn; named for the chat call site it serves. */
export const playChatCompletionSound = (options = {}): Promise<void> => playNotificationSound(options);

// ---------------------------

//----------------- DOCUMENT TITLE ------------

/** Browser tab title shown when no project or session is selected. Private to the title helpers. */
const DEFAULT_PAGE_TITLE = 'CloudCLI UI';

/**
 * Resolves the human-readable label for a session, accounting for Cursor sessions that
 * carry a `name` instead of the summary the other providers return.
 */
export const getSessionTitle = (session: ProjectSession): string => {
  if (session.__provider === 'cursor') {
    return (session.name as string) || 'Untitled Session';
  }

  return (session.summary as string) || 'New Session';
};

/**
 * Builds the browser tab title for the current selection: the session title when one is
 * open, otherwise the project name, otherwise the app name.
 */
export const getPageTitle = (
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): string => {
  if (selectedSession) {
    return getSessionTitle(selectedSession);
  }

  const displayName = selectedProject?.displayName?.trim();
  return displayName ? `${displayName} - ${DEFAULT_PAGE_TITLE}` : DEFAULT_PAGE_TITLE;
};

/** Matches the awaiting-reply marker this module puts in the title, with or without a count. */
const AWAITING_REPLY_TITLE_PATTERN = /\[待回复(?: \d+)?\] /;

/** The `[Done]` marker `pageTitleNotification` owns; the awaiting marker is inserted after it so that helper's `startsWith` strip still works. Private to the title helpers. */
const COMPLETION_TITLE_PREFIX = '[Done] ';

/**
 * Keeps a `[待回复 N]` marker in the browser tab title while the sidebar's
 * awaiting-reply list is non-empty, and removes it once the list empties.
 *
 * Used by `useAwaitingReplySessions`, which is the only reader of that list and
 * therefore the only place that knows the count. A marker rather than a one-shot
 * flash: a wait stays until the user answers it, so the tab has to keep saying
 * so — including on the Windows taskbar, where the title is all the user sees
 * when the browser is behind another window.
 */
export const syncAwaitingReplyTitleIndicator = (count: number): void => {
  if (typeof document === 'undefined') {
    return;
  }

  const base = document.title.replace(AWAITING_REPLY_TITLE_PATTERN, '');
  if (count <= 0) {
    document.title = base;
    return;
  }

  const marker = `[待回复 ${count}] `;
  document.title = base.startsWith(COMPLETION_TITLE_PREFIX)
    ? `${COMPLETION_TITLE_PREFIX}${marker}${base.slice(COMPLETION_TITLE_PREFIX.length)}`
    : `${marker}${base}`;
};

// ---------------------------

//----------------- SESSION HOST HELD WORK ------------

/**
 * The held-work leases on one session's live host, in listing order.
 *
 * "Held work" is the two lease kinds that outlive the turn that started them —
 * a background task and a monitor — and is the whole set the resident pill
 * counts. It used to be what the transcript's background-task strip drew, but
 * that surface is retired: the activity dock's panel reads the session's own
 * task table, which is a different source, so the pill is the one reader left.
 * Derived from the `snapshot` argument rather than a hook so the reader does not
 * add an export to the hook module (a second export there would red every test
 * that mocks the hook wholesale). Read off the *listing*, not the transcript: the
 * work is a fact about the process the host layer holds, and the transcript only
 * knows it if a model happened to write it down.
 *
 * A session with no live host — or no session at all — has no held work and
 * answers with an empty list, not null: the caller's next question is always
 * "how many", and "no host" and "a host holding nothing" answer it the same way.
 */
export function findBackgroundTaskLeases(
  snapshot: SessionHostsSnapshot | null,
  appSessionId: string | null,
): Array<Extract<SessionHostLease, { kind: 'background-task' | 'monitor' }>> {
  if (!snapshot || !appSessionId) {
    return [];
  }
  for (const host of snapshot.hosts) {
    // A closed host keeps its bindings as the record of who it was serving, so
    // treating one as live would report work no process is holding any more.
    if (host.state === 'closed') {
      continue;
    }
    const binding = host.bindings.find((candidate) => candidate.appSessionId === appSessionId);
    if (binding) {
      return binding.leases.filter(
        (lease): lease is Extract<SessionHostLease, { kind: 'background-task' | 'monitor' }> =>
          lease.kind === 'background-task' || lease.kind === 'monitor',
      );
    }
  }
  return [];
}

//----------------- VOICE CLIENT ASSET PATHS ------------

/** The model-directory file names the server whitelists; the browser asks for exactly these two. */
const VOICE_CLIENT_MODEL_FILE = 'model.int8.onnx';
const VOICE_CLIENT_TOKENS_FILE = 'tokens.txt';

/**
 * Normalises Vite's `BASE_URL` into a leading-and-trailing-slash prefix, so concatenating a path onto
 * it can neither drop nor double a separator: `/`, `/sub/` and a bare `sub` all come out safe.
 */
function voiceClientBasePrefix(baseUrl: string | undefined): string {
  const raw = typeof baseUrl === 'string' ? baseUrl.trim() : '';
  if (raw === '' || raw === '/') return '/';
  return `${raw.startsWith('/') ? '' : '/'}${raw.replace(/\/+$/, '')}/`;
}

/**
 * The same-origin URLs the browser recogniser loads, all under one `BASE_URL` prefix.
 *
 * Use it wherever the client ASR path needs the model, the token list or the runtime: the server
 * serves the model directory at `/voice-client/model` and the `onnxruntime-web` distribution at
 * `/voice-client/ort`, and deriving both from `import.meta.env.BASE_URL` is what keeps a sub-path
 * deployment (`docs/nginx-subpath-template.conf`) working. Pass the raw `import.meta.env.BASE_URL`; a
 * missing or blank value is treated as the site root rather than producing a protocol-relative URL.
 */
export function voiceClientAssetPaths(baseUrl: string | undefined): VoiceClientAssetPaths {
  const prefix = voiceClientBasePrefix(baseUrl);
  return {
    modelUrl: `${prefix}voice-client/model/${VOICE_CLIENT_MODEL_FILE}`,
    tokensUrl: `${prefix}voice-client/model/${VOICE_CLIENT_TOKENS_FILE}`,
    ortScriptUrl: `${prefix}voice-client/ort/ort.wasm.min.mjs`,
    ortWasmPaths: `${prefix}voice-client/ort/`,
  };
}

// ---------------------------

//----------------- TIMESTAMP FORMATTING ------------

/**
 * Renders an ISO timestamp as a locale-aware relative reading ("3 hours ago").
 *
 * Use it wherever an absolute instant would make the reader do the arithmetic — the architecture
 * panel's analysis time and the mention hits' message times. `locale` is the INTERFACE language
 * (`i18n.language`), not the browser's, so the reading matches the surrounding labels. An
 * unparseable or missing timestamp reads `unknown` rather than throwing.
 */
export function formatRelativeTime(iso: string | null, locale: string): string {
  if (iso === null) return 'unknown';
  const analysed = Date.parse(iso);
  if (Number.isNaN(analysed)) return 'unknown';
  const seconds = Math.round((analysed - Date.now()) / 1000);
  const steps: readonly [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000],
    ['month', 2592000],
    ['day', 86400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ];
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size || unit === 'second') {
      return formatter.format(Math.round(seconds / size), unit);
    }
  }
  return formatter.format(seconds, 'second');
}

/**
 * The precise local instant behind a relative reading, for a `<time>` element's title attribute.
 *
 * Returns `undefined` for a missing or unparseable timestamp so callers can omit the attribute.
 */
export function formatAbsoluteTime(iso: string | null, locale: string): string | undefined {
  if (iso === null) return undefined;
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toLocaleString(locale);
}

// ---------------------------
