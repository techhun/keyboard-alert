import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cannonKeysChangeId,
  diffCannonKeysRows,
  normalizeCannonKeysRows,
  validateCannonKeysIndex,
  validateCannonKeysRows
} from '../scripts/cannonkeys-safety.mjs';

const categories = ['keyboard', 'keyset', 'deskmat', 'other'];
const statuses = ['ordered', 'manufacturing', 'en_route', 'shipping', 'complete'];

function detail(index, overrides = {}) {
  return {
    id: overrides.id ?? index + 1,
    display_name: overrides.display_name || 'Project ' + index,
    start_date: overrides.start_date ?? '2026-08-01',
    end_date: overrides.end_date ?? '2026-08-31',
    eta: overrides.eta ?? 'Q4 2026',
    status: overrides.status || statuses[index % statuses.length],
    category: overrides.category || categories[index % categories.length],
    updates: overrides.updates ?? [{
      id: 1000 + index,
      created_at: '2026-09-01',
      description: 'Update ' + index
    }]
  };
}

function detailsFixture(count = 120) {
  return Array.from({ length: count }, (_, index) => detail(index));
}

function indexFixture(count = 120) {
  return detailsFixture(count).map((item) => ({
    id: item.id,
    display_name: item.display_name,
    status: item.status,
    category: item.category
  }));
}

test('validates CannonKeys index shape and accepted states', () => {
  const index = indexFixture();
  assert.equal(validateCannonKeysIndex(index).length, 120);

  const bad = structuredClone(index);
  bad[0].status = 'mystery';
  assert.throws(() => validateCannonKeysIndex(bad), /unexpected status/);
});

test('normalizes detail rows and chooses newest update by date', () => {
  const details = detailsFixture();
  details[0].updates = [
    { id: 1, created_at: '2026-08-10', description: 'Older' },
    { id: 2, created_at: '2026-09-28', description: 'Newest' }
  ];

  const rows = normalizeCannonKeysRows(details);
  assert.equal(rows.length, 120);
  assert.deepEqual(rows[0], {
    id: 1,
    displayName: 'Project 0',
    category: 'keyboard',
    status: 'ordered',
    startDate: '2026-08-01',
    endDate: '2026-08-31',
    eta: 'Q4 2026',
    latestUpdateId: 2,
    latestUpdateDate: '2026-09-28',
    latestUpdateDescription: 'Newest'
  });
});

test('validation rejects malformed dates and duplicate ids', () => {
  const rows = normalizeCannonKeysRows(detailsFixture());

  const badDate = structuredClone(rows);
  badDate[0].latestUpdateDate = 'Sep 28';
  assert.throws(() => validateCannonKeysRows(badDate), /invalid latestUpdateDate/);

  const duplicate = structuredClone(rows);
  duplicate[1].id = duplicate[0].id;
  assert.throws(() => validateCannonKeysRows(duplicate), /duplicate id/);
});

test('diff is id-based and detects status, ETA, dates and latest update changes', () => {
  const previous = normalizeCannonKeysRows(detailsFixture());
  const current = structuredClone(previous).reverse();
  const target = current.find((row) => row.id === 5);

  target.status = 'shipping';
  target.eta = 'January 2027';
  target.endDate = '2026-09-05';
  target.latestUpdateDate = '2026-09-28';
  target.latestUpdateDescription = 'Shipping soon.';

  const changes = diffCannonKeysRows(previous, current);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].row.id, 5);
  assert.deepEqual(changes[0].fields.map((field) => field.field), [
    'status',
    'endDate',
    'eta',
    'latestUpdateDate',
    'latestUpdateDescription'
  ]);
});

test('change IDs use stable project id identity', () => {
  const a = {
    kind: 'changed',
    row: { id: 10, displayName: 'Same' },
    fields: [{ field: 'status', before: 'ordered', after: 'manufacturing' }]
  };
  const b = {
    kind: 'changed',
    row: { id: 11, displayName: 'Same' },
    fields: [{ field: 'status', before: 'ordered', after: 'manufacturing' }]
  };

  assert.notEqual(cannonKeysChangeId(a), cannonKeysChangeId(b));
});
