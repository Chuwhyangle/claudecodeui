// The browser bundle's build fingerprint (AC4).
//
// `scripts/write-client-build-info.mjs` is the last step of `build:client`. This criterion runs
// it against a throwaway root and checks the record it writes is the SAME shape the server's
// `scripts/write-build-info.mjs` produces — `{ gitSha, builtAt }`, nothing else — because the
// deployment reading parses both with one function. A second shape would make the client
// fingerprint silently unreadable.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { writeClientBuildInfo } from './write-client-build-info.mjs';

/**
 * @param {(root: string) => void} run
 */
function withTempRoot(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'client-build-info-'));
  try {
    run(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('writes dist/build-info.json with the server record shape', () => {
  withTempRoot((root) => {
    const sha = 'b'.repeat(40);
    const { path: outputPath, record } = writeClientBuildInfo({
      root,
      gitSha: sha,
      builtAt: '2026-10-24T00:00:00.000Z',
    });

    assert.equal(outputPath, path.join(root, 'dist', 'build-info.json'));
    assert.deepEqual(JSON.parse(fs.readFileSync(outputPath, 'utf8')), {
      gitSha: sha,
      builtAt: '2026-10-24T00:00:00.000Z',
    });
    // Exactly the two documented fields — an extra key would be ignored by the reader and could
    // hide a drift from the server's format.
    assert.deepEqual(Object.keys(record).sort(), ['builtAt', 'gitSha']);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).sort(), [
      'builtAt',
      'gitSha',
    ]);
  });
});

test('a null git sha is written, not omitted (the reading treats null as "not measured")', () => {
  withTempRoot((root) => {
    writeClientBuildInfo({ root, gitSha: null, builtAt: '2026-10-24T00:00:00.000Z' });
    const written = JSON.parse(
      fs.readFileSync(path.join(root, 'dist', 'build-info.json'), 'utf8'),
    );
    assert.deepEqual(written, { gitSha: null, builtAt: '2026-10-24T00:00:00.000Z' });
  });
});
