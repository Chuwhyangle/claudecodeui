import express, { type Request, type Response } from 'express';

import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { providerMcpService } from '@/modules/providers/services/mcp.service.js';
import { providerModelsService } from '@/modules/providers/services/provider-models.service.js';
import { providerTokenUsageService } from '@/modules/providers/services/provider-token-usage.service.js';
import { providerSkillsService } from '@/modules/providers/services/skills.service.js';
import { sessionConversationsSearchService } from '@/modules/providers/services/session-conversations-search.service.js';
import { sessionsService } from '@/modules/providers/services/sessions.service.js';
import { uiLastOpenedSessionService } from '@/modules/providers/services/ui-last-opened-session.service.js';
import type {
  CustomProviderModelInput,
  HostMode,
  ProviderModelConfig,
  ProviderModelEnvRow,
  LLMProvider,
  McpScope,
  McpTransport,
  ProviderSkillCreateFile,
  ProviderSkillCreateInput,
  SessionLaunchSelection,
  UpsertProviderMcpServerInput,
} from '@/shared/types.js';
import { AppError, asyncHandler, createApiSuccessResponse } from '@/shared/utils.js';

const router = express.Router();

const readPathParam = (value: unknown, name: string): string => {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }

  throw new AppError(`${name} path parameter is invalid.`, {
    code: 'INVALID_PATH_PARAMETER',
    statusCode: 400,
  });
};

const normalizeProviderParam = (value: unknown): string =>
  readPathParam(value, 'provider').trim().toLowerCase();

const SESSION_ID_PATTERN = /^[a-zA-Z0-9._-]{1,120}$/;

const parseSessionId = (value: unknown): string => {
  const sessionId = readPathParam(value, 'sessionId').trim();
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new AppError('Invalid sessionId.', {
      code: 'INVALID_SESSION_ID',
      statusCode: 400,
    });
  }

  return sessionId;
};

const readOptionalQueryString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
};

const parseOptionalBooleanQuery = (value: unknown, name: string): boolean | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'true') {
    return true;
  }
  if (normalized === 'false') {
    return false;
  }

  throw new AppError(`${name} must be "true" or "false".`, {
    code: 'INVALID_QUERY_PARAMETER',
    statusCode: 400,
  });
};

const parseMcpScope = (value: unknown): McpScope | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'user' || normalized === 'local' || normalized === 'project') {
    return normalized;
  }

  throw new AppError(`Unsupported MCP scope "${normalized}".`, {
    code: 'INVALID_MCP_SCOPE',
    statusCode: 400,
  });
};

const parseMcpTransport = (value: unknown): McpTransport => {
  const normalized = readOptionalQueryString(value);
  if (!normalized) {
    throw new AppError('transport is required.', {
      code: 'MCP_TRANSPORT_REQUIRED',
      statusCode: 400,
    });
  }

  if (normalized === 'stdio' || normalized === 'http' || normalized === 'sse') {
    return normalized;
  }

  throw new AppError(`Unsupported MCP transport "${normalized}".`, {
    code: 'INVALID_MCP_TRANSPORT',
    statusCode: 400,
  });
};

