import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { FileAudio, Loader2 } from 'lucide-react';

import { PromptInputButton } from '@/modules/chat/composer/PromptInput';
import type { VoiceInputState } from '@/shared/types';

type Props = {
  /** Hands the chosen file to the voice chain. Owned by the composer, which owns the hook. */
  onSelectFile: (file: File) => void;
  state: VoiceInputState;
};

/**
 * The file-upload entry into the voice path, rendered by chat's ChatComposer beside the microphone.
 *
 * Presentational, like VoiceInputButton: it owns a hidden `<input type="file">` and nothing else. What
 * the chosen file then travels — decode, trim, upload, repair, composer — belongs to `useVoiceInput`,
 * and is deliberately the same chain a recording travels rather than a second one beside it.
 *
 * It exists so a known piece of audio can drive that chain in a real browser, which is what makes the
 * chain reproducible without a microphone. ChatComposer renders it only while the voice debug switch
 * is on, so the composer of an install that never asks for it is unchanged.
 */
export default function VoiceUploadButton({ onSelectFile, state }: Props) {
  const { t } = useTranslation('chat');
  const inputRef = useRef<HTMLInputElement | null>(null);

  // One label, read by both the tooltip and the accessible name, for the same reason
  // VoiceInputButton has one: the tooltip is not announced, so the button needs `aria-label` too, and
  // two expressions would let the announced name drift from the visible one.
  const label = t('voice.uploadFile', { defaultValue: 'Upload audio file' });

  return (
    <span className="relative inline-flex">
      {/*
        Hidden rather than styled: the button above it is the control the user sees and the only one in
        the tab order, and this is the file dialog that control opens. `accept` is what makes the dialog
        useful, but it is not a stable handle for telling this input apart from the composer's attachment
        picker (also an `<input type="file">` in the same footer) or from the realtime voice control's own
        `accept="audio/*"` input, which shares the page. This entry claims its element with a test id of
        its own instead, the same way the realtime control names its input.
      */}
      <input
        ref={inputRef}
        type="file"
        accept="audio/*"
        data-testid="voice-upload-input"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0] ?? null;
          // Cleared before the upload starts: an input that still holds the file fires no change event
          // when the same file is picked again, which would make the second attempt do nothing.
          event.target.value = '';
          if (file) onSelectFile(file);
        }}
      />
      <PromptInputButton
        tooltip={{ content: label }}
        aria-label={label}
        onClick={(e: { preventDefault: () => void }) => {
          e.preventDefault();
          inputRef.current?.click();
        }}
      >
        {state === 'transcribing' ? <Loader2 className="animate-spin" /> : <FileAudio />}
      </PromptInputButton>
    </span>
  );
}
