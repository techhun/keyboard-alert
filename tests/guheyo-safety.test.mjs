import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../scripts/check-guheyo.mjs', import.meta.url), 'utf8');

test('Guheyo blocks suspicious bulk-new batches before sending notifications', () => {
  assert.match(source, /const MAX_NEW_LISTINGS = 15;/);

  const fresh = source.indexOf('const fresh = items.filter');
  const guard = source.indexOf('fresh.length > MAX_NEW_LISTINGS', fresh);
  const loop = source.indexOf('for (const item of [...fresh].reverse())', fresh);

  assert.ok(fresh >= 0, 'fresh listing detection must exist');
  assert.ok(guard > fresh, 'bulk-new guard must run after fresh detection');
  assert.ok(loop > guard, 'bulk-new guard must run before notification delivery');
  assert.match(source, /Suspiciously many new Guheyo listings/);
});
