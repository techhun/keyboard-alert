import fs from 'node:fs';
import { chromium } from 'playwright';
import { bulkChangeInfo, changeId, changeSignature, clean, comparableValue, normalizeKey, pruneSentChanges, validateReleaseRows } from './geonworks-safety.mjs';

const PAGE_URL = 'https://geonworks.kr/customhtml/release/release.html';
const DATA_URL = 'https://script.google.com/macros/s/AKfycbzOHhh_erWY6B-Ru1hpRZbwImXFP4UBWZj6gRiuvcOv9bVPOAIWN3-zGWFaQyIQE6xG/exec';
const STATE_PATH = 'geonworks-release-state.json';
const DISCORD_WEBHOOK_URL = (process.env.GEONWORKS_DISCORD_WEBHOOK_URL || '').trim();

const FIELD_LABELS = {
  manufacturer: '제조사',
  region: '지역',
  saleType: '판매 방식',
  type: '유형',
  status: '상태',
  fixed: '판매 결정',
  start: '판매 시작일',
  end: '판매 종료일'
};

const COMPARED_FIELDS = Object.keys(FIELD_LABELS);
const DATE_LABELS = new Set(['판매 시작일', '판매 종료일']);

function truncate(value, maxLength = 1000) {
  const text = String(value ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map(clean)
    .filter(Boolean)
    .join('\n') || '—';
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function displayValue(label, value) {
  const text = clean(value) || '—';
  if (!DATE_LABELS.has(label)) return truncate(text);

  const dotted = text.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})$/);
  if (dotted) {
    const [, year, month, day] = dotted;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  const dashed = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (dashed) {
    const [, year, month, day] = dashed;
    return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  }

  return truncate(text);
}

function normalizedObjectValue(object, aliases) {
  const entries = new Map(Object.entries(object || {}).map(([key, value]) => [
    clean(key).toLowerCase().replace(/[\s_-]+/g, ''),
    value
  ]));
  for (const alias of aliases) {
    const key = clean(alias).toLowerCase().replace(/[\s_-]+/g, '');
    if (entries.has(key)) return clean(entries.get(key));
  }
  return '';
}

function normalizeReleaseItem(item) {
  if (Array.isArray(item)) {
    if (item.length < 9) return null;
    return {
      product: clean(item[0]),
      manufacturer: clean(item[1]),
      region: clean(item[2]),
      saleType: clean(item[3]),
      type: clean(item[4]),
      status: clean(item[5]),
      fixed: clean(item[6]),
      start: clean(item[7]),
      end: clean(item[8])
    };
  }

  if (!item || typeof item !== 'object') return null;

  const row = {
    product: normalizedObjectValue(item, ['product', 'product name', 'name', 'items', '제품명']),
    manufacturer: normalizedObjectValue(item, ['manufacturer', 'maker', 'brand', '제조사']),
    region: normalizedObjectValue(item, ['region', 'krGlobal', 'kr global', '지역']),
    saleType: normalizedObjectValue(item, ['sale type', 'saletype', 'sale_type', '판매 방식', '판매방식', '분류']),
    type: normalizedObjectValue(item, ['type', '유형']),
    status: normalizedObjectValue(item, ['status', '상태']),
    fixed: normalizedObjectValue(item, ['fixed', '판매 결정', '판매결정']),
    start: normalizedObjectValue(item, ['start', 'start date', 'startdate', 'saleStart', 'sale start', '판매 시작일', '판매시작일']),
    end: normalizedObjectValue(item, ['end', 'end date', 'enddate', 'saleEnd', 'sale end', '판매 종료일', '판매종료일'])
  };

  return row.product ? row : null;
}

function releaseItems(payload) {
  if (Array.isArray(payload)) return payload;

  if (payload && typeof payload === 'object') {
    for (const key of ['data', 'rows', 'items', 'results', 'result', 'releases', 'release']) {
      if (Array.isArray(payload[key])) return payload[key];
    }

    const values = Object.values(payload);
    if (values.length > 0 && values.every((value) => value && typeof value === 'object')) {
      return values;
    }
  }

  return [];
}

async function fetchRowsDirect() {
  const response = await fetch(DATA_URL, {
    headers: { 'accept': 'application/json,text/plain,*/*' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`GEONWORKS Release API HTTP ${response.status}`);

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`GEONWORKS Release API returned non-JSON: ${clean(text).slice(0, 180)}`);
  }

  const rows = releaseItems(payload)
    .map(normalizeReleaseItem)
    .filter((row) => row?.product);

  if (rows.length < 1) {
    const shape = payload && typeof payload === 'object' ? Object.keys(payload).slice(0, 20).join(',') : typeof payload;
    throw new Error(`GEONWORKS Release API returned no recognizable rows; shape=${shape}`);
  }

  validateReleaseRows(rows);
  console.log(`GEONWORKS Release direct rows: ${rows.length}`);
  return rows;
}

