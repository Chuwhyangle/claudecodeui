import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Mic, MicOff, PhoneOff } from 'lucide-react';

import { useVoiceRealtimeSession, type VoiceRealtimePhase } from '@/modules/chat/voice-realtime/useVoiceRealtimeSession';

type Props = {
  /**
   * The session a voice `session_send` is bound to — the one the chat pane is
   * showing. `null` (no session open) disables the bar.
   */
  sessionId: string | null;
  /**
   * Called once the server confirms a `session_send`.
   *
   * An MCP-source run writes into the session's history rather than into this
   * page's live connection, so the transcript only shows the turn after it is
   * re-read. Consumed by `ChatInterface`, which passes its own
   * `requestLatestMessages`.
   */
  onSent?: (() => void) | undefined;
  /** Leaves Live Voice mode, returning the composer area to `ChatComposer`. */
  onExit: () => void;
};

/** The one-line status the bar shows for each phase. */
function phaseLabel(t: (key: string, options?: { defaultValue: string }) => string, phase: VoiceRealtimePhase): string {
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

const controlButtonClass =
  'inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50';

/**
 * The window flag a Playwright spec sets (via `addInitScript`, before
 * navigation) to suppress the automatic `start()` this bar otherwise fires on
 * mount. Without it every criterion that wants to exercise the file-upload
 * injection path would also open a real (faked) microphone connection first,
 * racing two `/voice-realtime` sockets against each other. Mirrors the
 * existing `__voiceFake` test seam's shape: a window global, read only here,
 * never true in a production build.
 */
const AUTO_START_SKIP_FLAG = '__voiceRealtimeSkipAutoStart';

/**
 * The fixed, compact Live Voice control bar (GOAL-033 / AC-316), rendered by
 * `ChatInterface` in place of `ChatComposer` while `composerMode === 'voice'`.
 *
 * Unlike the earlier `VoiceRealtimeControl`, this bar never grows: the same
 * mic-state/label + Mute + End row renders at idle, connecting, listening,
 * muted and failed alike, on both the desktop and the 375px layout. There is
 * no draft-and-confirm step — a model-proposed `session_send` executes the
 * moment it is called (see `voice-realtime-ws-proxy.service.ts`), and its
 * turn appears through the ordinary `mcp`-source transcript rendering, same
 * as before.
 */
export default function VoiceRealtimeBar({ sessionId, onSent, onExit }: Props) {
  const { t } = useTranslation('chat');
  const { phase, error, start, startWithFile, mute, unmute, end } = useVoiceRealtimeSession({
    sessionId,
    onSent,
  });
  // The hidden file input is the AC-315/AC-316 test-injection seam: no
  // visible button opens it. A real user never sees or reaches it; a
  // Playwright spec drives it directly via `setInputFiles` on its testid.
  const uploadInputRef = useRef<HTMLInputElement>(null);

  // Live Voice captures continuously from the moment the mode is entered —
  // there is no "press start" gesture in the shipped UI. The skip flag lets
  // a test that wants the file-injection path instead suppress this and
  // drive `startWithFile` itself.
  useEffect(() => {
    if (typeof window !== 'undefined' && (window as unknown as Record<string, unknown>)[AUTO_START_SKIP_FLAG]) {
      return;
    }
    start();
    // Runs once per mount; `start` is stable for the lifetime of this component instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const muted = phase === 'muted';
  const canToggleMute = phase === 'listening' || phase === 'muted';

  const handleEnd = () => {
    end();
    onExit();
  };

  return (
    <div
      data-testid="voice-realtime-bar"
      className="flex min-h-12 flex-shrink-0 items-center justify-between gap-2 border-t border-border/40 px-3 py-2 text-xs text-muted-foreground"
    >
      {/* The raw phase, so a test can read the state without depending on copy. */}
      <span data-testid="voice-realtime-phase" className="sr-only">
        {phase}
      </span>

      <div className="flex min-w-0 items-center gap-2">
        {phase === 'connecting' || phase === 'idle' ? (
          <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin" aria-hidden />
        ) : muted ? (
          <MicOff className="h-4 w-4 flex-shrink-0" aria-hidden />
        ) : (
          <Mic className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden />
        )}
        <span data-testid="voice-realtime-status" className="truncate">
          {phaseLabel(t, phase)}
        </span>
        {error && (
          <span data-testid="voice-realtime-error" className="truncate text-red-500">
            {error}
          </span>
        )}
      </div>

      <div className="flex flex-shrink-0 items-center gap-2">
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
        <button
          type="button"
          data-testid="voice-realtime-mute"
          onClick={muted ? unmute : mute}
          disabled={!canToggleMute}
          title={muted ? t('voice.realtime.unmute', { defaultValue: 'Unmute' }) : t('voice.realtime.mute', { defaultValue: 'Mute' })}
          className={controlButtonClass}
        >
          {muted ? <Mic className="h-3.5 w-3.5" aria-hidden /> : <MicOff className="h-3.5 w-3.5" aria-hidden />}
          {muted ? t('voice.realtime.unmute', { defaultValue: 'Unmute' }) : t('voice.realtime.mute', { defaultValue: 'Mute' })}
        </button>
        <button type="button" data-testid="voice-realtime-end" onClick={handleEnd} className={controlButtonClass}>
          <PhoneOff className="h-3.5 w-3.5" aria-hidden />
          {t('voice.realtime.end', { defaultValue: 'End' })}
        </button>
      </div>
    </div>
  );
}
