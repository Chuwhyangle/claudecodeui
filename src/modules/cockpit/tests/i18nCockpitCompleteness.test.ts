import { globSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * The cockpit renders every visible string through `react-i18next`, so each of the 12 shipped
 * locale bundles has to carry the `cockpit` block. react-i18next renders a missing key verbatim
 * — the failure mode the Quay tab once shipped (`tabs.quay` shown as literal text) — so this
 * walks the whole `locales/<lang>/common.json` glob rather than a hardcoded subset, and checks
 * interpolation placeholders too: `{{text}}` dropped in one language is a silently mangled
 * sentence, not a missing key.
 *
 * Resolved from the vitest process cwd (the repo root), the way the other filesystem-reading
 * tests in this repo do it: under jsdom `import.meta.url` is not a file: URL.
 */
const LOCALES_DIR = resolve(process.cwd(), 'src', 'modules', 'i18n', 'locales');

type CommonBundle = { cockpit?: Record<string, unknown> };

/** The `{{name}}` placeholders a translated sentence must keep, sorted for a stable comparison. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((match) => match[1]).sort();
}

/**
 * Why one locale's `cockpit` block fails the contract against the English reference; an empty
 * array means it passes. Returning reasons (not a boolean) is what lets the positive control
 * below prove the checker can actually go red.
 */
function cockpitProblems(bundle: CommonBundle, reference: Record<string, string>): string[] {
  const block = bundle.cockpit;
  if (block === undefined) {
    return ['cockpit block is missing'];
  }

  const problems: string[] = [];
  for (const [key, referenceValue] of Object.entries(reference)) {
    const value = block[key];
    if (typeof value !== 'string') {
      problems.push(`cockpit.${key} is missing or not a string`);
      continue;
    }
    if (value.trim().length === 0) {
      problems.push(`cockpit.${key} is an empty string`);
      continue;
    }
    if (value === key) {
      problems.push(`cockpit.${key} is the raw key name, not a label`);
      continue;
    }
    if (placeholders(value).join(',') !== placeholders(referenceValue).join(',')) {
      problems.push(`cockpit.${key} changes the placeholders of the English sentence`);
    }
  }

  return problems;
}

describe('every locale carries the cockpit copy', () => {
  const localeDirs = readdirSync(LOCALES_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const bundleFiles = globSync('*/common.json', { cwd: LOCALES_DIR }).sort();

  const readBundle = (file: string): CommonBundle =>
    JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf8')) as CommonBundle;

  const reference = readBundle('en/common.json').cockpit as Record<string, string>;

  it('covers every language directory on disk (the 12-locale glob, not a sampled subset)', () => {
    expect(bundleFiles).toEqual(localeDirs.map((dir) => `${dir}/common.json`));
    expect(localeDirs.length, `locale directories found: ${JSON.stringify(localeDirs)}`).toBeGreaterThanOrEqual(12);
  });

  it('gives every locale a complete, translated cockpit block with the same placeholders', () => {
    const offenders: string[] = [];
    for (const file of bundleFiles) {
      for (const problem of cockpitProblems(readBundle(file), reference)) {
        offenders.push(`${file}: ${problem}`);
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the English block itself is non-empty and every value differs from its key', () => {
    const keys = Object.keys(reference);
    expect(keys.length).toBeGreaterThan(20);
    for (const key of keys) {
      expect(reference[key].trim().length, `cockpit.${key}`).toBeGreaterThan(0);
      expect(reference[key], `cockpit.${key}`).not.toBe(key);
    }
  });

  // The mode switch, the attention badge, the row's deep-link action and the command
  // palette's two cockpit commands all render through this block. Naming them here keeps
  // a rename from being "covered" by the generic loop above while every locale silently
  // falls back to English.
  it('covers the cockpit entry control and its commands', () => {
    const required = [
      'modeSessions',
      'modeCockpit',
      'modeSwitchLabel',
      'attentionBadge',
      'attentionBadgeDetail',
      'attentionUnavailable',
      'openProject',
      'openCockpit',
      'openCockpitNewWindow',
    ];
    for (const key of required) {
      expect(typeof reference[key], `cockpit.${key}`).toBe('string');
      expect(reference[key].trim().length, `cockpit.${key}`).toBeGreaterThan(0);
    }
    // The badge's accessible name must carry the count, its sourced form the project list, and
    // the warning its reason.
    expect(placeholders(reference.attentionBadge)).toEqual(['n']);
    expect(placeholders(reference.attentionBadgeDetail)).toEqual(['n', 'projects']);
    expect(placeholders(reference.attentionUnavailable)).toEqual(['reason']);
  });

  // The observation wall's copy is a second surface with its own sentences: the three-state
  // readings, the liveness labels, the tile/preview actions and the three input echoes. Naming
  // them here keeps a rename from being "covered" by the generic loop while every locale
  // silently falls back to English — and the count-bearing sentences keep their placeholders.
  it('covers the observation wall and its echoes', () => {
    const required = [
      'wallView',
      'observationStateOk',
      'observationStateAttention',
      'observationStateRed',
      'observationStateUnevaluated',
      'observationKindSession',
      'observationKindProject',
      'observationKindArchitecture',
      'observationTemporary',
      'observationUnseen',
      'observationPin',
      'observationUnpin',
      'observationPinned',
      'observationAutoSurfaced',
      'observationOpen',
      'observationTileLabel',
      'observationCollapsed',
      'observationEmpty',
      'observationEmptyReason',
      'observationEmptyNext',
      'observationError',
      'observationSelfTitle',
      'observationSelfLastRun',
      'observationSelfNeverRan',
      'observationNoReason',
      'observationNoSummary',
      'observationJustNow',
      'observationMinutesAgo',
      'observationHoursAgo',
      'observationDaysAgo',
      'observationRevision',
      'observationPreviewLabel',
      'observationBlindSpots',
      'observationOpenQuay',
      'observationLater',
      'observationRecentTurn',
      'observationChanges',
      'observationNoChanges',
      'observationTests',
      'observationNoTests',
      'observationFiveLayers',
      'observationNoDigest',
      'observationDeltas',
      'observationNoDeltas',
      'observationDiffs',
      'observationOpenArchitecture',
      'observationOpenSession',
      'observationArchitectureUnavailable',
      'observationProducersOk',
      'observationSeenFailed',
      'observationSeenNext',
      'observationPinnedEcho',
      'observationUnpinnedEcho',
      'observationPinFailed',
      'observationPinNext',
      'echoDone',
      'echoSent',
      'echoCancelled',
      'echoUnmatched',
      'echoUnmatchedNext',
      'echoConfirm',
    ];
    for (const key of required) {
      expect(typeof reference[key], `cockpit.${key}`).toBe('string');
      expect(reference[key].trim().length, `cockpit.${key}`).toBeGreaterThan(0);
    }
    expect(placeholders(reference.observationUnseen)).toEqual(['n']);
    expect(placeholders(reference.observationCollapsed)).toEqual(['n']);
    expect(placeholders(reference.observationTileLabel)).toEqual(['position', 'state', 'title']);
    expect(placeholders(reference.observationSelfLastRun)).toEqual(['time']);
    expect(placeholders(reference.observationRevision)).toEqual(['revision']);
    expect(placeholders(reference.observationPinnedEcho)).toEqual(['title']);
    expect(placeholders(reference.observationUnpinnedEcho)).toEqual(['title']);
    expect(placeholders(reference.echoDone)).toEqual(['text']);
    expect(placeholders(reference.echoUnmatched)).toEqual(['text']);
    expect(placeholders(reference.echoConfirm)).toEqual(['text']);
    for (const key of ['observationMinutesAgo', 'observationHoursAgo', 'observationDaysAgo']) {
      expect(placeholders(reference[key]), `cockpit.${key}`).toEqual(['n']);
    }
  });

  // The initiative view and the decision queue are the third cockpit surface. Naming their copy
  // here keeps a rename from being "covered" by the generic loop while every locale silently
  // falls back to English — and the count/choice-bearing sentences keep their placeholders.
  it('covers the initiative view and the decision queue', () => {
    const required = [
      'initiativesView',
      'initiativeEmpty',
      'initiativeStatusActive',
      'initiativeStatusClosed',
      'initiativeProjects',
      'initiativeTasksCount',
      'initiativeGoalsCount',
      'initiativeLiaison',
      'initiativeEdgeBlocks',
      'initiativeEdgeContract',
      'initiativeEdgeRelease',
      'initiativeBlockedFor',
      'initiativeDurationJustNow',
      'initiativeDurationMinutes',
      'initiativeDurationHours',
      'initiativeDurationDays',
      'initiativeCharter',
      'initiativeCharterIntent',
      'initiativeCharterCompletion',
      'initiativeCharterExit',
      'initiativeCharterGrant',
      'initiativeCharterEscalate',
      'initiativeExpiresAt',
      'initiativePin',
      'initiativeUnpin',
      'initiativePinFailed',
      'initiativePinNext',
      'initiativeUnavailable',
      'decisionQueue',
      'decisionQueueEmpty',
      'decisionInitiative',
      'decisionPreviewChoice',
      'decisionRationale',
      'decisionRationalePlaceholder',
      'decisionConfirm',
      'decisionCancel',
      'decisionDone',
      'decisionFailed',
      'decisionAuditGroup',
      'decisionAuditEmpty',
      'decisionAuditChoice',
      'decisionAuditNote',
      'decisionAuditNotePlaceholder',
      'decisionAuditAgree',
      'decisionAuditObject',
      'decisionAuditAgreed',
      'decisionAuditObjected',
      'decisionAuditObjectionDefault',
    ];
    for (const key of required) {
      expect(typeof reference[key], `cockpit.${key}`).toBe('string');
      expect(reference[key].trim().length, `cockpit.${key}`).toBeGreaterThan(0);
    }
    expect(placeholders(reference.initiativeTasksCount)).toEqual(['n']);
    expect(placeholders(reference.initiativeGoalsCount)).toEqual(['n']);
    expect(placeholders(reference.initiativeLiaison)).toEqual(['liaison']);
    expect(placeholders(reference.initiativeBlockedFor)).toEqual(['duration']);
    expect(placeholders(reference.initiativeExpiresAt)).toEqual(['time']);
    expect(placeholders(reference.initiativeUnavailable)).toEqual(['reason']);
    expect(placeholders(reference.decisionInitiative)).toEqual(['slug']);
    expect(placeholders(reference.decisionPreviewChoice)).toEqual(['choice']);
    expect(placeholders(reference.decisionAuditChoice)).toEqual(['by', 'chosen', 'kind']);
    for (const key of ['initiativeDurationMinutes', 'initiativeDurationHours', 'initiativeDurationDays']) {
      expect(placeholders(reference[key]), `cockpit.${key}`).toEqual(['n']);
    }
  });

  // The project strip's refusal copy: a project the fleet cannot address (or whose driver is
  // down) stays clickable and answers with a reason and a next step. Naming the keys here keeps
  // the generic loop above from silently "covering" a rename with the English fallback.
  it('covers the unopenable-project feedback copy', () => {
    const required = [
      'projectNotRegistered',
      'projectDriverUnavailable',
      'projectOpenRefused',
      'fleetNeedsYou',
      'projectUnregisteredNext',
      'projectDriverUnavailableNext',
      'fleetCliMissingNext',
      'ordinalsRegisteredOnly',
      'ordinalUnavailable',
      'ordinalUnavailableNext',
    ];
    for (const key of required) {
      expect(typeof reference[key], `cockpit.${key}`).toBe('string');
      expect(reference[key].trim().length, `cockpit.${key}`).toBeGreaterThan(0);
    }
    expect(placeholders(reference.projectOpenRefused)).toEqual(['name']);
    expect(placeholders(reference.fleetNeedsYou)).toEqual(['name']);
    expect(placeholders(reference.ordinalUnavailable)).toEqual(['n']);
  });

  // Positive control: the same checker must reject a missing block, a blank value, a key-copied
  // value and a dropped placeholder. Without this the green above could not go red.
  it('rejects a missing, blank, key-copied or placeholder-dropping block (positive control)', () => {
    const sample = { title: 'Cockpit', intentUnmatched: 'Not recognised: “{{text}}”.' };

    expect(cockpitProblems({}, sample)).toContain('cockpit block is missing');
    expect(cockpitProblems({ cockpit: {} }, sample)).toContain(
      'cockpit.title is missing or not a string',
    );
    expect(cockpitProblems({ cockpit: { title: '  ', intentUnmatched: 'x {{text}}' } }, sample)).toContain(
      'cockpit.title is an empty string',
    );
    expect(cockpitProblems({ cockpit: { title: 'title', intentUnmatched: 'x {{text}}' } }, sample)).toContain(
      'cockpit.title is the raw key name, not a label',
    );
    expect(cockpitProblems({ cockpit: { title: 'Cockpit', intentUnmatched: 'x' } }, sample)).toContain(
      'cockpit.intentUnmatched changes the placeholders of the English sentence',
    );
  });
});
