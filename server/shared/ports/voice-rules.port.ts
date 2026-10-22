/**
 * The neutral accessor for the Live Voice rules injected into a resident prompt.
 *
 * WHY THIS FILE EXISTS. The resident Claude launch's `UserPromptSubmit` callback
 * asks two things of the voice-realtime module: whether THIS session has a Live
 * Voice connection, and which rules text to inject. It used to answer both with
 * a dynamic `import('@/modules/voice-realtime/index.js')` inside the callback.
 * That import is a `providers/list/claude -> voice-realtime` edge, and the
 * voice-realtime barrel reaches the MCP gateway, which reaches the providers
 * module — so the edge closes the initialization cycle that makes the launch
 * module order-sensitive. Static or dynamic, the edge is what must go; the
 * question is only how the callback reaches the two functions without it.
 *
 * The answer is a port owned by the shared layer. The voice-realtime barrel
 * installs the real functions while it evaluates (it already precomputes the
 * rules text and owns the in-process active-session set), and the composition
 * root names the same installation explicitly. The callback reads the installed
 * port at submit time, which is when the answer is needed and long after every
 * module has evaluated.
 *
 * An uninstalled port means "no voice session is active", the same reading the
 * callback had for an unmarked session: it returns the hook contract's `{}` and
 * the launch behaves byte-for-byte as it did before the hook existed. A process
 * that never loads the voice-realtime barrel (a focused resident-launch
 * criterion) therefore keeps working, and the debug escape hatch
 * (`VOICE_MODE_HOOK_FORCE=1`) still injects only when the real rules text is
 * available.
 *
 * Consumers: `modules/providers/list/claude/claude-host-driver.provider.ts`
 * (the callback) and `modules/voice-realtime/index.ts` (the owner that installs
 * the implementation).
 *
 * THE STORAGE NOW LIVES IN THE SHARED SETTINGS/RULES CONTRACT. `installVoiceRules` and
 * `readVoiceRules` (with the port type) are declared in
 * `shared/voice/voiceSettingsRegistry.ts` and re-exported here under this module's long-standing
 * names, so the voice rules and the settings they select travel through ONE address book rather
 * than two registries. The re-exported names are unchanged on purpose: every call site names the
 * port, and a rename would be churn without a behavioural reason. The contract module imports
 * nothing, so this file still cannot close a loop of its own.
 */
export type { VoiceRulesPort } from '@shared/voice/voiceSettingsRegistry.js';
export {
  installVoiceRules as installVoiceRulesPort,
  readVoiceRules as readVoiceRulesPort,
} from '@shared/voice/voiceSettingsRegistry.js';
