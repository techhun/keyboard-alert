import fs from 'node:fs';
import { createHash } from 'node:crypto';

export const KEEPODD_EVENTS_PATH = 'keepodd-events.json';
export const KEEPODD_MAX_EVENTS = 500;
export const GEONWORKS_UPDATE_URL = 'https://geonworks.kr/customhtml/GB_schedule.html';
export const GEONWORKS_RELEASE_UPDATE_URL = 'https://geonworks.kr/customhtml/release/release.html';
export const SWAGKEYS_UPDATE_URL = 'https://swagkeys.notion.site/swg-keycap-roadmap';
export const SWAGKEYS_STATUS_URL = 'https://swagkeys.notion.site/3b5f75d536018064b051e6a663b41d35';
export const SWAGKEYS_SCHEDULE_URL = 'https://swagkeys.notion.site/35df75d536018082bac3f5697dd4bfd0';
// Keepodd 이벤트 종류. 판매 일정 변경(시작/종료)은 상태 변경과 분리해 따로 전달한다.
export const KEEPODD_EVENT_TYPES = Object.freeze([
  'new_gb', 'eta_changed', 'status_changed', 'note_changed', 'sale_start_changed', 'sale_end_changed'
]);
const DATE_EVENT_TYPES = new Set(['eta_changed', 'sale_start_changed', 'sale_end_changed']);
// 표에서 잠깐 빠졌다가 다시 들어온 구작이 '신규 GB'로 오탐되지 않도록, GB 시작일이 이 기간보다
// 오래된 행은 신규로 승격하지 않는다.
export const GB_NEW_FRESHNESS_DAYS = 45;
const GEONWORKS_PRODUCTS_URL = 'https://geonworks.kr/category/products/47/';
const SWAGKEYS_PRODUCTS_JSON_URL = 'https://swagkeys.com/products.json';
const PRODUCT_CATALOG_MAX_PAGES = 10;
const SWAGKEYS_PRODUCTS_PAGE_LIMIT = 250;

