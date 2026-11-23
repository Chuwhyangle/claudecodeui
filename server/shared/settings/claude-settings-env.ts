/**
 * The one reader for the Claude CLI's `env` block.
 *
 * WHY THIS FILE EXISTS. `~/.claude/settings.json` has an `env` block that the CLI
 * itself honours, and this deployment deliberately sets no `ANTHROPIC_*` in the
 * systemd unit — so a server-side reader that wants the gateway address or the
 * credential has to consult that file, not only `process.env`. The first copy
 * lives as a private method on `ClaudeProviderAuth`; this is the second, and a
 * second structurally identical reader is the point at which the shape is
 * extracted rather than copied again.
 *
 * A MISSING OR MALFORMED FILE IS NOT AN ERROR: it is the ordinary "nothing
 * configured here" state, and every caller falls through to its own default.
 * The reader never throws.
 *
 * Consumers: `server/modules/api-latency/api-latency-settings.service.ts` (the
 * gateway address, model and credential a probe measures).
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readObjectRecord } from '../utils/index.js';

/**
 * Read the `env` object of `<homeDir>/.claude/settings.json`.
 *
 * Returns an empty record for a missing file, an unparseable document, or a
 * document without an `env` object — the caller's defaults decide in all three
 * cases. `homeDir` is injected so a criterion never reads the developer's own
 * configuration.
 */
export async function readClaudeSettingsEnv(
  homeDir: string = os.homedir(),
): Promise<Record<string, unknown>> {
  try {
    const settingsPath = path.join(homeDir, '.claude', 'settings.json');
    const parsed: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
    return readObjectRecord(readObjectRecord(parsed)?.env) ?? {};
  } catch {
    return {};
  }
}
