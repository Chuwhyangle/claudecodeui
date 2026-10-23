import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';

import {
  clearQueuedMessage,
  hydrateChatDrafts,
  readQueuedMessage,
  writeQueuedMessage,
} from '@/shared/chatDrafts';
import type { QueuedDraft } from '@/shared/types';

/**
 * The durable queue card for a message typed while a turn was already running.
 *
 * The VPS dispatcher owns sending a queued message; this hook owns only the
 * client's half — restoring the record when its session opens, persisting
 * edits, noticing when the server claims the card, and turning it back into
 * editable draft state. The record is keyed by session, and the owner ref is
 * what keeps a session switch from writing one session's draft under another's
 * key in the commit where both values have moved.
 */

const restoreQueuedDraft = (sessionKey: string): QueuedDraft | null => {
  const saved = readQueuedMessage(sessionKey);
  return saved
    ? {
        content: saved.content,
        attachments: [],
        uploadedAttachments: saved.attachments ?? saved.images,
        options: saved.options,
      }
    : null;
};

type UseDraftStateArgs = {
  sessionKey: string | null;
  setInput: Dispatch<SetStateAction<string>>;
  /** The send-time mirror of the draft, written in the same tick as the state. */
  inputValueRef: MutableRefObject<string>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  /** Adopting a queued draft's attachments puts them back in the composer's attachment state. */
  setAttachedFiles: Dispatch<SetStateAction<File[]>>;
};

export function useDraftState({
  sessionKey,
  setInput,
  inputValueRef,
  textareaRef,
  setAttachedFiles,
}: UseDraftStateArgs) {
  // Restored synchronously so a reload shows the message that is waiting rather
  // than after the drafts request lands.
  const [queuedDraft, setQueuedDraft] = useState<QueuedDraft | null>(() => {
    if (typeof window === 'undefined' || !sessionKey) {
      return null;
    }
    return restoreQueuedDraft(sessionKey);
  });
  // Which session the in-memory `queuedDraft` belongs to. On a session switch
  // there is one commit where `sessionKey` already points at the new session
  // while `queuedDraft` still holds the old session's draft; the persistence
  // effect must not write across that gap.
  const queuedDraftSessionRef = useRef<string | null>(sessionKey);

  // The VPS dispatcher owns sending. While the card is visible, periodically
  // reconcile only its removal so the UI notices when the server claims it.
  useEffect(() => {
    if (!sessionKey || !queuedDraft) {
      return;
    }
    let cancelled = false;
    const reconcile = async () => {
      await hydrateChatDrafts();
      if (!cancelled && !readQueuedMessage(sessionKey)) {
        queuedDraftSessionRef.current = sessionKey;
        setQueuedDraft(null);
      }
    };
    const timer = setInterval(() => void reconcile(), 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [queuedDraft, sessionKey]);

  // Persist the queued draft under its session's key. Must be defined BEFORE
  // the swap effect below: on a session switch there is one commit where
  // `sessionKey` already points at the new session while `queuedDraft` (and
  // the owner ref) still describe the old one — the ref mismatch makes this
  // effect skip that commit instead of writing/clearing across sessions.
  useEffect(() => {
    if (!sessionKey || queuedDraftSessionRef.current !== sessionKey) {
      return;
    }
    if (
      queuedDraft
      && (queuedDraft.content.trim() || (queuedDraft.uploadedAttachments?.length ?? 0) > 0)
    ) {
      writeQueuedMessage(sessionKey, {
        content: queuedDraft.content,
        options: queuedDraft.options,
        attachments: queuedDraft.uploadedAttachments,
      });
    } else {
      clearQueuedMessage(sessionKey);
    }
  }, [queuedDraft, sessionKey]);

  // Switching sessions swaps in that session's queued draft. Browser File
  // objects are local to the mounted composer, while their already-uploaded
  // descriptors restore from storage and remain sendable.
  useEffect(() => {
    queuedDraftSessionRef.current = sessionKey;
    if (!sessionKey) {
      setQueuedDraft(null);
      return;
    }
    setQueuedDraft(restoreQueuedDraft(sessionKey));
  }, [sessionKey]);

  /** Takes the queued message back into the box so the user can change and send it. */
  const editQueuedDraft = useCallback(() => {
    if (!queuedDraft) {
      return;
    }
    setQueuedDraft(null);
    setInput(queuedDraft.content);
    inputValueRef.current = queuedDraft.content;
    setAttachedFiles(queuedDraft.attachments);
    textareaRef.current?.focus();
  }, [queuedDraft, setInput, inputValueRef, setAttachedFiles, textareaRef]);

  const deleteQueuedDraft = useCallback(() => {
    setQueuedDraft(null);
  }, []);

  return {
    queuedDraft,
    setQueuedDraft,
    queuedDraftSessionRef,
    editQueuedDraft,
    deleteQueuedDraft,
  };
}
