import fs from 'node:fs';
import {
  bulkChangeInfo,
  clean,
  pruneSentChanges
} from './geonworks-safety.mjs';
import {
  diffOblotzkyRows,
  oblotzkyChangeId,
  oblotzkyChangeSignature,
  parseOblotzkyScheduleHtml,
  validateOblotzkyRows
} from './oblotzky-safety.mjs';

const PAGE_URL = 'https://oblotzky.industries/pages/schedule';
const STATE_PATH = 'oblotzky-state.json';
const DISCORD_WEBHOOK_URL = (process.env.OBLOTZKY_DISCORD_WEBHOOK_URL || '').trim();

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

async function fetchRows() {
  const response = await fetch(PAGE_URL, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'user-agent': 'keyboard-alert/1.0 (+https://github.com/techhun/keyboard-alert)'
    },
    signal: AbortSignal.timeout(15000)
  });
  if (!response.ok) throw new Error(`Oblotzky schedule HTTP ${response.status}`);

  const rows = parseOblotzkyScheduleHtml(await response.text());
  console.log(`Oblotzky direct rows: ${rows.length}`);
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
        username: 'Oblotzky Alert',
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
    throw new Error(`Discord webhook failed: ${response.status} ${await response.text()}`);
  }
}

function baseEmbed(title) {
  return {
    title: truncate(title, 250),
    url: PAGE_URL,
    footer: { text: 'Oblotzky Industries · Schedule 알림' },
    timestamp: new Date().toISOString()
  };
}

function addedEmbed(row) {
  return {
    ...baseEmbed(`🆕 Oblotzky 프로젝트 추가 · ${row.project}`),
    fields: [
      { name: '마지막 갱신', value: truncate(row.lastUpdated), inline: true },
      { name: '상태', value: truncate(row.status), inline: false }
    ]
  };
}

function changedEmbed(change) {
  return {
    ...baseEmbed(`🔄 Oblotzky 업데이트 · ${change.row.project}`),
    description: `변경된 항목 **${change.fields.length}개**`,
    fields: change.fields.slice(0, 25).map((field) => ({
      name: field.label,
      value: truncate(`이전: ${field.before}\n현재: ${field.after}`),
      inline: false
    }))
  };
}

function removedEmbed(row) {
  return {
    ...baseEmbed(`➖ Oblotzky 목록에서 제거 · ${row.project}`),
    description: 'Oblotzky Schedule의 현재 목록에서 사라졌습니다.',
    fields: [
      { name: '마지막 갱신', value: truncate(row.lastUpdated), inline: true },
      { name: '마지막 상태', value: truncate(row.status), inline: false }
    ]
  };
}

async function notify(change) {
  if (change.kind === 'added') return postDiscord(addedEmbed(change.row));
  if (change.kind === 'changed') return postDiscord(changedEmbed(change));
  return postDiscord(removedEmbed(change.row));
}

let rows = await fetchRows();
console.log(`Oblotzky rows: ${rows.length}`);
console.log('Oblotzky sample:', JSON.stringify(rows[0], null, 2));

const state = loadState();
const previousRows = Array.isArray(state?.rows) ? state.rows : [];
let sentChanges = pruneSentChanges(state?.sentChanges || {});

if (!state?.initialized || previousRows.length === 0) {
  console.log(`Baseline initialization: storing ${rows.length} Oblotzky rows without notifying.`);
  saveState(rows, sentChanges);
  process.exit(0);
}

const validateRows = (candidateRows) => {
  validateOblotzkyRows(candidateRows);
  if (candidateRows.length < Math.max(10, Math.floor(previousRows.length * 0.5))) {
    throw new Error(`Oblotzky row count dropped unexpectedly: ${previousRows.length} -> ${candidateRows.length}. State was not updated.`);
  }
};

validateRows(rows);
let changes = diffOblotzkyRows(previousRows, rows);
let bulkInfo = bulkChangeInfo(changes, previousRows.length);
const needsVerification = changes.some((change) => change.kind === 'removed') || bulkInfo.bulk;

if (needsVerification) {
  console.warn(`Oblotzky ${bulkInfo.bulk ? `bulk change detected (${bulkInfo.count}, ${Math.round(bulkInfo.ratio * 100)}%)` : 'removal detected'}; re-reading once before notifying.`);
  const firstSignature = oblotzkyChangeSignature(changes);
  const verificationRows = await fetchRows();
  validateRows(verificationRows);
  const verificationChanges = diffOblotzkyRows(previousRows, verificationRows);
  const secondSignature = oblotzkyChangeSignature(verificationChanges);

  if (firstSignature !== secondSignature) {
    throw new Error('Oblotzky change set changed during verification. State was not updated.');
  }

  rows = verificationRows;
  changes = verificationChanges;
  bulkInfo = bulkChangeInfo(changes, previousRows.length);
  console.log(`Oblotzky change set confirmed by two consecutive reads: ${changes.length} change(s).`);
}

console.log(`Oblotzky changes: ${changes.length}`);
for (const change of changes) {
  if (change.kind === 'changed') {
    console.log('Changed:', change.row.project, change.fields.map((field) => field.label).join(', '));
  } else {
    console.log(`${change.kind}:`, change.row.project);
  }
}

if (changes.length === 0) {
  if (JSON.stringify(sentChanges) !== JSON.stringify(state?.sentChanges || {})) saveState(previousRows, sentChanges);
  console.log('No Oblotzky state update needed.');
  process.exit(0);
}

const pendingChanges = changes.filter((change) => !sentChanges[oblotzkyChangeId(change)]);
if (pendingChanges.length !== changes.length) {
  console.log(`Oblotzky duplicate suppression: ${changes.length - pendingChanges.length} already-sent change(s) skipped.`);
}

if (!DISCORD_WEBHOOK_URL) {
  console.log('[discord] OBLOTZKY_DISCORD_WEBHOOK_URL is not configured. Changes remain pending; state was not updated.');
  process.exit(0);
}

if (bulkInfo.bulk) {
  const bulkId = oblotzkyChangeId({
    kind: 'changed',
    row: { project: 'Oblotzky bulk' },
    fields: [{ field: 'signature', before: '', after: oblotzkyChangeSignature(changes) }]
  });
  if (sentChanges[bulkId]) {
    saveState(rows, sentChanges);
    console.log('Duplicate Oblotzky bulk summary suppressed; state advanced.');
    process.exit(0);
  }

  await postDiscord({
    ...baseEmbed('⚠️ Oblotzky 대량 변경 확인'),
    description: `동일한 변경을 두 번 연속 확인했습니다. 개별 알림 대신 요약합니다.\n변경 항목: **${changes.length}개** / 기존 목록: **${previousRows.length}개**`,
    fields: [{
      name: '변경 예시',
      value: truncate(changes.slice(0, 10).map((change) => {
        const labels = change.kind === 'changed'
          ? change.fields.map((field) => field.label).join(', ')
          : change.kind;
        return `• ${change.row.project}: ${labels}`;
      }).join('\n')),
      inline: false
    }]
  });
  sentChanges[bulkId] = new Date().toISOString();
  saveState(rows, sentChanges);
  console.log(`Bulk Oblotzky change summarized in one notification and state updated: ${changes.length} change(s).`);
  process.exit(0);
}

for (const change of pendingChanges) {
  await notify(change);
  sentChanges[oblotzkyChangeId(change)] = new Date().toISOString();
  saveState(previousRows, sentChanges);
}

saveState(rows, sentChanges);
console.log(`Sent ${pendingChanges.length} Oblotzky notification(s), suppressed ${changes.length - pendingChanges.length} duplicate(s), and updated state.`);
