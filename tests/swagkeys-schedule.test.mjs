import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEDULE_CLOSING_OFFSETS,
  SCHEDULE_SOURCES,
  diffScheduleItems,
  dueScheduleClosings,
  formatScheduleSale,
  kstDayString,
  normalizeScheduleDate,
  parseScheduleCollectionRows,
  pruneScheduleClosings,
  scheduleProductKey
} from '../scripts/lib/swagkeys-schedule.mjs';
import {
  buildScheduleEvents,
  scheduleAddedEmbed,
  scheduleChangedEmbed,
  scheduleClosingEmbed
} from '../scripts/check-swagkeys.mjs';

const wrapped = (value) => ({ value: { value } });
const text = (value) => [[value]];

const SCHEMA = {
  title: { name: '품명', type: 'title' },
  '<S=i': { name: '배송 예상 일정', type: 'text' },
  '>=Mo': { name: '발주일자', type: 'date' },
  '^:zG': { name: '판매일정', type: 'date' },
  fAAG: { name: '카테고리', type: 'select' },
  'gRR|': { name: '브랜드', type: 'multi_select' },
  'u|gA': { name: '상태', type: 'status' },
  vJkF: { name: '제품 정보', type: 'url' },
  '{kqv': { name: '입고일자', type: 'date' }
};

const range = (start, end) => [['‣', [['d', { type: 'daterange', start_date: start, end_date: end }]]]];
const singleDate = (start) => [['‣', [['d', { type: 'date', start_date: start }]]]];

function collectionData(rows, schema = SCHEMA) {
  return {
    recordMap: {
      block: Object.fromEntries(rows.map((row) => [
        row.id,
        wrapped({ id: row.id, alive: true, properties: row.properties })
      ])),
      collection: {
        'col-1': wrapped({ schema, name: text('예약판매 품목 현황') })
      }
    },
    result: {
      reducerResults: {
        collection_group_results: { blockIds: rows.map((row) => row.id), total: rows.length, hasMore: false }
      }
    }
  };
}

const row = (id, properties) => ({ id, properties });

const realRows = [
  row('aaaaaaaa-0000-0000-0000-000000000001', {
    title: [['GMK CYL Purple']],
    '^:zG': range('2026-10-12', '2026-11-23'),
    fAAG: [['키캡']],
    'gRR|': [['GMK']],
    'u|gA': [['공제 중']],
    vJkF: [['https://swagkeys.com/products/gmk-cyl-purple', [['a', 'https://swagkeys.com/products/gmk-cyl-purple']]]]
  }),
  row('aaaaaaaa-0000-0000-0000-000000000002', {
    title: [['Zen75']],
    '<S=i': [['26년 11월']],
    fAAG: [['키보드']],
    'gRR|': [['Cerakey']],
    'u|gA': [['판매중']],
    '{kqv': singleDate('2026-11-10')
  })
];

test('parses the SWAGKEYS schedule collection into normalized items', () => {
  const items = parseScheduleCollectionRows(collectionData(realRows), 'reservations');
  assert.equal(items.length, 2);

  const purple = items.find((item) => item.product === 'GMK CYL Purple');
  assert.equal(purple.category, '키캡');
  assert.deepEqual(purple.brands, ['GMK']);
  assert.equal(purple.status, '공제 중');
  assert.equal(purple.saleStart, '2026-10-12');
  assert.equal(purple.saleEnd, '2026-11-23');
  assert.equal(purple.url, 'https://swagkeys.com/products/gmk-cyl-purple');
  assert.equal(purple.key, '키캡|gmk cyl purple');

  const zen = items.find((item) => item.product === 'Zen75');
  assert.equal(zen.arrivalDate, '2026-11-10');
  assert.equal(zen.eta, '26년 11월');
  assert.equal(zen.saleStart, '');
  assert.equal(formatScheduleSale(zen), '미정');
});

test('schedule dates keep only the calendar day and reject malformed values', () => {
  assert.equal(normalizeScheduleDate('2026-11-23'), '2026-11-23');
  assert.equal(normalizeScheduleDate('2026-11-23T12:30:00.000+09:00'), '2026-11-23');
  assert.equal(normalizeScheduleDate('26년 11월'), '');
  assert.equal(normalizeScheduleDate(null), '');
});