export function cleanKeepoddValue(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function meaningful(value) {
  const text = cleanKeepoddValue(value);
  return /^(?:—|–|-)$/u.test(text) ? '' : text;
}

export function normalizeKeepoddDate(value) {
  const text = meaningful(value);
  if (!text) return '';
  const match = text.match(/^(\d{4})\D+(\d{1,2})\D+(\d{1,2})(?:\D.*)?$/);
  if (!match) return text;
  return `${match[1]}-${String(Number(match[2])).padStart(2, '0')}-${String(Number(match[3])).padStart(2, '0')}`;
}

function stripDecorations(value) {
  return cleanKeepoddValue(value)
    .replace(/^(?:상품명|product\s*name)\s*[:：]\s*/i, ' ')
    .replace(/\[(?:예약판매|예판|group[- ]?buy|pre[- ]?order|in[- ]?stock)\]/gi, ' ')
    .replace(/\((?:국내\s*)?인스탁\s*판매\)/gi, ' ')
    .replace(/\(in[- ]?stock\)/gi, ' ')
    .replace(/\s+(?:keyboard\s*kit|키캡|keycaps?)$/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 원본 표의 알려진 오타를 보정한다. GMK NTNU Dasher / GMK MTNU Dasher가 두 건으로 갈라지지 않게 한다.
function correctKnownTypos(value) {
  return cleanKeepoddValue(value).replace(/\bntnu\b/gi, 'MTNU');
}

export function canonicalProductKey(source, value) {
  let text = stripDecorations(correctKnownTypos(value)).toLocaleLowerCase('en-US');
  if (String(source).toUpperCase() === 'SWAGKEYS') {
    text = text.replace(/^(?:swg|sws)\s+/i, '');
  }
  return text.replace(/[^a-z0-9가-힣]+/g, '');
}

// 이벤트 중복 판정용 키. SWAGKEYS는 SWG/SWS 계열을 남겨 'SWG Beige'와 'SWS Beige'를
// 서로 다른 제품으로 유지한다(다른 제품이 같은 신규 GB로 합쳐지지 않도록).
export function eventIdentityKey(source, value) {
  const key = canonicalProductKey(source, value);
  if (!key || String(source).toUpperCase() !== 'SWAGKEYS') return key;
  const raw = cleanKeepoddValue(value);
  const family = /^sws\b/i.test(raw) ? 'sws' : /^swg\b/i.test(raw) ? 'swg' : '';
  return family ? `${family}:${key}` : key;
}

function identityValue(value) {
  return meaningful(value).toLocaleLowerCase('en-US');
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

// 날짜 필드가 실제 날짜인지 확인하고 아니면 빈 값을 돌려준다('미정' 등).
function isoDay(value) {
  const normalized = normalizeKeepoddDate(value);
  return ISO_DAY.test(normalized) ? normalized : '';
}

function dayAge(value, nowIso) {
  const day = isoDay(value);
  const now = Date.parse(`${isoDay(nowIso) || String(nowIso).slice(0, 10)}T00:00:00Z`);
  const stamp = Date.parse(`${day}T00:00:00Z`);
  if (!ISO_DAY.test(day) || !Number.isFinite(now) || !Number.isFinite(stamp)) return null;
  return Math.round((now - stamp) / 86_400_000);
}

// GB 시작일이 충분히 최근일 때만 '신규 GB'로 취급한다. 날짜를 알 수 없으면 판단하지 않고 허용한다.
export function gbStartIsFresh(value, nowIso, maxAgeDays = GB_NEW_FRESHNESS_DAYS) {
  const age = dayAge(value, nowIso);
  if (age === null) return true;
  return age <= maxAgeDays;
}

function kstDayOf(nowIso) {
  const stamp = Date.parse(nowIso);
  if (!Number.isFinite(stamp)) return isoDay(nowIso);
  return new Date(stamp + 9 * 3_600_000).toISOString().slice(0, 10);
}

export function deterministicKeepoddEventId(event, canonicalKey = canonicalProductKey(event?.source, event?.name)) {
  const source = cleanKeepoddValue(event?.source).toUpperCase();
  const type = cleanKeepoddValue(event?.eventType).toLowerCase();
  const before = identityValue(event?.before);
  const after = identityValue(event?.after);
  return createHash('sha256')
    .update([source, canonicalKey, type, before, after].join('|'))
    .digest('hex')
    .slice(0, 32);
}

function cleanCategoryHint(value) {
  const text = cleanKeepoddValue(value).toLocaleLowerCase('en-US');
  if (text === '키보드' || text.includes('keyboard')) return '키보드';
  if (text === '키캡' || text.includes('keycap')) return '키캡';
  if (text === '액세서리' || text.includes('accessor')) return '액세서리';
  return undefined;
}

function eventFrom({ source, name, eventType, before, after, occurredAt, row = {}, quarter, fallbackUrl, canonicalKey, idAfter }) {
  const event = {
    source,
    name: cleanKeepoddValue(name),
    eventType,
    ...(meaningful(before) ? { before: DATE_EVENT_TYPES.has(eventType) ? normalizeKeepoddDate(before) : meaningful(before) } : {}),
    ...(meaningful(after) ? { after: DATE_EVENT_TYPES.has(eventType) ? normalizeKeepoddDate(after) : meaningful(after) } : {}),
    occurredAt,
    ...(cleanCategoryHint(row.type) ? { categoryHint: cleanCategoryHint(row.type) } : {}),
    ...(meaningful(row.manufacturer) ? { maker: meaningful(row.manufacturer) } : {}),
    ...(normalizeKeepoddDate(row.gbStart ?? row.saleStart) ? { saleStart: normalizeKeepoddDate(row.gbStart ?? row.saleStart) } : {}),
    ...(normalizeKeepoddDate(row.saleEnd ?? row.end) ? { saleEnd: normalizeKeepoddDate(row.saleEnd ?? row.end) } : {}),
    ...(normalizeKeepoddDate(row.eta) ? { eta: normalizeKeepoddDate(row.eta) } : {}),
    ...(meaningful(row.status ?? row.currentStatus) ? { status: meaningful(row.status ?? row.currentStatus) } : {}),
    ...(meaningful(row.note) ? { note: meaningful(row.note) } : {}),
    ...(quarter ? { quarter } : {}),
    sourceUrl: fallbackUrl,
    sourceUrlType: 'update'
  };
  const idInput = idAfter === undefined ? event : { ...event, after: idAfter };
  return { id: deterministicKeepoddEventId(idInput, canonicalKey), ...event };
}

export function buildGeonworksKeepoddEvents(changes = [], options = {}) {
  const occurredAt = options.occurredAt || new Date().toISOString();
  const fallbackUrl = options.fallbackUrl || GEONWORKS_UPDATE_URL;
  const result = [];

  for (const change of changes || []) {
    const row = change?.row || {};
    if (!meaningful(row.product)) continue;
    const canonicalKey = canonicalProductKey('GEONWORKS', row.product);

    if (change.kind === 'added') {
      // 목록에서 잠깐 빠졌다 다시 들어온 구작은 신규 GB가 아니다.
      if (!gbStartIsFresh(row.gbStart, occurredAt)) {
        options.onSkip?.({ source: 'GEONWORKS', name: row.product, reason: 'stale-gb-start', gbStart: normalizeKeepoddDate(row.gbStart) });
        continue;
      }
      result.push(eventFrom({
        source: 'GEONWORKS', name: row.product, eventType: 'new_gb', occurredAt, row, fallbackUrl, canonicalKey,
        idAfter: normalizeKeepoddDate(row.gbStart) || 'present'
      }));
      continue;
    }
    if (change.kind !== 'changed') continue;

    for (const field of change.fields || []) {
      const eventType = field.field === 'eta' ? 'eta_changed'
        : field.field === 'status' ? 'status_changed'
          : field.field === 'note' ? 'note_changed'
            : field.field === 'gbStart' ? 'sale_start_changed'
              : '';
      if (!eventType) continue;
      result.push(eventFrom({
        source: 'GEONWORKS', name: row.product, eventType,
        before: field.before, after: field.after, occurredAt, row, fallbackUrl, canonicalKey
      }));
    }
  }
  return result;
}


export function isConfirmedGeonworksReleaseGroupBuy(row = {}) {
  const saleType = meaningful(row.saleType).toLocaleLowerCase('en-US');
  const fixed = meaningful(row.fixed).toLocaleLowerCase('en-US');
  const status = meaningful(row.status).toLocaleLowerCase('en-US');
  return saleType === 'group buy'
    && fixed === '확정 / fixed'
    && !/interest\s*check|(?:^|\W)ic(?:$|\W)/i.test(status);
}

export function buildGeonworksReleaseKeepoddEvents(changes = [], options = {}) {
  const occurredAt = options.occurredAt || new Date().toISOString();
  const fallbackUrl = options.fallbackUrl || GEONWORKS_RELEASE_UPDATE_URL;
  const result = [];

  for (const change of changes || []) {
    const row = change?.row || {};
    if (!meaningful(row.product) || !isConfirmedGeonworksReleaseGroupBuy(row)) continue;

    const canonicalKey = canonicalProductKey('GEONWORKS', row.product);
    const becameConfirmed = change.kind === 'added'
      || (change.kind === 'changed' && !isConfirmedGeonworksReleaseGroupBuy(change.before || {}));

    if (becameConfirmed) {
      if (!gbStartIsFresh(row.start, occurredAt)) {
        options.onSkip?.({ source: 'GEONWORKS', name: row.product, reason: 'stale-gb-start', gbStart: normalizeKeepoddDate(row.start) });
        continue;
      }
      result.push(eventFrom({
        source: 'GEONWORKS',
        name: row.product,
        eventType: 'new_gb',
        occurredAt,
        row: { ...row, gbStart: row.start },
        fallbackUrl,
        canonicalKey,
        idAfter: normalizeKeepoddDate(row.start) || 'present'
      }));
      continue;
    }

    if (change.kind !== 'changed') continue;
    // 이미 확정된 GB의 판매 시작·종료일 정정도 Keepodd까지 전달한다.
    for (const field of change.fields || []) {
      const eventType = field.field === 'start' ? 'sale_start_changed'
        : field.field === 'end' ? 'sale_end_changed'
          : '';
      if (!eventType) continue;
      result.push(eventFrom({
        source: 'GEONWORKS',
        name: row.product,
        eventType,
        before: field.before,
        after: field.after,
        occurredAt,
        row: { ...row, gbStart: row.start },
        fallbackUrl,
        canonicalKey
      }));
    }
  }

  return result;
}

function swagDisplayName(rawName, quarters = {}) {
  const raw = cleanKeepoddValue(rawName);
  if (/^(?:swg|sws)\b/i.test(raw)) return raw;
  const key = canonicalProductKey('SWAGKEYS', raw);
  for (const products of Object.values(quarters || {})) {
    for (const product of products || []) {
      if (canonicalProductKey('SWAGKEYS', product) === key) return cleanKeepoddValue(product)
        .replace(/\s*\((?:국내\s*)?인스탁\s*판매\)\s*$/i, '')
        .replace(/\s*\(in[- ]?stock\)\s*$/i, '')
        .trim();
    }
  }
  return `SWG ${raw}`;
}

function swagQuarterFor(name, quarters = {}) {
  const raw = cleanKeepoddValue(name);
  // Prefer the exact qualified name: SWG Beige (Q1) and SWS Beige (Q4) coexist.
  for (const [quarter, products] of Object.entries(quarters || {})) {
    if ((products || []).some(product => cleanKeepoddValue(product).toLocaleLowerCase('en-US') === raw.toLocaleLowerCase('en-US'))) return quarter;
  }
  const key = canonicalProductKey('SWAGKEYS', name);
  for (const [quarter, products] of Object.entries(quarters || {})) {
    if ((products || []).some(product => canonicalProductKey('SWAGKEYS', product) === key)) return quarter;
  }
  return '';
}

function swagRoadmapDate(name, dates = {}) {
  const key = canonicalProductKey('SWAGKEYS', name);
  return (/^sws\s/i.test(name) ? dates[`sws:${key}`] : dates[key]) || dates[key] || dates[`sws:${key}`] || {};
}

function swagRowMap(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    const key = canonicalProductKey('SWAGKEYS', row?.product);
    if (key) map.set(key, row);
  }
  return map;
}

function swagEventRow(row = {}, roadmapDates = {}) {
  const colorMatching = meaningful(row.colorMatching);
  // 로드맵에 아직 날짜가 없을 때는 진행현황 행의 날짜로 보강해, 신규 GB 이벤트에
  // 판매 일정이 빠지지 않게 한다(SWG Nightshift / SWG Forest Cadet 사례).
  return {
    eta: row.eta,
    currentStatus: row.currentStatus,
    status: row.currentStatus,
    manufacturer: 'Swagkeys',
    type: 'Keycap',
    saleStart: roadmapDates?.saleStart || row.saleStart,
    saleEnd: roadmapDates?.saleEnd || row.saleEnd,
    ...(colorMatching ? { note: `컬러매칭 ${colorMatching}` } : {})
  };
}

function saleRangeLabel(value = {}) {
  const start = normalizeKeepoddDate(value?.saleStart);
  const end = normalizeKeepoddDate(value?.saleEnd);
  if (start && end) return `${start} ~ ${end}`;
  if (start) return `${start} ~ 미정`;
  if (end) return `미정 ~ ${end}`;
  return '미정';
}

export function buildSwagkeysKeepoddEvents({
  changes = [],
  quarterChanges = {},
  starts = [],
  snapshot = {},
  occurredAt = new Date().toISOString(),
  roadmapFallbackUrl = SWAGKEYS_UPDATE_URL,
  statusFallbackUrl = SWAGKEYS_STATUS_URL,
  onSkip
} = {}) {
  const events = new Map();
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  const quarters = snapshot.quarters || {};
  const roadmapDates = snapshot.roadmapDates || {};
  const rowByKey = swagRowMap(rows);

  if (snapshot.roadmapFresh !== false) {
    for (const item of quarterChanges.added || []) {
      const name = cleanKeepoddValue(item.product);
      const canonicalKey = canonicalProductKey('SWAGKEYS', name);
      if (!canonicalKey) continue;
      if (!gbStartIsFresh(swagRoadmapDate(name, roadmapDates)?.saleStart, occurredAt)) {
        onSkip?.({ source: 'SWAGKEYS', name, reason: 'stale-gb-start' });
        continue;
      }
      const row = rowByKey.get(canonicalKey) || {};
      const event = eventFrom({
        source: 'SWAGKEYS', name, eventType: 'new_gb', occurredAt,
        row: swagEventRow(row, swagRoadmapDate(name, roadmapDates)), quarter: item.quarter, fallbackUrl: roadmapFallbackUrl, canonicalKey,
        idAfter: item.quarter || 'present'
      });
      events.set(event.id, event);
    }
  }

  if (snapshot.roadmapFresh !== false) {
    for (const item of quarterChanges.datesChanged || []) {
      const name = cleanKeepoddValue(item.product);
      const canonicalKey = canonicalProductKey('SWAGKEYS', name);
      if (!canonicalKey) continue;
      const row = rowByKey.get(canonicalKey) || {};
      const currentDates = swagRoadmapDate(name, roadmapDates);
      const verifiedDates = currentDates.saleStart || currentDates.saleEnd ? currentDates : (item.after || {});
      const current = swagEventRow(row, verifiedDates);
      const before = saleRangeLabel(item.before);
      const after = saleRangeLabel(item.after);
      const quarter = swagQuarterFor(name, quarters);
      const event = eventFrom({
        source: 'SWAGKEYS', name, eventType: 'note_changed', before, after, occurredAt,
        row: current, quarter, fallbackUrl: roadmapFallbackUrl, canonicalKey
      });
      event.note = `판매 일정 ${after}`;
      events.set(event.id, event);
    }
  }

  if (snapshot.roadmapFresh !== false) {
    for (const start of starts || []) {
      const name = cleanKeepoddValue(start?.product);
      const canonicalKey = canonicalProductKey('SWAGKEYS', name);
      if (!name || !canonicalKey || !start?.saleStart) continue;
      const row = rowByKey.get(canonicalKey) || {};
      const dates = { saleStart: start.saleStart, saleEnd: start.saleEnd };
      const after = `GB 시작 ${saleRangeLabel(dates)}`;
      const event = eventFrom({
        source: 'SWAGKEYS', name, eventType: 'note_changed',
        after, occurredAt, row: swagEventRow(row, dates),
        quarter: swagQuarterFor(name, quarters), fallbackUrl: roadmapFallbackUrl,
        canonicalKey, idAfter: `gb-start:${start.saleStart}`
      });
      event.note = after;
      events.set(event.id, event);
    }
  }

  if (snapshot.statusFresh !== false) {
    for (const change of changes || []) {
      const row = change?.row || {};
      if (!meaningful(row.product)) continue;
      const canonicalKey = canonicalProductKey('SWAGKEYS', row.product);
      const name = swagDisplayName(row.product, quarters);
      const quarter = swagQuarterFor(name, quarters);
      const current = swagEventRow(row, swagRoadmapDate(name, roadmapDates));

      if (change.kind === 'added') {
        if (!gbStartIsFresh(swagRoadmapDate(name, roadmapDates)?.saleStart, occurredAt)) {
          onSkip?.({ source: 'SWAGKEYS', name, reason: 'stale-gb-start' });
          continue;
        }
        const event = eventFrom({
          source: 'SWAGKEYS', name, eventType: 'new_gb', occurredAt, row: current,
          quarter, fallbackUrl: statusFallbackUrl, canonicalKey, idAfter: quarter || 'present'
        });
        events.set(event.id, event);
        continue;
      }
      if (change.kind !== 'changed') continue;

      for (const field of change.fields || []) {
        const eventType = field.key === 'eta' ? 'eta_changed'
          : field.key === 'currentStatus' ? 'status_changed'
            : field.key === 'colorMatching' ? 'note_changed'
              : '';
        if (!eventType) continue;
        const before = field.key === 'colorMatching' && meaningful(field.before) ? `컬러매칭 ${meaningful(field.before)}` : field.before;
        const after = field.key === 'colorMatching' && meaningful(field.after) ? `컬러매칭 ${meaningful(field.after)}` : field.after;
        const event = eventFrom({
          source: 'SWAGKEYS', name, eventType, before, after, occurredAt,
          row: current, quarter, fallbackUrl: statusFallbackUrl, canonicalKey
        });
        if (eventType === 'note_changed') event.note = meaningful(after);
        events.set(event.id, event);
      }
    }
  }

  return [...events.values()];
}

// SWAGKEYS 예약판매 품목 현황(키보드·GMK·스위치 포함)은 로드맵·진행현황과 다른 표다.
// 디스코드에만 가던 이 표의 변동을 Keepodd 이벤트로도 내려보낸다.
const SCHEDULE_ACTIVE_STATUS = /^(?:공제\s*중|판매\s*중)$/;

function scheduleDisplayName(value) {
  return cleanKeepoddValue(value).replace(/^\[[^\]]*\]\s*/, '').trim();
}

function parseSaleRangeLabel(value) {
  const text = cleanKeepoddValue(value);
  const [start, end] = text.split('~').map((part) => normalizeKeepoddDate(part));
  return { start: isoDay(start), end: isoDay(end) };
}

function scheduleRow(item = {}) {
  const start = isoDay(item.saleStart);
  const end = isoDay(item.saleEnd);
  const range = start || end ? `${start || '미정'} ~ ${end || '미정'}` : '미정';
  return {
    type: item.category,
    manufacturer: Array.isArray(item.brands) ? item.brands[0] : undefined,
    status: item.status,
    saleStart: start,
    saleEnd: end,
    note: `예약판매 ${range}`
  };
}

export function buildSwagkeysScheduleKeepoddEvents({
  current = [],
  changed = [],
  occurredAt = new Date().toISOString(),
  fallbackUrl = SWAGKEYS_SCHEDULE_URL
} = {}) {
  const events = new Map();

  // 현재 예약판매 중인 품목. 처음 한 번 '신규 GB'로 등장하고,
  // 같은 제품의 판매일정이 바뀌면 새 이벤트 id가 생기지만 merge 단계에서 신규 GB 중복은 막힌다.
  const today = kstDayOf(occurredAt);
  for (const item of current || []) {
    const rawName = meaningful(item?.product);
    if (!rawName || !SCHEDULE_ACTIVE_STATUS.test(meaningful(item.status))) continue;
    if (!gbStartIsFresh(item.saleStart, occurredAt)) continue;
    // 이미 판매가 끝난 예약판매는 '신규 GB'로 띄우지 않는다.
    const end = isoDay(item.saleEnd);
    if (end && today && end < today) continue;
    const name = scheduleDisplayName(rawName);
    const canonicalKey = canonicalProductKey('SWAGKEYS', name);
    if (!canonicalKey) continue;
    const event = eventFrom({
      source: 'SWAGKEYS', name, eventType: 'new_gb', occurredAt,
      row: scheduleRow(item), fallbackUrl, canonicalKey,
      idAfter: `schedule:${isoDay(item.saleStart)}:${isoDay(item.saleEnd)}`
    });
    events.set(event.id, event);
  }

  for (const change of changed || []) {
    const item = change?.item || {};
    const rawName = meaningful(item.product);
    if (!rawName) continue;
    const name = scheduleDisplayName(rawName);
    const canonicalKey = canonicalProductKey('SWAGKEYS', name);
    if (!canonicalKey) continue;
    const row = scheduleRow(item);

    for (const field of change.fields || []) {
      if (field.key === 'sale') {
        const before = parseSaleRangeLabel(field.before);
        const after = parseSaleRangeLabel(field.after);
        if (before.start !== after.start) {
          const event = eventFrom({
            source: 'SWAGKEYS', name, eventType: 'sale_start_changed',
            before: before.start || field.before, after: after.start || field.after,
            occurredAt, row, fallbackUrl, canonicalKey
          });
          events.set(event.id, event);
        }
        if (before.end !== after.end) {
          const event = eventFrom({
            source: 'SWAGKEYS', name, eventType: 'sale_end_changed',
            before: before.end || field.before, after: after.end || field.after,
            occurredAt, row, fallbackUrl, canonicalKey
          });
          events.set(event.id, event);
        }
        continue;
      }

      const eventType = field.key === 'status' ? 'status_changed'
        : field.key === 'eta' ? 'eta_changed'
          : '';
      if (!eventType) continue;
      const event = eventFrom({
        source: 'SWAGKEYS', name, eventType,
        before: field.before, after: field.after,
        occurredAt, row, fallbackUrl, canonicalKey
      });
      events.set(event.id, event);
    }
  }

  return [...events.values()];
}

function validEvent(event) {
  return Boolean(event && meaningful(event.id) && ['GEONWORKS', 'SWAGKEYS'].includes(cleanKeepoddValue(event.source).toUpperCase())
    && KEEPODD_EVENT_TYPES.includes(cleanKeepoddValue(event.eventType))
    && meaningful(event.name));
}

export function loadKeepoddEvents(path = KEEPODD_EVENTS_PATH) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
    const events = Array.isArray(parsed?.events) ? parsed.events.filter(validEvent) : [];
    return { version: 1, updatedAt: cleanKeepoddValue(parsed?.updatedAt) || new Date(0).toISOString(), events };
  } catch {
    return { version: 1, updatedAt: new Date(0).toISOString(), events: [] };
  }
}

