import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendKeepoddEvents,
  buildGeonworksKeepoddEvents,
  buildGeonworksReleaseKeepoddEvents,
  buildSwagkeysKeepoddEvents,
  canonicalProductKey,
  deterministicKeepoddEventId,
  enrichKeepoddEventSourceUrls,
  findExactProductUrl,
  loadKeepoddEvents,
  mergeKeepoddEvents,
  parseGeonworksCatalogHtml,
  parseSwagkeysProductsJson
} from '../scripts/lib/keepodd-events.mjs';

const at = '2026-10-12T10:00:00.000Z';

function geonRow(overrides = {}) {
  return {
    product: 'GMK CYL Test',
    gbStart: '2026. 10. 12',
    eta: '2027. 3. 31',
    type: 'Keycap',
    manufacturer: 'GMK',
    status: '판매 중 / GB on sale',
    update: '2026. 10. 12',
    note: '—',
    ...overrides
  };
}

function releaseRow(overrides = {}) {
  return {
    product: 'GMK CYL Test',
    manufacturer: 'GMK',
    region: 'KR/GLOBAL',
    saleType: 'Group Buy',
    type: 'Keycaps',
    status: 'For Sale',
    fixed: '확정 / Fixed',
    start: '2026-10-13',
    end: '2026-11-02',
    ...overrides
  };
}

function swagRow(overrides = {}) {
  return {
    product: 'Classic Red',
    groupBuy: 100,
    waitingProduction: 100,
    inProduction: 100,
    shipping: 50,
    fulfilled: 0,
    inStock: 0,
    colorMatching: 'Complete',
    eta: '2026-10-19',
    currentStatus: '배송중 (Shipping)',
    ...overrides
  };
}

test('baseline/no changes creates zero events', () => {
  assert.deepEqual(buildGeonworksKeepoddEvents([], { occurredAt: at }), []);
  assert.deepEqual(buildSwagkeysKeepoddEvents({ changes: [], quarterChanges: { added: [] }, snapshot: { rows: [], quarters: {}, roadmapFresh: true, statusFresh: true }, occurredAt: at }), []);
});

test('GEONWORKS added row creates exactly one new_gb', () => {
  const events = buildGeonworksKeepoddEvents([{ kind: 'added', row: geonRow() }], { occurredAt: at });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'new_gb');
  assert.equal(events[0].name, 'GMK CYL Test');
  assert.equal(events[0].categoryHint, '키캡');
  assert.equal(events[0].saleStart, '2026-10-12');
  assert.equal(events[0].eta, '2027-03-31');
});

test('GEONWORKS ETA A -> B creates one eta_changed with exact before/after', () => {
  const events = buildGeonworksKeepoddEvents([{
    kind: 'changed', row: geonRow({ eta: '2027. 4. 30' }),
    fields: [{ field: 'eta', before: '2027. 3. 31', after: '2027. 4. 30' }]
  }], { occurredAt: at });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'eta_changed');
  assert.equal(events[0].before, '2027-03-31');
  assert.equal(events[0].after, '2027-04-30');
});

test('GEONWORKS status change creates status_changed', () => {
  const events = buildGeonworksKeepoddEvents([{
    kind: 'changed', row: geonRow({ status: '생산 중' }),
    fields: [{ field: 'status', before: '생산 대기', after: '생산 중' }]
  }], { occurredAt: at });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'status_changed');
});

test('GEONWORKS note change creates note_changed while update-only changes are ignored', () => {
  const events = buildGeonworksKeepoddEvents([{
    kind: 'changed', row: geonRow({ note: '검수 완료' }),
    fields: [
      { field: 'note', before: '검수 중', after: '검수 완료' },
      { field: 'update', before: '2026. 10. 11', after: '2026. 10. 12' }
    ]
  }], { occurredAt: at });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'note_changed');
  assert.equal(events[0].after, '검수 완료');
});