test('duplicate product rows stay distinct and a missing title property fails loudly', () => {
  const duplicates = [
    row('bbbbbbbb-1111-1111-1111-111111111111', { title: [['EVO80']], fAAG: [['키보드']], 'u|gA': [['판매중']] }),
    row('cccccccc-2222-2222-2222-222222222222', { title: [['EVO80']], fAAG: [['키보드']], 'u|gA': [['생산 중']] })
  ];
  const items = parseScheduleCollectionRows(collectionData(duplicates), 'instock');
  assert.equal(items.length, 2);
  assert.notEqual(items[0].key, items[1].key);
  assert.ok(items.every((item) => item.key.startsWith('키보드|evo80#')));

  assert.throws(
    () => parseScheduleCollectionRows(collectionData(realRows, { fAAG: { name: '카테고리', type: 'select' } }), 'instock'),
    /missing a title property/
  );
  assert.throws(() => parseScheduleCollectionRows(collectionData(realRows), 'unknown'), /Unknown SWAGKEYS schedule source/);
});

test('diff reports new products, status/schedule/arrival changes, and removals', () => {
  const before = parseScheduleCollectionRows(collectionData(realRows), 'reservations');
  const after = parseScheduleCollectionRows(collectionData([
    row('aaaaaaaa-0000-0000-0000-000000000001', {
      title: [['GMK CYL Purple']],
      '^:zG': range('2026-10-12', '2026-11-30'),
      fAAG: [['키캡']],
      'gRR|': [['GMK']],
      'u|gA': [['생산 중']]
    }),
    row('dddddddd-3333-3333-3333-333333333333', {
      title: [['NEO80 Cu']],
      '^:zG': range('2026-11-06', '2027-02-28'),
      fAAG: [['키보드']],
      'gRR|': [['NEO STUDIO']],
      'u|gA': [['공제 중']]
    })
  ]), 'reservations');

  const diff = diffScheduleItems(before, after);
  assert.deepEqual(diff.added.map((item) => item.product), ['NEO80 Cu']);
  assert.deepEqual(diff.removed.map((item) => item.product), ['Zen75']);
  assert.equal(diff.changed.length, 1);
  const change = diff.changed[0];
  assert.equal(change.item.product, 'GMK CYL Purple');
  assert.deepEqual(change.fields.map((field) => field.key), ['status', 'sale']);
  assert.equal(change.fields[0].before, '공제 중');
  assert.equal(change.fields[0].after, '생산 중');
  assert.equal(change.fields[1].before, '2026-10-12 ~ 2026-11-23');
  assert.equal(change.fields[1].after, '2026-10-12 ~ 2026-11-30');
});

test('closing reminders fire on D-3/D-1/D-day only for buyable reservations not on the roadmap', () => {
  const items = parseScheduleCollectionRows(collectionData([
    row('eeeeeeee-4444-4444-4444-444444444444', {
      title: [['GMK CYL Purple']], '^:zG': range('2026-10-12', '2026-11-23'), 'u|gA': [['공제 중']], fAAG: [['키캡']]
    }),
    row('ffffffff-5555-5555-5555-555555555555', {
      title: [['SWG Moomin']], '^:zG': range('2026-11-13', '2026-11-23'), 'u|gA': [['공제 중']], fAAG: [['키캡']]
    }),
    row('99999999-6666-6666-6666-666666666666', {
      title: [['SWG Nightshift']], '^:zG': range('2026-10-30', '2026-11-23'), 'u|gA': [['생산 중']], fAAG: [['키캡']]
    })
  ]), 'reservations');

  const now = new Date('2026-11-20T03:00:00+09:00'); // KST 2026-11-20, D-3 before 11-23
  const due = dueScheduleClosings({
    items,
    notified: {},
    now,
    skipProductKeys: ['SWG Moomin'].map(scheduleProductKey)
  });

  assert.equal(due.length, 1);
  assert.equal(due[0].item.product, 'GMK CYL Purple');
  assert.equal(due[0].offset, 3);
  assert.equal(due[0].saleEnd, '2026-11-23');
  assert.equal(due[0].key, '키캡|gmk cyl purple|2026-11-23|3');

  const repeated = dueScheduleClosings({
    items,
    notified: { '키캡|gmk cyl purple|2026-11-23|3': '2026-11-20' },
    now,
    skipProductKeys: ['SWG Moomin'].map(scheduleProductKey)
  });
  assert.deepEqual(repeated, []);

  const dayOf = dueScheduleClosings({ items, notified: {}, now: new Date('2026-11-23T08:10:00+09:00'), skipProductKeys: ['SWG Moomin'].map(scheduleProductKey) });
  assert.deepEqual(dayOf.map((entry) => entry.offset), [0]);
});

