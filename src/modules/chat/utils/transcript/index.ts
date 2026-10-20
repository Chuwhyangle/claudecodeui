/**
 * Transcript sub-package of `chat/utils`: the row model, keys and ordering, message text
 * projection (markdown, diffs, tool groups) and the export geometry the transcript renders
 * against. Consumers reach transcript utilities through this barrel.
 *
 * `chatExport` is deliberately NOT re-exported here: it composes `chat/export/*`, whose
 * components import this barrel, so re-exporting it would close a barrel cycle at module
 * evaluation time. Its callers import `.../transcript/chatExport` directly.
 */
export * from '@/modules/chat/utils/transcript/chatFormatting';
export * from '@/modules/chat/utils/transcript/contentHeightModel';
export * from '@/modules/chat/utils/transcript/jumpAnchorLock';
export * from '@/modules/chat/utils/transcript/liveRowIdentity';
export * from '@/modules/chat/utils/transcript/messageKeys';
export * from '@/modules/chat/utils/transcript/messageTransforms';
export * from '@/modules/chat/utils/transcript/searchTargetLocator';
export * from '@/modules/chat/utils/transcript/streamingMarkdown';
export * from '@/modules/chat/utils/transcript/syntaxHighlightTheme';
export * from '@/modules/chat/utils/transcript/toolGrouping';
export * from '@/modules/chat/utils/transcript/workSegments';
export * from '@/modules/chat/utils/transcript/workSegmentTitle';
