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

/**
 * The cockpit dock's phone touch floor. The chat composer ships 32px icon buttons, which is right
 * for a mouse; on a phone the same controls must be 44×44 (the product's touch target, the size the
 * header's mode switch already uses). The `md:` reset hands the desktop its original 32px box back,
 * so the wide layout is byte-for-byte unchanged.
 *
 * Exported because the cockpit test asserts the class SET rather than measuring a box: jsdom applies
 * no stylesheet, so a height reading there would be noise.
 */
export const COCKPIT_PHONE_TOUCH_TARGET_CLASS = 'min-h-[44px] min-w-[44px] md:min-h-0 md:min-w-0';

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
          // The dock stays one line on a phone, but its line is a touch target: 44px minimum,
          // the same floor the mic and send buttons carry.
          className="min-h-[44px]"
        />
      </PromptInputBody>
      <PromptInputFooter className="py-1 sm:py-2">
        {/* The push-to-talk hint is coaching, not a control: on a phone the dock's height is the
            stage's height, so the sentence yields to the buttons. */}
        <span className="hidden text-[11px] text-muted-foreground sm:inline">
          {t('cockpit.pushToTalkHint')}
        </span>
        <div className="flex items-center gap-1">
          <VoiceInputButton
            state={voiceState}
            onToggle={onVoiceToggle}
            inFlight={voiceInFlight}
            className={COCKPIT_PHONE_TOUCH_TARGET_CLASS}
          />
          <PromptInputSubmit
            aria-label={t('cockpit.intentSubmit')}
            className={COCKPIT_PHONE_TOUCH_TARGET_CLASS}
          />
        </div>
      </PromptInputFooter>
    </PromptInput>
  );
}
