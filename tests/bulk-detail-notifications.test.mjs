import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { bulkChangeInfo } from '../scripts/geonworks-safety.mjs';

const CHECKERS = [
  'scripts/check-geonworks.mjs',
  'scripts/check-geonworks-release.mjs',
  'scripts/check-oblotzky.mjs',
  'scripts/check-novelkeys.mjs',
  'scripts/check-kbdfans.mjs',
  'scripts/check-cannonkeys.mjs',
  'scripts/check-deskhero.mjs',
  'scripts/check-omnitype.mjs'
];

test('bulk threshold still classifies the recent 14/283 CannonKeys batch as bulk', () => {
  const result = bulkChangeInfo(Array.from({ length: 14 }, () => ({})), 283);
  assert.equal(result.bulk, true);
  assert.equal(result.count, 14);
  assert.ok(result.ratio > 0.04 && result.ratio < 0.06);
});

test('smaller verified batches remain non-bulk when below the safety threshold', () => {
  const result = bulkChangeInfo(Array.from({ length: 5 }, () => ({})), 93);
  assert.equal(result.bulk, false);
});

for (const path of CHECKERS) {
  test(path + ' keeps bulk re-verification but sends detailed per-change notifications', () => {
    const source = fs.readFileSync(path, 'utf8');

    assert.match(source, /bulkChangeInfo\(changes, previousRows\.length\)/);
    assert.match(source, /bulk change detected/i);
    assert.match(source, /change set confirmed by two consecutive reads/);

    assert.doesNotMatch(source, /대량 변경 확인/);
    assert.doesNotMatch(source, /summarized in one notification/i);
    assert.doesNotMatch(source, /const bulkId\s*=/);

    const pending = source.indexOf('const pendingChanges = changes.filter');
    const loop = source.indexOf('for (const change of pendingChanges)', pending);
    const checkpoint = source.indexOf('saveState(previousRows, sentChanges)', loop);

    assert.ok(pending >= 0, 'pendingChanges filter must remain');
    assert.ok(loop > pending, 'verified changes must use the per-change notification loop');
    assert.ok(checkpoint > loop, 'sent change IDs must be checkpointed before final state advance');
  });
}
