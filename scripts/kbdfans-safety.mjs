import { createHash } from 'node:crypto';
import { clean, comparableValue } from './geonworks-safety.mjs';

const KNOWN_CATEGORIES = new Set(['KEYCAPS', 'KEYBOARDS', 'DESKPADS']);

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

function parseMeta(body) {
  const block = body.match(/<div\b[^>]*class=["'][^"']*\bkbd-update-card__meta\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1] || '';
  return [...block.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((match) => htmlText(match[1]));
}

function parseLatestUpdate(body) {
  const updates = [...body.matchAll(/<article\b[^>]*class=["'][^"']*\bkbd-update-entry\b[^"']*["'][^>]*>([\s\S]*?)<\/article>/gi)]
    .map((match) => {
      const article = match[1];
      return {
        title: htmlText(article.match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i)?.[1]),
        date: htmlText(article.match(/<time\b[^>]*>([\s\S]*?)<\/time>/i)?.[1]),
        body: htmlText(article.match(/<div\b[^>]*class=["'][^"']*\bkbd-update-entry__body\b[^"']*["'][^>]*>([\s\S]*?)<\/div>/i)?.[1])
      };
    })
    .filter((item) => item.date || item.title || item.body);

  updates.sort((a, b) => {
    const ta = Date.parse(a.date);
    const tb = Date.parse(b.date);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
    return b.date.localeCompare(a.date);
  });

  return updates[0] || { title: '', date: '', body: '' };
}

export function parseKbdFansUpdatesHtml(html) {
  const source = String(html ?? '');
  const rows = [];

  for (const match of source.matchAll(/<details\b[^>]*class=["'][^"']*\bkbd-update-card\b[^"']*["'][^>]*>([\s\S]*?)<\/details>/gi)) {
    const body = match[1];
    const meta = parseMeta(body);
    const category = clean(meta[0]).toUpperCase();
    const status = clean(meta[1]);
    const eta = clean(meta[2]).replace(/^ETA\s+/i, '');
    const product = htmlText(body.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/i)?.[1]);
    const progressRaw = body.match(/aria-valuenow=["']([^"']+)["']/i)?.[1] || '';
    const progress = Number.parseInt(progressRaw, 10);
    const summary = htmlText(body.match(/<div\b[^>]*class=["'][^"']*\bkbd-update-card__footer\b[^"']*["'][^>]*>\s*<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1]);
    const latest = parseLatestUpdate(body);

    if (!KNOWN_CATEGORIES.has(category) || !product || !status) continue;

    rows.push({
      category,
      product,
      status,
      eta,
      progress: Number.isFinite(progress) ? progress : 0,
      summary,
      latestUpdateDate: latest.date,
      latestUpdateTitle: latest.title,
      latestUpdateBody: latest.body
    });
  }

  return validateKbdFansRows(rows);
}

export function validateKbdFansRows(rows) {
  if (!Array.isArray(rows) || rows.length < 30) {
    throw new Error('KBDfans returned suspiciously few rows: ' + (Array.isArray(rows) ? rows.length : 0));
  }

  const identities = new Set();
  const categories = new Map();

  for (const [index, row] of rows.entries()) {
    const category = clean(row?.category).toUpperCase();
    const product = clean(row?.product);
    const status = clean(row?.status);
    const eta = clean(row?.eta);
    const progress = Number(row?.progress);

    if (!KNOWN_CATEGORIES.has(category) || !product || !status) {
      throw new Error('KBDfans row ' + (index + 1) + ' is missing or misplacing required fields');
    }
    if (!Number.isFinite(progress) || progress < 0 || progress > 100) {
      throw new Error('KBDfans row ' + (index + 1) + ' has invalid progress: ' + row?.progress);
    }
    if (/^https?:\/\//i.test(product) || /^https?:\/\//i.test(status) || /^https?:\/\//i.test(eta)) {
      throw new Error('KBDfans row ' + (index + 1) + ' has shifted text fields');
    }
    if (row.latestUpdateDate && !/^\d{4}-\d{2}-\d{2}$/.test(clean(row.latestUpdateDate))) {
      throw new Error('KBDfans row ' + (index + 1) + ' has invalid latest update date: ' + row.latestUpdateDate);
    }

    const key = category + '|' + product.toLowerCase();
    if (identities.has(key)) throw new Error('KBDfans duplicate row identity: ' + key);
    identities.add(key);
    categories.set(category, (categories.get(category) || 0) + 1);
  }

  for (const category of KNOWN_CATEGORIES) {
    if (!categories.get(category)) throw new Error('KBDfans category returned no rows: ' + category);
  }

  return rows;
}

function identity(row) {
  return clean(row?.category).toUpperCase() + '|' + clean(row?.product).toLowerCase();
}

const FIELD_LABELS = {
  status: '상태',
  eta: 'ETA',
  progress: '진행률',
  summary: '요약',
  latestUpdateDate: '최근 업데이트 일자',
  latestUpdateTitle: '최근 업데이트 제목',
  latestUpdateBody: '최근 업데이트 내용'
};

const COMPARED_FIELDS = Object.keys(FIELD_LABELS);

export function diffKbdFansRows(previousRows, currentRows) {
  const previous = new Map(previousRows.map((row) => [identity(row), row]));
  const current = new Map(currentRows.map((row) => [identity(row), row]));
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
        before: before[field] ?? '—',
        after: row[field] ?? '—'
      }));

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

export function kbdFansChangeSignature(changes) {
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

export function kbdFansChangeId(change) {
  return createHash('sha256')
    .update(kbdFansChangeSignature([change]))
    .digest('hex')
    .slice(0, 24);
}
