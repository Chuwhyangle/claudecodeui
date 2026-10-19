import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronRight, Mic, Square, Loader2, XIcon } from 'lucide-react';

import { voiceErrorMessage, voiceErrorTechnicalDetail } from '@/modules/chat/utils/voiceErrorMessages';
import type { VoiceFailureReport, VoiceInputState } from '@/shared/types';

type Props = {
  state: VoiceInputState;
  onToggle: () => void;
  /**
   * Whether a transcription request is outstanding for the listen that is still recording.
   *
   * Draws a small pulsing dot beside the red square. Optional, and absent means "nothing in
   * flight", so every existing caller (and every standalone render) is unchanged.
   */
  inFlight?: boolean;
};

/**
 * The fold's own name, announced but never displayed.
 *
 * A literal rather than a locale key, for two reasons that are both mechanical. `voice.errors` names
 * FAILURES, so none of its members is a label for a disclosure; and no locale publishes a
 * technical-details key this build could borrow (`misc.errorDetails` exists in two languages, and
 * `permissions.codex.technicalDetails` is a settings surface for another provider). Adding a key is
 * out of this task's write surface. What is left is the shape the sibling fold in
 * `PermissionRequestsBanner` already ships — a literal on a `<summary>` — and the fact that this one
 * is only ever announced, never rendered: it is an attribute, so it cannot reach the bubble's text.
 */
const DETAILS_LABEL = 'Technical details';

// Rendered by chat's ChatComposer next to the send button.
// Push-to-talk mic button (presentational). Recording state and the stop-and-send action
// are owned by the composer so the main Send button can drive them too. This button just
// starts recording and, while recording, stops and drops the transcript into the input box.
//
// It renders the button and NOTHING ELSE. The failure notice that belongs beside it is a
// sibling of the composer's form rather than a child of this button — see `VoiceFailureNotice`.
export default function VoiceInputButton({ state, onToggle, inFlight = false }: Props) {
  const { t } = useTranslation('chat');

  const icon =
    state === 'recording' ? (
      <Square className="h-4 w-4 text-red-500" />
    ) : state === 'transcribing' ? (
      <Loader2 className="h-4 w-4 animate-spin" />
    ) : (
      <Mic className="h-4 w-4" />
    );

  // One label, read by the native title (hover) and the accessible name. The title is
  // not announced, so the button needs `aria-label` too, and two separate expressions
  // would let the announced name drift from the visible one.
  const label = state === 'recording' ? t('voice.stopRecording') : t('voice.input');

  return (
    <button
      type="button"
      // The in-flight dot is positioned against this button, so it has to be the containing block.
      // The shell is the permission menu trigger's chip — a bordered muted square — so the mic sits
      // beside the model and permission selectors as one of them rather than a bare ghost icon.
      className="relative flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-muted/50 text-muted-foreground transition-colors hover:bg-muted"
      data-testid="voice-input-button"
      aria-label={label}
      title={label}
      onClick={(e: { preventDefault: () => void }) => {
        e.preventDefault();
        onToggle();
      }}
    >
      {icon}
      {/*
        The one piece of feedback that a request is out: a small pulsing dot beside the red square.

        It is a span inside the button rather than a control of its own — no new button, no copy,
        no locale key — so the composer's control set is unchanged. `motion-safe:` gates the pulse
        so a reader with reduced-motion on gets a still dot rather than an animation. `aria-hidden`
        because it carries no text and the button's own name already says what pressing it does.
      */}
      {inFlight && (
        <span
          data-testid="voice-inflight-dot"
          aria-hidden="true"
          className="pointer-events-none absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-red-500 motion-safe:animate-pulse"
        />
      )}
    </button>
  );
}

/**
 * The notice a failed recognition leaves on screen, and the fold that carries its machine-readable half.
 *
 * WHY IT IS NOT RENDERED INSIDE THE BUTTON. The mic button lives in the composer's footer, and the
 * composer's form is `relative overflow-hidden` (`PromptInput`'s own shell, so that the textarea's
 * highlight layer can be clipped to its rounded corners). A notice anchored to the button and drawn
 * above it therefore grows out of the form's box and is CLIPPED: the visible part is the slice inside
 * the form, and the close control — the notice's top row — sits outside it, where the chat pane is the
 * element that actually receives a pointer. The app already draws its other floating layer this way:
 * `ChatComposer` puts the activity indicator in `chat-composer-shell`, a sibling of the form, for the
 * same reason. This component is rendered from there, so its `bottom-full` is the shell's top edge.
 *
 * It renders a REPORT rather than a sentence: which sentence a refusal gets is the user's language's
 * answer, so it is resolved here, at render, through the same translator the rest of the composer
 * uses. The machine-readable half (the status, the code strings) is folded away rather than shown — it
 * is what a reader matches against a log, not what a user needs in order to act, and the notice must
 * not read as the transport's own vocabulary.
 */
