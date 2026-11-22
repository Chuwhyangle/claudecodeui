import os from 'node:os';
import path from 'node:path';

import { appConfigDb, isSelfAssignedSessionName, sessionsDb, type SessionNameSource } from '@/modules/database/index.js';
import {
  buildLookupMap,
  extractFirstValidJsonlData,
  findFilesRecursivelyCreatedAfter,
  normalizeSessionName,
  readFileTimestamps,
  readTranscriptLastActivity,
} from '@/shared/utils.js';
import type { IProviderSessionSynchronizer } from '@/shared/interfaces.js';
import {
  readAiTitleEntry,
  readTranscriptWindow,
  TRANSCRIPT_TITLE_HEAD_MAX_WINDOW_BYTES,
  TRANSCRIPT_TITLE_TAIL_MAX_WINDOW_BYTES,
} from '@/modules/providers/list/claude/transcript/session-ai-title.service.js';

type ParsedSession = {
  sessionId: string;
  projectPath: string;
  sessionName?: string;
  /** Where `sessionName` came from; travels with it into the session row. */
  nameSource: SessionNameSource;
  /**
   * Whether `sessionName` is the name the transcript itself gives the session
   * rather than a name this indexer fell back to.
   *
   * The two are written to different columns: a reading is overwritten on every
   * sync (Claude revises its title, and a `/rename` lands between two scans),
   * while a fallback may only ever fill a gap. Without the distinction a
   * placeholder like "Untitled Claude Session" would be written over a title
   * the transcript had already given the session.
   */
  transcriptReading: boolean;
};

/** What a transcript says the session is called, and how authoritative that is. */
type TranscriptTitle = {
  name: string;
  source: SessionNameSource;
};

/**
 * The title-bearing entries one transcript window held, last of each type.
 *
 * Held per type rather than as one winner because the ladder cannot be applied
 * until the whole window has been read: an `agent-name` may sit either side of
 * an `ai-title`, and only the last entry of each type is the one the CLI would
 * display.
 *
 * `selfAssigned` is split out of `agent` at fold time rather than at ladder
 * time so a window holding nothing but an address this app minted does not count
 * as a complete answer: the `ai-title` it must not outrank may sit in the other
 * window, and the reader has to go and look. See `isSelfAssignedSessionName`.
 */
type TranscriptTitles = {
  agent: string | null;
  manual: string | null;
  ai: string | null;
  selfAssigned: string | null;
};

const NO_TITLES: TranscriptTitles = { agent: null, manual: null, ai: null, selfAssigned: null };

/**
 * The prompt blocks Claude writes that are not what the user typed: a slash
 * command, a bash escape, or one of the metadata blocks (`<system-reminder>`,
 * `<command-message>`, `<local-command-stdout>`, ...) the CLI appends to a
 * transcript. Mirrors the CLI's own filter, which is what keeps a derived name
 * from being a stack of XML.
 */
const PROMPT_METADATA_PREFIX = /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/;

const COMMAND_NAME_PATTERN = /<command-name>([^<]*)<\/command-name>/;
const COMMAND_ARGS_PATTERN = /<command-args>([^<]*)<\/command-args>/;
const BASH_INPUT_PATTERN = /<bash-input>([^<]*)<\/bash-input>/;

/** The name a Claude session carries before anything has named it. */
const UNTITLED_CLAUDE_SESSION = 'Untitled Claude Session';

/**
 * `app_config` key recording that this database's already-indexed rows for one
 * provider have had their activity re-derived from transcript content.
 *
 * Versioned because the derivation itself can be corrected later: a new suffix
 * asks every database to redo the pass once, instead of leaving rows the
 * previous pass wrote with a reading this one would no longer produce.
 *
 * Keyed by provider id because a second instance of this indexer exists — the
 * debug agent's, which reads a fixture home under a different provider id — and
 * a marker shared between them would let the fixture's scan consume the product's
 * one-shot pass, leaving the product's own rows unrepaired. For `claude` the key
 * is byte-identical to the original, so no existing database re-runs anything.
 */
const LAST_ACTIVITY_BACKFILL_KEY_SUFFIX = 'last_activity_backfill_v1';

/** Whether a window held any title entry at all. */
const hasAnyTitle = (titles: TranscriptTitles): boolean =>
  titles.agent !== null || titles.manual !== null || titles.ai !== null;

