import { createHash } from 'node:crypto';
import { clean, comparableValue } from './geonworks-safety.mjs';

const STATUS_VALUES = new Set(['ordered', 'manufacturing', 'en_route', 'shipping', 'complete']);
const CATEGORY_VALUES = new Set(['keyboard', 'keyset', 'deskmat', 'other']);

function latestUpdate(updates) {
  if (!Array.isArray(updates) || updates.length === 0) {
    return { id: null, date: '', description: '' };
  }

  const sorted = updates
    .map((update) => ({
      id: Number.isFinite(Number(update?.id)) ? Number(update.id) : null,
      date: clean(update?.created_at),
      description: clean(update?.description)
    }))
    .filter((update) => update.id !== null || update.date || update.description)
    .sort((a, b) => {
      const ta = Date.parse(a.date);
      const tb = Date.parse(b.date);
      if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
      return (b.id ?? 0) - (a.id ?? 0);
    });

  return sorted[0] || { id: null, date: '', description: '' };
}

export function normalizeCannonKeysRows(details) {
  if (!Array.isArray(details)) throw new Error('CannonKeys bulk response is not an array');

  const rows = details.map((item) => {
    const latest = latestUpdate(item?.updates);
    return {
      id: Number(item?.id),
      displayName: clean(item?.display_name),
      category: clean(item?.category),
      status: clean(item?.status),
      startDate: clean(item?.start_date),
      endDate: clean(item?.end_date),
      eta: clean(item?.eta),
      latestUpdateId: latest.id,
      latestUpdateDate: latest.date,
      latestUpdateDescription: latest.description
    };
  });

  return validateCannonKeysRows(rows);
}

export function validateCannonKeysIndex(index) {
  if (!Array.isArray(index) || index.length < 100) {
    throw new Error('CannonKeys index returned suspiciously few rows: ' + (Array.isArray(index) ? index.length : 0));
  }

  const ids = new Set();
  for (const [i, item] of index.entries()) {
    const id = Number(item?.id);
    const displayName = clean(item?.display_name);
    const category = clean(item?.category);
    const status = clean(item?.status);

    if (!Number.isInteger(id) || id <= 0 || !displayName) {
      throw new Error('CannonKeys index row ' + (i + 1) + ' is malformed');
    }
    if (!CATEGORY_VALUES.has(category)) {
      throw new Error('CannonKeys index row ' + (i + 1) + ' has unexpected category: ' + category);
    }
    if (!STATUS_VALUES.has(status)) {
      throw new Error('CannonKeys index row ' + (i + 1) + ' has unexpected status: ' + status);
    }
    if (ids.has(id)) throw new Error('CannonKeys index has duplicate id: ' + id);
    ids.add(id);
  }

  return index;
}

export function validateCannonKeysRows(rows) {
  if (!Array.isArray(rows) || rows.length < 100) {
    throw new Error('CannonKeys returned suspiciously few detail rows: ' + (Array.isArray(rows) ? rows.length : 0));
  }

  const ids = new Set();
  for (const [i, row] of rows.entries()) {
    const id = Number(row?.id);
    if (!Number.isInteger(id) || id <= 0 || !clean(row?.displayName)) {
      throw new Error('CannonKeys detail row ' + (i + 1) + ' is malformed');
    }
    if (!CATEGORY_VALUES.has(clean(row?.category))) {
      throw new Error('CannonKeys detail row ' + (i + 1) + ' has unexpected category: ' + row?.category);
    }
    if (!STATUS_VALUES.has(clean(row?.status))) {
      throw new Error('CannonKeys detail row ' + (i + 1) + ' has unexpected status: ' + row?.status);
    }
    for (const field of ['startDate', 'endDate', 'latestUpdateDate']) {
      const value = clean(row?.[field]);
      if (value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new Error('CannonKeys detail row ' + (i + 1) + ' has invalid ' + field + ': ' + value);
      }
    }
    if (ids.has(id)) throw new Error('CannonKeys details have duplicate id: ' + id);
    ids.add(id);
  }

  return rows;
}

const FIELD_LABELS = {
  displayName: '프로젝트명',
  category: '분류',
  status: '상태',
  startDate: 'GB 시작일',
  endDate: 'GB 종료일',
  eta: 'ETA',
  latestUpdateDate: '최근 업데이트 일자',
  latestUpdateDescription: '최근 업데이트 내용'
};

const COMPARED_FIELDS = Object.keys(FIELD_LABELS);

export function diffCannonKeysRows(previousRows, currentRows) {
  const previous = new Map(previousRows.map((row) => [Number(row.id), row]));
  const current = new Map(currentRows.map((row) => [Number(row.id), row]));
  const changes = [];

  for (const [id, row] of current) {
    const before = previous.get(id);
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

  for (const [id, row] of previous) {
    if (!current.has(id)) changes.push({ kind: 'removed', row });
  }

  return changes;
}

function stableRow(row) {
  return Object.fromEntries(Object.entries(row || {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => [key, comparableValue(value)]));
}

export function cannonKeysChangeSignature(changes) {
  return (changes || []).map((change) => {
    const id = Number(change?.row?.id);
    if (change.kind === 'changed') {
      const fields = (change.fields || [])
        .map((field) => ({
          field: field.field || field.label || '',
          before: comparableValue(field.before),
          after: comparableValue(field.after)
        }))
        .sort((a, b) => a.field.localeCompare(b.field));
      return JSON.stringify({ kind: change.kind, id, fields });
    }
    return JSON.stringify({ kind: change.kind, id, row: stableRow(change.row) });
  }).sort().join('\n');
}

export function cannonKeysChangeId(change) {
  return createHash('sha256')
    .update(cannonKeysChangeSignature([change]))
    .digest('hex')
    .slice(0, 24);
}
