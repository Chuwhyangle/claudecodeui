/**
 * The OAuth consent screen, rendered inside the application shell.
 *
 * This replaces the unstyled server-rendered form `GET /oauth/authorize` used to
 * answer with: the server now validates the request and `302`s the browser here
 * (`/oauth/consent?<original query>`), and this page drives the decision instead.
 * It uses the app's theme tokens and shared UI so the authorization step looks
 * like the product rather than a bare HTML page, and it is mobile-first because
 * the clients that ask for authorization (ChatGPT, Gemini) are usually approved
 * on a phone.
 *
 * The delivery is deliberately explicit and low-authority: a client's name and
 * callback host are shown as DATA (never interpolated as markup), the pinned
 * read scope is checked and disabled, and every write scope starts unchecked
 * behind a risk warning, so a decision is always something the user opted into.
 *
 * An Allow carries one confirmation more (AC-261): the signed-in user re-enters
 * their password, exactly as the server-rendered form used to ask, so holding a
 * session JWT is not by itself enough to authorize a third-party client. The
 * server rate-limits that submission per source; a refusal (wrong password, or a
 * rate-limited source) is shown in place with the decision still on screen, so
 * the user can correct the password or come back later instead of losing the
 * request.
 *
 * Consumers: the `/oauth/consent` route in `src/App.tsx`.
 */