const parseMcpUpsertPayload = (payload: unknown): UpsertProviderMcpServerInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const name = readOptionalQueryString(body.name);
  if (!name) {
    throw new AppError('name is required.', {
      code: 'MCP_NAME_REQUIRED',
      statusCode: 400,
    });
  }

  const transport = parseMcpTransport(body.transport);
  const scope = parseMcpScope(body.scope);
  const workspacePath = readOptionalQueryString(body.workspacePath);

  return {
    name,
    transport,
    scope,
    workspacePath,
    command: readOptionalQueryString(body.command),
    args: Array.isArray(body.args) ? body.args.filter((entry): entry is string => typeof entry === 'string') : undefined,
    env: typeof body.env === 'object' && body.env !== null
      ? Object.fromEntries(
        Object.entries(body.env as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
    cwd: readOptionalQueryString(body.cwd),
    url: readOptionalQueryString(body.url),
    headers: typeof body.headers === 'object' && body.headers !== null
      ? Object.fromEntries(
        Object.entries(body.headers as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
    envVars: Array.isArray(body.envVars)
      ? body.envVars.filter((entry): entry is string => typeof entry === 'string')
      : undefined,
    bearerTokenEnvVar: readOptionalQueryString(body.bearerTokenEnvVar),
    envHttpHeaders: typeof body.envHttpHeaders === 'object' && body.envHttpHeaders !== null
      ? Object.fromEntries(
        Object.entries(body.envHttpHeaders as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
      : undefined,
  };
};

const parseProviderSkillCreatePayload = (payload: unknown): ProviderSkillCreateInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const rawEntries = Array.isArray(body.entries)
    ? body.entries
    : typeof body.content === 'string'
      ? [{
          content: body.content,
          directoryName: body.directoryName,
          fileName: body.fileName,
          files: body.files,
        }]
      : null;

  if (!rawEntries || rawEntries.length === 0) {
    throw new AppError('At least one skill entry is required.', {
      code: 'PROVIDER_SKILLS_REQUIRED',
      statusCode: 400,
    });
  }

  const entries = rawEntries.map((entry, index) => {
    if (!entry || typeof entry !== 'object') {
      throw new AppError(`Skill entry ${index + 1} must be an object.`, {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }

    const record = entry as Record<string, unknown>;
    const content = typeof record.content === 'string' ? record.content : '';
    const directoryName = readOptionalQueryString(record.directoryName);
    const fileName = readOptionalQueryString(record.fileName);
    const rawFiles = record.files;

    if (!content.trim()) {
      throw new AppError(`Skill entry ${index + 1} must include markdown content.`, {
        code: 'PROVIDER_SKILL_CONTENT_REQUIRED',
        statusCode: 400,
      });
    }

    if (rawFiles !== undefined && !Array.isArray(rawFiles)) {
      throw new AppError(`Skill entry ${index + 1} files must be an array.`, {
        code: 'INVALID_REQUEST_BODY',
        statusCode: 400,
      });
    }

    const files: ProviderSkillCreateFile[] | undefined = rawFiles?.map((file, fileIndex) => {
      if (!file || typeof file !== 'object') {
        throw new AppError(`Skill entry ${index + 1} file ${fileIndex + 1} must be an object.`, {
          code: 'INVALID_REQUEST_BODY',
          statusCode: 400,
        });
      }

      const fileRecord = file as Record<string, unknown>;
      const relativePath = readOptionalQueryString(fileRecord.relativePath);
      const fileContent = typeof fileRecord.content === 'string' ? fileRecord.content : null;
      const encoding = fileRecord.encoding === 'utf8' || fileRecord.encoding === 'base64'
        ? fileRecord.encoding
        : null;

      if (!relativePath || fileContent === null || !encoding) {
        throw new AppError(
          `Skill entry ${index + 1} file ${fileIndex + 1} requires relativePath, content, and encoding.`,
          {
            code: 'INVALID_REQUEST_BODY',
            statusCode: 400,
          },
        );
      }

      return {
        relativePath,
        content: fileContent,
        encoding,
      };
    });

    return {
      content,
      directoryName,
      fileName,
      files,
    };
  });

  return { entries };
};

const parseProvider = (value: unknown): LLMProvider => {
  const normalized = normalizeProviderParam(value);
  if (
    normalized === 'claude'
    || normalized === 'codex'
    || normalized === 'cursor'
    || normalized === 'opencode'
  ) {
    return normalized;
  }

  throw new AppError(`Unsupported provider "${normalized}".`, {
    code: 'UNSUPPORTED_PROVIDER',
    statusCode: 400,
  });
};

/** Both fields are optional: an empty body forks the whole conversation. */
const parseSessionForkPayload = (payload: unknown): { upToAnchorId?: string; title?: string } => {
  if (payload === undefined || payload === null) {
    return {};
  }
  if (typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const upToAnchorId = typeof body.upToAnchorId === 'string' ? body.upToAnchorId.trim() : '';
  const title = typeof body.title === 'string' ? body.title.trim() : '';

  return {
    ...(upToAnchorId ? { upToAnchorId } : {}),
    ...(title ? { title } : {}),
  };
};

/**
 * Reads the session order a drop produced.
 *
 * The list is the caller's whole arrangement, so it has to be a non-empty array
 * of distinct, non-empty ids: an empty list would mean "arrange nothing", which
 * is not a state this route can store, and duplicates would leave one of two
 * positions silently winning. An id the project does not own is tolerated by
 * the service (a stale tab may still list a session that has just been
 * deleted); a malformed body is not.
 */
const parseSessionOrderPayload = (payload: unknown): string[] => {
  const sessionIds = payload && typeof payload === 'object'
    ? (payload as Record<string, unknown>).sessionIds
    : undefined;
  if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
    throw new AppError('sessionIds must be a non-empty array.', {
      code: 'INVALID_SESSION_ORDER',
      statusCode: 400,
    });
  }

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const entry of sessionIds) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new AppError('Every session id must be a non-empty string.', {
        code: 'INVALID_SESSION_ORDER',
        statusCode: 400,
      });
    }
    if (seen.has(entry)) {
      throw new AppError(`Session id "${entry}" appears twice in the order.`, {
        code: 'INVALID_SESSION_ORDER',
        statusCode: 400,
      });
    }
    seen.add(entry);
    ordered.push(entry);
  }

  return ordered;
};

const parseSessionRenameSummary = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const summary = typeof body.summary === 'string' ? body.summary.trim() : '';
  if (!summary) {
    throw new AppError('Summary is required.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  if (summary.length > 500) {
    throw new AppError('Summary must not exceed 500 characters.', {
      code: 'INVALID_SESSION_SUMMARY',
      statusCode: 400,
    });
  }

  return summary;
};

const parseSessionSearchQuery = (value: unknown): string => {
  const query = readOptionalQueryString(value) ?? '';
  if (query.length < 2) {
    throw new AppError('Query must be at least 2 characters', {
      code: 'INVALID_SEARCH_QUERY',
      statusCode: 400,
    });
  }

  return query;
};

const parseSessionSearchLimit = (value: unknown): number => {
  const raw = readOptionalQueryString(value);
  if (!raw) {
    return 50;
  }

  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    throw new AppError('limit must be a valid integer.', {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return Math.max(1, Math.min(parsed, 100));
};

const parseBoundedIntegerQuery = <T extends number | null>(
  value: unknown,
  name: string,
  fallback: T,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number | T => {
  const raw = readOptionalQueryString(value);
  if (raw === undefined) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new AppError(`${name} must be an integer between ${minimum} and ${maximum}.`, {
      code: 'INVALID_QUERY_PARAMETER',
      statusCode: 400,
    });
  }

  return parsed;
};

const parseSessionModelPayload = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const model = readOptionalQueryString(body.model);
  if (!model) {
    throw new AppError('model is required.', {
      code: 'MODEL_REQUIRED',
      statusCode: 400,
    });
  }

  return model;
};

const parseSessionEffortPayload = (payload: unknown): string => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const effort = readOptionalQueryString(body.effort);
  if (!effort) {
    throw new AppError('effort is required.', {
      code: 'EFFORT_REQUIRED',
      statusCode: 400,
    });
  }

  if (effort.length > 32) {
    throw new AppError('effort must be 32 characters or fewer.', {
      code: 'INVALID_EFFORT',
      statusCode: 400,
    });
  }

  return effort;
};

/**
 * The lifecycle-mode vocabulary, as a runtime list.
 *
 * `HostMode` is the definition and this is the same two values in a form a
 * request body can be checked against. Duplicating a two-element union of a
 * *shared type* in the route that parses it is the transport's own job — the
 * repository's matching list is private to the database module and would be a
 * cross-module deep import — and keeping it here is what lets the route answer
 * `LIFECYCLE_MODE_UNKNOWN` for a typo instead of letting the write throw an
 * untagged `Error`. The capability question ("does this provider implement the
 * mode?") is a different refusal with a different code, and is answered by the
 * service.
 */
const HOST_MODES: readonly HostMode[] = ['per-run', 'resident'];

const parseLifecycleModePayload = (payload: unknown): HostMode => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const mode = readOptionalQueryString(body.mode);
  if (!mode || !HOST_MODES.includes(mode as HostMode)) {
    throw new AppError(`mode must be one of: ${HOST_MODES.join(', ')}.`, {
      code: 'LIFECYCLE_MODE_UNKNOWN',
      statusCode: 400,
    });
  }

  return mode as HostMode;
};

const parseModelRecordId = (value: unknown): number => {
  const rawRecordId = readPathParam(value, 'recordId').trim();
  if (!/^\d+$/.test(rawRecordId)) {
    throw new AppError('recordId must be a positive integer.', {
      code: 'INVALID_MODEL_RECORD_ID',
      statusCode: 400,
    });
  }

  const recordId = Number.parseInt(rawRecordId, 10);
  if (!Number.isSafeInteger(recordId) || recordId < 1) {
    throw new AppError('recordId must be a positive integer.', {
      code: 'INVALID_MODEL_RECORD_ID',
      statusCode: 400,
    });
  }

  return recordId;
};

/** Structural parse of `config`; allowlist and duplicate rules live in the service. */
const parseModelConfigPayload = (raw: unknown): ProviderModelConfig | null | undefined => {
  if (raw === undefined || raw === null) {
    return raw;
  }
  const env = (raw as { env?: unknown }).env;
  if (typeof raw !== 'object' || !Array.isArray(env)) {
    throw new AppError('config.env must be an array.', { code: 'INVALID_MODEL_CONFIG', statusCode: 400 });
  }
  const rows = env.map((entry): ProviderModelEnvRow => {
    const row = (entry ?? {}) as Record<string, unknown>;
    const kinds = ['value', 'secret', 'envref', 'unset'];
    if (
      typeof row.key !== 'string' || !row.key
      || typeof row.kind !== 'string' || !kinds.includes(row.kind)
      || (row.value !== undefined && typeof row.value !== 'string')
    ) {
      throw new AppError('config.env rows must be {key, kind, value?}.', {
        code: 'INVALID_MODEL_CONFIG',
        statusCode: 400,
      });
    }
    return row.value === undefined
      ? { key: row.key, kind: row.kind as ProviderModelEnvRow['kind'] }
      : { key: row.key, kind: row.kind as ProviderModelEnvRow['kind'], value: row.value };
  });
  return { env: rows };
};

const parseCustomProviderModelPayload = (payload: unknown): CustomProviderModelInput => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const model = readOptionalQueryString(body.model);
  const id = readOptionalQueryString(body.id);
  if (!model) {
    throw new AppError('model is required.', {
      code: 'MODEL_NAME_REQUIRED',
      statusCode: 400,
    });
  }
  if (!id) {
    throw new AppError('id is required.', {
      code: 'MODEL_ID_REQUIRED',
      statusCode: 400,
    });
  }
  if (model.length > 80) {
    throw new AppError('model must be 80 characters or fewer.', {
      code: 'MODEL_NAME_TOO_LONG',
      statusCode: 400,
    });
  }
  if (id.length > 200 || /\s/.test(id)) {
    throw new AppError('id must be 200 characters or fewer and cannot contain whitespace.', {
      code: 'INVALID_MODEL_ID',
      statusCode: 400,
    });
  }

  const config = parseModelConfigPayload(body.config);
  return config === undefined ? { model, id } : { model, id, config };
};

router.get(
  '/:provider/auth/status',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const status = await providerAuthService.getProviderAuthStatus(provider);
    res.json(createApiSuccessResponse(status));
  }),
);

