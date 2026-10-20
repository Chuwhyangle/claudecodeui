import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowLeft,
  Check,
  Copy,
  Loader2,
  LockKeyhole,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';

import { Badge, Button, Input, LLMProviderLogo } from '@/shared/ui';
import ModelEnvEditor, {
  getUnsavedEnvRows,
  toEditorRows,
  toRequestRows,
  type ModelEnvEditorRow,
} from '@/shared/ui/ModelEnvEditor';
import type {
  LLMProvider,
  ModelEnvStatus,
  ProviderModelActions,
  ProviderModelOption,
  ProviderModelsDefinition,
} from '@/shared/types';

const PROVIDERS: Array<{ id: LLMProvider; label: string }> = [
  { id: 'claude', label: 'Claude' },
  { id: 'codex', label: 'Codex' },
  { id: 'cursor', label: 'Cursor' },
  { id: 'opencode', label: 'OpenCode' },
];

/** Both limits the server enforces on a custom model (`provider.routes.ts`); the inputs and the copy suggestion must not exceed them. */
const MODEL_NAME_MAX_LENGTH = 80;
const MODEL_ID_MAX_LENGTH = 200;

/**
 * Suggests the model id a copy of `base` should take: `-copy`, then `-copy-2`,
 * `-copy-3`… for the first candidate nothing already uses.
 *
 * `taken` has to hold built-in and custom ids alike, because the server answers
 * 409 for a built-in collision too. The base is truncated so the suffixed result
 * stays within the id limit even when `base` is already at it.
 */
