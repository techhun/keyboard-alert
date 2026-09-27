import { createHash } from 'node:crypto';
import { clean, comparableValue } from './geonworks-safety.mjs';

const CATEGORY_TABS = [
  { id: 'keyboards', label: 'Keyboard' },
  { id: 'keycaps', label: 'Keycap' },
  { id: 'deskpads', label: 'Deskpad' },
  { id: 'switches', label: 'Misc.' }
];

function decodeHtml(value) {
  return String(value ?? '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number.parseInt(dec, 10)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function htmlText(value) {
  return clean(decodeHtml(String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')));
}

function attrValue(attrs, name) {
  const match = String(attrs ?? '').match(new RegExp('\\b' + name + '=["\']([^"\']+)["\']', 'i'));
  return match ? decodeHtml(match[1]).trim() : '';
}

function normalizeProductUrl(href) {
  try {
    const url = new URL(href, 'https://novelkeys.com');
    return url.origin + (url.pathname.replace(/\/$/, '') || '/');
  } catch {
    return '';
  }
}

function sectionRange(html, id) {
  const matcher = new RegExp('<div\\b[^>]*\\bid=["\']' + id + '["\'][^>]*>', 'i');
  const match = matcher.exec(html);
  if (!match) throw new Error('NovelKeys tab section not found: ' + id);

  const start = match.index + match[0].length;
  const later = CATEGORY_TABS
    .filter((tab) => tab.id !== id)
    .map((tab) => {
      const re = new RegExp('<div\\b[^>]*\\bid=["\']' + tab.id + '["\'][^>]*>', 'i');
      const found = re.exec(html.slice(start));
      return found ? start + found.index : Number.POSITIVE_INFINITY;
    })
    .filter(Number.isFinite);

  const end = later.length ? Math.min(...later) : html.length;
  return html.slice(start, end);
}

function parseCards(sectionHtml, category) {
  const cards = [];
  const cardRe = /<a\b([^>]*class=["'][^"']*\bpreorder-timeline-link\b[^"']*["'][^>]*)>([\s\S]*?)<\/a>/gi;

  for (const match of sectionHtml.matchAll(cardRe)) {
    const attrs = match[1];
    const body = match[2];
    const href = attrValue(attrs, 'href');
    const titleMatch = body.match(/<h2\b[^>]*class=["'][^"']*\bpreorder-timeline-title\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);
    const statusMatch = body.match(/Current\s*Status:\s*<\/b>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i);
    const etaMatch = body.match(/<span\b[^>]*class=["'][^"']*\bpreorder-timeline-text\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i);

    const product = htmlText(titleMatch?.[1]);
    const status = htmlText(statusMatch?.[1]);
    const eta = htmlText(etaMatch?.[1]);
    const url = normalizeProductUrl(href);
    if (!product || !status || !url) continue;

    cards.push({ category, product, status, eta, url });
  }

  return cards;
}

export function validateNovelKeysRows(rows) {
  if (!Array.isArray(rows) || rows.length < 30) {
    throw new Error('NovelKeys returned suspiciously few rows: ' + (Array.isArray(rows) ? rows.length : 0));
  }

  const categories = new Map();
  const identities = new Set();

  for (const [index, row] of rows.entries()) {
    const category = clean(row?.category);
    const product = clean(row?.product);
    const status = clean(row?.status);
    const eta = clean(row?.eta);
    const url = clean(row?.url);

    if (!category || !product || !status || !url) {
      throw new Error('NovelKeys row ' + (index + 1) + ' is missing a required field');
    }
    if (!/^https:\/\/novelkeys\.com\/products\//i.test(url)) {
      throw new Error('NovelKeys row ' + (index + 1) + ' has an unexpected product URL: ' + url);
    }
    if (/^https?:\/\//i.test(product) || /^https?:\/\//i.test(status) || /^https?:\/\//i.test(eta)) {
      throw new Error('NovelKeys row ' + (index + 1) + ' has shifted text fields');
    }

    const identity = category.toLowerCase() + '|' + url.toLowerCase() + '|' + product.toLowerCase();
    if (identities.has(identity)) {
      throw new Error('NovelKeys duplicate row identity: ' + product + ' | ' + url);
    }
    identities.add(identity);
    categories.set(category, (categories.get(category) || 0) + 1);
  }

  for (const { label } of CATEGORY_TABS) {
    if (!categories.get(label)) throw new Error('NovelKeys category returned no rows: ' + label);
  }

  return rows;
}

export function parseNovelKeysUpdatesHtml(html) {
  const source = String(html ?? '');
  const rows = CATEGORY_TABS.flatMap(({ id, label }) => parseCards(sectionRange(source, id), label));
  return validateNovelKeysRows(rows);
}

function identity(row) {
  return clean(row?.category).toLowerCase() + '|' + clean(row?.url).toLowerCase() + '|' + clean(row?.product).toLowerCase();
}

export function diffNovelKeysRows(previousRows, currentRows) {
  const previous = new Map(previousRows.map((row) => [identity(row), row]));
  const current = new Map(currentRows.map((row) => [identity(row), row]));
  const changes = [];

  for (const [key, row] of current) {
    const before = previous.get(key);
    if (!before) {
      changes.push({ kind: 'added', row });
      continue;
    }

    const fields = [];
    if (comparableValue(before.status) !== comparableValue(row.status)) {
      fields.push({ field: 'status', label: '상태', before: before.status || '—', after: row.status || '—' });
    }
    if (comparableValue(before.eta) !== comparableValue(row.eta)) {
      fields.push({ field: 'eta', label: '예상 입고', before: before.eta || '—', after: row.eta || '—' });
    }
    if (fields.length) changes.push({ kind: 'changed', row, before, fields });
  }

  for (const [key, row] of previous) {
    if (!current.has(key)) changes.push({ kind: 'removed', row });
  }

  return changes;
}

function stableRow(row) {
  return Object.fromEntries(Object.entries(row || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, comparableValue(value)]));
}

export function novelKeysChangeSignature(changes) {
  return (changes || []).map((change) => {
    const key = identity(change?.row);
    if (change.kind === 'changed') {
      const fields = (change.fields || [])
        .map((field) => ({
          field: field.field || field.label || '',
          before: comparableValue(field.before),
          after: comparableValue(field.after)
        }))
        .sort((a, b) => a.field.localeCompare(b.field));
      return JSON.stringify({ kind: change.kind, key, fields });
    }
    return JSON.stringify({ kind: change.kind, key, row: stableRow(change.row) });
  }).sort().join('\n');
}

export function novelKeysChangeId(change) {
  return createHash('sha256')
    .update(novelKeysChangeSignature([change]))
    .digest('hex')
    .slice(0, 24);
}
