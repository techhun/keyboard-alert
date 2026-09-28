import test from 'node:test';
import assert from 'node:assert/strict';

import {
  diffRows,
  parseSwagkeysStatusApi,
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


test('parses current SWAGKEYS Notion collection rows without browser rendering', () => {
  const pageId = '3b5f75d5-3601-8064-b051-e6a663b41d35';
  const collectionId = '71df75d5-3601-82b1-b8bc-071f8ecc44e0';
  const schema = {
    'Zr<U': { name: '공제 (Group-Buy)', type: 'number', show_as: { maxValue: 6 } },
    'z\\dm': { name: '생산 대기 (Waiting Production)', type: 'number', show_as: { maxValue: 6 } },
    ':z^h': { name: '생산중 (In Production)', type: 'number', show_as: { maxValue: 6 } },
    'aDOQ': { name: '배송중 (Shipping)', type: 'number', show_as: { maxValue: 6 } },
    'Dmnh': { name: '예판분 발송 완료 (Fulfilled)', type: 'number', show_as: { maxValue: 6 } },
    'zIZq': { name: '인스탁 판매중 (In-Stock)', type: 'number', show_as: { maxValue: 6 } },
    '?CvY': { name: '컬러 매칭 (Color Matching)', type: 'status', defaultOption: 'Not started' },
    'U}^t': { name: '배송 예정일 (ETA)', type: 'date' },
    'nF;r': { name: 'Current Status', type: 'status' }
  };
  const pageData = {
    recordMap: {
      block: {
        [pageId]: {
          spaceId: 'space',
          value: { value: { collection_id: collectionId } }
        }
      },
      collection: {
        [collectionId]: { value: { value: { schema } } }
      }
    }
  };
  const date = (start_date) => [['‣', [['d', { type: 'date', start_date }]]]];
  const text = (value) => [[value]];
  const collectionData = {
    result: {
      reducerResults: {
        collection_group_results: { blockIds: ['red', 'art'] }
      }
    },
    recordMap: {
      block: {
        red: {
          value: {
            value: {
              properties: {
                title: text('Classic Red'),
                'Zr<U': text('6'),
                'z\\dm': text('6'),
                ':z^h': text('3'),
                'aDOQ': text('0'),
                'Dmnh': text('0'),
                'zIZq': text('0'),
                '?CvY': text('Complete'),
                'U}^t': date('2026-10-19'),
                'nF;r': text('생산중 (In Production)')
              }
            }
          }
        },
        art: {
          value: {
            value: {
              properties: {
                title: text('Art'),
                'Zr<U': text('3'),
                'z\\dm': text('0'),
                ':z^h': text('0'),
                'aDOQ': text('0'),
                'Dmnh': text('0'),
                'zIZq': text('0'),
                'nF;r': text('예약판매 진행중 (in GB)')
              }
            }
          }
        }
      }
    }
  };

  assert.deepEqual(parseSwagkeysStatusApi(pageData, collectionData), [
    {
      product: 'Classic Red',
      groupBuy: 100,
      waitingProduction: 100,
      inProduction: 50,
      shipping: 0,
      fulfilled: 0,
      inStock: 0,
      colorMatching: 'Complete',
      eta: '2026-10-19',
      currentStatus: '생산중 (In Production)'
    },
    {
      product: 'Art',
      groupBuy: 50,
      waitingProduction: 0,
      inProduction: 0,
      shipping: 0,
      fulfilled: 0,
      inStock: 0,
      colorMatching: 'Not started',
      eta: '',
      currentStatus: '예약판매 진행중 (in GB)'
    }
  ]);
});
