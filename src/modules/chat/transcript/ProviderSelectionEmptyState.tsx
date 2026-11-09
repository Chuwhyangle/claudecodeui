import React, { useCallback, useMemo, useState } from "react";
import { ChevronDown, Plus } from "lucide-react";
import { Trans, useTranslation } from "react-i18next";

import type {
  ProjectSession,
  LLMProvider,
  ProviderModelActions,
  ProviderModelsDefinition,
} from "@/shared/types";
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  Card,
  Button,
  LLMProviderLogo,
} from "@/shared/ui";
import { ModelGroupList, ResidentToggle, type ModelGroup } from '@/modules/chat-support';
import { ModelLibraryPanel } from "@/modules/model-library";
import { writeSelectedProvider } from '@/shared/settings/selectedProvider';
import {
  modelOptionDisplayName,
  readModelOptionProviderId,
  readModelProviderId,
} from '@/shared/utils';

const PROVIDER_META: { id: LLMProvider; name: string }[] = [
  { id: "claude", name: "Anthropic" },
  { id: "codex", name: "OpenAI" },
  { id: "cursor", name: "Cursor" },
  { id: "opencode", name: "OpenCode" },
];

const MOD_KEY =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl";

// cmdk's default filter is fuzzy (loose character-subsequence scoring), which
// surfaces unrelated models — e.g. searching "chatgpt" also matched "Fable".
// Require every whitespace-separated search token to appear as a literal
// substring instead, so "claude 4.5" still matches "Anthropic Claude Haiku 4.5"
// but "chatgpt" only matches models that actually contain it.
function modelSearchFilter(value: string, search: string): number {
  const haystack = value.toLowerCase();
  const tokens = search.toLowerCase().split(/\s+/).filter(Boolean);
  return tokens.every((token) => haystack.includes(token)) ? 1 : 0;
}

/**
 * The next-task banner's shape, as this empty state uses it.
 *
 * The component itself is handed in (`nextTaskBanner`) rather than imported: the banner lives in
 * task-master, and the transcript package must not depend on that feature — the two would then be
 * mutually reachable through shell→chat and never separable. `ChatInterface`, which already reads
 * the task feature's settings, supplies it.
 */
export type NextTaskBannerComponent = React.ComponentType<{
  onStartTask?: (() => void) | null;
  onShowAllTasks?: (() => void) | null;
  className?: string;
}>;

type ProviderSelectionEmptyStateProps = {
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  setProvider: (next: LLMProvider) => void;
  textareaRef: React.RefObject<HTMLTextAreaElement>;
  providerModels: Record<LLMProvider, string>;
  /**
   * Records the pick as this provider's default and persists it. The third
   * argument is the upstream provider the row runs under (`null` for the bare,
   * inherit-the-default identity); a host that predates provider-bound catalogs
   * may ignore it.
   */
  setProviderModel: (provider: LLMProvider, model: string, modelProviderId?: string | null) => void;
  /**
   * Upstream provider id of the active selection, from the host that owns the
   * selection. Absent is not an error: the picker falls back to the row this
   * picker just picked, then to the catalog when exactly one row serves the
   * active model; otherwise it shows the bare model rather than guessing
   * between variants.
   */
  currentModelProviderId?: string | null;
  providerModelCatalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>;
  providerModelActions: ProviderModelActions;
  providerModelsLoading: boolean;
  tasksEnabled: boolean;
  isTaskMasterInstalled: boolean | null;
  onShowAllTasks?: (() => void) | null;
  setInput: React.Dispatch<React.SetStateAction<string>>;
  /**
   * Whether the selected provider can hold a resident session. The switch below the model card is
   * drawn only when it can — the capability matrix's answer, not this file's.
   */
  canRunResident: boolean;
  /**
   * Whether the next brand-new session is meant to be resident.
   *
   * Owned by `ChatInterface` and handed down, because the send path that applies it lives in
   * `useChatComposerState` while the switch that sets it is rendered here.
   */
  residentEnabled: boolean;
  /** Flips `residentEnabled`. This empty state is the switch's only home now. */
  onToggleResident: () => void;
  /**
   * Draws the next-task banner above the provider picker. Absent draws nothing —
   * a standalone render has no task feature to ask.
   */
  nextTaskBanner?: NextTaskBannerComponent;
};

function getModelConfig(
  p: LLMProvider,
  catalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>,
): ProviderModelsDefinition {
  const entry = catalog[p];
  return entry ?? { OPTIONS: [], DEFAULT: "" };
}

