import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

import type { IProviderSessions } from '@/shared/interfaces.js';
import type {
  AnyRecord,
  CommandLifecycleState,
  CompactionInfo,
  FetchHistoryOptions,
  FetchHistoryResult,
  MessageOrigin,
  NormalizedMessage,
  SubagentActivity,
  SubagentInfo,
} from '@/shared/types.js';
import { COMMAND_LIFECYCLE_ROW_TYPE } from '@/shared/types.js';
import { parseFilesInputTag } from '@/shared/image-attachments.js';
import { prepareTranscriptMessages } from '@/shared/message-unification.js';
import {
  createNormalizedMessage,
  generateMessageId,
  isClaudeRequestCaptureRow,
  readObjectRecord,
  sliceTailPage,
  stripAnsiSequences,
  truncateSubagentActivity,
} from '@/shared/utils.js';
import { sessionsDb } from '@/modules/database/index.js';
import { summarizeClaudeTokenUsage } from '@/modules/providers/services/provider-token-usage.service.js';
import { takeHistoryLoadContext } from '@/modules/providers/services/session-history-cache.service.js';

const PROVIDER = 'claude';

/**
 * The command lifecycle states this build has a word for.
 *
 * A closed set rather than a cast: the row is an artifact an older or newer
 * build may have written, and a state this build cannot name would reach a
 * client as a queue entry it has no branch for — the same failure as an
 * unknown message kind, one layer earlier where dropping it is still cheap.
 */
const COMMAND_LIFECYCLE_STATES: readonly CommandLifecycleState[] = [
  'queued',
  'started',
  'cancelled',
  'completed',
];

/** The state a lifecycle row names, or null when it names one this build does not know. */
function readCommandLifecycleState(value: unknown): CommandLifecycleState | null {
  return typeof value === 'string' && (COMMAND_LIFECYCLE_STATES as readonly string[]).includes(value)
    ? (value as CommandLifecycleState)
    : null;
}

/** Tokens the way the CLI writes them: 725k rather than 724,871. */
const formatTokenCount = (tokens: number): string => {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  return tokens >= 1_000 ? `${Math.round(tokens / 1_000)}k` : `${tokens}`;
};

/** A duration the way the CLI writes one: `2m 22s`. */
const formatDuration = (milliseconds: number): string => {
  const seconds = Math.round(milliseconds / 1_000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

/**
 * Upper bound on how much of a subagent's timeline is sent to the client. A
 * long-running agent can record hundreds of tool calls, and the transcript only
 * ever shows them behind a collapsed header, so shipping the whole history on
 * every load costs far more than it shows.
 */
const MAX_TRANSMITTED_SUBAGENT_ACTIVITIES = 200;

type ClaudeToolResult = {
  content: unknown;
  isError: boolean;
  subagentTools?: SubagentActivity[];
  subagent?: SubagentInfo;
  toolUseResult?: unknown;
};

type ClaudeHistoryResult =
  | AnyRecord[]
  | {
    messages?: AnyRecord[];
    total?: number;
    hasMore?: boolean;
  };

type ClaudeHistoryMessagesResult =
  | AnyRecord[]
  | {
    messages: AnyRecord[];
    total: number;
    hasMore: boolean;
    offset?: number;
    limit?: number | null;
  };

type ClaudeSubagentTranscript = {
  activity: SubagentActivity[];
  model?: string;
  /**
   * True when the transcript's last tool call never received a result, which
   * is the only evidence in the file that the agent stopped mid-flight.
   */
  endedMidToolCall: boolean;
};

/**
 * Flattens one subagent transcript into the shared activity timeline.
 *
 * Assistant prose and reasoning are kept alongside the tool calls so the
 * transcript can replay what the agent actually did rather than listing tool
 * names with no narrative.
 */
async function readClaudeSubagentTranscript(filePath: string): Promise<ClaudeSubagentTranscript> {
  const activity: SubagentActivity[] = [];
  const transcript: ClaudeSubagentTranscript = { activity, endedMidToolCall: false };
  const toolsById = new Map<string, SubagentActivity>();

  try {
    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) {
        continue;
      }

      try {
        const entry = JSON.parse(line) as AnyRecord;
        const timestamp = typeof entry.timestamp === 'string' ? entry.timestamp : undefined;

        if (entry.message?.role === 'assistant' && Array.isArray(entry.message?.content)) {
          if (typeof entry.message.model === 'string') {
            transcript.model = entry.message.model;
          }

          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type === 'tool_use') {
              const tool: SubagentActivity = {
                kind: 'tool',
                toolId: String(part.id ?? ''),
                toolName: String(part.name ?? 'Tool'),
                toolInput: part.input,
                timestamp,
              };
              activity.push(tool);
              if (tool.toolId) {
                toolsById.set(tool.toolId, tool);
              }
              continue;
            }
            if (part.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
              activity.push({ kind: 'text', content: part.text, timestamp });
              continue;
            }
            if (part.type === 'thinking' && typeof part.thinking === 'string' && part.thinking.trim()) {
              activity.push({ kind: 'thinking', content: part.thinking, timestamp });
            }
          }
        }

        if (entry.message?.role === 'user' && Array.isArray(entry.message?.content)) {
          for (const part of entry.message.content as AnyRecord[]) {
            if (part.type !== 'tool_result') {
              continue;
            }

            const tool = toolsById.get(String(part.tool_use_id ?? ''));
            if (!tool) {
              continue;
            }

            tool.toolResult = {
              content: typeof part.content === 'string'
                ? part.content
                : Array.isArray(part.content)
                  ? part.content
                    .map((contentPart: AnyRecord) => contentPart?.text || '')
                    .join('\n')
                  : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
            };
          }
        }
      } catch {
        // Skip malformed lines that can happen during concurrent writes.
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`Error parsing agent file ${filePath}:`, message);
  }

  const lastActivity = activity[activity.length - 1];
  transcript.endedMidToolCall = lastActivity?.kind === 'tool' && !lastActivity.toolResult;

  return transcript;
}

type ClaudeSubagentMeta = {
  agentType?: string;
  description?: string;
};

/** Reads the sidecar `.meta.json` Claude writes next to a subagent transcript. */
async function readClaudeSubagentMeta(metaPath: string): Promise<ClaudeSubagentMeta> {
  try {
    const parsed = JSON.parse(await fsp.readFile(metaPath, 'utf8')) as AnyRecord;
    return {
      agentType: typeof parsed.agentType === 'string' ? parsed.agentType : undefined,
      description: typeof parsed.description === 'string' ? parsed.description : undefined,
    };
  } catch {
    return {};
  }
}

/**
 * Resolves where a subagent's transcript lives.
 *
 * Current Claude versions write it to
 * `<projectDir>/<providerSessionId>/subagents/agent-<agentId>.jsonl`; older
 * ones dropped it next to the parent transcript. Both are checked, newest
 * layout first, because a project directory usually holds sessions from
 * several CLI versions.
 */
async function findClaudeSubagentTranscript(
  projectDirectory: string,
  providerSessionId: string,
  agentId: string,
): Promise<{ transcriptPath: string; metaPath: string } | null> {
  const candidates = [
    path.join(projectDirectory, providerSessionId, 'subagents', `agent-${agentId}.jsonl`),
    path.join(projectDirectory, `agent-${agentId}.jsonl`),
  ];

  for (const transcriptPath of candidates) {
    try {
      await fsp.access(transcriptPath);
      return { transcriptPath, metaPath: transcriptPath.replace(/\.jsonl$/, '.meta.json') };
    } catch {
      // Try the next layout.
    }
  }

  return null;
}