router.get(
  '/:provider/models',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const models = await providerModelsService.getProviderModels(provider);
    res.json(createApiSuccessResponse({ provider, models }));
  }),
);

router.post(
  '/:provider/models',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const input = parseCustomProviderModelPayload(req.body);
    const result = await providerModelsService.createCustomModel(provider, input);
    res.status(201).json(createApiSuccessResponse({ provider, ...result }));
  }),
);

/**
 * Copies a stored custom model into a new one. The body has the same shape as
 * create (`{id, model, config?}`) and the answer is the same envelope, because
 * the copy IS a create — only the stored config it inherits from differs, and
 * that is what the service reads the source row for. Omitting `config` copies
 * the source config whole; supplying it copies only the rows the form sends,
 * with blank secret rows taking the source's values.
 */
router.post(
  '/:provider/models/:recordId/duplicate',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const recordId = parseModelRecordId(req.params.recordId);
    const input = parseCustomProviderModelPayload(req.body);
    const result = await providerModelsService.duplicateCustomModel(provider, recordId, input);
    res.status(201).json(createApiSuccessResponse({ provider, ...result }));
  }),
);

router.patch(
  '/:provider/models/:recordId',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const recordId = parseModelRecordId(req.params.recordId);
    const input = parseCustomProviderModelPayload(req.body);
    const result = await providerModelsService.updateCustomModel(provider, recordId, input);
    res.json(createApiSuccessResponse({ provider, ...result }));
  }),
);

