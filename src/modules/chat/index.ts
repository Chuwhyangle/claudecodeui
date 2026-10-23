export { default as ChatInterface } from '@/modules/chat/ChatInterface';
/**
 * The i18n key for one activity phase's running word, or null when the phase
 * has none. Used by the sidebar module, whose running rows draw the same phase
 * label the dock draws — one reduction, so the two surfaces cannot disagree.
 */
export { activityPhaseLabelKey } from '@/modules/chat/utils/voice/activityDockView';
/**
 * The wall-aware voice input seam, for modules outside `chat` (the dev-only ui-scenario surface):
 * one builder for the reference pack, the dictation-pack builder it shares with the real ASR path,
 * and the seam's build counter a scenario uses to assert it reached that same builder.
 */
export {
  buildVoiceInputContextPack,
  buildVoiceReferencePack,
  readVoiceInputPackBuildCount,
} from '@/modules/chat/utils/voice/voiceContextPack';
export type { VoiceReferencePack } from '@/modules/chat/utils/voice/voiceContextPack';
export { getClaudeSettings } from '@/modules/chat/utils/session/chatStorage';
export { default as ResidentSessionBadge } from '@/modules/chat/transcript/ResidentSessionBadge';