async function fetchRowsBrowser() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });

  try {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1600 },
      locale: 'ko-KR'
    });

    await page.goto(PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(() => {
      const selectors = ['#tableBody tr', 'tbody tr', 'table tr'];
      return selectors.some((selector) => [...document.querySelectorAll(selector)]
        .some((tr) => tr.querySelectorAll('td').length >= 9));
    }, { timeout: 30000 });
    await page.waitForTimeout(700);

    const rows = await page.evaluate(() => {
      const cleanText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
      const selectors = ['#tableBody tr', 'tbody tr', 'table tr'];
      let rowEls = [];

      for (const selector of selectors) {
        const candidates = [...document.querySelectorAll(selector)]
          .filter((tr) => tr.querySelectorAll('td').length >= 9);
        if (candidates.length) {
          rowEls = candidates;
          break;
        }
      }

      return rowEls
        .map((tr) => [...tr.querySelectorAll('td')].map((td) => cleanText(td.innerText)))
        .filter((cells) => cells.length >= 9 && cells[0])
        .map((cells) => ({
          product: cells[0],
          manufacturer: cells[1],
          region: cells[2],
          saleType: cells[3],
          type: cells[4],
          status: cells[5],
          fixed: cells[6],
          start: cells[7],
          end: cells[8]
        }));
    });

    validateReleaseRows(rows);
    console.log(`GEONWORKS Release browser fallback rows: ${rows.length}`);
    return rows;
  } finally {
    await browser.close();
  }
}

async function fetchRows() {
  try {
    return await fetchRowsDirect();
  } catch (error) {
    console.warn(`GEONWORKS Release direct fetch failed; using browser fallback: ${error?.message || error}`);
    return fetchRowsBrowser();
  }
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function saveState(rows, sentChanges = {}) {
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({
      version: 1,
      initialized: true,
      updatedAt: new Date().toISOString(),
      rows,
      sentChanges: pruneSentChanges(sentChanges)
    }, null, 2) + '\n'
  );
}

function buildMap(rows) {
  const nameCounts = new Map();
  for (const row of rows) {
    const name = normalizeKey(row.product);
    nameCounts.set(name, (nameCounts.get(name) || 0) + 1);
  }

  const map = new Map();
  for (const row of rows) {
    const name = normalizeKey(row.product);
    const key = nameCounts.get(name) > 1
      ? [name, row.manufacturer, row.region, row.saleType, row.start].map(normalizeKey).join('|')
      : name;
    map.set(key, row);
  }
  return map;
}

function diffRows(previousRows, currentRows) {
  const previous = buildMap(previousRows);
  const current = buildMap(currentRows);
  const changes = [];

  for (const [key, row] of current) {
    const before = previous.get(key);
    if (!before) {
      changes.push({ kind: 'added', row });
      continue;
    }

    const fields = COMPARED_FIELDS
      .filter((field) => comparableValue(before[field]) !== comparableValue(row[field]))
      .map((field) => ({
        field,
        label: FIELD_LABELS[field],
        before: before[field] || '—',
        after: row[field] || '—'
      }));

    if (fields.length) changes.push({ kind: 'changed', row, before, fields });
  }

  for (const [key, row] of previous) {
    if (!current.has(key)) changes.push({ kind: 'removed', row });
  }

  return changes;
}

async function postDiscord(embed) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'GEONWORKS Alert',
        allowed_mentions: { parse: [] },
        embeds: [embed]
      })
    });

    if (response.ok) return;

    if (response.status === 429 && attempt < 3) {
      let retryAfter = 1;
      try {
        const body = await response.json();
        retryAfter = Number(body?.retry_after) || 1;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(retryAfter * 1000)));
      continue;
    }

    throw new Error(`Discord webhook failed: ${response.status} ${await response.text()}`);
  }
}

function baseEmbed(title) {
  return {
    title: truncate(title, 250),
    url: PAGE_URL,
    footer: { text: 'GEONWORKS · Release 알림' },
    timestamp: new Date().toISOString()
  };
}

function addedEmbed(row) {
  return {
    ...baseEmbed(`📅 출시 일정 추가 · ${row.product}`),
    fields: [
      ['제조사', row.manufacturer],
      ['지역', row.region],
      ['판매 방식', row.saleType],
      ['유형', row.type],
      ['상태', row.status],
      ['판매 결정', row.fixed],
      ['판매 시작일', row.start],
      ['판매 종료일', row.end]
    ].map(([name, value]) => ({ name, value: displayValue(name, value), inline: true }))
  };
}

