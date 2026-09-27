import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diffKbdFansRows,
  kbdFansChangeId,
  parseKbdFansUpdatesHtml,
  validateKbdFansRows
} from '../scripts/kbdfans-safety.mjs';

const categories = [
  ['KEYCAPS', 12],
  ['KEYBOARDS', 12],
  ['DESKPADS', 6]
];

function card(category, index, overrides = {}) {
  const product = overrides.product || category + ' Product ' + index;
  const status = overrides.status || 'In production';
  const eta = overrides.eta || 'Q4 2026';
  const progress = overrides.progress ?? 50;
  const summary = overrides.summary || 'No update summary yet.';
  const update = overrides.update || '';

  return '<details class="kbd-update-card">' +
    '<summary><div class="kbd-update-card__layout"><div class="kbd-update-card__content">' +
    '<div class="kbd-update-card__meta"><span>' + category + '</span><span>' + status + '</span><span>ETA ' + eta + '</span></div>' +
    '<h3>' + product + '</h3>' +
    '<div class="kbd-update-card__progress-label"><span>Project progress</span><b>' + progress + '%</b></div>' +
    '<div class="kbd-update-card__track" role="progressbar" aria-valuenow="' + progress + '"></div>' +
    '<div class="kbd-update-card__footer"><p>' + summary + '</p><span>View updates</span></div>' +
    '</div></div></summary>' +
    update +
    '</details>';
}

function timeline(date = '2026-09-21', title = 'Project update', body = 'CNC in batches.') {
  return '<div class="kbd-update-timeline">' +
    '<article class="kbd-update-entry">' +
    '<div class="kbd-update-entry__content"><div class="kbd-update-entry__head">' +
    '<h4>' + title + '</h4><time>' + date + '</time></div>' +
    '<div class="kbd-update-entry__body">' + body + '</div></div>' +
    '</article></div>';
}

function fixture() {
  return categories.map(([category, count]) =>
    '<section class="kbd-updates-group" data-update-group="' + category + '">' +
    Array.from({ length: count }, (_, index) =>
      card(category, index, category === 'KEYBOARDS' && index === 0
        ? { summary: 'Project update', update: timeline() }
        : {})
    ).join('') +
    '</section>'
  ).join('');
}

test('parses category, status, ETA, progress, summary, and latest update', () => {
  const rows = parseKbdFansUpdatesHtml(fixture());
  assert.equal(rows.length, 30);

  const row = rows.find((item) => item.product === 'KEYBOARDS Product 0');
  assert.deepEqual(row, {
    category: 'KEYBOARDS',
    product: 'KEYBOARDS Product 0',
    status: 'In production',
    eta: 'Q4 2026',
    progress: 50,
    summary: 'Project update',
    latestUpdateDate: '2026-09-21',
    latestUpdateTitle: 'Project update',
    latestUpdateBody: 'CNC in batches.'
  });
});

test('chooses the newest timeline update by date', () => {
  const newer = timeline('2026-09-28', 'Latest', 'Newest body');
  const older = timeline('2026-08-10', 'Older', 'Older body');
  const html = fixture().replace(
    card('KEYCAPS', 0),
    card('KEYCAPS', 0, { summary: 'Latest', update: older + newer })
  );

  const row = parseKbdFansUpdatesHtml(html).find((item) => item.product === 'KEYCAPS Product 0');
  assert.equal(row.latestUpdateDate, '2026-09-28');
  assert.equal(row.latestUpdateTitle, 'Latest');
  assert.equal(row.latestUpdateBody, 'Newest body');
});

test('validation rejects malformed progress and missing categories', () => {
  const rows = parseKbdFansUpdatesHtml(fixture());
  const bad = structuredClone(rows);
  bad[0].progress = 150;
  assert.throws(() => validateKbdFansRows(bad), /invalid progress/);

  const noDeskpads = rows.filter((row) => row.category !== 'DESKPADS');
  assert.throws(() => validateKbdFansRows(noDeskpads), /suspiciously few rows|category returned no rows/);
});

test('diff is stable when card order changes and catches rich update fields', () => {
  const previous = parseKbdFansUpdatesHtml(fixture());
  const current = structuredClone(previous).reverse();
  const target = current.find((row) => row.product === 'KEYBOARDS Product 0');

  target.status = 'Shipping';
  target.eta = 'Q1 2027';
  target.progress = 80;
  target.summary = 'Shipping soon';
  target.latestUpdateDate = '2026-09-28';
  target.latestUpdateTitle = 'Shipping update';
  target.latestUpdateBody = 'Packaging completed.';

  const changes = diffKbdFansRows(previous, current);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].row.product, 'KEYBOARDS Product 0');
  assert.deepEqual(changes[0].fields.map((field) => field.field), [
    'status',
    'eta',
    'progress',
    'summary',
    'latestUpdateDate',
    'latestUpdateTitle',
    'latestUpdateBody'
  ]);
});

test('change IDs distinguish same product name in different categories', () => {
  const a = {
    kind: 'changed',
    row: { category: 'KEYCAPS', product: 'Graphite' },
    fields: [{ field: 'status', before: 'In production', after: 'Shipping' }]
  };
  const b = {
    kind: 'changed',
    row: { category: 'KEYBOARDS', product: 'Graphite' },
    fields: [{ field: 'status', before: 'In production', after: 'Shipping' }]
  };
  assert.notEqual(kbdFansChangeId(a), kbdFansChangeId(b));
});
