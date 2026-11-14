import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  notificationMode,
  parseSkipDiscord,
  skipDiscordSummaryLine
} from '../scripts/check-swagkeys.mjs';

const swag = fs.readFileSync('scripts/check-swagkeys.mjs', 'utf8');

test('SWAGKEYS_SKIP_DISCORD accepts only true/1 and keeps the flag off by default', () => {
  for (const value of ['true', 'TRUE', ' True ', '1', ' 1 ']) {
    assert.equal(parseSkipDiscord(value), true, value);
  }
  for (const value of ['', ' ', 'false', '0', 'yes', 'on', undefined, null]) {
    assert.equal(parseSkipDiscord(value), false, String(value));
  }
});

test('notification mode keeps the pending guard when no webhook is set and skip mode is off', () => {
  assert.equal(notificationMode({ webhookUrl: '', skipDiscord: false }), 'pending');
  assert.equal(notificationMode({ webhookUrl: '   ', skipDiscord: false }), 'pending');
  assert.equal(notificationMode({ webhookUrl: 'https://discord.com/api/webhooks/x', skipDiscord: false }), 'discord');
  assert.equal(notificationMode({ webhookUrl: '', skipDiscord: true }), 'skip');
  assert.equal(notificationMode({ webhookUrl: 'https://discord.com/api/webhooks/x', skipDiscord: true }), 'skip');
});

test('skip-mode summary is one parseable SWAGKEYS_SUMMARY_JSON line with the Pickle payload', () => {
  const quarterChanges = {
    moved: [{ product: 'SWG Nightshift', before: 'Q4', after: 'Q1' }],
    added: [{ product: 'SWG Moomin', quarter: 'Q2' }],
    removed: [],
    datesChanged: []
  };
  const changes = [{
    kind: 'changed',
    row: { product: 'Classic Red', inProduction: 66.7 },
    before: { product: 'Classic Red', inProduction: 33.3 },
    fields: [{ key: 'inProduction', label: '생산중 진행률', type: 'percent', before: 33.3, after: 66.7 }]
  }];
  const starts = [{ key: 'nightshift', product: 'SWG Nightshift', saleStart: '2026-11-14', saleEnd: '2026-11-28' }];
  const announcement = { heading: '업데이트(26.11.14)', content: '로드맵이 갱신되었습니다.' };

  const line = skipDiscordSummaryLine({
    announcementChanged: true,
    quarterChanges,
    changes,
    starts,
    announcement
  });
  assert.equal(line.split('\n').length, 1);
  assert.ok(line.startsWith('SWAGKEYS_SUMMARY_JSON='));

  const payload = JSON.parse(line.slice('SWAGKEYS_SUMMARY_JSON='.length));
  assert.deepEqual(Object.keys(payload), ['announcementChanged', 'quarterChanges', 'changes', 'starts', 'announcement']);
  assert.equal(payload.announcementChanged, true);
  assert.deepEqual(payload.quarterChanges, quarterChanges);
  assert.deepEqual(payload.changes, changes);
  assert.deepEqual(payload.starts, starts);
  assert.deepEqual(payload.announcement, announcement);

  const withoutAnnouncement = JSON.parse(skipDiscordSummaryLine({
    announcementChanged: false,
    quarterChanges,
    changes,
    starts,
    announcement
  }).slice('SWAGKEYS_SUMMARY_JSON='.length));
  assert.equal(withoutAnnouncement.announcement, null);
});

test('skip mode still commits state and Keepodd events before printing the summary', () => {
  const guard = swag.indexOf('Changes remain pending; state was not updated.');
  const advance = swag.indexOf('await advanceStateWithKeepoddEvents(snapshot, quarterChanges, changes, starts);');
  const summary = swag.indexOf('console.log(skipDiscordSummaryLine(');
  assert.ok(guard >= 0 && advance > guard, 'pending guard must stay ahead of the commit path');
  assert.ok(summary > advance, 'summary is printed only after state/Keepodd commit');

  const discordBranch = swag.slice(swag.indexOf("if (mode === 'discord') {"), advance);
  assert.ok(discordBranch.length > 0, 'Discord embeds are sent on their own branch');
  const totalPosts = (swag.match(/await postDiscord\(/g) || []).length;
  const branchPosts = (discordBranch.match(/await postDiscord\(/g) || []).length;
  assert.ok(totalPosts > 0);
  assert.equal(branchPosts, totalPosts, 'every postDiscord call stays inside the Discord branch');
});

test('fetchSnapshot launches Chromium only for the browser fallback', () => {
  assert.doesNotMatch(swag, /const browser = await chromium\.launch/);
  assert.match(swag, /let browser = null;/);
  assert.match(swag, /if \(context\) await context\.close\(\);/);
  assert.match(swag, /if \(browser\) await browser\.close\(\);/);
  assert.match(swag, /candidate = await openWithRetry\(await browserContext\(\), ROADMAP_URL/);
  assert.match(swag, /candidateRows = await openWithRetry\(await browserContext\(\), STATUS_URL/);
  assert.equal(
    (swag.match(/await browserContext\(\)/g) || []).length,
    2,
    'Chromium is requested only by the two browser fallback call sites'
  );
});

