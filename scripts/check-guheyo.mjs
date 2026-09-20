import { chromium } from 'playwright';
import fs from 'node:fs';
import crypto from 'node:crypto';

const MARKET_URL = process.env.GUHEYO_URL || 'https://guheyo.com/g/keyboard/sell?category=keycap';
const NTFY_TOPIC = (process.env.GUHEYO_NTFY_TOPIC || process.env.NTFY_TOPIC || '').trim();
const DISCORD_WEBHOOK_URL = (process.env.GUHEYO_DISCORD_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || '').trim();
const STATE_PATH = 'guheyo-state.json';
const MAX_SEEN = 300;
const MAX_NEW_LISTINGS = 30;
const NTFY_CHUNK_BYTES = 2800;
const DISCORD_DETAIL_CHARS = 3600;

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 20);
}

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { seen: [], initialized: false };
  }
}

function parseListing(text) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const price = normalized.match(/([\d,]+\s*원)\s*$/)?.[1] || '';
  let title = normalized
    .replace(/^(?:방금\s*전|하루\s*전|한\s*시간\s*전|몇\s*(?:초|분|시간|일)\s*전|\d+\s*(?:초|분|시간|일)\s*전)\s+/, '')
    .replace(/\s+키캡\s+[\d,]+\s*원\s*$/, '')
    .trim();
  if (!title) title = '새 키캡 매물';
  return { title, price, normalized };
}

function splitUtf8(text, maxBytes = NTFY_CHUNK_BYTES) {
  const chunks = [];
  let current = '';

  for (const char of String(text || '')) {
    const next = current + char;
    if (Buffer.byteLength(next, 'utf8') > maxBytes) {
      if (current) chunks.push(current);
      current = char;
    } else {
      current = next;
    }
  }

  if (current) chunks.push(current);
  return chunks.length ? chunks : [''];
}

