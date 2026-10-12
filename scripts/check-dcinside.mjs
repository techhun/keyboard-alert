import fs from 'node:fs';
import { chromium } from 'playwright';

const STATE_PATH = 'dcinside-tteotnya-state.json';
const DISCORD_WEBHOOK_URL = (process.env.DCINSIDE_DISCORD_WEBHOOK_URL || '').trim();
const TARGET_NAME = '떴냐';
const MOBILE_URL = 'https://m.dcinside.com/board/mechanicalkeyboard?headid=110';
const DESKTOP_URL = 'https://gall.dcinside.com/mgallery/board/lists/?id=mechanicalkeyboard&search_head=110&page=1';
const SOURCES = [
  { id: 'desktop', url: DESKTOP_URL, expectedQuery: 'search_head=110' },
  { id: 'mobile', url: MOBILE_URL, expectedQuery: 'headid=110' }
];
const HTTP_TIMEOUT_MS = 6000;
const BROWSER_NAV_TIMEOUT_MS = 8000;
const BROWSER_ATTEMPTS_PER_SOURCE = 1;

const clean = (value) => String(value ?? '')
  .replace(/\r/g, '')
  .replace(/\s+/g, ' ')
  .trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
  const match = String(tag ?? '').match(new RegExp("\\b" + name + "\\s*=\\s*[\\\"']([^\\\"']*)[\\\"']", "i"));
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
    if (/공지|설문|AD|광고/i.test(category)) continue;
    if (!/떴냐/i.test(category)) continue;

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

  return [...new Map(rows.map((row) => [row.no, row])).values()].sort((a, b) => b.no - a.no);
}

async function fetchRowsHttp() {
  const response = await fetch(DESKTOP_URL, {
    headers: {
      'accept': 'text/html,application/xhtml+xml',
      'accept-language': 'ko-KR,ko;q=0.9,en;q=0.8',
      'user-agent': 'Mozilla/5.0'
    },
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error('DCInside direct HTTP ' + response.status);

  const html = await response.text();
  if (!/떴냐/.test(html)) throw new Error('DCInside direct HTTP page did not contain the 떴냐 category');

  const rows = parseDesktopHtml(html);
  if (rows.length < 1) throw new Error('DCInside direct HTTP returned no 떴냐 post rows');
  if (rows.some((row) => !/떴냐/i.test(row.category))) {
    throw new Error('DCInside direct HTTP returned rows outside the 떴냐 category');
  }

  console.log('DCInside 떴냐 source: direct-http');
  console.log('DCInside 떴냐 direct HTTP rows: ' + rows.length);
  console.log('DCInside 떴냐 direct HTTP sample:', JSON.stringify(rows.slice(0, 3), null, 2));
  return { rows, sourceId: 'direct-http' };
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function saveState(rows, sourceId) {
  const maxNo = Math.max(...rows.map((row) => row.no));
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    version: 1,
    initialized: true,
    updatedAt: new Date().toISOString(),
    source: sourceId,
    lastSeenNo: maxNo,
    recentNos: rows.slice(0, 100).map((row) => row.no)
  }, null, 2) + '\n');
}

async function extractRows(page, source) {
  await page.waitForTimeout(1200);

  const currentUrl = page.url();
  if (!currentUrl.includes(source.expectedQuery)) {
    throw new Error(`DCInside ${source.id} filter was lost: ${currentUrl}`);
  }

  const result = await page.evaluate(() => {
    const tidy = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

    const postNoFromHref = (href) => {
      try {
        const url = new URL(href, location.href);
        const mobile = url.pathname.match(/\/board\/mechanicalkeyboard\/(\d+)(?:\/)?$/);
        if (mobile) return Number(mobile[1]);
        if (url.searchParams.get('id') === 'mechanicalkeyboard') {
          const no = Number(url.searchParams.get('no'));
          if (Number.isFinite(no) && no > 0) return no;
        }
      } catch {}
      return 0;
    };

    const rows = new Map();
    const anchors = [...document.querySelectorAll('a[href]')];

    for (const anchor of anchors) {
      const no = postNoFromHref(anchor.href);
      if (!no) continue;

      const container = anchor.closest('li, tr, article, .ub-content') || anchor.parentElement;
      const category = tidy(container?.querySelector('.gall_subject, .subject_head, [class*="subject_head"], [class*="category"]')?.textContent);
      if (/공지|설문|AD|광고/i.test(category)) continue;
      if (category && !/떴냐/i.test(category)) continue;

      const explicitTitle = tidy(
        anchor.querySelector('.subjectin, .title, .tit')?.textContent
        || container?.querySelector('.gall_tit a[href], .subjectin, .title, .tit')?.textContent
      );
      let title = explicitTitle || tidy(anchor.textContent) || tidy(anchor.getAttribute('title'));
      title = title
        .replace(/^\[(?:⚡\s*)?떴냐\]\s*/i, '')
        .replace(/^(?:⚡\s*)?떴냐\s*/i, '')
        .trim();

      if (!title || title.length > 300) continue;

      const author = tidy(
        container?.querySelector('.gall_writer, .writer, .nickname, [data-nick], [class*="writer"]')?.getAttribute('data-nick')
        || container?.querySelector('.gall_writer, .writer, .nickname, [class*="writer"]')?.textContent
      );
      const date = tidy(
        container?.querySelector('.gall_date, .date, time, [class*="date"]')?.getAttribute('title')
        || container?.querySelector('.gall_date, .date, time, [class*="date"]')?.textContent
      );

      const candidate = {
        no,
        title,
        author,
        date,
        category,
        url: `https://m.dcinside.com/board/mechanicalkeyboard/${no}`
      };
      const existing = rows.get(no);
      if (!existing || candidate.title.length > existing.title.length) rows.set(no, candidate);
    }

    return {
      title: document.title,
      bodyHasTarget: /떴냐/.test(document.body?.innerText || ''),
      rows: [...rows.values()].sort((a, b) => b.no - a.no)
    };
  });

  if (!result.bodyHasTarget) throw new Error(`DCInside ${source.id} page did not contain the ${TARGET_NAME} tab label`);
  if (result.rows.length < 1) throw new Error(`DCInside ${source.id} returned no post rows`);

  if (source.id === 'desktop') {
    const invalidRows = result.rows.filter((row) => !/떴냐/i.test(clean(row.category)));
    if (invalidRows.length > 0) {
      throw new Error(`DCInside desktop returned ${invalidRows.length} row(s) without the ${TARGET_NAME} category; state was not updated.`);
    }
  }

  console.log(`DCInside ${TARGET_NAME} source: ${source.id}`);
  console.log(`DCInside ${TARGET_NAME} rows: ${result.rows.length}`);
  console.log(`DCInside ${TARGET_NAME} sample:`, JSON.stringify(result.rows.slice(0, 3), null, 2));
  return { rows: result.rows, sourceId: source.id };
}

