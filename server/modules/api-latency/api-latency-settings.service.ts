/**
 * Which gateway a probe measures, and with which credential.
 *
 * The priority order is the CLI's own: the process environment first, then the
 * CLI's `~/.claude/settings.json` `env` block, then a built-in default. It is
 * resolved on EVERY measurement rather than cached, because switching this
 * deployment between gateways is done by editing that file — a cached reading
 * would keep pointing at the old one until a restart.
 *
 * The token is carried on {@link ResolvedApiLatencyGateway} only; every shape
 * that reaches the browser is {@link ApiLatencyGatewayTarget}, which has no
 * token field at all.
 *
 * Consumers: `api-latency-probe.service.ts` (reads the target and token) and the
 * routes, which answer the browser-safe half.
 */
import { readClaudeSettingsEnv } from '@/shared/settings/claude-settings-env.js';
import type { ResolvedApiLatencyGateway } from '@/shared/types.js';

/** The gateway used when neither the process env nor the CLI settings name one. */
const DEFAULT_BASE_URL = 'https://api.anthropic.com';

/** The model used when the caller names none and the configuration names none. */
const DEFAULT_MODEL = 'claude-sonnet-4-5';

/** The seams {@link resolveApiLatencyGateway} reads through; both injectable for criteria. */
export type ApiLatencyGatewayOptions = {
  /** The environment to read; defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** The home `~/.claude/settings.json` is found under; defaults to the process home. */
  homeDir?: string;
};

function readOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Strip Claude Code's context-window suffix (`[1m]` / `[1M]`).
 *
 * The gateway rejects a suffixed name with HTTP 400 "Invalid model name". The CLI
 * itself removes the suffix before sending, but a probe bypasses the CLI, so this
 * must happen here or every probe taken while such a model is selected fails.
 *
 * Consumers: this module (before the model is returned) and the probe service,
 * which strips again so a caller injecting its own resolver cannot send one.
 */
export function stripContextSuffix(model: string): string {
  return model.replace(/\[1m\]$/i, '').trim();
}

/**
 * Resolve the gateway URL, credential and model a probe should use.
 *
 * A malformed `baseUrl` is reported verbatim on `host` rather than replaced with
 * the default: the probe then fails with the real request error, which is the
 * finding — silently measuring api.anthropic.com while the operator pointed the
 * deployment somewhere else would be the worse answer.
 */
export async function resolveApiLatencyGateway(
  requestedModel?: string,
  options: ApiLatencyGatewayOptions = {},
): Promise<ResolvedApiLatencyGateway> {
  const env = options.env ?? process.env;
  const settingsEnv = await readClaudeSettingsEnv(options.homeDir);

  const baseUrl = readOptionalString(env.ANTHROPIC_BASE_URL)
    ?? readOptionalString(settingsEnv.ANTHROPIC_BASE_URL)
    ?? DEFAULT_BASE_URL;

  const envToken = readOptionalString(env.ANTHROPIC_AUTH_TOKEN)
    ?? readOptionalString(env.ANTHROPIC_API_KEY);
  const settingsToken = readOptionalString(settingsEnv.ANTHROPIC_AUTH_TOKEN)
    ?? readOptionalString(settingsEnv.ANTHROPIC_API_KEY);
  const token = envToken ?? settingsToken;

  const model = stripContextSuffix(
    requestedModel
      ?? readOptionalString(env.ANTHROPIC_MODEL)
      ?? readOptionalString(settingsEnv.ANTHROPIC_MODEL)
      ?? DEFAULT_MODEL,
  );

  let host = baseUrl;
  try {
    host = new URL(baseUrl).host;
  } catch {
    // Reported as-is; see the doc comment above.
  }

  return {
    baseUrl,
    host,
    model,
    hasCredential: token !== null,
    credentialSource: envToken ? 'env' : settingsToken ? 'settings.json' : null,
    token,
  };
}