test('one product ETA + status change creates two events', () => {
  const events = buildGeonworksKeepoddEvents([{
    kind: 'changed', row: geonRow({ eta: '2027. 4. 30', status: '생산 중' }),
    fields: [
      { field: 'eta', before: '2027. 3. 31', after: '2027. 4. 30' },
      { field: 'status', before: '생산 대기', after: '생산 중' }
    ]
  }], { occurredAt: at });
  assert.deepEqual(events.map((event) => event.eventType).sort(), ['eta_changed', 'status_changed']);
  assert.notEqual(events[0].id, events[1].id);
});

test('deterministic ID is stable and transition-sensitive', () => {
  const event = { source: 'GEONWORKS', name: 'GMK CYL Test', eventType: 'status_changed', before: 'A', after: 'B' };
  assert.equal(deterministicKeepoddEventId(event), deterministicKeepoddEventId(structuredClone(event)));
  assert.notEqual(deterministicKeepoddEventId(event), deterministicKeepoddEventId({ ...event, after: 'C' }));
});

test('same event rerun does not append duplicate', () => {
  const events = buildGeonworksKeepoddEvents([{ kind: 'added', row: geonRow() }], { occurredAt: at });
  const first = mergeKeepoddEvents({ version: 1, updatedAt: at, events: [] }, events, { now: at });
  const second = mergeKeepoddEvents(first.feed, events, { now: '2026-10-12T11:00:00.000Z' });
  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.equal(second.feed.events.length, 1);
});

test('GEONWORKS Release IC addition creates zero Keepodd events', () => {
  const events = buildGeonworksReleaseKeepoddEvents([{
    kind: 'added',
    row: releaseRow({ status: 'Interest Check (IC)', fixed: '' })
  }], { occurredAt: at });
  assert.equal(events.length, 0);
});

test('GEONWORKS Release IC -> Fixed transition creates one new_gb event', () => {
  const before = releaseRow({ status: 'Interest Check (IC)', fixed: '' });
  const row = releaseRow();
  const events = buildGeonworksReleaseKeepoddEvents([{
    kind: 'changed',
    before,
    row,
    fields: [
      { field: 'status', before: before.status, after: row.status },
      { field: 'fixed', before: before.fixed, after: row.fixed }
    ]
  }], { occurredAt: at });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'new_gb');
  assert.equal(events[0].saleStart, '2026-10-13');
  assert.equal(events[0].sourceUrlType, 'update');
  assert.equal(events[0].sourceUrl, 'https://geonworks.kr/customhtml/release/release.html');
});

test('GEONWORKS Release already-Fixed addition creates one new_gb event', () => {
  const events = buildGeonworksReleaseKeepoddEvents([{
    kind: 'added',
    row: releaseRow()
  }], { occurredAt: at });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'new_gb');
});

test('GEONWORKS Release changes on an already-confirmed GB do not create another new_gb', () => {
  const before = releaseRow({ end: '2026-11-01' });
  const row = releaseRow({ end: '2026-11-02' });
  const events = buildGeonworksReleaseKeepoddEvents([{
    kind: 'changed',
    before,
    row,
    fields: [{ field: 'end', before: before.end, after: row.end }]
  }], { occurredAt: at });
  assert.equal(events.length, 0);
});

test('GEONWORKS Release new_gb is deduped when GB Schedule already emitted the same canonical product', () => {
  const gb = buildGeonworksKeepoddEvents([{
    kind: 'added',
    row: geonRow({ product: 'GMK CYL Test', gbStart: '2026. 10. 12' })
  }], { occurredAt: at });
  const release = buildGeonworksReleaseKeepoddEvents([{
    kind: 'added',
    row: releaseRow({ product: 'GMK CYL Test', start: '2026-10-13' })
  }], { occurredAt: '2026-10-13T01:00:00.000Z' });

  const first = mergeKeepoddEvents({ version: 1, updatedAt: at, events: [] }, gb, { now: at });
  const second = mergeKeepoddEvents(first.feed, release, { now: '2026-10-13T01:00:00.000Z' });
  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.equal(second.feed.events.filter((event) => event.eventType === 'new_gb').length, 1);
});