type ClaudeTaskNotification = {
  /** `uuid` of the transcript row the notification came from, so it can be dropped. */
  sourceUuid: string;
  toolUseId: string;
  status: string;
  summary: string;
  result: string;
};

function readTaggedValue(content: string, tagName: string): string {
  const match = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`).exec(content);
  return match ? match[1].trim() : '';
}

/**
 * Collects every `<task-notification>` turn keyed by the tool call that
 * spawned the agent it reports on.
 *
 * Only notifications that name a tool-use id are collected: without one there
 * is no card to fold them into, and they must keep rendering on their own.
 */
function collectTaskNotifications(messages: AnyRecord[]): Map<string, ClaudeTaskNotification> {
  const notifications = new Map<string, ClaudeTaskNotification>();

  for (const message of messages) {
    if (message.message?.role !== 'user') {
      continue;
    }

    const content = message.message.content;
    const texts: string[] = typeof content === 'string'
      ? [content]
      : Array.isArray(content)
        ? content.filter((part: AnyRecord) => part?.type === 'text').map((part: AnyRecord) => String(part.text ?? ''))
        : [];

    for (const text of texts) {
      if (!text.trimStart().startsWith('<task-notification>')) {
        continue;
      }

      const toolUseId = readTaggedValue(text, 'tool-use-id');
      if (!toolUseId) {
        continue;
      }

      // A resumed agent notifies more than once; the last word wins.
      notifications.set(toolUseId, {
        sourceUuid: String(message.uuid ?? ''),
        toolUseId,
        status: readTaggedValue(text, 'status') || 'completed',
        summary: readTaggedValue(text, 'summary'),
        result: readTaggedValue(text, 'result'),
      });
    }
  }

  return notifications;
}

/** Reads the `tool_use_id` off the tool-result row that launched an agent. */
function readAgentToolUseId(message: AnyRecord): string | null {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return null;
  }

  for (const part of content) {
    if (part?.type === 'tool_result' && typeof part.tool_use_id === 'string') {
      return part.tool_use_id;
    }
  }

  return null;
}

/** Swaps an agent launch acknowledgement for the agent's actual answer. */
function replaceAgentToolResultContent(message: AnyRecord, replacement: string): void {
  const content = message.message?.content;
  if (!Array.isArray(content)) {
    return;
  }

  for (const part of content) {
    if (part?.type === 'tool_result') {
      part.content = replacement;
    }
  }
}

/**
 * Reads a Claude transcript's rows as a graph keyed by `uuid`.
 *
 * The file is append-only and every row names its predecessor in `parentUuid`,
 * so a conversation is a path through it rather than the whole file. Editing a
 * sent message makes a second path appear alongside the first.
 */
async function readTranscriptRows(jsonlPath: string, providerSessionId: string): Promise<AnyRecord[]> {
  const rows: AnyRecord[] = [];
  const fileStream = fs.createReadStream(jsonlPath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    const entry = parseTranscriptLine(line, providerSessionId);
    if (entry) {
      rows.push(entry);
    }
  }

  return rows;
}

/**
 * Bytes at the parse boundary hashed so a rewrite under an append is caught.
 *
 * A transcript is append-only in normal use, so comparing the bytes just before
 * where the previous parse stopped against their recorded digest separates the
 * two: an append leaves them untouched, an edit or rewind replaces them.
 */
const PREFIX_CHECKSUM_WINDOW_BYTES = 4096;

/**
 * Everything a later Claude history read needs to resume from where an earlier
 * one stopped instead of re-reading and re-parsing the whole JSONL file.
 *
 * Held by the session history cache on the entry it belongs to and handed back
 * through that cache's per-load context. `rows` are the rows parsed for
 * `[0, offset)` before branch dropping, so the resuming read re-runs every
 * downstream step — superseded-branch pruning, tool-result folding, sorting —
 * over the complete row set and cannot drift from a full parse.
 */
type ClaudeTranscriptResume = {
  /** Path the offset and rows were read from; a different path invalidates it. */
  transcriptPath: string;
  /** Byte offset just past the last complete line consumed. */
  offset: number;
  /** Rows parsed for `[0, offset)`, in file order. */
  rows: AnyRecord[];
  /** Bytes of the boundary window those `rows` were validated against. */
  windowBytes: number;
  /** Digest of the boundary window, to detect a rewrite under an append. */
  prefixChecksum: string;
};

function isClaudeTranscriptResume(value: unknown): value is ClaudeTranscriptResume {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const resume = value as Partial<ClaudeTranscriptResume>;
  return typeof resume.transcriptPath === 'string'
    && typeof resume.offset === 'number'
    && Array.isArray(resume.rows)
    && typeof resume.windowBytes === 'number'
    && typeof resume.prefixChecksum === 'string';
}

/**
 * Bytes of the transcript file the most recent history read parsed, reset at
 * the start of each read.
 *
 * Exposed for `session-history-incremental-cache.test.ts`, which asserts an
 * append parses only the appended tail; production never reads it.
 */
let transcriptParseBytes = 0;

/** Bytes parsed by the most recent Claude history read (see `transcriptParseBytes`). */
export function getClaudeTranscriptParseBytes(): number {
  return transcriptParseBytes;
}

/**
 * Parses one JSONL line, keeping only rows this session owns that belong to
 * the conversation. Request-capture rows are dropped here, at the one parse
 * boundary both the full read and the incremental tail read go through.
 */
function parseTranscriptLine(line: string, providerSessionId: string): AnyRecord | null {
  const text = line.endsWith('\r') ? line.slice(0, -1) : line;
  if (!text.trim()) {
    return null;
  }
  try {
    const entry = JSON.parse(text) as AnyRecord;
    if (entry.sessionId !== providerSessionId) {
      return null;
    }
    return isClaudeRequestCaptureRow(entry) ? null : entry;
  } catch {
    // A row can be half-written while the CLI is streaming into the file.
    return null;
  }
}

function digestPrefixWindow(bytes: Buffer): string {
  return createHash('sha1').update(bytes).digest('hex');
}

/** Reads and digests the `PREFIX_CHECKSUM_WINDOW_BYTES` before `offset`. */
async function readPrefixChecksum(
  jsonlPath: string,
  offset: number,
): Promise<{ windowBytes: number; checksum: string }> {
  const windowBytes = Math.min(offset, PREFIX_CHECKSUM_WINDOW_BYTES);
  if (windowBytes === 0) {
    return { windowBytes: 0, checksum: digestPrefixWindow(Buffer.alloc(0)) };
  }

  const handle = await fsp.open(jsonlPath, 'r');
  try {
    const window = Buffer.allocUnsafe(windowBytes);
    await handle.read(window, 0, windowBytes, offset - windowBytes);
    return { windowBytes, checksum: digestPrefixWindow(window) };
  } finally {
    await handle.close();
  }
}

/**
 * Reads the bytes after `fromOffset` and parses only the lines among them.
 *
 * Complete lines (ending in `\n`) are consumed and counted in
 * `transcriptParseBytes`. Bytes after the last newline are returned as
 * `trailingRows` when they already parse, but are deliberately left unconsumed,
 * so a row the CLI is still writing is re-read once complete rather than lost
 * or double-counted on the next append.
 */
async function readTranscriptRowsFrom(
  jsonlPath: string,
  providerSessionId: string,
  priorRows: AnyRecord[],
  fromOffset: number,
): Promise<{ rows: AnyRecord[]; offset: number; trailingRows: AnyRecord[] }> {
  const handle = await fsp.open(jsonlPath, 'r');
  let tail: Buffer;
  try {
    const stat = await handle.stat();
    const length = Math.max(0, stat.size - fromOffset);
    tail = Buffer.allocUnsafe(length);
    if (length > 0) {
      await handle.read(tail, 0, length, fromOffset);
    }
  } finally {
    await handle.close();
  }
  transcriptParseBytes += tail.length;

  const rows = priorRows.slice();
  const lastNewline = tail.lastIndexOf(0x0a);
  if (lastNewline !== -1) {
    for (const line of tail.subarray(0, lastNewline).toString('utf8').split('\n')) {
      const entry = parseTranscriptLine(line, providerSessionId);
      if (entry) {
        rows.push(entry);
      }
    }
  }

  const trailingRows: AnyRecord[] = [];
  const trailing = (lastNewline === -1 ? tail : tail.subarray(lastNewline + 1)).toString('utf8');
  if (trailing.trim()) {
    const entry = parseTranscriptLine(trailing, providerSessionId);
    if (entry) {
      trailingRows.push(entry);
    }
  }

  const offset = lastNewline === -1 ? fromOffset : fromOffset + lastNewline + 1;
  return { rows, offset, trailingRows };
}

/**
 * Resumes a Claude history read from a cached parse state, or returns null when
 * the file is not a clean append and the caller must re-parse it whole.
 *
 * The append checks, in order: same path; the file did not shrink; its mtime
 * did not move backward; and the bytes just before the previous offset still
 * digest to the recorded checksum — an edit or rewind rewrites them, an append
 * does not.
 */
async function resumeClaudeTranscript(
  jsonlPath: string,
  providerSessionId: string,
  previous: { resume: unknown; size: number; mtimeMs: number },
): Promise<{ rows: AnyRecord[]; resume: ClaudeTranscriptResume } | null> {
  const prior = previous.resume as ClaudeTranscriptResume;
  if (prior.transcriptPath !== jsonlPath) {
    return null;
  }

  let stat;
  try {
    stat = await fsp.stat(jsonlPath);
  } catch {
    return null;
  }
  if (!stat.isFile() || stat.size <= prior.offset || stat.mtimeMs < previous.mtimeMs) {
    return null;
  }

  const boundary = await readPrefixChecksum(jsonlPath, prior.offset);
  if (boundary.checksum !== prior.prefixChecksum) {
    return null;
  }

  const tail = await readTranscriptRowsFrom(jsonlPath, providerSessionId, prior.rows, prior.offset);
  const next = await readPrefixChecksum(jsonlPath, tail.offset);
  return {
    rows: [...tail.rows, ...tail.trailingRows],
    resume: {
      transcriptPath: jsonlPath,
      offset: tail.offset,
      rows: tail.rows,
      windowBytes: next.windowBytes,
      prefixChecksum: next.checksum,
    },
  };
}

/**
 * Reads a Claude transcript through the session history cache's per-load
 * context: parsing only the appended tail when the file grew by append, and
 * publishing the parse state the cache entry should carry.
 *
 * Returns the rows the history pipeline should normalize (consumed rows plus a
 * valid trailing line still being written) and the resume state for the next read.
 */
async function readClaudeTranscriptRows(
  sessionId: string,
  jsonlPath: string,
  providerSessionId: string,
): Promise<{ rows: AnyRecord[]; resume: ClaudeTranscriptResume }> {
  transcriptParseBytes = 0;
  const context = takeHistoryLoadContext(sessionId);

  if (context?.previous && isClaudeTranscriptResume(context.previous.resume)) {
    const resumed = await resumeClaudeTranscript(jsonlPath, providerSessionId, context.previous);
    if (resumed) {
      context.producedResume = resumed.resume;
      return resumed;
    }
  }

  const full = await readTranscriptRowsFrom(jsonlPath, providerSessionId, [], 0);
  const boundary = await readPrefixChecksum(jsonlPath, full.offset);
  const resume: ClaudeTranscriptResume = {
    transcriptPath: jsonlPath,
    offset: full.offset,
    rows: full.rows,
    windowBytes: boundary.windowBytes,
    prefixChecksum: boundary.checksum,
  };
  if (context) {
    context.producedResume = resume;
  }
  return { rows: [...full.rows, ...full.trailingRows], resume };
}

/** True for a row the user typed, as opposed to a tool result or an injected note. */
function isUserPromptRow(row: AnyRecord): boolean {
  if (row.type !== 'user' || row.isMeta === true || row.isCompactSummary === true) {
    return false;
  }

  const content = row.message?.content;
  if (Array.isArray(content)) {
    return content.some((part: AnyRecord) => part?.type === 'text' || part?.type === 'image');
  }

  return typeof content === 'string' && content.length > 0;
}

/**
 * Drops the rows belonging to prompts that were replaced by an edit.
 *
 * When a message is edited, Claude resumes the conversation partway and appends
 * the replacement, so the file holds both the abandoned attempt and the live
 * one. A flat read would show them stacked, which reads as the app having sent
 * the message twice.
 *
 * Two shapes mark a replaced prompt:
 *
 * 1. **Literal sibling** — two prompts parented onto the same row. This is the
 *    per-run edit, where the replacement is appended as a second child of the
 *    row the original came from.
 * 2. **Replaced across a turn-end block** — a resident session always writes
 *    `prompt_snapshot` / `stop_hook_summary` rows after a turn, so a prompt
 *    sent then abandoned parents onto that block instead of onto the assistant
 *    turn it followed. The replacement resumes at that assistant turn, so it is
 *    anchored directly on the abandoned prompt's nearest assistant ancestor
 *    (its branch point) — *there*, and not on any literal shared parent, is the
 *    supersede signal.
 *
 * Only sibling *prompts* are treated as a fork. Branch points made by parallel
 * tool calls are extremely common — one assistant turn writes several chained
 * rows and each tool result parents onto its own — and pruning those would
 * delete tool output from every transcript in the app.
 */
function dropSupersededPromptBranches(rows: AnyRecord[]): AnyRecord[] {
  const rowsByUuid = new Map<string, AnyRecord>();
  for (const row of rows) {
    if (typeof row.uuid === 'string') {
      rowsByUuid.set(row.uuid, row);
    }
  }

  // A row's branch point is its nearest assistant ancestor: the turn a resume
  // partway to it keeps. Parents are written before children, so one forward
  // pass resolves every chain.
  const branchPointOf = new Map<string, string | null>();
  for (const row of rows) {
    if (typeof row.uuid !== 'string') {
      continue;
    }
    const parent = typeof row.parentUuid === 'string' ? rowsByUuid.get(row.parentUuid) : undefined;
    if (!parent) {
      branchPointOf.set(row.uuid, null);
    } else if (parent.type === 'assistant') {
      branchPointOf.set(row.uuid, row.parentUuid as string);
    } else {
      branchPointOf.set(row.uuid, typeof parent.uuid === 'string' ? branchPointOf.get(parent.uuid) ?? null : null);
    }
  }

  const promptSiblings = new Map<string, AnyRecord[]>();
  const promptIndex = new Map<string, number>();
  rows.forEach((row, index) => {
    if (typeof row.uuid === 'string') {
      promptIndex.set(row.uuid, index);
    }
    if (typeof row.parentUuid !== 'string' || !isUserPromptRow(row)) {
      return;
    }
    const siblings = promptSiblings.get(row.parentUuid);
    if (siblings) {
      siblings.push(row);
    } else {
      promptSiblings.set(row.parentUuid, [row]);
    }
  });

  const supersededRoots = new Set<string>();
  for (const siblings of promptSiblings.values()) {
    if (siblings.length < 2) {
      continue;
    }
    // The transcript is append-only, so the last prompt written under a parent
    // is the one that replaced the others.
    for (const row of siblings.slice(0, -1)) {
      if (typeof row.uuid === 'string') {
        supersededRoots.add(row.uuid);
      }
    }
  }

  // A prompt is also superseded when a *later* prompt is anchored directly on
  // its branch point: the replacement skipped this prompt's whole subtree,
  // turn-end block included. Requiring that direct anchor — rather than merely
  // sharing the branch point — keeps a prompt sent after an abort (which
  // parents onto the interrupt marker, not the branch point) alive.
  for (const siblings of promptSiblings.values()) {
    for (const row of siblings) {
      if (typeof row.uuid !== 'string') {
        continue;
      }
      const branchPoint = branchPointOf.get(row.uuid);
      const anchoredAtBranch = branchPoint ? promptSiblings.get(branchPoint) : undefined;
      const selfIndex = promptIndex.get(row.uuid);
      if (!anchoredAtBranch || selfIndex === undefined) {
        continue;
      }
      const replaced = anchoredAtBranch.some(
        (candidate) => candidate.uuid !== row.uuid
          && typeof candidate.uuid === 'string'
          && (promptIndex.get(candidate.uuid) ?? -1) > selfIndex,
      );
      if (replaced) {
        supersededRoots.add(row.uuid);
      }
    }
  }

  if (supersededRoots.size === 0) {
    return rows;
  }

  const abandoned = new Set(supersededRoots);
  // Rows are appended in order, so one forward pass propagates each superseded
  // root to its whole subtree.
  for (const row of rows) {
    if (typeof row.parentUuid === 'string' && abandoned.has(row.parentUuid) && typeof row.uuid === 'string') {
      abandoned.add(row.uuid);
    }
  }

  return rows.filter((row) => typeof row.uuid !== 'string' || !abandoned.has(row.uuid));
}

async function getSessionMessages(
  sessionId: string,
  providerSessionId: string,
  limit: number | null,
  offset: number,
): Promise<ClaudeHistoryMessagesResult> {
  try {
    // The DB row is keyed by the app-facing session id, while the JSONL rows
    // on disk carry the provider-native id — both ids are needed here.
    const jsonLPath = sessionsDb.getSessionById(sessionId)?.jsonl_path;

    if (!jsonLPath) {
      return { messages: [], total: 0, hasMore: false };
    }

    const projectDir = path.dirname(jsonLPath);

    // Served through the history cache with a resume state, an append parses
    // only the new tail; every read still re-runs the full pipeline below over
    // the complete row set, so the result cannot drift from a whole-file parse.
    const transcript = await readClaudeTranscriptRows(sessionId, jsonLPath, providerSessionId);
    const messages = dropSupersededPromptBranches(transcript.rows);

    const agentIds = new Set<string>();
    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (agentId) {
        agentIds.add(String(agentId));
      }
    }

    // Read each spawned agent's own transcript once, then hang it off every
    // row that references it.
    const subagentsById = new Map<string, {
      activity: SubagentActivity[];
      info: SubagentInfo;
      endedMidToolCall: boolean;
    }>();
    for (const agentId of agentIds) {
      const located = await findClaudeSubagentTranscript(projectDir, providerSessionId, agentId);
      if (!located) {
        continue;
      }

      const [transcript, meta] = await Promise.all([
        readClaudeSubagentTranscript(located.transcriptPath),
        readClaudeSubagentMeta(located.metaPath),
      ]);

      subagentsById.set(agentId, {
        endedMidToolCall: transcript.endedMidToolCall,
        activity: transcript.activity
          .slice(0, MAX_TRANSMITTED_SUBAGENT_ACTIVITIES)
          .map(truncateSubagentActivity),
        info: {
          id: agentId,
          name: meta.agentType,
          type: meta.agentType,
          description: meta.description,
          model: transcript.model,
          status: 'completed',
          activityCount: transcript.activity.length,
        },
      });
    }

    // An async agent's launch result is internal bookkeeping ("Async agent
    // launched successfully…"); its real answer arrives later as a separate
    // `<task-notification>` turn. Folding the notification back onto the tool
    // call that started the agent keeps one card per agent instead of a card,
    // an unrelated status line, and a stray markdown reply.
    const notificationsByToolUseId = collectTaskNotifications(messages);
    const foldedNotificationUuids = new Set<string>();

    for (const message of messages) {
      const agentId = message.toolUseResult?.agentId;
      if (!agentId) {
        continue;
      }

      const subagent = subagentsById.get(String(agentId));
      const toolUseId = readAgentToolUseId(message);
      const notification = toolUseId ? notificationsByToolUseId.get(toolUseId) : undefined;
      // An async agent's launch row never tells you it finished — only the
      // later notification does. When that notification is missing (a live run,
      // or one compacted out of the transcript), the agent's own transcript is
      // the evidence: a timeline that does not stop mid-tool-call is done.
      const isAwaitingAsyncAgent = message.toolUseResult?.isAsync === true
        && !notification
        && (!subagent || subagent.endedMidToolCall);

      if (subagent) {
        if (subagent.activity.length > 0) {
          message.subagentTools = subagent.activity;
        }
        message.subagent = {
          ...subagent.info,
          description: subagent.info.description
            ?? (typeof message.toolUseResult?.description === 'string' ? message.toolUseResult.description : undefined),
          model: subagent.info.model
            ?? (typeof message.toolUseResult?.resolvedModel === 'string' ? message.toolUseResult.resolvedModel : undefined),
          status: isAwaitingAsyncAgent
            ? 'running'
            : notification && notification.status !== 'completed'
              ? 'failed'
              : 'completed',
        };
      }

      if (notification) {
        replaceAgentToolResultContent(message, notification.result || notification.summary);
        foldedNotificationUuids.add(notification.sourceUuid);
      } else if (message.toolUseResult?.isAsync === true) {
        // Without a notification there is no answer to show, and the launch
        // acknowledgement is internal bookkeeping the user must never read.
        replaceAgentToolResultContent(message, '');
      }
    }

    const sortedMessages = messages
      .filter((message) => !foldedNotificationUuids.has(String(message.uuid ?? '')))
      .sort(
      (a, b) => new Date(a.timestamp || 0).getTime() - new Date(b.timestamp || 0).getTime(),
    );
    const total = sortedMessages.length;

    if (limit === null) {
      return sortedMessages;
    }

    const startIndex = Math.max(0, total - offset - limit);
    const endIndex = total - offset;
    const paginatedMessages = sortedMessages.slice(startIndex, endIndex);
    const hasMore = startIndex > 0;

    return {
      messages: paginatedMessages,
      total,
      hasMore,
      offset,
      limit,
    };
  } catch (error) {
    console.error(`Error reading messages for session ${sessionId}:`, error);
    return limit === null ? [] : { messages: [], total: 0, hasMore: false };
  }
}

/**
 * Claude writes a mix of truly internal transcript rows and "UI-hidden" local
 * command artifacts into the same JSONL stream.
 *
 * Important distinction:
 * - system reminders / caveats / interruption banners should stay hidden
 * - local command payloads (`<command-name>...`) and stdout wrappers
 *   (`<local-command-stdout>...`) should be remapped into normal chat messages
 *   instead of being discarded as internal content
 *
 * Skill bodies belong in the first group. When a skill is invoked, Claude
 * injects the entire SKILL.md as a synthetic user turn. Persisted transcripts
 * tag it `isMeta: true`, but the live SDK stream does not, so without a
 * content-level check the same payload renders as a huge user bubble during the
 * run and then vanishes on reload. The skill is already represented by the
 * `Skill` tool call, so it is never user-visible content.
 */
const INTERNAL_CONTENT_PREFIXES = [
  '<system-reminder>',
  'Caveat:',
  '[Request interrupted',
  'Base directory for this skill:',
] as const;

function isInternalContent(content: string): boolean {
  return INTERNAL_CONTENT_PREFIXES.some((prefix) => content.startsWith(prefix));
}

/**
 * Claude wraps local slash-command metadata in lightweight XML-like tags inside
 * a plain string payload. We intentionally parse only the small tag surface we
 * care about instead of introducing a generic XML parser for untrusted history.
 */
function extractTaggedContent(content: string, tagName: string): string | null {
  const escapedTagName = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`<${escapedTagName}>([\\s\\S]*?)<\\/${escapedTagName}>`).exec(content);
  return match ? match[1] : null;
}

/**
 * The tag the CLI wraps a message another session sent in.
 *
 * A message delivered by a peer arrives on disk as a `user` row whose content is
 * `Another Claude session sent a message:` followed by this envelope; the
 * sender's actual words are what sits inside it.
 */
const CROSS_SESSION_ENVELOPE_TAG = 'cross-session-message';

/**
 * The sender's own message body, out of the transport envelope the CLI carried
 * it in, or the content unchanged when it names no envelope.
 *
 * A dedicated reader rather than {@link extractTaggedContent} because the
 * envelope tag carries attributes (`from-name`, `from-mode`) that that helper's
 * attribute-less pattern would not match — and unwrapping is what keeps the
 * transport's own `Another Claude session sent a message:` preamble out of the
 * transcript the reader sees.
 */
function unwrapCrossSessionMessage(content: string): string {
  const match = new RegExp(`<${CROSS_SESSION_ENVELOPE_TAG}\\b[^>]*>([\\s\\S]*?)<\\/${CROSS_SESSION_ENVELOPE_TAG}>`).exec(content);
  return match ? match[1].trim() : content;
}

/**
 * The peer `origin` the CLI writes on a row another session sent, read into the
 * shared vocabulary — or `null` for a row that carries none.
 *
 * This is the field that tells a real cross-session turn apart from the injected
 * internal turns {@link isInternalContent} hides. The CLI marks BOTH with
 * `isMeta: true`, and only the real one carries a first-class `origin` with
 * `kind: 'peer'`; the live path states the same fact on the turn's `result`
 * (`claude-host-driver.provider.ts`'s `finishUnattendedTurn`), but history is
 * where it was never read — so the row was dropped whole and the message never
 * reached a transcript. A `kind` this build does not know reads as no origin,
 * exactly as an unknown trigger does elsewhere: absent and unreadable both mean
 * "not a cause this build can name".
 */
function readClaudeRowOrigin(raw: AnyRecord): MessageOrigin | null {
  const origin = readObjectRecord(raw.origin);
  if (origin?.kind !== 'peer') {
    return null;
  }

  const name = origin.name;
  return {
    trigger: 'cross-session',
    sender: typeof name === 'string' && name.trim() ? name : null,
  };
}

/**
 * The `background-task` origin the CLI writes on a `<task-notification>` row —
 * the host layer's own turn reporting back — read into the shared vocabulary,
 * or `null` for a row that carries none.
 *
 * A second reader, not a widening of {@link readClaudeRowOrigin}. Both rows are
 * real content the `isMeta` gate must not hide, but a non-null return from that
 * reader routes its row into the cross-session branch, which unwraps an
 * envelope a notification does not carry — two facts, two readings. The cause
 * is read from the row's first-class `origin` rather than sniffed from its
 * `<task-notification>` body: the transcript states it, and every such row
 * carries it, so the cause is available without heuristics.
 */
function readClaudeNotificationOrigin(raw: AnyRecord): MessageOrigin | null {
  const origin = readObjectRecord(raw.origin);
  if (origin?.kind !== 'task-notification') {
    return null;
  }

  return { trigger: 'background-task', sender: null };
}

type ClaudeLocalCommandPayload = {
  commandName: string;
  commandMessage: string;
  commandArgs: string;
};

/**
 * Converts Claude's hidden local command wrapper into structured metadata.
 *
 * The three tags often coexist in one string payload. Returning `null` lets the
 * normal text path continue untouched for unrelated messages.
 */
function parseLocalCommandPayload(content: string): ClaudeLocalCommandPayload | null {
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
 * Produces the short user-visible command string that should appear in chat.
 *
 * We prefer the slash-prefixed command name because that most closely matches
 * what the user actually typed, and only fall back to the message body when the
 * command name is unavailable in older transcript variants.
 */
function buildLocalCommandDisplayText(payload: ClaudeLocalCommandPayload): string {
  const commandName = payload.commandName.trim();
  const commandMessage = payload.commandMessage.trim();
  const commandArgs = payload.commandArgs.trim();
  const baseCommand = commandName || commandMessage;

  if (!baseCommand) {
    return '';
  }

  return commandArgs ? `${baseCommand} ${commandArgs}` : baseCommand;
}

/**
 * The words of a message the CLI absorbed into a turn that was already running,
 * or null when the row is not one.
 *
 * A message sent mid-turn is not persisted as a `user` row: the CLI folds it
 * into the running turn and records it as an `attachment` of type
 * `queued_command` (its queue-operation row says `absorbed_mid_turn`). Without
 * this reading it reaches the model and is never drawn as something the person
 * said — which is every Live Voice sentence spoken while Claude is busy.
 *
 * Only a prompt the person sent qualifies. A row naming an `origin` is another
 * party's message (a task notification, a peer session) and keeps whatever
 * rendering that cause already has; a non-`prompt` command mode is a shell
 * line, not a sentence.
 */
function readQueuedCommandPrompt(raw: AnyRecord): string | null {
  if (raw.type !== 'attachment') {
    return null;
  }
  const attachment = readObjectRecord(raw.attachment);
  if (
    !attachment
    || attachment.type !== 'queued_command'
    || attachment.commandMode !== 'prompt'
    || attachment.origin != null
    || typeof attachment.prompt !== 'string'
  ) {
    return null;
  }
  const prompt = attachment.prompt.trim();
  return prompt && !isInternalContent(prompt) ? prompt : null;
}

/**
 * The transcript row's own identity, or null when it carries none.
 *
 * A synthesized id cannot serve as a fork anchor: it is minted per read, so the
 * row it named at render time would not be the row a later fork cut finds.
 */
function readClaudeRowUuid(raw: AnyRecord): string | null {
  return typeof raw.uuid === 'string' && raw.uuid ? raw.uuid : null;
}

/**
 * Whether a row is a real user prompt — not a tool result and not a row the CLI
 * injected. Only these open a turn for fork-anchor purposes.
 */
function isClaudePromptRow(raw: AnyRecord): boolean {
  if (raw.type !== 'user' || raw.isMeta) {
    return false;
  }
  const content = raw.message?.content;
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }
  if (Array.isArray(content)) {
    return content.some(
      (part: AnyRecord) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0,
    );
  }
  return false;
}

/** Whether an assistant row contributes text the user actually reads. */
function isClaudeAssistantTextRow(raw: AnyRecord): boolean {
  if (raw.type !== 'assistant' || raw.message?.role !== 'assistant') {
    return false;
  }
  const content = raw.message?.content;
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }
  if (Array.isArray(content)) {
    return content.some(
      (part: AnyRecord) => part?.type === 'text' && typeof part.text === 'string' && part.text.trim().length > 0,
    );
  }
  return false;
}

/**
 * The uuid of the row each turn should be forked from.
 *
 * A turn runs from one real user prompt to the next. Its fork anchor is the
 * *last* assistant row in it that carried text, so a fork lands after the whole
 * answer — not beside the intermediate "let me check" that precedes a tool
 * call, which would cut the turn mid-flight. The last text row is also the one
 * the transcript draws as the turn's final reply.
 *
 * The final turn is skipped while `running`: its answer is still arriving, and
 * a fork cut at a half-written turn copies an incomplete exchange. It is
 * skipped only for that window — once the session is idle the anchor is
 * written again, so the button is withheld, never lost.
 */
function collectClaudeForkAnchorUuids(rawMessages: AnyRecord[], running: boolean): Set<string> {
  const turns: string[][] = [];
  let currentTurnTextRowUuids: string[] = [];

  for (const raw of rawMessages) {
    if (isClaudePromptRow(raw)) {
      if (currentTurnTextRowUuids.length > 0) {
        turns.push(currentTurnTextRowUuids);
      }
      currentTurnTextRowUuids = [];
      continue;
    }
    if (isClaudeAssistantTextRow(raw)) {
      const uuid = readClaudeRowUuid(raw);
      if (uuid) {
        currentTurnTextRowUuids.push(uuid);
      }
    }
  }
  if (currentTurnTextRowUuids.length > 0) {
    turns.push(currentTurnTextRowUuids);
  }

  const anchors = new Set<string>();
  const lastTurnIndex = turns.length - 1;
  turns.forEach((rowUuids, index) => {
    // Nothing is skipped when idle, so a "never writes it" regression still
    // fails the idle half of the running/idle pair.
    if (running && index === lastTurnIndex) {
      return;
    }
    const anchor = rowUuids[rowUuids.length - 1];
    if (anchor) {
      anchors.add(anchor);
    }
  });
  return anchors;
}

export class ClaudeSessionsProvider implements IProviderSessions {
  /**
   * Normalizes one Claude JSONL entry or live SDK stream event into the shared
   * message shape consumed by REST and WebSocket clients.
   *
   * Every user turn it produces is stamped with the transcript row's `uuid`,
   * which is the anchor "edit this message" and "fork from here" address. It is
   * applied here rather than at each `createNormalizedMessage` call because the
   * row-shape branches below have several exits, and an anchor missing from one
   * of them would show up as a message the user silently cannot edit.
   */
  normalizeMessage(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const messages = this.normalizeMessageRows(rawMessage, sessionId);
    // A synthesized id is useless as an anchor — it changes on every read — so
    // a row without its own uuid produces messages with no anchor at all.
    const raw = readObjectRecord(rawMessage);
    const anchorId = typeof raw?.uuid === 'string' && raw.uuid ? raw.uuid : null;
    if (anchorId) {
      for (const message of messages) {
        if (message.role === 'user') {
          message.transcriptAnchorId = anchorId;
        }
      }
    }

    return messages;
  }

  private normalizeMessageRows(rawMessage: unknown, sessionId: string | null): NormalizedMessage[] {
    const raw = readObjectRecord(rawMessage);
    if (!raw) {
      return [];
    }

    // The SDK hands a partial assistant message over wrapped — the whole
    // Anthropic event sits under `event`, and the frame's own `type` is
    // `stream_event`. Unwrapping here is what puts the dispatch below back on
    // the event shape it was written for; reading `raw.delta` instead leaves
    // every partial frame unrecognized and the two streaming kinds unreachable.
    const streamEvent = raw.type === 'stream_event' ? readObjectRecord(raw.event) : raw;
    if (streamEvent?.type === 'content_block_delta' && streamEvent.delta?.text) {
      return [createNormalizedMessage({ kind: 'stream_delta', content: streamEvent.delta.text, sessionId, provider: PROVIDER })];
    }
    if (streamEvent?.type === 'content_block_stop') {
      return [createNormalizedMessage({ kind: 'stream_end', sessionId, provider: PROVIDER })];
    }

    const messages: NormalizedMessage[] = [];
    const ts = raw.timestamp || new Date().toISOString();
    const baseId = raw.uuid || generateMessageId('claude');

    // Where one queued user message is in the CLI's own queue. This is the only
    // place the dialect's `command_lifecycle` row becomes something a client can
    // see, and it is deliberately here rather than in whoever writes the row:
    // the row is the artifact and the wire shape is this function's business
    // (ADR-003 decision 7 — a producer that built the frame itself would be a
    // second implementation of the dialect, and the one that drifts).
    //
    // Both envelopes the CLI uses are accepted — a bare `command_lifecycle` row
    // and a `system` row carrying it as its subtype — because §9.2 records the
    // event's name but not which of the two carries it on any given build.
    const lifecycleState =
      raw.type === COMMAND_LIFECYCLE_ROW_TYPE ||
      (raw.type === 'system' && raw.subtype === COMMAND_LIFECYCLE_ROW_TYPE)
        ? readCommandLifecycleState(raw.state)
        : null;
    const commandUuid = typeof raw.command_uuid === 'string' && raw.command_uuid ? raw.command_uuid : null;
    if (lifecycleState && commandUuid) {
      // A row that names no command, or names a state this build has no word
      // for, normalizes to nothing: the client's whole reading of a withdrawal
      // is "which command, and where is it now", and a frame missing either
      // half would be a queue entry no client could place or settle.
      return [
        createNormalizedMessage({
          id: `${baseId}_lifecycle`,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'command_lifecycle',
          commandUuid,
          commandState: lifecycleState,
        }),
      ];
    }

    // A compaction is the most expensive thing a long session does without
    // being asked, and neither record that describes it survives the branches
    // below: `system` events normalize to nothing. Both become one ordinary
    // assistant row, so a client that knows nothing of `compact` still reads
    // the sentence, while one that does can draw it as a row of its own.
    if (raw.type === 'system' && (raw.subtype === 'compact_boundary' || raw.subtype === 'status')) {
      const compactionRow = (content: string, compact: CompactionInfo): NormalizedMessage[] => [
        createNormalizedMessage({
          id: `${baseId}_compact`,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content,
          compact,
        }),
      ];

      if (raw.subtype === 'compact_boundary') {
        // `compact_metadata` live, `compactMetadata` on disk.
        const metadata = readObjectRecord(raw.compact_metadata ?? raw.compactMetadata) ?? {};
        const trigger = metadata.trigger === 'manual' ? 'manual' : 'auto';
        const preTokens = Number(metadata.pre_tokens ?? metadata.preTokens) || 0;
        const postTokens = Number(metadata.post_tokens ?? metadata.postTokens) || 0;
        const durationMs = Number(metadata.duration_ms ?? metadata.durationMs) || 0;
        const said = ['Compacted', trigger];
        if (preTokens) {
          said.push(postTokens
            ? `${formatTokenCount(preTokens)} → ${formatTokenCount(postTokens)} tokens`
            : `${formatTokenCount(preTokens)} tokens`);
        }
        if (durationMs) {
          said.push(formatDuration(durationMs));
        }

        return compactionRow(said.join(' · '), {
          phase: 'done',
          trigger,
          preTokens,
          postTokens,
          durationMs,
        });
      }

      // A status message reports several things, and compaction is the only one
      // with anything to say: every other turn sends `requesting` or nothing.
      if (raw.status === 'compacting') {
        return compactionRow('Compacting conversation…', { phase: 'running' });
      }
      if (raw.compact_result === 'failed') {
        const error = typeof raw.compact_error === 'string' ? raw.compact_error : null;
        return compactionRow(`Compaction failed${error ? `: ${error}` : ''}`, {
          phase: 'failed',
          error,
        });
      }

      return [];
    }

    // A message sent while the CLI was mid-turn: no `user` row exists for it, only
    // the attachment the CLI folded it in as. It keeps the attachment row's own
    // uuid, so a later read and a live push name it the same way.
    const queuedPrompt = readQueuedCommandPrompt(raw);
    if (queuedPrompt !== null) {
      return [
        createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'user',
          content: queuedPrompt,
        }),
      ];
    }

    // A message another session sent is persisted as a `user` row that is BOTH
    // `isMeta: true` — the marker the check below hides injected skill bodies
    // and caveats under — AND carries a first-class peer `origin`. The `isMeta`
    // test alone drops it whole, which is why the origin is read here and
    // exempted: the cause the CLI stated is what tells a real turn another
    // session wrote apart from the injected content the gate exists to hide.
    const rowOrigin = readClaudeRowOrigin(raw);
    const notificationOrigin = readClaudeNotificationOrigin(raw);
    if (
      raw.message?.role === 'user'
      && raw.message?.content
      && (raw.isMeta !== true || rowOrigin !== null || notificationOrigin !== null)
    ) {
      // The one `isMeta` row that is real content: post the sender's body, not
      // the transport envelope, and carry the cause the transcript draws its
      // own row style and divider from. Handled before the internal-prefix and
      // local-command paths because it is neither — the envelope only looks
      // command-shaped, and it is the reason the message arrived, not a command.
      if (rowOrigin) {
        const text = typeof raw.message.content === 'string'
          ? raw.message.content
          : (raw.message.content as AnyRecord[])
              .filter((part) => part?.type === 'text' && typeof part.text === 'string')
              .map((part) => part.text as string)
              .join('\n');
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'user',
          content: unwrapCrossSessionMessage(text),
          origin: rowOrigin,
        }));
        return messages;
      }

      // A background task reporting back is persisted as an ordinary `user` row
      // with no `isMeta`, so the gate above never hid it — only the missing
      // cause did. The `<task-notification>` body is kept verbatim: the
      // transcript view parses it into a compact notification line, and it is
      // the origin, not the content, that tells the outline and the transcript
      // nobody typed this turn. Handled before the general user paths for the
      // same reason the peer row is: the reason it arrived is the fact, not a
      // shape for those paths to reparse.
      if (notificationOrigin) {
        const text = typeof raw.message.content === 'string'
          ? raw.message.content
          : (raw.message.content as AnyRecord[])
              .filter((part) => part?.type === 'text' && typeof part.text === 'string')
              .map((part) => part.text as string)
              .join('\n');
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'user',
          content: text,
          origin: notificationOrigin,
        }));
        return messages;
      }

      if (Array.isArray(raw.message.content)) {
        // Image attachments sent through the SDK are persisted as base64
        // `image` blocks next to the prompt text. Collect them so the UI can
        // render them on the user bubble.
        const imageAttachments: Array<{ data: string }> = [];
        for (const part of raw.message.content) {
          if (part?.type === 'image' && part.source?.type === 'base64' && typeof part.source.data === 'string') {
            const mediaType = typeof part.source.media_type === 'string' ? part.source.media_type : 'image/png';
            imageAttachments.push({ data: `data:${mediaType};base64,${part.source.data}` });
          }
        }
        let imagesAttached = false;
        let filesAttached = false;

        for (let partIndex = 0; partIndex < raw.message.content.length; partIndex++) {
          const part = raw.message.content[partIndex];
          if (part.type === 'tool_result') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_tr_${part.tool_use_id}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_result',
              toolId: part.tool_use_id,
              content: typeof part.content === 'string' ? part.content : JSON.stringify(part.content),
              isError: Boolean(part.is_error),
              toolUseResult: raw.toolUseResult,
            }));
          } else if (part.type === 'text') {
            const text = part.text || '';
            const parsedFiles = parseFilesInputTag(text);
            if (
              (parsedFiles.text || parsedFiles.attachments.length > 0)
              && !isInternalContent(parsedFiles.text)
            ) {
              messages.push(createNormalizedMessage({
                id: `${baseId}_text_${partIndex}`,
                sessionId,
                timestamp: ts,
                provider: PROVIDER,
                kind: 'text',
                role: 'user',
                content: parsedFiles.text,
                images: !imagesAttached && imageAttachments.length > 0 ? imageAttachments : undefined,
                files: !filesAttached && parsedFiles.attachments.length > 0
                  ? parsedFiles.attachments
                  : undefined,
              }));
              imagesAttached = true;
              filesAttached = filesAttached || parsedFiles.attachments.length > 0;
            }
          }
        }

        if (messages.length === 0) {
          const textParts = raw.message.content
            .filter((part: AnyRecord) => part.type === 'text')
            .map((part: AnyRecord) => part.text)
            .filter(Boolean)
            .join('\n');
          if (textParts && !isInternalContent(textParts)) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_text`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: textParts,
              images: imageAttachments.length > 0 ? imageAttachments : undefined,
            }));
            imagesAttached = true;
          }
        }

        // Image-only turns still deserve a user bubble even without text.
        if (!imagesAttached && imageAttachments.length > 0) {
          messages.push(createNormalizedMessage({
            id: `${baseId}_images`,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: '',
            images: imageAttachments,
          }));
        }
      } else if (typeof raw.message.content === 'string') {
        const text = raw.message.content;

        /**
         * Claude stores compact summaries as synthetic "user" rows so the CLI
         * can resume the next session turn with the summary in-context.
         *
         * For the web UI this is much more useful as assistant-authored summary
         * text; otherwise it is both filtered by the generic internal-prefix
         * check and visually mislabeled as a user message.
         */
        if (raw.isCompactSummary === true && text.trim()) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'assistant',
            content: text,
            isCompactSummary: true,
          }));
          return messages;
        }

        /**
         * Local slash commands are serialized as tagged text even though they
         * are semantically a user action. Expose the parsed fields to the
         * frontend and emit a plain user-visible command string so the command
         * no longer disappears from history.
         */
        const localCommandPayload = parseLocalCommandPayload(text);
        if (localCommandPayload) {
          const displayText = buildLocalCommandDisplayText(localCommandPayload);
          if (displayText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'user',
              content: displayText,
              commandName: localCommandPayload.commandName,
              commandMessage: localCommandPayload.commandMessage,
              commandArgs: localCommandPayload.commandArgs,
              isLocalCommand: true,
            }));
          }
          return messages;
        }

        /**
         * Local command stdout is also written as a "user" row in Claude's
         * transcript, but it is terminal output produced in response to the
         * command. Re-label it as assistant text so the chat transcript matches
         * the actual conversational flow seen by the user.
         */
        const localCommandStdout = extractTaggedContent(text, 'local-command-stdout');
        if (localCommandStdout !== null) {
          const stdoutText = stripAnsiSequences(localCommandStdout).trim();
          if (stdoutText) {
            messages.push(createNormalizedMessage({
              id: baseId,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: stdoutText,
              isLocalCommandStdout: true,
            }));
          }
          return messages;
        }

        const parsedFiles = parseFilesInputTag(text);
        if (
          (parsedFiles.text || parsedFiles.attachments.length > 0)
          && !isInternalContent(parsedFiles.text)
        ) {
          messages.push(createNormalizedMessage({
            id: baseId,
            sessionId,
            timestamp: ts,
            provider: PROVIDER,
            kind: 'text',
            role: 'user',
            content: parsedFiles.text,
            files: parsedFiles.attachments.length > 0 ? parsedFiles.attachments : undefined,
          }));
        }
      }
      return messages;
    }

    if (raw.type === 'thinking' && raw.message?.content) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'thinking',
        content: raw.message.content,
      }));
      return messages;
    }

    if (raw.type === 'tool_use' && raw.toolName) {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_use',
        toolName: raw.toolName,
        toolInput: raw.toolInput,
        toolId: raw.toolCallId || baseId,
      }));
      return messages;
    }

    if (raw.type === 'tool_result') {
      messages.push(createNormalizedMessage({
        id: baseId,
        sessionId,
        timestamp: ts,
        provider: PROVIDER,
        kind: 'tool_result',
        toolId: raw.toolCallId || '',
        content: raw.output || '',
        isError: false,
      }));
      return messages;
    }

    if (raw.message?.role === 'assistant' && raw.message?.content) {
      if (Array.isArray(raw.message.content)) {
        let partIndex = 0;
        for (const part of raw.message.content) {
          if (part.type === 'text' && part.text) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'text',
              role: 'assistant',
              content: part.text,
            }));
          } else if (part.type === 'tool_use') {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'tool_use',
              toolName: part.name,
              toolInput: part.input,
              toolId: part.id,
            }));
          } else if (part.type === 'thinking' && part.thinking) {
            messages.push(createNormalizedMessage({
              id: `${baseId}_${partIndex}`,
              sessionId,
              timestamp: ts,
              provider: PROVIDER,
              kind: 'thinking',
              content: part.thinking,
            }));
          }
          partIndex++;
        }
      } else if (typeof raw.message.content === 'string') {
        messages.push(createNormalizedMessage({
          id: baseId,
          sessionId,
          timestamp: ts,
          provider: PROVIDER,
          kind: 'text',
          role: 'assistant',
          content: raw.message.content,
        }));
      }
      return messages;
    }

    return messages;
  }

  /**
   * Finds the row to resume *through* so that `anchorId`'s turn is replaced.
   *
   * Walks up the `parentUuid` chain to the nearest assistant row, because the
   * SDK's `resumeSessionAt` is documented against assistant message ids — the
   * user row's immediate parent can be an attachment or an injected note.
   * Returns `null` when nothing precedes the edited prompt, which means the
   * conversation should start over rather than resume.
   */
  async resolveEditAnchor(
    sessionId: string,
    anchorId: string,
  ): Promise<{ found: boolean; resumeThroughId: string | null }> {
    const session = sessionsDb.getSessionById(sessionId);
    const jsonlPath = session?.jsonl_path;
    const providerSessionId = session?.provider_session_id;
    if (!jsonlPath || !providerSessionId) {
      return { found: false, resumeThroughId: null };
    }

    const rows = await readTranscriptRows(jsonlPath, providerSessionId);
    const byUuid = new Map<string, AnyRecord>();
    for (const row of rows) {
      if (typeof row.uuid === 'string') {
        byUuid.set(row.uuid, row);
      }
    }

    const target = byUuid.get(anchorId);
    if (!target) {
      return { found: false, resumeThroughId: null };
    }

    const visited = new Set<string>([anchorId]);
    let parentUuid: unknown = target.parentUuid;
    while (typeof parentUuid === 'string' && !visited.has(parentUuid)) {
      visited.add(parentUuid);
      const parent = byUuid.get(parentUuid);
      if (!parent) {
        break;
      }
      if (parent.type === 'assistant') {
        return { found: true, resumeThroughId: parentUuid };
      }
      parentUuid = parent.parentUuid;
    }

    return { found: true, resumeThroughId: null };
  }

  /**
   * Loads Claude JSONL history for a project/session and returns normalized
   * messages, preserving the existing pagination behavior from projects.js.
   */
  async fetchHistory(
    sessionId: string,
    options: FetchHistoryOptions = {},
  ): Promise<FetchHistoryResult> {
    const { limit = null, offset = 0 } = options;
    const providerSessionId = options.providerSessionId ?? sessionId;

    let result: ClaudeHistoryResult;
    try {
      // Load full history first so `total` reflects frontend-normalized messages,
      // not raw JSONL records.
      result = await getSessionMessages(sessionId, providerSessionId, null, 0);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[ClaudeProvider] Failed to load session ${sessionId}:`, message);
      return { messages: [], total: 0, hasMore: false, offset: 0, limit: null };
    }

    const rawMessages = Array.isArray(result) ? result : (result.messages || []);

    const toolResultMap = new Map<string, ClaudeToolResult>();
    for (const raw of rawMessages) {
      if (raw.message?.role === 'user' && Array.isArray(raw.message?.content)) {
        for (const part of raw.message.content) {
          if (part.type === 'tool_result' && part.tool_use_id) {
            toolResultMap.set(part.tool_use_id, {
              content: part.content,
              isError: Boolean(part.is_error),
              subagentTools: raw.subagentTools,
              subagent: raw.subagent,
              toolUseResult: raw.toolUseResult,
            });
          }
        }
      }
    }

    const forkAnchorUuids = collectClaudeForkAnchorUuids(rawMessages, options.running === true);

    const normalized: NormalizedMessage[] = [];
    for (const raw of rawMessages) {
      const messages = this.normalizeMessage(raw, sessionId);
      const rowUuid = readClaudeRowUuid(raw);
      if (rowUuid && forkAnchorUuids.has(rowUuid)) {
        // The anchor belongs on the answer the user reads. A row can normalize
        // into several messages (text + tool_use + thinking), so stamp the last
        // text-bearing one: exactly one message per turn carries the anchor.
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (message?.kind === 'text' && message.role === 'assistant') {
            message.forkAnchorId = rowUuid;
            break;
          }
        }
      }
      normalized.push(...messages);
    }

    for (const msg of normalized) {
      if (msg.kind === 'tool_use' && msg.toolId && toolResultMap.has(msg.toolId)) {
        const toolResult = toolResultMap.get(msg.toolId);
        if (!toolResult) {
          continue;
        }

        msg.toolResult = {
          content: typeof toolResult.content === 'string'
            ? toolResult.content
            : JSON.stringify(toolResult.content),
          isError: toolResult.isError,
          toolUseResult: toolResult.toolUseResult,
        };
        msg.subagentTools = toolResult.subagentTools;
        msg.subagent = toolResult.subagent;
      }
    }

    // Everything the transcript draws, and nothing else — so a page of N rows
    // is N rows the user sees, and `total` counts the same thing.
    const transcript = prepareTranscriptMessages(normalized);
    const total = transcript.length;
    const normalizedOffset = Math.max(0, offset);
    const normalizedLimit = limit === null ? null : Math.max(0, limit);
    const { page, hasMore } = sliceTailPage(transcript, normalizedLimit, normalizedOffset);

    return {
      messages: page,
      total,
      hasMore,
      offset: normalizedOffset,
      limit: normalizedLimit,
      // Carried on every page, like the Codex and OpenCode readers do, so the
      // composer's counter tracks the conversation instead of being frozen at
      // whatever it was when the session was opened.
      tokenUsage: summarizeClaudeTokenUsage(rawMessages),
    };
  }
}
