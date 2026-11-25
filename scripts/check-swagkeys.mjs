import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { buildSwagkeysKeepoddEvents, buildSwagkeysScheduleKeepoddEvents, canonicalProductKey, commitStateAndKeepoddEvents, enrichKeepoddEventSourceUrls } from './lib/keepodd-events.mjs';
import {
  SCHEDULE_SOURCES,
  diffScheduleItems,
  dueScheduleClosings,
  formatScheduleSale,
  kstDayString,
  parseScheduleCollectionRows,
  pruneScheduleClosings,
  scheduleProductKey
} from './lib/swagkeys-schedule.mjs';

const STATE_PATH = 'swagkeys-state.json';
const DISCORD_WEBHOOK_URL = (process.env.SWAGKEYS_DISCORD_WEBHOOK_URL || process.env.SWG_DISCORD_WEBHOOK_URL || '').trim();
// Pickle (the user's assistant) runs this collector without Discord: it formats the
// chat notifications itself from the printed SWAGKEYS_SUMMARY_JSON line.
export const parseSkipDiscord = (value) => /^(?:1|true)$/i.test(String(value ?? '').trim());
export const SKIP_DISCORD = parseSkipDiscord(process.env.SWAGKEYS_SKIP_DISCORD);
const ROADMAP_URL = 'https://swagkeys.notion.site/swg-keycap-roadmap';
const STATUS_URL = 'https://swagkeys.notion.site/3b5f75d536018064b051e6a663b41d35';
const STATUS_PAGE_ID = '3b5f75d5-3601-8064-b051-e6a663b41d35';
const ROADMAP_PAGE_ID = '374f75d5-3601-80c4-8736-e9893ea18e62';
const NOTION_API_BASE = 'https://swagkeys.notion.site/api/v3';
const QUARTERS = ['Q1', 'Q2', 'Q3', 'Q4'];
const STAGES = [
  { key: 'groupBuy', label: '공제' },
  { key: 'waitingProduction', label: '생산 대기' },
  { key: 'inProduction', label: '생산중' },
  { key: 'shipping', label: '배송중' },
  { key: 'fulfilled', label: '예판분 발송 완료' },
  { key: 'inStock', label: '인스탁 판매중' }
];

const clean = (value) => String(value ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
const cleanMultiline = (value) => String(value ?? '')
  .replace(/\r/g, '')
  .split('\n')
  .map(clean)
  .filter(Boolean)
  .join('\n');
const truncate = (value, maxLength = 1000) => {
  const text = cleanMultiline(value) || '—';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isNotionChallengeTitle = (value) => /just a moment|잠시만 기다리십시오/i.test(String(value || ''));
const FALLBACK_MAX_AGE_MS = 6 * 60 * 60 * 1000;


const ENGLISH_MONTHS = new Map([
  ['january', 1], ['february', 2], ['march', 3], ['april', 4], ['may', 5], ['june', 6],
  ['july', 7], ['august', 8], ['september', 9], ['october', 10], ['november', 11], ['december', 12]
]);

function canonicalDate(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)
      || y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1 || d > 31) return '';
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function normalizeEta(value) {
  const text = clean(value);
  if (!text) return '';

  let match = text.match(/^(\d{4})년\s*(\d{1,2})월\s*(\d{1,2})일$/);
  if (match) return canonicalDate(match[1], match[2], match[3]) || text;

  match = text.match(/^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})\.?$/);
  if (match) return canonicalDate(match[1], match[2], match[3]) || text;

  match = text.match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (match) {
    const month = ENGLISH_MONTHS.get(match[1].toLowerCase());
    if (month) return canonicalDate(match[3], month, match[2]) || text;
  }

  return text;
}

function comparableFieldValue(fieldKey, value) {
  return fieldKey === 'eta' ? normalizeEta(value) : clean(value);
}

const INVALID_ROADMAP_RE = /^(?:불러오는 중(?:\.{3})?|loading(?:\.{3})?|결과 없음|no results|문제 발생|다시 시도하기|something went wrong|try again)$/i;
const isInvalidRoadmapValue = (value) => INVALID_ROADMAP_RE.test(clean(value));
const quarterSnapshotIsValid = (quarters) => QUARTERS.every((quarter) => {
  const products = quarters?.[quarter];
  return Array.isArray(products)
    && products.length > 0
    && products.every((product) => clean(product) && !isInvalidRoadmapValue(product));
});

async function openWithRetry(context, url, label, extractor) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      if (isNotionChallengeTitle(await page.title())) throw new Error('blocked by the Notion challenge page');
      const result = await extractor(page);
      console.log(`SWAGKEYS ${label} read successfully on attempt ${attempt}.`);
      return result;
    } catch (error) {
      lastError = error;
      console.warn(`SWAGKEYS ${label} attempt ${attempt} failed: ${error?.message || error}`);
      console.warn(`SWAGKEYS ${label} diagnostics: title=${await page.title().catch(() => '')}; body=${clean((await page.locator('body').innerText({ timeout: 3000 }).catch(() => '')).slice(0, 300))}`);
      if (attempt < 3) await sleep(4000);
    } finally {
      await page.close();
    }
  }
  throw lastError;
}