router.delete(
  '/:provider/models/:recordId',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const recordId = parseModelRecordId(req.params.recordId);
    const result = await providerModelsService.deleteCustomModel(provider, recordId);
    res.json(createApiSuccessResponse({ provider, ...result }));
  }),
);

/**
 * Reports which model one session is using, plus the reasoning effort and
 * permission mode recorded for it. `requestedModel` lets the client pass the
 * default it would otherwise send, so a session that has not been sent on yet
 * resolves to that instead of the catalog default. `permissionMode` has no
 * such fallback: it is the recorded mode or null, because the client does not
 * persist one and must not invent one.
 */
router.get(
  '/:provider/sessions/:sessionId/active-model',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const requestedModel = readOptionalQueryString(req.query.requestedModel);
    const result = await providerModelsService.resolveSessionModel(provider, {
      sessionId,
      requestedModel,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/:provider/sessions/:sessionId/active-model',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const model = parseSessionModelPayload(req.body);
    const stored = providerModelsService.setSessionModel(provider, sessionId, model);
    // A session row only exists once the gateway has allocated one. Report the
    // selection back either way so the client can hold it until the first send.
    // A session with no row has no recorded permission mode either, so that
    // answer is null rather than a mode the session never sent with.
    res.json(createApiSuccessResponse(
      stored ?? { provider, sessionId, model, effort: null, permissionMode: null, source: 'session' as const },
    ));
  }),
);

