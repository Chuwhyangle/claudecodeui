import { useState } from 'react';
import { Loader2, Plus, Save, Trash2 } from 'lucide-react';

import ModelsContent from '@/modules/settings/tabs/agents-settings/sections/content/ModelsContent';
import CodexProviderImport from '@/modules/settings/tabs/agents-settings/sections/content/CodexProviderImport';
import CodexProviderAdvanced from '@/modules/settings/tabs/agents-settings/sections/content/CodexProviderAdvanced';
import { useCodexProviders } from '@/modules/settings/hooks/useCodexProviders';
import type { CodexProviderBindRequest } from '@/modules/model-library';
import { Button, Input } from '@/shared/ui';
import type { AgentProvider } from '@/shared/types';

type CodexProvidersContentProps = {
  agent: AgentProvider;
};

const fieldClass = 'h-9 rounded-lg bg-background font-mono text-xs';

/**
 * Rendered by AgentCategoryContentSection for a provider whose descriptor declares
 * `showsUpstreamProviderRegistry` (Codex): the project-owned upstream provider registry
 * (`GET/PUT /api/settings/codex/model-providers`) and, below it, the model library whose
 * entries bind to one of these providers.
 *
 * The page is deliberately explicit about the two facts the registry exists to enforce:
 * `wire_api` is always `responses` (Codex refuses Chat Completions), and the secret is a
 * token FILE — the form can set it, but the reading only ever says whether one is stored, so
 * no secret value is drawn, logged, or sent back.
 *
 * The `data-codex-*` attributes are the page's own declaration of this panel's state, read by
 * `scripts/ui-scenario.mjs` and by the criterion; the drive verbs press the same inputs and
 * buttons a person does.
 */
