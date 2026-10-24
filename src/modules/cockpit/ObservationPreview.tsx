import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { useWebSocketOptional } from '@/shared/context/WebSocketContext';
import { cn } from '@/shared/utils';
import type {
  ObservationStatusState,
  ObservationWallEntry,
} from '@/modules/cockpit/hooks/useObservationWall';
import { observationLiveness } from '@/modules/cockpit/ObservationTile';
import { cockpitViewPath } from '@/modules/cockpit/cockpitView';
import { parseObservationUri } from '@/modules/cockpit/observationUri';

/**
 * The stage's in-place preview of one observed object.
 *
 * OPENING THIS IS SEEING IT. The page advances the server-side seen cursor exactly once when
 * the preview opens (`POST /seen`), which clears the object's deltas on every device. 「稍后再看」
 * closes without moving the cursor — that is the whole difference between the two doors.
 *
 * WHAT EACH KIND SHOWS, and the one navigation it owns:
 *
 *   session      — the latest turn in full, plus its changes and test reading.
 *                  「在会话中打开」 is the ONLY link into the conversation.
 *   project      — the five-layer truth and the delta items behind them.
 *   architecture — the diff list and 「在架构 tab 中打开（高亮差异）」.
 *
 * The digest is the producer's document and this component treats it as opaque: a field it does
 * not recognise is not invented into a sentence. The structured fields it does read are named
 * here, and a missing one simply omits its line.
 */

const STATE_LABEL_KEYS: Record<ObservationStatusState, string> = {
  ok: 'cockpit.observationStateOk',
  attention: 'cockpit.observationStateAttention',
  red: 'cockpit.observationStateRed',
  unevaluated: 'cockpit.observationStateUnevaluated',
};

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '');
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/** The digest's change/test readings, across the field names producers actually use. */
function sessionChanges(digest: Record<string, unknown>): string[] {
  return [...stringList(digest.changes), ...stringList(digest.diff)];
}

function sessionTests(digest: Record<string, unknown>): string[] {
  const direct = [...stringList(digest.tests), ...stringList(digest.testResults)];
  const summary = stringValue(digest.tests);
  if (summary !== null) direct.push(summary);
  return direct;
}

/** The project's five-layer truth: `digest.layers` as `{ name: reading }`, or a stated absence. */
function projectLayers(digest: Record<string, unknown>): Array<[string, string]> {
  const layers = digest.layers;
  if (layers === null || typeof layers !== 'object' || Array.isArray(layers)) return [];
  return Object.entries(layers as Record<string, unknown>).map(([name, reading]) => [
    name,
    typeof reading === 'string'
      ? reading
      : reading === null || reading === undefined
        ? ''
        : JSON.stringify(reading),
  ]);
}

function architectureDiffs(entry: ObservationWallEntry): string[] {
  const digest = entry.object.digest;
  const explicit = [...stringList(digest.diffs), ...stringList(digest.delta), ...stringList(digest.changes)];
  return explicit.length > 0 ? explicit : entry.deltaItems;
}

// ── the second (LLM) digest tier ─────────────────────────────────────────────

/** What the producer wrote under `digest.llm`; recognised fields only, never invented. */
type SessionLlmReading = {
  /** `evaluated` carries the model's words; `skipped` / `unevaluated` carry only a reason. */
  state: string;
  conclusion: string | null;
  options: string[];
  driftNote: string | null;
  /** Why a skipped or failed tier produced no model reading. */
  reason: string | null;
};

/** Reads `digest.llm`, or null when this object carries no LLM-tier reading. */
function sessionLlmReading(digest: Record<string, unknown>): SessionLlmReading | null {
  const value = digest.llm;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const state = stringValue(record.state);
  if (state === null) return null;
  return {
    state,
    conclusion: stringValue(record.conclusion),
    options: stringList(record.options),
    driftNote: stringValue(record.driftNote),
    reason: stringValue(record.reason),
  };
}

/**
 * The model's one-sentence conclusion, its suggested replies, and the drift note.
 *
 * EVERY SENDING OPTION IS A TWO-STEP ACTION. Clicking an option only opens a confirmation
 * sentence (the same 「→ …: text」 wording the cockpit's send card uses); the text is sent as
 * one `chat.send` frame for THIS session only after 「发送」 is pressed. A ref remembers the one
 * option this preview has already sent, so a double click cannot deliver the same reply twice.
 *
 * The drift note is a semantic judgment, and the producer already appended 「仅作建议」 to it; the
 * UI must not present it as a reading. A skipped or failed tier shows only its stated reason —
 * the deterministic digest above it is still the reading of record.
 *
 * Used by ObservationPreview (session previews only).
 */