import { AlertTriangle, ArrowRight, Loader2, RotateCw, ShieldAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';

import { Button, Input } from '@/shared/ui';
import { useAuth } from '@/modules/auth';
import { useOAuthConsent } from '@/modules/oauth-consent/hooks/useOAuthConsent';
import type { OAuthConsentError } from '@/modules/oauth-consent/hooks/useOAuthConsent';
import type { OAuthConsentScopeOption } from '@/shared/types';

/**
 * The i18n leaf each scope id labels, mirroring the server's scope vocabulary.
 *
 * The server decides which scopes exist and what they mean; this table only
 * gives the consent namespace a per-locale address for the same ids, so the page
 * has no untranslated text. A scope the table does not know (a vocabulary the
 * server grew ahead of this page) falls back to the server's own description
 * rather than disappearing.
 */
const SCOPE_MESSAGE_KEYS: Record<string, string> = {
  'cloudcli:read': 'scopes.read',
  'cloudcli:session:send': 'scopes.sessionSend',
  'cloudcli:session:create': 'scopes.sessionCreate',
  'cloudcli:session:control': 'scopes.sessionControl',
  'cloudcli:approve': 'scopes.approve',
  'cloudcli:navigate': 'scopes.navigate',
};

/** The i18n key for a failed load or decision; the page shows one readable line per cause. */
const ERROR_MESSAGE_KEYS: Record<OAuthConsentError['kind'], string> = {
  'missing-request': 'errors.missingRequest',
  'invalid-request': 'errors.invalidRequest',
  unauthorized: 'errors.unauthorized',
  network: 'errors.network',
  'invalid-credentials': 'errors.invalidCredentials',
  'rate-limited': 'errors.rateLimited',
};

/**
 * One scope row. The pinned read scope is checked and disabled; a write scope is
 * an ordinary tick the user can add or remove.
 */
function ScopeRow({
  option,
  label,
  checked,
  onToggle,
}: {
  option: OAuthConsentScopeOption;
  label: string;
  checked: boolean;
  onToggle: (checked: boolean) => void;
}) {
  return (
    <label
      data-testid="consent-scope"
      data-scope={option.scope}
      data-writable={option.writable}
      className="flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border border-border/60 p-3 text-sm text-foreground has-[:disabled]:cursor-default"
    >
      <input
        type="checkbox"
        data-testid="consent-scope-checkbox"
        className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-input"
        checked={checked}
        disabled={option.required}
        onChange={(event) => onToggle(event.target.checked)}
      />
      <span className="min-w-0 break-words">{label}</span>
    </label>
  );
}

/**
 * The card a full-page state (loading, refusal, failure) is wrapped in, so every face shares one shell.
 *
 * The root is the page's OWN scroll container: the app clips the document (`html, body { overflow:
 * hidden }` in `src/index.css`, which the workspace shell depends on), so a page whose content is
 * taller than the viewport must scroll inside itself or the user cannot reach the bottom of it. The
 * shell previously used `min-h-screen`, which grows with its content and therefore never scrolls —
 * a phone or laptop window shorter than the card left the Allow/Deny row below the fold, reachable
 * by keyboard (which scrolls programmatically) but not by a wheel or a touch drag. `h-dvh` fixes the
 * shell to the current dynamic viewport height (not `vh`, which a mobile browser's collapsing
 * address bar reports too large) and `overflow-y-auto` makes the wheel and touch drags move it.
 *
 * `main` keeps `min-h-full` rather than `min-h-screen`: it fills the shell when the content is short
 * (so the card stays centred) and no longer stretches `body` height, which is the other half of why
 * the page never scrolled.
 *
 * `data-testid="consent-scroll"` names this scroller so the e2e criterion can read its position.
 */
function ConsentShell({ children }: { children: React.ReactNode }) {
  return (
    <div data-testid="consent-scroll" className="relative h-dvh overflow-y-auto overflow-x-hidden bg-background">
      <div aria-hidden className="pointer-events-none fixed inset-0">
        <div className="absolute -top-40 left-1/2 h-[32rem] w-[32rem] -translate-x-1/2 rounded-full bg-primary/10 blur-3xl" />
        <div className="absolute inset-0 bg-[radial-gradient(hsl(var(--foreground)/0.04)_1px,transparent_1px)] opacity-60 [background-size:22px_22px]" />
      </div>
      <main className="relative mx-auto flex min-h-full w-full max-w-md flex-col justify-center p-4 py-8">
        <div className="w-full min-w-0 rounded-2xl border border-border/70 bg-card/90 p-6 shadow-[0_24px_60px_-20px_hsl(var(--foreground)/0.18)] ring-1 ring-foreground/5 backdrop-blur-xl sm:p-8">
          {children}
        </div>
      </main>
    </div>
  );
}

/** Rendered by App's `/oauth/consent` route; drives one authorization decision. */
export default function OAuthConsentRoute() {
  const { t } = useTranslation('consent');
  const { user } = useAuth();
  const search = useLocation().search;
  const {
    phase,
    context,
    selectedScopes,
    hasWriteSelection,
    password,
    setPassword,
    submitError,
    error,
    toggleScope,
    decide,
    retry,
  } = useOAuthConsent(search);

  if (phase === 'loading') {
    return (
      <ConsentShell>
        <div data-testid="consent-loading" className="flex flex-col items-center gap-3 py-6 text-muted-foreground">
          <Loader2 className="h-6 w-6 animate-spin" />
          <p className="text-sm">{t('loading')}</p>
        </div>
      </ConsentShell>
    );
  }

  // No context means no decision can be rendered — and, critically, no Allow
  // button: a request that failed validation must not be approvable by accident.
  if (phase === 'error' || phase === 'unauthorized' || !context) {
    const kind = error?.kind ?? 'network';
    return (
      <ConsentShell>
        <div data-testid="consent-error" className="flex flex-col items-center gap-3 text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
            <ShieldAlert className="h-6 w-6" />
          </div>
          <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground">
            {t('errorTitle')}
          </h1>
          <p data-testid="consent-error-message" className="text-sm leading-relaxed text-muted-foreground">
            {t(ERROR_MESSAGE_KEYS[kind])}
          </p>
          {/* Only a transport failure is worth retrying; a refused request will be refused again. */}
          {kind === 'network' && (
            <Button data-testid="consent-retry" variant="outline" onClick={retry}>
              <RotateCw className="mr-1.5 h-4 w-4" />
              {t('retry')}
            </Button>
          )}
        </div>
      </ConsentShell>
    );
  }

  const submitting = phase === 'submitting';

  return (
    <ConsentShell>
      <div className="flex flex-col items-center text-center">
        <div className="mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-gradient-to-br from-primary to-primary/80 shadow-lg shadow-primary/25 ring-1 ring-inset ring-white/20">
          <img src="/logo.svg" alt="CloudCLI" className="h-8 w-8" />
        </div>
        <h1 className="font-serif text-2xl font-bold tracking-tight text-foreground">
          {t('title')}
        </h1>
        <p data-testid="consent-client-name" className="mt-2 min-w-0 max-w-full break-words text-lg font-semibold text-foreground">
          {context.clientName || t('unknownClient')}
        </p>
        <p className="mt-1 text-sm text-muted-foreground">{t('wantsAccess')}</p>
      </div>

      {/* The anti-phishing line: the callback host is the single fact that tells a
          user where their authorization code is about to be sent, so it is shown
          as a distinct, emphasized callout rather than buried in body text. */}
      <div
        data-testid="consent-callback"
        className="mt-5 flex min-w-0 items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 text-left"
      >
        <ArrowRight className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-600 dark:text-amber-500" />
        <p className="min-w-0 break-words text-sm text-amber-700 dark:text-amber-400">
          {t('callbackWarning')}{' '}
          <span data-testid="consent-callback-host" className="font-semibold">
            {context.callbackHost}
          </span>
        </p>
      </div>

      <p data-testid="consent-identity" className="mt-4 text-sm text-muted-foreground">
        {t('signingInAs', { username: user?.username ?? '' })}
      </p>

      <fieldset className="mt-5" disabled={submitting}>
        <legend className="mb-2 text-sm font-medium text-foreground">{t('scopesLabel')}</legend>
        <div className="space-y-2">
          {context.scopes.map((option) => (
            <ScopeRow
              key={option.scope}
              option={option}
              label={t(SCOPE_MESSAGE_KEYS[option.scope] ?? 'scopes.other', { defaultValue: option.description })}
              checked={selectedScopes.includes(option.scope)}
              onToggle={(checked) => toggleScope(option.scope, checked)}
            />
          ))}
        </div>
      </fieldset>

      {hasWriteSelection && (
        <p
          data-testid="consent-write-warning"
          className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{t('writeWarning')}</span>
        </p>
      )}

      <p data-testid="consent-revoke-hint" className="mt-4 text-xs leading-relaxed text-muted-foreground">
        {t('revokeHint')}
      </p>

      {/* The confirmation step: an Allow asks for the password again, so a
          session token alone can no longer hand a third-party client access. */}
      <div className="mt-5 text-left">
        <label htmlFor="consent-password" className="text-sm font-medium text-foreground">
          {t('passwordLabel')}
        </label>
        <Input
          id="consent-password"
          data-testid="consent-password"
          type="password"
          autoComplete="current-password"
          className="mt-2"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          disabled={submitting}
          aria-describedby="consent-password-hint"
        />
        <p id="consent-password-hint" className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
          {t('passwordHint')}
        </p>
      </div>

      {submitError && (
        <p
          data-testid="consent-submit-error"
          className="mt-3 flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-left text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
          <span>{t(ERROR_MESSAGE_KEYS[submitError.kind])}</span>
        </p>
      )}

      <div className="mt-5 flex flex-col gap-2 sm:flex-row">
        <Button
          data-testid="consent-allow"
          className="w-full sm:flex-1"
          disabled={submitting || password.length === 0}
          onClick={() => decide('allow')}
        >
          {submitting && <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />}
          {submitting ? t('submitting') : t('allow')}
        </Button>
        <Button
          data-testid="consent-deny"
          variant="outline"
          className="w-full sm:flex-1"
          disabled={submitting}
          onClick={() => decide('deny')}
        >
          {t('deny')}
        </Button>
      </div>
    </ConsentShell>
  );
}
