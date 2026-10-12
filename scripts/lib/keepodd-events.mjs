import fs from 'node:fs';
import { createHash } from 'node:crypto';

export const KEEPODD_EVENTS_PATH = 'keepodd-events.json';
export const KEEPODD_MAX_EVENTS = 500;
export const GEONWORKS_UPDATE_URL = 'https://geonworks.kr/customhtml/GB_schedule.html';
export const SWAGKEYS_UPDATE_URL = 'https://swagkeys.notion.site/swg-keycap-roadmap';
const GEONWORKS_PRODUCTS_URLS = [
  'https://geonworks.kr/category/products/47/?page=1',
  'https://geonworks.kr/category/products/47/?page=2'
];
const SWAGKEYS_PRODUCTS_JSON_URL = 'https://swagkeys.com/products.json?limit=250';

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
    .replace(/\[(?:예약판매|예판|group[- ]?buy|pre[- ]?order|in[- ]?stock)\]/gi, ' ')
    .replace(/\((?:국내\s*)?인스탁\s*판매\)/gi, ' ')
    .replace(/\(in[- ]?stock\)/gi, ' ')
    .replace(/\s+(?:키캡|keycaps?)$/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function canonicalProductKey(source, value) {
  let text = stripDecorations(value).toLocaleLowerCase('en-US');
  if (String(source).toUpperCase() === 'SWAGKEYS') {
    text = text.replace(/^(?:swg|sws)\s+/i, '');
  }
  return text.replace(/[^a-z0-9가-힣]+/g, '');
}

function identityValue(value) {
  return meaningful(value).toLocaleLowerCase('en-US');
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
    ...(meaningful(before) ? { before: eventType === 'eta_changed' ? normalizeKeepoddDate(before) : meaningful(before) } : {}),
    ...(meaningful(after) ? { after: eventType === 'eta_changed' ? normalizeKeepoddDate(after) : meaningful(after) } : {}),
    occurredAt,
    ...(cleanCategoryHint(row.type) ? { categoryHint: cleanCategoryHint(row.type) } : {}),
    ...(meaningful(row.manufacturer) ? { maker: meaningful(row.manufacturer) } : {}),
    ...(normalizeKeepoddDate(row.gbStart) ? { saleStart: normalizeKeepoddDate(row.gbStart) } : {}),
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
  const key = canonicalProductKey('SWAGKEYS', name);
  for (const [quarter, products] of Object.entries(quarters || {})) {
    if ((products || []).some((product) => canonicalProductKey('SWAGKEYS', product) === key)) return quarter;
  }
  return '';
}

function swagRowMap(rows = []) {
  const map = new Map();
  for (const row of rows || []) {
    const key = canonicalProductKey('SWAGKEYS', row?.product);
    if (key) map.set(key, row);
  }
  return map;
}

function swagEventRow(row = {}) {
  const colorMatching = meaningful(row.colorMatching);
  return {
    eta: row.eta,
    currentStatus: row.currentStatus,
    status: row.currentStatus,
    manufacturer: 'Swagkeys',
    type: 'Keycap',
    ...(colorMatching ? { note: `컬러매칭 ${colorMatching}` } : {})
  };
}

export function buildSwagkeysKeepoddEvents({ changes = [], quarterChanges = {}, snapshot = {}, occurredAt = new Date().toISOString(), fallbackUrl = SWAGKEYS_UPDATE_URL } = {}) {
  const events = new Map();
  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  const quarters = snapshot.quarters || {};
  const rowByKey = swagRowMap(rows);

  if (snapshot.roadmapFresh !== false) {
    for (const item of quarterChanges.added || []) {
      const name = cleanKeepoddValue(item.product);
      const canonicalKey = canonicalProductKey('SWAGKEYS', name);
      if (!canonicalKey) continue;
      const row = rowByKey.get(canonicalKey) || {};
      const event = eventFrom({
        source: 'SWAGKEYS', name, eventType: 'new_gb', occurredAt,
        row: swagEventRow(row), quarter: item.quarter, fallbackUrl, canonicalKey,
        idAfter: item.quarter || 'present'
      });
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
      const current = swagEventRow(row);

      if (change.kind === 'added') {
        const event = eventFrom({
          source: 'SWAGKEYS', name, eventType: 'new_gb', occurredAt, row: current,
          quarter, fallbackUrl, canonicalKey, idAfter: quarter || 'present'
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
          row: current, quarter, fallbackUrl, canonicalKey
        });
        if (eventType === 'note_changed') event.note = meaningful(after);
        events.set(event.id, event);
      }
    }
  }

  return [...events.values()];
}

function validEvent(event) {
  return Boolean(event && meaningful(event.id) && ['GEONWORKS', 'SWAGKEYS'].includes(cleanKeepoddValue(event.source).toUpperCase())
    && ['new_gb', 'eta_changed', 'status_changed', 'note_changed'].includes(cleanKeepoddValue(event.eventType))
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
  let added = 0;

  for (const raw of newEvents || []) {
    if (!raw?.name || !raw?.eventType || !raw?.source) continue;
    const id = raw.id || deterministicKeepoddEventId(raw);
    if (!id || byId.has(id)) continue;
    byId.set(id, { ...raw, id, occurredAt: raw.occurredAt || now });
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

export async function fetchProductCatalog(source, { fetchImpl = fetch, timeoutMs = 7000 } = {}) {
  if (source === 'SWAGKEYS') {
    const response = await fetchWithTimeout(fetchImpl, SWAGKEYS_PRODUCTS_JSON_URL, timeoutMs);
    if (!response.ok) throw new Error(`SWAGKEYS products catalog HTTP ${response.status}`);
    return parseSwagkeysProductsJson(await response.json());
  }
  if (source === 'GEONWORKS') {
    const catalog = [];
    for (const url of GEONWORKS_PRODUCTS_URLS) {
      const response = await fetchWithTimeout(fetchImpl, url, timeoutMs);
      if (!response.ok) throw new Error(`GEONWORKS products catalog HTTP ${response.status}`);
      catalog.push(...parseGeonworksCatalogHtml(await response.text(), url));
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
      for (const event of result) {
        if (event.source !== source) continue;
        const url = findExactProductUrl(source, event.name, catalog);
        if (url) {
          event.sourceUrl = url;
          event.sourceUrlType = 'product';
        }
      }
    } catch (error) {
      console.warn(`Keepodd ${source} product URL lookup failed; using update-page fallback: ${error?.message || error}`);
    }
  }
  return result;
}
