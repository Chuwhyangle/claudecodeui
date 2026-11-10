/**
 * The voice pipeline's own package: capture-time debug/endpoint helpers, the
 * runtime config reader, the keyboard shortcuts and the trim/resample seam.
 *
 * Callers outside `src/shared` may import this barrel; files inside the package
 * import their siblings by absolute path (`@/shared/voice/<file>`) because the
 * frontend lint override forbids relative imports.
 */
export * from '@/shared/voice/audioDecode';
export * from '@/shared/voice/voiceDebug';
export * from '@/shared/voice/labels/voiceEditLabels';
export * from '@/shared/voice/voiceEndpoint';
export * from '@/shared/voice/voiceRuntimeConfig';
export * from '@/shared/voice/voiceShortcuts';
export * from '@/shared/voice/voiceTrim';
