import { createHash } from 'node:crypto';
import { clean, comparableValue } from './geonworks-safety.mjs';

export const OMNITYPE_PAGE_URL = 'https://omnitype.com/pages/product-updates';

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

function updateSection(html) {
  const source = String(html ?? '');
  const marker = /GROUPBUYS\s+and\s+preorders/i.exec(source);
  if (!marker) throw new Error('Omnitype Groupbuys and preorders section was not found');

  const start = source.lastIndexOf('<section', marker.index);
  const end = source.indexOf('</section>', marker.index);
  if (start < 0 || end < 0 || end <= start) {
    throw new Error('Omnitype Product Updates section boundaries were not recognized');
  }
  return source.slice(start, end + '</section>'.length);
}

export function parseOmnitypeUpdatesHtml(html) {
  const section = updateSection(html);
  const chunks = section.split(/<div\b[^>]*class=["'][^"']*\baccordion__wrapper\b[^"']*["'][^>]*>/i).slice(1);
  const rows = [];

  for (const chunk of chunks) {
    const titleMatch = chunk.match(/<button\b[^>]*class=["'][^"']*\baccordion__title\b[^"']*["'][^>]*>([\s\S]*?)<\/button>/i);
    const bodyMatch = chunk.match(/<div\b[^>]*\bdata-accordion-body\b[^>]*>([\s\S]*?)<\/div>/i);
    if (!titleMatch || !bodyMatch) continue;

    const product = htmlText(titleMatch[1]);
    const body = bodyMatch[1];
    const overview = [...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
      .map((match) => htmlText(match[1]))
      .filter(Boolean)
      .join(' | ');
    const components = [...body.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)]
      .map((match) => htmlText(match[1]))
      .filter(Boolean);

    if (!product || (!overview && components.length === 0)) continue;
    rows.push({
      product,
      overview,
      components,
      sourceUrl: OMNITYPE_PAGE_URL
    });
  }

  return validateOmnitypeRows(rows);
}

export function validateOmnitypeRows(rows) {
  if (!Array.isArray(rows) || rows.length < 3) {
    throw new Error('Omnitype returned suspiciously few rows: ' + (Array.isArray(rows) ? rows.length : 0));
  }

  const identities = new Set();

  for (const [index, row] of rows.entries()) {
    const product = clean(row?.product);
    const overview = clean(row?.overview);
    const components = Array.isArray(row?.components) ? row.components.map(clean).filter(Boolean) : null;
    const sourceUrl = clean(row?.sourceUrl);

    if (!product || (!overview && (!components || components.length === 0)) || !sourceUrl) {
      throw new Error('Omnitype row ' + (index + 1) + ' is missing required update content');
    }
    if (sourceUrl !== OMNITYPE_PAGE_URL) {
      throw new Error('Omnitype row ' + (index + 1) + ' has an unexpected source URL: ' + sourceUrl);
    }
    if (/^https?:\/\//i.test(product) || /^https?:\/\//i.test(overview)) {
      throw new Error('Omnitype row ' + (index + 1) + ' has shifted text fields');
    }
    if (!Array.isArray(row.components)) {
      throw new Error('Omnitype row ' + (index + 1) + ' components must be an array');
    }
    if (components.some((value) => /^https?:\/\//i.test(value))) {
      throw new Error('Omnitype row ' + (index + 1) + ' has a shifted component field');
    }

    const key = productKey(product);
    if (identities.has(key)) throw new Error('Omnitype duplicate product: ' + product);
    identities.add(key);
  }

  return rows;
}

function identity(row) {
  return productKey(row?.product);
}

function componentsValue(row) {
  return (Array.isArray(row?.components) ? row.components : [])
    .map(comparableValue)
    .filter(Boolean)
    .join('\n');
}

export function diffOmnitypeRows(previousRows, currentRows) {
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
    if (comparableValue(before.overview) !== comparableValue(row.overview)) {
      fields.push({
        field: 'overview',
        label: '예상 일정 / 요약',
        before: before.overview || '—',
        after: row.overview || '—'
      });
    }

    const beforeComponents = componentsValue(before);
    const afterComponents = componentsValue(row);
    if (beforeComponents !== afterComponents) {
      fields.push({
        field: 'components',
        label: '부품별 진행',
        before: beforeComponents || '—',
        after: afterComponents || '—'
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
    product: comparableValue(row?.product),
    overview: comparableValue(row?.overview),
    components: componentsValue(row),
    sourceUrl: comparableValue(row?.sourceUrl)
  };
}

export function omnitypeChangeSignature(changes) {
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

export function omnitypeChangeId(change) {
  return createHash('sha256')
    .update(omnitypeChangeSignature([change]))
    .digest('hex')
    .slice(0, 24);
}
