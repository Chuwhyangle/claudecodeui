import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { VoiceFailureReport, VoiceInputState } from '@/shared/types';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  useVoiceInput,
} from '@/modules/chat';
import type { VoiceCaptureEngine } from '@/modules/chat';
import { useCockpitHub } from '@/modules/cockpit/hooks/useCockpitHub';

/**
 * The phone remote (`/cockpit/remote`): the input half of the cockpit, on the device that is
 * always in hand. The stage stays on the desktop; this page sends direction keys, phrases and
 * the one confirmation that releases a message.
 *
 * WHY THIS PAGE HOLDS NO COCKPIT STATE. Focus, view, the tray and the pending card live in the
 * server-side hub. This page announces the `input` role only, sends events, and renders the
 * state the hub broadcasts back — so what it echoes is what the desktop is showing, not a
 * second opinion. It never reports a visible set: a report from a phone would describe a page
 * nobody is looking at and would overwrite the set the confirmation card is built from.
 *
 * DICTATION IS THE COMPOSER'S OWN HOOK. `useVoiceInput` is the repository's single ASR path;
 * holding the big button starts exactly the session the chat box's mic starts, and the text
 * lands in THIS page's input box rather than being sent. A speak-then-send is still two acts.
 *
 * TWO HONEST LIMITS ARE STATED, NOT HIDDEN. A phone browser allows the microphone only in a
 * secure context (HTTPS or localhost), so an insecure page disables the button and says why —
 * typing and the direction pads keep working. And a screen lock interrupts a recording unless a
 * wake lock is held; when the lock cannot be acquired the page says so rather than pretending
 * the listen is safe.
 */

export type CockpitRemoteProps = {
  /**
   * Where the audio comes from. Absent is the shipping microphone engine; a test hands in a fake
   * so it can push PCM without an audio thread or a microphone.
   */
  captureEngine?: VoiceCaptureEngine;
};

/** The Screen Wake Lock API as this page uses it, typed locally: it is not in every DOM lib. */
type WakeLockSentinelLike = { release: () => Promise<void> };
type WakeLockNavigator = Navigator & {
  wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
};

/** One direction, as the pad draws it. */
type Direction = 'up' | 'down' | 'left' | 'right';

/** The translation key for one direction pad's accessible name. */
const DIRECTION_LABEL_KEY: Record<Direction, string> = {
  up: 'cockpit.remoteMoveUp',
  down: 'cockpit.remoteMoveDown',
  left: 'cockpit.remoteMoveLeft',
  right: 'cockpit.remoteMoveRight',
};

/** The glyph drawn in the cell; language-neutral, so it needs no translation. */
const DIRECTION_GLYPH: Record<Direction, string> = {
  up: '↑',
  down: '↓',
  left: '←',
  right: '→',
};

/** A stable identifier for one pending card, so a second confirm click inside it is ignored. */
function pendingKeyOf(pending: { text: string; target: { sessionId: string } | null } | null): string | null {
  if (pending === null) return null;
  return `${pending.target?.sessionId ?? 'none'}|${pending.text}`;
}