const suggestCopyId = (base: string, taken: ReadonlySet<string>): string => {
  for (let attempt = 1; ; attempt += 1) {
    const suffix = attempt === 1 ? '-copy' : `-copy-${attempt}`;
    const candidate = `${base.slice(0, Math.max(MODEL_ID_MAX_LENGTH - suffix.length, 0))}${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
};

type ModelLibraryPanelProps = {
  initialProvider: LLMProvider;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  actions: ProviderModelActions;
  onDone?: () => void;
  /** Resolves which server env variables are set; when absent, envref rows show no live status. */
  loadEnvStatus?: (names: string[]) => Promise<ModelEnvStatus>;
  /** Hides the provider switcher when the host already fixes the provider (Settings > Agents). */
  hideProviderTabs?: boolean;
};

/**
 * Rendered by chat's ProviderSelectionEmptyState and CommandResultModal, and by
 * settings' Agents > Models category, so the user can browse each provider's
 * model catalog and add, edit (including env config) or remove custom models.
 *
 * It is dialog body rather than a dialog — it opens no overlay of its own, and
 * each consumer supplies the Dialog around it. That is why it sits in modals/
 * with no Dialog in the file.
 */
export default function ModelLibraryPanel({
  initialProvider,
  providerModelCatalog,
  actions,
  onDone,
  loadEnvStatus,
  hideProviderTabs = false,
}: ModelLibraryPanelProps) {
  const { t } = useTranslation();
  const { t: tSettings } = useTranslation('settings');
  const [selectedProvider, setSelectedProvider] = useState(initialProvider);
  const [editing, setEditing] = useState<ProviderModelOption | null>(null);
  // The custom model the form is copying, or null. `editing` stays null while it
  // is set, so the form keeps create semantics; only the labels, the prefill and
  // which action `handleSubmit` calls change.
  const [duplicatingFrom, setDuplicatingFrom] = useState<ProviderModelOption | null>(null);
  const [model, setModel] = useState('');
  const [modelId, setModelId] = useState('');
  const [saving, setSaving] = useState(false);
  const [deletingRecordId, setDeletingRecordId] = useState<number | null>(null);
  const [confirmDeleteRecordId, setConfirmDeleteRecordId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Env rows of the model being added/edited; `envDirty` is set only by a user edit,
  // so an untouched form never sends `config` and cannot overwrite stored values.
  const [envRows, setEnvRows] = useState<ModelEnvEditorRow[]>([]);
  const [envDirty, setEnvDirty] = useState(false);
  const [envStatus, setEnvStatus] = useState<ModelEnvStatus>({});

  const envrefNames = envRows
    .filter((row) => row.kind === 'envref' && row.value.trim())
    .map((row) => row.value.trim())
    .join(',');
  useEffect(() => {
    if (!loadEnvStatus || !envrefNames) {
      return undefined;
    }
    let cancelled = false;
    loadEnvStatus(envrefNames.split(','))
      .then((status) => { if (!cancelled) setEnvStatus(status); })
      .catch(() => { if (!cancelled) setEnvStatus({}); });
    return () => { cancelled = true; };
  }, [envrefNames, loadEnvStatus]);

  useEffect(() => {
    setSelectedProvider(initialProvider);
  }, [initialProvider]);

  const options = useMemo(
    () => providerModelCatalog[selectedProvider]?.OPTIONS ?? [],
    [providerModelCatalog, selectedProvider],
  );
  const customModels = useMemo(
    () => options.filter((option) => option.isCustom),
    [options],
  );
  const predefinedModels = useMemo(
    () => options.filter((option) => !option.isCustom),
    [options],
  );
  // Every id the provider already answers 409 for, built-in ones included; used
  // to pre-check a submit and to pick a free id for a copy.
  const takenModelIds = useMemo(
    () => new Set(options.map((option) => option.value)),
    [options],
  );

  const resetForm = () => {
    setEditing(null);
    setDuplicatingFrom(null);
    setModel('');
    setModelId('');
    setEnvRows([]);
    setEnvDirty(false);
    setError(null);
  };

  const selectProvider = (provider: LLMProvider) => {
    setSelectedProvider(provider);
    setConfirmDeleteRecordId(null);
    setNotice(null);
    resetForm();
  };

  const startEditing = (option: ProviderModelOption) => {
    setEditing(option);
    setDuplicatingFrom(null);
    setModel(option.label);
    setModelId(option.value);
    setEnvRows(toEditorRows(option.config));
    setEnvDirty(false);
    setConfirmDeleteRecordId(null);
    setNotice(null);
    setError(null);
  };

  /**
   * Enters the copy state for `option`: the same rows the server will copy, with
   * `(copy)` naming and a free id suggestion. No secret value is available here
   * — a stored secret reads back as an empty, `secretStored` row — so the rows
   * pre-filled this way say "keep the source's secret", and the server is the
   * one that actually carries the value over.
   */
  const startDuplicating = (option: ProviderModelOption) => {
    setEditing(null);
    setDuplicatingFrom(option);
    setModel(tSettings('modelLibrary.duplicate.name', { source: option.label }).slice(0, MODEL_NAME_MAX_LENGTH));
    setModelId(suggestCopyId(option.value, takenModelIds));
    setEnvRows(toEditorRows(option.config));
    setEnvDirty(false);
    setConfirmDeleteRecordId(null);
    setNotice(null);
    setError(null);
  };

  // Whether this submit carries `config.env` at all: the same predicate that
  // builds it below. When it is false no row is dropped, so nothing is reported.
  const sendsEnvConfig = envDirty || (!editing && envRows.length > 0);
  // Rows the request will leave out for an empty value — the user must see them
  // before submitting, or a named variable silently never reaches the server.
  const unsavedEnvKeys = sendsEnvConfig ? getUnsavedEnvRows(envRows).map((row) => row.key.trim()) : [];

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedModel = model.trim();
    const normalizedId = modelId.trim();
    if (!normalizedModel || !normalizedId) {
      setError(t('chat:misc.enterModelInfo'));
      return;
    }
    if (/\s/.test(normalizedId)) {
      setError('Model IDs cannot contain spaces.');
      return;
    }
    // Both providers' catalogs are in hand, so a colliding id is worth answering
    // here: it names the id, where the server's 409 arrives after a round trip.
    if (!editing && takenModelIds.has(normalizedId)) {
      setError(tSettings('modelLibrary.duplicate.idTaken', { id: normalizedId }));
      return;
    }

    setSaving(true);
    setError(null);
    setNotice(null);
    const configInput = sendsEnvConfig
      ? { config: { env: toRequestRows(envRows) } }
      : {};
    try {
      if (editing) {
        await actions.update(selectedProvider, editing, {
          model: normalizedModel,
          id: normalizedId,
          ...configInput,
        });
        setNotice(`${normalizedModel} was updated.`);
      } else if (duplicatingFrom) {
        await actions.duplicate(selectedProvider, duplicatingFrom, {
          model: normalizedModel,
          id: normalizedId,
          ...configInput,
        });
        setNotice(tSettings('modelLibrary.duplicate.notice', {
          source: duplicatingFrom.label,
          name: normalizedModel,
        }));
      } else {
        await actions.create(selectedProvider, {
          model: normalizedModel,
          id: normalizedId,
          ...configInput,
        });
        setNotice(`${normalizedModel} was added.`);
      }
      resetForm();
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : t('chat:misc.modelSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (option: ProviderModelOption) => {
    if (!option.recordId) {
      return;
    }

    setDeletingRecordId(option.recordId);
    setError(null);
    setNotice(null);
    try {
      await actions.remove(selectedProvider, option);
      if (editing?.recordId === option.recordId) {
        resetForm();
      }
      setConfirmDeleteRecordId(null);
      setNotice(`${option.label} was deleted.`);
    } catch (caughtError) {
      setError(caughtError instanceof Error ? caughtError.message : t('chat:misc.modelDeleteFailed'));
    } finally {
      setDeletingRecordId(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <div className="flex shrink-0 flex-col gap-3 border-b border-border/70 pb-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl border border-primary/25 bg-primary/10 text-primary">
              <Plus className="h-4 w-4" />
            </span>
            <div>
              <p className="text-base font-semibold tracking-tight text-foreground">Model library</p>
              <p className="text-xs leading-5 text-muted-foreground">
                Add model IDs supported by your provider. Built-in models stay locked.
              </p>
            </div>
          </div>
        </div>
        {onDone && (
          <Button type="button" variant="outline" size="sm" onClick={onDone} className="shrink-0 rounded-xl">
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to models
          </Button>
        )}
      </div>

      {!hideProviderTabs && (
      <div className="scrollbar-thin flex shrink-0 gap-1 overflow-x-auto rounded-xl border border-border/70 bg-muted/25 p-1">
        {PROVIDERS.map((provider) => {
          const selected = provider.id === selectedProvider;
          return (
            <button
              key={provider.id}
              type="button"
              onClick={() => selectProvider(provider.id)}
              aria-pressed={selected}
              className={`flex min-w-fit flex-1 items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold transition-all ${
                selected
                  ? 'bg-background text-foreground shadow-sm ring-1 ring-border/70'
                  : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'
              }`}
            >
              <LLMProviderLogo provider={provider.id} className="h-4 w-4" />
              {provider.label}
            </button>
          );
        })}
      </div>
      )}

      <div className="scrollbar-thin grid min-h-0 flex-1 grid-cols-1 items-start gap-4 overflow-y-auto pr-1">
        <form
          onSubmit={handleSubmit}
          className="h-fit rounded-2xl border border-border/70 bg-muted/20 p-4 shadow-sm"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-foreground">
                {editing
                  ? 'Edit custom model'
                  : duplicatingFrom ? tSettings('modelLibrary.duplicate.title') : 'Add a custom model'}
              </p>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                {duplicatingFrom
                  ? tSettings('modelLibrary.duplicate.description', { source: duplicatingFrom.label })
                  : `The ID is sent to ${PROVIDERS.find((entry) => entry.id === selectedProvider)?.label} exactly as written.`}
              </p>
            </div>
            {(editing || duplicatingFrom) && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                onClick={resetForm}
                className="h-8 w-8 rounded-lg"
                aria-label={t('chat:misc.cancelEditing')}
              >
                <X className="h-4 w-4" />
              </Button>
            )}
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <div>
          <label className="block text-xs font-semibold text-foreground" htmlFor="custom-model-name">
            Model name
          </label>
          <Input
            id="custom-model-name"
            value={model}
            onChange={(event) => setModel(event.target.value)}
            maxLength={MODEL_NAME_MAX_LENGTH}
            placeholder="e.g. GPT-5.5 Pro"
            autoComplete="off"
            className="mt-1.5 h-10 rounded-xl bg-background"
          />
            </div>
            <div>
          <label className="block text-xs font-semibold text-foreground" htmlFor="custom-model-id">
            Model ID
          </label>
          <Input
            id="custom-model-id"
            value={modelId}
            onChange={(event) => setModelId(event.target.value)}
            maxLength={MODEL_ID_MAX_LENGTH}
            placeholder="e.g. gpt-5.5-pro"
            autoComplete="off"
            spellCheck={false}
            className="mt-1.5 h-10 rounded-xl bg-background font-mono"
          />
          <p className="mt-1.5 text-[11px] leading-4 text-muted-foreground">
            {duplicatingFrom
              ? tSettings('modelLibrary.duplicate.idHint')
              : 'Use the exact identifier accepted by the provider CLI. IDs cannot contain spaces.'}
          </p>
            </div>
          </div>

          {selectedProvider !== 'opencode' && (
            <ModelEnvEditor
              rows={envRows}
              envStatus={envStatus}
              showGatewayTemplate={selectedProvider === 'claude'}
              reportUnsavedRows={sendsEnvConfig}
              onChange={(rows) => { setEnvRows(rows); setEnvDirty(true); }}
            />
          )}

          {unsavedEnvKeys.length > 0 && (
            <div
              role="status"
              data-testid="model-env-unsaved-summary"
              className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
            >
              <p>{tSettings('modelLibrary.env.unsavedSummary')}</p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {unsavedEnvKeys.map((key, index) => (
                  <li key={`${index}:${key}`} className="rounded-full bg-amber-500/15 px-2 py-0.5 font-mono text-[11px]">
                    {key}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {error && (
            <div role="alert" className="mt-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
          {notice && !error && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
              <Check className="h-3.5 w-3.5" />
              {notice}
            </div>
          )}

          <Button type="submit" disabled={saving} className="mt-4 w-full rounded-xl">
            {saving
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : editing ? <Check className="h-4 w-4" /> : duplicatingFrom ? <Copy className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
            {saving
              ? 'Saving…'
              : editing ? 'Save changes' : duplicatingFrom ? tSettings('modelLibrary.duplicate.submit') : 'Add model'}
          </Button>
        </form>

        <div className="min-h-0 space-y-4">
          <section>
            <div className="mb-2 flex items-center justify-between gap-3 px-1">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-foreground">Your models</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Editable and stored in auth.db</p>
              </div>
              <Badge variant="secondary" className="rounded-full text-[10px]">{customModels.length}</Badge>
            </div>

            {customModels.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-border bg-background/60 px-4 py-7 text-center">
                <p className="text-sm font-medium text-foreground">No custom models yet</p>
                <p className="mt-1 text-xs text-muted-foreground">Add one with the form and it will appear in every model picker.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {customModels.map((option) => {
                  const confirming = confirmDeleteRecordId === option.recordId;
                  const deleting = deletingRecordId === option.recordId;
                  return (
                    <div key={option.recordId ?? option.value} className="rounded-2xl border border-primary/20 bg-primary/[0.04] p-3">
                      <div className="flex items-start gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-semibold text-foreground">{option.label}</p>
                            <Badge className="rounded-full px-2 py-0 text-[9px]">Custom</Badge>
                          </div>
                          <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{option.value}</p>
                        </div>
                        {!confirming && (
                          <div className="flex shrink-0 items-center gap-1">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => startEditing(option)}
                              className="h-8 w-8 rounded-lg"
                              aria-label={`Edit ${option.label}`}
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => startDuplicating(option)}
                              className="h-8 w-8 rounded-lg"
                              aria-label={tSettings('modelLibrary.duplicate.actionLabel', { name: option.label })}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              onClick={() => setConfirmDeleteRecordId(option.recordId ?? null)}
                              className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                              aria-label={`Delete ${option.label}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        )}
                      </div>
                      {confirming && (
                        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
                          <p className="text-xs text-muted-foreground">Delete this model from all pickers?</p>
                          <div className="flex items-center gap-2">
                            <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmDeleteRecordId(null)} className="h-8 rounded-lg">
                              Cancel
                            </Button>
                            <Button type="button" variant="destructive" size="sm" disabled={deleting} onClick={() => void handleDelete(option)} className="h-8 rounded-lg">
                              {deleting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                              Delete
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <div className="mb-2 flex items-center justify-between gap-3 px-1">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.14em] text-foreground">Built-in models</p>
                <p className="mt-0.5 text-[11px] text-muted-foreground">Maintained by CloudCLI and read-only</p>
              </div>
              <Badge variant="secondary" className="rounded-full text-[10px]">{predefinedModels.length}</Badge>
            </div>
            <div className="overflow-hidden rounded-2xl border border-border/70 bg-background/70">
              {predefinedModels.map((option) => (
                <div key={option.recordId ?? option.value} className="flex items-center gap-3 border-b border-border/60 px-3 py-2.5 last:border-b-0">
                  <LockKeyhole className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs font-medium text-foreground">{option.label}</p>
                    <p className="truncate font-mono text-[10px] text-muted-foreground">{option.value}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