function SessionDigestLlmSection({ uri, llm }: { uri: string; llm: SessionLlmReading }) {
  const { t } = useTranslation();
  const socket = useWebSocketOptional();
  const parsed = parseObservationUri(uri);
  const sessionId = parsed !== null && parsed.kind === 'session' ? parsed.id : null;
  // The option whose confirmation sentence is open. The uri is kept with it so a preview
  // switched to another object cannot confirm the previous object's option.
  const [confirming, setConfirming] = useState<{ uri: string; option: string } | null>(null);
  // The one option this preview has already sent. A second confirm — a double click, a
  // replayed event — must be a no-op, so delivery is exactly once.
  const sentRef = useRef<string | null>(null);

  const pendingOption = confirming !== null && confirming.uri === uri ? confirming.option : null;

  const confirmSend = () => {
    if (pendingOption === null || sessionId === null || socket === null) return;
    const key = `${uri}\u0000${pendingOption}`;
    if (sentRef.current === key) return;
    sentRef.current = key;
    socket.sendMessage({ type: 'chat.send', sessionId, content: pendingOption });
    setConfirming(null);
  };

  if (llm.state !== 'evaluated') {
    return (
      <p
        className="text-xs text-muted-foreground"
        data-testid="observation-preview-llm-note"
        data-llm-state={llm.state}
      >
        {llm.reason ?? t('cockpit.observationNoReason')}
      </p>
    );
  }

  return (
    <div className="space-y-2" data-testid="observation-preview-llm">
      {llm.conclusion !== null && (
        <p className="text-xs text-foreground" data-testid="observation-preview-llm-conclusion">
          {llm.conclusion}
        </p>
      )}
      {llm.options.length > 0 && (
        <ul className="space-y-1" data-testid="observation-preview-llm-options">
          {llm.options.map((option, index) => (
            <li key={`${index}-${option}`}>
              <button
                type="button"
                onClick={() => setConfirming({ uri, option })}
                className="min-h-11 w-full rounded border border-border/60 px-2 py-1 text-left text-xs text-foreground hover:bg-accent sm:min-h-0"
                data-testid="observation-preview-llm-option"
                data-option-index={index}
              >
                {option}
              </button>
            </li>
          ))}
        </ul>
      )}
      {pendingOption !== null && (
        <div className="rounded border border-border/60 bg-muted/40 px-2 py-1" data-testid="observation-preview-llm-confirm-preview">
          <p className="text-xs text-foreground" data-testid="observation-preview-llm-confirm-text">
            {t('cockpit.echoConfirm', { text: pendingOption })}
          </p>
          <div className="mt-1 flex items-center gap-2">
            <button
              type="button"
              onClick={confirmSend}
              disabled={sessionId === null || socket === null}
              className="min-h-11 rounded border border-border/60 px-2 text-xs text-foreground hover:bg-accent disabled:opacity-50 sm:min-h-0 sm:py-0.5"
              data-testid="observation-preview-llm-confirm"
            >
              {t('cockpit.sendConfirm')}
            </button>
            <button
              type="button"
              onClick={() => setConfirming(null)}
              className="min-h-11 rounded border border-border/60 px-2 text-xs text-foreground hover:bg-accent sm:min-h-0 sm:py-0.5"
              data-testid="observation-preview-llm-cancel"
            >
              {t('cockpit.sendCancel')}
            </button>
          </div>
        </div>
      )}
      {llm.driftNote !== null && (
        <p className="text-xs text-amber-800 dark:text-amber-200" data-testid="observation-preview-llm-drift">
          {llm.driftNote}
        </p>
      )}
    </div>
  );
}

export type ObservationPreviewProps = {
  entry: ObservationWallEntry;
  now: number;
  /** Closes the preview WITHOUT advancing the seen cursor. */
  onLater: () => void;
  onTogglePin: () => void;
  pinPending?: boolean;
  /** Session only: the one door into the conversation. */
  onOpenSession?: () => void;
  /** Architecture only: open the architecture tab with the differences highlighted. */
  onOpenArchitecture?: () => void;
  /** Why 「在架构 tab 中打开」 cannot be offered, when it cannot. */
  architectureUnavailableReason?: string | null;
};

