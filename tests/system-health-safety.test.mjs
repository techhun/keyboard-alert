import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptPath = fileURLToPath(new URL('../scripts/system-health.mjs', import.meta.url));

function runTransition(initialSource, status, fallbackSince = {
  roadmap: new Date(Date.now() - 30 * 60 * 1000).toISOString()
}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyboard-health-'));
  const statePath = path.join(dir, 'system-health-slow.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    initialized: true,
    updatedAt: '2026-09-28T00:00:00.000Z',
    sources: { swagkeys: initialSource }
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'swagkeys-state.json'), JSON.stringify({
    version: 1,
    initialized: true,
    fallbackSince
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
  assert.equal(source.status, 'fail');
  assert.equal(source.consecutiveFailures, 3);
  assert.equal(source.mode, 'degraded');
  assert.deepEqual(source.fallbackSources, ['roadmap']);
  assert.ok(source.degradedSince);
  assert.match(stdout, /degraded fallback; health status preserved as fail/);
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
  assert.equal(source.status, 'ok');
  assert.equal(source.consecutiveFailures, 2);
  assert.equal(source.mode, 'degraded');
  assert.deepEqual(source.fallbackSources, ['roadmap']);
});

test('degraded state records all fallback sources and keeps warning pending without webhook', () => {
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const initial = {
    status: 'ok',
    changedAt: '2026-09-27T00:00:00.000Z'
  };

  const { source, stdout } = runTransition(initial, 'degraded', {
    roadmap: old,
    status: new Date(Date.now() - 90 * 60 * 1000).toISOString()
  });

  assert.equal(source.mode, 'degraded');
  assert.deepEqual(source.fallbackSources, ['roadmap', 'status']);
  assert.equal(source.degradedSince, old);
  assert.equal(source.degradedAlertedAt, undefined);
  assert.match(stdout, /degraded warning remains pending/);
});

test('fresh ok clears degraded metadata without touching normal status', () => {
  const initial = {
    status: 'ok',
    changedAt: '2026-09-27T00:00:00.000Z',
    mode: 'degraded',
    degradedSince: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    fallbackSources: ['roadmap', 'status'],
    consecutiveFailures: 2,
    lastFailureRunId: '12222',
    lastFailureAt: new Date(Date.now() - 5 * 60 * 1000).toISOString()
  };

  const { source, stdout } = runTransition(initial, 'ok', {});
  assert.deepEqual(source, {
    status: 'ok',
    changedAt: '2026-09-27T00:00:00.000Z'
  });
  assert.match(stdout, /degraded -> ok/);
});