function splitText(text, maxChars) {
  const value = String(text || '');
  if (!value) return [''];

  const chunks = [];
  let remaining = value;

  while (remaining.length > maxChars) {
    let cut = remaining.lastIndexOf('\n', maxChars);
    if (cut < Math.floor(maxChars * 0.6)) cut = remaining.lastIndexOf(' ', maxChars);
    if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;

    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks.length ? chunks : [''];
}

function normalizeDetail(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function sanitizeDetail(text, item) {
  const normalized = normalizeDetail(text);
  if (!normalized) return '';

  const lines = normalized.split('\n');
  const boundary = lines.findIndex((line) =>
    line === '공유'
    || line === '종료 임박 경매'
    || line === '판매자의 다른 상품'
    || line === '추천 상품'
  );
  const trimmed = normalizeDetail((boundary >= 0 ? lines.slice(0, boundary) : lines).join('\n'));
  if (!trimmed) return '';

  const compact = trimmed.replace(/\s+/g, ' ').trim();
  const title = String(item?.title || '').replace(/\s+/g, ' ').trim();
  const price = String(item?.price || '').replace(/\s+/g, ' ').trim();
  if (compact === title || compact === price || compact === `${title} ${price}`.trim()) return '';

  return trimmed;
}

function cleanMetaDescription(text) {
  return normalizeDetail(text).replace(/^[\d,]+\s*원\s*-\s*[^-]+?\s*-\s*/, '').trim();
}

function truncate(text, maxLength) {
  const value = String(text || '');
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function formatPriceManwon(price) {
  const amount = Number(String(price || '').replace(/[^\d]/g, ''));
  if (!Number.isFinite(amount) || amount <= 0) return '';
  return new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 2 }).format(amount / 10_000);
}

let browser;

async function fetchListingDetail(item) {
  const detailPage = await browser.newPage({
    viewport: { width: 1280, height: 1800 },
    locale: 'ko-KR',
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36'
  });

  const graphqlContents = [];
  detailPage.on('response', async (response) => {
    try {
      if (!response.url().includes('api.guheyo.com/graphql')) return;
      const contentType = response.headers()['content-type'] || '';
      if (!contentType.includes('application/json')) return;

      const json = await response.json();
      const content = json?.data?.findOffer?.content;
      if (typeof content === 'string' && content.trim()) graphqlContents.push(content);
    } catch {}
  });

  try {
    await detailPage.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await detailPage.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    await detailPage.waitForTimeout(700);

    const graphqlDetail = graphqlContents
      .map((text) => sanitizeDetail(text, item))
      .filter(Boolean)
      .sort((a, b) => b.length - a.length)[0] || '';

    if (graphqlDetail) {
      console.log(`Detail source for ${item.title}: graphql, ${Buffer.byteLength(graphqlDetail, 'utf8')} bytes`);
      return graphqlDetail;
    }

    const detailCandidates = await detailPage.evaluate(({ title, price }) => {
      const jsonLd = [];
      for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const parsed = JSON.parse(script.textContent || 'null');
          const nodes = Array.isArray(parsed) ? parsed : [parsed];
          for (const node of nodes) {
            if (node && node['@type'] === 'Product' && typeof node.description === 'string') {
              jsonLd.push(node.description);
            }
          }
        } catch {}
      }

      const meta = document.querySelector('meta[property="og:description"], meta[name="description"]')
        ?.getAttribute('content') || '';

      const lines = (document.body?.innerText || '')
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);

      let body = '';
      const titleIndex = lines.findIndex((x) => x === title);
      if (titleIndex >= 0) {
        let start = titleIndex + 1;
        if (price && lines[start] === price) start += 1;
        if (start < lines.length && /택배|배송|직거래|착불/.test(lines[start])) start += 1;

        const boundary = lines.findIndex((x, i) =>
          i >= start && (
            x === '공유'
            || x === '종료 임박 경매'
            || x === '판매자의 다른 상품'
            || x === '추천 상품'
          )
        );
        const end = boundary >= start ? boundary : lines.length;
        body = lines.slice(start, end).join('\n');
      }

      return { jsonLd, meta, body };
    }, { title: item.title, price: item.price });

    const candidates = [
      ...detailCandidates.jsonLd.map((text) => ['json-ld', text]),
      ['meta', cleanMetaDescription(detailCandidates.meta)],
      ['body-slice', detailCandidates.body]
    ];

    for (const [source, candidate] of candidates) {
      const text = sanitizeDetail(candidate, item);
      if (!text) continue;
      console.log(`Detail source for ${item.title}: ${source}, ${Buffer.byteLength(text, 'utf8')} bytes`);
      return text;
    }

    console.log(`Detail source for ${item.title}: none, 0 bytes`);
    return '';
  } catch (error) {
    console.warn(`Could not load listing detail for ${item.url}:`, error?.message || error);
    return '';
  } finally {
    await detailPage.close();
  }
}

async function sendNtfy(item) {
  if (!NTFY_TOPIC) return;

  const header = `${item.title}${item.price ? `\n${item.price}` : ''}`;
  const fullMessage = item.detail ? `${header}\n\n${item.detail}` : header;
  const chunks = splitUtf8(fullMessage);

  for (let i = 0; i < chunks.length; i += 1) {
    const response = await fetch('https://ntfy.sh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        topic: NTFY_TOPIC,
        title: chunks.length > 1 ? `키캡 새 매물 (${i + 1}/${chunks.length})` : '키캡 새 매물',
        message: chunks[i],
        priority: 4,
        tags: ['shopping_cart'],
        click: item.url
      })
    });
    if (!response.ok) throw new Error(`ntfy failed: ${response.status} ${await response.text()}`);
  }
}

