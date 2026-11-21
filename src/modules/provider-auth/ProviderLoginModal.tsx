import { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';

import { PROVIDER_DESCRIPTORS } from '@/shared/constants';
import { IS_PLATFORM } from '@/shared/utils';
import type { LLMProvider } from '@/shared/types';

/**
 * The embedded terminal is the code-editor-sized part of this module: xterm and
 * its addons are only fetched when someone actually opens a provider login
 * modal. The modal is opened from onboarding or the settings page, neither of
 * which should pay for that graph on first paint.
 */
const LazyStandaloneShell = lazy(() =>
  import('@/modules/standalone-shell').then((module) => ({ default: module.StandaloneShell })),
);

/**
 * For empty shell instances where no project is provided,
 * we use a default project object to ensure the shell can still function.
 * This prevents errors related to missing project data.
 *
 * `projectId` is set to a well-known sentinel ('default') because the empty
 * shell doesn't correspond to any real project row in the database; any API
 * call that routes through this placeholder must tolerate a missing match.
 */
const DEFAULT_PROJECT_FOR_EMPTY_SHELL = {
  projectId: 'default',
  displayName: 'default',
  fullPath: IS_PLATFORM ? '/workspace' : '',
  path: IS_PLATFORM ? '/workspace' : '',
};

type ProviderLoginModalProps = {
  isOpen: boolean;
  onClose: () => void;
  provider?: LLMProvider;
  onComplete?: (exitCode: number) => void;
  customCommand?: string;
  isAuthenticated?: boolean;
};

const getProviderCommand = ({
  provider,
  customCommand,
  isAuthenticated: _isAuthenticated,
}: {
  provider: LLMProvider;
  customCommand?: string;
  isAuthenticated: boolean;
}) => {
  if (customCommand) {
    return customCommand;
  }

  const descriptor = PROVIDER_DESCRIPTORS[provider];
  return IS_PLATFORM
    ? descriptor.platformLoginCommand ?? descriptor.loginCommand
    : descriptor.loginCommand;
};

const getProviderTitle = (provider: LLMProvider) => PROVIDER_DESCRIPTORS[provider].loginTitle;

/** Used by the onboarding and settings modules to run a provider's CLI login command in an embedded shell. */
export default function ProviderLoginModal({
  isOpen,
  onClose,
  provider = 'claude',
  onComplete,
  customCommand,
  isAuthenticated = false,
}: ProviderLoginModalProps) {
  const { t } = useTranslation();
  if (!isOpen) {
    return null;
  }

  const command = getProviderCommand({ provider, customCommand, isAuthenticated });
  const title = getProviderTitle(provider);

  const handleComplete = (exitCode: number) => {
    onComplete?.(exitCode);
    // Keep the modal open so users can read terminal output before closing.
  };

  return (
    <div
      data-escape-layer
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-50 max-md:items-stretch max-md:justify-stretch"
    >
      <div className="flex h-3/4 w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl dark:bg-gray-800 max-md:m-0 max-md:h-full max-md:max-w-none max-md:rounded-none md:m-4 md:h-3/4 md:max-w-4xl md:rounded-lg">
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
            aria-label={t('common:misc.closeLoginModal')}
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden">
          <Suspense fallback={null}>
            <LazyStandaloneShell project={DEFAULT_PROJECT_FOR_EMPTY_SHELL} command={command} onComplete={handleComplete} minimal={true} />
          </Suspense>
        </div>
      </div>
    </div>
  );
}
