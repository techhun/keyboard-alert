import fs from 'node:fs';

const STATE_PATH = 'dcinside-backfill-state.json';
const DISCORD_WEBHOOK_URL = (process.env.DCINSIDE_DISCORD_WEBHOOK_URL || '').trim();
const BASE_URL = 'https://gall.dcinside.com/mgallery/board/lists/?id=mechanicalkeyboard&search_head=110';
const MAX_PAGES = 5;
const HTTP_TIMEOUT_MS = 8000;
const SEND_DELAY_MS = 250;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const clean = (value) => String(value ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&#x27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function textFromHtml(value) {
  return clean(decodeHtml(String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')));
}

function attrValue(tag, name) {
  const match = String(tag ?? '').match(new RegExp('\\b' + name + '\\s*=\\s*["\\\']([^"\\\']*)["\\\']', 'i'));
  return match ? decodeHtml(match[1]) : '';
}

function parseDesktopHtml(html) {
  const rows = [];
  const blocks = String(html ?? '').match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) || [];

  for (const block of blocks) {
    const openTag = block.match(/^<tr\b[^>]*>/i)?.[0] || '';
    const noFromAttr = Number(attrValue(openTag, 'data-no'));
    const noFromLink = Number(block.match(/(?:[?&]|&amp;)no=(\d+)/i)?.[1] || 0);
    const no = Number.isFinite(noFromAttr) && noFromAttr > 0 ? noFromAttr : noFromLink;
    if (!no) continue;

    const category = textFromHtml(
      block.match(/<td\b[^>]*class=["'][^"']*(?:gall_subject|subject_head)[^"']*["'][^>]*>([\s\S]*?)<\/td>/i)?.[1] || ''
    );
    if (/공지|설문|AD|광고/i.test(category) || !/떴냐/i.test(category)) continue;

    const anchor = block.match(/<a\b[^>]*href=["']([^"']*(?:(?:[?&]|&amp;)no=\d+|\/mechanicalkeyboard\/\d+)[^"']*)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;

    const title = textFromHtml(anchor[2])
      .replace(/^\[(?:⚡\s*)?떴냐\]\s*/i, '')
      .replace(/^(?:⚡\s*)?떴냐\s*/i, '')
      .trim();
    if (!title || title.length > 300) continue;

    const writerTag = block.match(/<(?:td|span)\b[^>]*class=["'][^"']*(?:gall_writer|writer)[^"']*["'][^>]*>/i)?.[0] || '';
    const writerCell = block.match(/<(?:td|span)\b[^>]*class=["'][^"']*(?:gall_writer|writer)[^"']*["'][^>]*>([\s\S]*?)<\/(?:td|span)>/i)?.[1] || '';
    const author = clean(attrValue(writerTag, 'data-nick') || textFromHtml(writerCell));

    const dateTag = block.match(/<(?:td|span|time)\b[^>]*class=["'][^"']*(?:gall_date|date)[^"']*["'][^>]*>/i)?.[0] || '';
    const dateCell = block.match(/<(?:td|span|time)\b[^>]*class=["'][^"']*(?:gall_date|date)[^"']*["'][^>]*>([\s\S]*?)<\/(?:td|span|time)>/i)?.[1] || '';
    const date = clean(attrValue(dateTag, 'title') || textFromHtml(dateCell));

    rows.push({
      no,
      title,
      author,
      date,
      category,
      url: 'https://m.dcinside.com/board/mechanicalkeyboard/' + no
    });
  }

  return [...new Map(rows.map((row) => [row.no, row])).values()];
}

function loadState() {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return state && typeof state === 'object' ? state : null;
  } catch {
    return null;
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    ...state,
    updatedAt: new Date().toISOString()
  }, null, 2) + '\n');
}

async function fetchPage(page) {
  const url = BASE_URL + '&page=' + page;
  const response = await fetch(url, {
    headers: {
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'user-agent': 'Mozilla/5.0'
    },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error('DCInside backfill page ' + page + ' HTTP ' + response.status);
  const rows = parseDesktopHtml(await response.text());
  if (!rows.length) throw new Error('DCInside backfill page ' + page + ' returned no 떴냐 rows');
  console.log('DCInside backfill page ' + page + ': ' + rows.length + ' rows');
  return rows;
}

async function postDiscord(row) {
  const fields = [];
  if (row.author) fields.push({ name: '작성자', value: row.author, inline: true });
  if (row.date) fields.push({ name: '작성시간', value: row.date, inline: true });
  fields.push({ name: '글 번호', value: String(row.no), inline: true });

  const embed = {
    title: ('⚡ 기키갤 떴냐 · ' + row.title).slice(0, 256),
    url: row.url,
    fields,
    footer: { text: 'DCInside · 기계식키보드 갤러리 · 떴냐 · 누락 복구' },
    timestamp: new Date().toISOString()
  };

  let lastError;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const response = await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: '기키갤 떴냐 알림',
          allowed_mentions: { parse: [] },
          embeds: [embed]
        }),
        signal: AbortSignal.timeout(12_000)
      });

      if (response.ok) return;

      const body = await response.text();
      lastError = new Error('Discord webhook failed: ' + response.status + ' ' + body);
      if (response.status !== 429 && response.status < 500) break;

      let retryAfterMs = attempt * 1000;
      if (response.status === 429) {
        try {
          const parsed = JSON.parse(body);
          retryAfterMs = Math.max(250, Math.ceil(Number(parsed?.retry_after || 1) * 1000));
        } catch {}
      }
      await sleep(retryAfterMs);
    } catch (error) {
      lastError = error;
      if (attempt < 5) await sleep(attempt * 1000);
    }
  }
  throw lastError || new Error('Discord webhook failed');
}

const state = loadState();
if (!state) {
  console.log('No DCInside backfill campaign configured.');
  process.exit(0);
}
if (state.completed) {
  console.log('DCInside backfill campaign already completed.');
  process.exit(0);
}

const targetNos = [...new Set((state.targetNos || []).map(Number).filter(Number.isFinite))];
const sentNos = new Set((state.sentNos || []).map(Number).filter(Number.isFinite));
if (!targetNos.length) throw new Error('DCInside backfill targetNos is empty.');

const targetSet = new Set(targetNos);
const rowsByNo = new Map();

for (let page = 1; page <= MAX_PAGES; page += 1) {
  const rows = await fetchPage(page);
  for (const row of rows) {
    if (targetSet.has(row.no)) rowsByNo.set(row.no, row);
  }
  if (targetNos.every((no) => rowsByNo.has(no))) break;
}

const missing = targetNos.filter((no) => !rowsByNo.has(no));
if (missing.length) {
  throw new Error('DCInside backfill could not resolve ' + missing.length + ' target post(s): ' + missing.join(', '));
}

if (!DISCORD_WEBHOOK_URL) {
  console.log('[discord] DCINSIDE_DISCORD_WEBHOOK_URL is not configured. Backfill remains pending.');
  process.exit(0);
}

const pending = targetNos.filter((no) => !sentNos.has(no)).sort((a, b) => a - b);
console.log('DCInside backfill pending: ' + pending.length + '/' + targetNos.length);

for (const no of pending) {
  const row = rowsByNo.get(no);
  await postDiscord(row);
  sentNos.add(no);
  saveState({
    ...state,
    sentNos: [...sentNos].sort((a, b) => a - b),
    completed: false
  });
  console.log('DCInside backfill sent: ' + no);
  await sleep(SEND_DELAY_MS);
}

saveState({
  ...state,
  sentNos: [...sentNos].sort((a, b) => a - b),
  completed: true,
  completedAt: new Date().toISOString()
});
console.log('DCInside backfill complete: ' + sentNos.size + '/' + targetNos.length);
