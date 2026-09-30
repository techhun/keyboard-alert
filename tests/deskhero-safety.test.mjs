import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DESKHERO_PAGES,
  deskheroChangeId,
  diffDeskheroRows,
  parseDeskheroPageHtml,
  validateDeskheroRows
} from '../scripts/deskhero-safety.mjs';

function page(category) {
  return DESKHERO_PAGES.find((item) => item.category === category);
}

function fixture(rows) {
  return '<html><body><table><tbody>' +
    '<tr><td><strong>Product Name</strong></td><td><strong>Status / Notes</strong></td></tr>' +
    rows.map(([product, notes]) =>
      '<tr><td><span>' + product + '</span></td><td><span>' + notes + '</span></td></tr>'
    ).join('') +
    '</tbody></table></body></html>';
}

test('parses Deskhero two-column update rows and preserves detailed notes', () => {
  const rows = parseDeskheroPageHtml(fixture([
    ['GMK Motif Keycaps', 'Initial samples not approved.<br/>Quality adjustments being made.'],
    ['GMK Gurokawa', 'New estimated shipping October 2026']
  ]), page('Keyset'));

  assert.deepEqual(rows, [
    {
      category: 'Keyset',
      product: 'GMK Motif Keycaps',
      notes: 'Initial samples not approved. Quality adjustments being made.',
      sourceUrl: page('Keyset').url
    },
    {
      category: 'Keyset',
      product: 'GMK Gurokawa',
      notes: 'New estimated shipping October 2026',
      sourceUrl: page('Keyset').url
    }
  ]);
});

test('merges distinct duplicate highlight and canonical notes without duplicating identical text', () => {
  const rows = parseDeskheroPageHtml(fixture([
    ['GMK Motif Keycaps', 'Further delayed. Estimated late October.'],
    ['Awekeys Wild Ice', 'Estimated late August 2026.'],
    ['GMK Motif Keycaps', 'Initial sample not approved. Quality adjustments in progress.'],
    ['Awekeys Wild Ice', 'Estimated late August 2026.']
  ]), page('Keyset'));

  assert.equal(rows.length, 2);
  assert.equal(
    rows.find((row) => row.product === 'GMK Motif Keycaps').notes,
    'Further delayed. Estimated late October. | Initial sample not approved. Quality adjustments in progress.'
  );
  assert.equal(
    rows.find((row) => row.product === 'Awekeys Wild Ice').notes,
    'Estimated late August 2026.'
  );
});

test('validation requires all Deskhero categories and rejects shifted URLs', () => {
  const rows = [];
  const counts = { Keyboard: 20, Keyset: 50, Deskmat: 30, Accessory: 5 };
  for (const [category, count] of Object.entries(counts)) {
    for (let i = 0; i < count; i += 1) {
      rows.push({
        category,
        product: category + ' Product ' + i,
        notes: 'In production ' + i,
        sourceUrl: page(category).url
      });
    }
  }

  assert.equal(validateDeskheroRows(rows), rows);

  const bad = structuredClone(rows);
  bad[0].notes = 'https://example.com/bad';
  assert.throws(() => validateDeskheroRows(bad), /shifted text fields/);

  const missingAccessories = rows.filter((row) => row.category !== 'Accessory');
  assert.throws(() => validateDeskheroRows(missingAccessories), /Accessory=0/);
});

test('diff is category-aware, order-independent, and detects full note changes', () => {
  const previous = [
    { category: 'Keyset', product: 'Shared Name', notes: 'In production', sourceUrl: page('Keyset').url },
    { category: 'Keyboard', product: 'Shared Name', notes: 'Prototype', sourceUrl: page('Keyboard').url }
  ];
  const current = structuredClone(previous).reverse();
  current.find((row) => row.category === 'Keyset').notes = 'In transit. Estimated October 2026';

  const changes = diffDeskheroRows(previous, current);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].row.category, 'Keyset');
  assert.equal(changes[0].row.product, 'Shared Name');
  assert.deepEqual(changes[0].fields.map((field) => field.field), ['notes']);
});

test('change IDs distinguish same product name in different categories', () => {
  const keyset = {
    kind: 'changed',
    row: { category: 'Keyset', product: 'Shared Name', notes: 'B', sourceUrl: page('Keyset').url },
    fields: [{ field: 'notes', before: 'A', after: 'B' }]
  };
  const keyboard = structuredClone(keyset);
  keyboard.row.category = 'Keyboard';
  keyboard.row.sourceUrl = page('Keyboard').url;

  assert.notEqual(deskheroChangeId(keyset), deskheroChangeId(keyboard));
});