/**
 * Folds one transcript entry into the titles a window has seen.
 *
 * Only the *last* entry of each type is kept, because that is the one the CLI
 * displays: it rewrites the title entries near the end of the file as a
 * conversation goes on, so the earlier ones are drafts of a name it has since
 * replaced, not the session's name. An entry that belongs to another session —
 * a subagent transcript repeats its parent's entries under its own id — is
 * dropped rather than allowed to name this one.
 *
 * An `agent-name` this app minted (`--name`) is routed to `selfAssigned` instead
 * of `agent`, so it lands on its own rung of the ladder rather than at the top
 * of it; see `TranscriptTitles` for why the split happens here.
 */
function foldTitleEntry(
  state: TranscriptTitles,
  entry: Record<string, unknown>,
  sessionId: string,
  appSessionId?: string | null,
): TranscriptTitles {
  const type = typeof entry.type === 'string' ? entry.type : undefined;

  if (type === 'agent-name') {
    if (entry.sessionId !== sessionId) {
      return state;
    }
    const name = typeof entry.agentName === 'string' ? entry.agentName : undefined;
    if (!name?.trim()) {
      return state;
    }
    return isSelfAssignedSessionName(name, appSessionId)
      ? { ...state, selfAssigned: name }
      : { ...state, agent: name };
  }

  if (type === 'custom-title') {
    if (entry.sessionId !== sessionId) {
      return state;
    }
    const name = typeof entry.customTitle === 'string' ? entry.customTitle : undefined;
    if (!name?.trim()) {
      return state;
    }
    // The same split as `agent-name`, and for the same reason: a `--name` writes
    // `custom-title` *as well as* `agent-name`, with the identical value
    // (measured: 2748 of 2749 transcripts carrying an `agent-name` carry a
    // `custom-title` equal to it). Only the `agent-name` half was routed, so a
    // legacy row's address still reached the `manual` rung through this branch —
    // above `ai` — and would have outranked the `ai-title` anyway. A real rename
    // (an app rename, or a CLI `/rename`) is not shaped like this app's own
    // address, so it keeps the `manual` rung.
    return isSelfAssignedSessionName(name, appSessionId)
      ? { ...state, selfAssigned: name }
      : { ...state, manual: name };
  }

  if (type === 'ai-title') {
    // The same rule the `/cost` reader applies, so the title a session row
    // stores and the one the command modal shows cannot drift.
    const name = readAiTitleEntry(entry, sessionId);
    return name ? { ...state, ai: name } : state;
  }

  return state;
}

/**
 * Returns what one transcript entry contributes to the session's derived name:
 * the text of the first prompt the user typed.
 *
 * This is the CLI's own rule, and it exists because a transcript's earliest
 * entries are not all things the user said — a slash command, a bash escape,
 * and the metadata blocks the CLI appends (`<system-reminder>`,
 * `<local-command-stdout>`, ...) are all written as `user` entries, and a
 * session named after one of them would be named after XML. An entry that is
 * not a prompt at all returns undefined so the scan keeps looking, and the
 * first entry that *is* one wins: everything after it was typed into a
 * conversation that already had a topic.
 */
function readPromptEntry(entry: Record<string, unknown>): string | undefined {
  if (entry.type !== 'user' || entry.isMeta === true || entry.isCompactSummary === true) {
    return undefined;
  }

  const message = entry.message;
  const content = message && typeof message === 'object'
    ? (message as Record<string, unknown>).content
    : undefined;
  const parts = typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((part) =>
          part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text'
            && typeof (part as Record<string, unknown>).text === 'string'
            ? [(part as Record<string, unknown>).text as string]
            : [],
        )
      : [];

  for (const part of parts) {
    const command = COMMAND_NAME_PATTERN.exec(part);
    if (command) {
      const args = COMMAND_ARGS_PATTERN.exec(part);
      if (args) {
        return `${command[1]} ${args[1]}`.trim();
      }
      // A builtin with no arguments names nothing about the session; the next
      // entry is where the user's own words start.
      continue;
    }

    const bash = BASH_INPUT_PATTERN.exec(part);
    if (bash) {
      return `! ${bash[1]}`.trim();
    }

    if (PROMPT_METADATA_PREFIX.test(part)) {
      continue;
    }

    return part;
  }

  return undefined;
}

/** Where one provider's transcripts live, and the id its rows are recorded under. */
export type ClaudeSessionSynchronizerOptions = {
  /** Provider home directory; defaults to this machine's `~/.claude`. */
  home?: string;
  /** Provider id rows are written under; defaults to `claude`. */
  providerId?: string;
};