function eventTime(event) {
  const time = Date.parse(event?.occurredAt || '');
  return Number.isFinite(time) ? time : 0;
}

export function mergeKeepoddEvents(feed, newEvents = [], { now = new Date().toISOString(), maxEvents = KEEPODD_MAX_EVENTS } = {}) {
  const existing = Array.isArray(feed?.events) ? feed.events.filter(validEvent) : [];
  const byId = new Map(existing.map((event) => [event.id, event]));
  const newGbIdentity = (event) => {
    const key = eventIdentityKey(event?.source, event?.name);
    return key ? `${cleanKeepoddValue(event?.source).toUpperCase()}:${key}` : '';
  };
  const newGbKeys = new Set(existing
    .filter((event) => cleanKeepoddValue(event.eventType) === 'new_gb')
    .map(newGbIdentity)
    .filter(Boolean));
  let added = 0;

  for (const raw of newEvents || []) {
    if (!raw?.name || !raw?.eventType || !raw?.source) continue;
    const source = cleanKeepoddValue(raw.source).toUpperCase();
    const eventType = cleanKeepoddValue(raw.eventType);
    const identity = newGbIdentity({ ...raw, source });
    if (eventType === 'new_gb' && identity && newGbKeys.has(identity)) continue;

    const id = raw.id || deterministicKeepoddEventId(raw);
    if (!id || byId.has(id)) continue;
    byId.set(id, { ...raw, id, occurredAt: raw.occurredAt || now });
    if (eventType === 'new_gb' && identity) newGbKeys.add(identity);
    added += 1;
  }

  const events = [...byId.values()]
    .sort((a, b) => eventTime(a) - eventTime(b) || String(a.id).localeCompare(String(b.id)))
    .slice(-Math.max(1, Number(maxEvents) || KEEPODD_MAX_EVENTS));
  const changedByPrune = events.length !== existing.length + added;
  return {
    feed: {
      version: 1,
      updatedAt: added > 0 || changedByPrune ? now : (cleanKeepoddValue(feed?.updatedAt) || now),
      events
    },
    added
  };
}

