import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const workflowPath = fileURLToPath(new URL('../.github/workflows/keyboard-alert-watchdog.yml', import.meta.url));

test('watchdog state persistence skips empty commits after staging', () => {
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  const stagedGuard = 'git -C "$state_dir" diff --cached --quiet -- workflow-watchdog-state.json';
  const commit = "git -C \"$state_dir\" commit -m 'Update workflow watchdog state'";

  assert.match(workflow, /diff --cached --quiet -- workflow-watchdog-state\.json/);
  assert.ok(workflow.indexOf(stagedGuard) < workflow.indexOf(commit), 'staged diff guard must run before commit');
  assert.doesNotMatch(workflow, /git diff --quiet origin\/watcher-state -- workflow-watchdog-state\.json/);
  assert.match(workflow, /Watchdog state unchanged\./);
});