async function extractRoadmap(page) {
  await page.waitForTimeout(4000);
  if (!/Swagkeys Keycap Roadmap/i.test(await page.title())) {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
  }
  await page.waitForFunction(() => {
    if (/just a moment|잠시만 기다리십시오/i.test(document.title || '')) return true;
    const note = document.querySelector('[role="note"]') || document.querySelector('.notion-callout-block');
    return /업데이트\s*\(/.test(note?.innerText || '');
  }, undefined, { timeout: 20000 });
  if (isNotionChallengeTitle(await page.title())) throw new Error('blocked by the Notion challenge page');
  await page.waitForTimeout(500);

  const announcement = await page.evaluate(() => {
    const tidy = (value) => String(value ?? '').replace(/\r/g, '').trim();
    const note = document.querySelector('[role="note"]') || document.querySelector('.notion-callout-block');
    const lines = tidy(note?.innerText)
      .split('\n')
      .map((line) => line.replace(/\s+/g, ' ').trim())
      .filter((line) => line && line !== '📌');
    const headingIndex = lines.findIndex((line) => /^업데이트\s*\(/.test(line));
    return {
      heading: headingIndex >= 0 ? lines[headingIndex] : '',
      content: lines.slice(headingIndex >= 0 ? headingIndex + 1 : 0).join('\n')
    };
  });

  const quarters = { Q1: null, Q2: null, Q3: null, Q4: null };
  await page.mouse.move(900, 700);
  await page.evaluate(() => {
    const scroller = document.querySelector('.notion-scroller.vertical') || document.scrollingElement || document.documentElement;
    scroller.scrollTop = 0;
  });
  await page.waitForTimeout(700);

  // Notion virtualizes collection views. Scan only until the bottom is reached
  // and the verified quarter snapshot stops growing, instead of always doing 72 passes.
  let stableScans = 0;
  let zeroDataScans = 0;
  let previousTotal = 0;
  let scanCount = 0;

  for (let step = 0; step < 48; step += 1) {
    scanCount = step + 1;
    const found = await page.evaluate(() => {
      const tidy = (value) => String(value ?? '').replace(/\r/g, '').trim();
      const invalid = /^(?:불러오는 중(?:\.{3})?|loading(?:\.{3})?|결과 없음|no results|문제 발생|다시 시도하기|something went wrong|try again)$/i;
      const result = {};

      for (const block of document.querySelectorAll('.notion-collection_view-block')) {
        const blockLines = tidy(block.innerText)
          .split('\n')
          .map((line) => line.replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        const match = blockLines[0]?.match(/^[1-4]분기\s*\(Q([1-4])\)$/i);
        if (!match) continue;

        const bodyLines = blockLines.slice(1);
        if (bodyLines.some((line) => invalid.test(line))) {
          const retry = [...block.querySelectorAll('button, [role="button"]')]
            .find((element) => /다시 시도하기|try again/i.test((element.innerText || element.textContent || '').trim()));
          retry?.click();
          continue;
        }

        const products = [...new Set(bodyLines.filter((line) => line && !invalid.test(line)))];
        if (products.length > 0) result[`Q${match[1]}`] = [...new Set([...(result[`Q${match[1]}`] || []), ...products])];
      }
      return result;
    });

    for (const [quarter, products] of Object.entries(found)) {
      quarters[quarter] = [...new Set([...(quarters[quarter] || []), ...products])];
    }

    const currentTotal = Object.values(quarters)
      .filter(Array.isArray)
      .reduce((sum, products) => sum + products.length, 0);
    stableScans = currentTotal === previousTotal ? stableScans + 1 : 0;
    zeroDataScans = currentTotal === 0 ? zeroDataScans + 1 : 0;
    previousTotal = currentTotal;

    if (zeroDataScans >= 8) {
      throw new Error('quarter roadmap product rows did not render');
    }

    const scrollState = await page.evaluate(() => {
      const scroller = document.querySelector('.notion-scroller.vertical') || document.scrollingElement || document.documentElement;
      const distance = Math.max(900, Math.floor((scroller.clientHeight || window.innerHeight || 900) * 0.8));
      const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const before = scroller.scrollTop;
      scroller.scrollTop = Math.min(before + distance, scroller.scrollHeight);
      return {
        top: scroller.scrollTop,
        max,
        moved: scroller.scrollTop > before + 5
      };
    });

    const atBottom = scrollState.max === 0 || scrollState.top >= scrollState.max - 5 || !scrollState.moved;
    if (atBottom && stableScans >= 2 && quarterSnapshotIsValid(quarters)) break;
    if (atBottom && stableScans >= 5 && !quarterSnapshotIsValid(quarters)) {
      throw new Error('quarter roadmap stopped changing before all quarters rendered');
    }

    await page.waitForTimeout(atBottom ? 900 : 450);
  }

  console.log(`SWAGKEYS roadmap scan passes: ${scanCount}`);

  if (!quarterSnapshotIsValid(quarters)) {
    const missing = QUARTERS.filter((quarter) => !Array.isArray(quarters[quarter]) || quarters[quarter].length === 0);
    throw new Error(`quarter roadmap incomplete or contains Notion error placeholders: ${missing.length ? missing.join(', ') : 'invalid values'}`);
  }

  console.log(`SWAGKEYS quarter counts: ${Object.entries(quarters).map(([quarter, products]) => `${quarter}=${products.length}`).join(', ')}`);
  return { announcement, quarters };
}

async function extractRows(page) {
  await page.waitForFunction(() => {
    if (/just a moment|잠시만 기다리십시오/i.test(document.title || '')) return true;
    return document.querySelectorAll('.notion-table-view-row').length >= 10;
  }, undefined, { timeout: 25000 });
  if (isNotionChallengeTitle(await page.title())) throw new Error('blocked by the Notion challenge page');
  await page.waitForTimeout(1000);
  return page.evaluate(() => {
    const tidy = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
    const progress = (cells, index) => {
      const value = Number(cells.get(index)?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow'));
      return Number.isFinite(value) ? Math.round(value * 10) / 10 : 0;
    };
    return [...document.querySelectorAll('.notion-table-view-row')].map((row) => {
      const cells = new Map([...row.querySelectorAll('.notion-table-view-cell')]
        .map((cell) => [Number(cell.getAttribute('data-col-index')), cell]));
      return {
        product: tidy(cells.get(0)?.innerText),
        groupBuy: progress(cells, 1),
        waitingProduction: progress(cells, 2),
        inProduction: progress(cells, 3),
        shipping: progress(cells, 4),
        fulfilled: progress(cells, 5),
        inStock: progress(cells, 6),
        colorMatching: tidy(cells.get(7)?.innerText),
        eta: tidy(cells.get(8)?.innerText),
        currentStatus: tidy(cells.get(9)?.innerText)
      };
    }).filter((row) => row.product);
  });
}


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

function notionDate(value) {
  return notionDateRange(value).start;
}

function findSchemaPropertyId(schema, matcher, fallbackId) {
  const entry = Object.entries(schema || {}).find(([, definition]) => matcher.test(clean(definition?.name)));
  return entry?.[0] || fallbackId;
}

function notionStatusText(properties, propertyId, schema) {
  const value = notionText(properties?.[propertyId]);
  if (value) return value;
  return clean(schema?.[propertyId]?.defaultOption);
}

function notionProgressPercent(properties, propertyId, schema) {
  const raw = Number(notionText(properties?.[propertyId]));
  if (!Number.isFinite(raw)) return 0;
  const maxValue = Number(schema?.[propertyId]?.show_as?.maxValue);
  const value = Number.isFinite(maxValue) && maxValue > 0 ? (raw / maxValue) * 100 : raw;
  return Math.round(value * 10) / 10;
}

export function parseSwagkeysStatusApi(pageData, collectionData) {
  const pageRecord = unwrapNotionRecord(pageData?.recordMap?.block?.[STATUS_PAGE_ID]);
  const collectionId = pageRecord?.collection_id;
  if (!collectionId) throw new Error('SWAGKEYS status collection id was missing from Notion page data');

  const collectionRecord = unwrapNotionRecord(
    pageData?.recordMap?.collection?.[collectionId]
    || collectionData?.recordMap?.collection?.[collectionId]
  );
  const schema = collectionRecord?.schema || {};

  const ids = {
    groupBuy: findSchemaPropertyId(schema, /Group-Buy/i, 'Zr<U'),
    waitingProduction: findSchemaPropertyId(schema, /Waiting Production/i, 'z\\dm'),
    inProduction: findSchemaPropertyId(schema, /In Production/i, ':z^h'),
    shipping: findSchemaPropertyId(schema, /Shipping/i, 'aDOQ'),
    fulfilled: findSchemaPropertyId(schema, /Fulfilled/i, 'Dmnh'),
    inStock: findSchemaPropertyId(schema, /In-Stock/i, 'zIZq'),
    colorMatching: findSchemaPropertyId(schema, /Color Matching/i, '?CvY'),
    eta: findSchemaPropertyId(schema, /ETA/i, 'U}^t'),
    currentStatus: findSchemaPropertyId(schema, /Current Status/i, 'nF;r')
  };

  const blocks = collectionData?.recordMap?.block || {};
  const blockIds = collectionData?.result?.reducerResults?.collection_group_results?.blockIds
    || Object.keys(blocks);

  return blockIds.map((blockId) => {
    const block = unwrapNotionRecord(blocks[blockId]);
    const properties = block?.properties || {};
    return {
      product: notionText(properties.title),
      groupBuy: notionProgressPercent(properties, ids.groupBuy, schema),
      waitingProduction: notionProgressPercent(properties, ids.waitingProduction, schema),
      inProduction: notionProgressPercent(properties, ids.inProduction, schema),
      shipping: notionProgressPercent(properties, ids.shipping, schema),
      fulfilled: notionProgressPercent(properties, ids.fulfilled, schema),
      inStock: notionProgressPercent(properties, ids.inStock, schema),
      colorMatching: notionStatusText(properties, ids.colorMatching, schema),
      eta: notionDate(properties[ids.eta]),
      currentStatus: notionStatusText(properties, ids.currentStatus, schema)
    };
  }).filter((row) => row.product);
}

export function parseSwagkeysRoadmapPageApi(pageData) {
  const blocks = pageData?.recordMap?.block || {};
  const collections = pageData?.recordMap?.collection || {};
  const views = pageData?.recordMap?.collection_view || {};
  let announcement = null;
  const sources = {};

  for (const record of Object.values(blocks)) {
    const block = unwrapNotionRecord(record);
    if (!block) continue;

    if (block.type === 'callout' && !announcement) {
      const directText = notionText(block.properties?.title);
      const childText = (block.content || [])
        .map((childId) => notionText(unwrapNotionRecord(blocks[childId])?.properties?.title))
        .filter(Boolean)
        .join('\n');
      const lines = [directText, childText]
        .filter(Boolean)
        .join('\n')
        .replace(/\r/g, '')
        .split('\n')
        .map(clean)
        .filter(Boolean);
      const headingIndex = lines.findIndex((line) => /^업데이트\s*\(/.test(line));
      if (headingIndex >= 0) {
        const headingMatch = lines[headingIndex].match(/^(업데이트\s*\([^)]+\))\s*(.*)$/);
        const inlineContent = clean(headingMatch?.[2]);
        announcement = {
          heading: clean(headingMatch?.[1] || lines[headingIndex]),
          content: [inlineContent, ...lines.slice(headingIndex + 1)].filter(Boolean).join('\n')
        };
      }
    }

    if (block.type !== 'collection_view') continue;
    const collectionId = block.collection_id || block.format?.collection_pointer?.id;
    const viewId = block.view_ids?.[0];
    if (!collectionId || !viewId) continue;

    const collection = unwrapNotionRecord(collections[collectionId]);
    const collectionName = notionText(collection?.name);
    const match = collectionName.match(/^([1-4])분기\s*\(Q([1-4])\)$/i);
    if (!match) continue;

    const quarter = `Q${match[2]}`;
    const view = unwrapNotionRecord(views[viewId]);
    // SWG and SWS use the same quarter headings. Preserve *both* collection views.
    sources[quarter] ||= [];
    if (!sources[quarter].some((source) => source.collectionId === collectionId && source.viewId === viewId)) {
      sources[quarter].push({
        collectionId,
        viewId,
        query: view?.query2 || {},
        schema: collection?.schema || {}
      });
    }
  }

  if (!announcement?.heading || !announcement?.content) {
    throw new Error('SWAGKEYS roadmap announcement was missing from Notion page data');
  }

  const missing = QUARTERS.filter((quarter) => !sources[quarter]?.length);
  if (missing.length) {
    throw new Error(`SWAGKEYS roadmap collection/view ids were missing for: ${missing.join(', ')}`);
  }

  return { announcement, sources };
}

export function parseSwagkeysRoadmapCollectionRowsApi(collectionData, schemaOverride = {}) {
  const blocks = collectionData?.recordMap?.block || {};
  const collections = collectionData?.recordMap?.collection || {};
  const collectionRecord = Object.values(collections)
    .map(unwrapNotionRecord)
    .find((record) => record?.schema);
  const schema = Object.keys(schemaOverride || {}).length ? schemaOverride : (collectionRecord?.schema || {});
  const gbDateId = findSchemaPropertyId(schema, /(?:GB|Group[- ]?Buy)\s*Date|공제.*일|판매.*일/i, '');
  const blockIds = collectionData?.result?.reducerResults?.collection_group_results?.blockIds
    || Object.keys(blocks);
  const byProduct = new Map();

  for (const blockId of blockIds) {
    const block = unwrapNotionRecord(blocks[blockId]);
    const properties = block?.properties || {};
    const product = clean(notionText(properties.title));
    if (!product || isInvalidRoadmapValue(product)) continue;
    const range = gbDateId ? notionDateRange(properties[gbDateId]) : { start: '', end: '' };
    byProduct.set(product.toLocaleLowerCase('en-US'), {
      product,
      saleStart: normalizeEta(range.start),
      saleEnd: normalizeEta(range.end)
    });
  }

  return [...byProduct.values()];
}

export function parseSwagkeysRoadmapCollectionApi(collectionData) {
  return parseSwagkeysRoadmapCollectionRowsApi(collectionData).map((row) => row.product);
}

export function notionRetryDelayMs(status, retryAfterValue, attempt, nowMs = Date.now()) {
  if (Number(status) === 429) {
    const raw = clean(retryAfterValue);
    if (/^\d+(?:\.\d+)?$/.test(raw)) {
      return Math.min(120000, Math.max(1000, Math.ceil(Number(raw) * 1000)));
    }
    const retryAt = Date.parse(raw);
    if (Number.isFinite(retryAt)) {
      return Math.min(120000, Math.max(1000, retryAt - nowMs));
    }
    return Math.min(60000, 10000 * Math.max(1, attempt));
  }
  return Math.min(10000, 1500 * Math.max(1, attempt));
}

async function postNotionPublicApi(path, body, headers = {}, { attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(`${NOTION_API_BASE}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
      if (!response.ok) {
        const error = new Error(`Notion public API HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
        error.status = response.status;
        error.retryAfter = response.headers.get('retry-after') || '';
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (attempt < Math.max(1, attempts)) {
        const delayMs = notionRetryDelayMs(error?.status, error?.retryAfter, attempt);
        console.warn(`SWAGKEYS Notion API retry in ${Math.ceil(delayMs / 1000)}s after ${error?.message || error}`);
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

async function queryNotionCollection(collectionId, collectionViewId, query = {}, spaceId = '') {
  return postNotionPublicApi('queryCollection?src=initial_load', {
    collection: { id: collectionId },
    collectionView: { id: collectionViewId },
    source: { type: 'collection', id: collectionId },
    loader: {
      type: 'reducer',
      reducers: {
        collection_group_results: {
          type: 'results',
          limit: 100,
          loadContentCover: true
        }
      },
      ...query,
      filter: query.filter || { filters: [], operator: 'and' },
      searchQuery: '',
      userTimeZone: 'Asia/Seoul'
    }
  }, spaceId ? { 'x-notion-space-id': spaceId } : {});
}

async function fetchRoadmapFromNotionApi() {
  const pageData = await postNotionPublicApi('loadPageChunk', {
    pageId: ROADMAP_PAGE_ID,
    limit: 100,
    chunkNumber: 0,
    cursor: { stack: [] },
    verticalColumns: false
  });

  const { announcement, sources } = parseSwagkeysRoadmapPageApi(pageData);
  const spaceId = pageData?.recordMap?.block?.[ROADMAP_PAGE_ID]?.spaceId || '';
  const quarters = {};
  const roadmapDates = {};

  for (const quarter of QUARTERS) {
    const products = new Map();
    for (const source of sources[quarter]) {
      const collectionData = await queryNotionCollection(
        source.collectionId,
        source.viewId,
        source.query,
        spaceId
      );
      const roadmapRows = parseSwagkeysRoadmapCollectionRowsApi(collectionData, source.schema);
      if (!roadmapRows.length) throw new Error(`Notion public API returned no SWAGKEYS roadmap products for ${quarter} collection ${source.collectionId}`);
      for (const row of roadmapRows) {
        products.set(clean(row.product).toLocaleLowerCase('en-US'), row.product);
        const canonicalKey = canonicalProductKey('SWAGKEYS', row.product);
        if (!canonicalKey) continue;
        // "SWG Beige" and "SWS Beige" are different products, not interchangeable dates.
        const key = /^SWS\s+/i.test(row.product) ? `sws:${canonicalKey}` : canonicalKey;
        roadmapDates[key] = {
          product: row.product,
          saleStart: row.saleStart || '',
          saleEnd: row.saleEnd || ''
        };
      }
    }
    if (!products.size) throw new Error(`Notion public API returned no SWAGKEYS roadmap products for ${quarter}`);
    quarters[quarter] = [...products.values()];
  }

  if (!quarterSnapshotIsValid(quarters)) {
    throw new Error('Notion public API returned an invalid SWAGKEYS roadmap snapshot');
  }
  return { announcement, quarters, roadmapDates, roadmapLayoutVersion: 2 };
}

async function fetchStatusRowsFromNotionApi() {
  const pageData = await postNotionPublicApi('loadPageChunk', {
    pageId: STATUS_PAGE_ID,
    limit: 100,
    chunkNumber: 0,
    cursor: { stack: [] },
    verticalColumns: false
  });

  const pageRecord = unwrapNotionRecord(pageData?.recordMap?.block?.[STATUS_PAGE_ID]);
  const collectionId = pageRecord?.collection_id;
  const collectionViewId = pageRecord?.view_ids?.[0];
  const spaceId = pageData?.recordMap?.block?.[STATUS_PAGE_ID]?.spaceId;
  if (!collectionId || !collectionViewId) {
    throw new Error('SWAGKEYS status collection/view id was missing from Notion page data');
  }

  const viewRecord = unwrapNotionRecord(pageData?.recordMap?.collection_view?.[collectionViewId]);
  const query = viewRecord?.query2 || {};
  const collectionData = await queryNotionCollection(
    collectionId,
    collectionViewId,
    query,
    spaceId || ''
  );

  const rows = parseSwagkeysStatusApi(pageData, collectionData);
  if (rows.length < 10) throw new Error(`Notion public API returned too few SWAGKEYS status rows: ${rows.length}`);
  const uniqueProducts = new Set(rows.map((row) => clean(row.product).toLowerCase()));
  if (uniqueProducts.size !== rows.length) throw new Error('Notion public API returned duplicate SWAGKEYS products');
  return rows;
}

async function fetchSnapshot(fallback = {}) {
  const fallbackSince = { ...(fallback.fallbackSince || {}) };
  let fallbackMetadataChanged = false;
  const fallbackRows = Array.isArray(fallback.rows) ? fallback.rows : [];
  const fallbackRoadmapIsValid = Boolean(
    fallback.announcement?.heading
    && fallback.announcement?.content
    && quarterSnapshotIsValid(fallback.quarters)
  );
  // Chromium is only needed for the browser fallback. Launching it lazily keeps
  // the direct Notion API path usable in environments without a Chrome binary.
  let browser = null;
  let context = null;
  const browserContext = async () => {
    if (context) return context;
    console.log('SWAGKEYS browser fallback: launching Playwright Chromium.');
    browser = await chromium.launch({ headless: true, channel: 'chrome' });
    context = await browser.newContext({
      viewport: { width: 1800, height: 1400 },
      locale: 'ko-KR'
    });
    return context;
  };
  try {
    let roadmap = null;
    let roadmapFresh = true;
    let roadmapError = null;
    try {
      let candidate;
      try {
        candidate = await fetchRoadmapFromNotionApi();
        console.log(`SWAGKEYS roadmap direct API counts: ${Object.entries(candidate.quarters).map(([quarter, products]) => `${quarter}=${products.length}`).join(', ')}`);
      } catch (apiError) {
        console.warn(`SWAGKEYS roadmap direct API failed; using browser fallback: ${apiError?.message || apiError}`);
        candidate = await openWithRetry(await browserContext(), ROADMAP_URL, 'roadmap browser fallback', extractRoadmap);
      }
      if (!candidate.announcement.heading || !candidate.announcement.content) throw new Error('roadmap announcement was empty');
      if (!quarterSnapshotIsValid(candidate.quarters)) throw new Error('quarter roadmap snapshot failed validation');
      if (!candidate.roadmapDates && fallback.roadmapDates) candidate = { ...candidate, roadmapDates: fallback.roadmapDates };
      if (Object.values(candidate.quarters).flat().length < 5) throw new Error('quarter roadmap returned too few products');
      roadmap = candidate;
      if (fallbackSince.roadmap) {
        delete fallbackSince.roadmap;
        fallbackMetadataChanged = true;
        console.log('SWAGKEYS roadmap fresh data recovered; fallback timer cleared.');
      }
    } catch (error) {
      roadmapError = error;
      roadmapFresh = false;
      if (fallbackRoadmapIsValid) {
        const startedAt = fallbackSince.roadmap || new Date().toISOString();
        const ageMs = Date.now() - Date.parse(startedAt);
        if (!Number.isFinite(ageMs) || ageMs >= FALLBACK_MAX_AGE_MS) {
          throw new Error(`SWAGKEYS roadmap has been unavailable for more than 6 hours: ${error?.message || error}`);
        }
        if (!fallbackSince.roadmap) {
          fallbackSince.roadmap = startedAt;
          fallbackMetadataChanged = true;
        }
        roadmap = {
          announcement: fallback.announcement,
          quarters: fallback.quarters,
          ...(fallback.roadmapDates ? { roadmapDates: fallback.roadmapDates } : {})
        };
        console.warn(`SWAGKEYS roadmap unavailable after retries. Reusing stored roadmap; fallback age=${Math.floor(ageMs / 60000)}m.`);
      }
    }

    let rows = null;
    let statusFresh = true;
    let statusError = null;
    try {
      let candidateRows;
      try {
        candidateRows = await fetchStatusRowsFromNotionApi();
        console.log(`SWAGKEYS status table direct API rows: ${candidateRows.length}`);
      } catch (apiError) {
        console.warn(`SWAGKEYS status direct API failed; using browser fallback: ${apiError?.message || apiError}`);
        candidateRows = await openWithRetry(await browserContext(), STATUS_URL, 'status table browser fallback', extractRows);
      }
      if (candidateRows.length < 10) throw new Error(`status table returned too few rows: ${candidateRows.length}`);
      rows = candidateRows;
      if (fallbackSince.status) {
        delete fallbackSince.status;
        fallbackMetadataChanged = true;
        console.log('SWAGKEYS status table fresh data recovered; fallback timer cleared.');
      }
    } catch (error) {
      statusError = error;
      statusFresh = false;
      if (fallbackRows.length >= 10) {
        const startedAt = fallbackSince.status || new Date().toISOString();
        const ageMs = Date.now() - Date.parse(startedAt);
        if (!Number.isFinite(ageMs) || ageMs >= FALLBACK_MAX_AGE_MS) {
          throw new Error(`SWAGKEYS status table has been unavailable for more than 6 hours: ${error?.message || error}`);
        }
        if (!fallbackSince.status) {
          fallbackSince.status = startedAt;
          fallbackMetadataChanged = true;
        }
        rows = fallbackRows;
        console.warn(`SWAGKEYS status table unavailable after retries. Reusing ${rows.length} stored rows; fallback age=${Math.floor(ageMs / 60000)}m.`);
      }
    }

    if (!roadmap) throw roadmapError || new Error('SWAGKEYS roadmap unavailable and no verified fallback exists');
    if (!rows) throw statusError || new Error('SWAGKEYS status table unavailable and no verified fallback exists');
    if (!roadmapFresh && !statusFresh) {
      console.warn('SWAGKEYS roadmap and status table are both using bounded stored fallback for this run.');
    }

    return {
      announcement: roadmap.announcement,
      quarters: roadmap.quarters,
      ...(roadmap.roadmapDates ? { roadmapDates: roadmap.roadmapDates } : {}),
      rows,
      roadmapFresh,
      statusFresh,
      roadmapLayoutVersion: roadmapFresh ? (roadmap.roadmapLayoutVersion || 2) : (fallback.roadmapLayoutVersion || 1),
      fallbackSince,
      fallbackMetadataChanged
    };
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}

// 판매·입고 일정 DB는 부가 소스다. 요청 수를 늘리지 않도록 재시도 없이 한 번만 읽고,
// 실패하면 저장된 이전 행을 그대로 쓴다. 기존 로드맵/진행현황의 fallbackSince에는
// 손대지 않아 health 판정과 공제 마감 알림 조건이 바뀌지 않는다.
async function fetchScheduleItemsFromNotionApi(sourceKey) {
  const source = SCHEDULE_SOURCES[sourceKey];
  const collectionData = await postNotionPublicApi('queryCollection?src=initial_load', {
    collection: { id: source.collectionId },
    collectionView: { id: source.viewId },
    source: { type: 'collection', id: source.collectionId },
    loader: {
      type: 'reducer',
      reducers: { collection_group_results: { type: 'results', limit: 1000, loadContentCover: true } },
      filter: { filters: [], operator: 'and' },
      searchQuery: '',
      userTimeZone: 'Asia/Seoul'
    }
  }, {}, { attempts: 1 });
  const items = parseScheduleCollectionRows(collectionData, sourceKey);
  if (!items.length) throw new Error('Notion returned no schedule rows');
  return items;
}

async function fetchScheduleSnapshot(previous = null) {
  const sources = {};
  const fallbackSince = { ...(previous?.fallbackSince || {}) };
  for (const sourceKey of Object.keys(SCHEDULE_SOURCES)) {
    const source = SCHEDULE_SOURCES[sourceKey];
    const previousItems = Array.isArray(previous?.sources?.[sourceKey]?.items)
      ? previous.sources[sourceKey].items
      : [];
    try {
      const items = await fetchScheduleItemsFromNotionApi(sourceKey);
      sources[sourceKey] = { items, fresh: true };
      if (fallbackSince[sourceKey]) {
        delete fallbackSince[sourceKey];
        console.log(`SWAGKEYS ${source.label}: fresh data recovered; fallback timer cleared.`);
      }
      console.log(`SWAGKEYS ${source.label}: ${items.length} rows (fresh)`);
    } catch (error) {
      const reason = error?.message || String(error);
      if (!previousItems.length) {
        sources[sourceKey] = { items: [], fresh: false };
        console.warn(`SWAGKEYS ${source.label} unavailable and no stored rows yet: ${reason}`);
        continue;
      }
      fallbackSince[sourceKey] = fallbackSince[sourceKey] || new Date().toISOString();
      sources[sourceKey] = { items: previousItems, fresh: false };
      console.warn(`SWAGKEYS ${source.label} unavailable; reusing ${previousItems.length} stored rows: ${reason}`);
    }
  }
  return { sources, fallbackSince };
}

// 이전 실행과 비교해 새 품목·상태/일정 변경·마감 임박을 만든다.
// 첫 실행(저장된 일정이 없음)은 기준선만 저장하고 알리지 않는다.
// 로드맵에 이미 올라온 품목은 기존 GB 마감 알림이 맡으므로 마감 대상에서 뺀다.
// watcher-state에 매번 통째로 커밋되는 값이라 블록 id와 빈 필드는 빼고 저장한다.
function scheduleItemForState(item) {
  const stored = {};
  for (const [key, value] of Object.entries(item || {})) {
    if (key === 'id') continue;
    if (value === '' || (Array.isArray(value) && value.length === 0)) continue;
    stored[key] = value;
  }
  return stored;
}

export function buildScheduleEvents({ schedule, previous = null, now = new Date(), roadmapProducts = [] }) {
  const baseline = !previous?.initialized;
  const added = [];
  const changed = [];
  const closings = [];
  const sources = {};
  const skipProductKeys = (roadmapProducts || []).map(scheduleProductKey).filter(Boolean);

  for (const sourceKey of Object.keys(SCHEDULE_SOURCES)) {
    const current = schedule?.sources?.[sourceKey] || { items: [], fresh: false };
    sources[sourceKey] = { items: (current.items || []).map(scheduleItemForState), fresh: Boolean(current.fresh) };
    if (baseline || !current.fresh) continue;
    const diff = diffScheduleItems(previous?.sources?.[sourceKey]?.items || [], current.items || []);
    for (const item of diff.added) added.push({ sourceKey, item });
    for (const change of diff.changed) changed.push({ sourceKey, ...change });
    if (diff.removed.length) {
      // 품목이 표에서 빠지는 것은 판매 종료·정리라서 알리지 않고 로그만 남긴다.
      console.log(`SWAGKEYS ${SCHEDULE_SOURCES[sourceKey].label}: ${diff.removed.length} row(s) left the table (not notified).`);
    }
  }

  const closingsNotified = pruneScheduleClosings(previous?.closingsNotified || {}, now);
  const reservations = schedule?.sources?.reservations;
  if (!baseline && reservations?.fresh) {
    for (const closing of dueScheduleClosings({
      items: reservations.items || [],
      notified: closingsNotified,
      now,
      skipProductKeys
    })) {
      closings.push(closing);
      closingsNotified[closing.key] = kstDayString(now);
    }
  }

  return {
    baseline,
    added,
    changed,
    closings,
    sources,
    closingsNotified,
    fallbackSince: schedule?.fallbackSince || {},
    nextState: {
      version: 1,
      initialized: true,
      updatedAt: new Date(now).toISOString(),
      sources,
      closingsNotified,
      fallbackSince: schedule?.fallbackSince || {}
    }
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function statePayload(snapshot, updatedAt = new Date().toISOString()) {
  return {
    version: 1,
    initialized: true,
    updatedAt,
    roadmapLayoutVersion: snapshot.roadmapLayoutVersion || 1,
    gbStartsNotified: snapshot.gbStartsNotified || {},
    announcement: snapshot.announcement,
    quarters: snapshot.quarters,
    ...(snapshot.roadmapDates ? { roadmapDates: snapshot.roadmapDates } : {}),
    rows: snapshot.rows.map((row) => ({ ...row, eta: normalizeEta(row.eta) })),
    ...(snapshot.schedule ? { schedule: snapshot.schedule } : {}),
    ...(snapshot.keepoddScheduleSeededAt ? { keepoddScheduleSeededAt: snapshot.keepoddScheduleSeededAt } : {}),
    fallbackSince: snapshot.fallbackSince || {}
  };
}

function saveState(snapshot) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(statePayload(snapshot), null, 2) + '\n');
}

// 예약판매 표가 Keepodd 이벤트로 연결되기 전부터 표에 있던 품목은 added diff가 없어
// 이벤트가 생기지 않는다. 최초 1회만 현재 '공제 중/판매 중' 품목을 시드한다(Discord 발송 없음).
async function seedReservationScheduleKeepoddEvents(snapshot, scheduleEvents) {
  snapshot.keepoddScheduleSeededAt = new Date().toISOString();
  await advanceStateWithKeepoddEvents(snapshot, { added: [], removed: [], datesChanged: [] }, [], [], scheduleEvents);
  console.log('Keepodd SWAGKEYS reservation schedule seeded once (no Discord messages).');
}

async function advanceStateWithKeepoddEvents(snapshot, quarterChanges, changes, starts = [], scheduleEvents = null) {
  const occurredAt = new Date().toISOString();
  const candidates = buildSwagkeysKeepoddEvents({ changes, quarterChanges, starts, snapshot, occurredAt });
  // 예약판매 품목 현황(NEO80 Cu·GMK Liminal·GMK CYL Purple 등)은 로드맵과 다른 표라
  // 별도 빌더로 Keepodd 이벤트를 만든다. 전에는 디스코드 임베드로만 나갔다.
  const reservations = scheduleEvents?.nextState?.sources?.reservations;
  if (reservations?.fresh) {
    candidates.push(...buildSwagkeysScheduleKeepoddEvents({
      current: reservations.items || [],
      changed: (scheduleEvents.changed || []).filter((change) => change.sourceKey === 'reservations'),
      occurredAt
    }));
  }
  const events = await enrichKeepoddEventSourceUrls(candidates);
  const merged = commitStateAndKeepoddEvents({
    statePath: STATE_PATH,
    stateValue: statePayload(snapshot, occurredAt),
    events,
    now: occurredAt
  });
  console.log(`Keepodd SWAGKEYS events committed: ${merged.added} new / ${events.length} candidate(s).`);
}

function rowMap(rows) {
  return new Map(rows.map((row) => [clean(row.product).toLowerCase(), row]));
}

export function diffRows(previousRows, currentRows) {
  const previous = rowMap(previousRows);
  const current = rowMap(currentRows);
  const changes = [];
  const fields = [
    ...STAGES.map(({ key, label }) => ({ key, label: `${label} 진행률`, type: 'percent' })),
    { key: 'colorMatching', label: '컬러 매칭' },
    { key: 'eta', label: '배송 예정일' },
    { key: 'currentStatus', label: '현재 상태' }
  ];
  for (const [key, row] of current) {
    const before = previous.get(key);
    if (!before) {
      changes.push({ kind: 'added', row });
      continue;
    }
    const changedFields = fields
      .filter((field) => comparableFieldValue(field.key, before[field.key]) !== comparableFieldValue(field.key, row[field.key]))
      .map((field) => ({
        ...field,
        before: field.key === 'eta' ? normalizeEta(before[field.key]) : before[field.key],
        after: field.key === 'eta' ? normalizeEta(row[field.key]) : row[field.key]
      }));
    if (changedFields.length) changes.push({ kind: 'changed', row, before, fields: changedFields });
  }
  for (const [key, row] of previous) {
    if (!current.has(key)) changes.push({ kind: 'removed', row });
  }
  return changes;
}

export function preserveIndependentFreshChanges({
  state,
  previousRows,
  snapshot,
  verificationSnapshot,
  removalNeedsRoadmapFresh,
  removalNeedsStatusFresh
}) {
  return {
    ...snapshot,
    announcement: removalNeedsRoadmapFresh ? state.announcement : snapshot.announcement,
    quarters: removalNeedsRoadmapFresh ? state.quarters : snapshot.quarters,
    ...(removalNeedsRoadmapFresh
      ? (state.roadmapDates ? { roadmapDates: state.roadmapDates } : {})
      : (snapshot.roadmapDates ? { roadmapDates: snapshot.roadmapDates } : {})),
    rows: removalNeedsStatusFresh ? previousRows : snapshot.rows,
    roadmapLayoutVersion: removalNeedsRoadmapFresh ? (state.roadmapLayoutVersion || 1) : snapshot.roadmapLayoutVersion,
    fallbackSince: verificationSnapshot.fallbackSince,
    fallbackMetadataChanged: true
  };
}

// KST calendar date, not GitHub runner UTC, determines whether a scheduled GB has started.
export function dueSwagkeysGbStarts({ roadmapDates = {}, notified = {}, now = new Date().toISOString(), maxCatchupDays = 7 } = {}) {
  const dateParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(now));
  const dateValues = Object.fromEntries(dateParts.map(({ type, value }) => [type, value]));
  const today = `${dateValues.year}-${dateValues.month}-${dateValues.day}`;
  const todayMs = Date.parse(`${today}T00:00:00Z`);
  const result = [];
  for (const [key, row] of Object.entries(roadmapDates)) {
    const saleStart = normalizeEta(row?.saleStart);
    const saleEnd = normalizeEta(row?.saleEnd);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(saleStart) || (saleEnd && !/^\d{4}-\d{2}-\d{2}$/.test(saleEnd))) continue;
    const ageDays = (todayMs - Date.parse(`${saleStart}T00:00:00Z`)) / 86400000;
    if (!Number.isInteger(ageDays) || ageDays < 0 || ageDays > maxCatchupDays || (saleEnd && saleEnd < today)) continue;
    if (notified[key] === saleStart) continue;
    const product = clean(row?.product);
    if (product) result.push({ key, product, saleStart, saleEnd });
  }
  return result;
}

export function suppressLegacySwgQ4Additions(state, candidateSnapshot, quarterChanges) {
  if ((state?.roadmapLayoutVersion || 1) >= 2 || candidateSnapshot?.roadmapLayoutVersion !== 2) return quarterChanges;
  // The old collector dropped SWG Q4 while retaining SWS Q4. Existing SWG Q4
  // products are not new launches: suppress them during this one-time upgrade.
  return {
    ...quarterChanges,
    added: (quarterChanges.added || []).filter(item =>
      !(item.quarter === 'Q4' && /^SWG\s+/i.test(item.product)))
  };
}

export function diffRoadmapDates(previousDates = {}, currentDates = {}) {
  const result = [];
  const keys = Object.keys(previousDates || {}).filter((key) => Object.prototype.hasOwnProperty.call(currentDates || {}, key));
  for (const key of keys) {
    const before = previousDates?.[key] || {};
    const after = currentDates?.[key] || {};
    // Prior to the Q4 collector fix, the key "beige" could mean SWS Beige.
    // Never report a false date change by comparing it with SWG Beige.
    const oldFamily = clean(before.product).match(/^(SWG|SWS)\b/i)?.[1]?.toUpperCase();
    const newFamily = clean(after.product).match(/^(SWG|SWS)\b/i)?.[1]?.toUpperCase();
    if (oldFamily && newFamily && oldFamily !== newFamily) continue;
    const beforeStart = normalizeEta(before.saleStart);
    const beforeEnd = normalizeEta(before.saleEnd);
    const afterStart = normalizeEta(after.saleStart);
    const afterEnd = normalizeEta(after.saleEnd);
    if (beforeStart === afterStart && beforeEnd === afterEnd) continue;
    result.push({
      product: clean(after.product || before.product || key),
      quarter: '',
      before: { saleStart: beforeStart, saleEnd: beforeEnd },
      after: { saleStart: afterStart, saleEnd: afterEnd }
    });
  }
  return result;
}

export function diffQuarters(previousQuarters = {}, currentQuarters = {}) {
  const locations = (quarters) => {
    const map = new Map();
    for (const quarter of QUARTERS) {
      for (const product of quarters[quarter] || []) {
        map.set(clean(product).toLowerCase(), { product: clean(product), quarter });
      }
    }
    return map;
  };
  const previous = locations(previousQuarters);
  const current = locations(currentQuarters);
  const result = { moved: [], added: [], removed: [] };
  for (const [key, item] of current) {
    const before = previous.get(key);
    if (!before) result.added.push(item);
    else if (before.quarter !== item.quarter) result.moved.push({ product: item.product, before: before.quarter, after: item.quarter });
  }
  for (const [key, item] of previous) {
    if (!current.has(key)) result.removed.push(item);
  }
  return result;
}

function hasQuarterChanges(changes) {
  return changes.moved.length > 0 || changes.added.length > 0 || changes.removed.length > 0 || (changes.datesChanged?.length ?? 0) > 0;
}

function formatKst(isoString) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date(isoString));
  const values = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function displayPercent(value) {
  return `${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 1 })}%`;
}
function auxiliaryFields(url, detectedAt) {
  return [
    { name: '변경 감지 시각', value: `${formatKst(detectedAt)} KST`, inline: false },
    { name: '링크', value: `[🔗 상세 보기](${url})`, inline: false }
  ];
}
function baseEmbed(title, url, detectedAt) {
  return { title: truncate(title, 250), url, footer: { text: 'SWAGKEYS · Keycap Roadmap' }, timestamp: detectedAt };
}

export function gbStartEmbed(row, detectedAt = new Date().toISOString()) {
  return {
    ...baseEmbed(`🟢 SWAGKEYS GB 시작 · ${row.product}`, ROADMAP_URL, detectedAt),
    fields: [
      { name: 'GB 기간', value: `${row.saleStart} ~ ${row.saleEnd || '종료일 미정'}`, inline: false },
      ...auxiliaryFields(ROADMAP_URL, detectedAt)
    ]
  };
}

export function announcementEmbed(announcement, detectedAt = new Date().toISOString()) {
  return {
    ...baseEmbed(`📌 SWAGKEYS 로드맵 · ${announcement.heading}`, ROADMAP_URL, detectedAt),
    fields: [
      { name: '업데이트 내용', value: truncate(announcement.content), inline: false },
      ...auxiliaryFields(ROADMAP_URL, detectedAt)
    ]
  };
}

export function quartersEmbed(changes, detectedAt = new Date().toISOString()) {
  const fields = [];
  if (changes.moved.length) fields.push({ name: '분기 이동', value: truncate(changes.moved.map((item) => `• ${item.product}: ${item.before} → ${item.after}`).join('\n')), inline: false });
  if (changes.added.length) fields.push({ name: '신규 배치', value: truncate(changes.added.map((item) => `• ${item.product} → ${item.quarter}`).join('\n')), inline: false });
  if (changes.removed.length) fields.push({ name: '로드맵 제외', value: truncate(changes.removed.map((item) => `• ${item.product} (기존 ${item.quarter})`).join('\n')), inline: false });
  if (changes.datesChanged?.length) fields.push({
    name: '판매 일정 변경',
    value: truncate(changes.datesChanged.map((item) => {
      const before = `${item.before.saleStart || '미정'} ~ ${item.before.saleEnd || '미정'}`;
      const after = `${item.after.saleStart || '미정'} ~ ${item.after.saleEnd || '미정'}`;
      return `• ${item.product}: ${before} → ${after}`;
    }).join('\n')),
    inline: false
  });
  return { ...baseEmbed('🗺️ SWAGKEYS 분기별 로드맵 업데이트', ROADMAP_URL, detectedAt), fields: [...fields, ...auxiliaryFields(ROADMAP_URL, detectedAt)] };
}

export function addedEmbed(row, detectedAt = new Date().toISOString()) {
  const progress = STAGES.map(({ key, label }) => `${label}: ${displayPercent(row[key])}`).join('\n');
  return {
    ...baseEmbed(`🆕 SWAGKEYS 제품 추가 · ${row.product}`, STATUS_URL, detectedAt),
    fields: [
      { name: '현재 상태', value: truncate(row.currentStatus), inline: false },
      { name: '배송 예정일', value: truncate(row.eta || '—'), inline: true },
      { name: '컬러 매칭', value: truncate(row.colorMatching || '—'), inline: true },
      { name: '단계별 진행률', value: progress, inline: false },
      ...auxiliaryFields(STATUS_URL, detectedAt)
    ]
  };
}

export function changedEmbed(change, detectedAt = new Date().toISOString()) {
  return {
    ...baseEmbed(`🔄 SWAGKEYS 진행 업데이트 · ${change.row.product}`, STATUS_URL, detectedAt),
    fields: [
      ...change.fields.map((field) => ({
        name: field.label,
        value: truncate(`이전: ${field.type === 'percent' ? displayPercent(field.before) : field.before || '—'}\n현재: ${field.type === 'percent' ? displayPercent(field.after) : field.after || '—'}`),
        inline: false
      })),
      ...auxiliaryFields(STATUS_URL, detectedAt)
    ]
  };
}

export function removedEmbed(row, detectedAt = new Date().toISOString()) {
  return {
    ...baseEmbed(`➖ SWAGKEYS 로드맵에서 제거 · ${row.product}`, STATUS_URL, detectedAt),
    description: 'SWAGKEYS의 현재 키캡 생산 진행 상황 표에서 사라졌습니다.',
    fields: [
      { name: '마지막 상태', value: truncate(row.currentStatus || '—'), inline: false },
      { name: '마지막 배송 예정일', value: truncate(row.eta || '—'), inline: true },
      ...auxiliaryFields(STATUS_URL, detectedAt)
    ]
  };
}

const SCHEDULE_CHANGE_FIELD_NAMES = Object.freeze({
  status: '상태',
  sale: '판매 일정',
  arrival: '입고일자',
  eta: '배송 예상'
});

// 이미 '이전 → 현재'로 보여준 항목은 현재 값 목록에서 빼서 같은 내용을 두 번 적지 않는다.
function scheduleBaseFields(item, omit = new Set()) {
  const fields = [
    { name: '카테고리', value: truncate(item.category || '—'), inline: true },
    { name: '브랜드', value: truncate((item.brands || []).join(', ') || '—'), inline: true },
    { name: '상태', value: truncate(item.status || '—'), inline: true },
    ...(item.saleStart || item.saleEnd ? [{ name: '판매 일정', value: formatScheduleSale(item), inline: true }] : []),
    ...(item.arrivalDate ? [{ name: '입고일자', value: item.arrivalDate, inline: true }] : []),
    ...(item.eta ? [{ name: '배송 예상', value: truncate(item.eta), inline: true }] : [])
  ];
  return fields.filter((field) => !omit.has(field.name));
}

function scheduleAuxiliaryFields(sourceKey, item, detectedAt) {
  const source = SCHEDULE_SOURCES[sourceKey];
  return [
    { name: '변경 감지 시각', value: `${formatKst(detectedAt)} KST`, inline: false },
    { name: '링크', value: item?.url ? `[🔗 제품 보기](${item.url})` : `[🔗 ${source.label}](${source.url})`, inline: false }
  ];
}

function scheduleEmbed({ title, sourceKey, item, detectedAt, extraFields = [], omit = new Set() }) {
  const source = SCHEDULE_SOURCES[sourceKey];
  return {
    title: truncate(title, 250),
    url: source.url,
    footer: { text: `SWAGKEYS · ${source.label}` },
    timestamp: detectedAt,
    fields: [
      ...extraFields,
      ...scheduleBaseFields(item, omit),
      ...scheduleAuxiliaryFields(sourceKey, item, detectedAt)
    ]
  };
}

export function scheduleAddedEmbed(sourceKey, item, detectedAt = new Date().toISOString()) {
  const source = SCHEDULE_SOURCES[sourceKey];
  return scheduleEmbed({
    title: `🆕 SWAGKEYS ${source.label} 등록 · ${item.product}`,
    sourceKey,
    item,
    detectedAt
  });
}

export function scheduleChangedEmbed(sourceKey, change, detectedAt = new Date().toISOString()) {
  const source = SCHEDULE_SOURCES[sourceKey];
  return scheduleEmbed({
    title: `🔄 SWAGKEYS ${source.label} 변경 · ${change.item.product}`,
    sourceKey,
    item: change.item,
    detectedAt,
    extraFields: change.fields.map((field) => ({
      name: `${field.label} 변경`,
      value: truncate(`이전: ${field.before}\n현재: ${field.after}`),
      inline: false
    })),
    omit: new Set(change.fields.map((field) => SCHEDULE_CHANGE_FIELD_NAMES[field.key]).filter(Boolean))
  });
}

export function scheduleClosingEmbed(closing, detectedAt = new Date().toISOString()) {
  const { item, offset } = closing;
  const remain = offset === 0 ? '오늘 마감' : `D-${offset}`;
  return scheduleEmbed({
    title: `⏳ SWAGKEYS 예약판매 마감 ${remain} · ${item.product}`,
    sourceKey: 'reservations',
    item,
    detectedAt,
    extraFields: [{ name: '마감일', value: item.saleEnd, inline: true }]
  });
}

// Pickle formats its own chat notifications, so skip-mode runs print one machine-readable
// line instead of posting Discord embeds. State and Keepodd events advance exactly as usual.
export function skipDiscordSummaryLine({ announcementChanged, quarterChanges, changes, starts, announcement, schedule = null }) {
  return `SWAGKEYS_SUMMARY_JSON=${JSON.stringify({
    announcementChanged,
    quarterChanges,
    changes,
    starts,
    announcement: announcementChanged ? (announcement || null) : null,
    schedule: schedule ? {
      added: schedule.added || [],
      changed: schedule.changed || [],
      closings: (schedule.closings || []).map((closing) => ({
        key: closing.key, offset: closing.offset, saleEnd: closing.saleEnd, item: closing.item
      }))
    } : null
  })}`;
}

// Discord webhook · Discord-less Pickle run · or the legacy pending guard.
export function notificationMode({ webhookUrl = DISCORD_WEBHOOK_URL, skipDiscord = SKIP_DISCORD } = {}) {
  if (skipDiscord) return 'skip';
  return String(webhookUrl || '').trim() ? 'discord' : 'pending';
}

async function postDiscord(embed) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'SWAGKEYS Updates', allowed_mentions: { parse: [] }, embeds: [embed] })
    });
    if (response.ok) return;
    if (response.status === 429 && attempt < 3) {
      let retryAfter = 1;
      try { retryAfter = Number((await response.json())?.retry_after) || 1; } catch {}
      await sleep(Math.ceil(retryAfter * 1000));
      continue;
    }
    throw new Error(`Discord webhook failed: ${response.status} ${await response.text()}`);
  }
}