async function sendDiscord(item) {
  if (!DISCORD_WEBHOOK_URL) return;

  const detailChunks = splitText(item.detail || '판매글 본문이 없습니다.', DISCORD_DETAIL_CHARS);
  const shortPrice = formatPriceManwon(item.price);

  for (let i = 0; i < detailChunks.length; i += 1) {
    const first = i === 0;
    const total = detailChunks.length;
    const sourceLink = first ? `\n\n[🔗 판매글 보기](${item.url})` : '';
    const titleText = shortPrice ? `${item.title} - ${shortPrice}` : item.title;
    const embed = {
      title: first ? `🆕 ${truncate(titleText, 250)}` : `↳ 본문 계속 (${i + 1}/${total})`,
      url: item.url,
      description: `${detailChunks[i]}${sourceLink}`,
      footer: { text: first ? '구해요 · 키캡 판매 알림' : `구해요 · 본문 ${i + 1}/${total}` },
      timestamp: new Date().toISOString()
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const response = await fetch(DISCORD_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'Guheyo Keycap Alert', allowed_mentions: { parse: [] }, embeds: [embed] })
      });
      if (response.ok) break;
      if (response.status === 429 && attempt < 3) {
        let retryAfter = 1;
        try { retryAfter = Number((await response.json())?.retry_after) || 1; } catch {}
        await new Promise((resolve) => setTimeout(resolve, Math.ceil(retryAfter * 1000)));
        continue;
      }
      throw new Error(`Discord webhook failed: ${response.status} ${await response.text()}`);
    }
  }
}

async function sendNotification(item) {
  if (NTFY_TOPIC) await sendNtfy(item);
  if (DISCORD_WEBHOOK_URL) await sendDiscord(item);
}

function saveState(ids) {
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({
      initialized: true,
      updatedAt: new Date().toISOString(),
      seen: [...new Set(ids)].slice(0, MAX_SEEN)
    }, null, 2) + '\n'
  );
}

browser = await chromium.launch({ headless: true, channel: 'chrome' });
const page = await browser.newPage({
  viewport: { width: 1280, height: 1800 },
  locale: 'ko-KR',
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Safari/537.36'
});

try {
  console.log('Opening:', MARKET_URL);
  await page.goto(MARKET_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  const offerLinks = page.locator('a[href*="/offer/"]');
  await offerLinks.first().waitFor({ state: 'attached', timeout: 20_000 });
  await page.waitForTimeout(1500);

  const rawLinks = await offerLinks.evaluateAll((nodes) => nodes.map((a) => ({
    href: a.href,
    text: (a.innerText || a.textContent || '').replace(/\s+/g, ' ').trim()
  })));

  const unique = new Map();
  for (const link of rawLinks) {
    if (!link.href || !link.text) continue;
    if (!/키캡/.test(link.text) || !/[\d,]+\s*원/.test(link.text)) continue;
    if (!unique.has(link.href)) unique.set(link.href, link);
  }

  const candidates = [...unique.values()];
  console.log(`Found ${candidates.length} keycap listings.`);
  console.log(JSON.stringify(candidates.slice(0, 8), null, 2));
  if (candidates.length === 0) throw new Error('No keycap listings found. Guheyo page structure may have changed.');

  const items = candidates.map((x) => {
    const parsed = parseListing(x.text);
    return {
      id: hash(x.href),
      url: x.href,
      title: parsed.title,
      price: parsed.price,
      summary: parsed.normalized,
      detail: ''
    };
  });

  const state = loadState();
  const seen = new Set(Array.isArray(state.seen) ? state.seen : []);

  if (!state.initialized || seen.size === 0) {
    console.log(`Baseline initialization: storing ${items.length} current listings without notifying.`);
    saveState(items.map((x) => x.id));
  } else {
    const fresh = items.filter((x) => !seen.has(x.id));
    console.log(`New listings: ${fresh.length}`);

    if (fresh.length === 0) {
      console.log('No state update needed.');
    } else if (fresh.length > MAX_NEW_LISTINGS) {
      throw new Error(`Suspiciously many new Guheyo listings (${fresh.length}); state was not updated.`);
    } else if (!NTFY_TOPIC && !DISCORD_WEBHOOK_URL) {
      console.log('[notify] No Guheyo notification channel is configured. New listings remain pending; state was not updated.');
    } else {
      const acknowledged = new Set(seen);
      for (const item of [...fresh].reverse()) {
        console.log('New:', item.title, item.price, item.url);
        item.detail = await fetchListingDetail(item);
        await sendNotification(item);
        acknowledged.add(item.id);
        saveState([...acknowledged]);
      }

      saveState([...items.map((x) => x.id), ...acknowledged]);
      console.log(`Sent ${fresh.length} Guheyo notification(s) and updated state.`);
    }
  }
} finally {
  await browser.close();
}