test('GEONWORKS Release rerun does not duplicate new_gb', () => {
  const release = buildGeonworksReleaseKeepoddEvents([{
    kind: 'added',
    row: releaseRow()
  }], { occurredAt: at });
  const first = mergeKeepoddEvents({ version: 1, updatedAt: at, events: [] }, release, { now: at });
  const second = mergeKeepoddEvents(first.feed, release, { now: '2026-10-13T01:00:00.000Z' });
  assert.equal(first.added, 1);
  assert.equal(second.added, 0);
  assert.equal(second.feed.events.length, 1);
});

test('SWAGKEYS roadmap/status addition collapses to one new_gb event', () => {
  const row = swagRow();
  const events = buildSwagkeysKeepoddEvents({
    changes: [{ kind: 'added', row }],
    quarterChanges: { added: [{ product: 'SWG Classic Red', quarter: 'Q1' }] },
    snapshot: { rows: [row], quarters: { Q1: ['SWG Classic Red'] }, roadmapFresh: true, statusFresh: true },
    occurredAt: at
  });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'new_gb');
  assert.equal(events[0].name, 'SWG Classic Red');
  assert.equal(events[0].quarter, 'Q1');
});

test('SWAGKEYS eta/currentStatus/colorMatching map to supported types and progress-only does not', () => {
  const row = swagRow({ eta: '2026-10-31', currentStatus: '생산 완료', colorMatching: 'Approved' });
  const events = buildSwagkeysKeepoddEvents({
    changes: [{ kind: 'changed', row, fields: [
      { key: 'eta', before: '2026-10-19', after: '2026-10-31' },
      { key: 'currentStatus', before: '배송중', after: '생산 완료' },
      { key: 'colorMatching', before: 'Complete', after: 'Approved' },
      { key: 'shipping', before: 50, after: 100, type: 'percent' }
    ] }],
    quarterChanges: { added: [] },
    snapshot: { rows: [row], quarters: { Q1: ['SWG Classic Red'] }, roadmapFresh: true, statusFresh: true },
    occurredAt: at
  });
  assert.deepEqual(events.map((event) => event.eventType).sort(), ['eta_changed', 'note_changed', 'status_changed']);
});

test('SWAGKEYS stored fallback sources do not produce events', () => {
  const row = swagRow();
  const events = buildSwagkeysKeepoddEvents({
    changes: [{ kind: 'added', row }],
    quarterChanges: { added: [{ product: 'SWG Classic Red', quarter: 'Q1' }] },
    snapshot: { rows: [row], quarters: { Q1: ['SWG Classic Red'] }, roadmapFresh: false, statusFresh: false },
    occurredAt: at
  });
  assert.equal(events.length, 0);
});

test('GEONWORKS then SWAGKEYS append preserves both sources, and reverse order also does', () => {
  const geon = buildGeonworksKeepoddEvents([{ kind: 'added', row: geonRow() }], { occurredAt: at });
  const swag = buildSwagkeysKeepoddEvents({
    changes: [{ kind: 'added', row: swagRow() }], quarterChanges: { added: [] },
    snapshot: { rows: [swagRow()], quarters: { Q1: ['SWG Classic Red'] }, roadmapFresh: true, statusFresh: true }, occurredAt: at
  });
  let feed = mergeKeepoddEvents({ version: 1, updatedAt: at, events: [] }, geon, { now: at }).feed;
  feed = mergeKeepoddEvents(feed, swag, { now: at }).feed;
  assert.deepEqual(new Set(feed.events.map((event) => event.source)), new Set(['GEONWORKS', 'SWAGKEYS']));
  let reverse = mergeKeepoddEvents({ version: 1, updatedAt: at, events: [] }, swag, { now: at }).feed;
  reverse = mergeKeepoddEvents(reverse, geon, { now: at }).feed;
  assert.deepEqual(new Set(reverse.events.map((event) => event.source)), new Set(['GEONWORKS', 'SWAGKEYS']));
});