/** Rendered by `App` for the `/cockpit/remote` route. */
export default function CockpitRemote({ captureEngine }: CockpitRemoteProps = {}) {
  const { t } = useTranslation();
  // Input only: see the module comment for why a remote must not report visibility.
  const hub = useCockpitHub({ roles: ['input'] });
  const hubState = hub.state;

  const [text, setText] = useState('');
  const [voiceNotice, setVoiceNotice] = useState<string | null>(null);
  const [wakeLockNotice, setWakeLockNotice] = useState<string | null>(null);
  // The card this page has already confirmed. State (not a ref) so the button repaints disabled
  // immediately; cleared when the hub broadcasts a different card or none.
  const [confirmedKey, setConfirmedKey] = useState<string | null>(null);

  // A microphone is only available in a secure context. Anything else still types and steers.
  const secureContext = typeof window === 'undefined' ? true : window.isSecureContext !== false;

  /** The recogniser's hotwords: the labels of what the desktop is showing, taken from the hub. */
  const candidates = useMemo(
    () => [...new Set(hubState.visible.focusables.map((object) => object.label).filter((label) => label !== ''))],
    [hubState.visible.focusables],
  );

  // The text the box held when THIS listen opened: a dictation appends to the draft rather than
  // replacing what the person typed before pressing the button.
  const voiceBaseRef = useRef('');
  const previousVoiceStateRef = useRef<VoiceInputState>('idle');

  const voice = useVoiceInput(
    (dictated) => {
      const base = voiceBaseRef.current.trim();
      setText(base === '' ? dictated : `${base} ${dictated}`);
    },
    (failure: VoiceFailureReport) => {
      setVoiceNotice(typeof failure === 'string' ? failure : failure.code ?? 'VOICE_FAILED');
    },
    {
      scope: 'cockpit',
      ...(captureEngine === undefined ? {} : { captureEngine }),
      candidates,
    },
  );

  useEffect(() => {
    const previous = previousVoiceStateRef.current;
    previousVoiceStateRef.current = voice.state;
    if (voice.state === 'recording' && previous !== 'recording') {
      voiceBaseRef.current = text;
      setVoiceNotice(null);
    }
  }, [text, voice.state]);

  // A hold that was released before the microphone finished opening must not leave the recorder
  // running: `started` remembers that this listen belongs to a press, and the effect below stops
  // it as soon as it actually begins.
  const pressRef = useRef({ active: false, started: false });
  const beginPress = useCallback(() => {
    if (!secureContext) return;
    pressRef.current.active = true;
    if (voice.state === 'idle') {
      pressRef.current.started = true;
      voice.toggle();
    }
  }, [secureContext, voice]);
  const endPress = useCallback(() => {
    if (!pressRef.current.active) return;
    pressRef.current.active = false;
    // `started` stays set until the listen actually ends: the release may arrive while the
    // microphone is still opening, and the effect below then closes it as soon as it opens.
    if (!pressRef.current.started) return;
    voice.stop();
  }, [voice]);
  const stop = voice.stop;
  useEffect(() => {
    if (!pressRef.current.started) return;
    if (voice.state === 'recording' && !pressRef.current.active) {
      stop();
      return;
    }
    if (voice.state === 'idle') {
      pressRef.current.started = false;
    }
  }, [stop, voice.state]);

  // Keep the screen awake while the microphone is open. The lock is released on stop and on
  // unmount; a failure is stated, because a locked screen really does cut the capture short.
  useEffect(() => {
    if (voice.state !== 'recording') {
      setWakeLockNotice(null);
      return undefined;
    }
    const wakeLock = (navigator as WakeLockNavigator).wakeLock;
    if (wakeLock === undefined) {
      setWakeLockNotice(t('cockpit.remoteWakeLockFailed'));
      return undefined;
    }
    let cancelled = false;
    let sentinel: WakeLockSentinelLike | null = null;
    wakeLock
      .request('screen')
      .then((granted) => {
        if (cancelled) {
          void granted.release().catch(() => undefined);
          return;
        }
        sentinel = granted;
        setWakeLockNotice(null);
      })
      .catch(() => {
        if (!cancelled) setWakeLockNotice(t('cockpit.remoteWakeLockFailed'));
      });
    return () => {
      cancelled = true;
      if (sentinel !== null) void sentinel.release().catch(() => undefined);
    };
  }, [t, voice.state]);

  const focusObject = useMemo(
    () =>
      hubState.focusUri === null
        ? null
        : hubState.visible.focusables.find((object) => object.uri === hubState.focusUri) ?? null,
    [hubState.focusUri, hubState.visible.focusables],
  );

  const pending = hubState.pendingSend;
  const pendingKey = pendingKeyOf(pending);
  const target = pending?.target ?? null;
  const confirmDisabled = pendingKey === null || confirmedKey === pendingKey;

  useEffect(() => {
    setConfirmedKey(null);
  }, [pendingKey]);

  const submit = useCallback(
    (value: string) => {
      const phrase = value.trim();
      if (phrase === '') return;
      setText('');
      setVoiceNotice(null);
      hub.dispatch({ type: 'utterance', text: phrase });
    },
    [hub],
  );

  const confirm = useCallback(() => {
    if (pendingKey === null || confirmedKey === pendingKey) return;
    setConfirmedKey(pendingKey);
    // Exactly one confirm leaves this page for one card. The hub is the second guard: it closes
    // the card before its send awaits, so a duplicate that slips through sends nothing.
    hub.dispatch({ type: 'confirm' });
  }, [confirmedKey, hub, pendingKey]);

  const cancel = useCallback(() => {
    hub.dispatch({ type: 'cancel' });
  }, [hub]);

  const pinned = hubState.focusUri !== null && hubState.tray.includes(hubState.focusUri);

  const holdLabel =
    voice.state === 'recording'
      ? t('cockpit.remoteListening')
      : voice.state === 'transcribing'
        ? t('cockpit.remoteTranscribing')
        : t('cockpit.remoteHoldToTalk');

  const renderDirectionButton = (direction: Direction) => (
    <button
      type="button"
      data-testid={`cockpit-remote-move-${direction}`}
      aria-label={t(DIRECTION_LABEL_KEY[direction])}
      onClick={() => hub.dispatch({ type: 'move', direction })}
      className="flex h-16 items-center justify-center rounded-lg border border-border/60 bg-card text-2xl active:bg-accent"
    >
      {DIRECTION_GLYPH[direction]}
    </button>
  );

  return (
    <div
      className="flex min-h-screen flex-col gap-3 bg-background px-4 py-4 text-foreground"
      data-testid="cockpit-remote"
      data-cockpit-connected={hub.connected ? 'true' : 'false'}
      data-cockpit-pending={pendingKey === null ? undefined : pendingKey}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border/40 pb-2">
        <div className="flex flex-col">
          <span className="text-base font-semibold">{t('cockpit.remoteTitle')}</span>
          <span className="text-[11px] text-muted-foreground">{t('cockpit.remoteHint')}</span>
        </div>
        <span
          className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
          data-testid="cockpit-remote-connection"
        >
          {hub.connected ? t('cockpit.remoteConnected') : t('cockpit.remoteDisconnected')}
        </span>
      </header>

      {/* What the desktop has focused, echoed here so the person knows what a phrase will act on. */}
      <div
        className="rounded border border-border/60 bg-muted/30 px-3 py-2"
        data-testid="cockpit-remote-focus"
        data-cockpit-focus={hubState.focusUri ?? undefined}
      >
        <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
          {t('cockpit.focus')}
        </span>
        <p className="text-sm font-medium" data-testid="cockpit-remote-focus-label">
          {focusObject?.label ?? t('cockpit.noFocus')}
          {focusObject !== null && (
            <span className="ml-2 text-[11px] font-normal text-muted-foreground">
              {focusObject.display.status}
            </span>
          )}
        </p>
      </div>

      {/*
        The pad is a cross, not a row: ↑ above and ← ↓ → below it, so the thumb finds a
        direction by where it is rather than by reading the label. The empty corners keep the
        three occupied cells in their physical places.
      */}
      <section
        className="grid grid-cols-3 gap-2"
        aria-label={t('cockpit.remoteDirectionPad')}
      >
        <span aria-hidden="true" />
        {renderDirectionButton('up')}
        <span aria-hidden="true" />
        {renderDirectionButton('left')}
        {renderDirectionButton('down')}
        {renderDirectionButton('right')}
      </section>

      <section className="grid grid-cols-2 gap-2">
        <button
          type="button"
          data-testid="cockpit-remote-zoom-in"
          aria-label={t('cockpit.remoteZoomIn')}
          onClick={() => hub.dispatch({ type: 'zoom', direction: 'in' })}
          className="flex h-14 items-center justify-center rounded-lg border border-border/60 bg-card text-sm active:bg-accent"
        >
          {t('cockpit.remoteZoomIn')}
        </button>
        <button
          type="button"
          data-testid="cockpit-remote-zoom-out"
          aria-label={t('cockpit.remoteZoomOut')}
          onClick={() => hub.dispatch({ type: 'zoom', direction: 'out' })}
          className="flex h-14 items-center justify-center rounded-lg border border-border/60 bg-card text-sm active:bg-accent"
        >
          {t('cockpit.remoteZoomOut')}
        </button>
        <button
          type="button"
          data-testid="cockpit-remote-back"
          aria-label={t('cockpit.remoteBack')}
          onClick={() => hub.dispatch({ type: 'back' })}
          className="flex h-14 items-center justify-center rounded-lg border border-border/60 bg-card text-sm active:bg-accent"
        >
          {t('cockpit.remoteBack')}
        </button>
        <button
          type="button"
          data-testid="cockpit-remote-pin"
          aria-label={pinned ? t('cockpit.remoteUnpin') : t('cockpit.remotePin')}
          disabled={hubState.focusUri === null}
          onClick={() => {
            if (hubState.focusUri === null) return;
            hub.dispatch(
              pinned
                ? { type: 'unpin', uri: hubState.focusUri }
                : { type: 'pin' },
            );
          }}
          className="flex h-14 items-center justify-center rounded-lg border border-border/60 bg-card text-sm active:bg-accent disabled:opacity-50"
        >
          {pinned ? t('cockpit.remoteUnpin') : t('cockpit.remotePin')}
        </button>
      </section>

      {/*
        The confirmation card. It is drawn from the hub's own copy, so the preview is exactly
        what a confirm would send — project, conversation, text and the references that ride
        along. 「确认」 is on this device because the person who spoke is holding it.
      */}
      {pending !== null && (
        <div
          className="rounded border border-border/60 bg-muted/40 px-3 py-2"
          data-testid="cockpit-remote-pending"
          data-cockpit-send-source={target?.source ?? 'none'}
        >
          {target !== null ? (
            <>
              <p className="text-sm" data-testid="cockpit-remote-preview-line">
                {t('cockpit.sendPreview', {
                  project: target.projectName ?? target.projectId ?? '',
                  session: target.sessionTitle ?? target.sessionId,
                  text: pending.text,
                })}
              </p>
              <p className="text-[11px] text-muted-foreground" data-testid="cockpit-remote-references">
                {t('cockpit.sendReferences', {
                  refs: [
                    ...(pending.focusUri === null ? [] : [pending.focusUri]),
                    ...pending.visible.map((object) => `${object.label} → ${object.uri}`),
                  ].join('；'),
                })}
              </p>
            </>
          ) : (
            <p className="text-sm text-amber-700 dark:text-amber-300" data-testid="cockpit-remote-no-target">
              {pending.reason === 'no-focus'
                ? t('cockpit.noFocusTarget', { text: pending.text })
                : t('cockpit.noTargetSession', { text: pending.text })}
            </p>
          )}
        </div>
      )}

      {/*
        The two acts on a card, always in the same place. With nothing pending the confirm is
        disabled rather than absent — that is what makes "there is nothing to release" readable —
        and cancel is disabled for the same reason.
      */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          data-testid="cockpit-remote-confirm"
          aria-label={t('cockpit.remoteConfirm')}
          disabled={confirmDisabled}
          onClick={confirm}
          className="flex h-14 items-center justify-center rounded-lg bg-foreground text-sm font-semibold text-background disabled:opacity-50"
        >
          {t('cockpit.remoteConfirm')}
        </button>
        <button
          type="button"
          data-testid="cockpit-remote-cancel"
          aria-label={t('cockpit.remoteCancel')}
          disabled={pending === null}
          onClick={cancel}
          className="flex h-14 items-center justify-center rounded-lg border border-border/60 text-sm disabled:opacity-50"
        >
          {t('cockpit.remoteCancel')}
        </button>
      </div>

      <button
        type="button"
        data-testid="cockpit-remote-hold"
        aria-label={holdLabel}
        aria-pressed={voice.state === 'recording'}
        disabled={!secureContext}
        onPointerDown={(event) => {
          event.preventDefault();
          // Capture the pointer so a small drift of the thumb does not look like a release.
          try {
            event.currentTarget.setPointerCapture(event.pointerId);
          } catch {
            // jsdom and a browser without pointer capture both land here; the press still works.
          }
          beginPress();
        }}
        onPointerUp={endPress}
        onPointerCancel={endPress}
        onContextMenu={(event) => event.preventDefault()}
        className="flex h-28 select-none flex-col items-center justify-center rounded-2xl bg-foreground text-background disabled:opacity-50"
      >
        <span className="text-lg font-semibold">{holdLabel}</span>
        {voice.inFlight && (
          <span className="text-[11px] opacity-70" data-testid="cockpit-remote-in-flight">
            {t('cockpit.remoteTranscribing')}
          </span>
        )}
      </button>

      {!secureContext && (
        <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="cockpit-remote-insecure">
          {t('cockpit.remoteInsecureContext')}
        </p>
      )}
      {voiceNotice !== null && (
        <p className="text-xs text-red-600 dark:text-red-400" data-testid="cockpit-remote-voice-error">
          {voiceNotice}
        </p>
      )}
      {wakeLockNotice !== null && (
        <p className="text-xs text-amber-700 dark:text-amber-300" data-testid="cockpit-remote-wakelock">
          {wakeLockNotice}
        </p>
      )}

      <PromptInput
        data-testid="cockpit-remote-input"
        className="mt-auto w-full"
        onSubmit={(event) => {
          event.preventDefault();
          submit(text);
        }}
      >
        <PromptInputBody>
          <PromptInputTextarea
            value={text}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                submit(text);
              }
            }}
            placeholder={t('cockpit.remoteInputPlaceholder')}
            aria-label={t('cockpit.remoteInputPlaceholder')}
            rows={2}
          />
        </PromptInputBody>
        <PromptInputFooter>
          <span className="text-[11px] text-muted-foreground">{t('cockpit.remoteTypeHint')}</span>
          <PromptInputSubmit aria-label={t('cockpit.remoteSubmit')} />
        </PromptInputFooter>
      </PromptInput>
    </div>
  );
}
