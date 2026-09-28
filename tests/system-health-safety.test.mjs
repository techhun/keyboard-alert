import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptPath = fileURLToPath(new URL('../scripts/system-health.mjs', import.meta.url));

function runTransition(initialSource, status) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyboard-health-'));
  const statePath = path.join(dir, 'system-health-slow.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    initialized: true,
    updatedAt: '2026-09-28T00:00:00.000Z',
    sources: { swagkeys: initialSource }
  }, null, 2));

  const result = spawnSync(process.execPath, [
    scriptPath,
    'transition',
    'slow',
    'swagkeys',
    status,
    'SWAGKEYS',
    'test'
  ], {
    cwd: dir,
    env: {
      ...process.env,
      SYSTEM_DISCORD_WEBHOOK_URL: '',
      GITHUB_RUN_ID: '12345'
    },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return { source: state.sources.swagkeys, stdout: result.stdout };
}

test('degraded fallback does not falsely recover a failed source', () => {
  const initial = {
    status: 'fail',
    changedAt: '2026-09-27T00:00:00.000Z',
    consecutiveFailures: 3,
    lastFailureRunId: '12222',
    lastFailureAt: '2026-09-27T00:00:00.000Z'
  };

  const { source, stdout } = runTransition(initial, 'degraded');
  assert.deepEqual(source, initial);
  assert.match(stdout, /degraded fallback; health state unchanged/);
});

test('degraded fallback does not clear pending transient failures', () => {
  const initial = {
    status: 'ok',
    changedAt: '2026-09-27T00:00:00.000Z',
    consecutiveFailures: 2,
    lastFailureRunId: '12222',
    lastFailureAt: '2026-09-27T00:00:00.000Z'
  };

  const { source } = runTransition(initial, 'degraded');
  assert.deepEqual(source, initial);
});
