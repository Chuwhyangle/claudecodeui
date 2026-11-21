import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { ChevronDown, ChevronRight } from 'lucide-react';

import type { ProviderModelOption } from '@/shared/types';
import { DEFAULT_EFFORT_VALUE } from '@/shared/constants';
import { useComposerMenuAnchor } from '@/modules/chat-composer/hooks/useComposerMenuAnchor';
import {
  ComposerMenuHeading,
  ComposerMenuItem,
  ComposerMenuSeparator,
  ComposerMenuSurface,
} from '@/modules/chat-composer/composer/menus/ComposerMenuPrimitives';

type EffortOption = NonNullable<ProviderModelOption['effort']>['values'][number];

/**
 * One selectable row's identity: the model id sent to the provider runtime and
 * the upstream provider it runs under (`null` for the bare, inherit-the-default
 * row). A built-in model is offered once per registered provider, so those rows
 * share `model` and only this pair tells them apart.
 */
type ModelEntry = {
  model: string;
  providerId: string | null;
  label: string;
};

/** One model's rows, kept together so its bare row and variants are adjacent. */
type ModelGroup = {
  key: string;
  label: string;
  entries: ModelEntry[];
};

/** Reads a provider id off the catalog, treating a blank one as the bare identity. */
const readProviderId = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

/**
 * A row's own model name, with the server's `model · provider` display suffix
 * removed.
 *
 * The suffix is how the server keeps two rows with the same display name
 * distinguishable; the menu composes its own `model (provider)` label from the
 * identity fields instead, so keeping the server's suffix too would print the
 * provider twice.
 */
const modelNameOf = (option: ProviderModelOption, providerId: string | null): string => {
  const label = option.label || option.value;
  const suffix = providerId === null ? null : ` · ${providerId}`;
  return suffix !== null && label.endsWith(suffix)
    ? label.slice(0, -suffix.length)
    : label;
};

/**
 * Groups catalog rows by model, in catalog order.
 *
 * Purely data-driven: the groups, their labels and their variants all come from
 * the rows the catalog answered with. Nothing here knows which provider a
 * catalog belongs to, and no provider list is expanded speculatively — a
 * provider that was deleted (or never registered) has no row, so it has no
 * entry. Duplicate `(model, provider)` rows collapse to the first one.
 */
const groupModelOptions = (options: ProviderModelOption[]): ModelGroup[] => {
  const groups: ModelGroup[] = [];
  const byModel = new Map<string, ModelGroup>();

  for (const option of options) {
    const providerId = readProviderId(option.modelProviderId);
    let group = byModel.get(option.value);
    if (!group) {
      group = {
        key: option.value,
        label: modelNameOf(option, providerId),
        entries: [],
      };
      byModel.set(option.value, group);
      groups.push(group);
    }
    if (group.entries.some((entry) => entry.providerId === providerId)) {
      continue;
    }
    group.entries.push({
      model: option.value,
      providerId,
      // A custom model is a single row whose binding is already part of its own
      // name; only a built-in row needs the provider spelled out beside it.
      label: providerId === null || option.isCustom ? group.label : `${group.label} (${providerId})`,
    });
  }

  return groups;
};

type ComposerModelMenuProps = {
  effort: string;
  /** Effort values the active provider/model actually accepts; empty hides the section. */
  effortOptions: EffortOption[];
  onSelectEffort: (effort: string) => void;
  model: string;
  /**
   * Upstream provider id of the active selection, or absent/null for the bare
   * (inherit-the-provider-default) identity. Optional so a host that predates
   * provider-bound catalogs keeps working unchanged.
   */
  modelProviderId?: string | null;
  /** Model catalog for the active provider; empty hides the section. */
  modelOptions: ProviderModelOption[];
  /** Receives the clicked row's full identity, not just the model id. */
  onSelectModel: (model: string, modelProviderId?: string | null) => void;
  modelsLoading: boolean;
};

/**
 * Rendered by chat's ChatComposer as the popover for choosing the active
 * provider's model and reasoning effort for the next turn.
 */
