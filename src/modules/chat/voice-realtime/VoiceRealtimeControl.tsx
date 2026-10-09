import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Mic, Send, Square, Upload, XIcon } from 'lucide-react';

import { useVoiceRealtimeSession, type VoiceRealtimePhase } from '@/modules/chat/voice-realtime/useVoiceRealtimeSession';

type Props = {
  /**
   * The session a voice `session_send` is bound to — the one the chat pane is
   * showing. `null` (no session open) disables the control.
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
};

/** The one-line status the control shows while it is not idle. */
function phaseLabel(t: (key: string, options?: { defaultValue: string }) => string, phase: VoiceRealtimePhase): string {
  switch (phase) {
    case 'connecting':
      return t('voice.realtime.connecting', { defaultValue: 'Connecting voice…' });
    case 'listening':
      return t('voice.realtime.listening', { defaultValue: 'Listening…' });
    case 'understanding':
      return t('voice.realtime.understanding', { defaultValue: 'Understood — edit it, then send' });
    case 'sending':
      return t('voice.realtime.sending', { defaultValue: 'Sending…' });
    case 'sent':
      return t('voice.realtime.sent', { defaultValue: 'Sent — the reply will appear in the transcript' });
    case 'failed':
      return t('voice.realtime.failed', { defaultValue: 'Voice control stopped' });
    case 'idle':
      return '';
  }
}

const buttonClass =
  'inline-flex min-h-8 items-center gap-1.5 rounded-md border border-border/60 px-2.5 py-1 text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50';

/**
 * The voice control strip, rendered by the chat module's `ChatInterface` above
 * its composer.
 *
 * It is the user-facing half of GOAL-031 / AC-312: press the microphone, speak,
 * see the model's understanding of the instruction in an editable field, and
 * approve it. Reusing this app's transcript rendering instead of adding a
 * result component is part of the criterion — the send is an ordinary MCP
 * `session_send`, so its turn already renders like any other.
 */
export default function VoiceRealtimeControl({ sessionId, onSent }: Props) {
  const { t } = useTranslation('chat');
  const { phase, intent, error, setIntent, start, startWithFile, stop, approve, decline } = useVoiceRealtimeSession({
    sessionId,
    onSent,
  });
  const idle = phase === 'idle';
  // Only `useVoiceRealtimeSession.startWithFile` reads this input's selection; the
  // ref exists so the upload button can open the native file picker without a
  // second, visible `<input>`.
  const uploadInputRef = useRef<HTMLInputElement>(null);

  return (
    <div
      data-testid="voice-realtime-control"
      className="flex flex-wrap items-center gap-2 border-t border-border/40 px-3 py-2 text-xs text-muted-foreground"
    >
      {/* The raw phase, so a test can read the state without depending on copy. */}
      <span data-testid="voice-realtime-phase" className="sr-only">
        {phase}
      </span>

      {idle ? (
        <>
          <button
            type="button"
            data-testid="voice-realtime-start"
            onClick={start}
            disabled={!sessionId}
            title={t('voice.realtime.start', { defaultValue: 'Start voice control' })}
            className={buttonClass}
          >
            <Mic className="h-3.5 w-3.5" aria-hidden />
            {t('voice.realtime.start', { defaultValue: 'Start voice control' })}
          </button>
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
            data-testid="voice-realtime-upload"
            onClick={() => uploadInputRef.current?.click()}
            disabled={!sessionId}
            title={t('voice.realtime.upload', { defaultValue: 'Upload an audio file' })}
            className={buttonClass}
          >
            <Upload className="h-3.5 w-3.5" aria-hidden />
            {t('voice.realtime.upload', { defaultValue: 'Upload audio' })}
          </button>
        </>
      ) : (
        <>
          {phase === 'connecting' || phase === 'sending' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
          ) : (
            <Mic className="h-3.5 w-3.5" aria-hidden />
          )}
          <span data-testid="voice-realtime-status">{phaseLabel(t, phase)}</span>
        </>
      )}

      {phase === 'understanding' && (
        <div className="flex w-full flex-col gap-2">
          <textarea
            data-testid="voice-realtime-intent"
            aria-label={t('voice.realtime.intentLabel', { defaultValue: 'Instruction to send' })}
            value={intent}
            onChange={(event) => setIntent(event.target.value)}
            rows={2}
            className="w-full resize-none rounded-md border border-border/60 bg-background px-2 py-1 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" data-testid="voice-realtime-send" onClick={approve} className={buttonClass}>
              <Send className="h-3.5 w-3.5" aria-hidden />
              {t('voice.realtime.send', { defaultValue: 'Send' })}
            </button>
            <button type="button" data-testid="voice-realtime-cancel" onClick={decline} className={buttonClass}>
              <XIcon className="h-3.5 w-3.5" aria-hidden />
              {t('voice.realtime.cancel', { defaultValue: 'Cancel' })}
            </button>
          </div>
        </div>
      )}

      {error && (
        <span data-testid="voice-realtime-error" className="text-red-500">
          {error}
        </span>
      )}

      {!idle && (
        <button type="button" data-testid="voice-realtime-stop" onClick={stop} className={buttonClass}>
          <Square className="h-3.5 w-3.5" aria-hidden />
          {t('voice.realtime.stop', { defaultValue: 'Stop' })}
        </button>
      )}
    </div>
  );
}
