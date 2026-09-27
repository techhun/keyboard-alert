import fs from 'node:fs';
import { bulkChangeInfo, clean, pruneSentChanges } from './geonworks-safety.mjs';
import {
  diffKbdFansRows,
  kbdFansChangeId,
  kbdFansChangeSignature,
  parseKbdFansUpdatesHtml,
  validateKbdFansRows
} from './kbdfans-safety.mjs';

const PAGE_URL = 'https://kbdfans.com/apps/kbd-notify/product-updates';
const STATE_PATH = 'kbdfans-state.json';
const DISCORD_WEBHOOK_URL = (process.env.KBDFANS_DISCORD_WEBHOOK_URL || '').trim();

function truncate(value, maxLength = 1000) {
  const text = String(value ?? '')
    .replace(/\r/g, '')
    .split('\n')
    .map(clean)
    .filter(Boolean)
    .join('\n') || '—';
  if (text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength - 1)).trimEnd() + '…';
}

function displayField(field, value) {
  if (field === 'progress') return String(value ?? 0) + '%';
  return truncate(value);
}

async function fetchRows() {
  const response = await fetch(PAGE_URL, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'keyboard-alert/1.0 (+https://github.com/techhun/keyboard-alert)'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('KBDfans Product Updates HTTP ' + response.status);

  const rows = parseKbdFansUpdatesHtml(await response.text());
  console.log('KBDfans direct rows: ' + rows.length);
  return rows;
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

async function postDiscord(embed) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'KBDfans Alert',
        allowed_mentions: { parse: [] },
        embeds: [embed]
      })
    });

    if (response.ok) return;
    if (response.status === 429 && attempt < 3) {
      let retryAfter = 1;
      try { retryAfter = Number((await response.json())?.retry_after) || 1; } catch {}
      await new Promise((resolve) => setTimeout(resolve, Math.ceil(retryAfter * 1000)));
      continue;
    }
    throw new Error('Discord webhook failed: ' + response.status + ' ' + await response.text());
  }
}

function baseEmbed(title) {
  return {
    title: truncate(title, 250),
    url: PAGE_URL,
    footer: { text: 'KBDfans · Product Updates 알림' },
    timestamp: new Date().toISOString()
  };
}

function updateFields(row) {
  const fields = [
    { name: '분류', value: truncate(row.category), inline: true },
    { name: '상태', value: truncate(row.status), inline: true },
    { name: 'ETA', value: truncate(row.eta), inline: true },
    { name: '진행률', value: String(row.progress) + '%', inline: true }
  ];

  if (clean(row.summary) && !/^No update summary yet\.?$/i.test(clean(row.summary))) {
    fields.push({ name: '요약', value: truncate(row.summary), inline: false });
  }

  if (clean(row.latestUpdateDate) || clean(row.latestUpdateTitle) || clean(row.latestUpdateBody)) {
    fields.push({
      name: '최근 업데이트',
      value: truncate([
        row.latestUpdateDate,
        row.latestUpdateTitle,
        row.latestUpdateBody
      ].filter((value) => clean(value)).join('\n')),
      inline: false
    });
  }

  return fields.slice(0, 25);
}

function addedEmbed(row) {
  return {
    ...baseEmbed('🆕 KBDfans 프로젝트 추가 · ' + row.product),
    fields: updateFields(row)
  };
}

function changedEmbed(change) {
  return {
    ...baseEmbed('🔄 KBDfans 업데이트 · ' + change.row.product),
    description: change.row.category + ' · 변경된 항목 **' + change.fields.length + '개**',
    fields: change.fields.slice(0, 25).map((field) => ({
      name: field.label,
      value: truncate(
        '이전: ' + displayField(field.field, field.before) +
        '\n현재: ' + displayField(field.field, field.after)
      ),
      inline: false
    }))
  };
}

function removedEmbed(row) {
  return {
    ...baseEmbed('➖ KBDfans 목록에서 제거 · ' + row.product),
    description: 'KBDfans Product Updates의 현재 목록에서 사라졌습니다.',
    fields: updateFields(row)
  };
}

async function notify(change) {
  if (change.kind === 'added') return postDiscord(addedEmbed(change.row));
  if (change.kind === 'changed') return postDiscord(changedEmbed(change));
  return postDiscord(removedEmbed(change.row));
}

let rows = await fetchRows();
console.log('KBDfans rows: ' + rows.length);
console.log('KBDfans category counts:', JSON.stringify(
  Object.fromEntries([...new Set(rows.map((row) => row.category))]
    .map((category) => [category, rows.filter((row) => row.category === category).length]))
));
console.log('KBDfans sample:', JSON.stringify(rows[0], null, 2));