/** Records the reasoning-effort choice for one app session. */
router.post(
  '/:provider/sessions/:sessionId/active-effort',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const effort = parseSessionEffortPayload(req.body);
    const stored = providerModelsService.setSessionEffort(provider, sessionId, effort);
    // Mirror active-model behavior for a composer that picked an effort just
    // before the session gateway created its row.
    res.json(createApiSuccessResponse(
      stored ?? { provider, sessionId, effort, source: 'session' as const },
    ));
  }),
);

/**
 * Records the lifecycle-mode preference for one app session.
 *
 * The fourth member of the `/:provider/sessions/:sessionId/...` family, and the
 * only one that can end a process: a mode change is a statement about who owns
 * the session's host, so the service moves any live host out of the way before
 * it stores the new preference. What the route owns is the transport half —
 * which provider, which session, and whether the mode is a mode at all — and
 * the two refusals it can produce on its own are `LIFECYCLE_MODE_UNKNOWN` here
 * and the service's `LIFECYCLE_MODE_NOT_SUPPORTED` / `LIFECYCLE_MODE_HOST_BUSY`,
 * which travel through the application error middleware with their codes.
 */
router.put(
  '/:provider/sessions/:sessionId/lifecycle-mode',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const sessionId = parseSessionId(req.params.sessionId);
    const mode = parseLifecycleModePayload(req.body);
    const result = sessionsService.switchSessionLifecycleMode(provider, sessionId, mode);
    res.json(createApiSuccessResponse(result));
  }),
);

// ----------------- Skills routes -----------------
router.get(
  '/:provider/skills',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    const skills = await providerSkillsService.listProviderSkills(provider, { workspacePath });
    res.json(createApiSuccessResponse({ provider, skills }));
  }),
);

