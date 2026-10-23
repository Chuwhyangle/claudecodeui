import { useCallback, useState } from 'react';
import type { Dispatch, MutableRefObject, RefObject, SetStateAction } from 'react';

import { api } from '@/shared/api';
import { escapeRegExp } from '@/modules/chat/utils/transcript/chatFormatting';
import { useSlashCommands } from '@/modules/chat/hooks/useSlashCommands';
import type {
  ChatMessage,
  CommandModalPayload,
  CostCommandData,
  HelpCommandData,
  ModelCommandData,
  Project,
  ProjectSession,
  LLMProvider,
  SlashCommand,
  StatusCommandData,
} from '@/shared/types';

/**
 * Slash commands in the composer: the suggestion menu that opens on a leading
 * `/`, the built-in command modals (help/models/cost/status), and the execution
 * path for both the server-registered built-ins and the project's own command
 * files.
 *
 * A custom command that runs in the transcript is submitted through the
 * composer's form a tick later, so the command text is painted before the send
 * path takes it; that submit is handed in rather than reached for, which is what
 * keeps the menu hook from depending on the send path.
 */

type CommandExecutionResult = {
  type: 'builtin' | 'custom';
  action?: string;
  data?: any;
  content?: string;
  hasBashCommands?: boolean;
  hasFileIncludes?: boolean;
};

type UseCommandMenuStateArgs = {
  selectedProject: Project | null;
  selectedSession: ProjectSession | null;
  currentSessionId: string | null;
  provider: LLMProvider;
  currentProviderModel: string;
  tokenBudget: Record<string, unknown> | null;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  /** The send-time mirror of the draft, written in the same tick as the state. */
  inputValueRef: MutableRefObject<string>;
  textareaRef: RefObject<HTMLTextAreaElement>;
  addMessage: (msg: ChatMessage) => string | null | void;
  onFileOpen?: (filePath: string, diffInfo?: unknown) => void;
  onShowSettings?: () => void;
  /** Runs the composer's submit path; used to fire a custom command's send. */
  submit: () => void;
};

