import fs from 'node:fs';
import { bulkChangeInfo, clean, pruneSentChanges } from './geonworks-safety.mjs';
import {
  OMNITYPE_PAGE_URL,
  diffOmnitypeRows,
  omnitypeChangeId,
  omnitypeChangeSignature,
  parseOmnitypeUpdatesHtml,
  validateOmnitypeRows
} from './omnitype-safety.mjs';

const STATE_PATH = 'omnitype-state.json';
const DISCORD_WEBHOOK_URL = (process.env.OMNITYPE_DISCORD_WEBHOOK_URL || '').trim();

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

function componentsText(row) {
  const items = Array.isArray(row?.components) ? row.components.filter(Boolean) : [];
  return items.length ? items.map((item) => '• ' + item).join('\n') : '—';
}

async function fetchHtml() {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(OMNITYPE_PAGE_URL, {
        headers: {
          accept: 'text/html,application/xhtml+xml',
          'user-agent': 'keyboard-alert/1.0 (+https://github.com/techhun/keyboard-alert)'
        },
        signal: AbortSignal.timeout(15000)
      });

      if (response.ok) return response.text();

      if ((response.status === 429 || response.status >= 500) && attempt < 3) {
        const retryAfter = Number(response.headers.get('retry-after'));
        const delay = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.ceil(retryAfter * 1000)
          : 1000 * attempt;
        console.warn('Omnitype HTTP ' + response.status + '; retrying in ' + delay + 'ms');
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw new Error('Omnitype Product Updates HTTP ' + response.status);
    } catch (error) {
      lastError = error;
      if (attempt >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError || new Error('Omnitype Product Updates request failed');
}

async function fetchRows() {
  const rows = parseOmnitypeUpdatesHtml(await fetchHtml());
  console.log('Omnitype rows: ' + rows.length);
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

function validateRuntimeRows(rows, previousRows) {
  validateOmnitypeRows(rows);
  if (rows.length < Math.max(3, Math.floor(previousRows.length * 0.6))) {
    throw new Error('Omnitype row count dropped unexpectedly: ' + previousRows.length + ' -> ' + rows.length + '. State was not updated.');
  }
}

async function postDiscord(embed) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Omnitype Alert',
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
    url: OMNITYPE_PAGE_URL,
    footer: { text: 'Omnitype · Product Updates 알림' },
    timestamp: new Date().toISOString()
  };
}

function addedEmbed(row) {
  return {
    ...baseEmbed('🆕 Omnitype 프로젝트 추가 · ' + row.product),
    fields: [
      { name: '예상 일정 / 요약', value: truncate(row.overview), inline: false },
      { name: '부품별 진행', value: truncate(componentsText(row)), inline: false }
    ]
  };
}

function changedEmbed(change) {
  return {
    ...baseEmbed('🔄 Omnitype 업데이트 · ' + change.row.product),
    description: '변경된 항목 **' + change.fields.length + '개**',
    fields: change.fields.slice(0, 25).map((field) => ({
      name: field.label,
      value: truncate('이전:\n' + field.before + '\n\n현재:\n' + field.after),
      inline: false
    }))
  };
}

function removedEmbed(row) {
  return {
    ...baseEmbed('➖ Omnitype 목록에서 제거 · ' + row.product),
    description: 'Omnitype Product Updates의 현재 목록에서 사라졌습니다.',
    fields: [
      { name: '마지막 예상 일정 / 요약', value: truncate(row.overview), inline: false },
      { name: '마지막 부품별 진행', value: truncate(componentsText(row)), inline: false }
    ]
  };
}

async function notify(change) {
  if (change.kind === 'added') return postDiscord(addedEmbed(change.row));
  if (change.kind === 'changed') return postDiscord(changedEmbed(change));
  return postDiscord(removedEmbed(change.row));
}

let rows = await fetchRows();
console.log('Omnitype products:', rows.map((row) => row.product).join(' | '));
console.log('Omnitype sample:', JSON.stringify(rows[0], null, 2));

const state = loadState();
const previousRows = Array.isArray(state?.rows) ? state.rows : [];
let sentChanges = pruneSentChanges(state?.sentChanges || {});

if (!state?.initialized || previousRows.length === 0) {
  console.log('Baseline initialization: storing ' + rows.length + ' Omnitype rows without notifying.');
  saveState(rows, sentChanges);
  process.exit(0);
}

validateRuntimeRows(rows, previousRows);
let changes = diffOmnitypeRows(previousRows, rows);
let bulkInfo = bulkChangeInfo(changes, previousRows.length);
const needsVerification = changes.some((change) => change.kind === 'removed') || bulkInfo.bulk;

if (needsVerification) {
  console.warn('Omnitype ' + (bulkInfo.bulk ? 'bulk change detected (' + bulkInfo.count + ', ' + Math.round(bulkInfo.ratio * 100) + '%)' : 'removal detected') + '; re-reading once before notifying.');
  const firstSignature = omnitypeChangeSignature(changes);
  const verificationRows = await fetchRows();
  validateRuntimeRows(verificationRows, previousRows);
  const verificationChanges = diffOmnitypeRows(previousRows, verificationRows);
  const secondSignature = omnitypeChangeSignature(verificationChanges);

  if (firstSignature !== secondSignature) {
    throw new Error('Omnitype change set changed during verification. State was not updated.');
  }

  rows = verificationRows;
  changes = verificationChanges;
  bulkInfo = bulkChangeInfo(changes, previousRows.length);
  console.log('Omnitype change set confirmed by two consecutive reads: ' + changes.length + ' change(s).');
}

console.log('Omnitype changes: ' + changes.length);
for (const change of changes) {
  if (change.kind === 'changed') {
    console.log('Changed:', change.row.product, change.fields.map((field) => field.label).join(', '));
  } else {
    console.log(change.kind + ':', change.row.product);
  }
}

if (changes.length === 0) {
  if (JSON.stringify(sentChanges) !== JSON.stringify(state?.sentChanges || {})) saveState(previousRows, sentChanges);
  console.log('No Omnitype state update needed.');
  process.exit(0);
}

const pendingChanges = changes.filter((change) => !sentChanges[omnitypeChangeId(change)]);
if (pendingChanges.length !== changes.length) {
  console.log('Omnitype duplicate suppression: ' + (changes.length - pendingChanges.length) + ' already-sent change(s) skipped.');
}

if (!DISCORD_WEBHOOK_URL) {
  console.log('[discord] OMNITYPE_DISCORD_WEBHOOK_URL is not configured. Changes remain pending; state was not updated.');
  process.exit(0);
}

if (bulkInfo.bulk) {
  const bulkId = omnitypeChangeId({
    kind: 'changed',
    row: { product: 'Omnitype bulk', sourceUrl: OMNITYPE_PAGE_URL },
    fields: [{ field: 'signature', before: '', after: omnitypeChangeSignature(changes) }]
  });

  if (sentChanges[bulkId]) {
    saveState(rows, sentChanges);
    console.log('Duplicate Omnitype bulk summary suppressed; state advanced.');
    process.exit(0);
  }

  await postDiscord({
    ...baseEmbed('⚠️ Omnitype 대량 변경 확인'),
    description: '동일한 변경을 두 번 연속 확인했습니다. 개별 알림 대신 요약합니다.\n변경 항목: **' + changes.length + '개** / 기존 목록: **' + previousRows.length + '개**',
    fields: [{
      name: '변경 예시',
      value: truncate(changes.slice(0, 10).map((change) => {
        const labels = change.kind === 'changed'
          ? change.fields.map((field) => field.label).join(', ')
          : change.kind;
        return '• ' + change.row.product + ': ' + labels;
      }).join('\n')),
      inline: false
    }]
  });

  sentChanges[bulkId] = new Date().toISOString();
  saveState(rows, sentChanges);
  console.log('Bulk Omnitype change summarized in one notification and state updated: ' + changes.length + ' change(s).');
  process.exit(0);
}

for (const change of pendingChanges) {
  await notify(change);
  sentChanges[omnitypeChangeId(change)] = new Date().toISOString();
  saveState(previousRows, sentChanges);
}

saveState(rows, sentChanges);
console.log('Sent ' + pendingChanges.length + ' Omnitype notification(s), suppressed ' + (changes.length - pendingChanges.length) + ' duplicate(s), and updated state.');
