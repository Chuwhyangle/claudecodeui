import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AudioLines, Loader2, LogOut, Mic, MicOff } from 'lucide-react';

import type { VoiceRealtimePhase, VoiceRealtimeSession } from '@/modules/chat/voice-realtime/useVoiceRealtimeSession';

type Props = {
  /**
   * The Live Voice connection, owned by `ChatInterface`.
   *
   * Lifted to the pane rather than created here because the pane also renders the
   * transcript, and AC-317 requires the model's transcription of the user's audio
   * to appear THERE — as a user message — not inside this bar. A hook owned by the
   * bar could not reach it without a second copy of the state.
   */
  voice: VoiceRealtimeSession;
  /** Leaves Live Voice mode, returning the composer area to `ChatComposer`. */
  onExit: () => void;
  /**
   * The composer's own model picker, drawn at the bar's trailing side. It chooses the model for
   * Claude Code's next run — the Realtime model is fixed for a connection — which is why it carries
   * no "switch voice model" meaning here.
   */
  modelMenu?: ReactNode;
  /**
   * Content drawn directly ABOVE the bar inside the same composer shell — the pending
   * permission/question surface `ChatInterface` keeps answerable while Live Voice is active.
   *
   * It is a slot rather than a permission-specific prop so the bar stays a bar: it owns no
   * knowledge of what a request is, only where such content goes. Because the composer is
   * anchored to the bottom of the pane, content here grows the shell UPWARD — the bar itself
   * keeps its fixed height and its position, so entering/exiting this surface never moves it.
   */
  banner?: ReactNode;
  /**
   * The per-utterance withdrawal rows (GOAL-041 / AC-351), drawn directly above the bar.
   *
   * A second slot rather than content folded into `banner`: this is not a request to answer, it is
   * the queue's own account of the sentences the session is still holding — each of which the person
   * can take back by itself. It sits between the banner and the bar so the growing stack pushes the
   * banner up, never the fixed-height bar down. The bar draws it and knows nothing more about it.
   */
  pendingUtterances?: ReactNode;
  /**
   * Whether the session is busy — a turn is in flight, so the person's next words can only wait.
   *
   * Supplied by `ChatInterface` from the session's own activity reading rather than read off the
   * connection: the connection does not know whether Claude is mid-turn. The bar carries it as a
   * DIAGNOSTIC attribute only — the status cell says nothing about the backlog any more (the
   * operator's ruling: the bar shows the connection phase and nothing else), so a busy session is
   * visible to a test through `data-busy` and to the person through the transcript.
   */
  busy?: boolean;
};

/**
 * The bar's single status word; the caption, once there is one, takes its place on screen.
 *
 * A DISCONNECT OUTRANKS THE PHASE (AC-367). The voice connection can die while the page's own socket
 * stays open — the journal's shape: the upstream goes `closed` and the segments after it come back
 * `lost(connection-closed)` — and the phase alone then still reads `listening`, so gating this copy on
 * `phase === 'idle'` left the bar saying "Listening…" over a microphone with nowhere to send. A
 * `failed` session is the one exception: its reason is the more important reading, and `disconnected`
 * is true for every failed socket too (the close follows the error), so the failure keeps its word.
 */
function phaseLabel(
  t: (key: string, options?: { defaultValue: string }) => string,
  phase: VoiceRealtimePhase,
  disconnected: boolean,
): string {
  if (disconnected && phase !== 'failed') {
    return t('voice.realtime.disconnected', { defaultValue: 'Voice disconnected' });
  }
  switch (phase) {
    case 'idle':
    case 'connecting':
      return t('voice.realtime.connecting', { defaultValue: 'Connecting voice…' });
    case 'listening':
      return t('voice.realtime.listening', { defaultValue: 'Listening…' });
    case 'muted':
      return t('voice.realtime.muted', { defaultValue: 'Muted' });
    case 'failed':
      return t('voice.realtime.failed', { defaultValue: 'Voice control stopped' });
  }
}

/**
 * The i18n key of the ONE sentence the caption line carries when the voice connection fails.
 *
 * The person is told what to do, not what broke (operator's ruling, 2026-10-14: the page must offer
 * one understandable reason instead of the server's raw technical text). The classification reads
 * the `code` the hook recorded off the error frame — the browser's own failures (the socket's
 * `onerror`, a WebSocket that will not construct, a microphone that will not open) get a local code
 * there, because no frame ever carries one for them. An unrecognised code, and no code at all, both
 * fall to the generic copy: guessing a more specific reason would be worse than saying less.
 */
