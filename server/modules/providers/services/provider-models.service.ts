import { providerModelsDb, sessionsDb } from '@/modules/database/index.js';
import { isAllowedLaunchEnvKey } from '@/modules/providers/services/launch-spec.service.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { providerRegistry } from '@/modules/providers/provider.registry.js';
import type { IProvider } from '@/shared/interfaces.js';
import type {
  CustomProviderModelInput,
  CustomProviderModelRecord,
  LLMProvider,
  ProviderCurrentActiveModel,
  ProviderModelConfig,
  ProviderModelPublicConfig,
  ProviderModelOption,
  ProviderModelsDefinition,
  ProviderSessionModel,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** Session-row access the service needs, narrowed so tests can stub it. */
type ProviderModelsSessionStore = {
  getSessionById(
    sessionId: string,
  ): { model: string | null; effort: string | null; permission_mode: string | null } | null;
  setSessionModel(sessionId: string, model: string): void;
  setSessionEffort(sessionId: string, effort: string): void;
  /** Returns false when no session row matched. */
  setSessionPermissionMode(sessionId: string, permissionMode: string): boolean;
};

/** SQLite catalog operations used by the Providers service and its unit fakes. */
type ProviderModelsCatalogStore = Pick<
  typeof providerModelsDb,
  | 'listCustomProviderModels'
  | 'getCustomProviderModel'
  | 'findCustomProviderModelByModelId'
  | 'createCustomProviderModel'
  | 'updateCustomProviderModel'
  | 'deleteCustomProviderModel'
>;

type ProviderModelsServiceDependencies = {
  resolveProvider?: (provider: LLMProvider) => Pick<IProvider, 'models'>;
  catalog?: ProviderModelsCatalogStore;
  sessions?: ProviderModelsSessionStore;
};

/**
 * Strips secret values at the service exit so no caller (route, command,
 * client) can receive one; secret rows become `{key, kind, isSet}`.
 */
const toPublicConfig = (config: ProviderModelConfig | null): ProviderModelPublicConfig | null => (
  config === null
    ? null
    : {
      env: config.env.map((row) => {
        if (row.kind === 'secret') {
          return { key: row.key, kind: 'secret' as const, isSet: true as const };
        }
        if (row.kind === 'unset') {
          return { key: row.key, kind: 'unset' as const };
        }
        return { key: row.key, kind: row.kind, ...(row.value === undefined ? {} : { value: row.value }) };
      }),
    }
);

const toCustomProviderModelOption = (
  record: CustomProviderModelRecord,
): ProviderModelOption => ({
  value: record.modelId,
  label: record.model,
  recordId: record.recordId,
  isCustom: true,
  config: toPublicConfig(record.config),
});

const mergeProviderModels = (
  predefined: ProviderModelsDefinition,
  custom: CustomProviderModelRecord[],
): ProviderModelsDefinition => {
  return {
    OPTIONS: [
      ...predefined.OPTIONS.map((option) => ({ ...option, isCustom: false })),
      ...custom.map(toCustomProviderModelOption),
    ],
    DEFAULT: predefined.DEFAULT,
  };
};

const invalidConfig = (message: string): AppError => new AppError(message, {
  code: 'INVALID_MODEL_CONFIG',
  statusCode: 400,
});

/**
 * Applies write-only secret semantics against the stored config: a secret row
 * without `value` keeps the stored value, an empty string clears the row, and
 * a non-empty value replaces it. Error messages carry keys only, never values.
 */
const resolveSecretRows = (
  config: ProviderModelConfig,
  stored: ProviderModelConfig | null,
): ProviderModelConfig => {
  const env: ProviderModelConfig['env'] = [];
  for (const row of config.env) {
    if (row.kind !== 'secret') {
      env.push(row);
      continue;
    }
    if (row.value === '') {
      continue;
    }
    if (row.value !== undefined) {
      env.push(row);
      continue;
    }
    const kept = stored?.env.find((entry) => entry.key === row.key && entry.kind === 'secret');
    if (!kept?.value) {
      throw invalidConfig(`Environment variable ${row.key} has no stored secret to keep.`);
    }
    env.push({ key: row.key, kind: 'secret', value: kept.value });
  }
  return { env };
};

/**
 * Semantic validation of a model's env rows: allowlisted keys (the same
 * function launch profiles use), one row per key, and `value` present exactly
 * when the kind carries one. Rejected config is never persisted.
 */
const validateModelConfig = (config: ProviderModelConfig): ProviderModelConfig => {
  const seen = new Set<string>();
  for (const row of config.env) {
    if (!isAllowedLaunchEnvKey(row.key)) {
      throw invalidConfig(`Environment variable ${row.key} is not allowed.`);
    }
    if (seen.has(row.key)) {
      throw invalidConfig(`Environment variable ${row.key} appears more than once.`);
    }
    seen.add(row.key);
    if (row.kind === 'unset' ? row.value !== undefined : !row.value) {
      throw invalidConfig(`Environment variable ${row.key} has an invalid value for kind ${row.kind}.`);
    }
  }
  return config;
};

const normalizeCustomModelInput = (
  input: CustomProviderModelInput,
  stored: ProviderModelConfig | null = null,
): CustomProviderModelInput => ({
  id: input.id.trim(),
  model: input.model.trim(),
  ...(input.config === undefined
    ? {}
    : {
      config: input.config === null
        ? null
        : validateModelConfig(resolveSecretRows(input.config, stored)),
    }),
});

/**
 * Builds the input a duplicate request persists from the caller's form rows and
 * the source record's config.
 *
 * An omitted `config` means "copy the whole config": the source rows are handed
 * to `resolveSecretRows` with their secret values still in place, so they take
 * its non-empty branch and are stored verbatim. Copying the row objects rather
 * than aliasing them keeps the two records independent.
 *
 * A supplied `config` is the form's rows, unchanged: only its blank secret rows
 * fall back to the source (through the `stored` argument of the create path),
 * a row typed with a new value keeps that value, and a row the form omits is
 * not copied at all.
 */
const withSourceConfig = (
  input: CustomProviderModelInput,
  sourceConfig: ProviderModelConfig | null,
): CustomProviderModelInput => (
  input.config === undefined && sourceConfig !== null
    ? { ...input, config: { env: sourceConfig.env.map((row) => ({ ...row })) } }
    : input
);

const isUniqueConstraintError = (error: unknown): boolean => (
  error !== null
  && error !== undefined
  && typeof error === 'object'
  && 'code' in error
  && String(error.code).startsWith('SQLITE_CONSTRAINT')
);

/**
 * Creates the provider model application service used by Providers routes,
 * Commands, and provider runtimes.
 *
 * Curated adapter definitions stay source-controlled and are merged at read
 * time with custom SQLite rows. This deliberately has no predefined-model
 * persistence, memory cache, disk cache, TTL, or provider-native discovery.
 * Tests inject a small custom-model store through the same boundary.
 */
export const createProviderModelsService = (dependencies: ProviderModelsServiceDependencies = {}) => {
  const resolveProvider = dependencies.resolveProvider ?? providerRegistry.resolveProvider;
  const catalog = dependencies.catalog ?? providerModelsDb;
  const sessions = dependencies.sessions ?? sessionsDb;

  const getProviderModels = async (provider: LLMProvider): Promise<ProviderModelsDefinition> => {
    const predefined = await resolveProvider(provider).models.getSupportedModels();
    return mergeProviderModels(predefined, catalog.listCustomProviderModels(provider));
  };

  const getCurrentActiveModel = async (
    provider: LLMProvider,
    sessionId?: string,
  ): Promise<ProviderCurrentActiveModel> => resolveProvider(provider).models.getCurrentActiveModel(sessionId);

  /**
   * Refuses a model the app cannot select, and answers the normalized id.
   *
   * The catalog this reads is the same one the picker lists and the launch-spec
   * compiler resolves against: the provider's predefined options merged with the
   * custom rows. A value in neither is a typo (or a model name invented for a
   * different CLI), and letting it through is the incident this guard exists for:
   * `resolveModelLaunchSpec` answers an unknown id with an EMPTY spec rather than
   * an error, so the child would silently keep the host env and launch with the
   * CLI's own default — a different endpoint AND a different account, with the
   * page still showing what the person picked.
   *
   * Consumed by the two gateway callers that state a session's launch selection
   * before its row exists: the providers session-gateway route and the MCP
   * `session_create` adapter. The row writers themselves record what they are
   * handed (see `sessionsService.createAppSession`), the same contract
   * `setSessionModel` has for a model chosen after the fact.
   */
  const assertSelectableModel = async (provider: LLMProvider, model: string): Promise<string> => {
    const normalizedModel = model.trim();
    if (!normalizedModel) {
      throw new AppError('model is required.', {
        code: 'MODEL_REQUIRED',
        statusCode: 400,
      });
    }

    const catalog = await getProviderModels(provider);
    const known = catalog.OPTIONS.some((option) => option.value === normalizedModel);
    if (!known) {
      const supported = catalog.OPTIONS.map((option) => option.value);
      throw new AppError(
        `Unknown ${provider} model "${normalizedModel}". Supported models: ${supported.join(', ')}.`,
        {
          code: 'MODEL_UNKNOWN',
          statusCode: 400,
          details: { supported },
        },
      );
    }

    return normalizedModel;
  };

  const readCustomModel = (
    provider: LLMProvider,
    recordId: number,
  ): CustomProviderModelRecord => {
    const existing = catalog.getCustomProviderModel(provider, recordId);
    if (!existing) {
      throw new AppError('Model not found.', {
        code: 'MODEL_NOT_FOUND',
        statusCode: 404,
      });
    }

    return existing;
  };

  const assertModelIdAvailable = (
    provider: LLMProvider,
    predefined: ProviderModelsDefinition,
    modelId: string,
    currentRecordId?: number,
  ): void => {
    if (predefined.OPTIONS.some((option) => option.value === modelId)) {
      throw new AppError(`A ${provider} model with this ID already exists.`, {
        code: 'MODEL_ID_ALREADY_EXISTS',
        statusCode: 409,
      });
    }

    const duplicate = catalog.findCustomProviderModelByModelId(provider, modelId);
    if (duplicate && duplicate.recordId !== currentRecordId) {
      throw new AppError(`A ${provider} model with this ID already exists.`, {
        code: 'MODEL_ID_ALREADY_EXISTS',
        statusCode: 409,
      });
    }
  };

  /**
   * Creates a custom model row.
   *
   * `stored` is the config a blank secret row in `input` keeps its value from.
   * It is null for a plain create (there is nothing stored yet, so such a row is
   * an error) and the source record's config for a duplicate; it is deliberately
   * not on the route contract.
   */
  const createCustomModel = async (
    provider: LLMProvider,
    input: CustomProviderModelInput,
    stored: ProviderModelConfig | null = null,
  ): Promise<{ model: ProviderModelOption; models: ProviderModelsDefinition }> => {
    const predefined = await resolveProvider(provider).models.getSupportedModels();
    const normalized = normalizeCustomModelInput(input, stored);
    assertModelIdAvailable(provider, predefined, normalized.id);

    try {
      const created = catalog.createCustomProviderModel(provider, normalized);
      return {
        model: toCustomProviderModelOption(created),
        models: mergeProviderModels(predefined, catalog.listCustomProviderModels(provider)),
      };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError(`A ${provider} model with this ID already exists.`, {
          code: 'MODEL_ID_ALREADY_EXISTS',
          statusCode: 409,
        });
      }
      throw error;
    }
  };

  /**
   * Copies a custom model into a new one, then returns the create envelope.
   *
   * Reading the source row is the entire mechanism, not bookkeeping: ADR-002
   * decision 2 keeps secret values out of every client-facing read, so the
   * client can only ever send back "keep the stored secret" — which has nothing
   * to keep on a row that does not exist yet. Handing the service the SOURCE
   * config as `stored` is what makes the copy carry the secret; passing the
   * target's (nonexistent) config, the way `updateCustomModel` does, would
   * answer 400 `has no stored secret to keep` and copy nothing at all.
   *
   * A built-in id has no row in `provider_models`, so it 404s like any unknown
   * id rather than being duplicated.
   */
  const duplicateCustomModel = async (
    provider: LLMProvider,
    recordId: number,
    input: CustomProviderModelInput,
  ): Promise<{ model: ProviderModelOption; models: ProviderModelsDefinition }> => {
    const source = readCustomModel(provider, recordId);
    return createCustomModel(provider, withSourceConfig(input, source.config), source.config);
  };

  const updateCustomModel = async (
    provider: LLMProvider,
    recordId: number,
    input: CustomProviderModelInput,
  ): Promise<{ model: ProviderModelOption; models: ProviderModelsDefinition }> => {
    const predefined = await resolveProvider(provider).models.getSupportedModels();
    const existing = readCustomModel(provider, recordId);
    const normalized = normalizeCustomModelInput(input, existing.config);
    assertModelIdAvailable(provider, predefined, normalized.id, recordId);

    try {
      const updated = catalog.updateCustomProviderModel(provider, recordId, normalized);
      if (!updated) {
        throw new AppError('Model not found.', {
          code: 'MODEL_NOT_FOUND',
          statusCode: 404,
        });
      }

      return {
        model: toCustomProviderModelOption(updated),
        models: mergeProviderModels(predefined, catalog.listCustomProviderModels(provider)),
      };
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new AppError(`A ${provider} model with this ID already exists.`, {
          code: 'MODEL_ID_ALREADY_EXISTS',
          statusCode: 409,
        });
      }
      throw error;
    }
  };

  const deleteCustomModel = async (
    provider: LLMProvider,
    recordId: number,
  ): Promise<{ model: ProviderModelOption; models: ProviderModelsDefinition }> => {
    const predefined = await resolveProvider(provider).models.getSupportedModels();
    readCustomModel(provider, recordId);
    const removed = catalog.deleteCustomProviderModel(provider, recordId, predefined.DEFAULT);
    if (!removed) {
      throw new AppError('Model not found.', {
        code: 'MODEL_NOT_FOUND',
        statusCode: 404,
      });
    }

    return {
      model: toCustomProviderModelOption(removed),
      models: mergeProviderModels(predefined, catalog.listCustomProviderModels(provider)),
    };
  };

  const readRecordedSessionSelection = (
    sessionId: string,
  ): { model: string | null; effort: string | null; permissionMode: string | null } | null => {
    const session = sessions.getSessionById(sessionId);
    if (!session) {
      return null;
    }

    return {
      model: session.model?.trim() || null,
      effort: session.effort?.trim() || null,
      permissionMode: session.permission_mode?.trim() || null,
    };
  };

  /**
   * Records the model one session runs with.
   *
   * Called from the active-model route when the user picks a model and from
   * `chat.send` on every turn, so the row always matches what the session last
   * ran with. Sessions the app has not created yet (no row) are ignored rather
   * than treated as an error: the client keeps its own pending selection and
   * the value lands on the row with the first send.
   */
  const setSessionModel = (
    provider: LLMProvider,
    sessionId: string,
    model: string,
  ): ProviderSessionModel | null => {
    const normalizedSessionId = sessionId.trim();
    const normalizedModel = model.trim();
    if (!normalizedSessionId || !normalizedModel) {
      return null;
    }

    const recordedSelection = readRecordedSessionSelection(normalizedSessionId);
    if (!recordedSelection) {
      return null;
    }

    sessions.setSessionModel(normalizedSessionId, normalizedModel);
    return {
      provider,
      sessionId: normalizedSessionId,
      model: normalizedModel,
      effort: recordedSelection.effort,
      permissionMode: recordedSelection.permissionMode,
      source: 'session',
    };
  };

  /**
   * Records the reasoning effort one session runs with.
   *
   * Like `setSessionModel`, this ignores an id that has not been allocated by
   * the session gateway yet. The websocket send path records it once the row
   * exists, so a pre-session composer choice is not lost.
   */
  const setSessionEffort = (
    provider: LLMProvider,
    sessionId: string,
    effort: string,
  ): { provider: LLMProvider; sessionId: string; effort: string; source: 'session' } | null => {
    const normalizedSessionId = sessionId.trim();
    const normalizedEffort = effort.trim();
    if (!normalizedSessionId || !normalizedEffort) {
      return null;
    }

    if (!readRecordedSessionSelection(normalizedSessionId)) {
      return null;
    }

    sessions.setSessionEffort(normalizedSessionId, normalizedEffort);
    return {
      provider,
      sessionId: normalizedSessionId,
      effort: normalizedEffort,
      source: 'session',
    };
  };

  /**
   * Records the permission mode a sent message carried for its session.
   *
   * Called from `chat.send`/`chat.edit-send` only. A mode the provider's
   * capability matrix does not list is ignored (no write, no error): the
   * runtime would reject it, so persisting it would make reopening the session
   * show a mode it never actually ran with.
   *
   * A mode that arrives with no session row to record it on returns null and
   * changes nothing. That is not the silent loss it would be for a mode chosen
   * in a composer: the row is written by the session gateway before it hands
   * the client the id, so the first message of a brand-new chat already has a
   * row to write to (see `sessionsService.createAppSession`, which mints the id
   * and INSERTs in the same call).
   */
  const setSessionPermissionMode = (
    provider: LLMProvider,
    sessionId: string,
    permissionMode: string,
  ): { provider: LLMProvider; sessionId: string; permissionMode: string; source: 'session' } | null => {
    const normalizedSessionId = sessionId.trim();
    const normalizedMode = permissionMode.trim();
    if (!normalizedSessionId || !normalizedMode) {
      return null;
    }

    const supportedModes = providerCapabilitiesService.getProviderCapabilities(provider)?.permissionModes ?? [];
    if (!supportedModes.includes(normalizedMode)) {
      return null;
    }

    if (!sessions.setSessionPermissionMode(normalizedSessionId, normalizedMode)) {
      return null;
    }

    return {
      provider,
      sessionId: normalizedSessionId,
      permissionMode: normalizedMode,
      source: 'session',
    };
  };

  /**
   * Answers "which model is this session using?" for every display surface.
   *
   * Precedence, highest first:
   *   1. the model recorded on the session row;
   *   2. the provider's own session state for externally-created sessions;
   *   3. `requestedModel`, the client's current default;
   *   4. the source-controlled provider catalog default.
   *
   * The permission mode rides along unchanged: it has no provider-side source
   * and no client-supplied fallback (the client is not allowed to persist one),
   * so the only two answers are the recorded mode or NULL for "never sent one".
   */
  const resolveSessionModel = async (
    provider: LLMProvider,
    options: { sessionId?: string | null; requestedModel?: string | null } = {},
  ): Promise<ProviderSessionModel> => {
    const normalizedSessionId = typeof options.sessionId === 'string' ? options.sessionId.trim() : '';
    const normalizedRequestedModel = typeof options.requestedModel === 'string'
      ? options.requestedModel.trim()
      : '';

    if (normalizedSessionId) {
      const recordedSelection = readRecordedSessionSelection(normalizedSessionId);
      if (recordedSelection?.model) {
        return {
          provider,
          sessionId: normalizedSessionId,
          model: recordedSelection.model,
          effort: recordedSelection.effort,
          permissionMode: recordedSelection.permissionMode,
          source: 'session',
        };
      }

      const providerCatalog = await getProviderModels(provider);
      const providerModel = await getCurrentActiveModel(provider, normalizedSessionId);
      const resolvedProviderModel = providerModel.model?.trim();
      if (resolvedProviderModel && resolvedProviderModel !== providerCatalog.DEFAULT) {
        return {
          provider,
          sessionId: normalizedSessionId,
          model: resolvedProviderModel,
          effort: recordedSelection?.effort ?? null,
          permissionMode: recordedSelection?.permissionMode ?? null,
          source: 'provider',
        };
      }

      return {
        provider,
        sessionId: normalizedSessionId,
        model: normalizedRequestedModel || providerCatalog.DEFAULT,
        effort: recordedSelection?.effort ?? null,
        permissionMode: recordedSelection?.permissionMode ?? null,
        source: normalizedRequestedModel ? 'session' : 'default',
      };
    }

    if (normalizedRequestedModel) {
      return {
        provider,
        sessionId: null,
        model: normalizedRequestedModel,
        effort: null,
        permissionMode: null,
        source: 'session',
      };
    }

    const providerCatalog = await getProviderModels(provider);
    return {
      provider,
      sessionId: null,
      model: providerCatalog.DEFAULT,
      effort: null,
      permissionMode: null,
      source: 'default',
    };
  };

  /**
   * Picks the model one resumed provider run should use.
   *
   * Provider-global state is deliberately ignored because it must never
   * override the model explicitly selected in the composer.
   */
  const resolveResumeModel = async (
    provider: LLMProvider,
    sessionId: string | undefined,
    requestedModel?: string | null,
  ): Promise<string | undefined> => {
    void provider;
    const normalizedRequestedModel = typeof requestedModel === 'string' ? requestedModel.trim() : '';
    const normalizedSessionId = sessionId?.trim();
    if (!normalizedSessionId) {
      return normalizedRequestedModel || undefined;
    }

    const recordedModel = readRecordedSessionSelection(normalizedSessionId)?.model;
    return recordedModel || normalizedRequestedModel || undefined;
  };

  /**
   * SERVER-INTERNAL ONLY: returns the stored config including secret values
   * for the launch compiler. Never mount this on a route or return its result
   * to a client; every client-facing read goes through `getProviderModels`.
   */
  const getCustomModelConfigForRuntime = (
    provider: LLMProvider,
    modelId: string,
  ): ProviderModelConfig | null => catalog.findCustomProviderModelByModelId(provider, modelId)?.config ?? null;

  return {
    getProviderModels,
    getCustomModelConfigForRuntime,
    createCustomModel,
    duplicateCustomModel,
    updateCustomModel,
    deleteCustomModel,
    setSessionModel,
    setSessionEffort,
    setSessionPermissionMode,
    resolveSessionModel,
    resolveResumeModel,
    assertSelectableModel,
  };
};

/** Shared Providers service used by routes, Commands, and provider runtimes. */
export const providerModelsService = createProviderModelsService();
