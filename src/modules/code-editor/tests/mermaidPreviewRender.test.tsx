import assert from 'node:assert/strict';

import { render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

// The preview branch never mounts the editor, and the source branch never
// mounts the diagram; both stand in as data-testid markers below.
vi.mock('@uiw/react-codemirror', () => ({
  default: () => <div data-testid="code-editor" />,
}));

// Stub the diagram so the test never lazy-loads mermaid (~1.5MB) in jsdom; the
// surface is only asserted to hand the raw source through to it.
vi.mock('@/modules/code-editor/markdown/MermaidDiagram', () => ({
  default: ({ code }: { code: string }) => <pre data-testid="mermaid-diagram">{code}</pre>,
}));

const { default: CodeEditorSurface } = await import('@/modules/code-editor/CodeEditorSurface');

const renderSurface = (content: string, mermaidPreview: boolean) =>
  render(
    <CodeEditorSurface
      content={content}
      onChange={() => undefined}
      markdownPreview={false}
      isMarkdownFile={false}
      mermaidPreview={mermaidPreview}
      isMermaidFile
      isDarkMode={false}
      fontSize={14}
      showLineNumbers
      extensions={[]}
      gotoTarget={null}
    />,
  );

test('a .mmd file with preview on renders the diagram from the raw source', () => {
  const source = 'flowchart TD\n  A --> B';
  renderSurface(source, true);
  assert.equal(screen.getByTestId('mermaid-diagram').textContent, source);
  assert.equal(screen.queryByTestId('code-editor'), null);
});

test('a .mmd file with preview off renders the editable source', () => {
  renderSurface('flowchart TD\n  A --> B', false);
  assert.notEqual(screen.getByTestId('code-editor'), null);
  assert.equal(screen.queryByTestId('mermaid-diagram'), null);
});
