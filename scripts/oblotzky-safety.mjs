import { createHash } from 'node:crypto';
import { clean, comparableValue, normalizeKey } from './geonworks-safety.mjs';

const LAST_UPDATED_RE = /^\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}$/;

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

function cellText(value) {
  return clean(decodeHtml(String(value ?? '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')));
}

function tableRows(tableHtml) {
  return [...String(tableHtml ?? '').matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map((match) => [...match[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((cell) => cellText(cell[1])))
    .filter((cells) => cells.length > 0);
}

function normalizeHeader(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function validateOblotzkyRows(rows) {
  if (!Array.isArray(rows) || rows.length < 10) {
    throw new Error(`Oblotzky returned suspiciously few rows: ${Array.isArray(rows) ? rows.length : 0}`);
  }

  for (const [index, row] of rows.entries()) {
    const project = clean(row?.project);
    const lastUpdated = clean(row?.lastUpdated);
    const status = clean(row?.status);
    if (!project || !status) throw new Error(`Oblotzky row ${index + 1} is missing project or status`);
    if (/^https?:\/\//i.test(project) || /^https?:\/\//i.test(status)) {
      throw new Error(`Oblotzky row ${index + 1} unexpectedly contains a URL`);
    }
    if (LAST_UPDATED_RE.test(project)) {
      throw new Error(`Oblotzky row ${index + 1} project unexpectedly looks like a date: ${project}`);
    }
    if (!LAST_UPDATED_RE.test(lastUpdated)) {
      throw new Error(`Oblotzky row ${index + 1} lastUpdated was not recognized: ${lastUpdated}`);
    }
  }

  return rows;
}

export function parseOblotzkyScheduleHtml(html) {
  const tables = [...String(html ?? '').matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)];
  for (const table of tables) {
    const rows = tableRows(table[1]);
    if (rows.length < 2) continue;

    const header = rows[0].map(normalizeHeader);
    const projectIndex = header.indexOf('project');
    const lastUpdatedIndex = header.indexOf('lastupdated');
    const statusIndex = header.indexOf('status');
    if (projectIndex < 0 || lastUpdatedIndex < 0 || statusIndex < 0) continue;

    const parsed = rows.slice(1)
      .filter((cells) => cells.length > Math.max(projectIndex, lastUpdatedIndex, statusIndex))
      .map((cells) => ({
        project: clean(cells[projectIndex]),
        lastUpdated: clean(cells[lastUpdatedIndex]),
        status: clean(cells[statusIndex])
      }))
      .filter((row) => row.project);

    return validateOblotzkyRows(parsed);
  }

  throw new Error('Oblotzky schedule table was not found or its headers changed');
}

function buildMap(rows) {
  const map = new Map();
  for (const row of rows) map.set(normalizeKey(row.project), row);
  return map;
}

export function diffOblotzkyRows(previousRows, currentRows) {
  const previous = buildMap(previousRows);
  const current = buildMap(currentRows);
  const changes = [];

  for (const [key, row] of current) {
    const before = previous.get(key);
    if (!before) {
      changes.push({ kind: 'added', row });
      continue;
    }

    const fields = [];
    if (comparableValue(before.lastUpdated) !== comparableValue(row.lastUpdated)) {
      fields.push({
        field: 'lastUpdated',
        label: '마지막 갱신',
        before: before.lastUpdated || '—',
        after: row.lastUpdated || '—'
      });
    }
    if (comparableValue(before.status) !== comparableValue(row.status)) {
      fields.push({
        field: 'status',
        label: '상태',
        before: before.status || '—',
        after: row.status || '—'
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
  return Object.fromEntries(Object.entries(row || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, comparableValue(value)]));
}

export function oblotzkyChangeSignature(changes) {
  return (changes || []).map((change) => {
    const project = comparableValue(change?.row?.project);
    if (change.kind === 'changed') {
      const fields = (change.fields || [])
        .map((field) => ({
          field: field.field || field.label || '',
          before: comparableValue(field.before),
          after: comparableValue(field.after)
        }))
        .sort((a, b) => a.field.localeCompare(b.field));
      return JSON.stringify({ kind: change.kind, project, fields });
    }
    return JSON.stringify({ kind: change.kind, project, row: stableRow(change.row) });
  }).sort().join('\n');
}

export function oblotzkyChangeId(change) {
  return createHash('sha256')
    .update(oblotzkyChangeSignature([change]))
    .digest('hex')
    .slice(0, 24);
}
