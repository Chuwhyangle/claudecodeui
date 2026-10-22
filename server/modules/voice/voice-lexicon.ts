import { sessionsDb, voiceUserIdentifiersDb } from '@/modules/database/index.js';
import { readVoiceLexiconPort } from '@/shared/ports/voice-lexicon.port.js';
import type {
  VoiceHumanMessage,
  VoiceIdentifierRow,
  VoiceIdentifierStore,
  VoiceLexiconService,
} from '@/shared/types.js';

/**
 * The shape rule, the cleaning pass and the two exclusion patterns below are a
 * line-for-line port of the Python reference implementation
 * (`experiments/voice-index-loop/sim/extract.py`): its `is_id`, `clean`, `AUTO`
 * and `SECRET` are the single source of truth for what counts as an
 * identifier-like token. The criterion's known-answer table asserts this port
 * against that reference, so the rules are reproduced here rather than
 * re-designed — a "better" rule would make the vocabulary a second opinion and
 * the numbers it feeds incomparable to the experiment's.
 */

/**
 * A message the driver injected rather than the person writing.
 *
 * Anchored at the start and matched against the message with its leading
 * whitespace removed, exactly as the reference does: an injected prompt is
 * recognised by how it OPENS (`You are `, `WORKSPACE:`, a continuation banner, a
 * task notification, a command marker, a system reminder). The match is
 * CASE-SENSITIVE, as the reference's is — only `SECRET` below carries `re.I` —
 * so `caveat:` in lower case is the person's own writing and stays in.
 * `Caveat:` in its capitalised form is excluded whether or not the driver wrote
 * it; that over-collection is the reference's, and it is the safe direction,
 * since these are all turns nobody composed to be mined.
 */
