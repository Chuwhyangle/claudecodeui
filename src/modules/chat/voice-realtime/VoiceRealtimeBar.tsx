import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Mic, MicOff, PhoneOff } from 'lucide-react';

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
 * The fixed, compact Live Voice control bar (GOAL-033 / AC-316), rendered by
 * `ChatInterface` in place of `ChatComposer` while `composerMode === 'voice'`.
 *
 * The bar never grows: the same mic-state/label + Mute + End row renders at idle,
 * connecting, listening, muted and failed alike, on both the desktop and the
 * 375px layout. There is no draft-and-confirm step — a model-proposed
 * `session_send` executes the moment it is called (see
 * `voice-realtime-ws-proxy.service.ts`), and its turn appears through the
 * ordinary `mcp`-source transcript rendering.
 *
 * It owns no connection state of its own (see `voice`), so the ONLY thing that
 * moves between phases is the status text and the mic icon.
 */
export default function VoiceRealtimeBar({ voice, onExit }: Props) {
  const { t } = useTranslation('chat');
  const { phase, error, startWithFile, mute, unmute, end } = voice;
  // The hidden file input is the AC-315/AC-316 test-injection seam: no visible
  // button opens it. A real user never sees or reaches it; a Playwright spec
  // drives it directly via `setInputFiles` on its testid.
  const uploadInputRef = useRef<HTMLInputElement>(null);

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
          aria-pressed={muted}
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
