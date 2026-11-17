// SWAGKEYS 판매·입고 일정 DB 파서.
//
// 기존 키캡 로드맵(`Swagkeys Keycap Roadmap 2026`)과 진행현황 DB는 SWG/SWS 키캡만 다룬다.
// 아래 두 DB는 스웨그키가 키보드·GMK·스위치·마우스까지 포함해 예약판매 일정과
// 일반 입고 일정을 직접 관리하는 표다.
//   1. 예약판매 품목 현황 — 판매일정(시작~마감), 상태, 브랜드, 카테고리
//   2. 일반 품목 입고 현황 — 입고일자, 배송 예상, 상태, 브랜드, 카테고리
// 이 모듈은 Notion 응답 형태만 다루고 네트워크 호출은 하지 않는다.

export const SCHEDULE_SOURCES = Object.freeze({
  reservations: Object.freeze({
    key: 'reservations',
    label: '예약판매 품목 현황',
    pageId: '35df75d5-3601-8082-bac3-f5697dd4bfd0',
    collectionId: '35df75d5-3601-819d-9408-000b0d830df9',
    viewId: '35df75d5-3601-8180-b979-000cf8949a84',
    url: 'https://swagkeys.notion.site/35df75d536018082bac3f5697dd4bfd0'
  }),
  instock: Object.freeze({
    key: 'instock',
    label: '일반 품목 입고 현황',
    pageId: 'caee1072-540c-44b2-bf5a-4548df992908',
    collectionId: 'c8d4ed73-d624-425d-98d5-c6b0ec5abbe5',
    viewId: '3afb8b01-ad89-4417-9909-762c03e01b62',
    url: 'https://swagkeys.notion.site/caee1072540c44b2bf5a4548df992908'
  })
});

// 기존 공제 마감 알림(gb-deadlines)과 같은 D-3 · D-1 · D-day 기준을 쓴다.
export const SCHEDULE_CLOSING_OFFSETS = Object.freeze([3, 1, 0]);

// 마감 알림은 아직 구매할 수 있는 상태에서만 보낸다. 생산 중·배송 중·발송완료·샘플링은 제외.
const ACTIVE_SALE_STATUS_RE = /^(?:공제\s*중|판매\s*중)$/;