const state = loadState();
const previousRows = Array.isArray(state?.rows) ? state.rows : [];
let sentChanges = pruneSentChanges(state?.sentChanges || {});

if (!state?.initialized || previousRows.length === 0) {
  console.log('Baseline initialization: storing ' + rows.length + ' KBDfans rows without notifying.');
  saveState(rows, sentChanges);
  process.exit(0);
}

const validateRows = (candidateRows) => {
  validateKbdFansRows(candidateRows);
  if (candidateRows.length < Math.max(30, Math.floor(previousRows.length * 0.6))) {
    throw new Error('KBDfans row count dropped unexpectedly: ' + previousRows.length + ' -> ' + candidateRows.length + '. State was not updated.');
  }
};

validateRows(rows);
let changes = diffKbdFansRows(previousRows, rows);
let bulkInfo = bulkChangeInfo(changes, previousRows.length);
const needsVerification = changes.some((change) => change.kind === 'removed') || bulkInfo.bulk;

if (needsVerification) {
  console.warn('KBDfans ' + (bulkInfo.bulk ? 'bulk change detected (' + bulkInfo.count + ', ' + Math.round(bulkInfo.ratio * 100) + '%)' : 'removal detected') + '; re-reading once before notifying.');
  const firstSignature = kbdFansChangeSignature(changes);
  const verificationRows = await fetchRows();
  validateRows(verificationRows);
  const verificationChanges = diffKbdFansRows(previousRows, verificationRows);
  const secondSignature = kbdFansChangeSignature(verificationChanges);

  if (firstSignature !== secondSignature) {
    throw new Error('KBDfans change set changed during verification. State was not updated.');
  }

  rows = verificationRows;
  changes = verificationChanges;
  bulkInfo = bulkChangeInfo(changes, previousRows.length);
  console.log('KBDfans change set confirmed by two consecutive reads: ' + changes.length + ' change(s).');
}

console.log('KBDfans changes: ' + changes.length);
for (const change of changes) {
  if (change.kind === 'changed') {
    console.log('Changed:', change.row.product, change.fields.map((field) => field.label).join(', '));
  } else {
    console.log(change.kind + ':', change.row.product);
  }
}

if (changes.length === 0) {
  if (JSON.stringify(sentChanges) !== JSON.stringify(state?.sentChanges || {})) saveState(previousRows, sentChanges);
  console.log('No KBDfans state update needed.');
  process.exit(0);
}

const pendingChanges = changes.filter((change) => !sentChanges[kbdFansChangeId(change)]);
if (pendingChanges.length !== changes.length) {
  console.log('KBDfans duplicate suppression: ' + (changes.length - pendingChanges.length) + ' already-sent change(s) skipped.');
}

if (!DISCORD_WEBHOOK_URL) {
  console.log('[discord] KBDFANS_DISCORD_WEBHOOK_URL is not configured. Changes remain pending; state was not updated.');
  process.exit(0);
}

if (bulkInfo.bulk) {
  const bulkId = kbdFansChangeId({
    kind: 'changed',
    row: { category: 'BULK', product: 'KBDfans bulk' },
    fields: [{ field: 'signature', before: '', after: kbdFansChangeSignature(changes) }]
  });

  if (sentChanges[bulkId]) {
    saveState(rows, sentChanges);
    console.log('Duplicate KBDfans bulk summary suppressed; state advanced.');
    process.exit(0);
  }

  await postDiscord({
    ...baseEmbed('⚠️ KBDfans 대량 변경 확인'),
    description: '동일한 변경을 두 번 연속 확인했습니다. 개별 알림 대신 요약합니다.\n변경 항목: **' + changes.length + '개** / 기존 목록: **' + previousRows.length + '개**',
    fields: [{
      name: '변경 예시',
      value: truncate(changes.slice(0, 10).map((change) => {
        const labels = change.kind === 'changed'
          ? change.fields.map((field) => field.label).join(', ')
          : change.kind;
        return '• [' + change.row.category + '] ' + change.row.product + ': ' + labels;
      }).join('\n')),
      inline: false
    }]
  });

  sentChanges[bulkId] = new Date().toISOString();
  saveState(rows, sentChanges);
  console.log('Bulk KBDfans change summarized in one notification and state updated: ' + changes.length + ' change(s).');
  process.exit(0);
}

for (const change of pendingChanges) {
  await notify(change);
  sentChanges[kbdFansChangeId(change)] = new Date().toISOString();
  saveState(previousRows, sentChanges);
}

saveState(rows, sentChanges);
console.log('Sent ' + pendingChanges.length + ' KBDfans notification(s), suppressed ' + (changes.length - pendingChanges.length) + ' duplicate(s), and updated state.');
