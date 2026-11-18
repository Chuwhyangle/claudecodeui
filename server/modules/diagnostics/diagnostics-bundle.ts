/**
 * The copyable diagnostics bundle: a plain-text operator summary that can be
 * pasted into an issue without leaking a key, a prompt or a message body.
 *
 * The document is assembled from the ALREADY-REDACTED service output, and the
 * finished text is redacted once more on the way out. The second pass is not
 * redundant ceremony: the meta block is composed here from process facts the
 * service did not see, and a future line added here must not become a leak just
 * because the author forgot the rule. The redactor is the one
 * `diagnostics.service.ts` exports, so there is a single spelling of every
 * secret pattern in the module.
 *
 * WHAT IT NEVER CARRIES: prompts, message bodies, upstream response bodies or
 * credential values. The failure rows are correlation facts only (category,
 * upstream status, request id, model, protocol).
 *
 * Consumers: `diagnostics.module.ts` (the `GET /bundle` answer) and the
 * diagnostics service criterion.
 */
import {
  redactDiagnosticsText,
  type DiagnosticsBundleInput,
  type DiagnosticsFailure,
  type DiagnosticsFeature,
} from './diagnostics.service.js';

/** Renders one feature's health block. */
function renderFeature(feature: DiagnosticsFeature): string[] {
  const problems = feature.problems.length === 0 ? 'none' : feature.problems.join('; ');
  const lines = [
    `feature: ${feature.id} (${feature.label})`,
    `  state: ${feature.state}`,
    `  enabled: ${feature.enabled ? 'yes' : 'no'}`,
    `  config: ${feature.configSource ?? 'default'}`,
    `  lastSuccessAt: ${feature.lastSuccessAt ?? 'never'}`,
    `  problems: ${problems}`,
    `  lastFailure: ${feature.lastFailure === null ? 'none' : renderFailureSummary(feature.lastFailure)}`,
  ];
  return lines;
}

/** One line of correlation facts, never a body. */
function renderFailureSummary(failure: DiagnosticsFailure): string {
  return [
    `at=${failure.at}`,
    `feature=${failure.featureId}`,
    `category=${failure.category}`,
    `httpStatus=${failure.httpStatus === null ? 'none' : String(failure.httpStatus)}`,
    `durationMs=${String(failure.durationMs)}`,
    `requestId=${failure.requestId}`,
    `model=${failure.model}`,
    `protocol=${failure.protocol}`,
  ].join(' ');
}

/**
 * Renders the whole bundle.
 *
 * Consumers: `diagnostics.module.ts` (the `GET /bundle` answer).
 */
export function renderDiagnosticsBundle(input: DiagnosticsBundleInput): string {
  const { meta } = input;
  const lines: string[] = [
    'Cloudpit diagnostics bundle',
    `generatedAt: ${input.generatedAt}`,
    `version: ${meta.version ?? 'unknown'}`,
    `installForm: ${meta.installForm}`,
    `platform: ${meta.platform}`,
    `settingsSource: ${meta.settingsSource}`,
    `settingsPath: ${meta.settingsPath ?? 'default'}`,
    '',
    `features (${input.features.length}):`,
  ];

  if (input.features.length === 0) {
    lines.push('  none registered');
  } else {
    for (const feature of input.features) lines.push(...renderFeature(feature));
  }

  lines.push('', `recent failures (${input.failures.length}):`);
  if (input.failures.length === 0) {
    lines.push('  none');
  } else {
    for (const failure of input.failures) lines.push(`  - ${renderFailureSummary(failure)}`);
  }

  return redactDiagnosticsText(lines.join('\n'));
}
