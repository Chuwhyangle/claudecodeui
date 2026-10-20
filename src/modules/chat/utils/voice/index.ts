/**
 * Voice sub-package of `chat/utils`: capture, segmentation, playback, model caching and the
 * activity-dock reading derived from a voice turn. Consumers reach voice utilities through this
 * barrel so the sub-package stays the import surface rather than its individual files.
 */
export * from '@/modules/chat/utils/voice/activityDockView';
export * from '@/modules/chat/utils/voice/voiceContextPack';
export * from '@/modules/chat/utils/voice/voiceErrorMessages';
export * from '@/modules/chat/utils/voice/voiceInsertion';
export * from '@/modules/chat/utils/voice/voiceLiveReading';
export * from '@/modules/chat/utils/voice/voiceLiveSegmenter';
export * from '@/modules/chat/utils/voice/voiceModelCache';
export * from '@/modules/chat/utils/voice/voicePlayer';
export * from '@/modules/chat/utils/voice/voiceSegments';
