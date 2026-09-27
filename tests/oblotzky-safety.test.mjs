import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diffOblotzkyRows,
  oblotzkyChangeId,
  parseOblotzkyScheduleHtml,
  validateOblotzkyRows
} from '../scripts/oblotzky-safety.mjs';

const products = [
  'Motif',
  'Gurokawa',
  'Mizu R2',
  'Centinela',
  'BRG R2',
  'Prussian Alert',
  'Thunder God',
  'Masterpiece R2',
  'Noire R2',
  'TA Neo'
];

function fixture() {
  const rows = products.map((name, index) =>
    `<tr><td>${name}</td><td>${index === 1 ? '22 Sept 2026' : '14 Sept 2026'}</td><td>${index === 1 ? 'Colormatching completed &amp; shipping soon' : 'In production'}</td></tr>`
  ).join('');

  return `<html><body>
    <table><tr><th>Wrong</th></tr><tr><td>ignore</td></tr></table>
    <table class="schedule">
      <thead><tr><th>Project</th><th>Last Updated</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </body></html>`;
}

test('parses the schedule table by headers and decodes entities', () => {
  const rows = parseOblotzkyScheduleHtml(fixture());
  assert.equal(rows.length, 10);
  assert.deepEqual(rows[1], {
    project: 'Gurokawa',
    lastUpdated: '22 Sept 2026',
    status: 'Colormatching completed & shipping soon'
  });
});

test('validation rejects malformed date columns', () => {
  const rows = Array.from({ length: 10 }, (_, index) => ({
    project: `Project ${index}`,
    lastUpdated: '14 Sept 2026',
    status: 'In production'
  }));
  assert.equal(validateOblotzkyRows(rows).length, 10);

  rows[0].lastUpdated = 'In production';
  assert.throws(() => validateOblotzkyRows(rows), /lastUpdated was not recognized/);
});

test('diff reports status and update-date changes without positional matching', () => {
  const previous = parseOblotzkyScheduleHtml(fixture());
  const current = structuredClone(previous).reverse();
  const target = current.find((row) => row.project === 'Gurokawa');
  target.lastUpdated = '28 Sept 2026';
  target.status = 'Shipping';

  const changes = diffOblotzkyRows(previous, current);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].row.project, 'Gurokawa');
  assert.deepEqual(changes[0].fields.map((field) => field.field), ['lastUpdated', 'status']);
});

test('change IDs include the Oblotzky project identity', () => {
  const a = {
    kind: 'changed',
    row: { project: 'Alpha' },
    fields: [{ field: 'status', before: 'In production', after: 'Shipping' }]
  };
  const b = {
    kind: 'changed',
    row: { project: 'Bravo' },
    fields: [{ field: 'status', before: 'In production', after: 'Shipping' }]
  };
  assert.notEqual(oblotzkyChangeId(a), oblotzkyChangeId(b));
});
