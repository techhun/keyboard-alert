import { createHash } from 'node:crypto';
import { clean, comparableValue } from './geonworks-safety.mjs';

export const DESKHERO_PAGES = [
  { category: 'Keyboard', url: 'https://help.deskhero.ca/en-US/group-buypreorder-keyboard-updates-4856504' },
  { category: 'Keyset', url: 'https://help.deskhero.ca/en-US/group-buypreorder-keyset-updates-4855831' },
  { category: 'Deskmat', url: 'https://help.deskhero.ca/en-US/group-buypreorder-deskmat-updates-4855887' },
  { category: 'Accessory', url: 'https://help.deskhero.ca/en-US/group-buypreorder-accessories-updates-4856503' }
];

const MINIMUM_CATEGORY_ROWS = {
  Keyboard: 20,
  Keyset: 50,
  Deskmat: 30,
  Accessory: 5
};

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

function productKey(value) {
  return comparableValue(value).toLocaleLowerCase('en-US');
}

function findUpdateTable(html) {
  const tables = [...String(html ?? '').matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)]
    .map((match) => match[0]);
  const table = tables.find((candidate) =>
    /Product\s*Name/i.test(htmlText(candidate)) &&
    /Status\s*\/\s*Notes/i.test(htmlText(candidate))
  );
  if (!table) throw new Error('Deskhero update table was not found');
  return table;
}

export function parseDeskheroPageHtml(html, page) {
  const category = clean(page?.category);
  const sourceUrl = clean(page?.url);
  if (!category || !sourceUrl) throw new Error('Deskhero page metadata is missing');

  const table = findUpdateTable(html);
  const grouped = new Map();

  for (const match of table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)]
      .map((cell) => htmlText(cell[1]));
    if (cells.length < 2) continue;

    const product = clean(cells[0]);
    const notes = clean(cells[1]);
    if (!product || !notes) continue;
    if (/^Product\s*Name$/i.test(product) || /^Status\s*\/\s*Notes$/i.test(notes)) continue;

    const key = productKey(product);
    const existing = grouped.get(key) || { category, product, notes: [], sourceUrl };
    if (!existing.notes.some((value) => comparableValue(value) === comparableValue(notes))) {
      existing.notes.push(notes);
    }
    grouped.set(key, existing);
  }

  return [...grouped.values()].map((row) => ({
    category: row.category,
    product: row.product,
    notes: row.notes.join(' | '),
    sourceUrl: row.sourceUrl
  }));
}

export function validateDeskheroRows(rows) {
  if (!Array.isArray(rows) || rows.length < 100) {
    throw new Error('Deskhero returned suspiciously few rows: ' + (Array.isArray(rows) ? rows.length : 0));
  }

  const counts = {};
  const identities = new Set();

  for (const [index, row] of rows.entries()) {
    const category = clean(row?.category);
    const product = clean(row?.product);
    const notes = clean(row?.notes);
    const sourceUrl = clean(row?.sourceUrl);

    if (!category || !product || !notes || !sourceUrl) {
      throw new Error('Deskhero row ' + (index + 1) + ' is missing a required field');
    }
    if (!Object.hasOwn(MINIMUM_CATEGORY_ROWS, category)) {
      throw new Error('Deskhero row ' + (index + 1) + ' has an unknown category: ' + category);
    }
    if (!/^https:\/\/help\.deskhero\.ca\/en-US\//i.test(sourceUrl)) {
      throw new Error('Deskhero row ' + (index + 1) + ' has an unexpected source URL: ' + sourceUrl);
    }
    if (/^https?:\/\//i.test(product) || /^https?:\/\//i.test(notes)) {
      throw new Error('Deskhero row ' + (index + 1) + ' has shifted text fields');
    }

    const id = category.toLowerCase() + '|' + productKey(product);
    if (identities.has(id)) throw new Error('Deskhero duplicate row identity: ' + category + ' | ' + product);
    identities.add(id);
    counts[category] = (counts[category] || 0) + 1;
  }

  for (const [category, minimum] of Object.entries(MINIMUM_CATEGORY_ROWS)) {
    if ((counts[category] || 0) < minimum) {
      throw new Error('Deskhero category returned suspiciously few rows: ' + category + '=' + (counts[category] || 0));
    }
  }

  return rows;
}

function identity(row) {
  return clean(row?.category).toLowerCase() + '|' + productKey(row?.product);
}

export function diffDeskheroRows(previousRows, currentRows) {
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
    if (comparableValue(before.notes) !== comparableValue(row.notes)) {
      fields.push({
        field: 'notes',
        label: '상태 / 상세 메모',
        before: before.notes || '—',
        after: row.notes || '—'
      });
    }
    if (fields.length) changes.push({ kind: 'changed', row, before, fields });
  }

  for (const [key, row] of previous) {
    if (!current.has(key)) changes.push({ kind: 'removed', row });
  }

  return changes;
}

function stableRow(row) {
  return {
    category: comparableValue(row?.category),
    product: comparableValue(row?.product),
    notes: comparableValue(row?.notes),
    sourceUrl: comparableValue(row?.sourceUrl)
  };
}

export function deskheroChangeSignature(changes) {
  return (changes || []).map((change) => {
    const key = identity(change?.row);
    if (change.kind === 'changed') {
      const fields = (change.fields || []).map((field) => ({
        field: field.field || field.label || '',
        before: comparableValue(field.before),
        after: comparableValue(field.after)
      })).sort((a, b) => a.field.localeCompare(b.field));
      return JSON.stringify({ kind: change.kind, key, fields });
    }
    return JSON.stringify({ kind: change.kind, key, row: stableRow(change.row) });
  }).sort().join('\n');
}

export function deskheroChangeId(change) {
  return createHash('sha256')
    .update(deskheroChangeSignature([change]))
    .digest('hex')
    .slice(0, 24);
}