/**
 * Session indexer for Claude-dialect transcript artifacts.
 *
 * The dialect is claude's; the home and the provider id are parameters, because
 * the debug agent indexes a fixture home under an id of its own (ADR-003
 * decision 2) with exactly this reader. Both default to the product's values, so
 * the claude provider constructs it with no arguments and keeps reading the real
 * `~/.claude`.
 */
export class ClaudeSessionSynchronizer implements IProviderSessionSynchronizer {
  private readonly provider: string;
  private readonly home: string;

  constructor(options: ClaudeSessionSynchronizerOptions = {}) {
    this.provider = options.providerId ?? 'claude';
    this.home = options.home ?? path.join(os.homedir(), '.claude');
  }

  /**
   * Returns true when a JSONL file is a subagent transcript or tool result
   * rather than a top-level session.
   *
   * Claude stores subagent transcripts under a `subagents/` directory and
   * tool results under a `tool-results/` directory, e.g.
   * `~/.claude/projects/<encoded-cwd>/<session-id>/subagents/agent-<id>.jsonl`.
   * Those files repeat the parent session's `sessionId`, so indexing them as
   * standalone sessions overwrites the parent row's `jsonl_path` and corrupts
   * the main session record. The recursive scan in `synchronize()` reaches
   * them, so both entry points must skip them.
   */
  private isSubagentTranscript(filePath: string): boolean {
    const pathParts = path.normalize(filePath).split(path.sep);
    return pathParts.includes('subagents') || pathParts.includes('tool-results');
  }

  /**
   * Scans ~/.claude/projects and upserts discovered sessions into DB.
   */
  async synchronize(since?: Date): Promise<number> {
    await this.backfillLastActivity();

    const nameMap = await buildLookupMap(path.join(this.home, 'history.jsonl'), 'sessionId', 'display');
    const files = await findFilesRecursivelyCreatedAfter(
      path.join(this.home, 'projects'),
      '.jsonl',
      since ?? null
    );

    let processed = 0;
    for (const filePath of files) {
      if (this.isSubagentTranscript(filePath)) {
        continue;
      }

      const parsed = await this.processSessionFile(filePath, nameMap);
      if (!parsed) {
        continue;
      }

      await this.writeSessionRow(parsed, filePath);
      processed += 1;
    }

    return processed;
  }

  /**
   * Parses and upserts one Claude session JSONL file.
   */
  async synchronizeFile(filePath: string): Promise<string | null> {
    if (!filePath.endsWith('.jsonl')) {
      return null;
    }
    if (this.isSubagentTranscript(filePath)) {
      return null;
    }

    const nameMap = await buildLookupMap(path.join(this.home, 'history.jsonl'), 'sessionId', 'display');
    const parsed = await this.processSessionFile(filePath, nameMap);
    if (!parsed) {
      return null;
    }

    return this.writeSessionRow(parsed, filePath);
  }

  /**
   * Resolves the activity time one transcript should be recorded with.
   *
   * The transcript's own last `timestamp` wins, because a file's mtime moves
   * for reasons that are not activity — a CLI flushing its bookkeeping
   * records, an external process rewriting or restoring the file — which is
   * what let a session idle for days read as active minutes ago.
   *
   * The mtime is the fallback for the two cases content cannot answer: a
   * transcript with no records yet (a session the user just created), and one
   * that cannot be read. Neither may end up without a time, or the session
   * disappears from a sidebar that sorts by activity.
   */
  private async resolveLastActivity(
    filePath: string,
    fileUpdatedAt: string | undefined
  ): Promise<string | undefined> {
    return (await readTranscriptLastActivity(filePath)) ?? fileUpdatedAt;
  }

  /**
   * Re-derives `updated_at` for Claude rows indexed before content was read.
   *
   * A row is only rewritten when its transcript is re-scanned, and both entry
   * points skip a file nothing has touched — the scan cursor compares
   * `birthtime > lastScanAt`, and the watcher only fires on a change. Without
   * this pass every row already in the database would keep its mtime reading
   * forever, which is precisely the wrong reading this synchronizer now
   * refuses to write.
   *
   * Rows are read from the database rather than by walking `~/.claude/projects`:
   * the walk is the one thing that runs on every list request, and paying a
   * content read per transcript there is the cost this design exists to avoid.
   * The `app_config` marker keeps the pass to once per database.
   *
   * A row whose transcript has since been deleted, or records no activity, is
   * left exactly as it is — `pruneOrphanedSessions` owns deletion, and a
   * transcript with no records has no better reading to offer.
   */
  private async backfillLastActivity(): Promise<void> {
    const markerKey = `${this.provider}_${LAST_ACTIVITY_BACKFILL_KEY_SUFFIX}`;
    if (appConfigDb.get(markerKey)) {
      return;
    }

    let repaired = 0;
    for (const row of sessionsDb.getSessionsWithTranscriptPath(this.provider)) {
      const lastActivity = await readTranscriptLastActivity(row.jsonl_path);
      if (lastActivity && sessionsDb.updateSessionUpdatedAt(row.session_id, lastActivity)) {
        repaired += 1;
      }
    }

    appConfigDb.set(markerKey, new Date().toISOString());

    if (repaired > 0) {
      console.log(
        `[Sessions] Re-derived last activity from transcript content for ${repaired} Claude session row(s).`
      );
    }
  }