export default function CodexProvidersContent({ agent }: CodexProvidersContentProps) {
  const {
    snapshot, load, addDraft, updateDraft, removeDraft, save, bindImportedProvider, testConnection,
  } = useCodexProviders();
  const reading = snapshot.reading;
  const providers = reading?.providers ?? [];
  const busy = snapshot.status === 'loading' || snapshot.status === 'saving';
  // The latest one-click bind, carried down to the model editor so its picker selects the
  // provider the person just bound. `requestId` makes a second bind of the same id re-apply;
  // the draft rows themselves stay the controller's, never this state's.
  const [bindRequest, setBindRequest] = useState<CodexProviderBindRequest | null>(null);
  const storedWarnings = new Map(providers.map((provider) => [provider.id, provider.warnings]));

  const handleBindImportedProvider = (providerId: string) => {
    // Published first: the model editor applies it once the registry answer contains the
    // provider, so a refused import never moves the picker.
    setBindRequest((previous) => ({
      providerId,
      requestId: (previous?.requestId ?? 0) + 1,
    }));
    void bindImportedProvider(providerId);
  };

  return (
    <div
      className="space-y-6"
      data-codex-providers={snapshot.status}
      data-codex-providers-error={snapshot.error?.kind ?? ''}
      data-codex-providers-count={String(snapshot.drafts.length)}
      data-codex-providers-path={reading?.path ?? ''}
      data-codex-import-status={snapshot.importStatus}
    >
      <section className="rounded-2xl border border-border/70 bg-muted/20 p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-foreground">Codex providers</p>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-muted-foreground">
              Upstream endpoints project Codex sessions may dial. A model binds to one of these
              providers; a model without a binding inherits Codex&apos;s global default.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="rounded-xl"
            data-codex-providers-add
            disabled={busy}
            onClick={addDraft}
          >
            <Plus className="h-3.5 w-3.5" />
            Add provider
          </Button>
        </div>

        <p
          className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300"
          data-testid="codex-responses-only"
        >
          Codex only supports <code className="font-mono">wire_api = &quot;responses&quot;</code>.
          Chat Completions endpoints are not supported.
        </p>

        {reading !== null && (
          <p className="mt-2 break-all text-[11px] text-muted-foreground" data-testid="codex-providers-path">
            {reading.path}
          </p>
        )}

        {snapshot.status === 'loading' && (
          <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
            Loading providers…
          </p>
        )}

        {snapshot.error?.kind === 'load' && (
          <div role="alert" className="mt-3 rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
            Could not read the Codex provider settings: {snapshot.error.message}
            <Button type="button" variant="ghost" size="sm" className="ml-2 h-7 rounded-lg" onClick={() => void load()}>
              Retry
            </Button>
          </div>
        )}

        {(reading?.warnings.length ?? 0) > 0 && (
          <ul className="mt-3 space-y-1" data-testid="codex-providers-warnings">
            {reading?.warnings.map((warning, index) => (
              <li
                key={`${index}:${warning}`}
                className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300"
                data-testid="codex-provider-warning"
              >
                {warning}
              </li>
            ))}
          </ul>
        )}
      </section>

      <CodexProviderImport
        reading={snapshot.imports}
        onBind={handleBindImportedProvider}
        busy={snapshot.importStatus === 'importing' || busy}
      />

      {snapshot.importError !== null && (
        <p
          role="alert"
          data-testid="codex-import-error"
          className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          Could not import the Codex profile: {snapshot.importError}
        </p>
      )}

      {snapshot.drafts.map((draft, index) => (
        <section
          key={`${index}:${draft.id}`}
          className="rounded-2xl border border-border/70 bg-background/70 p-4"
          data-codex-provider-index={index}
          data-codex-provider-id={draft.id}
          data-codex-provider-token-set={String(draft.tokenSet)}
        >
          <div className="flex items-start justify-between gap-3">
            <p className="font-mono text-sm font-semibold text-foreground">
              {draft.id || 'New provider'}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
              aria-label={`Delete provider ${draft.id || index + 1}`}
              data-codex-provider-delete={index}
              disabled={busy}
              onClick={() => removeDraft(index)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>

          <div className="mt-2 max-w-2xl space-y-1">
            <p
              className="text-[11px] leading-5 text-muted-foreground"
              data-testid="codex-provider-variant-hint"
              data-codex-provider-variant={draft.id}
            >
              The composer and new-session model pickers show this provider&apos;s own models as
              <code className="font-mono">(provider)</code> variants, and the suffix is the
              provider ID (<code className="font-mono">{draft.id || 'provider-id'}</code>).
            </p>
            <p className="text-[11px] leading-5 text-muted-foreground">
              A model with no provider binding keeps Codex&apos;s global default and appears once.
            </p>
          </div>

          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block text-xs font-semibold text-foreground">
              Provider ID
              <Input
                value={draft.id}
                className={`${fieldClass} mt-1.5`}
                data-codex-provider-field="id"
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                placeholder="bob"
                onChange={(event) => updateDraft(index, { id: event.target.value })}
              />
            </label>
            <label className="block text-xs font-semibold text-foreground">
              Display name
              <Input
                value={draft.name}
                className={`${fieldClass} mt-1.5`}
                data-codex-provider-field="name"
                disabled={busy}
                autoComplete="off"
                placeholder="Bob"
                onChange={(event) => updateDraft(index, { name: event.target.value })}
              />
            </label>
            <label className="block text-xs font-semibold text-foreground">
              Base URL
              <Input
                value={draft.baseUrl}
                className={`${fieldClass} mt-1.5`}
                data-codex-provider-field="baseUrl"
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                placeholder="https://gateway.example/v1"
                onChange={(event) => updateDraft(index, { baseUrl: event.target.value })}
              />
            </label>
            <label className="block text-xs font-semibold text-foreground">
              Env key
              <Input
                value={draft.envKey}
                className={`${fieldClass} mt-1.5`}
                data-codex-provider-field="envKey"
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                placeholder="BOB_API_KEY"
                onChange={(event) => updateDraft(index, { envKey: event.target.value })}
              />
            </label>
            <label className="block text-xs font-semibold text-foreground sm:col-span-2">
              Token file
              <Input
                value={draft.tokenFile}
                className={`${fieldClass} mt-1.5`}
                data-codex-provider-field="tokenFile"
                disabled={busy}
                autoComplete="off"
                spellCheck={false}
                placeholder="leave blank for the default path"
                onChange={(event) => updateDraft(index, { tokenFile: event.target.value })}
              />
            </label>
            <label className="block text-xs font-semibold text-foreground sm:col-span-2">
              Token
              <Input
                type="password"
                value={draft.token}
                className={`${fieldClass} mt-1.5`}
                data-codex-provider-field="token"
                data-testid="codex-provider-token"
                disabled={busy}
                autoComplete="new-password"
                placeholder={draft.tokenSet ? '•••••• stored — leave blank to keep it' : 'not set'}
                onChange={(event) => updateDraft(index, { token: event.target.value })}
              />
              <span className="mt-1 block text-[11px] font-normal text-muted-foreground" data-testid="codex-provider-token-set">
                {draft.tokenSet ? '•••••• secret stored in the token file' : 'no secret stored yet'}
              </span>
            </label>
            <label className="block text-xs font-semibold text-foreground sm:col-span-2">
              Wire API
              <Input
                value="responses"
                className={`${fieldClass} mt-1.5`}
                data-codex-provider-field="wireApi"
                disabled
                readOnly
              />
            </label>
          </div>

          {(storedWarnings.get(draft.id) ?? []).length > 0 && (
            <ul className="mt-3 space-y-1">
              {(storedWarnings.get(draft.id) ?? []).map((warning, warningIndex) => (
                <li
                  key={`${warningIndex}:${warning}`}
                  className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-700 dark:text-amber-300"
                  data-testid="codex-provider-warning"
                >
                  {warning}
                </li>
              ))}
            </ul>
          )}

          <CodexProviderAdvanced
            draft={draft}
            disabled={busy}
            canTest={providers.some((provider) => provider.id === draft.id)}
            testing={snapshot.connectionStatus === 'testing'}
            connection={snapshot.connection?.providerId === draft.id ? snapshot.connection : null}
            onChange={(patch) => updateDraft(index, patch)}
            onTestConnection={() => void testConnection(draft.id)}
          />
        </section>
      ))}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          className="rounded-xl"
          data-codex-providers-save
          disabled={busy || reading === null}
          onClick={() => void save()}
        >
          {snapshot.status === 'saving'
            ? <Loader2 className="h-4 w-4 animate-spin" />
            : <Save className="h-4 w-4" />}
          Save providers
        </Button>
        <Button
          type="button"
          variant="outline"
          className="rounded-xl"
          data-codex-providers-reload
          disabled={busy}
          onClick={() => void load()}
        >
          Reload
        </Button>
      </div>

      {snapshot.error?.kind === 'conflict' && (
        <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Another editor changed the Codex provider settings first. Your rows are kept — reload
          to see the saved file, then save again.
        </p>
      )}
      {snapshot.error?.kind === 'save' && (
        <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          Could not save the Codex providers: {snapshot.error.message}
        </p>
      )}
      {snapshot.connectionError !== null && (
        <p
          role="alert"
          data-testid="codex-connection-error"
          className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
        >
          Could not run the connection test: {snapshot.connectionError}
        </p>
      )}

      <ModelsContent
        agent={agent}
        codexProviders={providers}
        bindCodexProviderRequest={bindRequest ?? undefined}
      />
    </div>
  );
}
