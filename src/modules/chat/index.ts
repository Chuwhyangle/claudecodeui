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
/**
 * The composer's presentation shell, exposed so the cockpit's intent input is assembled from
 * the SAME form/textarea/footer/submit components instead of a copy. The cockpit deliberately
 * does not reuse `ChatComposer` itself: that component is bound to one session's permission,
 * model and effort state, which a fleet-wide view does not have.
 */
export {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from '@/modules/chat/composer/PromptInput';
/**
 * The wall's deterministic referent resolver — 「第二个」/「②」/「红的那个」 over a view's
 * declared `{uri,label,display}` objects. The cockpit's intent parser resolves the same spoken
 * phrases over the same contract, so it calls this implementation rather than a second one.
 */
export { resolveVoiceReference } from '@/modules/chat/utils/voice/voiceContextPack';
export type { VoiceReferenceMatch } from '@/modules/chat/utils/voice/voiceContextPack';
