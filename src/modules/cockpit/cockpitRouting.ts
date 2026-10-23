import type { QuayFocusableObject, QuayObjectUri } from '@/shared/types';
import { buildVoiceReferencePack } from '@/modules/chat';
import type { VoiceReferencePack } from '@/modules/chat';
import { parseQuayUri } from '@/modules/quay';
import { parseCockpitIntent } from '@/modules/cockpit/cockpitIntent';
import type { CockpitIntent } from '@/modules/cockpit/cockpitIntent';
import type { CockpitProject } from '@/modules/cockpit/cockpitView';

/**
 * Where an unmatched cockpit phrase goes: the target conversation of the project the focused
 * object belongs to, previewed before anything is sent.
 *
 * THE COCKPIT HAS TWO DESTINATIONS, and the split is the parser's own answer, never a second
 * classifier: a phrase `parseCockpitIntent` recognises changes the view (reversible, no
 * confirmation), and everything else is treated as something said TO a project. Free-form speech
 * is never silently dropped, and it is never sent before the person confirms it.
 *
 * THE FLEET REGISTRY IS THE AUTHORITY for a project's target session. This module holds the two
 * calls it makes — {@link readCockpitInterfaceSession} and {@link writeCockpitInterfaceSession} —
 * and nothing else in the cockpit talks to the registry, so the fallback rules below exist in one
 * place. The registry is reached through {@link CockpitFleetPort}: the browser cannot spawn the
 * fleet CLI, so the port's production binding is the server route, and a test binds a stub.
 */

/** What the fleet registry answered about one project's pinned 「对人接口会话」. */
export type CockpitFleetReading =
  | { ok: true; interfaceSessionId: string | null }
  | { ok: false; reason: string };

/** The answer to a pin or clear. A refusal carries the reason verbatim so the UI can state it. */
export type CockpitFleetWriteResult = { ok: true } | { ok: false; reason: string };

/**
 * The fleet registry seam. One read and one write, matching the fleet CLI's
 * `registry interface-session get|set|clear` verbs exactly.
 */
export type CockpitFleetPort = {
  /** Reads the project's pinned target session; `null` means nothing is pinned. */
  readInterfaceSession: (projectId: string) => Promise<CockpitFleetReading>;
  /** Pins `sessionId` as the project's target session. */
  writeInterfaceSession: (projectId: string, sessionId: string) => Promise<CockpitFleetWriteResult>;
  /** Un-pins the project's target session. */
  clearInterfaceSession: (projectId: string) => Promise<CockpitFleetWriteResult>;
};

/** The reason recorded when the port throws rather than answering (an unreachable route, a dead CLI). */
export const COCKPIT_FLEET_UNAVAILABLE = 'unavailable';

/**
 * The one read of the project's pinned target session.
 *
 * A THROW IS AN ANSWER here, not an exception to propagate: "the fleet read port could not
 * answer" is one of the states the cockpit must route around (it falls back to the last-opened
 * session and says so), and an unhandled rejection would turn that into a blank stage instead.
 */
export async function readCockpitInterfaceSession(
  port: CockpitFleetPort,
  projectId: string,
): Promise<CockpitFleetReading> {
  try {
    return await port.readInterfaceSession(projectId);
  } catch {
    return { ok: false, reason: COCKPIT_FLEET_UNAVAILABLE };
  }
}

/**
 * The one write path: `sessionId === null` un-pins, anything else pins. Same throw-is-an-answer
 * rule as the read, so the UI can always state why a pin did not happen.
 */
export async function writeCockpitInterfaceSession(
  port: CockpitFleetPort,
  projectId: string,
  sessionId: string | null,
): Promise<CockpitFleetWriteResult> {
  try {
    return sessionId === null
      ? await port.clearInterfaceSession(projectId)
      : await port.writeInterfaceSession(projectId, sessionId);
  } catch {
    return { ok: false, reason: COCKPIT_FLEET_UNAVAILABLE };
  }
}

/**
 * The user's「钉选为目标会话」 action.
 *
 * IT WRITES ONLY TO THE FLEET. The cockpit keeps no local copy of the pin: a second store would
 * be a second answer to "which conversation is this project's target", and the fleet registry is
 * the one downstream consumers (the delegate refusal) actually read.
 */
export async function pinCockpitTargetSession(
  port: CockpitFleetPort,
  projectId: string,
  sessionId: string | null,
): Promise<CockpitFleetWriteResult> {
  return writeCockpitInterfaceSession(port, projectId, sessionId);
}

/**
 * Where a preview's target session came from.
 *
 *   pinned — the fleet registry's per-project field answered with a session
 *   recent — no pin (or no readable registry), so the last-opened session was used
 */