const INJECTED_PROMPT_PREFIX =
  /^(You are |WORKSPACE:|This session is being continued|<task-notification|<command-|<local-command|\[Request interrupted|<system-reminder|Caveat:|<bash-|<user-prompt|Base directory)/;

/**
 * A message that looks like it carries a credential.
 *
 * The reference's list, unchanged: a message whose text mentions a password,
 * token, secret, `sk-…` key, bearer token, the Chinese words for password, an
 * `api key` assignment, or `authorized_keys` contributes nothing at all. It is
 * keyed on the WHOLE message rather than on the token, because a secret is a
 * property of the sentence — `sk-sentinel-abc` alone is identifier-shaped, and
 * only the surrounding words say it must never be stored.
 */
const CREDENTIAL_STYLE =
  /passwd|password|passphrase|token\b|secret|sk-[A-Za-z0-9]|Bearer |密码|口令|api[ _-]?key\s*[:=：]|authorized_keys/i;

/**
 * The reference's `TOK`: an identifier candidate starts with a letter, may
 * contain letters, digits, `_`, `.`, `/` and `-`, and ends on a letter or digit.
 * A lone letter is a candidate too (the second alternative), and is dropped by
 * the shape rule below rather than here.
 */
const TOKEN_PATTERN = /[A-Za-z][A-Za-z0-9_./\-]*[A-Za-z0-9]|[A-Za-z]/g;

/**
 * Removes the parts of a message that are never the user's own words, exactly as
 * the reference's `clean` does and in the same order: an embedded paste block, a
 * fenced code block, a URL, a UUID, then any bare 7–40 character hex run. Doing
 * this BEFORE tokenizing is what makes a pasted file's contents and a hash
 * un-mineable — the shape rule never sees them.
 */
export function cleanSentText(text: string): string {
  return text
    .replace(/<pasted_content[^>]*>[\s\S]*?<\/pasted_content[^>]*>/g, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/g, ' ')
    .replace(/\b[0-9a-f]{7,40}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The reference's `is_id`: whether one candidate token is identifier-like.
 *
 * A token of one character is never one, and neither is a path (any `/`) nor a
 * file name (a `.ext` tail). Beyond that it qualifies if it carries a camel-case
 * boundary, a `_` or `-`, or a digit — or is an all-caps run of at least two
 * letters. `main.ts`, `a/b`, `plain`, `https://x.y` and a bare hash all fail it;
 * `needs-human`, `AC-103`, `CloudCLI`, `GOAL-013`, `provider_models` and `MCP`
 * pass.
 *
 * Exported because the shape criterion's known-answer table is the only other
 * reader: it asserts each row against the Python reference.
 */
export function isIdentifierToken(token: string): boolean {
  if (token.length < 2 || token.includes('/') || /\.\w{1,4}$/.test(token)) {
    return false;
  }

  if (/[a-z][A-Z]|[_\-]|\d/.test(token)) {
    return true;
  }

  // The reference's `x.isupper()`: at least one letter, and none of them lower.
  return /[A-Z]/.test(token) && !/[a-z]/.test(token);
}

/**
 * The reference's `ids(text)`: every identifier-shaped token in a string, in
 * order and WITH repeats — a word written twice counts twice, because frequency
 * is the signal this lexicon exists to measure.
 */
export function extractIdentifiers(text: string): string[] {
  const cleaned = cleanSentText(text);
  if (cleaned === '') {
    return [];
  }

  return (cleaned.match(TOKEN_PATTERN) ?? []).filter(isIdentifierToken);
}

/**
 * Whether a whole message is one this lexicon must ignore, before any token is
 * taken from it: an injected prompt, or a message that reads as credential-like.
 *
 * The prompt test runs on the RAW text (its opening is what identifies it) and
 * the credential test on the CLEANED text (a URL or hash removed by cleaning
 * cannot make a message look like a secret), which is the reference's own split.
 */
function isIgnorableMessage(rawText: string): boolean {
  if (rawText.trim() === '') {
    return true;
  }

  if (INJECTED_PROMPT_PREFIX.test(rawText.replace(/^\s+/, ''))) {
    return true;
  }

  return CREDENTIAL_STYLE.test(cleanSentText(rawText));
}

/**
 * Whether a token is an opaque credential blob rather than a word the person
 * wrote: three dot-separated base64url runs, i.e. a JWT (or a same-shaped
 * signed token).
 *
 * AN ADDITION BEYOND THE REFERENCE, and the reason it exists is the real-data
 * run: a session whose entire message was a pasted JWT put that string in the
 * table, because the reference's `SECRET` pattern keys on the WORDS around a
 * credential (`token`, `Bearer`, `sk-…`) and a bare token has no words. Where
 * the reference removes a UUID and a hex hash in `clean` — opaque blobs of the
 * same kind — this removes the third one it did not know about. It is applied to
 * the tokens of an accepted message rather than inside `clean`, so the exported
 * `extractIdentifiers` stays the reference's `ids` exactly and only the stored
 * vocabulary gains the screen.
 */
function isOpaqueCredentialBlob(token: string): boolean {
  const segments = token.split('.');
  return (
    segments.length === 3 &&
    segments.every((segment) => segment.length >= 8 && /^[A-Za-z0-9_-]+$/.test(segment))
  );
}

/**
 * The identifier-shaped tokens of one message the user sent, after both
 * exclusions. The single entry point every path — the live send hook and the
 * history import — goes through, so a token a live send would refuse can never
 * enter through an import.
 */
export function extractSentIdentifiers(rawText: string): string[] {
  if (isIgnorableMessage(rawText)) {
    return [];
  }

  return extractIdentifiers(rawText).filter((token) => !isOpaqueCredentialBlob(token));
}

/**
 * The seams the lexicon service is assembled from.
 *
 * `store` is the persistence port (the database module's
 * `voiceUserIdentifiersDb` in production, an in-memory fake in tests).
 * `listHumanMessages` is how the cold-start import reaches the existing session
 * index: it answers the human-written messages across the indexed sessions and
 * is a dependency rather than an inline call so a criterion can hand over a
 * constructed fixture. `clock` is the time source for the live send path and for
 * messages whose transcript carries no timestamp.
 */
export type VoiceLexiconDependencies = {
  store: VoiceIdentifierStore;
  listHumanMessages: () => Promise<VoiceHumanMessage[]>;
  clock?: () => number;
};

/**
 * Builds the U-source lexicon service.
 *
 * Consumed by the Voice routes (`voice.routes.ts`) for the read/import/clear
 * surface and by the chat dispatch hook (`chat-websocket.service.ts`) for the
 * automatic recording of every sent message.
 */
export function createVoiceLexiconService(deps: VoiceLexiconDependencies): VoiceLexiconService {
  const clock = deps.clock ?? (() => Date.now());

  function observeSentText(text: string, projectKey: string): void {
    const tokens = extractSentIdentifiers(text);
    if (tokens.length === 0) {
      return;
    }

    const at = clock();
    deps.store.incrementTokens(
      tokens.map((token) => ({
        tokenLower: token.toLowerCase(),
        canonical: token,
        projectKey,
        at,
      }))
    );
  }

  async function importFromHistory(): Promise<{ importedMessages: number; tokenCount: number }> {
    const messages = await deps.listHumanMessages();

    // Dedup by message id: two sessions that share an id (a fork, a re-read) must
    // not count the same words twice. The counts are then derived afresh and the
    // table REPLACED, which is what makes a repeated import — or one that runs
    // after a live send — leave the same numbers rather than double them.
    const seen = new Set<string>();
    const perProject = new Map<string, Map<string, { canonical: string; count: number; firstSeenAt: number; lastSeenAt: number }>>();
    let importedMessages = 0;

    for (const message of messages) {
      if (seen.has(message.id)) {
        continue;
      }
      seen.add(message.id);

      const tokens = extractSentIdentifiers(message.text);
      if (tokens.length === 0) {
        continue;
      }

      importedMessages += 1;
      const at = message.at ?? clock();
      let rows = perProject.get(message.projectKey);
      if (!rows) {
        rows = new Map();
        perProject.set(message.projectKey, rows);
      }

      for (const token of tokens) {
        const tokenLower = token.toLowerCase();
        const existing = rows.get(tokenLower);
        if (existing) {
          existing.count += 1;
          existing.firstSeenAt = Math.min(existing.firstSeenAt, at);
          existing.lastSeenAt = Math.max(existing.lastSeenAt, at);
          continue;
        }
        rows.set(tokenLower, { canonical: token, count: 1, firstSeenAt: at, lastSeenAt: at });
      }
    }

    const entries: VoiceIdentifierRow[] = [];
    for (const [projectKey, rows] of perProject) {
      for (const [tokenLower, row] of rows) {
        entries.push({ tokenLower, projectKey, ...row });
      }
    }

    deps.store.replaceAll(entries);
    return { importedMessages, tokenCount: entries.length };
  }

  return {
    observeSentText,
    importFromHistory,
    list: (limit: number) => deps.store.listTop(limit),
    clear: () => deps.store.clear(),
  };
}

/**
 * Enumerates the human-written messages across the indexed sessions, through the
 * existing session index and history reader.
 *
 * NO TRANSCRIPT IS PARSED HERE: the session list comes from `sessionsDb` and each
 * session's messages from `sessionsService.fetchHistory`, the very reader the
 * messages route serves, so a transcript format change is absorbed below this
 * function rather than duplicated. A session that cannot be read (a missing file,
 * a provider that no longer resolves) is skipped rather than failing the whole
 * import — a cold start that one unreadable transcript could block is a cold
 * start that does not happen.
 *
 * The provider barrel is NOT imported here. The chat dispatch (this module's
 * other consumer) already makes `voice` a dependency of `websocket`, and
 * `providers` depends on `websocket`; a static import would close that cycle at
 * module-eval time, and a literal dynamic import closed it for the directory
 * scanner (which counts `import()` like `import`) — so the eight-member cycle
 * never actually broke. The reader now arrives through
 * `readVoiceLexiconPort()`, installed by `server/index.ts`: `voice` depends on
 * `server/shared/**` only, the edge to `modules/providers` is gone, and the
 * capability is still reached at call time, on the import route, long after the
 * module graph has settled.
 */
async function listHumanMessagesFromSessionIndex(): Promise<VoiceHumanMessage[]> {
  const historyReader = readVoiceLexiconPort();
  if (!historyReader) {
    // A missing installation is a misassembled process, not an empty history:
    // silently returning [] would report a successful cold start that imported
    // nothing. Fail on the route instead, naming the line the assembly owes.
    throw new Error(
      'voice lexicon history port is not installed — server/index.ts must call installVoiceLexiconPort()',
    );
  }
  const messages: VoiceHumanMessage[] = [];

  for (const session of sessionsDb.getAllSessions()) {
    if (!session.provider_session_id) {
      continue;
    }

    let history;
    try {
      history = await historyReader.fetchHistory(session.session_id, { limit: null, offset: 0 });
    } catch {
      continue;
    }

    const projectKey = session.project_path ?? '';
    for (const message of history.messages) {
      if (message.role !== 'user' || typeof message.content !== 'string' || message.content.trim() === '') {
        continue;
      }

      const at = Date.parse(message.timestamp);
      messages.push({
        id: `${session.session_id}:${message.transcriptAnchorId ?? message.id}`,
        projectKey,
        text: message.content,
        ...(Number.isFinite(at) ? { at } : {}),
      });
    }
  }

  return messages;
}

/**
 * The process's U-source lexicon: the database-backed store and the session-index
 * history source the routes and the send hook share.
 *
 * Exported through the Voice module's barrel so the chat dispatch can call the
 * recording hook without reaching into this file. Consumed by
 * `voice.module.ts` (the routes) and `chat-websocket.service.ts` (the hook).
 */
export const voiceLexicon: VoiceLexiconService = createVoiceLexiconService({
  store: voiceUserIdentifiersDb,
  listHumanMessages: listHumanMessagesFromSessionIndex,
});
