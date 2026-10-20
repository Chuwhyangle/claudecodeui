/**
 * The single reader of Claude's transcript formatting conventions.
 *
 * The Claude CLI writes a mix of truly internal transcript rows and
 * "UI-hidden" local command artifacts into the same JSONL stream. Two readers
 * consume that stream — the history projection in
 * `claude-sessions.provider.ts` (what the chat transcript shows) and
 * `session-conversations-search.service.ts` (what search finds). Both must
 * give the same answer to "is this row internal?" and "how does a slash
 * command read?", so those readings live here once rather than as two copies
 * that silently drift apart when one side is fixed.
 *
 * Consumers:
 * - `claude-sessions.provider.ts` — projects transcript rows into chat messages.
 * - `session-conversations-search.service.ts` — extracts searchable text from
 *   the same rows.
 */

/**
 * Prefixes that mark a Claude transcript row as internal machinery rather than
 * conversation.
 *
 * The first group is shared by every Claude reader:
 * - system reminders / caveats / interruption banners should stay hidden.
 *
 * The local command wrappers (`<command-name>...`) and stdout wrappers
 * (`<local-command-stdout>...`) are deliberately NOT here: both readers remap
 * them into normal chat or searchable text instead of discarding them.
 *
 * Skill bodies belong in this group. When a skill is invoked, Claude injects
 * the entire SKILL.md as a synthetic user turn. Persisted transcripts tag it
 * `isMeta: true`, but the live SDK stream does not, so without a content-level
 * check the same payload renders as a huge user bubble during the run and then
 * vanishes on reload. The skill is already represented by the `Skill` tool
 * call, so it is never user-visible content.
 *
 * `Invalid API key` is an authentication banner the CLI records as a user row;
 * it is a diagnostic, not something the reader typed, so search and history
 * both hide it.
 */
export const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  '[Request interrupted',
  'Base directory for this skill:',
  'Invalid API key',
] as const;

/**
 * Whether a transcript row's text is internal machinery rather than
 * conversation.
 *
 * Shared by `claude-sessions.provider.ts` (history projection) and
 * `session-conversations-search.service.ts` (search) so a row is classified
 * identically on both read surfaces.
 */
export function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * The body of the first `<tagName>…</tagName>` pair in a plain string payload,
 * or `null` when the tag is absent.
 *
 * Claude wraps local slash-command metadata in lightweight XML-like tags inside
 * a plain string payload. We intentionally parse only the small tag surface we
 * care about instead of introducing a generic XML parser for untrusted
 * history. Consumed by the history projection and search, for command
 * metadata and `<local-command-stdout>` output alike.
 */
export function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

/**
 * The structured metadata a Claude local slash-command wrapper carries.
 *
 * Each field is the body of one wrapper tag, or an empty string when the tag
 * is unavailable in an older transcript variant. Consumed by the history
 * projection (to expose `commandName`/`commandMessage`/`commandArgs` on the
 * normalized message) and by search (to read the user-visible command text).
 */
export type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

/**
 * Converts Claude's hidden local command wrapper into structured metadata.
 *
 * The three tags often coexist in one string payload. Returning `null` lets the
 * normal text path continue untouched for unrelated messages. Shared by the
 * history projection and search so both read the same wrapper the same way.
 */
export function parseLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
  const commandName = extractTaggedContent(content, 'command-name');
  const commandMessage = extractTaggedContent(content, 'command-message');
  const commandArgs = extractTaggedContent(content, 'command-args');

  if (commandName === null && commandMessage === null && commandArgs === null) {
    return null;
  }

  return {
    commandName: commandName ?? '',
    commandMessage: commandMessage ?? '',
    commandArgs: commandArgs ?? '',
  };
}

/**
 * Produces the short user-visible command string that should appear in chat
 * and in search results.
 *
 * We prefer the slash-prefixed command name because that most closely matches
 * what the user actually typed, and only fall back to the message body when the
 * command name is unavailable in older transcript variants. Shared by the
 * history projection and search.
 */
export function buildLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}