  /**
   * Extracts session metadata from one Claude JSONL session file.
   */
  private async processSessionFile(
    filePath: string,
    nameMap: Map<string, string>
  ): Promise<ParsedSession | null> {
    const parsed = await extractFirstValidJsonlData(filePath, (rawData) => {
      const data = rawData as Record<string, unknown>;
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : undefined;
      const projectPath = typeof data.cwd === 'string' ? data.cwd : undefined;

      if (!sessionId || !projectPath) {
        return null;
      }

      return {
        sessionId,
        projectPath,
      };
    });

    if (!parsed) {
      return null;
    }

    // App-created sessions are keyed by an app id, so disk-discovered provider
    // ids must be resolved through the provider-id mapping first. The row's
    // name comes back as the display name — the user's override if they made
    // one, the transcript's own reading otherwise.
    const existingSession = sessionsDb.getSessionByProviderSessionId(parsed.sessionId)
      ?? sessionsDb.getSessionById(parsed.sessionId);
    const existingSessionName = existingSession?.custom_name;
    const existingNameSource = (existingSession?.name_source ?? 'derived') as SessionNameSource;

    // Always read the transcript, however the session is already named: Claude
    // revises its title and a `/rename` lands at any point in a session's life,
    // so a name that is not re-read is a name that goes stale. The read is two
    // bounded windows, so this costs the same for a session that has been named
    // for months as for one being discovered now.
    //
    // The row's id goes with the read so the ladder can tell an address this app
    // minted (`--name`, always suffixed with this row's own id) apart from an
    // `agent-name` a real agent chose.
    const transcriptTitle = await this.extractSessionTitle(
      filePath,
      parsed.sessionId,
      existingSession?.session_id
    );
    if (transcriptTitle) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(transcriptTitle.name, UNTITLED_CLAUDE_SESSION),
        nameSource: transcriptTitle.source,
        transcriptReading: true,
      };
    }

    const historyName = nameMap.get(parsed.sessionId);
    if (historyName) {
      return {
        ...parsed,
        sessionName: normalizeSessionName(historyName, UNTITLED_CLAUDE_SESSION),
        nameSource: 'derived',
        transcriptReading: false,
      };
    }

    // Nothing on disk names this session. A row that already has a name keeps
    // it: `normalizeSessionName` would otherwise hand back the placeholder and
    // the upsert would replace a real name with it. The name is not claimed
    // here at all — not even in the read column — because a transcript that
    // names its session nowhere is not evidence that the name it had is gone.
    if (existingSessionName) {
      return { ...parsed, nameSource: existingNameSource, transcriptReading: false };
    }

    return {
      ...parsed,
      sessionName: UNTITLED_CLAUDE_SESSION,
      nameSource: 'derived',
      transcriptReading: false,
    };
  }

  /**
   * Writes one scanned transcript into its session row.
   *
   * A name the transcript itself gives the session goes to the read column,
   * unconditionally: it is the newest reading of a name Claude owns and revises,
   * and leaving an older one in place is how a rename goes unnoticed. A name
   * this indexer fell back to — the history file, or the placeholder — is
   * offered as an ordinary claim instead, so it fills the gap on a session that
   * has no name without being able to overwrite one it does have.
   */
  private async writeSessionRow(parsed: ParsedSession, filePath: string): Promise<string> {
    const timestamps = await readFileTimestamps(filePath);
    const sessionId = sessionsDb.createSession(
      parsed.sessionId,
      this.provider,
      parsed.projectPath,
      parsed.transcriptReading ? undefined : parsed.sessionName,
      timestamps.createdAt,
      await this.resolveLastActivity(filePath, timestamps.updatedAt),
      filePath,
      parsed.nameSource
    );

    if (parsed.transcriptReading && parsed.sessionName) {
      sessionsDb.writeTranscriptName(sessionId, parsed.sessionName, parsed.nameSource);
    }

    return sessionId;
  }

  /**
   * Returns the name one session's transcript gives it, and which rung of
   * Claude's own title ladder that name came from.
   *
   * The ladder is the CLI's, and the session a user sees in this app is named
   * what the CLI would name it: `agent-name` (the agent that owns the session),
   * then `custom-title` (a CLI `/rename`), then `ai-title` (the generated one),
   * then the session's first prompt. Two details of it decide what this reader
   * has to do, and both used to be wrong here:
   *
   * - A title entry is *revised*, not written once. Claude re-emits its
   *   `ai-title` as the conversation goes on, so the last entry of each type is
   *   the current name and every earlier one is a draft it replaced. Stopping
   *   at the first `ai-title` therefore reads a stale title as soon as a
   *   session has been re-titled.
   * - A `/rename`'s `custom-title` is not ordered against the `ai-title` it
   *   belongs with: inside a rewrite the pair goes out together, but a rename
   *   after the fact appends a lone `custom-title` at the end of the file. Its
   *   position says nothing, so the ladder — not the order the entries appear
   *   in — has to decide which of the two is the name.
   *
   * Reading it costs two bounded windows rather than the file: the tail, where
   * the rewritten titles live, and — only when the tail holds none — the head,
   * where a title written once and the first prompt sit. Neither window grows
   * with the file, so a transcript of hundreds of megabytes is read for the
   * same handful of kilobytes as a short one.
   *
   * Returns undefined when the transcript names the session nowhere, so the
   * caller can fall back to the name the row already carries.
   */
  private async extractSessionTitle(
    filePath: string,
    sessionId: string,
    appSessionId?: string | null
  ): Promise<TranscriptTitle | undefined> {
    const tail = await readTranscriptWindow<TranscriptTitles>(filePath, {
      from: 'tail',
      maxBytes: TRANSCRIPT_TITLE_TAIL_MAX_WINDOW_BYTES,
      initial: NO_TITLES,
      fold: (state, entry) => foldTitleEntry(state, entry, sessionId, appSessionId),
      isComplete: hasAnyTitle,
    });

    let titles = tail;
    let firstPrompt: string | null = null;

    if (!hasAnyTitle(tail)) {
      const head = await readTranscriptWindow<{ titles: TranscriptTitles; firstPrompt: string | null }>(
        filePath,
        {
          from: 'head',
          maxBytes: TRANSCRIPT_TITLE_HEAD_MAX_WINDOW_BYTES,
          initial: { titles: NO_TITLES, firstPrompt: null },
          fold: (state, entry) => ({
            titles: foldTitleEntry(state.titles, entry, sessionId, appSessionId),
            firstPrompt: state.firstPrompt ?? readPromptEntry(entry) ?? null,
          }),
          // A title outranks the prompt, so either answer ends the read.
          isComplete: (state) => hasAnyTitle(state.titles) || state.firstPrompt !== null,
        },
      );
      titles = head.titles;
      firstPrompt = head.firstPrompt;
    }

    // The ladder, in the CLI's order. `summary` sits between `ai-title` and the
    // first prompt in the CLI and is deliberately absent here: it is not a
    // transcript entry type at all (0 of 1282 transcripts in the corpus this
    // was measured against carry one — it is session metadata the CLI keeps
    // elsewhere), so there is nothing in a transcript for a rung to read.
    //
    // `selfAssigned` is the one rung that is *not* the CLI's. The CLI prints the
    // address this app handed it through `--name`, but that address is a launch
    // flag the app invented, not a name the session earned, so it sits below the
    // session's own titles and only above the inferred first prompt. Ranking it
    // where the CLI does is what let a `--name` outrank the `ai-title` of a
    // session that had a real name of its own.
    if (titles.agent) {
      return { name: titles.agent, source: 'agent' };
    }
    if (titles.manual) {
      return { name: titles.manual, source: 'manual' };
    }
    if (titles.ai) {
      return { name: titles.ai, source: 'ai' };
    }
    if (titles.selfAssigned) {
      return { name: titles.selfAssigned, source: 'self-assigned' };
    }

    // Below the titles the CLI falls back to the session id; the app has a
    // better placeholder, so a transcript with no prompt at all is left to the
    // caller's fallback chain instead of being named after its id here.
    return firstPrompt ? { name: firstPrompt, source: 'derived' } : undefined;
  }
}