function getProviderDisplayName(p: LLMProvider) {
  if (p === "claude") return "Claude";
  if (p === "cursor") return "Cursor";
  if (p === "codex") return "Codex";
  if (p === "opencode") return "OpenCode";
  return "Claude";
}

/**
 * The picker's branches, decided by the catalog rather than by a provider id.
 *
 * A catalog whose rows name an upstream provider is grouped by model: those
 * rows share `value` and differ only by provider, so one provider branch would
 * hold several rows with the same name and the clicked row's identity would not
 * be readable back. Every other catalog keeps the single branch per provider it
 * has always had. Nothing here knows which provider a catalog belongs to, so a
 * new provider needs a catalog row, not a code path.
 */
function buildVisibleGroups(
  catalog: Partial<Record<LLMProvider, ProviderModelsDefinition>>,
): ModelGroup[] {
  const groups: ModelGroup[] = [];
  const byKey = new Map<string, ModelGroup>();

  for (const meta of PROVIDER_META) {
    const options = catalog[meta.id]?.OPTIONS ?? [];
    const bindsUpstreamProvider = options.some(
      (option) => readModelOptionProviderId(option) !== null,
    );

    if (!bindsUpstreamProvider) {
      groups.push({
        key: meta.id,
        provider: meta.id,
        name: meta.name,
        models: options,
      });
      continue;
    }

    for (const option of options) {
      const providerId = readModelOptionProviderId(option);
      const key = `${meta.id}:model:${option.value}`;
      let group = byKey.get(key);
      if (!group) {
        group = {
          key,
          provider: meta.id,
          name: modelOptionDisplayName(option, providerId),
          models: [],
        };
        byKey.set(key, group);
        groups.push(group);
      }

      // Two rows for the same (model, provider) are one identity; the first wins.
      if (group.models.some((entry) => readModelOptionProviderId(entry) === providerId)) {
        continue;
      }
      group.models.push(option);
    }
  }

  return groups;
}

/**
 * Rendered by chat's ChatMessagesPane when a session has no messages yet, so
 * the user can pick a provider, model and permission mode before their first turn.
 */
