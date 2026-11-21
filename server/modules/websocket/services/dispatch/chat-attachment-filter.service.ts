import path from 'node:path';

import {
  getImageAssetsReadDirs,
  normalizeAttachmentDescriptors,
  type ChatAttachmentDescriptor,
} from '@/shared/image-attachments.js';

/**
 * Trust boundary for client-supplied image attachments: chat.send options come
 * straight from the browser, and the provider runtimes read the referenced
 * files off disk (Claude base64-encodes them). Only images directly inside an
 * upload store (`~/.cloudcli/assets`, or `<explicit>/assets` when a root is
 * configured — either place POST /api/assets/images writes) are allowed through;
 * anything else (absolute paths elsewhere, traversal, subdirectories) is dropped.
 * Exported for tests; without an override both dual roots are accepted (new root
 * first) so re-sending a historical attachment from either store survives.
 *
 * It lives in its own leaf (rather than in the transport module) because the run
 * dispatcher — the funnel every accepted human turn passes through — enforces
 * it too, and that dispatcher must not import the transport without closing the
 * `chat-control ⇄ chat-websocket` cycle the contract extraction broke.
 */
export function filterAttachmentsToUploadStore(
  attachments: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  const assetsRoots =
    assetsRootOverride === undefined
      ? getImageAssetsReadDirs().map((root) => path.resolve(root))
      : [path.resolve(assetsRootOverride)];

  return normalizeAttachmentDescriptors(attachments).filter((descriptor) => {
    // Relative paths are anchored in each store; absolute ones must already be in one.
    const isDirectChild = assetsRoots.some((assetsRoot) => {
      const resolved = path.resolve(assetsRoot, descriptor.path);
      const relative = path.relative(assetsRoot, resolved);
      return (
        relative.length > 0 &&
        !relative.startsWith('..') &&
        !path.isAbsolute(relative) &&
        !relative.includes(path.sep) &&
        !relative.includes('/')
      );
    });

    if (!isDirectChild) {
      console.warn(`[Chat] Dropping attachment outside the upload store: ${descriptor.path}`);
    }
    return isDirectChild;
  });
}

/** Backward-compatible image filter consumed by existing websocket tests. */
export function filterImagesToUploadStore(
  images: unknown,
  assetsRootOverride?: string,
): ChatAttachmentDescriptor[] {
  return filterAttachmentsToUploadStore(images, assetsRootOverride);
}