export function VoiceFailureNotice({ failure, onDismiss }: {
  failure: VoiceFailureReport;
  onDismiss?: () => void;
}) {
  const { t } = useTranslation('chat');
  const { t: tCommon } = useTranslation('common');
  // Whether the technical-detail fold is open. It belongs to this component and outlives nothing:
  // a new failure starts folded (see the reset below), and the fold only exists while a failure is
  // shown, so no other component has an opinion about it.
  const [detailsOpen, setDetailsOpen] = useState(false);

  // A chain-local failure (a recording that never reached the recogniser, a playback the browser
  // blocked) is already a sentence the chain wrote, and it is shown as it stands. A refusal arrives
  // as the fields its answer carried and becomes the sentence the user's language has for its code.
  const message = typeof failure === 'string' ? failure : voiceErrorMessage(failure, t);
  const technicalDetail = typeof failure === 'string' ? '' : voiceErrorTechnicalDetail(failure);

  // The failure the fold's open state belongs to. A second failure replaces the first, and the replacement
  // starts folded — the fold is opened by a user who went looking for the codes, and carrying "open" across
  // failures would show them unbidden. Adjusting state during render is React's own answer to "reset derived
  // state when a prop changes"; an effect here would render the new failure unfolded for a frame first.
  const [reportedFailure, setReportedFailure] = useState<VoiceFailureReport>(failure);
  if (failure !== reportedFailure) {
    setReportedFailure(failure);
    setDetailsOpen(false);
  }

  return (
    /*
      The notice's own text is the sentence and NOTHING else. The composer criteria read this layer's
      `textContent` for equality with the localized sentence (a `includes` reading would pass on the
      right copy with the transport's sentence glued to it), so both controls below carry an icon and
      their name in an attribute: text nodes here would be concatenated onto the sentence by design,
      not by accident.

      The horizontal offset matches the composer shell's own padding, so the notice is aligned with the
      mic button that raised it rather than with the shell's border box.
    */
    <span
      data-testid="voice-error-notice"
      className="absolute bottom-full left-2 z-20 mb-1 flex max-w-[min(22rem,calc(100vw-2rem))] flex-col gap-1 rounded bg-red-600 px-2 py-1 text-xs text-white shadow-lg sm:left-4"
    >
      <span className="flex items-start gap-1.5">
        <span data-testid="voice-error-message" className="min-w-0 break-words">
          {message}
        </span>
        {/*
          The span a continuous listen's failed segment occupied. A long dictation is many uploads,
          and a failure is about one of them rather than the whole recording, so the sentence alone
          would not say WHICH words are missing. Absent on the single-request path, where the failure
          is the whole recording and the sentence already says so.
        */}
        {typeof failure !== 'string' && failure.startSec !== undefined && failure.endSec !== undefined && (
          <span data-testid="voice-error-segment" className="shrink-0 tabular-nums text-red-100">
            {`${failure.startSec.toFixed(2)}–${failure.endSec.toFixed(2)}s`}
          </span>
        )}
        <button
          type="button"
          data-testid="voice-error-close"
          aria-label={tCommon('buttons.close')}
          title={tCommon('buttons.close')}
          onClick={onDismiss}
          className="shrink-0 cursor-pointer rounded p-0.5 hover:bg-red-700 focus:outline-none focus-visible:ring-1 focus-visible:ring-white"
        >
          <XIcon className="h-3 w-3" />
        </button>
      </span>
      {technicalDetail !== '' && (
        <details
          data-testid="voice-error-details"
          onToggle={(event) => setDetailsOpen(event.currentTarget.open)}
          className="border-t border-red-400/60 pt-0.5"
        >
          <summary
            data-testid="voice-error-details-summary"
            aria-label={DETAILS_LABEL}
            title={DETAILS_LABEL}
            className="inline-flex cursor-pointer list-none items-center text-red-100 hover:text-white"
          >
            <ChevronRight className={`h-3 w-3 transition-transform${detailsOpen ? ' rotate-90' : ''}`} />
          </summary>
          {/*
            Mounted only while the fold is open: a `<pre>` that is merely hidden still carries
            its text, and the notice's `textContent` is asserted to be the sentence alone.
          */}
          {detailsOpen && (
            <pre
              data-testid="voice-error-technical"
              className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-red-100"
            >
              {technicalDetail}
            </pre>
          )}
        </details>
      )}
    </span>
  );
}