function atomicWriteJson(path, value) {
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tempPath, path);
}

export function appendKeepoddEvents(newEvents = [], { path = KEEPODD_EVENTS_PATH, now = new Date().toISOString(), maxEvents = KEEPODD_MAX_EVENTS } = {}) {
  const current = loadKeepoddEvents(path);
  const merged = mergeKeepoddEvents(current, newEvents, { now, maxEvents });
  if (merged.added > 0 || merged.feed.events.length !== current.events.length) atomicWriteJson(path, merged.feed);
  return merged;
}

export function commitStateAndKeepoddEvents({ statePath, stateValue, events = [], eventsPath = KEEPODD_EVENTS_PATH, now = new Date().toISOString(), maxEvents = KEEPODD_MAX_EVENTS }) {
  const currentFeed = loadKeepoddEvents(eventsPath);
  const merged = mergeKeepoddEvents(currentFeed, events, { now, maxEvents });
  const stateBefore = fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : null;
  const eventsBefore = fs.existsSync(eventsPath) ? fs.readFileSync(eventsPath, 'utf8') : null;

  try {
    atomicWriteJson(statePath, stateValue);
    if (merged.added > 0 || merged.feed.events.length !== currentFeed.events.length) atomicWriteJson(eventsPath, merged.feed);
  } catch (error) {
    try {
      if (stateBefore === null) fs.rmSync(statePath, { force: true }); else fs.writeFileSync(statePath, stateBefore);
      if (eventsBefore === null) fs.rmSync(eventsPath, { force: true }); else fs.writeFileSync(eventsPath, eventsBefore);
    } catch {}
    throw error;
  }
  return merged;
}

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ');
}