function errorCopyKey(code: string | null): string {
  switch (code) {
    case 'CONNECTION_FAILED':
    case 'CONNECTION_LOST':
    case 'TRANSPORT':
    case 'SOCKET_ERROR':
      return 'voice.realtime.errors.connectionFailed';
    case 'SPEND_LIMIT':
      return 'voice.realtime.errors.spendLimit';
    case 'MISSING_API_KEY':
      return 'voice.realtime.errors.missingCredential';
    case 'MIC_UNAVAILABLE':
      return 'voice.realtime.errors.micUnavailable';
    default:
      return 'voice.realtime.errors.generic';
  }
}

/** English fallbacks for `errorCopyKey`'s keys, so a locale missing one still reads a sentence. */
const ERROR_COPY_DEFAULTS: Record<string, string> = {
  'voice.realtime.errors.connectionFailed': 'Voice connection failed — exit and start Live Voice again.',
  'voice.realtime.errors.spendLimit': 'This voice session reached its spending limit — exit and start Live Voice again.',
  'voice.realtime.errors.missingCredential': 'The server has no voice service credentials configured.',
  'voice.realtime.errors.micUnavailable': 'Cannot use the microphone.',
  'voice.realtime.errors.generic': 'Voice error — exit and start Live Voice again.',
};

/** The number of waveform columns; fixed so the bar's width never depends on the signal. */
const WAVE_BARS = 12;

const iconButtonClass =
  'inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border border-border/60 text-foreground transition-colors hover:bg-accent disabled:opacity-50';

/** `mm:ss` for the connection's running time. */
function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/**
 * Fixed-width level meter. Heights come from `levelRef` on the bar's own animation frames and are
 * written straight to the DOM, so the pane is not re-rendered at the audio rate. While muted the
 * level is 0 and every column rests at its minimum — a static line.
 *
 * `suspended` greys the columns without touching the phase: a browser-forced microphone suspension
 * is shown by colour alone (the operator ruled out the red error line for it), and it is a
 * different state machine from Mute even though the grey tone is the same.
 */
