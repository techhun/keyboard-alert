import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const slow = fs.readFileSync('.github/workflows/keyboard-alert-slow.yml', 'utf8');
const geon = fs.readFileSync('scripts/check-geonworks.mjs', 'utf8');
const swag = fs.readFileSync('scripts/check-swagkeys.mjs', 'utf8');

test('slow workflow restores and persists keepodd-events.json', () => {
  const matches = slow.match(/keepodd-events\.json/g) || [];
  assert.ok(matches.length >= 2, 'keepodd-events.json must appear in both restore and persist state lists');
  const restore = slow.slice(slow.indexOf('- name: Restore watcher state'), slow.indexOf('- name: Run regression tests'));
  const persist = slow.slice(slow.indexOf('- name: Persist slow watcher state'), slow.indexOf('- name: Signal slow heartbeat success'));
  assert.match(restore, /keepodd-events\.json/);
  assert.match(persist, /keepodd-events\.json/);
});

test('GEONWORKS only advances Keepodd feed after the pending-webhook guard', () => {
  const guard = geon.indexOf('Changes remain pending; state was not updated.');
  const firstAdvance = geon.indexOf('await advanceStateWithKeepoddEvents');
  assert.ok(guard >= 0);
  assert.ok(firstAdvance > guard);
  assert.match(geon, /Baseline initialization: storing .* without notifying/);
});

test('SWAGKEYS only advances Keepodd feed after the pending-webhook guard', () => {
  const guard = swag.indexOf('Changes remain pending; state was not updated.');
  const firstAdvance = swag.indexOf('await advanceStateWithKeepoddEvents');
  assert.ok(guard >= 0);
  assert.ok(firstAdvance > guard);
  assert.match(swag, /Baseline initialization: storing .* without notifying/);
});

test('slow persist compares watcher-state-only files by content before committing', () => {
  const persist = slow.slice(slow.indexOf('- name: Persist slow watcher state'), slow.indexOf('- name: Signal slow heartbeat success'));
  assert.match(persist, /git cat-file -e "origin\/watcher-state:\$file"/);
  assert.match(persist, /cmp -s "\$file" <\(git show "origin\/watcher-state:\$file"\)/);
  assert.match(persist, /Slow watcher state unchanged\./);
});

test('fallback and verification paths retain their existing state-preservation guards', () => {
  assert.match(swag, /using bounded stored fallback/i);
  assert.match(swag, /removal verification was inconclusive/i);
  assert.match(geon, /change set changed during verification\. State was not updated/);
  assert.match(geon, /State was not updated/);
});
