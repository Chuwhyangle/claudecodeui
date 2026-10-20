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
 * the implementation). This file imports nothing.
 */

/**
 * The two voice-realtime functions the dispatch hook needs.
 *
 * `isSessionActive` is `voice-realtime-active.ts`'s process-state read;
 * `rulesFor` is `voice-mode-rules.ts`'s rule-table selection. Naming them as a
 * port keeps the driver from importing either module.
 */
export type VoiceRulesPort = {
  isSessionActive(sessionId: string): boolean;
  rulesFor(variant: string | undefined): string;
};

/** The installed voice rules, or null before the voice-realtime barrel evaluates. */
let installedVoiceRules: VoiceRulesPort | null = null;

/**
 * Installs the process's voice-rules reader.
 *
 * Called by `voice-realtime/index.ts` next to the functions it exposes, and by
 * `server/index.ts`. Re-installing the same object is a no-op.
 */
export function installVoiceRulesPort(port: VoiceRulesPort): void {
  installedVoiceRules = port;
}

/**
 * Reads the installed voice rules, or null when the voice-realtime module has
 * not been loaded in this process.
 *
 * Null is the documented "no Live Voice connection" answer: the caller gates on
 * it exactly as it gates on an inactive session, rather than treating a missing
 * module as an error.
 */
export function readVoiceRulesPort(): VoiceRulesPort | null {
  return installedVoiceRules;
}