function textFromHtml(value) {
  return cleanKeepoddValue(decodeHtml(String(value ?? '').replace(/<[^>]+>/g, ' ')));
}

export function parseGeonworksCatalogHtml(html, baseUrl = 'https://geonworks.kr/') {
  const byUrl = new Map();
  const re = /<a\b[^>]*href=["']([^"']*\/product\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let match;
  while ((match = re.exec(String(html ?? '')))) {
    const title = textFromHtml(match[2]);
    if (!title) continue;
    let url;
    try { url = new URL(decodeHtml(match[1]), baseUrl).href; } catch { continue; }
    const previous = byUrl.get(url);
    if (!previous || title.length > previous.title.length) byUrl.set(url, { title, url });
  }
  return [...byUrl.values()];
}

export function parseSwagkeysProductsJson(payload) {
  const data = typeof payload === 'string' ? JSON.parse(payload) : payload;
  return (Array.isArray(data?.products) ? data.products : [])
    .map((product) => ({
      title: cleanKeepoddValue(product?.title),
      url: product?.handle ? `https://swagkeys.com/products/${product.handle}` : ''
    }))
    .filter((product) => product.title && product.url);
}

export function findExactProductUrl(source, name, catalog = []) {
  const key = canonicalProductKey(source, name);
  if (!key) return '';
  const matches = [...new Set((catalog || [])
    .filter((item) => canonicalProductKey(source, item?.title) === key)
    .map((item) => cleanKeepoddValue(item?.url))
    .filter(Boolean))];
  return matches.length === 1 ? matches[0] : '';
}

async function fetchWithTimeout(fetchImpl, url, timeoutMs) {
  return fetchImpl(url, {
    headers: { accept: 'application/json,text/html;q=0.9,*/*;q=0.8', 'user-agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(timeoutMs)
  });
}

export async function fetchProductCatalog(source, {
  fetchImpl = fetch,
  timeoutMs = 7000,
  maxPages = PRODUCT_CATALOG_MAX_PAGES
} = {}) {
  const pageLimit = Math.max(1, Number(maxPages) || PRODUCT_CATALOG_MAX_PAGES);

  if (source === 'SWAGKEYS') {
    const catalog = [];
    const seenUrls = new Set();

    for (let page = 1; page <= pageLimit; page += 1) {
      const url = `${SWAGKEYS_PRODUCTS_JSON_URL}?limit=${SWAGKEYS_PRODUCTS_PAGE_LIMIT}&page=${page}`;
      const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
      if (!response.ok) throw new Error(`SWAGKEYS products catalog HTTP ${response.status}`);
      const products = parseSwagkeysProductsJson(await response.json());
      let added = 0;

      for (const product of products) {
        if (seenUrls.has(product.url)) continue;
        seenUrls.add(product.url);
        catalog.push(product);
        added += 1;
      }

      if (products.length < SWAGKEYS_PRODUCTS_PAGE_LIMIT || added === 0) break;
    }

    return catalog;
  }

  if (source === 'GEONWORKS') {
    const catalog = [];
    const seenUrls = new Set();

    for (let page = 1; page <= pageLimit; page += 1) {
      const url = `${GEONWORKS_PRODUCTS_URL}?page=${page}`;
      const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
      if (!response.ok) throw new Error(`GEONWORKS products catalog HTTP ${response.status}`);
      const products = parseGeonworksCatalogHtml(await response.text(), url);
      let added = 0;

      for (const product of products) {
        if (seenUrls.has(product.url)) continue;
        seenUrls.add(product.url);
        catalog.push(product);
        added += 1;
      }

      if (products.length === 0 || added === 0) break;
    }

    return catalog;
  }

  return [];
}

export async function enrichKeepoddEventSourceUrls(events = [], options = {}) {
  const result = (events || []).map((event) => ({ ...event }));
  const sources = [...new Set(result.map((event) => event.source).filter((source) => source === 'GEONWORKS' || source === 'SWAGKEYS'))];

  for (const source of sources) {
    try {
      const catalog = options.catalogs?.[source] || await fetchProductCatalog(source, options);
      let exactMatches = 0;
      let fallbacks = 0;

      for (const event of result) {
        if (event.source !== source) continue;
        const url = findExactProductUrl(source, event.name, catalog);
        if (url) {
          event.sourceUrl = url;
          event.sourceUrlType = 'product';
          exactMatches += 1;
        } else {
          fallbacks += 1;
        }
      }

      console.log(`Keepodd ${source} source URL resolution: exact=${exactMatches}, fallback=${fallbacks}, catalog=${catalog.length}`);
    } catch (error) {
      console.warn(`Keepodd ${source} product URL lookup failed; using update-page fallback: ${error?.message || error}`);
    }
  }
  return result;
}