router.post(
  '/:provider/skills',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const input = parseProviderSkillCreatePayload(req.body);
    const skills = await providerSkillsService.addProviderSkills(provider, input);
    res.json(createApiSuccessResponse({ provider, skills }));
  }),
);

router.delete(
  '/:provider/skills/:directoryName',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const result = await providerSkillsService.removeProviderSkill(provider, {
      directoryName: readPathParam(req.params.directoryName, 'directoryName'),
    });
    res.json(createApiSuccessResponse(result));
  }),
);

// ----------------- MCP routes -----------------
router.get(
  '/:provider/mcp/servers',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    const scope = parseMcpScope(req.query.scope);

    if (scope) {
      const servers = await providerMcpService.listProviderMcpServersForScope(provider, scope, { workspacePath });
      res.json(createApiSuccessResponse({ provider, scope, servers }));
      return;
    }

    const groupedServers = await providerMcpService.listProviderMcpServers(provider, { workspacePath });
    res.json(createApiSuccessResponse({ provider, scopes: groupedServers }));
  }),
);

router.post(
  '/:provider/mcp/servers',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const payload = parseMcpUpsertPayload(req.body);
    const server = await providerMcpService.upsertProviderMcpServer(provider, payload);
    res.status(201).json(createApiSuccessResponse({ server }));
  }),
);

router.delete(
  '/:provider/mcp/servers/:name',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    const scope = parseMcpScope(req.query.scope);
    const workspacePath = readOptionalQueryString(req.query.workspacePath);
    const result = await providerMcpService.removeProviderMcpServer(provider, {
      name: readPathParam(req.params.name, 'name'),
      scope,
      workspacePath,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/mcp/servers/global',
  asyncHandler(async (req: Request, res: Response) => {
    const payload = parseMcpUpsertPayload(req.body);
    if (payload.scope === 'local') {
      throw new AppError('Global MCP add supports only "user" or "project" scopes.', {
        code: 'INVALID_GLOBAL_MCP_SCOPE',
        statusCode: 400,
      });
    }

    const results = await providerMcpService.addMcpServerToAllProviders({
      ...payload,
      scope: payload.scope === 'user' ? 'user' : 'project',
    });
    res.status(201).json(createApiSuccessResponse({ results }));
  }),
);

router.get(
  '/capabilities',
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(createApiSuccessResponse({
      providers: providerCapabilitiesService.listAllProviderCapabilities(),
    }));
  }),
);

router.get(
  '/:provider/capabilities',
  asyncHandler(async (req: Request, res: Response) => {
    const provider = parseProvider(req.params.provider);
    res.json(createApiSuccessResponse(
      providerCapabilitiesService.getProviderCapabilities(provider),
    ));
  }),
);

// ----------------- Session routes -----------------
/**
 * Reads the launch selection a session-gateway call may state.
 *
 * All three fields are optional and a blank one is read as absent (the composer
 * sends `''` for "nothing picked"), so a caller that states nothing keeps the
 * exact request shape it had before these fields existed. `model` is validated
 * against the provider catalog by the route before the row is minted — an unknown
 * id would otherwise be recorded and launch the session as whatever the provider
 * CLI defaults to, which is the incident the gateway call is here to prevent.
 */
const parseSessionLaunchSelection = (payload: unknown): SessionLaunchSelection => {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('Request body must be an object.', {
      code: 'INVALID_REQUEST_BODY',
      statusCode: 400,
    });
  }

  const body = payload as Record<string, unknown>;
  const model = readOptionalQueryString(body.model);
  const effort = readOptionalQueryString(body.effort);
  const permissionMode = readOptionalQueryString(body.permissionMode);

  return {
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(permissionMode ? { permissionMode } : {}),
  };
};

/**
 * Session gateway entry point: allocates the stable app-facing session id for
 * a brand-new chat. The frontend must call this before the first `chat.send`
 * so the session id in the URL, the store, and the websocket all agree from
 * the very first message — there is no client-visible session-id handoff.
 *
 * The optional `model`/`effort`/`permissionMode` state the launch selection the
 * session is created WITH. They belong on THIS call rather than only on the first
 * send because not every session's first turn is a composer send: Live Voice
 * delivers its first utterance through the relay's `session_send`, and an MCP
 * caller through `session_create` — neither carries a model, so a session whose
 * selection was never stated here has none, and runs the provider CLI's default.
 */