export type CockpitSendTargetSource = 'pinned' | 'recent';

/**
 * The confirmation card shown before anything is sent.
 *
 * It carries everything the bar renders AND the package the downstream reads: the reference-style
 * input pack (`focus`/`visible`/`history`/`tray` + text) is built at preview time, so what the
 * person confirms is byte-for-byte what leaves — there is no second build at send time that could
 * disagree with the preview.
 */
export type CockpitSendPreview = {
  projectId: string;
  projectName: string;
  /** The target conversation's session id. */
  sessionId: string;
  /** The conversation's title, when the caller could read one; `null` renders the id instead. */
  sessionTitle: string | null;
  source: CockpitSendTargetSource;
  /**
   * Why the fallback was used, when the fleet registry could not answer. `null` means either the
   * pin was used or the registry answered "nothing pinned" — both are ordinary, and the UI still
   * distinguishes them through `source`.
   */
  fleetUnavailableReason: string | null;
  /** The transcribed/typed text, verbatim. */
  text: string;
  /** The focused object's `quay://` address, or `null` (a preview is only built with a focus). */
  focusUri: string | null;
  /** Every reference the message body carries, in order, de-duplicated. */
  referenceUris: QuayObjectUri[];
  /** The A/B reference pack that is also the message's structured half. */
  pack: VoiceReferencePack;
  /** The message body sent on confirm: the text plus the reference URI list. */
  messageBody: string;
};

/**
 * Why a phrase produced no preview. Both are stated to the person rather than swallowed:
 *   no-focus   — nothing on the stage is focused, so there is no project to address
 *   no-session — the project has neither a pinned target nor a last-opened session
 */
export type CockpitNoTargetReason = 'no-focus' | 'no-session';

/** What one submitted phrase resolved to. */
export type CockpitRouteDecision =
  | { kind: 'intent'; intent: CockpitIntent }
  | { kind: 'preview'; preview: CockpitSendPreview }
  | {
      kind: 'no-target';
      reason: CockpitNoTargetReason;
      /** The project the phrase was addressed to, when a focus named one. */
      project: CockpitProject | null;
      /** The fleet registry's refusal, when that was part of why no target was found. */
      fleetUnavailableReason: string | null;
      /** The phrase, verbatim, so the notice can quote it. */
      text: string;
    };

/** Everything one submission is resolved against. Injected, so a test binds every seam. */
export type CockpitRouteInput = {
  text: string;
  /** The view's declared objects, in spatial order — the same set focus moves over. */
  visible: readonly QuayFocusableObject[];
  projects: readonly CockpitProject[];
  focusUri: string | null;
  fleet: CockpitFleetPort;
  /** The project's most recently opened session (the `ui_last_opened_session` reading). */
  recentSessionId: (projectId: string) => Promise<string | null> | string | null;
  /** Reads a conversation's title for the preview; absent leaves the bar showing the id. */
  sessionTitle?: (sessionId: string) => string | null | Promise<string | null>;
  /** Recently viewed references, oldest first — carried into the pack unchanged. */
  history?: readonly QuayObjectUri[];
  /** The input tray's pinned references — carried into the pack unchanged. */
  tray?: readonly QuayObjectUri[];
};

/**
 * Resolves the project a `quay://` address belongs to.
 *
 * The project segment is the project's quay-fleet REGISTRY ID; the display name is accepted as
 * a spoken alias because both name the same project to the person. The CloudCLI project id is
 * NOT matched — no address carries it any more, and treating a UUID as a handle is exactly the
 * drift this mapping exists to remove.
 */
export function cockpitProjectForUri(
  projects: readonly CockpitProject[],
  uri: string,
): CockpitProject | null {
  const parsed = parseQuayUri(uri);
  if (!parsed.ok) return null;
  const segment = parsed.object.project.toLowerCase();
  return (
    projects.find((project) => {
      const fleetProjectId = project.fleetProjectId ?? null;
      return fleetProjectId !== null && fleetProjectId.toLowerCase() === segment;
    }) ??
    projects.find((project) => project.name.toLowerCase() === segment) ??
    null
  );
}

/** De-duplicates references while preserving first-seen order. */
function uniqueUris(uris: readonly (QuayObjectUri | null)[]): QuayObjectUri[] {
  const seen = new Set<string>();
  const ordered: QuayObjectUri[] = [];
  for (const uri of uris) {
    if (uri === null || seen.has(uri)) continue;
    seen.add(uri);
    ordered.push(uri);
  }
  return ordered;
}

