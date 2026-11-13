import { providerModelsDb, sessionsDb } from '@/modules/database/index.js';
import { isAllowedLaunchEnvKey } from '@/modules/providers/services/runtime/launch-spec.service.js';
import { providerCapabilitiesService } from '@/modules/providers/services/provider-capabilities.service.js';
import { readProviderRegistryPort } from '@/shared/ports/provider-registry.port.js';
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
import {
  readCodexProviderRegistryPort,
  type CodexProviderRegistryReading,
} from '@/shared/ports/codex-provider-registry.port.js';
import { AppError } from '@/shared/utils.js';

import {
  createSessionModelResolver,
  type RecordedSessionSelection,
} from './runtime/session-model-resolver.js';
import {
  assertProviderAvailable,
  assertProviderSwitchAllowed,
  readRecordedProviderBinding,
  resolveModelProviderId,
  resolveRequestedProviderId,
} from './runtime/session-provider-binding.js';

/** Session-row access the service needs, narrowed so tests can stub it. */
type ProviderModelsSessionStore = {
  getSessionById(
    sessionId: string,
  ): {
    model: string | null;
    effort: string | null;
    permission_mode: string | null;
    model_provider_id?: string | null;
  } | null;
  setSessionModel(sessionId: string, model: string): void;
  /** Returns false when the row already carries a binding (the column is write-once). */
  setSessionModelProviderId(sessionId: string, modelProviderId: string): boolean;
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

/**
 * The Codex provider registry reading a model write validates against.
 *
 * `null` means no registry is wired (a focused criterion that injected no fake);
 * the service then refuses a declared `codexProviderId` instead of guessing.
 */
type ProviderModelsCodexProviders = {
  read(): CodexProviderRegistryReading | null;
};

type ProviderModelsServiceDependencies = {
  resolveProvider?: (provider: LLMProvider) => Pick<IProvider, 'models'>;
  catalog?: ProviderModelsCatalogStore;
  sessions?: ProviderModelsSessionStore;
  codexProviders?: ProviderModelsCodexProviders;
};

/**
 * Strips secret values at the service exit so no caller (route, command,
 * client) can receive one; secret rows become `{key, kind, isSet}`.
 */
const toPublicConfig = (config: ProviderModelConfig | null): ProviderModelPublicConfig | null => (
  config === null
    ? null
    : {
      ...(config.codexProviderId === undefined ? {} : { codexProviderId: config.codexProviderId }),
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

/**
 * The picker row for one custom model.
 *
 * A model bound to a project Codex provider carries the provider id in its label
 * (`model · provider`) so two entries with the same display name — one bound to
 * each endpoint — stay distinguishable in the merged catalog. The same id is
 * published as `modelProviderId`, the identity field the picker sends back on a
 * model write; a custom entry is never expanded into variants (its binding is
 * already specific). An entry with no binding keeps its bare name: it inherits
 * the Codex global default.
 */
const toCustomProviderModelOption = (
  record: CustomProviderModelRecord,
): ProviderModelOption => {
  const providerId = record.config?.codexProviderId?.trim() || undefined;
  return {
    value: record.modelId,
    label: providerId === undefined ? record.model : `${record.model} · ${providerId}`,
    ...(providerId === undefined ? {} : { modelProviderId: providerId }),
    recordId: record.recordId,
    isCustom: true,
    config: toPublicConfig(record.config),
  };
};

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
  return {
    ...(config.codexProviderId === undefined ? {} : { codexProviderId: config.codexProviderId }),
    env,
  };
};

/**
 * Reads the Codex provider registry once for the write that is about to happen.
 *
 * The thunk is only invoked when a config actually declares `codexProviderId`,
 * so an ordinary Claude/Codex row that inherits the Codex default never touches
 * the settings file.
 */
const readInstalledCodexProviders = (): CodexProviderRegistryReading | null =>
  readCodexProviderRegistryPort()?.read() ?? null;

/**
 * Semantic validation of a model's env rows and its upstream-provider binding.
 *
 * Env rows: allowlisted keys (the same function launch profiles use), one row
 * per key, and `value` present exactly when the kind carries one.
 *
 * `codexProviderId`: a declared id must name a provider the project registry
 * defines (or one Codex reserves for its built-ins). A missing registry, an
 * unknown id, or an id that was deleted since the entry was written is refused
 * with a readable 409 carrying the id; nothing is persisted. An undeclared id
 * is left out entirely, which is the "inherit the Codex global default" path
 * every pre-existing row takes.
 *
 * Rejected config is never persisted: every caller validates before it touches
 * the catalog.
 */
const validateModelConfig = (
  config: ProviderModelConfig,
  readRegistry: () => CodexProviderRegistryReading | null,
): ProviderModelConfig => {
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

  if (config.codexProviderId === undefined) {
    return config;
  }

  const codexProviderId = config.codexProviderId.trim();
  if (!codexProviderId) {
    throw invalidConfig('codexProviderId must name a provider.');
  }
  const registry = readRegistry();
  const known = registry !== null && (
    registry.reservedIds.includes(codexProviderId)
    || registry.providers.some((provider) => provider.id === codexProviderId)
  );
  if (!known) {
    throw new AppError(
      `Codex provider "${codexProviderId}" does not exist; save it in the Codex provider settings or omit codexProviderId to inherit the Codex default.`,
      {
        code: 'CODEX_PROVIDER_UNKNOWN',
        statusCode: 409,
        details: { codexProviderId },
      },
    );
  }
  return { ...config, codexProviderId };
};

const normalizeCustomModelInput = (
  input: CustomProviderModelInput,
  stored: ProviderModelConfig | null = null,
  readRegistry: () => CodexProviderRegistryReading | null = () => null,
): CustomProviderModelInput => ({
  id: input.id.trim(),
  model: input.model.trim(),
  ...(input.config === undefined
    ? {}
    : {
      config: input.config === null
        ? null
        : validateModelConfig(resolveSecretRows(input.config, stored), readRegistry),
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
    ? {
      ...input,
      config: {
        ...(sourceConfig.codexProviderId === undefined
          ? {}
          : { codexProviderId: sourceConfig.codexProviderId }),
        env: sourceConfig.env.map((row) => ({ ...row })),
      },
    }
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
 * The contract, revised when Codex moved to live discovery:
 *
 * 1. Provider adapters may perform provider-native discovery; the Codex
 *    adapter reads the packaged CLI's app-server `model/list` as its primary
 *    source.
 * 2. Memory caching (TTL + single-flight) belongs to the adapter, never to
 *    this service: the service only merges and validates.
 * 3. Persistence stays custom SQLite rows only; discovery results are never
 *    written to disk.
 * 4. The static `CODEX_PREDEFINED_MODELS` catalog is a fallback and an offline
 *    reference, not the only source.
 *
 * Tests inject a small custom-model store through the same boundary.
 */
export const createProviderModelsService = (dependencies: ProviderModelsServiceDependencies = {}) => {
  // Read the registry lazily: the shared port is installed by `provider.registry.ts`
  // at module-evaluation time, which may run after this module when a criterion
  // imports the service directly. Capturing it here would freeze an uninstalled port.
  const resolveProvider = (provider: LLMProvider) =>
    (dependencies.resolveProvider ?? readProviderRegistryPort().resolveProvider)(provider);
  const catalog = dependencies.catalog ?? providerModelsDb;
  const sessions = dependencies.sessions ?? sessionsDb;
  // Read lazily: the registry port is installed by the settings module at boot, which may
  // evaluate after this module, so capturing its reading here would freeze a null.
  const codexProviders = dependencies.codexProviders ?? { read: readInstalledCodexProviders };
  const readCodexRegistry = (): CodexProviderRegistryReading | null => codexProviders.read();

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
    const normalized = normalizeCustomModelInput(input, stored, readCodexRegistry);
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
    const normalized = normalizeCustomModelInput(input, existing.config, readCodexRegistry);
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

  const readRecordedSessionSelection = (sessionId: string): RecordedSessionSelection | null => {
    const session = sessions.getSessionById(sessionId);
    if (!session) {
      return null;
    }

    return {
      model: session.model?.trim() || null,
      effort: session.effort?.trim() || null,
      permissionMode: session.permission_mode?.trim() || null,
      modelProviderId: session.model_provider_id?.trim() || null,
    };
  };

  // The display/resume half of the service: which model a session is on, and
  // which model a resume should launch. Composed here because it reads the same
  // catalog and row access this service owns.
  const { resolveSessionModel, resolveResumeModel } = createSessionModelResolver({
    readRecordedSelection: readRecordedSessionSelection,
    readCodexRegistry,
    getProviderModels,
    getCurrentActiveModel,
  });

  /**
   * Records the model one session runs with.
   *
   * Called from the active-model route when the user picks a model and from
   * `chat.send` on every turn, so the row always matches what the session last
   * ran with. Sessions the app has not created yet (no row) are ignored rather
   * than treated as an error: the client keeps its own pending selection and
   * the value lands on the row with the first send.
   *
   * The session's upstream provider is recorded here too, on the first write
   * that names one (`model_provider_id`). `modelProviderId` is the picker's
   * explicit choice for a built-in model: those rows share the bare `value` and
   * differ only by provider, so the id cannot be derived from the catalog entry
   * and must be handed in. An explicit id wins over a custom entry's declared
   * `codexProviderId` and is validated like any other binding. This is the send
   * funnel, so it is the one place every first turn passes through. A later
   * selection that would run under a DIFFERENT provider is refused — with the
   * fork/new-session action in the message — because the provider runtime
   * cannot switch it in place; the same selection on the same provider is an
   * ordinary model change.
   */
  const setSessionModel = (
    provider: LLMProvider,
    sessionId: string,
    model: string,
    modelProviderId?: string | null,
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

    const registry = readCodexRegistry();
    const requestedProviderId = resolveRequestedProviderId(
      catalog,
      provider,
      normalizedModel,
      modelProviderId,
      resolveProvider(provider).models.bindsUpstreamProvider === true,
    );
    assertProviderSwitchAllowed(recordedSelection.modelProviderId, requestedProviderId, normalizedModel);
    assertProviderAvailable(registry, requestedProviderId, normalizedModel);

    sessions.setSessionModel(normalizedSessionId, normalizedModel);
    if (requestedProviderId && !recordedSelection.modelProviderId) {
      sessions.setSessionModelProviderId(normalizedSessionId, requestedProviderId);
    }
    return {
      provider,
      sessionId: normalizedSessionId,
      model: normalizedModel,
      effort: recordedSelection.effort,
      permissionMode: recordedSelection.permissionMode,
      ...readRecordedProviderBinding(registry, recordedSelection.modelProviderId ?? requestedProviderId),
      source: 'session',
    };
  };

  /**
   * Answers whether a send may name this model for this session, throwing the
   * same readable refusal the record path throws.
   *
   * `chat-websocket.service.ts` calls this BEFORE the session's run is admitted.
   * The record path (`setSessionModel`) would refuse the equal case, but it runs
   * after the run is reserved — and a throw there would leave a `running` run
   * with no process behind it. A missing row, or a session with no recorded
   * binding, is not a refusal: the first send of a session is exactly where a
   * binding is allowed to be established.
   */
  const assertSessionProviderSwitch = (
    provider: LLMProvider,
    sessionId: string,
    model: string,
    modelProviderId?: string | null,
  ): void => {
    const normalizedSessionId = sessionId.trim();
    const normalizedModel = model.trim();
    if (!normalizedSessionId || !normalizedModel) {
      return;
    }
    const recordedSelection = readRecordedSessionSelection(normalizedSessionId);
    if (!recordedSelection) {
      return;
    }
    // Same resolution as the record path: the send that follows this guard
    // must be judged against the provider it will actually be recorded under.
    const requestedProviderId = resolveRequestedProviderId(
      catalog,
      provider,
      normalizedModel,
      modelProviderId,
      resolveProvider(provider).models.bindsUpstreamProvider === true,
    );
    assertProviderSwitchAllowed(recordedSelection.modelProviderId, requestedProviderId, normalizedModel);
    assertProviderAvailable(readCodexRegistry(), requestedProviderId, normalizedModel);
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
   * SERVER-INTERNAL ONLY: returns the stored config including secret values
   * for the launch compiler. Never mount this on a route or return its result
   * to a client; every client-facing read goes through `getProviderModels`.
   */
  const getCustomModelConfigForRuntime = (
    provider: LLMProvider,
    modelId: string,
  ): ProviderModelConfig | null => catalog.findCustomProviderModelByModelId(provider, modelId)?.config ?? null;

  /**
   * Resolves one model's upstream provider id synchronously from the custom-model
   * catalog. Consumed by the runtime dispatch so a resident cold start carries
   * the binding in its launch options (a send's options name only the model).
   */
  const resolveModelProviderIdForModel = (
    provider: LLMProvider,
    modelId: string,
  ): string | null => resolveModelProviderId(catalog, provider, modelId.trim());

  return {
    getProviderModels,
    getCustomModelConfigForRuntime,
    resolveModelProviderId: resolveModelProviderIdForModel,
    createCustomModel,
    duplicateCustomModel,
    updateCustomModel,
    deleteCustomModel,
    setSessionModel,
    assertSessionProviderSwitch,
    setSessionEffort,
    setSessionPermissionMode,
    resolveSessionModel,
    resolveResumeModel,
    assertSelectableModel,
  };
};

/** Shared Providers service used by routes, Commands, and provider runtimes. */
export const providerModelsService = createProviderModelsService();