router.post(
  '/sessions',
  asyncHandler(async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const provider = parseProvider(body.provider);
    const projectPath = typeof body.projectPath === 'string' ? body.projectPath : '';
    const initialMessage = typeof body.initialMessage === 'string' ? body.initialMessage : '';
    const selection = parseSessionLaunchSelection(body);
    // Validated before the row exists, so a refused model leaves nothing behind.
    if (selection.model) {
      selection.model = await providerModelsService.assertSelectableModel(provider, selection.model);
    }
    const result = sessionsService.createAppSession(provider, projectPath, initialMessage, selection);
    res.status(201).json(createApiSuccessResponse(result));
  }),
);

router.get(
  '/sessions/running',
  asyncHandler(async (_req: Request, res: Response) => {
    const sessions = sessionsService.listRunningSessions();
    res.json(createApiSuccessResponse({ sessions }));
  }),
);

router.get(
  '/sessions/recent',
  asyncHandler(async (req: Request, res: Response) => {
    const limit = parseBoundedIntegerQuery(req.query.limit, 'limit', 40, 1, 100);
    const offset = parseBoundedIntegerQuery(req.query.offset, 'offset', 0, 0);
    const page = sessionsService.listRecentSessions(limit, offset);
    res.json(createApiSuccessResponse(page));
  }),
);

router.get(
  '/sessions/archived',
  asyncHandler(async (_req: Request, res: Response) => {
    const sessions = sessionsService.listArchivedSessions();
    res.json(createApiSuccessResponse({ sessions }));
  }),
);

router.get(
  '/sessions/:sessionId/provider-id',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const providerSessionId = sessionsService.getProviderSessionId(sessionId);
    res.json(createApiSuccessResponse({ sessionId: providerSessionId }));
  }),
);

router.get(
  '/sessions/:sessionId/token-usage',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = await providerTokenUsageService.getSessionTokenUsage(sessionId);
    res.json(createApiSuccessResponse(result));
  }),
);

// Must stay registered after the static and session-specific routes so their
// literals never match the generic `:sessionId` parameter.
router.get(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = sessionsService.getSessionDetailsById(sessionId);
    res.json(createApiSuccessResponse(result));
  }),
);

router.delete(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const force = parseOptionalBooleanQuery(req.query.force, 'force') ?? false;
    const deletedFromDisk = parseOptionalBooleanQuery(req.query.deletedFromDisk, 'deletedFromDisk') ?? force;
    const result = await sessionsService.deleteOrArchiveSessionById(sessionId, {
      force,
      deletedFromDisk,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/sessions/:sessionId/restore',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = sessionsService.restoreSessionById(sessionId);
    res.json(createApiSuccessResponse(result));
  }),
);

router.post(
  '/sessions/:sessionId/fork',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const result = await sessionsService.forkSessionById(sessionId, parseSessionForkPayload(req.body));
    res.status(201).json(createApiSuccessResponse(result));
  }),
);

