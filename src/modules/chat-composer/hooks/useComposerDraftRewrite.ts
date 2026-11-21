import { useCallback } from 'react';
import type { MutableRefObject } from 'react';

import { useDraftRewrite } from '@/modules/chat-composer/hooks/useDraftRewrite';
import type { UseDraftRewriteResult } from '@/modules/chat-composer/hooks/useDraftRewrite';

/**
 * The ✦ candidate bound to the composer's ONE draft writer.
 *
 * A whole-text replacement invalidates everything keyed to the old bytes — the voice insertion
 * range is remapped (not left pointing into the old text), a model-chip attribution is forfeited,
 * and the expansion chain anchored on the old draft is dropped — then both draft stores are
 * written so an immediate Enter sends the candidate. It never submits.
 *
 * The candidate shares the reply-suggestions settings/budget but is available on any non-blank
 * draft. It is reset by every path that ends the draft's identity (edit, clear, send, scope
 * change via the controller's context, unmount via the hook's dispose); those reset points stay
 * with the composer because only it sees all of them.
 */
type UseComposerDraftRewriteArgs = {
  sessionId: string | null;
  draftScope: string | null;
  draft: string;
  enabled: boolean | null;
  inputValueRef: MutableRefObject<string>;
  clearExpansion: () => void;
  noteDraftEdit: (text: string) => void;
  remapVoiceRangeOnEdit: (previous: string, next: string) => void;
  setInputFromHistory: (value: string) => void;
};

export function useComposerDraftRewrite({
  sessionId,
  draftScope,
  draft,
  enabled,
  inputValueRef,
  clearExpansion,
  noteDraftEdit,
  remapVoiceRangeOnEdit,
  setInputFromHistory,
}: UseComposerDraftRewriteArgs): UseDraftRewriteResult {
  const applyDraftRewriteText = useCallback((text: string) => {
    const previous = inputValueRef.current;
    clearExpansion();
    noteDraftEdit(text);
    remapVoiceRangeOnEdit(previous, text);
    setInputFromHistory(text);
  }, [clearExpansion, inputValueRef, noteDraftEdit, remapVoiceRangeOnEdit, setInputFromHistory]);

  return useDraftRewrite({
    sessionId,
    draftScope,
    draft,
    enabled,
    writeDraft: applyDraftRewriteText,
  });
}
