import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AudioLines, Loader2, Mic, MicOff, RotateCcw, Square } from 'lucide-react';

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
 * [model] [Mute] [End]`. The caption is the last utterance the model heard,
 * truncated to its own flex cell — it can never push the row taller. There is
 * no draft-and-confirm step: a model-proposed `session_send` executes the
 * moment it is called, and its turn appears through the ordinary transcript.
 *
 * It owns no connection state (see `voice`); only the elapsed clock and the
 * level meter, both display-only, live here.
 */
export default function VoiceRealtimeBar({ voice, onExit, modelMenu }: Props) {
  const { t } = useTranslation('chat');
  const { phase, error, unansweredSeconds, captions, levelRef, connectedAt, disconnected, start, startWithFile, mute, unmute, end, refusal, queuedDepth } = voice;
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
   * The observed delivery depth, on the status cell whether or not anything was refused.
   *
   * A refusal needs a number to be legible ("three of your messages are already waiting"), and the
   * waiting itself — before any refusal — is the state a person has to be able to see: this is the
   * seam AC-327's sibling case reads to prove the depth really climbed while the turn was in flight.
   * It sits beside the refusal rather than inside it, so the two readings stay apart: `data-refusal`
   * answers "did that one go?", `data-queued-depth` answers "how much is the session holding?".
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
                className="min-w-0 truncate"
              >
                {refusedLabel ?? (unanswered ? (
                  <span data-testid="voice-realtime-unanswered" className="text-amber-600 dark:text-amber-400">
                    {t('voice.realtime.unanswered', { defaultValue: 'No answer — say it again' })}
                  </span>
                ) : (
                  status
                ))}
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
          <button
            type="button"
            data-testid="voice-realtime-end"
            onClick={handleEnd}
            aria-label={t('voice.realtime.end', { defaultValue: 'End' })}
            title={t('voice.realtime.end', { defaultValue: 'End Live Voice' })}
            className="inline-flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-destructive text-destructive-foreground shadow-sm transition-colors hover:bg-destructive/90"
          >
            <Square className="h-4 w-4 fill-current" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