async function main() {
  const state = loadState();
  const previousRows = Array.isArray(state?.rows) ? state.rows : [];
  const fallback = {
    roadmapLayoutVersion: state?.roadmapLayoutVersion || 1,
    gbStartsNotified: state?.gbStartsNotified || {},
    announcement: state?.announcement,
    quarters: state?.quarters,
    ...(state?.roadmapDates ? { roadmapDates: state.roadmapDates } : {}),
    rows: previousRows,
    fallbackSince: state?.fallbackSince && typeof state.fallbackSince === 'object' ? state.fallbackSince : {}
  };
  let snapshot = await fetchSnapshot(fallback);
  // 키보드·GMK·스위치까지 포함한 예약판매/입고 일정 2곳. 첫 실행은 기준선만 저장한다.
  const previousSchedule = state?.schedule && typeof state.schedule === 'object' ? state.schedule : null;
  const scheduleEvents = buildScheduleEvents({
    schedule: await fetchScheduleSnapshot(previousSchedule),
    previous: previousSchedule,
    now: new Date(),
    roadmapProducts: Object.values(snapshot.quarters || {}).flat().filter((product) => typeof product === 'string')
  });
  snapshot.schedule = scheduleEvents.nextState;
  const roadmapDatesInitialized = !state?.roadmapDates && Boolean(snapshot.roadmapDates);
  console.log(`SWAGKEYS announcement: ${snapshot.announcement.heading}${snapshot.roadmapFresh ? '' : ' (stored fallback)'}`);
  console.log(`SWAGKEYS status rows: ${snapshot.rows.length}${snapshot.statusFresh ? '' : ' (stored fallback)'}`);

  if (!state?.initialized || previousRows.length === 0) {
    console.log(`Baseline initialization: storing ${snapshot.rows.length} SWAGKEYS rows without notifying.`);
    saveState(snapshot);
    return;
  }

  if (!quarterSnapshotIsValid(state.quarters)) {
    console.warn('Stored SWAGKEYS quarter roadmap was incomplete or polluted by Notion error placeholders. Replacing it with a verified snapshot without notifying.');
    saveState(snapshot);
    return;
  }

  const validateRows = (candidateSnapshot) => {
    if (candidateSnapshot.rows.length < Math.max(8, Math.floor(previousRows.length * 0.5))) {
      throw new Error(`SWAGKEYS row count dropped unexpectedly: ${previousRows.length} -> ${candidateSnapshot.rows.length}. State was not updated.`);
    }
  };
  const removalSignature = (candidateQuarterChanges, candidateChanges) => [
    ...candidateQuarterChanges.removed.map((item) => `roadmap|${clean(item.product).toLowerCase()}|${item.quarter}`),
    ...candidateChanges
      .filter((change) => change.kind === 'removed')
      .map((change) => `status|${clean(change.row.product).toLowerCase()}`)
  ].sort().join('\n');
  const calculateChanges = (candidateSnapshot) => {
    const announcementChanged = clean(state.announcement?.heading) !== clean(candidateSnapshot.announcement.heading)
      || clean(state.announcement?.content) !== clean(candidateSnapshot.announcement.content);
    const quarterChanges = suppressLegacySwgQ4Additions(
      state, candidateSnapshot, diffQuarters(state.quarters, candidateSnapshot.quarters)
    );
    quarterChanges.datesChanged = state.roadmapDates && candidateSnapshot.roadmapDates
      ? diffRoadmapDates(state.roadmapDates, candidateSnapshot.roadmapDates)
      : [];
    const changes = diffRows(previousRows, candidateSnapshot.rows);
    const starts = candidateSnapshot.roadmapFresh
      ? dueSwagkeysGbStarts({ roadmapDates: candidateSnapshot.roadmapDates, notified: state.gbStartsNotified, now: new Date().toISOString() })
      : [];
    return { announcementChanged, quarterChanges, quartersChanged: hasQuarterChanges(quarterChanges), changes, starts };
  };

  validateRows(snapshot);
  let calculated = calculateChanges(snapshot);
  let removalVerificationInconclusive = '';
  const firstRemovalSignature = removalSignature(calculated.quarterChanges, calculated.changes);
  if (firstRemovalSignature) {
    const removalNeedsRoadmapFresh = calculated.quarterChanges.removed.length > 0;
    const removalNeedsStatusFresh = calculated.changes.some((change) => change.kind === 'removed');

    console.warn('SWAGKEYS removal detected; re-reading once before notifying.');
    const verificationSnapshot = await fetchSnapshot({ ...fallback, fallbackSince: snapshot.fallbackSince });
    validateRows(verificationSnapshot);
    const verificationCalculated = calculateChanges(verificationSnapshot);

    const staleVerificationSources = [
      removalNeedsRoadmapFresh && !verificationSnapshot.roadmapFresh ? 'roadmap' : '',
      removalNeedsStatusFresh && !verificationSnapshot.statusFresh ? 'status table' : ''
    ].filter(Boolean);

    if (staleVerificationSources.length) {
      removalVerificationInconclusive = `SWAGKEYS removal verification was inconclusive because ${staleVerificationSources.join(' and ')} used stored fallback. Unverified removal changes were deferred, while independent fresh changes were kept.`;
      snapshot = preserveIndependentFreshChanges({
        state,
        previousRows,
        snapshot,
        verificationSnapshot,
        removalNeedsRoadmapFresh,
        removalNeedsStatusFresh
      });
      calculated = calculateChanges(snapshot);
      console.warn(removalVerificationInconclusive);
    } else {
      const secondRemovalSignature = removalSignature(verificationCalculated.quarterChanges, verificationCalculated.changes);
      if (secondRemovalSignature && secondRemovalSignature !== firstRemovalSignature) {
        throw new Error('SWAGKEYS removal set changed during verification. State was not updated.');
      }

      if (secondRemovalSignature) {
        console.log('SWAGKEYS removal confirmed by two consecutive fresh reads.');
      } else {
        snapshot = verificationSnapshot;
        calculated = verificationCalculated;
        console.log('SWAGKEYS removal disappeared on a fresh verification read; using the verified second snapshot.');
      }
    }
  }

  // 삭제 검증 재조회로 snapshot이 교체될 수 있어 일정 상태를 마지막에 다시 붙인다.
  snapshot.schedule = scheduleEvents.nextState;
  let { announcementChanged, quarterChanges, quartersChanged, changes, starts } = calculated;
  const scheduleActivity = scheduleEvents.added.length + scheduleEvents.changed.length + scheduleEvents.closings.length;
  const scheduleStateChanged = JSON.stringify(previousSchedule?.sources || {}) !== JSON.stringify(scheduleEvents.nextState.sources)
    || JSON.stringify(previousSchedule?.closingsNotified || {}) !== JSON.stringify(scheduleEvents.nextState.closingsNotified)
    || JSON.stringify(previousSchedule?.fallbackSince || {}) !== JSON.stringify(scheduleEvents.nextState.fallbackSince);
  console.log(`SWAGKEYS announcement changed: ${announcementChanged}`);
  console.log(`SWAGKEYS quarter roadmap changed: ${quartersChanged}`);
  console.log(`SWAGKEYS product changes: ${changes.length}`);
  console.log(`SWAGKEYS GB starts due: ${starts.length}`);
  console.log(`SWAGKEYS schedule events: ${scheduleEvents.added.length} new / ${scheduleEvents.changed.length} changed / ${scheduleEvents.closings.length} closing${scheduleEvents.baseline ? ' (baseline saved without notifications)' : ''}`);

  snapshot.gbStartsNotified = { ...(state.gbStartsNotified || {}), ...Object.fromEntries(starts.map(row => [row.key, row.saleStart])) };

  if (!announcementChanged && !quartersChanged && changes.length === 0 && starts.length === 0 && scheduleActivity === 0) {
    if (snapshot.fallbackMetadataChanged || roadmapDatesInitialized || snapshot.roadmapLayoutVersion !== (state.roadmapLayoutVersion || 1) || scheduleStateChanged) {
      saveState(snapshot);
      console.log('SWAGKEYS verified roadmap metadata updated without backfilling historical events.');
    } else {
      console.log('No SWAGKEYS state update needed.');
    }
    if (removalVerificationInconclusive) throw new Error(removalVerificationInconclusive);
    return;
  }
  const mode = notificationMode();
  if (mode === 'pending') {
    console.log('[discord] SWAGKEYS_DISCORD_WEBHOOK_URL/SWG_DISCORD_WEBHOOK_URL is not configured. Changes remain pending; state was not updated.');
    return;
  }

  if (state?.initialized && !state?.keepoddScheduleSeededAt && scheduleEvents.nextState.sources?.reservations?.fresh) {
    await seedReservationScheduleKeepoddEvents(snapshot, scheduleEvents);
  }

  if (mode === 'discord') {
    if (announcementChanged) await postDiscord(announcementEmbed(snapshot.announcement));
    if (quartersChanged) await postDiscord(quartersEmbed(quarterChanges));
    for (const start of starts) await postDiscord(gbStartEmbed(start));
    for (const change of changes) {
      if (change.kind === 'added') await postDiscord(addedEmbed(change.row));
      else if (change.kind === 'changed') await postDiscord(changedEmbed(change));
      else await postDiscord(removedEmbed(change.row));
    }
    for (const event of scheduleEvents.added) await postDiscord(scheduleAddedEmbed(event.sourceKey, event.item));
    for (const event of scheduleEvents.changed) await postDiscord(scheduleChangedEmbed(event.sourceKey, event));
    for (const closing of scheduleEvents.closings) await postDiscord(scheduleClosingEmbed(closing));
  }
  await advanceStateWithKeepoddEvents(snapshot, quarterChanges, changes, starts, scheduleEvents);
  if (mode === 'skip') {
    console.log(`SWAGKEYS_SKIP_DISCORD is enabled: ${changes.length + Number(announcementChanged) + Number(quartersChanged) + starts.length + scheduleActivity} change group(s) reported without Discord, state and Keepodd events updated.`);
    console.log(skipDiscordSummaryLine({
      announcementChanged,
      quarterChanges,
      changes,
      starts,
      announcement: snapshot.announcement,
      schedule: scheduleEvents
    }));
  } else {
    console.log(`Sent ${changes.length + Number(announcementChanged) + Number(quartersChanged) + starts.length + scheduleActivity} SWAGKEYS notification(s) and updated state.`);
  }
  if (removalVerificationInconclusive) throw new Error(removalVerificationInconclusive);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