test('closing offsets match the existing GB deadline reminders', () => {
  assert.deepEqual([...SCHEDULE_CLOSING_OFFSETS], [3, 1, 0]);
});

test('old closing records are pruned and recent ones are kept', () => {
  const pruned = pruneScheduleClosings({
    recent: kstDayString(new Date()),
    old: '2024-01-01'
  }, new Date('2026-11-20T00:00:00+09:00'));
  assert.deepEqual(Object.keys(pruned), ['recent']);
});

test('buildScheduleEvents stores a baseline first and only sees changes afterwards', () => {
  const schedule = {
    sources: {
      reservations: { items: parseScheduleCollectionRows(collectionData(realRows), 'reservations'), fresh: true },
      instock: { items: [], fresh: false }
    },
    fallbackSince: {}
  };

  const baseline = buildScheduleEvents({ schedule, previous: null, now: new Date('2026-11-20T00:00:00+09:00') });
  assert.equal(baseline.baseline, true);
  assert.equal(baseline.added.length, 0);
  assert.equal(baseline.changed.length, 0);
  assert.equal(baseline.nextState.initialized, true);
  assert.equal(baseline.nextState.sources.reservations.items.length, 2);

  const next = buildScheduleEvents({
    schedule,
    previous: baseline.nextState,
    now: new Date('2026-11-20T00:00:00+09:00')
  });
  assert.equal(next.baseline, false);
  assert.equal(next.added.length, 0);
  assert.equal(next.changed.length, 0);
});

test('a stale schedule source keeps its stored rows and produces no events', () => {
  const previous = {
    version: 1,
    initialized: true,
    sources: {
      reservations: { items: parseScheduleCollectionRows(collectionData(realRows), 'reservations') },
      instock: { items: [] }
    },
    closingsNotified: {},
    fallbackSince: {}
  };
  const schedule = {
    sources: {
      reservations: { items: previous.sources.reservations.items, fresh: false },
      instock: { items: [], fresh: false }
    },
    fallbackSince: { reservations: '2026-11-19T00:00:00.000Z' }
  };

  const events = buildScheduleEvents({ schedule, previous, now: new Date('2026-11-20T00:00:00+09:00') });
  assert.equal(events.added.length, 0);
  assert.equal(events.changed.length, 0);
  assert.deepEqual(events.nextState.fallbackSince, { reservations: '2026-11-19T00:00:00.000Z' });
});

test('schedule embeds carry the DB link, product state, and the closing day', () => {
  const item = parseScheduleCollectionRows(collectionData(realRows), 'reservations')
    .find((entry) => entry.product === 'GMK CYL Purple');

  const added = scheduleAddedEmbed('reservations', item, '2026-11-20T00:00:00.000Z');
  assert.match(added.title, /🆕 SWAGKEYS 예약판매 품목 현황 등록 · GMK CYL Purple/);
  assert.equal(added.url, SCHEDULE_SOURCES.reservations.url);
  assert.ok(added.fields.some((field) => field.name === '판매 일정' && field.value === '2026-10-12 ~ 2026-11-23'));
  assert.ok(added.fields.some((field) => String(field.value).includes('swagkeys.com/products/gmk-cyl-purple')));

  const changed = scheduleChangedEmbed('reservations', {
    item,
    fields: [{ key: 'status', label: '상태', before: '공제 중', after: '생산 중' }]
  }, '2026-11-20T00:00:00.000Z');
  assert.match(changed.title, /🔄 SWAGKEYS 예약판매 품목 현황 변경 · GMK CYL Purple/);
  assert.equal(changed.fields[0].name, '상태 변경');
  assert.equal(changed.fields[0].value, '이전: 공제 중\n현재: 생산 중');
  assert.equal(changed.fields.filter((field) => field.name === '상태').length, 0);

  const closing = scheduleClosingEmbed({ item, offset: 3, saleEnd: '2026-11-23' }, '2026-11-20T00:00:00.000Z');
  assert.match(closing.title, /⏳ SWAGKEYS 예약판매 마감 D-3 · GMK CYL Purple/);
  assert.ok(closing.fields.some((field) => field.name === '마감일' && field.value === '2026-11-23'));
});
