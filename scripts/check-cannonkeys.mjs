import fs from 'node:fs';
import { bulkChangeInfo, clean, pruneSentChanges } from './geonworks-safety.mjs';
import {
  cannonKeysChangeId,
  cannonKeysChangeSignature,
  diffCannonKeysRows,
  normalizeCannonKeysRows,
  validateCannonKeysIndex,
  validateCannonKeysRows
} from './cannonkeys-safety.mjs';

const PAGE_URL = 'https://cannonkeys.com/pages/project-updates';
const API_BASE = 'https://backend.cannonkeys.com/api/v1/public/updates/';
const STATE_PATH = 'cannonkeys-state.json';
const DISCORD_WEBHOOK_URL = (process.env.CANNONKEYS_DISCORD_WEBHOOK_URL || '').trim();
const DETAIL_CHUNK_SIZE = 40;

const STATUS_LABELS = {
  ordered: 'Ordered',
  manufacturing: 'Manufacturing',
  en_route: 'En Route',
  shipping: 'Shipping',
  complete: 'Complete'
};

const CATEGORY_LABELS = {
  keyboard: 'Keyboard',
  keyset: 'Keyset',
  deskmat: 'Deskmat',
  other: 'Other'
};

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

function stripMarkdown(value) {
  return clean(String(value ?? '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_~>#]/g, '')
    .replace(/\x60/g, '')
    .replace(/\s+/g, ' '));
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'keyboard-alert/1.0 (+https://github.com/techhun/keyboard-alert)'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error('CannonKeys API HTTP ' + response.status + ': ' + url);
  return response.json();
}

async function fetchRows() {
  const index = validateCannonKeysIndex(await fetchJson(API_BASE + 'index'));
  const ids = index.map((item) => Number(item.id));
  const details = [];

  for (let offset = 0; offset < ids.length; offset += DETAIL_CHUNK_SIZE) {
    const chunk = ids.slice(offset, offset + DETAIL_CHUNK_SIZE);
    const payload = await fetchJson(API_BASE + 'bulk?ids=' + encodeURIComponent(chunk.join(',')));
    const data = Array.isArray(payload?.data) ? payload.data : [];
    const nonexistent = Array.isArray(payload?.nonexistent_ids) ? payload.nonexistent_ids : [];

    if (nonexistent.length > 0) {
      throw new Error('CannonKeys bulk response reported nonexistent ids: ' + nonexistent.join(','));
    }
    if (data.length !== chunk.length) {
      throw new Error('CannonKeys bulk response count mismatch: expected ' + chunk.length + ', got ' + data.length);
    }

    details.push(...data);
  }

  const rows = normalizeCannonKeysRows(details);
  if (rows.length !== index.length) {
    throw new Error('CannonKeys index/detail count mismatch: ' + index.length + ' vs ' + rows.length);
  }

  console.log('CannonKeys index rows: ' + index.length);
  console.log('CannonKeys detail rows: ' + rows.length);
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
        username: 'CannonKeys Alert',
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
    footer: { text: 'CannonKeys · Project Updates 알림' },
    timestamp: new Date().toISOString()
  };
}

function rowFields(row) {
  const fields = [
    { name: '분류', value: CATEGORY_LABELS[row.category] || row.category || '—', inline: true },
    { name: '상태', value: STATUS_LABELS[row.status] || row.status || '—', inline: true },
    { name: 'ETA', value: truncate(row.eta), inline: true }
  ];

  if (row.startDate || row.endDate) {
    fields.push({
      name: 'GB 기간',
      value: truncate((row.startDate || '—') + ' → ' + (row.endDate || '—')),
      inline: false
    });
  }

  if (row.latestUpdateDate || row.latestUpdateDescription) {
    fields.push({
      name: '최근 업데이트',
      value: truncate([
        row.latestUpdateDate,
        stripMarkdown(row.latestUpdateDescription)
      ].filter(Boolean).join('\n')),
      inline: false
    });
  }

  return fields.slice(0, 25);
}

function addedEmbed(row) {
  return {
    ...baseEmbed('🆕 CannonKeys 프로젝트 추가 · ' + row.displayName),
    fields: rowFields(row)
  };
}

function changedEmbed(change) {
  return {
    ...baseEmbed('🔄 CannonKeys 업데이트 · ' + change.row.displayName),
    description: (CATEGORY_LABELS[change.row.category] || change.row.category) + ' · 변경된 항목 **' + change.fields.length + '개**',
    fields: change.fields.slice(0, 25).map((field) => ({
      name: field.label,
      value: truncate('이전: ' + (field.before || '—') + '\n현재: ' + (field.after || '—')),
      inline: false
    }))
  };
}

function removedEmbed(row) {
  return {
    ...baseEmbed('➖ CannonKeys 목록에서 제거 · ' + row.displayName),
    description: 'CannonKeys Project Updates의 현재 목록에서 사라졌습니다.',
    fields: rowFields(row)
  };
}

async function notify(change) {
  if (change.kind === 'added') return postDiscord(addedEmbed(change.row));
  if (change.kind === 'changed') return postDiscord(changedEmbed(change));
  return postDiscord(removedEmbed(change.row));
}