export default function ObservationPreview({
  entry,
  now,
  onLater,
  onTogglePin,
  pinPending = false,
  onOpenSession,
  onOpenArchitecture,
  architectureUnavailableReason = null,
}: ObservationPreviewProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { object } = entry;
  const state = object.status.state;
  const digest = object.digest;

  const recentTurn =
    stringValue(digest.recentTurn) ?? stringValue(digest.turn) ?? stringValue(digest.summary);
  const changes = sessionChanges(digest);
  const tests = sessionTests(digest);
  const llm = sessionLlmReading(digest);
  const layers = projectLayers(digest);
  const diffs = architectureDiffs(entry);
  // The producer's declaration is the whole point of the section: the defaults the store filled
  // guarantee it is non-empty, and a malformed/legacy payload renders no list rather than an
  // invented sentence.
  const blindSpots = stringList(object.blindSpots);

  /** The one door back to the material this projection compressed, per kind. */
  const rawMaterialLabelKey =
    object.kind === 'session'
      ? 'cockpit.observationOpenSession'
      : object.kind === 'project'
        ? 'cockpit.observationOpenQuay'
        : 'cockpit.observationOpenArchitecture';
  const rawMaterialDisabled =
    object.kind === 'session'
      ? onOpenSession === undefined
      : object.kind === 'architecture'
        ? onOpenArchitecture === undefined
        : false;
  const openRawMaterial = () => {
    if (object.kind === 'session') {
      onOpenSession?.();
      return;
    }
    if (object.kind === 'architecture') {
      onOpenArchitecture?.();
      return;
    }
    // A project object is addressed as `quay://<fleetProjectId>/board`; the cockpit's board view
    // is where the Quay panel for that project is drawn.
    const parsed = parseObservationUri(object.uri);
    if (parsed !== null && parsed.kind === 'project') {
      navigate(cockpitViewPath({ type: 'board', project: parsed.id }));
    }
  };

  return (
    <section
      className="flex min-h-0 flex-1 flex-col overflow-y-auto border-l border-border/40 bg-card p-3 text-xs text-foreground"
      aria-label={t('cockpit.observationPreviewLabel')}
      data-testid="cockpit-observation-preview"
      data-observation-uri={object.uri}
      data-observation-kind={object.kind}
    >
      <header className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h2
            className="truncate text-sm font-semibold text-foreground"
            title={object.title}
            data-testid="observation-preview-title"
          >
            {object.title}
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
            <span
              className={cn(
                'font-medium',
                state === 'attention' && 'text-amber-800 dark:text-amber-200',
                state === 'red' && 'text-red-800 dark:text-red-200',
                state !== 'attention' && state !== 'red' && 'text-foreground',
              )}
              data-testid="observation-preview-state"
              data-state={state}
            >
              {t(STATE_LABEL_KEYS[state])}
            </span>
            <span data-testid="observation-preview-liveness" data-updated-at={object.updatedAt}>
              {observationLiveness(object.updatedAt, now, t)}
            </span>
            <span>{t('cockpit.observationRevision', { revision: object.revision })}</span>
          </p>
        </div>
        <button
          type="button"
          onClick={onLater}
          className="min-h-11 shrink-0 rounded border border-border/60 px-2 text-xs text-foreground hover:bg-accent sm:min-h-0 sm:py-0.5"
          data-testid="observation-preview-later"
        >
          {t('cockpit.observationLater')}
        </button>
      </header>

      {state === 'unevaluated' && (
        <p className="mt-2 rounded border border-border/60 bg-muted/40 px-2 py-1 text-xs text-foreground" data-testid="observation-preview-reason">
          {object.status.reason ?? t('cockpit.observationNoReason')}
        </p>
      )}

      {object.kind === 'session' && (
        <div className="mt-2 space-y-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('cockpit.observationRecentTurn')}</p>
            <p className="mt-0.5 whitespace-pre-wrap text-xs text-foreground" data-testid="observation-preview-recent-turn">
              {recentTurn ?? t('cockpit.observationNoDigest')}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('cockpit.observationChanges')}</p>
            {changes.length === 0 ? (
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="observation-preview-changes">
                {t('cockpit.observationNoChanges')}
              </p>
            ) : (
              <ul className="mt-0.5 list-disc pl-5 text-xs" data-testid="observation-preview-changes">
                {changes.map((change, index) => (
                  <li key={`${index}-${change}`}>{change}</li>
                ))}
              </ul>
            )}
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('cockpit.observationTests')}</p>
            {tests.length === 0 ? (
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="observation-preview-tests">
                {t('cockpit.observationNoTests')}
              </p>
            ) : (
              <ul className="mt-0.5 list-disc pl-5 text-xs" data-testid="observation-preview-tests">
                {tests.map((test, index) => (
                  <li key={`${index}-${test}`}>{test}</li>
                ))}
              </ul>
            )}
          </div>
          {/* The second tier is drawn BELOW the deterministic reading it extends: the model's
              words never replace what was read off the transcript, and its options are the only
              place in the preview that can send anything. */}
          {llm !== null && <SessionDigestLlmSection uri={object.uri} llm={llm} />}
        </div>
      )}

      {object.kind === 'project' && (
        <div className="mt-2 space-y-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('cockpit.observationFiveLayers')}</p>
            {layers.length === 0 ? (
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="observation-preview-layers">
                {t('cockpit.observationNoDigest')}
              </p>
            ) : (
              <dl className="mt-0.5 space-y-1" data-testid="observation-preview-layers">
                {layers.map(([name, reading]) => (
                  <div key={name} className="flex gap-2">
                    <dt className="w-24 shrink-0 font-medium text-foreground">{name}</dt>
                    <dd className="min-w-0 flex-1 text-foreground">{reading}</dd>
                  </div>
                ))}
              </dl>
            )}
          </div>
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('cockpit.observationDeltas')}</p>
            {entry.deltaItems.length === 0 ? (
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="observation-preview-deltas">
                {t('cockpit.observationNoDeltas')}
              </p>
            ) : (
              <ul className="mt-0.5 list-disc pl-5 text-xs" data-testid="observation-preview-deltas">
                {entry.deltaItems.map((item, index) => (
                  <li key={`${index}-${item}`}>{item}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {object.kind === 'architecture' && (
        <div className="mt-2 space-y-2">
          <div>
            <p className="text-xs font-medium text-muted-foreground">{t('cockpit.observationDiffs')}</p>
            {diffs.length === 0 ? (
              <p className="mt-0.5 text-xs text-muted-foreground" data-testid="observation-preview-diffs">
                {t('cockpit.observationNoDeltas')}
              </p>
            ) : (
              <ul className="mt-0.5 list-disc pl-5 text-xs" data-testid="observation-preview-diffs">
                {diffs.map((diff, index) => (
                  <li key={`${index}-${diff}`}>{diff}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {/*
        THE LAST THING THE PREVIEW SAYS IS WHAT IT CANNOT SEE. Every tile is a projection; a
        detail that only repeats the readings would let the reader mistake the compression for
        the whole record. The declaration is followed immediately by the one door back to the
        material it compressed — the session, the Quay panel, or the architecture tab.
      */}
      <section
        className="mt-3 border-t border-border/40 pt-2"
        aria-label={t('cockpit.observationBlindSpots')}
        data-testid="observation-preview-blind-spots"
      >
        <p className="text-xs font-medium text-muted-foreground">{t('cockpit.observationBlindSpots')}</p>
        <ul
          className="mt-0.5 list-disc pl-5 text-xs text-foreground"
          data-testid="observation-preview-blind-spot-list"
        >
          {blindSpots.map((spot, index) => (
            <li key={`${index}-${spot}`} data-testid="observation-preview-blind-spot">
              {spot}
            </li>
          ))}
        </ul>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={openRawMaterial}
            disabled={rawMaterialDisabled}
            className="min-h-11 rounded border border-border/60 px-2 text-xs text-foreground hover:bg-accent disabled:opacity-50 sm:min-h-0 sm:py-0.5"
            data-testid="observation-preview-raw-material"
            data-raw-material-kind={object.kind}
          >
            {t(rawMaterialLabelKey)}
          </button>
          {object.kind === 'architecture' && architectureUnavailableReason !== null && (
            <span className="text-xs text-muted-foreground" data-testid="observation-preview-architecture-reason">
              {architectureUnavailableReason}
            </span>
          )}
        </div>
      </section>

      <footer className="mt-auto flex flex-wrap items-center gap-2 pt-3">
        <button
          type="button"
          onClick={onTogglePin}
          disabled={pinPending}
          className="min-h-11 rounded border border-border/60 px-2 text-xs text-foreground hover:bg-accent disabled:opacity-50 sm:min-h-0 sm:py-0.5"
          data-testid="observation-preview-pin"
          data-pinned={entry.pinned ? 'true' : 'false'}
        >
          {entry.pinned ? t('cockpit.observationUnpin') : t('cockpit.observationPin')}
        </button>
      </footer>
    </section>
  );
}
