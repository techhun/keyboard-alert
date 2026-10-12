import fs from 'node:fs';
import { chromium } from 'playwright';
import { bulkChangeInfo, changeId, changeSignature, clean, comparableValue, normalizeKey, pruneSentChanges, parseGbGvizResponse, validateGbRows } from './geonworks-safety.mjs';
import { buildGeonworksKeepoddEvents, commitStateAndKeepoddEvents, enrichKeepoddEventSourceUrls } from './lib/keepodd-events.mjs';

const PAGE_URL = 'https://geonworks.kr/customhtml/GB_schedule.html';
const DATA_URL = 'https://docs.google.com/spreadsheets/d/1i9SK14aWxpElXrjMinidKjVCXDi1XXBQSZJVB7ocbJk/gviz/tq?tqx=out:json&sheet=GB%20Schedule';
const STATE_PATH = 'geonworks-state.json';
const DISCORD_WEBHOOK_URL = (process.env.GEONWORKS_DISCORD_WEBHOOK_URL || '').trim();

const FIELD_LABELS = {
  gbStart: 'GB 시작일',
  eta: '예상 발송일',
  type: '분류',
  manufacturer: '제조사',
  status: '상태',
  update: '갱신 일자',
  note: '비고'
};

const COMPARED_FIELDS = Object.keys(FIELD_LABELS);
const DATE_LABELS = new Set(['GB 시작일', '예상 발송일', '갱신 일자', '마지막 갱신']);

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

  const match = text.match(/^(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})$/);
  if (!match) return truncate(text);

  const [, year, month, day] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
}

async function fetchRowsDirect() {
  const response = await fetch(DATA_URL, {
    headers: { 'accept': 'application/json,text/plain,*/*' },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`GEONWORKS gviz HTTP ${response.status}`);

  const rows = parseGbGvizResponse(await response.text());
  console.log(`GEONWORKS GB direct rows: ${rows.length}`);
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
    await page.waitForSelector('#tableBody tr', { timeout: 30000 });
    await page.waitForTimeout(500);

    const rows = await page.evaluate(() => {
      const cleanText = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

      return [...document.querySelectorAll('#tableBody tr')]
        .map((tr) => [...tr.querySelectorAll('td')].map((td) => cleanText(td.innerText)))
        .filter((cells) => cells.length >= 8 && cells[0])
        .map((cells) => ({
          product: cells[0],
          gbStart: cells[1],
          eta: cells[2],
          type: cells[3],
          manufacturer: cells[4],
          status: cells[5],
          update: cells[6],
          note: cells[7] || '—'
        }));
    });

    validateGbRows(rows);
    console.log(`GEONWORKS GB browser fallback rows: ${rows.length}`);
    return rows;
  } finally {
    await browser.close();
  }
}

async function fetchRows() {
  try {
    return await fetchRowsDirect();
  } catch (error) {
    console.warn(`GEONWORKS direct fetch failed; using browser fallback: ${error?.message || error}`);
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

function statePayload(rows, sentChanges = {}, updatedAt = new Date().toISOString()) {
  return {
    version: 1,
    initialized: true,
    updatedAt,
    rows,
    sentChanges: pruneSentChanges(sentChanges)
  };
}

function saveState(rows, sentChanges = {}) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(statePayload(rows, sentChanges), null, 2) + '\n');
}

async function advanceStateWithKeepoddEvents(rows, sentChanges, changes) {
  const occurredAt = new Date().toISOString();
  const candidates = buildGeonworksKeepoddEvents(changes, { occurredAt, fallbackUrl: PAGE_URL });
  const events = await enrichKeepoddEventSourceUrls(candidates);
  const merged = commitStateAndKeepoddEvents({
    statePath: STATE_PATH,
    stateValue: statePayload(rows, sentChanges, occurredAt),
    events,
    now: occurredAt
  });
  console.log(`Keepodd GEONWORKS events committed: ${merged.added} new / ${events.length} candidate(s).`);
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
      ? `${name}|${normalizeKey(row.manufacturer)}|${normalizeKey(row.gbStart)}`
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
    footer: { text: 'GEONWORKS · GB Schedule 알림' },
    timestamp: new Date().toISOString()
  };
}

function addedEmbed(row) {
  return {
    ...baseEmbed(`🆕 신규 GB · ${row.product}`),
    fields: [
      ['GB 시작일', row.gbStart],
      ['예상 발송일', row.eta],
      ['분류', row.type],
      ['제조사', row.manufacturer],
      ['상태', row.status],
      ['갱신 일자', row.update],
      ['비고', row.note]
    ].map(([name, value]) => ({ name, value: displayValue(name, value), inline: name !== '비고' }))
  };
}

