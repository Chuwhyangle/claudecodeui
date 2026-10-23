import type { QuayFocusableObject, QuayObjectUri } from '@/shared/types';
import { resolveVoiceReference } from '@/modules/chat';
import type { CockpitProject, CockpitView } from '@/modules/cockpit/cockpitView';

/**
 * The cockpit's fast-path intent parser: deterministic, local, no network and no LLM.
 *
 * The cockpit does not guess. A phrase it cannot map to a known action comes back as
 * `unmatched` and the UI says so verbatim — silently treating free-form speech as "do
 * nothing" (or worse, as some nearby view) is how a voice-first surface routes the wrong
 * object. The whole function is pure: it reads the text and the visible contract, nothing else.
 */

/**
 * What one submitted phrase asks the cockpit to do.
 *
 *   view      — switch the stage to a described view (fleet, or one project's board)
 *   focus     — move focus to one declared object (「第二个」/「②」/「红的那个」)
 *   zoom-in   — Enter's semantic twin: enlarge whatever is focused
 *   back      — return to the previous view
 *   unmatched — the phrase named nothing this parser knows; the UI states that
 */
export type CockpitIntent =
  | { kind: 'view'; view: CockpitView }
  | { kind: 'focus'; uri: QuayObjectUri }
  | { kind: 'zoom-in' }
  | { kind: 'back' }
  | { kind: 'unmatched'; text: string };

/**
 * What the parser resolves against: the view's declared focusable children and the projects
 * the cockpit can open. `visible` is the same spatial-ordered set the stage declares as its
 * view contract, so a phrase and a direction key resolve over identical objects.
 */
export type CockpitIntentContext = {
  visible: readonly QuayFocusableObject[];
  projects: readonly CockpitProject[];
};

/** 「返回」 — reachable without the Escape key, which aborts a running session turn elsewhere. */
const BACK_PATTERN = /(返回|回去|上一(个|页)?视图|后退|\bback\b)/;
/** 「全部项目」 — the fleet view. `^fleet$` rather than `\bfleet\b`: a hyphen is a word boundary,
 * so the latter also fires inside the project name `quay-fleet`, turning "open quay-fleet" into
 * "show the fleet". */
const ALL_PROJECTS_PATTERN = /(全部项目|所有项目|全部|项目总览|整个舰队|\ball projects\b|^fleet$)/;
/** 「放大」 — Enter's semantic twin. */
const ZOOM_PATTERN = /(放大|进入|\bzoom\b|\benter\b)/;
/** The verbs that make "看 <project>" / "打开 <project>" a view request rather than chatter. */
const VIEW_VERB_PATTERN = /(看|打开|显示|切到|去|\bview\b|\bopen\b|\bshow\b|\bgo to\b)/;
/** The noun that makes "<project> 任务板" a view request even without a verb. */
const BOARD_NOUN_PATTERN = /(任务板|看板|board)/;

/**
 * Finds the project a phrase names, preferring the longest match so a name that is a prefix
 * of another ("quay" vs "quay-fleet") never wins by accident.
 *
 * Only the display NAME is matched, not the database id: ids are opaque (some are bare
 * numerals), and a substring match on `1` would turn almost any sentence into "open project 1".
 * A non-numeric id is matched as a fallback because a deployment can name projects after it.
 */
function namedProject(
  projects: readonly CockpitProject[],
  normalized: string,
): CockpitProject | null {
  const candidates = projects
    .map((project) => {
      const name = project.name.trim().toLowerCase();
      const id = project.projectId.trim().toLowerCase();
      const nameMatches = name !== '' && normalized.includes(name);
      const idMatches = id !== '' && !/^\d+$/.test(id) && normalized.includes(id);
      if (!nameMatches && !idMatches) {
        return null;
      }
      return { project, matchedLength: nameMatches ? name.length : id.length };
    })
    .filter((candidate): candidate is { project: CockpitProject; matchedLength: number } => candidate !== null)
    .sort((left, right) => right.matchedLength - left.matchedLength);

  return candidates[0]?.project ?? null;
}

/**
 * Parses one submitted phrase against the current view contract and project list.
 *
 * ORDER IS LOAD-BEARING: the three whole-view commands are checked before project names
 * (「全部项目」 would otherwise be read as a project called 全部), and the referent resolver
 * runs last because it only claims phrases naming a display attribute — a project request
 * never carries one.
 */
export function parseCockpitIntent(text: string, context: CockpitIntentContext): CockpitIntent {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { kind: 'unmatched', text: trimmed };
  }
  const normalized = trimmed.toLowerCase();

  if (BACK_PATTERN.test(normalized)) {
    return { kind: 'back' };
  }
  if (ALL_PROJECTS_PATTERN.test(normalized)) {
    return { kind: 'view', view: { type: 'fleet' } };
  }
  if (ZOOM_PATTERN.test(normalized)) {
    return { kind: 'zoom-in' };
  }

  const project = namedProject(context.projects, normalized);
  if (project !== null && (VIEW_VERB_PATTERN.test(normalized) || BOARD_NOUN_PATTERN.test(normalized))) {
    return { kind: 'view', view: { type: 'board', project: project.projectId } };
  }

  const reference = resolveVoiceReference(context.visible, trimmed);
  if (reference.status === 'resolved') {
    return { kind: 'focus', uri: reference.object.uri };
  }

  return { kind: 'unmatched', text: trimmed };
}