test('event retention trims oldest records beyond 500', () => {
  const events = Array.from({ length: 505 }, (_, index) => ({
    id: `id-${String(index).padStart(3, '0')}`,
    source: 'GEONWORKS', name: `Product ${index}`, eventType: 'new_gb',
    occurredAt: new Date(Date.parse('2026-01-01T00:00:00Z') + index * 1000).toISOString()
  }));
  const merged = mergeKeepoddEvents({ version: 1, updatedAt: at, events: [] }, events, { now: at, maxEvents: 500 });
  assert.equal(merged.feed.events.length, 500);
  assert.equal(merged.feed.events[0].id, 'id-005');
  assert.equal(merged.feed.events.at(-1).id, 'id-504');
});

test('appendKeepoddEvents preserves events from multiple checkers on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepodd-events-'));
  const file = path.join(dir, 'keepodd-events.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, updatedAt: at, events: [] }));
  const geon = buildGeonworksKeepoddEvents([{ kind: 'added', row: geonRow() }], { occurredAt: at });
  appendKeepoddEvents(geon, { path: file, now: at });
  const swag = buildSwagkeysKeepoddEvents({
    changes: [{ kind: 'added', row: swagRow() }], quarterChanges: { added: [] },
    snapshot: { rows: [swagRow()], quarters: { Q1: ['SWG Classic Red'] }, roadmapFresh: true, statusFresh: true }, occurredAt: at
  });
  appendKeepoddEvents(swag, { path: file, now: at });
  const loaded = loadKeepoddEvents(file);
  assert.equal(loaded.events.length, 2);
});

test('SWAGKEYS exact catalog match resolves product page', async () => {
  const catalog = parseSwagkeysProductsJson({ products: [
    { title: 'SWG Classic Red', handle: 'group-buy-swg-classic-red' },
    { title: 'SWG Classic Blue', handle: 'group-buy-swg-classic-blue' }
  ] });
  assert.equal(findExactProductUrl('SWAGKEYS', 'Classic Red', catalog), 'https://swagkeys.com/products/group-buy-swg-classic-red');
  const events = await enrichKeepoddEventSourceUrls([
    { id: 'x', source: 'SWAGKEYS', name: 'SWG Classic Red', eventType: 'new_gb', occurredAt: at, sourceUrl: 'fallback', sourceUrlType: 'update' }
  ], { catalogs: { SWAGKEYS: catalog } });
  assert.equal(events[0].sourceUrlType, 'product');
  assert.equal(events[0].sourceUrl, 'https://swagkeys.com/products/group-buy-swg-classic-red');
});

test('GEONWORKS exact title resolves while ambiguous/fuzzy name safely falls back', async () => {
  const html = `
    <a href="/product/gmk-varenye/101/category/47/display/1/"><span>[예약판매] GMK CYL Varenye 키캡</span></a>
    <a href="/product/supernova-pc/102/category/47/display/1/">[예약판매] SENSY Supernova PC Top Case Barebone Kit</a>
    <a href="/product/supernova-alu/103/category/47/display/1/">[예약판매] SENSY Supernova Alu Top Case Barebone Kit</a>`;
  const catalog = parseGeonworksCatalogHtml(html);
  assert.match(findExactProductUrl('GEONWORKS', 'GMK CYL Varenye', catalog), /gmk-varenye/);
  assert.equal(findExactProductUrl('GEONWORKS', 'Supernova', catalog), '');
  const events = await enrichKeepoddEventSourceUrls([
    { id: 'x', source: 'GEONWORKS', name: 'Supernova', eventType: 'new_gb', occurredAt: at, sourceUrl: 'https://geonworks.kr/customhtml/GB_schedule.html', sourceUrlType: 'update' }
  ], { catalogs: { GEONWORKS: catalog } });
  assert.equal(events[0].sourceUrlType, 'update');
  assert.equal(events[0].sourceUrl, 'https://geonworks.kr/customhtml/GB_schedule.html');
});

test('canonical SWAGKEYS key removes known prefix but does not fuzzy-match longer names', () => {
  assert.equal(canonicalProductKey('SWAGKEYS', 'SWG Classic Red'), canonicalProductKey('SWAGKEYS', 'Classic Red'));
  assert.notEqual(canonicalProductKey('SWAGKEYS', 'Classic Red'), canonicalProductKey('SWAGKEYS', 'Classic Red Light'));
});