function Waveform({
  levelRef,
  active,
  suspended,
}: {
  levelRef: VoiceRealtimeSession['levelRef'];
  active: boolean;
  suspended: boolean;
}) {
  const columns = useRef<Array<HTMLSpanElement | null>>([]);
  useEffect(() => {
    if (!active) {
      columns.current.forEach((column) => column && (column.style.height = '3px'));
      return;
    }
    const history = new Array<number>(WAVE_BARS).fill(0);
    let frame = 0;
    let last = 0;
    const draw = (now: number) => {
      if (now - last >= 60) {
        last = now;
        history.shift();
        history.push(levelRef.current);
        columns.current.forEach((column, index) => {
          if (column) column.style.height = `${3 + Math.round(history[index] * 17)}px`;
        });
      }
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [levelRef, active]);

  // The suspended tone is an existing muted-foreground shade, not a new accent: the bar's own
  // vocabulary has no dedicated "suspended" colour, and introducing one would read as a third state.
  const barClass = suspended ? 'w-[2px] rounded-full bg-muted-foreground/50' : 'w-[2px] rounded-full bg-primary/70';

  return (
    <span data-testid="voice-realtime-wave" aria-hidden className="flex h-5 w-[3.25rem] flex-shrink-0 items-center gap-[2px]">
      {Array.from({ length: WAVE_BARS }, (_, index) => (
        <span
          key={index}
          ref={(node) => {
            columns.current[index] = node;
          }}
          className={barClass}
          style={{ height: 3 }}
        />
      ))}
    </span>
  );
}

/**
 * The fixed, compact Live Voice control bar (GOAL-033 / AC-316), rendered by
 * `ChatInterface` in place of `ChatComposer` while `composerMode === 'voice'`.
 *
 * It is drawn in the composer's own shell (same padding, width cap, rounded
 * bordered container) at a fixed height, so entering Live Voice changes the
 * box's contents and nothing else: `[status] [wave · mm:ss · live caption]
 * [model] [Mute] │ [Exit]`. The caption is the last utterance the model heard,
 * truncated to its own flex cell — it can never push the row taller. There is
 * no draft-and-confirm step: a model-proposed `session_send` executes the
 * moment it is called, and its turn appears through the ordinary transcript.
 *
 * LEAVING IS NOT STOPPING. The trailing `Exit` leaves the live mode; the running
 * turn is the transcript row's own Stop, and this bar carries none. So Exit is
 * drawn apart from the controls to its left — behind a divider, and as the same
 * pure icon square the controls beside it are (`iconButtonClass`, `LogOut`), never
 * the solid red square a Stop is — because the one mistake this layout must not
 * invite is reading "leave the microphone" as "cancel the run".
 *
 * It owns no connection state (see `voice`); only the elapsed clock and the
 * level meter, both display-only, live here.
 *
 * `banner` is the one row allowed above the bar — the pending permission/question
 * surface, without which Live Voice would put an answerable prompt out of reach.
 *
 * WHAT THE BAR SAYS IS ONLY WHERE THE CONNECTION IS (operator's ruling, 2026-10-14). The status
 * cell reads the phase and nothing else — no stop's queue count, no refusal, no busy backlog, no
 * unanswered turn, no "heard but not forwarded" — because the page had become too much mixed
 * information in one place. Queue accounting belongs to the queue's own rows above the bar; the
 * words the model did not pass on are the transcript's business, not a fourth thing to read down
 * here. Failure is the one exception, and it is not a status: it replaces the caption line for as
 * long as it lasts, with a single sentence saying what to do. There is deliberately no reconnect
 * control and no auto-reconnect — a connection that died stays dead until the person leaves and
 * comes back.
 */
export default function VoiceRealtimeBar({ voice, onExit, modelMenu, banner, pendingUtterances, busy = false }: Props) {
  const { t } = useTranslation('chat');
  const { phase, error, errorCode, captions, levelRef, connectedAt, disconnected, micSuspended, startWithFile, mute, unmute, end, refusal, queuedDepth, queuedBytes } = voice;
  // The hidden file input is the AC-315/AC-316 test-injection seam: no visible
  // button opens it. A real user never sees or reaches it; a Playwright spec
  // drives it directly via `setInputFiles` on its testid.
  const uploadInputRef = useRef<HTMLInputElement>(null);
  // Re-renders the bar once a second so the clock advances; the connection start is the source of truth.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (connectedAt === null) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [connectedAt]);

  const muted = phase === 'muted';
  const connecting = (phase === 'connecting' || phase === 'idle') && !disconnected;
  const canToggleMute = phase === 'listening' || phase === 'muted';

  const lastCaption = captions.length > 0 ? captions[captions.length - 1].text : '';
  /**
   * The status cell reads the CONNECTION PHASE and nothing else (operator's ruling, 2026-10-14).
   *
   * The five readings that used to outrank it here — a spoken stop's queue count, a refusal, the
   * busy backlog in bytes, an unanswered turn, an utterance the model chose not to forward — are
   * gone from this cell: the page was "too much mixed information", and a queue's own account of
   * itself belongs in the queue's rows above the bar, not squeezed into the one word that also has
   * to say "Listening…". Their readings survive as `data-*` on the same span (below), so they stay
   * observable without being copy.
   */
  const status = phaseLabel(t, phase, disconnected);
  /**
   * The observed delivery depth and byte budget, carried as diagnostics on the status cell.
   *
   * They are no longer rendered as copy, but they are still the readings a test needs without
   * depending on the bar's wording: `data-refusal` answers "did that one go?", `data-queued-depth`
   * answers "how much is the session holding?", `data-queued-bytes` and `data-busy` place the
   * backlog against the byte budget the relay actually admits by.
   */
  const depth = String(queuedDepth);
  const muteLabel = muted ? t('voice.realtime.unmute', { defaultValue: 'Unmute' }) : t('voice.realtime.mute', { defaultValue: 'Mute' });

  const handleEnd = () => {
    end();
    onExit();
  };

  return (
    <div className="chat-composer-shell relative flex-shrink-0 px-2 pb-2 sm:px-4 sm:pb-4 md:pb-6">
      <div className="relative mx-auto max-w-[54.25rem]">
        {banner}
        {pendingUtterances}
        <div
          data-testid="voice-realtime-bar"
          data-slot="live-voice-bar"
          className="relative flex h-16 items-center gap-2 overflow-hidden rounded-xl border border-border/50 bg-card/80 px-2 shadow-sm backdrop-blur-sm sm:px-3"
        >
          {/* The raw phase, so a test can read the state without depending on copy. */}
          <span data-testid="voice-realtime-phase" className="sr-only">
            {phase}
          </span>

          <span
            data-testid="voice-realtime-state-icon"
            className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full ${
              muted ? 'bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground'
            }`}
          >
            {connecting ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <AudioLines className="h-4 w-4" aria-hidden />
            )}
          </span>

          <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5 text-xs">
            <div className="flex items-center gap-2 text-muted-foreground">
              {/* A disconnected connection has nowhere to send, so the meter rests: a live-looking
                  waveform beside "Voice disconnected" would be the same lie this bar exists to stop. */}
              <Waveform levelRef={levelRef} active={phase === 'listening' && !disconnected} suspended={micSuspended} />
              <span data-testid="voice-realtime-elapsed" className="flex-shrink-0 tabular-nums">
                {formatElapsed(connectedAt === null ? 0 : now - connectedAt)}
              </span>
              {/*
                The connection phase, and nothing else. The readings that used to outrank it here
                (a stop's queue count, a refusal, the busy backlog in bytes, an unanswered turn, an
                utterance the model did not forward) are gone from the cell — what is left is the one
                word that answers "is the microphone still going?", with those readings kept as
                `data-*` below so they stay observable without being copy.
              */}
              <span
                data-testid="voice-realtime-status"
                data-refusal={refusal ? refusal.reason : undefined}
                data-queued-depth={depth}
                data-queued-bytes={String(queuedBytes)}
                data-busy={busy ? 'true' : undefined}
                className="min-w-0 truncate"
              >
                {status}
              </span>
            </div>
            {/*
              The caption line, and the ONE place a failure is explained. On error it carries a
              single readable sentence naming what to do — never the upstream's raw technical text,
              which is not something a person can act on and, untranslated, was not even in their
              language. That raw message is not thrown away: it becomes this element's `title`, so
              the exact text stays one hover (and one attribute read) away.
            */}
            <span
              data-testid="voice-realtime-caption"
              className="block truncate text-sm text-foreground"
              title={error ? error : lastCaption || undefined}
            >
              {error ? (
                <span data-testid="voice-realtime-error" className="text-destructive">
                  {t(errorCopyKey(errorCode), { defaultValue: ERROR_COPY_DEFAULTS[errorCopyKey(errorCode)] })}
                </span>
              ) : (
                lastCaption || ' '
              )}
            </span>
          </div>

          {modelMenu && <div className="flex flex-shrink-0 items-center">{modelMenu}</div>}

          <input
            ref={uploadInputRef}
            type="file"
            accept="audio/*"
            data-testid="voice-realtime-upload-input"
            className="sr-only"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) {
                startWithFile(file);
              }
            }}
          />
          {/*
            No reconnect control. A dead voice connection is left dead and the person is told to
            leave and come back (the reason sentence on the caption line) — the operator's ruling
            against a one-press retry and against any auto-reconnect: a silently re-opened
            microphone is worse than one that stayed off.
          */}
          <button
            type="button"
            data-testid="voice-realtime-mute"
            onClick={muted ? unmute : mute}
            disabled={!canToggleMute}
            aria-pressed={muted}
            aria-label={muteLabel}
            title={muteLabel}
            className={iconButtonClass}
          >
            {muted ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
          </button>
          {/*
            Leaving the mode, told apart from stopping the turn. The trailing group is fenced off
            from the controls beside it by a divider — separated by position, not by a different
            shape — so "leave the microphone" cannot be read as "cancel what Claude is doing". Exit
            itself is the same pure icon square as the control to its left (Mute): it shares
            `iconButtonClass` — same `h-10 w-10` target and same `text-foreground` — draws the
            leaving glyph `LogOut`, and carries no visible text. `title` and `aria-label` name it at
            every width. It is never the solid red square a Stop is. One wrapper (not a bare divider
            plus a button) so the fence costs a single gap, not two.
          */}
          <span className="flex flex-shrink-0 items-center border-l border-border/60 pl-1.5 sm:pl-2">
            <button
              type="button"
              data-testid="voice-realtime-end"
              onClick={handleEnd}
              aria-label={t('voice.realtime.exit', { defaultValue: 'Exit Live Voice' })}
              title={t('voice.realtime.exit', { defaultValue: 'Exit Live Voice' })}
              className={iconButtonClass}
            >
              <LogOut className="h-4 w-4" aria-hidden />
            </button>
          </span>
        </div>
      </div>
    </div>
  );
}