const clean = (value) => String(value ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();

function unwrapNotionRecord(record) {
  return record?.value?.value ?? record?.value ?? record ?? null;
}

function notionText(value) {
  if (!Array.isArray(value)) return clean(value);
  return value.map((part) => {
    if (Array.isArray(part)) return String(part[0] ?? '');
    return String(part ?? '');
  }).join('').trim();
}

function notionDateRange(value) {
  let found = null;
  const visit = (node) => {
    if (found || node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (typeof node === 'object') {
      if (typeof node.start_date === 'string') {
        found = {
          start: node.start_date,
          end: typeof node.end_date === 'string' ? node.end_date : ''
        };
        return;
      }
      for (const item of Object.values(node)) visit(item);
    }
  };
  visit(value);
  return found || { start: '', end: '' };
}

// Notion 날짜 값은 날짜만 오거나 시각이 붙어 온다. 일정 비교는 KST 날짜 단위로 한다.
export function normalizeScheduleDate(value) {
  const text = clean(value);
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : '';
}

function propertyId(schema, matcher) {
  return Object.entries(schema || {}).find(([, definition]) => matcher(definition || {}))?.[0] || '';
}

function multiSelectValues(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => clean(Array.isArray(entry) ? entry[0] : entry))
    .filter(Boolean);
}

// 같은 이름·카테고리 품목이 표에 두 줄 이상 있을 수 있다(EVO80, DP104 등).
// 그럴 때만 블록 id 앞자리를 붙여 서로 다른 품목으로 구분한다.
function withScheduleKeys(rows) {
  const baseKey = (row) => [row.category, row.product].map((value) => clean(value).toLowerCase()).join('|');
  const counts = new Map();
  for (const row of rows) {
    const key = baseKey(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return rows.map((row) => {
    const key = baseKey(row);
    return {
      ...row,
      key: counts.get(key) > 1 ? `${key}#${String(row.id).slice(0, 8)}` : key
    };
  });
}

export function parseScheduleCollectionRows(collectionData, sourceKey) {
  const source = SCHEDULE_SOURCES[sourceKey];
  if (!source) throw new Error(`Unknown SWAGKEYS schedule source: ${sourceKey}`);

  const blocks = collectionData?.recordMap?.block || {};
  const collectionRecord = Object.values(collectionData?.recordMap?.collection || {})
    .map(unwrapNotionRecord)
    .find((record) => record?.schema);
  const schema = collectionRecord?.schema || {};

  const ids = {
    title: propertyId(schema, (definition) => definition.type === 'title'),
    status: propertyId(schema, (definition) => /상태/.test(clean(definition.name))),
    sale: propertyId(schema, (definition) => /판매\s*일정/.test(clean(definition.name))),
    arrival: propertyId(schema, (definition) => /입고\s*일자/.test(clean(definition.name))),
    order: propertyId(schema, (definition) => /발주\s*일자/.test(clean(definition.name))),
    brand: propertyId(schema, (definition) => /브랜드/.test(clean(definition.name))),
    category: propertyId(schema, (definition) => /카테고리/.test(clean(definition.name))),
    eta: propertyId(schema, (definition) => /배송\s*예상/.test(clean(definition.name))),
    url: propertyId(schema, (definition) => /제품\s*정보/.test(clean(definition.name)))
  };
  if (!ids.title) throw new Error(`SWAGKEYS ${source.label} collection is missing a title property`);

  const blockIds = collectionData?.result?.reducerResults?.collection_group_results?.blockIds
    || Object.keys(blocks);
  const rows = [];
  for (const blockId of blockIds) {
    const block = unwrapNotionRecord(blocks[blockId]);
    if (!block || block.alive === false) continue;
    const properties = block.properties || {};
    const product = clean(notionText(properties[ids.title]));
    if (!product) continue;
    const sale = ids.sale ? notionDateRange(properties[ids.sale]) : { start: '', end: '' };
    rows.push({
      id: blockId,
      product,
      category: clean(notionText(properties[ids.category])),
      brands: multiSelectValues(properties[ids.brand]),
      status: clean(notionText(properties[ids.status])),
      saleStart: normalizeScheduleDate(sale.start),
      saleEnd: normalizeScheduleDate(sale.end),
      arrivalDate: ids.arrival ? normalizeScheduleDate(notionDateRange(properties[ids.arrival]).start) : '',
      orderDate: ids.order ? normalizeScheduleDate(notionDateRange(properties[ids.order]).start) : '',
      eta: clean(notionText(properties[ids.eta])),
      url: clean(notionText(properties[ids.url]))
    });
  }
  return withScheduleKeys(rows);
}

export function formatScheduleSale(item) {
  const start = clean(item?.saleStart);
  const end = clean(item?.saleEnd);
  if (!start && !end) return '미정';
  return `${start || '미정'} ~ ${end || '미정'}`;
}

// 품목 이동·삭제가 아니라 실제 값 변경만 알린다.
// 상태·판매일정·입고일자·배송 예상을 비교하고, 브랜드/카테고리 표기 변경은 소음이라 무시한다.
export function diffScheduleItems(previousItems = [], currentItems = []) {
  const previous = new Map((previousItems || []).map((item) => [item.key, item]));
  const current = new Map((currentItems || []).map((item) => [item.key, item]));
  const added = [];
  const removed = [];
  const changed = [];

  for (const [key, item] of current) {
    const before = previous.get(key);
    if (!before) {
      added.push(item);
      continue;
    }
    const fields = [];
    if (clean(before.status) !== clean(item.status)) {
      fields.push({ key: 'status', label: '상태', before: before.status || '—', after: item.status || '—' });
    }
    if (clean(before.saleStart) !== clean(item.saleStart) || clean(before.saleEnd) !== clean(item.saleEnd)) {
      fields.push({ key: 'sale', label: '판매 일정', before: formatScheduleSale(before), after: formatScheduleSale(item) });
    }
    if (clean(before.arrivalDate) !== clean(item.arrivalDate)) {
      fields.push({ key: 'arrival', label: '입고일자', before: before.arrivalDate || '—', after: item.arrivalDate || '—' });
    }
    if (clean(before.eta) !== clean(item.eta)) {
      fields.push({ key: 'eta', label: '배송 예상', before: before.eta || '—', after: item.eta || '—' });
    }
    if (fields.length) changed.push({ key, item, before, fields });
  }

  for (const [key, item] of previous) {
    if (!current.has(key)) removed.push(item);
  }
  return { added, removed, changed };
}

// 로드맵에 이미 있는 품목(SWG/SWS 키캡)은 기존 GB 마감 알림이 맡는다.
// 두 소스가 같은 마감을 두 번 알리지 않도록 비교용 키를 만든다.
export function scheduleProductKey(value) {
  return clean(value).toLowerCase().replace(/[^0-9a-z가-힣]/g, '');
}

export function kstDayString(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(now));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function scheduleClosingKey(item, offset) {
  return `${item?.key || ''}|${clean(item?.saleEnd)}|${offset}`;
}

// 판매 마감이 offsets(D-3·D-1·D-day)에 걸린 예약판매 품목을 고른다.
// notified에 이미 기록된 (품목, 마감일, 오프셋)은 다시 보내지 않는다.
export function dueScheduleClosings({
  items = [],
  notified = {},
  now = new Date(),
  offsets = SCHEDULE_CLOSING_OFFSETS,
  skipProductKeys = []
} = {}) {
  const today = kstDayString(now);
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const skip = new Set(skipProductKeys);
  const due = [];

  for (const item of items || []) {
    const saleEnd = clean(item?.saleEnd);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(saleEnd)) continue;
    if (!ACTIVE_SALE_STATUS_RE.test(clean(item.status))) continue;
    if (skip.has(scheduleProductKey(item.product))) continue;
    const offset = Math.round((Date.parse(`${saleEnd}T00:00:00Z`) - todayMs) / 86400000);
    if (!offsets.includes(offset)) continue;
    const key = scheduleClosingKey(item, offset);
    if (notified[key]) continue;
    due.push({ key, item, offset, saleEnd });
  }

  return due.sort((a, b) => a.offset - b.offset || a.item.product.localeCompare(b.item.product, 'ko'));
}

// 오래된 알림 기록은 같은 품목이 다음 분기에 다시 열릴 때를 위해 일정 기간만 남긴다.
export function pruneScheduleClosings(notified = {}, now = new Date(), retentionDays = 400) {
  const cutoff = Date.parse(`${kstDayString(now)}T00:00:00Z`) - retentionDays * 86400000;
  const kept = {};
  for (const [key, day] of Object.entries(notified || {})) {
    const parsed = Date.parse(`${clean(day)}T00:00:00Z`);
    if (!Number.isFinite(parsed) || parsed >= cutoff) kept[key] = day;
  }
  return kept;
}