function changedEmbed(change) {
  return {
    ...baseEmbed(`🔄 GB 업데이트 · ${change.row.product}`),
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
    ...baseEmbed(`➖ GB 목록에서 제거 · ${row.product}`),
    description: 'GEONWORKS GB Schedule의 현재 목록에서 사라졌습니다.',
    fields: [
      { name: '마지막 상태', value: truncate(row.status), inline: true },
      { name: '예상 발송일', value: displayValue('예상 발송일', row.eta), inline: true },
      { name: '마지막 갱신', value: displayValue('마지막 갱신', row.update), inline: true },
      { name: '비고', value: truncate(row.note), inline: false }
    ]
  };
}

async function notify(change) {
  if (change.kind === 'added') return postDiscord(addedEmbed(change.row));
  if (change.kind === 'changed') return postDiscord(changedEmbed(change));
  return postDiscord(removedEmbed(change.row));
}

let rows = await fetchRows();
console.log(`GEONWORKS GB rows: ${rows.length}`);
console.log('GEONWORKS sample:', JSON.stringify(rows[0], null, 2));

const state = loadState();
const previousRows = Array.isArray(state?.rows) ? state.rows : [];
let sentChanges = pruneSentChanges(state?.sentChanges || {});

if (!state?.initialized || previousRows.length === 0) {
  console.log(`Baseline initialization: storing ${rows.length} GEONWORKS rows without notifying.`);
  saveState(rows, sentChanges);
  process.exit(0);
}

const validateRows = (candidateRows) => {
  validateGbRows(candidateRows);
  if (candidateRows.length < Math.max(5, Math.floor(previousRows.length * 0.5))) {
    throw new Error(`GEONWORKS row count dropped unexpectedly: ${previousRows.length} -> ${candidateRows.length}. State was not updated.`);
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
  console.warn(`GEONWORKS ${bulkInfo.bulk ? `bulk change detected (${bulkInfo.count}, ${Math.round(bulkInfo.ratio * 100)}%)` : 'removal detected'}; re-reading once before notifying.`);
  const firstSignature = changeSignature(changes);
  const verificationRows = await fetchRows();
  validateRows(verificationRows);
  const verificationChanges = diffRows(previousRows, verificationRows);
  const secondSignature = changeSignature(verificationChanges);

  if (firstSignature !== secondSignature) {
    throw new Error('GEONWORKS change set changed during verification. State was not updated.');
  }

  rows = verificationRows;
  changes = verificationChanges;
  bulkInfo = bulkChangeInfo(changes, previousRows.length);
  console.log(`GEONWORKS change set confirmed by two consecutive reads: ${changes.length} change(s).`);
}

console.log(`GEONWORKS changes: ${changes.length}`);

for (const change of changes) {
  if (change.kind === 'changed') {
    console.log('Changed:', change.row.product, change.fields.map((x) => x.label).join(', '));
  } else {
    console.log(`${change.kind}:`, change.row.product);
  }
}

if (changes.length === 0) {
  if (JSON.stringify(sentChanges) !== JSON.stringify(state?.sentChanges || {})) saveState(previousRows, sentChanges);
  console.log('No GEONWORKS state update needed.');
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

if (bulkInfo.bulk) {
  const bulkId = changeId({ kind: 'bulk', row: { product: 'GEONWORKS GB bulk' }, fields: [{ field: 'signature', before: '', after: changeSignature(changes) }] });
  if (sentChanges[bulkId]) {
    await advanceStateWithKeepoddEvents(rows, sentChanges, changes);
    console.log('Duplicate GEONWORKS bulk summary suppressed; state advanced.');
    process.exit(0);
  }
  await postDiscord({
    ...baseEmbed('⚠️ GEONWORKS 대량 변경 확인'),
    description: `동일한 변경을 두 번 연속 확인했습니다. 개별 알림 대신 요약합니다.\n변경 항목: **${changes.length}개** / 기존 목록: **${previousRows.length}개**`,
    fields: [
      {
        name: '변경 예시',
        value: truncate(changes.slice(0, 10).map((change) => {
          const labels = change.kind === 'changed'
            ? change.fields.map((field) => field.label).join(', ')
            : change.kind;
          return `• ${change.row.product}: ${labels}`;
        }).join('\n')),
        inline: false
      }
    ]
  });
  sentChanges[bulkId] = new Date().toISOString();
  await advanceStateWithKeepoddEvents(rows, sentChanges, changes);
  console.log(`Bulk GEONWORKS change summarized in one notification and state updated: ${changes.length} change(s).`);
  process.exit(0);
}

for (const change of pendingChanges) {
  await notify(change);
  sentChanges[changeId(change)] = new Date().toISOString();
  saveState(previousRows, sentChanges);
}

await advanceStateWithKeepoddEvents(rows, sentChanges, changes);
console.log(`Sent ${pendingChanges.length} GEONWORKS notification(s), suppressed ${changes.length - pendingChanges.length} duplicate(s), and updated state.`);
