import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import test from 'node:test';

import express, { type RequestHandler } from 'express';

import { createFileTreeRouter } from '@/modules/file-tree/file-tree.routes.js';
import type { FileTreeServices } from '@/shared/types.js';

function createFakeServices(overrides: Partial<FileTreeServices> = {}): FileTreeServices {
  const unexpectedOperation = async (): Promise<never> => {
    throw new Error('Unexpected File Tree service call');
  };

  return {
    browseWorkspace: unexpectedOperation,
    createWorkspaceFolder: unexpectedOperation,
    readTextFile: unexpectedOperation,
    openFile: unexpectedOperation,
    saveTextFile: unexpectedOperation,
    listProjectDirectory: unexpectedOperation,
    listProjectFileIndex: unexpectedOperation,
    listProjectSearchIndex: unexpectedOperation,
    createEntry: unexpectedOperation,
    renameEntry: unexpectedOperation,
    deleteEntry: unexpectedOperation,
    storeUploadedFiles: unexpectedOperation,
    ...overrides,
  };
}

const passUploadRequest: RequestHandler = (_request, _response, next) => next();

async function withFileTreeServer(
  services: FileTreeServices,
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.use('/api/file-tree', createFileTreeRouter(
    services,
    passUploadRequest,
    { maximumFileSizeMegabytes: 200, maximumFileCount: 20 },
    { error: () => undefined },
  ));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('project files route lists the project root when no path is supplied', async () => {
  const inputs: Parameters<FileTreeServices['listProjectDirectory']>[] = [];
  const services = createFakeServices({
    listProjectDirectory: async (...input) => {
      inputs.push(input);
      return { path: '/workspace/project', entries: [], truncated: false };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      path: '/workspace/project',
      entries: [],
      truncated: false,
    });
  });

  // The legacy full-tree shape is gone: every `/files` request is one lazy
  // directory listing, and the root is the no-path default.
  assert.deepEqual(inputs, [['project-1', undefined]]);
});

test('project files route ignores a legacy respectGitignore parameter', async () => {
  const inputs: Parameters<FileTreeServices['listProjectDirectory']>[] = [];
  const services = createFakeServices({
    listProjectDirectory: async (...input) => {
      inputs.push(input);
      return { path: '/workspace/project', entries: [], truncated: false };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?respectGitignore=true`,
    );

    assert.equal(response.status, 200);
  });

  // Display is disk truth by default: the retired query parameter reaches no
  // option bag, so there is nothing left for it to switch on.
  assert.deepEqual(inputs, [['project-1', undefined]]);
});

test('project files route takes the lazy directory listing when a path is supplied', async () => {
  const inputs: Parameters<FileTreeServices['listProjectDirectory']>[] = [];
  const services = createFakeServices({
    listProjectDirectory: async (...input) => {
      inputs.push(input);
      return { path: '/workspace/project/src', entries: [], truncated: true };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files?path=%2Fworkspace%2Fproject%2Fsrc`,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      path: '/workspace/project/src',
      entries: [],
      truncated: true,
    });
  });

  assert.deepEqual(inputs, [['project-1', '/workspace/project/src']]);
});

test('files-search-index route forwards the project id and returns the unfiltered index', async () => {
  const inputs: Parameters<FileTreeServices['listProjectSearchIndex']>[] = [];
  const services = createFakeServices({
    listProjectSearchIndex: async (...input) => {
      inputs.push(input);
      return {
        files: [{ name: 'package.mmd', path: '/workspace/project/.archguard/output/overview/package.mmd', type: 'file' }],
        truncated: false,
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl}/api/file-tree/projects/project-1/files-search-index`,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      files: [{
        name: 'package.mmd',
        path: '/workspace/project/.archguard/output/overview/package.mmd',
        type: 'file',
      }],
      truncated: false,
    });
  });

  assert.deepEqual(inputs, [['project-1']]);
});

test('files-index route forwards the project id and returns the flat index', async () => {
  const inputs: Parameters<FileTreeServices['listProjectFileIndex']>[] = [];
  const services = createFakeServices({
    listProjectFileIndex: async (...input) => {
      inputs.push(input);
      return {
        files: [{ name: 'index.ts', path: '/workspace/project/src/index.ts', type: 'file' }],
        truncated: false,
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files-index`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      files: [{ name: 'index.ts', path: '/workspace/project/src/index.ts', type: 'file' }],
      truncated: false,
    });
  });

  assert.deepEqual(inputs, [['project-1']]);
});

test('create route parses the transport payload before invoking the service', async () => {
  const inputs: Parameters<FileTreeServices['createEntry']>[0][] = [];
  const services = createFakeServices({
    createEntry: async (input) => {
      inputs.push(input);
      return {
        success: true,
        path: '/workspace/project/src/example.ts',
        name: input.name,
        type: input.type,
        message: 'File created successfully',
      };
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: '/workspace/project/src',
        type: 'file',
        name: 'example.ts',
      }),
    });

    assert.equal(response.status, 200);
  });

  assert.deepEqual(inputs, [{
    projectId: 'project-1',
    parentPath: '/workspace/project/src',
    type: 'file',
    name: 'example.ts',
  }]);
});

test('create route rejects invalid entry types without calling the service', async () => {
  let createCalled = false;
  const services = createFakeServices({
    createEntry: async () => {
      createCalled = true;
      throw new Error('createEntry should not run for invalid input');
    },
  });

  await withFileTreeServer(services, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/file-tree/projects/project-1/files/create`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'link', name: 'example' }),
    });
    const payload = await response.json() as { error: string };

    assert.equal(response.status, 400);
    assert.equal(payload.error, 'Type must be "file" or "directory"');
  });

  assert.equal(createCalled, false);
});