async function fetchRowsBrowser() {
  const browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1600 },
    locale: 'ko-KR'
  });

  let lastError;
  try {
    for (const source of SOURCES) {
      for (let attempt = 1; attempt <= BROWSER_ATTEMPTS_PER_SOURCE; attempt += 1) {
        const page = await context.newPage();
        try {
          const response = await page.goto(source.url, { waitUntil: 'domcontentloaded', timeout: BROWSER_NAV_TIMEOUT_MS });
          if (response && response.status() >= 400) throw new Error(`HTTP ${response.status()}`);
          return await extractRows(page, source);
        } catch (error) {
          lastError = error;
          console.warn(`DCInside ${source.id} attempt ${attempt} failed: ${error?.message || error}`);
          if (attempt < BROWSER_ATTEMPTS_PER_SOURCE) await sleep(1500);
        } finally {
          await page.close();
        }
      }
    }
  } finally {
    await context.close();
    await browser.close();
  }

  throw lastError || new Error('DCInside list could not be loaded');
}

async function fetchRows() {
  try {
    return await fetchRowsHttp();
  } catch (error) {
    console.warn('DCInside direct HTTP failed; using browser fallback: ' + (error?.message || error));
    return fetchRowsBrowser();
  }
}

async function postDiscord(row) {
  const fields = [];
  if (row.author) fields.push({ name: '작성자', value: row.author, inline: true });
  if (row.date) fields.push({ name: '작성시간', value: row.date, inline: true });
  fields.push({ name: '글 번호', value: String(row.no), inline: true });

  const embed = {
    title: `⚡ 기키갤 떴냐 · ${row.title}`.slice(0, 256),
    url: row.url,
    fields,
    footer: { text: 'DCInside · 기계식키보드 갤러리 · 떴냐' },
    timestamp: new Date().toISOString()
  };

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: '기키갤 떴냐 알림',
        allowed_mentions: { parse: [] },
        embeds: [embed]
      })
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

const { rows, sourceId } = await fetchRows();
const state = loadState();
const maxNo = Math.max(...rows.map((row) => row.no));

if (!state?.initialized || !Number.isFinite(Number(state.lastSeenNo))) {
  console.log(`DCInside ${TARGET_NAME} baseline initialization at post ${maxNo}; no notification sent.`);
  saveState(rows, sourceId);
  process.exit(0);
}

const lastSeenNo = Number(state.lastSeenNo);
const newRows = rows
  .filter((row) => row.no > lastSeenNo)
  .sort((a, b) => a.no - b.no);

console.log(`DCInside ${TARGET_NAME} last seen: ${lastSeenNo}; current max: ${maxNo}; new posts: ${newRows.length}`);

if (newRows.length === 0) {
  console.log(`No new DCInside ${TARGET_NAME} posts.`);
  process.exit(0);
}

if (newRows.length > 15) {
  throw new Error(`DCInside ${TARGET_NAME} returned suspiciously many new posts (${newRows.length}); state was not updated.`);
}

if (!DISCORD_WEBHOOK_URL) {
  console.log('[discord] DCINSIDE_DISCORD_WEBHOOK_URL is not configured. New DCInside posts remain pending; state was not updated.');
  process.exit(0);
}

for (const row of newRows) await postDiscord(row);
saveState(rows, sourceId);
console.log(`Sent ${newRows.length} DCInside ${TARGET_NAME} notification(s) and updated state.`);
