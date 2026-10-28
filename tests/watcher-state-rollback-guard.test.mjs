import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const fastPath = fileURLToPath(new URL('../.github/workflows/keyboard-alert-fast.yml', import.meta.url));
const slowPath = fileURLToPath(new URL('../.github/workflows/keyboard-alert-slow.yml', import.meta.url));
const watchdogPath = fileURLToPath(new URL('../.github/workflows/keyboard-alert-watchdog.yml', import.meta.url));

const fast = fs.readFileSync(fastPath, 'utf8');
const slow = fs.readFileSync(slowPath, 'utf8');
const watchdog = fs.readFileSync(watchdogPath, 'utf8');

test('Fast never runs DCInside or persists state after install/restore failure', () => {
  assert.match(fast, /name: Install dependencies\n        id: install/);
  assert.match(fast, /name: Restore watcher state\n        id: restore_state/);

  const guard = /always\(\) && steps\.install\.outcome == 'success' && steps\.restore_state\.outcome == 'success'/;
  const dcBlock = fast.slice(fast.indexOf('name: Check DCInside tteotnya posts'), fast.indexOf('name: Persist fast watcher state'));
  const persistBlock = fast.slice(fast.indexOf('name: Persist fast watcher state'), fast.indexOf('name: Signal fast heartbeat success'));

  assert.match(dcBlock, guard);
  assert.match(persistBlock, guard);
});

test('Fast restore removes stale checked-in state and snapshots a baseline', () => {
  const restoreBlock = fast.slice(fast.indexOf('name: Restore watcher state'), fast.indexOf('name: Check Guheyo keycap listings'));

  assert.match(restoreBlock, /baseline_dir=/);
  assert.match(restoreBlock, /cp "\$file" "\$baseline_dir\/\$file"/);
  assert.match(restoreBlock, /rm -f "\$file"/);
  assert.match(restoreBlock, /touch "\$baseline_dir\/\$file\.missing"/);
});

test('Fast persistence refuses to overwrite a remote file changed after restore', () => {
  const persistBlock = fast.slice(fast.indexOf('name: Persist fast watcher state'), fast.indexOf('name: Signal fast heartbeat success'));

  assert.match(persistBlock, /cmp -s "\$file" "\$baseline"/);
  assert.match(persistBlock, /cmp -s "\$baseline" <\(git show "origin\/watcher-state:\$file"\)/);
  assert.match(persistBlock, /refusing stale overwrite/);
  assert.doesNotMatch(persistBlock, /git diff --quiet origin\/watcher-state -- "\$file"/);
});

test('Slow always-steps require install, restore, and regression success', () => {
  assert.match(slow, /name: Install dependencies\n        id: install/);
  assert.match(slow, /name: Restore watcher state\n        id: restore_state/);
  assert.match(slow, /name: Run regression tests\n        id: regression/);

  const guarded = "always() && steps.install.outcome == 'success' && steps.restore_state.outcome == 'success' && steps.regression.outcome == 'success'";
  const count = slow.split(guarded).length - 1;

  // 9 source checks after GEONWORKS GB + persistence.
  assert.equal(count, 10);
  assert.match(slow, /Remote watcher state changed \$file after restore; refusing stale overwrite/);
});

test('Watchdog persistence also requires a restored baseline and rejects stale overwrite', () => {
  assert.match(watchdog, /name: Install dependencies\n        id: install/);
  assert.match(watchdog, /name: Restore watchdog state\n        id: restore_state/);
  assert.match(
    watchdog,
    /name: Persist watchdog state\n        if: \$\{\{ always\(\) && steps\.install\.outcome == 'success' && steps\.restore_state\.outcome == 'success' \}\}/
  );
  assert.match(watchdog, /Remote watchdog state changed after restore; refusing stale overwrite/);
});
