import assert from 'node:assert/strict';

import { fireEvent, render, screen } from '@testing-library/react';
import { test, vi } from 'vitest';

/**
 * Regression guard: what a file reference in a chat message hands to the
 * editor. Both suffix helpers are anchored at the end of the string, so a
 * reference picked up from the link text — which, unlike the href, keeps the
 * whitespace around it — used to reach the API with `:12 ` still attached and
 * answer a 404.
 */

const openFileInEditor = vi.fn();
const openDirectory = vi.fn();

vi.mock('@/modules/command-palette', () => ({
  usePaletteOps: () => ({ openFileInEditor, openDirectory }),
}));

const { Markdown } = await import('@/modules/chat/transcript/Markdown');

const clickReference = (markdown: string, linkText: string) => {
  openFileInEditor.mockReset();
  openDirectory.mockReset();
  render(<Markdown>{markdown}</Markdown>);
  fireEvent.click(screen.getByText(linkText));
};

test('a `path:line` reference opens the path without its suffix, at that line', () => {
  clickReference('See [src/foo.ts:130](src/foo.ts:130).', 'src/foo.ts:130');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', 130]);
});

test('whitespace around a reference taken from the link text is dropped', () => {
  clickReference('See [`src/foo.ts:12` ]().', 'src/foo.ts:12');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', 12]);
});

test('a directory reference goes to the file tree, not the editor', () => {
  clickReference('See [decisions/](decisions/).', 'decisions/');
  assert.equal(openFileInEditor.mock.calls.length, 0);
  assert.deepEqual(openDirectory.mock.calls[0], ['decisions/']);
});

test('a plain file reference opens with no line', () => {
  clickReference('See [src/foo.ts](src/foo.ts).', 'src/foo.ts');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['src/foo.ts', null]);
});

test('a non-ASCII reference opens the decoded on-disk path', () => {
  // Codex writes absolute references, and a Chinese path in an href comes back
  // out of the markdown parser percent-encoded. Handing that to the file API
  // asks for a literal `%E5%BC%80` directory and answers 404.
  clickReference('See [问题背景](</home/u/docs/开发需求/背景.md>).', '问题背景');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['/home/u/docs/开发需求/背景.md', null]);
});

test('a non-ASCII reference keeps its line suffix once decoded', () => {
  // The exact shape Codex emits: an angle-bracketed absolute destination with a
  // Chinese path and `:line` at the end.
  clickReference(
    'See [MakeUpdateArgs.java:71](</home/u/docs/开发需求/造卡/scripts/MakeUpdateArgs.java:71>).',
    'MakeUpdateArgs.java:71',
  );
  assert.deepEqual(openFileInEditor.mock.calls[0], ['/home/u/docs/开发需求/造卡/scripts/MakeUpdateArgs.java', 71]);
});

test('a non-ASCII directory reference opens the decoded directory', () => {
  clickReference('See [开发需求/](</home/u/docs/开发需求/>).', '开发需求/');
  assert.deepEqual(openDirectory.mock.calls[0], ['/home/u/docs/开发需求/']);
});
