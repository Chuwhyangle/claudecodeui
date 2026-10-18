export { default as ChatInterface } from '@/modules/chat/ChatInterface';
/**
 * The i18n key for one activity phase's running word, or null when the phase
 * has none. Used by the sidebar module, whose running rows draw the same phase
 * label the dock draws — one reduction, so the two surfaces cannot disagree.
 */
export { activityPhaseLabelKey } from '@/modules/chat/utils/activityDockView';
export { getClaudeSettings } from '@/modules/chat/utils/chatStorage';
export { default as ModelLibraryPanel } from '@/modules/chat/modals/ModelLibraryPanel';
export { default as ResidentSessionBadge } from '@/modules/chat/transcript/ResidentSessionBadge';
/** Used by the settings module's voice panel to show the on-device recogniser's download and give-ups. */
export { useVoiceClientAsrStatus } from '@/modules/chat/hooks/useVoiceAvailable';
export type { VoiceClientAsrPanel } from '@/modules/chat/hooks/useVoiceAvailable';
