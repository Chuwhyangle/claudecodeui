import assert from 'node:assert/strict';

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { beforeEach, test, vi } from 'vitest';

import enCommon from '@/modules/i18n/locales/en/common.json';
import type { Project } from '@/shared/types';

/**
 * The Files tab reads the project one directory at a time.
 *
 * What this file pins, on the real tree component:
 *
 *  - opening the tree reads the root and nothing else — the retired full-tree
 *    fetch has no api entry at all, so the only read is the one-level listing;
 *  - expanding a folder reads exactly that folder's path, once; collapsing and
 *    expanding again reuses the cached listing;
 *  - a reveal request walks a deep path layer by layer, root first, and opens
 *    the ancestors it loaded;
 *  - a create/rename/delete/upload invalidates the directory it touched and
 *    reads that directory again, rather than reloading the whole tree.
 */

const ROOT = '/home/odoo/workspace/lazy';
const PROJECT_ID = 'p1';

type Entry = { type: 'file' | 'directory'; name: string; path: string; hasChildren?: boolean };
type Listing = { path: string; entries: Entry[]; truncated: boolean };

const file = (parent: string, name: string): Entry => ({ type: 'file', name, path: `${parent}/${name}` });
const folder = (parent: string, name: string): Entry => ({
  type: 'directory',
  name,
  path: `${parent}/${name}`,
  hasChildren: true,
});
const listing = (path: string, entries: Entry[] = []): Listing => ({ path, entries, truncated: false });

const state = vi.hoisted(() => ({
  getDirectory: vi.fn(),
  createFile: vi.fn(),
  renameFile: vi.fn(),
  deleteFile: vi.fn(),
  uploadFilesUrl: vi.fn(),
}));

vi.mock('@/shared/api', () => ({
  api: {
    getDirectory: state.getDirectory,
    createFile: state.createFile,
    renameFile: state.renameFile,
    deleteFile: state.deleteFile,
    uploadFilesUrl: state.uploadFilesUrl,
  },
}));