function changedEmbed(change) {
  return {
    ...baseEmbed(`🔄 출시 일정 변경 · ${change.row.product}`),
    description: `변경된 항목 **${change.fields.length}개**`,
    fields: change.fields.slice(0, 25).map((field) => ({
      name: field.label,
      value: truncate(`이전: ${displayValue(field.label, field.before)}\n현재: ${displayValue(field.label, field.after)}`),
      inline: false
    }))
  };
}

function removedEmbed(row) {
  return {
    ...baseEmbed(`➖ 출시 예정표에서 제거 · ${row.product}`),
    description: 'GEONWORKS Release의 현재 목록에서 사라졌습니다.',
    fields: [
      { name: '제조사', value: truncate(row.manufacturer), inline: true },
      { name: '판매 방식', value: truncate(row.saleType), inline: true },
      { name: '상태', value: truncate(row.status), inline: true },
      { name: '판매 시작일', value: displayValue('판매 시작일', row.start), inline: true },
      { name: '판매 종료일', value: displayValue('판매 종료일', row.end), inline: true }
    ]
  };
}

async function notify(change) {
  if (change.kind === 'added') return postDiscord(addedEmbed(change.row));
  if (change.kind === 'changed') return postDiscord(changedEmbed(change));
  return postDiscord(removedEmbed(change.row));
}

let rows = await fetchRows();
console.log(`GEONWORKS Release rows: ${rows.length}`);
console.log('GEONWORKS Release sample:', JSON.stringify(rows[0], null, 2));

const state = loadState();
const previousRows = Array.isArray(state?.rows) ? state.rows : [];
let sentChanges = pruneSentChanges(state?.sentChanges || {});

if (!state?.initialized || previousRows.length === 0) {
  console.log(`Baseline initialization: storing ${rows.length} GEONWORKS Release rows without notifying.`);
  saveState(rows, sentChanges);
  process.exit(0);
}

const validateRows = (candidateRows) => {
  validateReleaseRows(candidateRows);
  if (candidateRows.length < Math.max(1, Math.floor(previousRows.length * 0.5))) {
    throw new Error(`GEONWORKS Release row count dropped unexpectedly: ${previousRows.length} -> ${candidateRows.length}. State was not updated.`);
  }
};
const removalSignature = (candidateChanges) => candidateChanges
  .filter((change) => change.kind === 'removed')
  .map((change) => JSON.stringify(change.row))
  .sort()
  .join('\n');

validateRows(rows);
let changes = diffRows(previousRows, rows);
let bulkInfo = bulkChangeInfo(changes, previousRows.length);
const firstRemovalSignature = removalSignature(changes);
const needsVerification = Boolean(firstRemovalSignature) || bulkInfo.bulk;

if (needsVerification) {
  console.warn(`GEONWORKS Release ${bulkInfo.bulk ? `bulk change detected (${bulkInfo.count}, ${Math.round(bulkInfo.ratio * 100)}%)` : 'removal detected'}; re-reading once before notifying.`);
  const firstSignature = changeSignature(changes);
  const verificationRows = await fetchRows();
  validateRows(verificationRows);
  const verificationChanges = diffRows(previousRows, verificationRows);
  const secondSignature = changeSignature(verificationChanges);

  if (firstSignature !== secondSignature) {
    throw new Error('GEONWORKS Release change set changed during verification. State was not updated.');
  }

  rows = verificationRows;
  changes = verificationChanges;
  bulkInfo = bulkChangeInfo(changes, previousRows.length);
  console.log(`GEONWORKS Release change set confirmed by two consecutive reads: ${changes.length} change(s).`);
}

console.log(`GEONWORKS Release changes: ${changes.length}`);

for (const change of changes) {
  if (change.kind === 'changed') {
    console.log('Changed:', change.row.product, change.fields.map((x) => x.label).join(', '));
  } else {
    console.log(`${change.kind}:`, change.row.product);
  }
}

if (changes.length === 0) {
  if (JSON.stringify(sentChanges) !== JSON.stringify(state?.sentChanges || {})) saveState(previousRows, sentChanges);
  console.log('No GEONWORKS Release state update needed.');
  process.exit(0);
}

const pendingChanges = changes.filter((change) => !sentChanges[changeId(change)]);
if (pendingChanges.length !== changes.length) {
  console.log(`GEONWORKS duplicate suppression: ${changes.length - pendingChanges.length} already-sent change(s) skipped.`);
}

if (!DISCORD_WEBHOOK_URL) {
  console.log('[discord] GEONWORKS_DISCORD_WEBHOOK_URL is not configured. Changes remain pending; state was not updated.');
  process.exit(0);
}

for (const change of pendingChanges) {
  await notify(change);
  sentChanges[changeId(change)] = new Date().toISOString();
  saveState(previousRows, sentChanges);
}

saveState(rows, sentChanges);
console.log(`Sent ${pendingChanges.length} GEONWORKS Release notification(s), suppressed ${changes.length - pendingChanges.length} duplicate(s), and updated state.`);