/**
 * The message body: what the person said, then the references it was said about.
 *
 * THE URI LIST IS THE POINT. Downstream resolves a reference by dereferencing the address, so a
 * message that named an object without carrying its URI would be unreadable to anyone but a human
 * looking at this screen.
 */
export function buildCockpitMessageBody(text: string, referenceUris: readonly string[]): string {
  const body = text.trim();
  if (referenceUris.length === 0) return body;
  return `${body}\n\n引用：\n${referenceUris.map((uri) => `- ${uri}`).join('\n')}`;
}

/**
 * Resolves one submitted phrase to a view change, a send preview, or a stated no-target.
 *
 * ORDER IS THE CONTRACT: a recognised intent is acted on and NEVER routed (the two destinations
 * are exclusive), and only an unmatched phrase is treated as speech addressed to the focused
 * project. The target session is read in the order the decision prescribes — fleet pin first,
 * then the last-opened session — and a fleet read that could not answer is recorded on the
 * preview rather than silently looking like "nothing pinned".
 */
export async function routeCockpitText(input: CockpitRouteInput): Promise<CockpitRouteDecision> {
  const intent = parseCockpitIntent(input.text, {
    visible: input.visible,
    projects: input.projects,
  });
  if (intent.kind !== 'unmatched') {
    return { kind: 'intent', intent };
  }

  const project =
    input.focusUri === null ? null : cockpitProjectForUri(input.projects, input.focusUri);
  if (project === null) {
    return {
      kind: 'no-target',
      reason: 'no-focus',
      project: null,
      fleetUnavailableReason: null,
      text: intent.text,
    };
  }

  const reading = await readCockpitInterfaceSession(input.fleet, project.projectId);
  let fleetUnavailableReason: string | null = null;
  let sessionId: string | null = null;
  let source: CockpitSendTargetSource = 'pinned';
  if (reading.ok) {
    sessionId = reading.interfaceSessionId;
  } else {
    fleetUnavailableReason = reading.reason;
    source = 'recent';
  }
  if (sessionId === null) {
    // Nothing pinned (or nothing readable): the fallback keeps the mouth working, and the preview
    // says which of the two happened.
    source = 'recent';
    try {
      sessionId = await input.recentSessionId(project.projectId);
    } catch {
      sessionId = null;
    }
  }

  if (sessionId === null) {
    return {
      kind: 'no-target',
      reason: 'no-session',
      project,
      fleetUnavailableReason,
      text: intent.text,
    };
  }

  const pack = buildVoiceReferencePack({
    utterance: intent.text,
    focusables: input.visible,
    focusUri: input.focusUri,
    ...(input.history === undefined ? {} : { history: input.history }),
    ...(input.tray === undefined ? {} : { tray: input.tray }),
  });
  const referenceUris = uniqueUris([
    pack.focus?.uri ?? null,
    ...pack.visible.map((object) => object.uri),
    ...pack.tray,
  ]);
  const sessionTitle =
    input.sessionTitle === undefined ? null : await input.sessionTitle(sessionId);

  return {
    kind: 'preview',
    preview: {
      projectId: project.projectId,
      projectName: project.name,
      sessionId,
      sessionTitle,
      source,
      fleetUnavailableReason,
      text: intent.text,
      focusUri: input.focusUri,
      referenceUris,
      pack,
      messageBody: buildCockpitMessageBody(intent.text, referenceUris),
    },
  };
}

/** The send seam the confirmation gate calls. */
export type CockpitSessionSender = (sessionId: string, content: string) => void;

/**
 * The confirmation gate: a preview exists, and nothing is sent until `confirm()`.
 *
 * WHY A GATE VALUE RATHER THAN A BOOLEAN. A boolean would let the page send from anywhere that
 * reads it; this object owns the one transition, and a second `confirm()` is a no-op instead of a
 * second message. `cancel()` closes it without sending, and both are observable by the seam.
 */
export type CockpitSendGate = {
  readonly preview: CockpitSendPreview;
  /** Sends once and returns true; a second call sends nothing and returns false. */
  confirm: () => boolean;
  /** Abandons the preview; any later `confirm()` sends nothing. */
  cancel: () => void;
};

/** Opens a confirmation gate over one preview. Constructing it sends nothing. */
export function openCockpitSendGate(
  preview: CockpitSendPreview,
  send: CockpitSessionSender,
): CockpitSendGate {
  let closed = false;
  return {
    preview,
    confirm() {
      if (closed) return false;
      closed = true;
      send(preview.sessionId, preview.messageBody);
      return true;
    },
    cancel() {
      closed = true;
    },
  };
}