export function useCommandMenuState({
  selectedProject,
  selectedSession,
  currentSessionId,
  provider,
  currentProviderModel,
  tokenBudget,
  input,
  setInput,
  inputValueRef,
  textareaRef,
  addMessage,
  onFileOpen,
  onShowSettings,
  submit,
}: UseCommandMenuStateArgs) {
  // The built-in command's answer, when it is a modal rather than transcript
  // rows. Null means no modal is open.
  const [commandModalPayload, setCommandModalPayload] = useState<CommandModalPayload | null>(null);

  const handleBuiltInCommand = useCallback(
    (result: CommandExecutionResult) => {
      const { action, data } = result;
      switch (action) {
        case 'help':
          setCommandModalPayload({
            kind: 'help',
            data: (data || {}) as HelpCommandData,
          });
          break;

        case 'models':
          setCommandModalPayload({
            kind: 'models',
            data: (data || {}) as ModelCommandData,
          });
          break;

        case 'cost': {
          setCommandModalPayload({
            kind: 'cost',
            data: (data || {}) as CostCommandData,
          });
          break;
        }

        case 'status': {
          setCommandModalPayload({
            kind: 'status',
            data: (data || {}) as StatusCommandData,
          });
          break;
        }

        case 'memory':
          if (data.error) {
            addMessage({
              type: 'assistant',
              content: `Warning: ${data.message}`,
              timestamp: Date.now(),
            });
          } else {
            addMessage({
              type: 'assistant',
              content: `${data.message}\n\nPath: \`${data.path}\``,
              timestamp: Date.now(),
            });
            if (data.exists && onFileOpen) {
              onFileOpen(data.path);
            }
          }
          break;

        case 'config':
          onShowSettings?.();
          break;

        default:
          console.warn('Unknown built-in command action:', action);
      }
    },
    [onFileOpen, onShowSettings, addMessage],
  );

  const closeCommandModal = useCallback(() => {
    setCommandModalPayload(null);
  }, []);

  const handleCustomCommand = useCallback(async (result: CommandExecutionResult) => {
    const { content, hasBashCommands } = result;

    if (hasBashCommands) {
      const confirmed = window.confirm(
        'This command contains bash commands that will be executed. Do you want to proceed?',
      );
      if (!confirmed) {
        addMessage({
          type: 'assistant',
          content: 'Command execution cancelled',
          timestamp: Date.now(),
        });
        return;
      }
    }

    const commandContent = content || '';
    setInput(commandContent);
    inputValueRef.current = commandContent;

    // Defer submit to next tick so the command text is reflected in UI before dispatching.
    setTimeout(() => {
      submit();
    }, 0);
  }, [addMessage, setInput, inputValueRef, submit]);

  const executeCommand = useCallback(
    async (command: SlashCommand, rawInput?: string, options?: { preserveInput?: boolean }) => {
      if (!command || !selectedProject) {
        return;
      }

      try {
        const effectiveInput = rawInput ?? input;
        const commandMatch = effectiveInput.match(new RegExp(`${escapeRegExp(command.name)}\\s*(.*)`));
        const args =
          commandMatch && commandMatch[1] ? commandMatch[1].trim().split(/\s+/) : [];

        // The `/api/commands/execute` context sends `projectId` now instead of
        // a folder-derived project name; the path is still included verbatim.
        const context = {
          projectPath: selectedProject.fullPath || selectedProject.path,
          projectId: selectedProject.projectId,
          sessionId: currentSessionId || selectedSession?.id || null,
          provider,
          model: currentProviderModel,
          tokenUsage: tokenBudget,
        };

        const response = await api.commands.execute({
          commandName: command.name,
          commandPath: command.path,
          args,
          context,
        });

        if (!response.ok) {
          let errorMessage = `Failed to execute command (${response.status})`;
          try {
            const errorData = await response.json();
            errorMessage = errorData?.message || errorData?.error || errorMessage;
          } catch {
            // Ignore JSON parse failures and use fallback message.
          }
          throw new Error(errorMessage);
        }

        const result = (await response.json()) as CommandExecutionResult;
        if (result.type === 'builtin') {
          handleBuiltInCommand(result);
          if (!options?.preserveInput) {
            setInput('');
            inputValueRef.current = '';
          }
        } else if (result.type === 'custom') {
          await handleCustomCommand(result);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        console.error('Error executing command:', error);
        addMessage({
          type: 'assistant',
          content: `Error executing command: ${message}`,
          timestamp: Date.now(),
        });
      }
    },
    [
      currentProviderModel,
      currentSessionId,
      handleBuiltInCommand,
      handleCustomCommand,
      input,
      provider,
      selectedProject,
      selectedSession?.id,
      addMessage,
      tokenBudget,
      setInput,
      inputValueRef,
    ],
  );

  const showCostModal = useCallback(() => {
    executeCommand(
      {
        name: '/cost',
        description: 'Display token usage information',
        namespace: 'builtin',
        metadata: { type: 'builtin' },
      } as SlashCommand,
      '/cost',
      { preserveInput: true },
    );
  }, [executeCommand]);

  const {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
  } = useSlashCommands({
    selectedProject,
    provider,
    input,
    setInput,
    textareaRef,
    onExecuteCommand: executeCommand,
  });

  return {
    slashCommands,
    slashCommandsCount,
    filteredCommands,
    frequentCommands,
    commandQuery,
    showCommandMenu,
    selectedCommandIndex,
    resetCommandMenuState,
    handleCommandSelect,
    handleToggleCommandMenu,
    handleCommandInputChange,
    handleCommandMenuKeyDown,
    commandModalPayload,
    closeCommandModal,
    showCostModal,
    executeCommand,
  };
}
