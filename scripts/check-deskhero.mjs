import fs from 'node:fs';
import { bulkChangeInfo, clean, pruneSentChanges } from './geonworks-safety.mjs';
import {
  DESKHERO_PAGES,
  deskheroChangeId,
  deskheroChangeSignature,
  diffDeskheroRows,
  parseDeskheroPageHtml,
  validateDeskheroRows
} from './deskhero-safety.mjs';

const STATE_PATH = 'deskhero-state.json';
const DISCORD_WEBHOOK_URL = (process.env.DESKHERO_DISCORD_WEBHOOK_URL || '').trim();

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

async function fetchText(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
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
        console.warn('Deskhero HTTP ' + response.status + '; retrying in ' + delay + 'ms: ' + url);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }

      throw new Error('Deskhero HTTP ' + response.status + ': ' + url);
    } catch (error) {
      lastError = error;
      if (attempt >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }
  throw lastError || new Error('Deskhero request failed: ' + url);
}

async function fetchRows() {
  const rows = [];
  for (const page of DESKHERO_PAGES) {
    const parsed = parseDeskheroPageHtml(await fetchText(page.url), page);
    console.log('Deskhero ' + page.category + ' rows: ' + parsed.length);
    rows.push(...parsed);
  }
  return validateDeskheroRows(rows);
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

function categoryCounts(rows) {
  return Object.fromEntries(DESKHERO_PAGES.map(({ category }) => [
    category,
    rows.filter((row) => row.category === category).length
  ]));
}

function validateRuntimeRows(rows, previousRows) {
  validateDeskheroRows(rows);
  if (rows.length < Math.max(100, Math.floor(previousRows.length * 0.6))) {
    throw new Error('Deskhero row count dropped unexpectedly: ' + previousRows.length + ' -> ' + rows.length + '. State was not updated.');
  }

  const before = categoryCounts(previousRows);
  const current = categoryCounts(rows);
  for (const { category } of DESKHERO_PAGES) {
    if ((current[category] || 0) < Math.floor((before[category] || 0) * 0.6)) {
      throw new Error('Deskhero ' + category + ' row count dropped unexpectedly: ' + (before[category] || 0) + ' -> ' + (current[category] || 0) + '. State was not updated.');
    }
  }
}

async function postDiscord(embed) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Deskhero Alert',
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

function baseEmbed(title, row) {
  return {
    title: truncate(title, 250),
    url: row?.sourceUrl || DESKHERO_PAGES[0].url,
    footer: { text: 'Deskhero · Group Buy/Preorder Updates 알림' },
    timestamp: new Date().toISOString()
  };
}

function addedEmbed(row) {
  return {
    ...baseEmbed('🆕 Deskhero 프로젝트 추가 · ' + row.product, row),
    fields: [
      { name: '분류', value: truncate(row.category), inline: true },
      { name: '상태 / 상세 메모', value: truncate(row.notes), inline: false }
    ]
  };
}

function changedEmbed(change) {
  return {
    ...baseEmbed('🔄 Deskhero 업데이트 · ' + change.row.product, change.row),
    description: change.row.category + ' · 변경된 항목 **' + change.fields.length + '개**',
    fields: change.fields.slice(0, 25).map((field) => ({
      name: field.label,
      value: truncate('이전: ' + field.before + '\n현재: ' + field.after),
      inline: false
    }))
  };
}

function removedEmbed(row) {
  return {
    ...baseEmbed('➖ Deskhero 목록에서 제거 · ' + row.product, row),
    description: 'Deskhero Group Buy/Preorder Updates의 현재 목록에서 사라졌습니다.',
    fields: [
      { name: '분류', value: truncate(row.category), inline: true },
      { name: '마지막 상태 / 상세 메모', value: truncate(row.notes), inline: false }
    ]
  };
}

async function notify(change) {
  if (change.kind === 'added') return postDiscord(addedEmbed(change.row));
  if (change.kind === 'changed') return postDiscord(changedEmbed(change));
  return postDiscord(removedEmbed(change.row));
}

let rows = await fetchRows();
console.log('Deskhero rows: ' + rows.length);
console.log('Deskhero category counts:', JSON.stringify(categoryCounts(rows)));
console.log('Deskhero sample:', JSON.stringify(rows.find((row) => /Motif/i.test(row.product)) || rows[0], null, 2));

const state = loadState();
const previousRows = Array.isArray(state?.rows) ? state.rows : [];
let sentChanges = pruneSentChanges(state?.sentChanges || {});

if (!state?.initialized || previousRows.length === 0) {
  console.log('Baseline initialization: storing ' + rows.length + ' Deskhero rows without notifying.');
  saveState(rows, sentChanges);
  process.exit(0);
}

validateRuntimeRows(rows, previousRows);
let changes = diffDeskheroRows(previousRows, rows);
let bulkInfo = bulkChangeInfo(changes, previousRows.length);
const needsVerification = changes.some((change) => change.kind === 'removed') || bulkInfo.bulk;

if (needsVerification) {
  console.warn('Deskhero ' + (bulkInfo.bulk ? 'bulk change detected (' + bulkInfo.count + ', ' + Math.round(bulkInfo.ratio * 100) + '%)' : 'removal detected') + '; re-reading once before notifying.');
  const firstSignature = deskheroChangeSignature(changes);
  const verificationRows = await fetchRows();
  validateRuntimeRows(verificationRows, previousRows);
  const verificationChanges = diffDeskheroRows(previousRows, verificationRows);
  const secondSignature = deskheroChangeSignature(verificationChanges);

  if (firstSignature !== secondSignature) {
    throw new Error('Deskhero change set changed during verification. State was not updated.');
  }

  rows = verificationRows;
  changes = verificationChanges;
  bulkInfo = bulkChangeInfo(changes, previousRows.length);
  console.log('Deskhero change set confirmed by two consecutive reads: ' + changes.length + ' change(s).');
}

console.log('Deskhero changes: ' + changes.length);
for (const change of changes) {
  if (change.kind === 'changed') {
    console.log('Changed:', change.row.category, change.row.product, change.fields.map((field) => field.label).join(', '));
  } else {
    console.log(change.kind + ':', change.row.category, change.row.product);
  }
}

if (changes.length === 0) {
  if (JSON.stringify(sentChanges) !== JSON.stringify(state?.sentChanges || {})) saveState(previousRows, sentChanges);
  console.log('No Deskhero state update needed.');
  process.exit(0);
}

const pendingChanges = changes.filter((change) => !sentChanges[deskheroChangeId(change)]);
if (pendingChanges.length !== changes.length) {
  console.log('Deskhero duplicate suppression: ' + (changes.length - pendingChanges.length) + ' already-sent change(s) skipped.');
}

if (!DISCORD_WEBHOOK_URL) {
  console.log('[discord] DESKHERO_DISCORD_WEBHOOK_URL is not configured. Changes remain pending; state was not updated.');
  process.exit(0);
}

if (bulkInfo.bulk) {
  const bulkId = deskheroChangeId({
    kind: 'changed',
    row: { category: 'Bulk', product: 'Deskhero bulk', sourceUrl: DESKHERO_PAGES[0].url },
    fields: [{ field: 'signature', before: '', after: deskheroChangeSignature(changes) }]
  });

  if (sentChanges[bulkId]) {
    saveState(rows, sentChanges);
    console.log('Duplicate Deskhero bulk summary suppressed; state advanced.');
    process.exit(0);
  }

  await postDiscord({
    ...baseEmbed('⚠️ Deskhero 대량 변경 확인', { sourceUrl: DESKHERO_PAGES[0].url }),
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
  console.log('Bulk Deskhero change summarized in one notification and state updated: ' + changes.length + ' change(s).');
  process.exit(0);
}

for (const change of pendingChanges) {
  await notify(change);
  sentChanges[deskheroChangeId(change)] = new Date().toISOString();
  saveState(previousRows, sentChanges);
}

saveState(rows, sentChanges);
console.log('Sent ' + pendingChanges.length + ' Deskhero notification(s), suppressed ' + (changes.length - pendingChanges.length) + ' duplicate(s), and updated state.');
