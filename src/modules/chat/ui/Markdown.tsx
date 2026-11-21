import React, { createContext, lazy, memo, Suspense, useContext, useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import { oneDark, oneLight } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { useTranslation } from 'react-i18next';
import type remarkMath from 'remark-math';
import type rehypeKatex from 'rehype-katex';

import { usePaletteOps } from '@/modules/command-palette';
import { MarkdownImage } from '@/modules/chat/ui/MarkdownImage';
import {
  buildSyntaxTheme,
  matchReplyItem,
  normalizeInlineCodeFences,
} from '@/modules/chat-transcript';
import { copyTextToClipboard } from '@/shared/utils';
import type { PrismStyleSheet, ReplyItem, ReplyItemRenderContext } from '@/modules/chat-transcript';

/**
 * Two heavy renderers stay out of this module's static import graph and are
 * fetched the first time the element they serve actually appears:
 *
 * - the Prism highlighter (~50 grammars + refractor) is only needed once a
 *   fenced code block renders, and a plain `<pre>` is a correct first paint;
 * - the mermaid diagram wrapper (and, through its own dynamic import, the
 *   mermaid library) is only fetched for a ```mermaid fence;
 * - `remark-math` + `rehype-katex` (KaTeX is ~600 KB of source) only run when
 *   the text carries one of the delimiters they act on — which the `hasMath`
 *   gate below already detects before this module would have used them.
 *
 * The caches are module-level or closure-owned so a transcript with many blocks
 * resolves once.
 */
const LazySyntaxHighlighter = lazy(() =>
  import('@/shared/syntaxHighlighter').then((module) => ({ default: module.SyntaxHighlighter })),
);
const LazyMermaidDiagram = lazy(() =>
  import('@/modules/code-editor').then((module) => ({ default: module.MermaidDiagram })),
);

type MathPluginSet = {
  remarkMath: typeof remarkMath;
  rehypeKatex: typeof rehypeKatex;
};

/**
 * One in-flight module promise, owned by this closure rather than by a
 * module-level binding (the architecture ratchet forbids module-scope `let`).
 */
const loadMathPlugins = (() => {
  let pending: Promise<MathPluginSet> | null = null;
  return (): Promise<MathPluginSet> => {
    pending ??= Promise.all([import('remark-math'), import('rehype-katex')]).then(
      ([math, katex]) => ({ remarkMath: math.default, rehypeKatex: katex.default }),
    );
    return pending;
  };
})();

/** Resolves the KaTeX plugins only for content that actually contains math. */
function useMathPlugins(enabled: boolean): MathPluginSet | null {
  const [plugins, setPlugins] = useState<MathPluginSet | null>(null);
  useEffect(() => {
    if (!enabled) {
      return undefined;
    }
    let cancelled = false;
    void loadMathPlugins().then((loaded) => {
      if (!cancelled) {
        setPlugins(loaded);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [enabled]);
  return enabled ? plugins : null;
}

/** The plain-text code block shown while the highlighter chunk is in flight. */
function PlainCodeBlock({ raw }: { raw: string }) {
  return (
    <pre className="m-0 overflow-x-auto px-4 pb-4 pt-2 font-mono text-[0.8125rem] leading-[1.6]">
      <code>{raw}</code>
    </pre>
  );
}

type MarkdownProps = {
  children: React.ReactNode;
  className?: string;
  /** Render single newlines as hard line breaks (for user-typed messages). */
  breaks?: boolean;
  /**
   * When set, the blocks that became addressable items publish their address,
   * label and highlight state on the DOM — see `replyItems.ts`. Only the latest
   * assistant reply receives this, so older replies stay plain prose.
   */
  replyItems?: ReplyItemRenderContext;
};

// Links to the wider web (or in-page anchors) keep normal browser navigation;
// everything else is treated as a workspace file reference.
const isExternalHref = (href?: string): boolean =>
  !!href && (/^(https?:|mailto:|tel:|data:)/i.test(href) || href.startsWith('#'));

// Read the trailing `:line` / `:line:col` suffix so the editor can reveal it.
// Both this and stripLineSuffix are anchored at the end, so callers pass an
// already-trimmed reference.
const lineFromRef = (value: string): number | null => {
  const match = value.match(/:(\d+)(?::\d+)?$/);
  return match ? Number(match[1]) : null;
};

// Strip a trailing `:line` / `:line:col` suffix (e.g. `src/foo.ts:130`).
const stripLineSuffix = (value: string): string => value.replace(/:\d+(?::\d+)?$/, '');

// A usable file path contains a separator or a filename with an extension.
const looksLikeFilePath = (value?: string): value is string => {
  if (!value) {
    return false;
  }
  const cleaned = stripLineSuffix(value.trim());
  if (!cleaned || cleaned === '#') {
    return false;
  }
  return /[\\/]/.test(cleaned) || /\.[a-z0-9]+$/i.test(cleaned);
};

// Extract plain text from link children so a reference rendered only as link
// text (e.g. `[src/foo.ts]()` with an empty href) can still be opened.
const childrenToText = (children: React.ReactNode): string => {
  if (typeof children === 'string' || typeof children === 'number') {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map(childrenToText).join('');
  }
  if (React.isValidElement(children)) {
    return childrenToText((children.props as { children?: React.ReactNode }).children);
  }
  return '';
};

// The delimiters `remark-math` recognizes with `singleDollarTextMath` off.
const MATH_DELIMITER = /\$\$|\\\(|\\\[/;

const EMPTY_PLUGINS: never[] = [];

type CodeBlockProps = {
  node?: any;
  className?: string;
  children?: React.ReactNode;
  /** Set by the custom `pre` renderer: this code element is a fenced/indented block. */
  forceBlock?: boolean;
};

// `node` is destructured out so react-markdown's hast node never reaches the DOM.
const CodeBlock = ({ node: _node, className, children, forceBlock, ...props }: CodeBlockProps) => {
  const { t } = useTranslation('chat');
  const [copied, setCopied] = useState(false);
  // Fenced blocks carry a trailing newline in the tree; trim it so the
  // highlighter doesn't render an empty final line.
  const raw = (Array.isArray(children) ? children.join('') : String(children ?? '')).replace(/\n$/, '');
  // react-markdown v9+ dropped the `inline` prop: block code is whatever the
  // `pre` renderer hands us (forceBlock). Multiline is kept as a safety net.
  const shouldInline = !forceBlock && !/[\r\n]/.test(raw);

  if (shouldInline) {
    return (
      <code
        className={`whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted px-1.5 py-0.5 font-mono text-[0.875em] text-foreground ${className || ''
          }`}
        {...props}
      >
        {children}
      </code>
    );
  }

  const match = /language-(\w+)/.exec(className || '');
  const language = match ? match[1] : 'text';
  const languageLabel = language.charAt(0).toUpperCase() + language.slice(1);

  if (language === 'mermaid') {
    return (
      <Suspense fallback={<PlainCodeBlock raw={raw} />}>
        <LazyMermaidDiagram code={raw} />
      </Suspense>
    );
  }

  return (
    <div className="group my-3 overflow-hidden rounded-xl border border-border bg-muted/50 shadow-sm dark:bg-zinc-900">
      {/* Label row shares the block's background — no divider, ChatGPT-style */}
      <div className="flex items-center justify-between px-4 pt-2">
        <span className="select-none text-xs text-muted-foreground">{languageLabel}</span>
        <button
          type="button"
          onClick={() =>
            copyTextToClipboard(raw).then((success) => {
              if (success) {
                setCopied(true);
                setTimeout(() => setCopied(false), 2000);
              }
            })
          }
          className={`rounded-md p-1 transition-opacity focus-visible:opacity-100 ${copied
            ? 'text-green-600 opacity-100 dark:text-green-500'
            : 'text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100'
            }`}
          title={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
          aria-label={copied ? t('codeBlock.copied') : t('codeBlock.copyCode')}
        >
          {copied ? (
            <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path
                fillRule="evenodd"
                d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                clipRule="evenodd"
              />
            </svg>
          ) : (
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path>
            </svg>
          )}
        </button>
      </div>

      <Suspense fallback={<PlainCodeBlock raw={raw} />}>
        <LazySyntaxHighlighter
          language={language}
          style={syntaxTheme.style}
          customStyle={{
            margin: 0,
            borderRadius: 0,
            fontSize: '0.8125rem',
            lineHeight: 1.6,
            padding: '0.5rem 1rem 1rem',
            // The container owns the background so the label row and code read as one panel.
            background: 'transparent',
          }}
          codeTagProps={{
            style: {
              fontFamily:
                'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
              background: 'transparent',
            },
          }}
        >
          {raw}
        </LazySyntaxHighlighter>
      </Suspense>
    </div>
  );
};

/**
 * One style object for both themes: switching between the two Prism objects
 * re-tokenized every mounted code block, so the theme-dependent values are CSS
 * variables and the toggle is a style recalculation instead.
 */
const syntaxTheme = buildSyntaxTheme(oneLight as PrismStyleSheet, oneDark as PrismStyleSheet);

/**
 * The low-key ① label drawn to the left of a labelled item, and the wash the
 * highlight arm adds. Drawn through `::before` on the item's own element (from
 * `data-reply-item-label`) rather than as a real text node: the label is a
 * reading aid, and a real span would become part of the row's text for every
 * reader of `textContent` — the export, the search index and a scenario's
 * text reading included.
 */
const REPLY_ITEM_LABEL_CLASS =
  'before:mr-1.5 before:select-none before:text-[0.75em] before:text-muted-foreground before:content-[attr(data-reply-item-label)] data-[reply-item-highlighted=true]:rounded-sm data-[reply-item-highlighted=true]:bg-primary/10';

// The `:root`/`.dark` declarations backing syntaxTheme.style. Injected once
// because the values are derived from the Prism theme objects at runtime and so
// cannot live in index.css. ThemeContext toggles `.dark` on <html>, which is
// what repaints the tokens.
const SYNTAX_THEME_STYLE_ELEMENT_ID = 'cc-syntax-theme';
if (!document.getElementById(SYNTAX_THEME_STYLE_ELEMENT_ID)) {
  const styleElement = document.createElement('style');
  styleElement.id = SYNTAX_THEME_STYLE_ELEMENT_ID;
  styleElement.textContent = syntaxTheme.css;
  document.head.appendChild(styleElement);
}

const markdownComponents = {
  code: CodeBlock,
  // Workspace image paths are fetched through the authenticated files route;
  // a bare <img src> would resolve against the web origin and 404.
  img: MarkdownImage,
  // Fenced/indented code arrives as <pre><code>. Re-render the child CodeBlock
  // with `forceBlock` so it always gets the block treatment (react-markdown v9+
  // no longer passes an `inline` flag), and skip the outer <pre> so Tailwind
  // Typography doesn't wrap the highlighter in a second dark shell.
  pre: ({ children }: { children?: React.ReactNode }) => {
    const child = Array.isArray(children) ? children.find(React.isValidElement) : children;
    if (React.isValidElement(child) && child.type === CodeBlock) {
      return <CodeBlock {...(child.props as CodeBlockProps)} forceBlock />;
    }
    return <>{children}</>;
  },
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-3 border-l-2 border-primary/50 pl-4 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="my-4 border-t border-border" />,
  p: ({ children }: { children?: React.ReactNode }) => <div className="mb-2 last:mb-0">{children}</div>,
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="mb-2 list-outside list-disc space-y-1 pl-5 marker:text-current last:mb-0">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="mb-2 list-outside list-decimal space-y-1 pl-5 marker:text-current last:mb-0">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => <li className="[&>div:last-child]:mb-0 [&>div]:mb-1">{children}</li>,
  table: ({ children }: { children?: React.ReactNode }) => (
    <div className="my-3 overflow-x-auto rounded-lg border border-border">
      {/* my-0 cancels Tailwind Typography's table margin, which would show as blank bands inside the border */}
      <table className="my-0 min-w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }: { children?: React.ReactNode }) => <thead className="bg-muted/60">{children}</thead>,
  tr: ({ children }: { children?: React.ReactNode }) => (
    <tr className="[&:last-child>td]:border-b-0">{children}</tr>
  ),
  th: ({ children }: { children?: React.ReactNode }) => (
    <th className="border-b border-border px-3 py-2 text-left font-semibold text-foreground">{children}</th>
  ),
  td: ({ children }: { children?: React.ReactNode }) => (
    <td className="border-b border-border/60 px-3 py-2 align-top">{children}</td>
  ),
};

/**
 * The reply-item labels for the message currently being rendered.
 *
 * The renderers that publish these labels must keep their identity across
 * renders: react-markdown treats every function in `components` as an element
 * type, so a new function identity at the same position makes React unmount and
 * rebuild that block. `replyItems` is rebuilt by the transcript on every render,
 * so it travels through this context (a value change re-renders the consumers)
 * instead of through `components`' identity — a rebuild would also destroy the
 * native text selection the transcript action is anchored to.
 */
const ReplyItemLabelContext = createContext<ReplyItemRenderContext | undefined>(undefined);

/** The DOM facts a labelled block publishes; absent for a block that is not an item. */
const replyItemAttributes = (
  item: ReplyItem | null,
  replyItems: ReplyItemRenderContext | undefined,
): Record<string, string> => {
  if (!item || !replyItems) {
    return {};
  }
  return {
    'data-reply-item-uri': replyItems.uriFor(item.ordinal),
    'data-reply-item-label': item.label,
    'data-reply-item-kind': item.kind,
    ...(replyItems.highlightedOrdinals.has(item.ordinal)
      ? { 'data-reply-item-highlighted': 'true' }
      : {}),
  };
};

const replyItemLabelledClass = (item: ReplyItem | null): string =>
  item ? ` ${REPLY_ITEM_LABEL_CLASS}` : '';

/** Labelled paragraph: a numbered bold paragraph is one of the reply's items. */
function ReplyItemParagraph({
  node,
  children,
  ...props
}: {
  node?: any;
  children?: React.ReactNode;
}) {
  const replyItems = useContext(ReplyItemLabelContext);
  // A numbered bold paragraph is exactly a paragraph whose first inline child is
  // the bold run; other paragraphs keep the plain renderer.
  const opensWithBold = node?.children?.[0]?.tagName === 'strong';
  const item = opensWithBold
    ? matchReplyItem(childrenToText(children), replyItems?.items ?? [], ['bold-paragraph'])
    : null;
  return (
    <div
      {...props}
      className={`mb-2 last:mb-0${replyItemLabelledClass(item)}`}
      {...replyItemAttributes(item, replyItems)}
    >
      {children}
    </div>
  );
}

/** Labelled list item: only a top-level item can be one of the reply's items. */
function ReplyItemListItem({
  node,
  children,
  ...props
}: {
  node?: any;
  children?: React.ReactNode;
}) {
  const replyItems = useContext(ReplyItemLabelContext);
  // A nested item is never one of the reply's top-level points, even when its
  // text happens to match. Markdown allows up to three spaces of top-level
  // indentation, so the column is what separates the two.
  const topLevel = !node?.position || node.position.start.column <= 3;
  const item = topLevel
    ? matchReplyItem(childrenToText(children), replyItems?.items ?? [], ['ordered', 'unordered'])
    : null;
  return (
    <li
      {...props}
      className={`[&>div:last-child]:mb-0 [&>div]:mb-1${replyItemLabelledClass(item)}`}
      {...replyItemAttributes(item, replyItems)}
    >
      {children}
    </li>
  );
}

/** Builds one heading renderer per tag at module load, so their identities are stable. */
const makeReplyItemHeading = (Tag: 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6') =>
  function ReplyItemHeading({
    node: _node,
    children,
    ...props
  }: {
    node?: any;
    children?: React.ReactNode;
    className?: string;
  }) {
    const replyItems = useContext(ReplyItemLabelContext);
    const item = matchReplyItem(childrenToText(children), replyItems?.items ?? [], ['heading']);
    return React.createElement(
      Tag,
      {
        ...props,
        className: `${props.className ?? ''}${replyItemLabelledClass(item)}`,
        ...replyItemAttributes(item, replyItems),
      },
      children,
    );
  };

const replyItemHeadings = {
  h1: makeReplyItemHeading('h1'),
  h2: makeReplyItemHeading('h2'),
  h3: makeReplyItemHeading('h3'),
  h4: makeReplyItemHeading('h4'),
  h5: makeReplyItemHeading('h5'),
  h6: makeReplyItemHeading('h6'),
};

/**
 * Used by chat's MessageComponent, ToolErrorDisplay and MarkdownContent to
 * render model-authored markdown with this module's shared prose styling,
 * code highlighting and table rules.
 */
function MarkdownBodyRenderer({ children, breaks = false, replyItems }: Omit<MarkdownProps, 'className'>) {
  const content = useMemo(
    () => normalizeInlineCodeFences(String(children ?? '')),
    [children],
  );
  // Math support costs a remark tree pass plus a full KaTeX walk on every
  // render, and almost no assistant message contains math. Only wire the two
  // plugins up when the text has a delimiter they could act on.
  const hasMath = useMemo(() => MATH_DELIMITER.test(content), [content]);
  const mathPlugins = useMathPlugins(hasMath);
  const remarkPlugins = useMemo(
    () => {
      const plugins: unknown[] = [remarkGfm];
      if (mathPlugins) {
        plugins.push([mathPlugins.remarkMath, { singleDollarTextMath: false }]);
      }
      if (breaks) {
        plugins.push(remarkBreaks);
      }
      return plugins as any;
    },
    [breaks, mathPlugins],
  );
  const rehypePlugins = useMemo(
    () => (mathPlugins ? [mathPlugins.rehypeKatex] : EMPTY_PLUGINS),
    [mathPlugins],
  );
  const { openFileInEditor, openDirectory } = usePaletteOps();
  // Presence, not identity: the memo below must not rebuild when the transcript
  // hands over a fresh `replyItems` object with the same shape.
  const hasReplyItems = replyItems !== undefined;

  const components = useMemo(() => {
    const base: Record<string, unknown> = {
      ...markdownComponents,
      a: ({ href, children: linkChildren }: { href?: string; children?: React.ReactNode }) => {
        // Prefer the href when it is a real path; otherwise fall back to the
        // link text, since models often emit `[src/foo.ts]()` with an empty href.
        const linkText = childrenToText(linkChildren);
        const fileRef = looksLikeFilePath(href) ? href : looksLikeFilePath(linkText) ? linkText : undefined;

        if (fileRef && !isExternalHref(href)) {
          return (
            <a
              href={href || fileRef}
              className="cursor-pointer text-blue-600 hover:underline dark:text-blue-400"
              onClick={(event) => {
                event.preventDefault();
                // Normalized once for every branch below: the href arrives
                // trimmed from the parser, but the link-text fallback keeps a
                // trailing space (``[`src/foo.ts:12` ]()``), and that space
                // defeats the `$`-anchored suffix strip.
                const reference = fileRef.trim();
                if (reference.endsWith('/')) {
                  openDirectory(reference);
                  return;
                }
                openFileInEditor(stripLineSuffix(reference), lineFromRef(reference));
              }}
            >
              {linkChildren}
            </a>
          );
        }

        return (
          <a
            href={href}
            className="text-blue-600 hover:underline dark:text-blue-400"
            target="_blank"
            rel="noopener noreferrer"
          >
            {linkChildren}
          </a>
        );
      },
    };

    if (!hasReplyItems) {
      return base;
    }

    // Element types stay module-level constants; the current message's items
    // reach them through ReplyItemLabelContext. Rebuilding these functions (as
    // the old `replyItems` dependency did) remounts every block they render,
    // dropping any live text selection inside the reply.
    return {
      ...base,
      p: ReplyItemParagraph,
      li: ReplyItemListItem,
      ...replyItemHeadings,
    };
  }, [openFileInEditor, openDirectory, hasReplyItems]);

  return (
    <ReplyItemLabelContext.Provider value={replyItems}>
      <ReactMarkdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} components={components as any}>
        {content}
      </ReactMarkdown>
    </ReplyItemLabelContext.Provider>
  );
}

/**
 * Markdown blocks without the prose wrapper. Used by StreamingMarkdown so a
 * streamed reply's settled and pending halves render as siblings inside ONE
 * prose container — Tailwind Typography's `> :first-child`/`> :last-child`
 * margin rules are per-container, so two containers would zero the gap at the
 * seam and make it pop back when the boundary moves.
 *
 * Memoized so a re-render does not re-run remark, rehype, KaTeX and Prism over
 * text that has not changed.
 */
export const MarkdownBody = memo(MarkdownBodyRenderer);

/** Markdown in its own prose container. The form every non-streaming caller uses. */
export const Markdown = memo(function Markdown({ children, className, breaks, replyItems }: MarkdownProps) {
  return (
    <div className={className}>
      <MarkdownBody breaks={breaks} replyItems={replyItems}>{children}</MarkdownBody>
    </div>
  );
});