let rows = await fetchRows();
console.log('CannonKeys rows: ' + rows.length);
console.log('CannonKeys category counts:', JSON.stringify(
  Object.fromEntries([...new Set(rows.map((row) => row.category))]
    .map((category) => [category, rows.filter((row) => row.category === category).length]))
));
console.log('CannonKeys status counts:', JSON.stringify(
  Object.fromEntries([...new Set(rows.map((row) => row.status))]
    .map((status) => [status, rows.filter((row) => row.status === status).length]))
));

const latestUpdateSample = rows
  .filter((row) => row.latestUpdateDate)
  .sort((a, b) => Date.parse(b.latestUpdateDate) - Date.parse(a.latestUpdateDate))[0];

if (latestUpdateSample) {
  console.log('CannonKeys latest update sample:', JSON.stringify(latestUpdateSample, null, 2));
}

const state = loadState();
const previousRows = Array.isArray(state?.rows) ? state.rows : [];
let sentChanges = pruneSentChanges(state?.sentChanges || {});

if (!state?.initialized || previousRows.length === 0) {
  console.log('Baseline initialization: storing ' + rows.length + ' CannonKeys rows without notifying.');
  saveState(rows, sentChanges);
  process.exit(0);
}

const validateRows = (candidateRows) => {
  validateCannonKeysRows(candidateRows);
  if (candidateRows.length < Math.max(100, Math.floor(previousRows.length * 0.6))) {
    throw new Error('CannonKeys row count dropped unexpectedly: ' + previousRows.length + ' -> ' + candidateRows.length + '. State was not updated.');
  }
};

validateRows(rows);
let changes = diffCannonKeysRows(previousRows, rows);
let bulkInfo = bulkChangeInfo(changes, previousRows.length);
const needsVerification = changes.some((change) => change.kind === 'removed') || bulkInfo.bulk;

if (needsVerification) {
  console.warn('CannonKeys ' + (bulkInfo.bulk ? 'bulk change detected (' + bulkInfo.count + ', ' + Math.round(bulkInfo.ratio * 100) + '%)' : 'removal detected') + '; re-reading once before notifying.');
  const firstSignature = cannonKeysChangeSignature(changes);
  const verificationRows = await fetchRows();
  validateRows(verificationRows);
  const verificationChanges = diffCannonKeysRows(previousRows, verificationRows);
  const secondSignature = cannonKeysChangeSignature(verificationChanges);

  if (firstSignature !== secondSignature) {
    throw new Error('CannonKeys change set changed during verification. State was not updated.');
  }

  rows = verificationRows;
  changes = verificationChanges;
  bulkInfo = bulkChangeInfo(changes, previousRows.length);
  console.log('CannonKeys change set confirmed by two consecutive reads: ' + changes.length + ' change(s).');
}

console.log('CannonKeys changes: ' + changes.length);
for (const change of changes) {
  if (change.kind === 'changed') {
    console.log('Changed:', change.row.displayName, change.fields.map((field) => field.label).join(', '));
  } else {
    console.log(change.kind + ':', change.row.displayName);
  }
}

if (changes.length === 0) {
  if (JSON.stringify(sentChanges) !== JSON.stringify(state?.sentChanges || {})) saveState(previousRows, sentChanges);
  console.log('No CannonKeys state update needed.');
  process.exit(0);
}

const pendingChanges = changes.filter((change) => !sentChanges[cannonKeysChangeId(change)]);
if (pendingChanges.length !== changes.length) {
  console.log('CannonKeys duplicate suppression: ' + (changes.length - pendingChanges.length) + ' already-sent change(s) skipped.');
}

if (!DISCORD_WEBHOOK_URL) {
  console.log('[discord] CANNONKEYS_DISCORD_WEBHOOK_URL is not configured. Changes remain pending; state was not updated.');
  process.exit(0);
}

if (bulkInfo.bulk) {
  const bulkId = cannonKeysChangeId({
    kind: 'changed',
    row: { id: 0, displayName: 'CannonKeys bulk' },
    fields: [{ field: 'signature', before: '', after: cannonKeysChangeSignature(changes) }]
  });

  if (sentChanges[bulkId]) {
    saveState(rows, sentChanges);
    console.log('Duplicate CannonKeys bulk summary suppressed; state advanced.');
    process.exit(0);
  }

  await postDiscord({
    ...baseEmbed('⚠️ CannonKeys 대량 변경 확인'),
    description: '동일한 변경을 두 번 연속 확인했습니다. 개별 알림 대신 요약합니다.\n변경 항목: **' + changes.length + '개** / 기존 목록: **' + previousRows.length + '개**',
    fields: [{
      name: '변경 예시',
      value: truncate(changes.slice(0, 10).map((change) => {
        const labels = change.kind === 'changed'
          ? change.fields.map((field) => field.label).join(', ')
          : change.kind;
        return '• [' + change.row.category + '] ' + change.row.displayName + ': ' + labels;
      }).join('\n')),
      inline: false
    }]
  });

  sentChanges[bulkId] = new Date().toISOString();
  saveState(rows, sentChanges);
  console.log('Bulk CannonKeys change summarized in one notification and state updated: ' + changes.length + ' change(s).');
  process.exit(0);
}

for (const change of pendingChanges) {
  await notify(change);
  sentChanges[cannonKeysChangeId(change)] = new Date().toISOString();
  saveState(previousRows, sentChanges);
}

saveState(rows, sentChanges);
console.log('Sent ' + pendingChanges.length + ' CannonKeys notification(s), suppressed ' + (changes.length - pendingChanges.length) + ' duplicate(s), and updated state.');
