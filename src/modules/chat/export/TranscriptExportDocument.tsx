import { I18nextProvider } from 'react-i18next';

import { i18n } from '@/modules/i18n';
import type { ChatMessage, DiffLine, LLMProvider, Project } from '@/shared/types';
import {
  TranscriptRenderContext,
  useIsExportingTranscript,
} from '@/modules/chat/context/TranscriptRenderContext';
import MessageComponent from '@/modules/chat/transcript/MessageComponent';
import WorkSegmentRecord from '@/modules/chat/transcript/WorkSegmentRecord';
import { getIntrinsicMessageKey } from '@/modules/chat/utils/transcript/messageKeys';
import { groupWorkSegments, isWorkSegment } from '@/modules/chat/utils/transcript/workSegments';

type TranscriptExportDocumentProps = {
  messages: ChatMessage[];
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  provider: LLMProvider | string;
  selectedProject?: Project | null;
};

type ExportRowProps = {
  message: ChatMessage;
  prevMessage: ChatMessage | null;
  createDiff: (oldStr: string, newStr: string) => DiffLine[];
  provider: LLMProvider | string;
  selectedProject?: Project | null;
};

/**
 * One exported transcript row: the real `MessageComponent` under the row's own
 * intrinsic key.
 *
 * The key is published as `data-message-key` on a wrapper rather than on
 * `MessageComponent` because the exported document has to be addressable by
 * row: a reader — or a criterion — has to be able to read the set of rows back
 * out of the HTML string, and the message component's own attributes (`type`,
 * timestamp) are not the identity the transcript keys rows by. The wrapper is
 * applied to every row the selector emits, so a row that went missing from the
 * export, or a header that invented a key, shows up as a set difference.
 *
 * Not exported: it is the export document's own drawing of a row.
 */
function ExportRow({ message, prevMessage, createDiff, provider, selectedProject }: ExportRowProps) {
  return (
    <div data-message-key={getIntrinsicMessageKey(message) ?? undefined}>
      <MessageComponent
        message={message}
        prevMessage={prevMessage}
        createDiff={createDiff}
        showRawParameters={false}
        showThinking
        selectedProject={selectedProject}
        provider={provider}
      />
    </div>
  );
}

/**
 * The transcript body, drawn from the work-segment selector rather than the old
 * same-name tool folder.
 *
 * Rendered inside `TranscriptRenderContext` so it reads the shared export flag
 * exactly as every other collapsible in the tree does. A run of adjacent
 * thinking / tool-call / subagent rows is one `WorkSegmentRecord` whose members
 * are drawn through `renderMember`; a row no segment absorbed is drawn as
 * itself. Either way each row's `MessageComponent` is reached exactly once, so
 * the export keeps every row the input had — which is the point: the selector
 * only regroups, it never folds same-name calls into an `xN` layer.
 *
 * Not exported: it is the export document's own body.
 */
function TranscriptExportRows({ messages, createDiff, provider, selectedProject }: TranscriptExportDocumentProps) {
  // An export is one static render with no chevron to click, so a segment that
  // stayed collapsed would withhold its members from the file entirely. Reading
  // the shared flag — the same one `Reasoning`, `ToolGroupContainer` and
  // `SubagentPanel` force themselves open with — keeps the forced-open decision
  // in one place, and leaves no "collapsed segment in an export" branch to drift.
  const isExporting = useIsExportingTranscript();
  const items = groupWorkSegments(messages);
  let previousMessage: ChatMessage | null = null;

  return (
    <div className="chat-export-transcript">
      {items.map((item, index) => {
        if (isWorkSegment(item)) {
          const segmentPreviousMessage = previousMessage;
          previousMessage = item.messages[item.messages.length - 1] ?? previousMessage;

          return (
            <WorkSegmentRecord
              key={item.key ?? `segment-${index}`}
              segment={item}
              expanded={isExporting}
              renderMember={(message, memberIndex) => (
                <ExportRow
                  message={message}
                  prevMessage={memberIndex > 0 ? item.messages[memberIndex - 1] : segmentPreviousMessage}
                  createDiff={createDiff}
                  provider={provider}
                  selectedProject={selectedProject}
                />
              )}
            />
          );
        }

        const messagePreviousMessage = previousMessage;
        previousMessage = item;

        return (
          <ExportRow
            key={getIntrinsicMessageKey(item) ?? `message-${index}`}
            message={item}
            prevMessage={messagePreviousMessage}
            createDiff={createDiff}
            provider={provider}
            selectedProject={selectedProject}
          />
        );
      })}
    </div>
  );
}

/**
 * The transcript, rendered for a document instead of a screen.
 *
 * It deliberately mounts the same `MessageComponent` / `WorkSegmentRecord` tree
 * the chat pane uses. Every previous export was a second formatter that only
 * knew about `msg.type`, which is why tool calls — the bulk of an agent
 * transcript — came out as empty sections. Rendering the real components means
 * the export cannot fall behind the UI: a new tool renderer appears in it for
 * free.
 *
 * Rendered by `buildTranscriptHtml` through `renderToStaticMarkup`, so there
 * are no effects and no interactivity — anything the components hide behind
 * open state is force-shown via `TranscriptRenderContext`.
 */
export function TranscriptExportDocument({
  messages,
  createDiff,
  provider,
  selectedProject,
}: TranscriptExportDocumentProps) {
  return (
    <I18nextProvider i18n={i18n}>
      <TranscriptRenderContext.Provider value={{ isExporting: true }}>
        <TranscriptExportRows
          messages={messages}
          createDiff={createDiff}
          provider={provider}
          selectedProject={selectedProject}
        />
      </TranscriptRenderContext.Provider>
    </I18nextProvider>
  );
}
