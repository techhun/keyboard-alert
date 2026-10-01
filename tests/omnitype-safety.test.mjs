import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OMNITYPE_PAGE_URL,
  diffOmnitypeRows,
  omnitypeChangeId,
  parseOmnitypeUpdatesHtml,
  validateOmnitypeRows
} from '../scripts/omnitype-safety.mjs';

function wrapper(product, body) {
  return '<div class="accordion__wrapper">' +
    '<button class="accordion__title js" data-accordion-trigger="x">' + product + '</button>' +
    '<div class="accordion__body rte" data-accordion-body>' + body + '</div>' +
    '</div>';
}

function fixture() {
  return '<html><body><section class="section-faq">' +
    '<p class="standard__kicker">GROUPBUYS and preorders</p>' +
    wrapper('Enso-E', '<p>Updated delivery time - November 2026</p><ul><li>Magnets - ready</li><li>PCBs - ready</li></ul>') +
    wrapper('Float 65', '<p>Now estimated to deliver in November 2026.</p><ul><li>Housings - delayed, manufacturing issue.</li></ul>') +
    wrapper('Wing', '<p>These are estimated to arrive to us Q1 2027.</p>') +
    '</section></body></html>';
}

test('parses Omnitype accordion products with overview and component progress', () => {
  const rows = parseOmnitypeUpdatesHtml(fixture());
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0], {
    product: 'Enso-E',
    overview: 'Updated delivery time - November 2026',
    components: ['Magnets - ready', 'PCBs - ready'],
    sourceUrl: OMNITYPE_PAGE_URL
  });
  assert.deepEqual(rows[2].components, []);
});

test('validation rejects suspiciously small or malformed Omnitype data', () => {
  const rows = parseOmnitypeUpdatesHtml(fixture());
  assert.equal(validateOmnitypeRows(rows), rows);
  assert.throws(() => validateOmnitypeRows(rows.slice(0, 2)), /suspiciously few rows/);

  const bad = structuredClone(rows);
  bad[0].sourceUrl = 'https://example.com';
  assert.throws(() => validateOmnitypeRows(bad), /unexpected source URL/);
});

test('diff is product-identity based and detects overview and component changes', () => {
  const previous = parseOmnitypeUpdatesHtml(fixture());
  const current = structuredClone(previous).reverse();
  const target = current.find((row) => row.product === 'Enso-E');
  target.overview = 'Updated delivery time - December 2026';
  target.components = ['Magnets - ready', 'PCBs - in production'];

  const changes = diffOmnitypeRows(previous, current);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].row.product, 'Enso-E');
  assert.deepEqual(changes[0].fields.map((field) => field.field), ['overview', 'components']);
});

test('diff detects additions and removals', () => {
  const previous = parseOmnitypeUpdatesHtml(fixture());
  const current = previous.filter((row) => row.product !== 'Wing');
  current.push({
    product: 'Bauer 65',
    overview: 'Q4 2026',
    components: ['Housings - production queue'],
    sourceUrl: OMNITYPE_PAGE_URL
  });

  const changes = diffOmnitypeRows(previous, current);
  assert.equal(changes.filter((change) => change.kind === 'removed').length, 1);
  assert.equal(changes.filter((change) => change.kind === 'added').length, 1);
});

test('change IDs differ for distinct component updates', () => {
  const a = {
    kind: 'changed',
    row: { product: 'Enso-E', overview: 'November', components: ['PCB - ready'], sourceUrl: OMNITYPE_PAGE_URL },
    fields: [{ field: 'components', before: 'PCB - queued', after: 'PCB - ready' }]
  };
  const b = structuredClone(a);
  b.fields[0].after = 'PCB - shipped';
  assert.notEqual(omnitypeChangeId(a), omnitypeChangeId(b));
});
