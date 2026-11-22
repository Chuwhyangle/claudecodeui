/**
 * Public barrel for the chat-composer leaf of the chat split. Every cross-module import of this
 * module goes through this file; internal code keeps deep specifiers.
 */
export type { UseSuggestionChipsResult } from '@/modules/chat-composer/hooks/useSuggestionChips';
export { COMPACT_TIER_WIDTH_PX } from '@/modules/chat-composer/hooks/useComposerCompactTier';
export { INLINE_TOOLS_MIN_BOX_PX } from '@/modules/chat-composer/hooks/useComposerCompactTier';
export { InputSuggestionChips } from '@/modules/chat-composer/composer/InputSuggestionChips';
export { PromptInput } from '@/modules/chat-composer/composer/PromptInput';
export { PromptInputBody } from '@/modules/chat-composer/composer/PromptInput';
export { PromptInputFooter } from '@/modules/chat-composer/composer/PromptInput';
export { PromptInputSubmit } from '@/modules/chat-composer/composer/PromptInput';
export { PromptInputTextarea } from '@/modules/chat-composer/composer/PromptInput';
export { ResidentToggle } from '@/modules/chat-composer/composer/ResidentConsentNotice';
export { SUGGESTION_CHIP_PASS_THROUGH_PX } from '@/modules/chat-composer/composer/InputSuggestionChips';
export { VoiceFailureNotice } from '@/modules/chat-composer/composer/VoiceInputButton';
export { default as ActivityIndicator } from '@/modules/chat-composer/composer/ActivityIndicator';
export { default as ChatComposer } from '@/modules/chat-composer/composer/ChatComposer';
export { default as ComposerModelMenu } from '@/modules/chat-composer/composer/menus/ComposerModelMenu';
export { default as PermissionRequestsBanner } from '@/modules/chat-composer/composer/PermissionRequestsBanner';
export { default as TokenUsageSummary } from '@/modules/chat-composer/composer/TokenUsageSummary';
export { default as VoiceClipButton } from '@/modules/chat-composer/composer/VoiceClipButton';
export { default as VoiceInputButton } from '@/modules/chat-composer/composer/VoiceInputButton';
export { readAllInputHistory } from '@/modules/chat-composer/hooks/useInputHistory';
export { readInputHistory } from '@/modules/chat-composer/hooks/useInputHistory';
export { useChatComposerState } from '@/modules/chat-composer/hooks/useChatComposerState';
export { useComposerMenuAnchor } from '@/modules/chat-composer/hooks/useComposerMenuAnchor';
export { useInputHistory } from '@/modules/chat-composer/hooks/useInputHistory';
export { useInputSuggestions } from '@/modules/chat-composer/hooks/useInputSuggestions';
export { useReplySuggestions } from '@/modules/chat-composer/hooks/useReplySuggestions';
export { useScheduledMessages } from '@/modules/chat-composer/composer/useScheduledMessages';
export { useSendOnEnter } from '@/modules/chat-composer/hooks/useSendOnEnter';
export { useSuggestionChips } from '@/modules/chat-composer/hooks/useSuggestionChips';
