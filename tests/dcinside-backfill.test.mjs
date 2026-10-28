import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../scripts/replay-dcinside.mjs', import.meta.url), 'utf8');
const workflow = fs.readFileSync(new URL('../.github/workflows/keyboard-alert-fast.yml', import.meta.url), 'utf8');

test('DCInside missed-alert backfill is bounded to explicit post numbers and checkpoints each send', () => {
  assert.match(source, /targetNos/);
  assert.match(source, /sentNos/);
  assert.match(source, /targetNos\.every/);
  assert.match(source, /could not resolve/);
  assert.match(source, /saveState\([\s\S]*sentNos/);
  assert.match(source, /completed: true/);
});

test('Fast workflow restores and persists the temporary DCInside backfill state', () => {
  assert.match(workflow, /dcinside-backfill-state\.json/);
  const replay = workflow.indexOf('name: Backfill missed DCInside tteotnya posts');
  const normal = workflow.indexOf('name: Check DCInside tteotnya posts');
  assert.ok(replay >= 0 && normal > replay);
  assert.match(workflow.slice(replay, normal), /DCINSIDE_DISCORD_WEBHOOK_URL/);
});