router.put(
  '/sessions/:sessionId',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const summary = parseSessionRenameSummary(req.body);
    const result = await sessionsService.renameSessionById(sessionId, summary);
    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * Stores a project's manual session order, as produced by a drag.
 *
 * Keyed by project rather than session because a drop can move one row and
 * renumber everything below it; sending the whole list is what keeps the
 * arrangement unambiguous when several rows shift at once.
 */
router.put(
  '/projects/:projectId/session-order',
  asyncHandler(async (req: Request, res: Response) => {
    const projectId = parseSessionId(req.params.projectId);
    const sessionIds = parseSessionOrderPayload(req.body);
    const result = await sessionsService.reorderProjectSessions(projectId, sessionIds);
    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * Default and maximum half-widths of an `around` message window, in messages.
 *
 * The default is the neighborhood the transcript draws around a jump target; the
 * cap keeps one caller from asking the server to serialize an entire
 * thousand-message session in a single response. Both edges are independent, so
 * `before=0` is a legal "this message and what follows it" read.
 */
const WINDOW_DEFAULT_BEFORE = 20;
const WINDOW_DEFAULT_AFTER = 20;
const WINDOW_MAX_SIDE = 200;

router.get(
  '/sessions/:sessionId/messages',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    const aroundId = readOptionalQueryString(req.query.around);

    // The browser asking for this session's transcript IS the user opening the
    // session: neither this route nor the outline route is called speculatively
    // (see the task record's Finding). Recording happens on the request, before
    // the read, so the pointer names the session being opened even when the
    // transcript itself is empty.
    uiLastOpenedSessionService.recordOpenedSession(sessionId);

    // `around` selects the neighborhood read (a window centered on one message
    // id); everything else is the unchanged tail page. When `around` is present
    // `limit`/`offset` are ignored on purpose — the window's shape is
    // `before`/`after`, and honoring both would make the two reads fight over the
    // same slice.
    if (aroundId !== undefined) {
      const before = parseBoundedIntegerQuery(req.query.before, 'before', WINDOW_DEFAULT_BEFORE, 0, WINDOW_MAX_SIDE);
      const after = parseBoundedIntegerQuery(req.query.after, 'after', WINDOW_DEFAULT_AFTER, 0, WINDOW_MAX_SIDE);
      const result = await sessionsService.fetchWindowAround(sessionId, { aroundId, before, after });
      res.json(createApiSuccessResponse(result));
      return;
    }

    const limit = parseBoundedIntegerQuery(req.query.limit, 'limit', null, 0);
    const offset = parseBoundedIntegerQuery(req.query.offset, 'offset', 0, 0);

    const result = await sessionsService.fetchHistory(sessionId, {
      limit,
      offset,
    });
    res.json(createApiSuccessResponse(result));
  }),
);

/**
 * The navigation rail's index of a conversation: every user turn, in absolute
 * order, read from the same full history as the messages route above. It takes
 * no query parameters — the rail needs the whole index, not a page — and it
 * shares the messages route's auth by living in this router under the same
 * `/api/providers` mount as everything else here.
 */
router.get(
  '/sessions/:sessionId/outline',
  asyncHandler(async (req: Request, res: Response) => {
    const sessionId = parseSessionId(req.params.sessionId);
    // The outline route is the second face of the same signal: the chat view
    // fetches the input outline only for the session it has open, so it is
    // recorded as opened here too. The write is idempotent — opening an already
    // open session only moves its `opened_at`.
    uiLastOpenedSessionService.recordOpenedSession(sessionId);
    const result = await sessionsService.fetchOutline(sessionId);
    res.json(createApiSuccessResponse(result));
  }),
);

router.get('/search/sessions', asyncHandler(async (req: Request, res: Response) => {
  const query = parseSessionSearchQuery(req.query.q);
  const limit = parseSessionSearchLimit(req.query.limit);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  let closed = false;
  const abortController = new AbortController();
  req.on('close', () => {
    closed = true;
    abortController.abort();
  });

  try {
    await sessionConversationsSearchService.search({
      query,
      limit,
      signal: abortController.signal,
      onTitleResults: (titleResults) => {
        if (!closed) {
          res.write(`event: title-results\ndata: ${JSON.stringify({ titleResults })}\n\n`);
        }
      },
      onProgress: ({ projectResult, totalMatches, scannedProjects, totalProjects }) => {
        if (closed) {
          return;
        }

        if (projectResult) {
          res.write(`event: result\ndata: ${JSON.stringify({ projectResult, totalMatches, scannedProjects, totalProjects })}\n\n`);
          return;
        }

        res.write(`event: progress\ndata: ${JSON.stringify({ totalMatches, scannedProjects, totalProjects })}\n\n`);
      },
    });

    if (!closed) {
      res.write('event: done\ndata: {}\n\n');
    }
  } catch (error) {
    console.error('Error searching conversations:', error);
    if (!closed) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Search failed' })}\n\n`);
    }
  } finally {
    if (!closed) {
      res.end();
    }
  }
}));

export default router;
