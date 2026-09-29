import test from 'node:test';
import assert from 'node:assert/strict';

import {
  notionRetryDelayMs,
  parseSwagkeysRoadmapCollectionApi,
  parseSwagkeysRoadmapPageApi
} from '../scripts/check-swagkeys.mjs';

const wrapped = (value) => ({ value: { value } });
const text = (value) => [[value]];

test('parses SWAGKEYS roadmap announcement and quarter collection sources from Notion page data', () => {
  const pageData = {
    recordMap: {
      block: {
        callout: wrapped({
          type: 'callout',
          content: ['notice-title', 'notice-body-1', 'notice-body-2']
        }),
        'notice-title': wrapped({ type: 'text', properties: { title: text('업데이트(26.09.29)') } }),
        'notice-body-1': wrapped({ type: 'text', properties: { title: text('진행 상황이 변경되었습니다.') } }),
        'notice-body-2': wrapped({ type: 'text', properties: { title: text('두 번째 줄') } }),
        q1: wrapped({ type: 'collection_view', collection_id: 'c1', view_ids: ['v1'] }),
        q2: wrapped({ type: 'collection_view', collection_id: 'c2', view_ids: ['v2'] }),
        q3: wrapped({ type: 'collection_view', collection_id: 'c3', view_ids: ['v3'] }),
        q4: wrapped({ type: 'collection_view', collection_id: 'c4', view_ids: ['v4'] })
      },
      collection: {
        c1: wrapped({ name: text('1분기 (Q1)') }),
        c2: wrapped({ name: text('2분기 (Q2)') }),
        c3: wrapped({ name: text('3분기 (Q3)') }),
        c4: wrapped({ name: text('4분기 (Q4)') })
      },
      collection_view: {
        v1: wrapped({ query2: { sort: [{ property: 'title', direction: 'ascending' }] } }),
        v2: wrapped({ query2: {} }),
        v3: wrapped({ query2: {} }),
        v4: wrapped({ query2: {} })
      }
    }
  };

  const parsed = parseSwagkeysRoadmapPageApi(pageData);
  assert.deepEqual(parsed.announcement, {
    heading: '업데이트(26.09.29)',
    content: '진행 상황이 변경되었습니다.\n두 번째 줄'
  });
  assert.deepEqual(Object.keys(parsed.sources), ['Q1', 'Q2', 'Q3', 'Q4']);
  assert.equal(parsed.sources.Q1.collectionId, 'c1');
  assert.equal(parsed.sources.Q1.viewId, 'v1');
  assert.equal(parsed.sources.Q1.query.sort[0].property, 'title');
});

test('parses and de-duplicates roadmap products from Notion collection data', () => {
  const collectionData = {
    result: {
      reducerResults: {
        collection_group_results: {
          blockIds: ['a', 'b', 'dup', 'empty']
        }
      }
    },
    recordMap: {
      block: {
        a: wrapped({ properties: { title: text('SWG Classic Red') } }),
        b: wrapped({ properties: { title: text('SWG Classic Blue') } }),
        dup: wrapped({ properties: { title: text('SWG Classic Red') } }),
        empty: wrapped({ properties: { title: text('') } })
      }
    }
  };

  assert.deepEqual(parseSwagkeysRoadmapCollectionApi(collectionData), [
    'SWG Classic Red',
    'SWG Classic Blue'
  ]);
});

test('Notion API retry delay respects Retry-After and uses longer 429 backoff', () => {
  assert.equal(notionRetryDelayMs(429, '12', 1, 0), 12000);
  assert.equal(notionRetryDelayMs(429, '', 1, 0), 10000);
  assert.equal(notionRetryDelayMs(429, '', 2, 0), 20000);
  assert.equal(notionRetryDelayMs(500, '', 2, 0), 3000);

  const now = Date.parse('2026-09-29T00:00:00Z');
  assert.equal(
    notionRetryDelayMs(429, 'Tue, 29 Sep 2026 00:00:25 GMT', 1, now),
    25000
  );
});
