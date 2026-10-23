import { useCallback, useState } from 'react';
import type { ClipboardEvent } from 'react';
import { useDropzone } from 'react-dropzone';

import { api } from '@/shared/api';
import type { ChatAttachment } from '@/shared/types';

/**
 * The files attached to the draft: what is held, what was refused and why, and
 * the paste/drop surfaces that put them there.
 *
 * Browser `File` objects are local to the mounted composer, so this state has
 * no persistence of its own — a queued draft keeps the server's uploaded
 * descriptors instead (`useDraftState`). The size and count limits live here
 * with the validation that enforces them, because both the dropzone and the
 * paste path have to apply the same rule.
 */

export const MAX_ATTACHMENT_COUNT = 10;
export const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;

export const isImageAttachment = (attachment: ChatAttachment) => {
  if (attachment.mimeType?.startsWith('image/')) return true;
  return /\.(gif|jpe?g|png|svg|webp)$/i.test(attachment.path || attachment.name || '');
};

/** Uploads the attached files and returns the server's durable descriptors. */
export const uploadAttachmentFiles = async (files: File[]): Promise<unknown[]> => {
  if (files.length === 0) {
    return [];
  }

  const formData = new FormData();
  files.forEach((file) => {
    formData.append('files', file);
  });

  const response = await api.assets.uploadFiles(formData);

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.error || 'Failed to upload files');
  }

  const result = await response.json();
  if (!Array.isArray(result.attachments) || result.attachments.length !== files.length) {
    throw new Error('File upload returned an incomplete result');
  }
  return result.attachments;
};

export function useAttachmentState() {
  // The files the next send carries. Local to the mounted composer: a reload
  // restores a queued draft's uploaded descriptors, never these File objects.
  const [attachedFiles, setAttachedFiles] = useState<File[]>([]);
  // Why a file was refused, keyed by name so each refusal replaces its own row
  // rather than stacking a new alert per attempt.
  const [fileErrors, setFileErrors] = useState<Map<string, string>>(new Map());

  const handleAttachmentFiles = useCallback((files: File[]) => {
    const validFiles = files.filter((file) => {
      try {
        if (!file || typeof file !== 'object') {
          console.warn('Invalid file object:', file);
          return false;
        }

        if (file.size > MAX_ATTACHMENT_SIZE) {
          const fileName = file.name || 'Unknown file';
          setFileErrors((previous) => {
            const next = new Map(previous);
            next.set(fileName, 'File too large (max 10MB)');
            return next;
          });
          return false;
        }

        return true;
      } catch (error) {
        console.error('Error validating file:', error, file);
        return false;
      }
    });

    if (validFiles.length > 0) {
      setAttachedFiles((previous) => [...previous, ...validFiles].slice(0, MAX_ATTACHMENT_COUNT));
    }
  }, []);

  const handlePaste = useCallback(
    (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const items = Array.from(event.clipboardData.items);

      items.forEach((item) => {
        if (!item.type.startsWith('image/')) {
          return;
        }
        const file = item.getAsFile();
        if (file) {
          handleAttachmentFiles([file]);
        }
      });

      if (items.length === 0 && event.clipboardData.files.length > 0) {
        const files = Array.from(event.clipboardData.files);
        const imageFiles = files.filter((file) => file.type.startsWith('image/'));
        if (imageFiles.length > 0) {
          handleAttachmentFiles(imageFiles);
        }
      }
    },
    [handleAttachmentFiles],
  );

  const { getRootProps, getInputProps, isDragActive, open } = useDropzone({
    maxSize: MAX_ATTACHMENT_SIZE,
    maxFiles: MAX_ATTACHMENT_COUNT,
    onDrop: handleAttachmentFiles,
    noClick: true,
    noKeyboard: true,
  });

  return {
    attachedFiles,
    setAttachedFiles,
    fileErrors,
    setFileErrors,
    getRootProps,
    getInputProps,
    isDragActive,
    openAttachmentPicker: open,
    handlePaste,
  };
}
