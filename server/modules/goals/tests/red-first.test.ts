import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyRedFirst } from '@/modules/goals/red-first.js';
import type { CriterionReading } from '@/shared/types.js';

function reading(verdict: 'pass' | 'fail'): CriterionReading {
  return {
    exitCode: verdict === 'pass' ? 0 : 1,
    timedOut: false,
    output: verdict,
    outputDigest: 'digest',
    verdict,
  };
}

test('all-red readings pass the gate', () => {
  assert.deepEqual(
    verifyRedFirst([
      { acId: 'AC-001', reading: reading('fail') },
      { acId: 'AC-002', reading: reading('fail') },
    ]),
    { ok: true },
  );
});

test('any green reading refuses activation and names every green AC', () => {
  assert.deepEqual(
    verifyRedFirst([
      { acId: 'AC-001', reading: reading('fail') },
      { acId: 'AC-002', reading: reading('pass') },
      { acId: 'AC-003', reading: reading('pass') },
    ]),
    { ok: false, greenAcIds: ['AC-002', 'AC-003'] },
  );
});

test('no readings at all is a refusal', () => {
  assert.deepEqual(verifyRedFirst([]), { ok: false, greenAcIds: [] });
});
