import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diffRows,
  preserveIndependentFreshChanges
} from '../scripts/check-swagkeys.mjs';

const previousRows = [{
  product: 'Classic Red',
  groupBuy: 100,
  waitingProduction: 100,
  inProduction: 33.3,
  shipping: 0,
  fulfilled: 0,
  inStock: 0,
  colorMatching: 'Complete',
  eta: '2026-09-28',
  currentStatus: '생산중 (In Production)'
}];

const freshRows = [{
  ...previousRows[0],
  inProduction: 66.7
}];

const state = {
  announcement: { heading: '업데이트(26.09.08)', content: 'old' },
  quarters: { Q1: ['A'], Q2: ['B'], Q3: ['Classic Red'], Q4: ['D'] }
};

test('roadmap removal verification failure does not discard fresh status progress changes', () => {
  const snapshot = {
    announcement: { heading: '업데이트(26.09.28)', content: 'new' },
    quarters: { Q1: ['A'], Q2: ['B'], Q3: [], Q4: ['D'] },
    rows: freshRows,
    roadmapFresh: true,
    statusFresh: true,
    fallbackSince: {}
  };
  const verificationSnapshot = {
    ...snapshot,
    fallbackSince: { roadmap: '2026-09-28T10:00:00.000Z' }
  };

  const preserved = preserveIndependentFreshChanges({
    state,
    previousRows,
    snapshot,
    verificationSnapshot,
    removalNeedsRoadmapFresh: true,
    removalNeedsStatusFresh: false
  });

  assert.deepEqual(preserved.quarters, state.quarters);
  assert.deepEqual(preserved.announcement, state.announcement);
  assert.deepEqual(preserved.rows, freshRows);

  const changes = diffRows(previousRows, preserved.rows);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].row.product, 'Classic Red');
  assert.equal(changes[0].fields[0].key, 'inProduction');
  assert.equal(changes[0].fields[0].before, 33.3);
  assert.equal(changes[0].fields[0].after, 66.7);
});

test('status-row removal verification failure preserves previous status rows', () => {
  const snapshot = {
    announcement: state.announcement,
    quarters: state.quarters,
    rows: [],
    roadmapFresh: true,
    statusFresh: true,
    fallbackSince: {}
  };
  const verificationSnapshot = {
    ...snapshot,
    fallbackSince: { status: '2026-09-28T10:00:00.000Z' }
  };

  const preserved = preserveIndependentFreshChanges({
    state,
    previousRows,
    snapshot,
    verificationSnapshot,
    removalNeedsRoadmapFresh: false,
    removalNeedsStatusFresh: true
  });

  assert.deepEqual(preserved.rows, previousRows);
  assert.deepEqual(preserved.quarters, state.quarters);
});