function ComposerModelMenu({
  effort,
  effortOptions,
  onSelectEffort,
  model,
  modelProviderId = null,
  modelOptions,
  onSelectModel,
  modelsLoading,
}: ComposerModelMenuProps) {
  const { t } = useTranslation('chat');
  const [isOpen, setIsOpen] = useState(false);
  const [isModelSectionOpen, setIsModelSectionOpen] = useState(false);
  const close = useCallback(() => setIsOpen(false), []);
  const { triggerRef, menuRef, anchor, updateAnchor } = useComposerMenuAnchor(isOpen, close);

  // The model list starts collapsed every time the menu opens, the way Codex
  // shows reasoning first and keeps the longer model list one click away.
  useEffect(() => {
    if (!isOpen) {
      setIsModelSectionOpen(false);
    }
  }, [isOpen]);

  const defaultEffortLabel = t('composer.effortDefault', { defaultValue: 'Default' });
  const resolvedEffortOptions = useMemo<EffortOption[]>(
    () => (effortOptions.length > 0 ? [{ value: DEFAULT_EFFORT_VALUE }, ...effortOptions] : []),
    [effortOptions],
  );
  const effortLabel = effort === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : effort;

  const modelGroups = useMemo(() => groupModelOptions(modelOptions), [modelOptions]);
  const selectedProviderId = readProviderId(modelProviderId);

  /**
   * Whether the active selection is this row. Both halves have to match: the
   * bare row and its provider variants share `model`, so comparing the model id
   * alone would tick every variant of the active model at once.
   */
  const isSelectedEntry = useCallback(
    (entry: ModelEntry) => entry.model === model && entry.providerId === selectedProviderId,
    [model, selectedProviderId],
  );
  const selectedEntry = useMemo(() => {
    for (const group of modelGroups) {
      const entry = group.entries.find(isSelectedEntry);
      if (entry) {
        return entry;
      }
    }
    return null;
  }, [isSelectedEntry, modelGroups]);
  // The catalog may not carry the active identity yet (still loading, or a
  // session bound to a provider that was just deleted); the composition is then
  // taken from the selection itself rather than from a row that is not there.
  const modelLabel = selectedEntry?.label
    ?? (selectedProviderId === null ? model : `${model} (${selectedProviderId})`);

  const hasEffortSection = resolvedEffortOptions.length > 0;
  const hasModelSection = modelOptions.length > 0 || modelsLoading;
  if (!hasEffortSection && !hasModelSection) {
    return null;
  }

  const triggerLabel = hasModelSection ? modelLabel : effortLabel;
  const ariaLabel = t('composer.modelMenu', {
    defaultValue: 'Select model and reasoning effort',
  });

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          updateAnchor();
          setIsOpen((current) => !current);
        }}
        className="flex h-8 max-w-20 shrink-0 items-center gap-1 rounded-lg border border-border/60 bg-muted/40 px-2 text-xs font-medium text-foreground transition-colors hover:bg-muted sm:max-w-56"
        aria-haspopup="menu"
        aria-expanded={isOpen}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        <span className="truncate">{triggerLabel}</span>
        {hasModelSection && hasEffortSection && effort !== DEFAULT_EFFORT_VALUE && (
          <span className="hidden shrink-0 capitalize text-muted-foreground sm:inline">· {effortLabel}</span>
        )}
      </button>

      {isOpen && anchor && createPortal(
        <ComposerMenuSurface anchor={anchor} menuRef={menuRef} ariaLabel={ariaLabel}>
          {hasEffortSection && (
            <>
              <ComposerMenuHeading>
                {t('composer.reasoning', { defaultValue: 'Reasoning' })}
              </ComposerMenuHeading>
              {resolvedEffortOptions.map((option) => (
                <ComposerMenuItem
                  key={option.value}
                  label={option.value === DEFAULT_EFFORT_VALUE ? defaultEffortLabel : option.value}
                  description={option.description}
                  isSelected={option.value === effort}
                  onSelect={() => {
                    onSelectEffort(option.value);
                    setIsOpen(false);
                  }}
                  className="capitalize"
                />
              ))}
            </>
          )}

          {hasModelSection && (
            <>
              {hasEffortSection && <ComposerMenuSeparator />}
              <ComposerMenuItem
                role="menuitem"
                label={modelLabel}
                isSelected={false}
                onSelect={() => setIsModelSectionOpen((current) => !current)}
                trailing={
                  isModelSectionOpen
                    ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                    : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                }
                className="text-muted-foreground"
              />

              {isModelSectionOpen && (
                <>
                  <ComposerMenuHeading>
                    {t('composer.model', { defaultValue: 'Model' })}
                  </ComposerMenuHeading>
                  {modelOptions.length === 0 && modelsLoading && (
                    <p className="px-2.5 py-1.5 text-sm text-muted-foreground">
                      {t('composer.loadingModels', { defaultValue: 'Loading models…' })}
                    </p>
                  )}
                  {/*
                    One group per model, its rows kept together: the bare row
                    first (inherit the provider default), then one `model
                    (provider)` row per registered upstream provider. A custom
                    model is a single row — its binding is already specific — so
                    it is never fanned out into variants.
                  */}
                  {modelGroups.map((group, groupIndex) => (
                    <div key={group.key} role="group" aria-label={group.label}>
                      {groupIndex > 0 && <ComposerMenuSeparator />}
                      {group.entries.map((entry) => (
                        <ComposerMenuItem
                          key={`${entry.model}::${entry.providerId ?? ''}`}
                          label={entry.label}
                          isSelected={isSelectedEntry(entry)}
                          onSelect={() => {
                            onSelectModel(entry.model, entry.providerId);
                            setIsOpen(false);
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </>
              )}
            </>
          )}
        </ComposerMenuSurface>,
        document.body,
      )}
    </>
  );
}

/** Memoized: the composer re-renders on every keystroke and none of this menu's props change while typing. */
export default memo(ComposerModelMenu);
