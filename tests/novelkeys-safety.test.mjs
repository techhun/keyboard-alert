import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diffNovelKeysRows,
  novelKeysChangeId,
  parseNovelKeysUpdatesHtml,
  validateNovelKeysRows
} from '../scripts/novelkeys-safety.mjs';

const categories = [
  ['keyboards', 'Keyboard'],
  ['keycaps', 'Keycap'],
  ['deskpads', 'Deskpad'],
  ['switches', 'Misc.']
];

function card(categoryId, index, overrides = {}) {
  const name = overrides.product || categoryId + ' Product ' + index;
  const href = overrides.href || '/products/' + categoryId + '-product-' + index;
  const status = overrides.status || 'In production.';
  const eta = overrides.eta === undefined ? 'Q4 2026' : overrides.eta;

  return '<a class="preorder-timeline-link" href="' + href + '">' +
    '<div class="preorder-timeline-container">' +
    '<h2 class="preorder-timeline-title">' + name + '</h2>' +
    '<div class="two-column-grid"><b>Current Status:</b><p>' + status + '</p></div>' +
    (eta ? '<p data-preorder-timeline="' + eta + '"><b>Estimated Arrival: </b><span class="preorder-timeline-text">' + eta + '</span></p>' : '') +
    '</div></a>';
}

function fixture() {
  return categories.map(([id]) => {
    const count = id === 'keyboards' ? 10 : id === 'keycaps' ? 10 : id === 'deskpads' ? 6 : 4;
    return '<div id="' + id + '" class="tab">' +
      Array.from({ length: count }, (_, index) => card(id, index)).join('') +
      '</div>';
  }).join('');
}

test('parses all NovelKeys tab cards with status, ETA, URL, and category', () => {
  const rows = parseNovelKeysUpdatesHtml(fixture());
  assert.equal(rows.length, 30);
  assert.deepEqual(rows[0], {
    category: 'Keyboard',
    product: 'keyboards Product 0',
    status: 'In production.',
    eta: 'Q4 2026',
    url: 'https://novelkeys.com/products/keyboards-product-0'
  });
  assert.equal(rows.at(-1).category, 'Misc.');
});

test('allows completed cards without an ETA', () => {
  const html = fixture().replace(
    card('deskpads', 0),
    card('deskpads', 0, { status: 'Fulfilled!', eta: '' })
  );
  const rows = parseNovelKeysUpdatesHtml(html);
  const row = rows.find((item) => item.product === 'deskpads Product 0');
  assert.equal(row.status, 'Fulfilled!');
  assert.equal(row.eta, '');
});

test('validation rejects malformed product links and missing categories', () => {
  const rows = parseNovelKeysUpdatesHtml(fixture());
  const bad = structuredClone(rows);
  bad[0].url = 'https://example.com/products/x';
  assert.throws(() => validateNovelKeysRows(bad), /unexpected product URL/);

  const noMisc = rows.filter((row) => row.category !== 'Misc.');
  assert.throws(() => validateNovelKeysRows(noMisc), /suspiciously few rows|category returned no rows/);
});

test('diff uses product identity instead of card position', () => {
  const previous = parseNovelKeysUpdatesHtml(fixture());
  const current = structuredClone(previous).reverse();
  const target = current.find((row) => row.product === 'keycaps Product 3');
  target.status = 'In transit to NovelKeys.';
  target.eta = 'Q1 2027';

  const changes = diffNovelKeysRows(previous, current);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].row.product, 'keycaps Product 3');
  assert.deepEqual(changes[0].fields.map((field) => field.field), ['status', 'eta']);
});

test('change IDs distinguish duplicate-looking products by product URL', () => {
  const a = {
    kind: 'changed',
    row: { category: 'Keyboard', product: 'Cloudnine 2', url: 'https://novelkeys.com/products/cloudnine-2-a' },
    fields: [{ field: 'status', before: 'In production', after: 'Shipping' }]
  };
  const b = {
    kind: 'changed',
    row: { category: 'Keyboard', product: 'Cloudnine 2', url: 'https://novelkeys.com/products/cloudnine-2-b' },
    fields: [{ field: 'status', before: 'In production', after: 'Shipping' }]
  };
  assert.notEqual(novelKeysChangeId(a), novelKeysChangeId(b));
});