await i18next.use(initReactI18next).init({
  lng: 'en',
  fallbackLng: 'en',
  ns: ['common'],
  defaultNS: 'common',
  resources: { en: { common: enCommon } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

const { default: FileTree } = await import('@/modules/file-tree/FileTree');

const project: Project = { projectId: PROJECT_ID, displayName: 'lazy', fullPath: ROOT, path: ROOT };

const respond = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => '' });
const okMutation = () => Promise.resolve({ ok: true, status: 200, json: async () => ({}) });

// The upload path talks to XMLHttpRequest directly; the response only has to
// settle successfully so the upload's invalidation callback runs.
class SuccessfulUploadRequest {
  upload = { onprogress: null as ((event: unknown) => void) | null };
  status = 200;
  responseText = JSON.stringify({ uploadedCount: 1, requestedFileCount: 1, files: [{ name: 'uploaded.txt' }] });
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  open() {}
  setRequestHeader() {}
  getResponseHeader() {
    return null;
  }
  send() {
    setTimeout(() => this.onload?.(), 0);
  }
}
vi.stubGlobal('XMLHttpRequest', SuccessfulUploadRequest);

let listings: Record<string, Listing>;
let directoryCalls: string[];

beforeEach(() => {
  state.getDirectory.mockReset();
  state.createFile.mockReset();
  state.renameFile.mockReset();
  state.deleteFile.mockReset();
  state.uploadFilesUrl.mockReset();

  listings = {
    '': listing(ROOT, [folder(ROOT, 'src'), folder(ROOT, 'docs'), file(ROOT, 'README.md')]),
    [`${ROOT}/src`]: listing(`${ROOT}/src`, [
      folder(`${ROOT}/src`, 'modules'),
      file(`${ROOT}/src`, 'app.ts'),
    ]),
    [`${ROOT}/src/modules`]: listing(`${ROOT}/src/modules`, [file(`${ROOT}/src/modules`, 'index.ts')]),
    [`${ROOT}/docs`]: listing(`${ROOT}/docs`, [file(`${ROOT}/docs`, 'guide.md')]),
  };
  directoryCalls = [];

  state.getDirectory.mockImplementation(async (_projectId: string, path: string) => {
    directoryCalls.push(path);
    return respond(listings[path] ?? listing(path));
  });
  state.createFile.mockImplementation(okMutation);
  state.renameFile.mockImplementation(okMutation);
  state.deleteFile.mockImplementation(okMutation);
  state.uploadFilesUrl.mockReturnValue(`/api/file-tree/projects/${PROJECT_ID}/files/upload`);
});

test('opening the tree reads only the root; unexpanded folders send nothing', async () => {
  render(<FileTree selectedProject={project} />);

  await screen.findByText('src');
  await screen.findByText('docs');

  assert.deepEqual(directoryCalls, [''], 'one request, for the root listing');
  assert.equal(screen.queryByText('app.ts'), null);
  assert.equal(screen.queryByText('guide.md'), null);
});

test('expanding a folder reads that path once and reuses the listing after a collapse', async () => {
  render(<FileTree selectedProject={project} />);
  await screen.findByText('src');

  fireEvent.click(screen.getByText('src'));
  await screen.findByText('app.ts');

  assert.deepEqual(directoryCalls, ['', `${ROOT}/src`]);
  assert.equal(screen.queryByText('guide.md'), null, 'the untouched sibling folder was never read');

  // Collapsing hides the rows but keeps the cache; expanding again is free.
  fireEvent.click(screen.getByText('src'));
  assert.equal(screen.queryByText('app.ts'), null);

  fireEvent.click(screen.getByText('src'));
  await screen.findByText('app.ts');
  assert.deepEqual(directoryCalls, ['', `${ROOT}/src`], 'the cached listing is reused');
});

test('revealing a deep folder loads its ancestors in order and opens it', async () => {
  render(<FileTree selectedProject={project} revealDirectory={{ path: 'src/modules/' }} />);

  await screen.findByText('index.ts');
  await screen.findByText('app.ts');

  assert.deepEqual(
    directoryCalls,
    ['', `${ROOT}/src`, `${ROOT}/src/modules`],
    'root, then each ancestor in order',
  );
});

test('creating a file invalidates the directory it landed in and reads it again', async () => {
  render(<FileTree selectedProject={project} />);
  await screen.findByText('src');
  fireEvent.click(screen.getByText('src'));
  await screen.findByText('app.ts');
  assert.deepEqual(directoryCalls, ['', `${ROOT}/src`]);

  // The server's next root listing carries the created file.
  listings[''] = listing(ROOT, [
    folder(ROOT, 'src'),
    folder(ROOT, 'docs'),
    file(ROOT, 'README.md'),
    file(ROOT, 'new.ts'),
  ]);

  fireEvent.click(screen.getByRole('button', { name: /New File/ }));
  const nameInput = screen.getByDisplayValue('untitled.txt');
  fireEvent.change(nameInput, { target: { value: 'new.ts' } });
  fireEvent.keyDown(nameInput, { key: 'Enter' });

  await screen.findByText('new.ts');
  assert.equal(state.createFile.mock.calls.length, 1);
  assert.deepEqual(directoryCalls, ['', `${ROOT}/src`, ''], 'the root is read again, not the whole tree');
});

test('renaming a file invalidates its containing directory and reads it again', async () => {
  render(<FileTree selectedProject={project} />);
  await screen.findByText('src');
  fireEvent.click(screen.getByText('src'));
  await screen.findByText('app.ts');
  assert.deepEqual(directoryCalls, ['', `${ROOT}/src`]);

  listings[`${ROOT}/src`] = listing(`${ROOT}/src`, [
    folder(`${ROOT}/src`, 'modules'),
    file(`${ROOT}/src`, 'main.ts'),
  ]);

  fireEvent.contextMenu(screen.getByText('app.ts'));
  // File menu order: Rename, Delete, Copy Path, Download.
  fireEvent.click(screen.getAllByRole('menuitem')[0]);
  const nameInput = screen.getByDisplayValue('app.ts');
  fireEvent.change(nameInput, { target: { value: 'main.ts' } });
  fireEvent.keyDown(nameInput, { key: 'Enter' });

  await screen.findByText('main.ts');
  assert.equal(state.renameFile.mock.calls.length, 1);
  assert.deepEqual(directoryCalls, ['', `${ROOT}/src`, `${ROOT}/src`], 'only the containing folder is read again');
});

test('deleting a file invalidates its containing directory and reads it again', async () => {
  render(<FileTree selectedProject={project} />);
  await screen.findByText('src');
  fireEvent.click(screen.getByText('src'));
  await screen.findByText('app.ts');
  assert.deepEqual(directoryCalls, ['', `${ROOT}/src`]);

  listings[`${ROOT}/src`] = listing(`${ROOT}/src`, [folder(`${ROOT}/src`, 'modules')]);

  fireEvent.contextMenu(screen.getByText('app.ts'));
  // File menu order: Rename, Delete, Copy Path, Download.
  fireEvent.click(screen.getAllByRole('menuitem')[1]);
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

  await waitFor(() => assert.equal(screen.queryByText('app.ts'), null));
  assert.equal(state.deleteFile.mock.calls.length, 1);
  assert.deepEqual(directoryCalls, ['', `${ROOT}/src`, `${ROOT}/src`], 'only the containing folder is read again');
});

test('uploading into a folder invalidates that folder and reads it again', async () => {
  const view = render(<FileTree selectedProject={project} />);
  await screen.findByText('src');
  fireEvent.click(screen.getByText('src'));
  await screen.findByText('app.ts');
  assert.deepEqual(directoryCalls, ['', `${ROOT}/src`]);

  listings[`${ROOT}/src`] = listing(`${ROOT}/src`, [
    folder(`${ROOT}/src`, 'modules'),
    file(`${ROOT}/src`, 'app.ts'),
    file(`${ROOT}/src`, 'uploaded.txt'),
  ]);

  const uploadedFile = new File(['hello'], 'uploaded.txt', { type: 'text/plain' });
  const dataTransfer = {
    items: [{ kind: 'file', webkitGetAsEntry: () => null, getAsFile: () => uploadedFile }],
    files: [uploadedFile],
  };

  // Dropping on a folder row targets that folder; the drop itself lands on the
  // tree container.
  fireEvent.dragOver(screen.getByText('src'));
  fireEvent.drop(view.container.firstElementChild as Element, { dataTransfer });

  await screen.findByText('uploaded.txt');
  assert.equal(state.uploadFilesUrl.mock.calls.length, 1);
  assert.deepEqual(directoryCalls, ['', `${ROOT}/src`, `${ROOT}/src`], 'only the target folder is read again');
});
