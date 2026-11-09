import type { LLMProvider } from '@/shared/types';
import ClaudeLogo from '@/shared/ui/logos/ClaudeLogo';
import { resolveProviderLogo } from '@/shared/ui/logos/providerLogos';

type LLMProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

/**
 * The debug agent's mark: a beaker, drawn here rather than in a file of its own.
 *
 * A debug session must be visually distinguishable from a Claude one. The
 * fall-through below renders Claude's mark for anything it does not recognise,
 * so a provider whose id the union deliberately does not carry (ADR-003 decision
 * 2) would otherwise be shown as Claude — a wrong label rather than a missing
 * one, and one no reader can detect. `src/shared/ui` may not import from
 * `src/modules`, so the mark lives beside the branch that uses it.
 */
function DebugAgentLogo({ className }: { className: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      role="img"
      aria-label="Debug Agent"
    >
      <path d="M9 3h6" />
      <path d="M10 3v5.2L4.9 17.4A2 2 0 0 0 6.7 20.4h10.6a2 2 0 0 0 1.8-3L14 8.2V3" />
      <path d="M7.5 14h9" />
      <circle cx="10.5" cy="17" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="13.8" cy="16.2" r="0.7" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Used by the chat, onboarding, project-workspace, settings and sidebar modules to show which coding agent a session or project belongs to. */
export function LLMProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: LLMProviderLogoProps) {
  const Logo = resolveProviderLogo(provider);
  if (Logo) {
    return <Logo className={className} />;
  }

  if (provider === 'debug') {
    return <DebugAgentLogo className={className} />;
  }

  return <ClaudeLogo className={className} />;
}
