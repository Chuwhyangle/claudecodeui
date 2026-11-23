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

const { Markdown } = await import('@/modules/chat/ui/Markdown');

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

// Regression guard: the markdown parser percent-encodes a non-ASCII link
// destination, but the file API opens an on-disk path. The href must be decoded
// before it becomes the reference; an undecoded one answers a 404.

test('a percent-encoded non-ASCII absolute path opens the decoded path', () => {
  clickReference(
    'See [文档/开发/x.md](/home/u/%E6%96%87%E6%A1%A3/%E5%BC%80%E5%8F%91/x.md).',
    '文档/开发/x.md',
  );
  assert.deepEqual(openFileInEditor.mock.calls[0], ['/home/u/文档/开发/x.md', null]);
});

test('a percent-encoded non-ASCII path still strips its `:line` suffix', () => {
  clickReference(
    'See [文档/x.md:42](/home/u/%E6%96%87%E6%A1%A3/x.md:42).',
    '文档/x.md:42',
  );
  assert.deepEqual(openFileInEditor.mock.calls[0], ['/home/u/文档/x.md', 42]);
});

test('a percent-encoded relative path under a non-ASCII directory opens decoded', () => {
  clickReference('See [文档/x.md](%E6%96%87%E6%A1%A3/x.md).', '文档/x.md');
  assert.deepEqual(openFileInEditor.mock.calls[0], ['文档/x.md', null]);
});