export default function ProviderSelectionEmptyState({
  selectedSession,
  currentSessionId,
  provider,
  setProvider,
  textareaRef,
  providerModels,
  setProviderModel,
  currentModelProviderId: explicitModelProviderId,
  providerModelCatalog,
  providerModelActions,
  providerModelsLoading,
  tasksEnabled,
  isTaskMasterInstalled,
  onShowAllTasks,
  setInput,
  canRunResident,
  residentEnabled,
  onToggleResident,
  nextTaskBanner: NextTaskBanner,
}: ProviderSelectionEmptyStateProps) {
  const { t } = useTranslation("chat");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [modelLibraryOpen, setModelLibraryOpen] = useState(false);

  const [modelSearch, setModelSearch] = useState("");

  /**
   * Opens and closes the picker, clearing the search on the way out.
   *
   * The search box is controlled, so a query left behind comes back with the
   * dialog - and brings every branch open with it, since searching expands
   * them. Reopening would undo the collapsing this picker is built around.
   */
  const setPickerOpen = useCallback((open: boolean) => {
    setDialogOpen(open);
    if (!open) {
      setModelSearch("");
    }
  }, []);

  /**
   * One collapsible branch per model for a provider-bound catalog, one per
   * provider otherwise — see `buildVisibleGroups`.
   */
  const visibleProviderGroups = useMemo<ModelGroup[]>(
    () => buildVisibleGroups(providerModelCatalog),
    [providerModelCatalog],
  );

  const nextTaskPrompt = t("tasks.nextTaskPrompt", {
    defaultValue: "Start the next task",
  });

  const currentModel = providerModels[provider];

  /**
   * The row this picker itself just chose, as `(model, provider id)`.
   *
   * ! Possibly unnecessary once every host passes `currentModelProviderId`:
   * the host's answer is authoritative and is preferred below. Until it does,
   * this is the only record of WHICH row was clicked — the model id is shared
   * by the bare row and its provider variants — so without it the card after a
   * pick would fall back to printing the bare model.
   *
   * Scoped to the active model: when the host hands over a different model
   * (a restored selection, another tab), the remembered row no longer
   * describes what is shown and is ignored.
   */
  const [pickedRow, setPickedRow] = useState<{ model: string; providerId: string | null } | null>(
    null,
  );

  /**
   * The active selection's upstream provider id, in order of authority: the
   * host's answer, the row this picker just picked, then a catalog with exactly
   * ONE row for the active model (a custom entry bound to a provider is such a
   * row). Anything else stays bare: guessing between variants would draw a
   * binding nobody chose.
   */
  const currentModelProviderId = useMemo(() => {
    const explicit = readModelProviderId(explicitModelProviderId);
    if (explicit !== null) {
      return explicit;
    }

    if (pickedRow !== null && pickedRow.model === currentModel) {
      return pickedRow.providerId;
    }

    const matching = (providerModelCatalog[provider]?.OPTIONS ?? [])
      .filter((option) => option.value === currentModel);
    if (matching.length !== 1) {
      return null;
    }
    return readModelOptionProviderId(matching[0]);
  }, [explicitModelProviderId, pickedRow, provider, providerModelCatalog, currentModel]);

  const currentModelLabel = useMemo(() => {
    const config = getModelConfig(provider, providerModelCatalog);
    // The row matching the full identity wins; several rows can share a value.
    const found = config.OPTIONS.find((option) => (
      option.value === currentModel
      && readModelOptionProviderId(option) === currentModelProviderId
    )) ?? config.OPTIONS.find((option) => option.value === currentModel);
    if (!found) {
      return currentModel;
    }
    return modelOptionDisplayName(found, readModelOptionProviderId(found));
  }, [provider, currentModel, currentModelProviderId, providerModelCatalog]);

  /** The collapsed card's label: the model, plus the provider when the pick names one. */
  const currentModelDisplayLabel = currentModelProviderId === null
    ? currentModelLabel
    : `${currentModelLabel} (${currentModelProviderId})`;

  const handleModelSelect = useCallback(
    (providerId: LLMProvider, modelValue: string, modelProviderId: string | null) => {
      // Remembered before the callback: the host re-renders with the new model,
      // and the card has to compose its label from the row that was clicked.
      setPickedRow({ model: modelValue, providerId: modelProviderId });
      setProvider(providerId);
      writeSelectedProvider(providerId);
      setProviderModel(providerId, modelValue, modelProviderId);
      setPickerOpen(false);
      setTimeout(() => textareaRef.current?.focus(), 100);
    },
    [setProvider, setProviderModel, setPickerOpen, textareaRef],
  );

  const openModelLibrary = () => {
    setPickerOpen(false);
    setModelLibraryOpen(true);
  };

  const closeModelLibrary = () => {
    setModelLibraryOpen(false);
    setPickerOpen(true);
  };

  if (!selectedSession && !currentSessionId) {
    return (
      <div className="flex h-full items-center justify-center px-4">
        <div className="w-full max-w-[34.25rem]">
          <div className="mb-8 text-center">
            <h2 className="text-lg font-semibold tracking-tight text-foreground sm:text-xl">
              {t("providerSelection.title")}
            </h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {t("providerSelection.description")}
            </p>
          </div>

          <Dialog open={dialogOpen} onOpenChange={setPickerOpen}>
            <DialogTrigger asChild>
              <Card
                className="group mx-auto max-w-xs cursor-pointer border-border/60 transition-all duration-150 hover:border-border hover:shadow-md active:scale-[0.99]"
                role="button"
                tabIndex={0}
              >
                <div className="flex items-center gap-2 p-3">
                  <LLMProviderLogo
                    provider={provider}
                    className="h-5 w-5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-semibold text-foreground">
                        {getProviderDisplayName(provider)}
                      </span>
                      <span className="text-xs text-muted-foreground">·</span>
                      <span className="truncate text-xs text-foreground">
                        {currentModelDisplayLabel}
                      </span>
                    </div>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("providerSelection.clickToChange", {
                        defaultValue: "Click to change model",
                      })}
                    </p>
                  </div>
                  <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-y-0.5" />
                </div>
              </Card>
            </DialogTrigger>

            {/*
              The resident switch, directly under the card that picks the model.

              It is the switch's only home: the composer's own copy was removed, and a session that
              already exists is converted from the session menu. So the affordance belongs exactly
              here — before the first turn, when the mode has to be chosen at the moment the session
              is created. It is deliberately outside `DialogTrigger` — the card opens the model picker
              on any click inside it, and a switch nested there would open a dialog instead of
              flipping.

              The hint beside it explains what the mode does; it asks for nothing. Turning the switch
              on is the whole of the intent, and the send that follows is resident.
            */}
            {canRunResident && (
              <div className="mx-auto mt-3 max-w-xs">
                <ResidentToggle enabled={residentEnabled} onToggle={onToggleResident} />
              </div>
            )}

            <DialogContent className="max-w-md overflow-hidden p-0">
              <DialogTitle>Model Selector</DialogTitle>
              <div className="flex items-center justify-between gap-3 border-b border-border/60 bg-muted/20 px-4 py-3">
                <div>
                  <p className="text-sm font-semibold text-foreground">
                    {t("providerSelection.chooseModel", {
                      defaultValue: "Choose a model",
                    })}
                  </p>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {t("providerSelection.chooseModelDescription", {
                      defaultValue: "Built-in and custom models in one list",
                    })}
                  </p>
                </div>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={openModelLibrary}
                  className="h-8 shrink-0 rounded-lg px-2.5 text-xs"
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("providerSelection.addModel", { defaultValue: "Add model" })}
                </Button>
              </div>
              <Command filter={modelSearchFilter}>
                <CommandInput
                  value={modelSearch}
                  onValueChange={setModelSearch}
                  placeholder={t("providerSelection.searchModels", {
                    defaultValue: "Search models...",
                  })}
                />
                <CommandList className="max-h-[350px]">
                  <CommandEmpty>
                    {t("providerSelection.noModelsFound", {
                      defaultValue: "No models found.",
                    })}
                  </CommandEmpty>
                  <ModelGroupList
                    groups={visibleProviderGroups}
                    provider={provider}
                    currentModel={currentModel}
                    currentModelProviderId={currentModelProviderId}
                    loading={providerModelsLoading}
                    searching={modelSearch.trim().length > 0}
                    onSelect={handleModelSelect}
                    loadingLabel={t("providerSelection.loadingModels", {
                      defaultValue: "Loading models…",
                    })}
                  />
                </CommandList>
              </Command>
            </DialogContent>
          </Dialog>

          <Dialog
            open={modelLibraryOpen}
            onOpenChange={(open) => {
              if (open) {
                setModelLibraryOpen(true);
              } else {
                closeModelLibrary();
              }
            }}
          >
            <DialogContent className="flex h-[min(90dvh,46rem)] w-[calc(100vw-1rem)] max-w-4xl flex-col overflow-hidden rounded-3xl p-4 sm:p-5">
              <DialogTitle>
                {t("providerSelection.manageModels", {
                  defaultValue: "Manage models",
                })}
              </DialogTitle>
              <ModelLibraryPanel
                initialProvider={provider}
                providerModelCatalog={providerModelCatalog}
                actions={providerModelActions}
                onDone={closeModelLibrary}
              />
            </DialogContent>
          </Dialog>

          <p className="mt-4 text-center text-sm text-muted-foreground/70">
            {
              {
                claude: t("providerSelection.readyPrompt.claude", {
                  model: providerModels.claude,
                }),
                cursor: t("providerSelection.readyPrompt.cursor", {
                  model: providerModels.cursor,
                }),
                codex: t("providerSelection.readyPrompt.codex", {
                  model: providerModels.codex,
                }),
                opencode: t("providerSelection.readyPrompt.opencode", {
                  model: providerModels.opencode,
                  defaultValue: "Ready with OpenCode {{model}}",
                }),
              }[provider]
            }
          </p>

          <p className="mt-3 flex items-center justify-center gap-1.5 text-center text-xs text-muted-foreground/60">
            <Trans
              ns="chat"
              i18nKey="providerSelection.pressToSearch"
              values={{ shortcut: MOD_KEY === "⌘" ? "⌘K" : "Ctrl+K" }}
              components={{
                kbd: (
                  <kbd className="inline-flex items-center gap-0.5 rounded border border-border/60 bg-muted/40 px-1.5 py-0.5 font-mono text-[10px]" />
                ),
              }}
            />
          </p>

          {provider && tasksEnabled && isTaskMasterInstalled && NextTaskBanner && (
            <div className="mt-5">
              <NextTaskBanner
                onStartTask={() => setInput(nextTaskPrompt)}
                onShowAllTasks={onShowAllTasks}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (selectedSession) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="max-w-[34.25rem] px-6 text-center">
          <p className="mb-1.5 text-lg font-semibold text-foreground">
            {t("session.continue.title")}
          </p>
          <p className="text-sm leading-relaxed text-muted-foreground">
            {t("session.continue.description")}
          </p>

          {tasksEnabled && isTaskMasterInstalled && NextTaskBanner && (
            <div className="mt-5">
              <NextTaskBanner
                onStartTask={() => setInput(nextTaskPrompt)}
                onShowAllTasks={onShowAllTasks}
              />
            </div>
          )}
        </div>
      </div>
    );
  }

  return null;
}
