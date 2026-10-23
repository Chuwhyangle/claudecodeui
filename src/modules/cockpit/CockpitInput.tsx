import type { RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import type { VoiceInputState } from '@/shared/types';
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  VoiceInputButton,
} from '@/modules/chat';

/**
 * The cockpit's intent input, assembled from the chat module's own `PromptInput` family
 * rather than a copy: the same form shell, textarea, footer and submit button the composer
 * uses, entered through `@/modules/chat`'s barrel.
 *
 * WHAT IS DELIBERATELY NOT REUSED is `ChatComposer` itself: it is bound to one session's
 * permission, model and effort state, none of which a cockpit view has. Only the presentation
 * shell is shared.
 *
 * KEYBOARD OWNERSHIP. While this input has focus, the stage must keep its hands off: every key
 * (arrows included) is the input's. The stage's window-level handler bails on editable targets
 * (see `CockpitPage`), so the two never both react to the same press. Enter submits the
 * phrase; Shift+Enter keeps the textarea's newline behaviour.
 *
 * FOCUS IS EXPLICIT. The box does not take focus on load — the stage does, so the first arrow
 * press moves focus instead of landing in a textarea. `/` (handled by the page) and a pointer
 * are how a person enters the box; the forwarded ref is what makes the `/` shortcut able to
 * focus this exact element.
 */

export type CockpitInputProps = {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** The dictation hook's state, painted on the mic control beside the submit button. */
  voiceState: VoiceInputState;
  /** The mic control's press: the same start/stop the held Space key drives. */
  onVoiceToggle: () => void;
  /** True while a transcription request is outstanding for the recording listen. */
  voiceInFlight?: boolean;
  /** The page's handle on the textarea, used to focus it from the `/` shortcut. */
  textareaRef?: RefObject<HTMLTextAreaElement>;
};

/** Rendered by `CockpitPage` as the cockpit's only text entry point. */
export default function CockpitInput({
  value,
  onValueChange,
  onSubmit,
  voiceState,
  onVoiceToggle,
  voiceInFlight = false,
  textareaRef,
}: CockpitInputProps) {
  const { t } = useTranslation();

  return (
    <PromptInput
      data-testid="cockpit-input"
      className="w-full"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit(value);
      }}
    >
      <PromptInputBody>
        <PromptInputTextarea
          ref={textareaRef}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            // Enter submits the phrase; Shift+Enter stays a newline inside the textarea.
            if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              onSubmit(value);
            }
          }}
          placeholder={t('cockpit.intentPlaceholder')}
          aria-label={t('cockpit.intentPlaceholder')}
          rows={1}
        />
      </PromptInputBody>
      <PromptInputFooter>
        <span className="text-[11px] text-muted-foreground">{t('cockpit.pushToTalkHint')}</span>
        <div className="flex items-center gap-1">
          <VoiceInputButton
            state={voiceState}
            onToggle={onVoiceToggle}
            inFlight={voiceInFlight}
          />
          <PromptInputSubmit aria-label={t('cockpit.intentSubmit')} />
        </div>
      </PromptInputFooter>
    </PromptInput>
  );
}
