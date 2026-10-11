import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AudioLines, Loader2, LogOut, Mic, MicOff, RotateCcw } from 'lucide-react';

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
   * Whether the session is busy — a turn is in flight, so the person's next words can only wait.
   *
   * Supplied by `ChatInterface` from the session's own activity reading rather than read off the
   * connection: the connection does not know whether Claude is mid-turn. It gates the ONE extra
   * reading this bar shows while the session cannot take an instruction — how long the session has
   * been busy and how many bytes of the person's speech are waiting on it — so "your words are
   * waiting" is visible before the backlog reaches the budget and a refusal is what says so.
   */
  busy?: boolean;
};

/** The bar's single status word; the caption, once there is one, takes its place on screen. */
function phaseLabel(
  t: (key: string, options?: { defaultValue: string }) => string,
  phase: VoiceRealtimePhase,
  disconnected: boolean,
): string {
  if (phase === 'idle' && disconnected) {
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
 */
function Waveform({ levelRef, active }: { levelRef: VoiceRealtimeSession['levelRef']; active: boolean }) {
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

  return (
    <span data-testid="voice-realtime-wave" aria-hidden className="flex h-5 w-[3.25rem] flex-shrink-0 items-center gap-[2px]">
      {Array.from({ length: WAVE_BARS }, (_, index) => (
        <span
          key={index}
          ref={(node) => {
            columns.current[index] = node;
          }}
          className="w-[2px] rounded-full bg-primary/70"
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
 */
export default function VoiceRealtimeBar({ voice, onExit, modelMenu, banner, busy = false }: Props) {
  const { t } = useTranslation('chat');
  const { phase, error, unansweredSeconds, captions, levelRef, connectedAt, disconnected, start, startWithFile, mute, unmute, end, refusal, queuedDepth, queuedBytes, stopped } = voice;
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
  const canRetry = phase === 'failed' || (phase === 'idle' && disconnected);

  const lastCaption = captions.length > 0 ? captions[captions.length - 1].text : '';
  const status = phaseLabel(t, phase, disconnected);
  /**
  /**
   * The endpoint heard the last utterance and never answered it. This is the bar's STATUS that
   * changes — not the caption slot, and not the error line: the turn is over and the session is
   * fine, so what the person needs to read is the outcome of what they just said. It holds until a
   * delivery answers it (the hook clears it on `sent`) or the connection ends; a session that has
   * truly failed reports the failure instead, which is why `failed` wins.
   */
  const unanswered = unansweredSeconds !== null && phase !== 'failed';
  /**
   * What the status slot reads while the proxy is refusing deliveries.
   *
   * It takes the STATUS cell rather than the caption's, on purpose. The caption is the person's own
   * last words, and the one thing a refusal must not do is hide them: the refused sentence stays
   * readable on the line below while this line says it did not go. Reusing the status cell also
   * keeps the bar's fixed height — the row already truncates, so a longer sentence cannot push the
   * layout taller.
   */
  const refusedLabel = refusal
    ? t('voice.realtime.refused', { defaultValue: 'Queue full — that one was not sent' })
    : null;
  /**
   * What the status slot reads after a spoken stop.
   *
   * A stop ends ONE run; it does not cancel the messages already accepted, and the person has to be
   * told that, or the stop reads as "everything I said is gone". The copy names the count the proxy
   * reported (`depth`) — the same number `data-queued-depth` carries — so it is a reading, not a
   * reassurance. It takes the status cell and holds until the next delivery lands.
   */
  const stoppedLabel = stopped
    ? t('voice.realtime.stopped', {
        defaultValue: 'Stopped the current turn — {{depth}} still queued',
        depth: String(stopped.depth),
      })
    : null;
  /**
   * The observed delivery depth, on the status cell whether or not anything was refused.
   *
   * A refusal needs a number to be legible ("three of your messages are already waiting"), and the
   * waiting itself — before any refusal — is the state a person has to be able to see: this is the
   * seam AC-327's sibling case reads to prove the depth really climbed while the turn was in flight.
   * It sits beside the refusal rather than inside it, so the two readings stay apart: `data-refusal`
   * answers "did that one go?", `data-queued-depth` answers "how much is the session holding?".
   */
  const depth = String(queuedDepth);
  /**
   * What the status cell reads while the session is BUSY: how long it has been busy and how much of
   * the person's speech is waiting on it, in bytes.
   *
   * The byte reading is the whole point of this task's admission change — the relay admits by a UTF-8
   * byte budget, not a message count — so the number a person sees has to be the number that decides
   * delivery. It is shown while busy whether or not anything is refused, because the state worth
   * catching is the backlog building up to the budget, not the refusal after it. `data-queued-bytes`
   * carries the same number for a test to read without depending on copy.
   */
  const busyLabel = busy
    ? t('voice.realtime.busy', {
        defaultValue: 'Busy {{elapsed}} · {{bytes}} bytes waiting',
        elapsed: formatElapsed(connectedAt === null ? 0 : now - connectedAt),
        bytes: String(queuedBytes),
      })
    : null;
  const muteLabel = muted ? t('voice.realtime.unmute', { defaultValue: 'Unmute' }) : t('voice.realtime.mute', { defaultValue: 'Mute' });

  const handleEnd = () => {
    end();
    onExit();
  };

  return (
    <div className="chat-composer-shell relative flex-shrink-0 px-2 pb-2 sm:px-4 sm:pb-4 md:pb-6">
      <div className="relative mx-auto max-w-[54.25rem]">
        {banner}
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
              muted || canRetry ? 'bg-muted text-muted-foreground' : 'bg-primary text-primary-foreground'
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
              <Waveform levelRef={levelRef} active={phase === 'listening'} />
              <span data-testid="voice-realtime-elapsed" className="flex-shrink-0 tabular-nums">
                {formatElapsed(connectedAt === null ? 0 : now - connectedAt)}
              </span>
              <span
                data-testid="voice-realtime-status"
                data-refusal={refusal ? refusal.reason : undefined}
                data-queued-depth={depth}
                data-queued-bytes={String(queuedBytes)}
                data-busy={busy ? 'true' : undefined}
                className="min-w-0 truncate"
              >
                {stoppedLabel ? (
                  <span data-testid="voice-realtime-stopped" className="text-amber-600 dark:text-amber-400">
                    {stoppedLabel}
                  </span>
                ) : refusedLabel ?? (busyLabel ?? (unanswered ? (
                  <span data-testid="voice-realtime-unanswered" className="text-amber-600 dark:text-amber-400">
                    {t('voice.realtime.unanswered', { defaultValue: 'No answer — say it again' })}
                  </span>
                ) : (
                  status
                )))}
              </span>
            </div>
            <span
              data-testid="voice-realtime-caption"
              className="block truncate text-sm text-foreground"
              title={lastCaption || undefined}
            >
              {error ? <span data-testid="voice-realtime-error" className="text-destructive">{error}</span> : lastCaption || ' '}
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
          {canRetry && (
            <button
              type="button"
              data-testid="voice-realtime-retry"
              onClick={start}
              aria-label={t('voice.realtime.retry', { defaultValue: 'Reconnect voice' })}
              title={t('voice.realtime.retry', { defaultValue: 'Reconnect voice' })}
              className={iconButtonClass}
            >
              <RotateCcw className="h-4 w-4" aria-hidden />
            </button>
          )}
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
            itself is the same pure icon square as the controls to its left (Mute, Retry): it shares
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
