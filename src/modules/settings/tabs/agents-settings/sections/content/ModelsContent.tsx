import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import ModelLibraryPanel from '@/shared/ui/ModelLibraryPanel';
import { api } from '@/shared/api';
import type {
  AgentProvider,
  CustomProviderModelInput,
  LLMProvider,
  ModelEnvStatus,
  ProviderModelActions,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types';

type ModelsContentProps = {
  agent: AgentProvider;
};

type CatalogByProvider = Partial<Record<LLMProvider, ProviderModelsDefinition>>;

const PROVIDER_IDS: LLMProvider[] = ['claude', 'codex', 'cursor', 'opencode'];

/** Reads a provider-models API envelope, throwing the server's message on failure. */
const readCatalogResponse = async (response: Response): Promise<ProviderModelsDefinition> => {
  const body = await response.json() as {
    success?: boolean;
    data?: { models?: ProviderModelsDefinition };
    error?: { message?: string };
  };
  if (!response.ok || !body.success || !body.data?.models) {
    throw new Error(body.error?.message || 'Unable to save this model.');
  }
  return body.data.models;
};

/** Rendered by AgentCategoryContentSection for the "models" category: the Model library as a first-class Settings > Agents section for the selected provider. */
export default function ModelsContent({ agent }: ModelsContentProps) {
  const { t } = useTranslation('settings');
  const [catalog, setCatalog] = useState<CatalogByProvider>({});
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all(PROVIDER_IDS.map(async (provider) => {
      const response = await api.providers.models(provider);
      const body = await response.json() as { data?: { models?: ProviderModelsDefinition } };
      return [provider, body.data?.models] as const;
    }))
      .then((entries) => {
        if (cancelled) return;
        setCatalog(Object.fromEntries(entries.filter(([, models]) => models)) as CatalogByProvider);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, []);

  const apply = useCallback((provider: LLMProvider, models: ProviderModelsDefinition) => {
    setCatalog((previous) => ({ ...previous, [provider]: models }));
  }, []);

  const actions = useMemo<ProviderModelActions>(() => ({
    create: async (provider: LLMProvider, input: CustomProviderModelInput) => {
      apply(provider, await readCatalogResponse(await api.providers.createModel(provider, input)));
    },
    duplicate: async (provider: LLMProvider, existing: ProviderModelOption, input: CustomProviderModelInput) => {
      if (!existing.recordId) throw new Error('This model cannot be duplicated.');
      apply(provider, await readCatalogResponse(await api.providers.duplicateModel(provider, existing.recordId, input)));
    },
    update: async (provider: LLMProvider, existing: ProviderModelOption, input: CustomProviderModelInput) => {
      if (!existing.recordId) throw new Error('This model cannot be edited.');
      apply(provider, await readCatalogResponse(await api.providers.updateModel(provider, existing.recordId, input)));
    },
    remove: async (provider: LLMProvider, existing: ProviderModelOption) => {
      if (!existing.recordId) throw new Error('This model cannot be deleted.');
      apply(provider, await readCatalogResponse(await api.providers.deleteModel(provider, existing.recordId)));
    },
  }), [apply]);

  const loadEnvStatus = useCallback(async (names: string[]): Promise<ModelEnvStatus> => {
    const response = await api.providers.modelEnvStatus(names);
    const body = await response.json() as { data?: { status?: ModelEnvStatus } };
    return body.data?.status ?? {};
  }, []);

  return (
    <div className="space-y-3">
      {loadError && (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {t('modelLibrary.loadFailed', { message: loadError })}
        </div>
      )}
      <ModelLibraryPanel
        initialProvider={agent}
        providerModelCatalog={catalog}
        actions={actions}
        loadEnvStatus={loadEnvStatus}
        hideProviderTabs
      />
    </div>
  );
}
