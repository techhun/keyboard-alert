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
}, sourceKey = 'swagkeys', extraEnv = {}, scheduleFallbackSince = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'keyboard-health-'));
  const statePath = path.join(dir, 'system-health-slow.json');
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1,
    initialized: true,
    updatedAt: '2026-09-28T00:00:00.000Z',
    sources: { [sourceKey]: initialSource }
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'swagkeys-state.json'), JSON.stringify({
    version: 1,
    initialized: true,
    fallbackSince,
    schedule: { fallbackSince: scheduleFallbackSince }
  }, null, 2));

  const result = spawnSync(process.execPath, [
    scriptPath,
    'transition',
    'slow',
    sourceKey,
    status,
    sourceKey === 'swagkeys' ? 'SWAGKEYS' : 'GEONWORKS',
    'test'
  ], {
    cwd: dir,
    env: {
      ...process.env,
      SYSTEM_DISCORD_WEBHOOK_URL: '',
      GITHUB_RUN_ID: '12345',
      ...extraEnv
    },
    encoding: 'utf8'
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  fs.rmSync(dir, { recursive: true, force: true });
  return { source: state.sources[sourceKey], stdout: result.stdout };
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
  assert.match(stdout, /degraded warning not sent to Discord \(Pickle reports this source\)/);
});

test('a non-Pickle source still reports a missing webhook as pending', () => {
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { source, stdout } = runTransition(
    {
      status: 'ok',
      changedAt: '2026-09-27T00:00:00.000Z',
      mode: 'degraded',
      degradedSince: old,
      fallbackSources: ['products']
    },
    'degraded',
    { roadmap: old },
    'geonworks-gb'
  );

  assert.equal(source.mode, 'degraded');
  assert.equal(source.degradedAlertedAt, undefined);
  assert.match(stdout, /degraded warning remains pending/);
});

test('SWAGKEYS alerts never reach Discord even when a webhook is configured', () => {
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  // If this transition tried to post, the unreachable webhook URL would throw and fail the run.
  const { source, stdout } = runTransition(
    { status: 'ok', changedAt: '2026-09-27T00:00:00.000Z' },
    'degraded',
    { roadmap: old },
    'swagkeys',
    { SYSTEM_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/pickle-owned-test' }
  );

  assert.equal(source.mode, 'degraded');
  assert.equal(source.degradedAlertedAt, undefined);
  assert.match(stdout, /degraded warning not sent to Discord \(Pickle reports this source\)/);
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


test('persistent failure becomes reminder-due after 12 hours without changing source status', () => {
  const old = new Date(Date.now() - 13 * 60 * 60 * 1000).toISOString();
  const initial = {
    status: 'fail',
    changedAt: old,
    consecutiveFailures: 3,
    lastFailureRunId: '12222',
    lastFailureAt: old,
    failureAlertedAt: old
  };

  const { source, stdout } = runTransition(initial, 'fail', {});
  assert.equal(source.status, 'fail');
  assert.equal(source.consecutiveFailures, 3);
  assert.equal(source.failureReminderAt, undefined);
  assert.match(stdout, /persistent failure reminder not sent to Discord \(Pickle reports this source\)/);
});

test('recent persistent failure stays quiet before the 12 hour reminder window', () => {
  const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const initial = {
    status: 'fail',
    changedAt: recent,
    consecutiveFailures: 3,
    lastFailureRunId: '12222',
    lastFailureAt: recent,
    failureAlertedAt: recent
  };

  const { source, stdout } = runTransition(initial, 'fail', {});
  assert.equal(source.status, 'fail');
  assert.match(stdout, /unchanged \(fail\)/);
  assert.doesNotMatch(stdout, /persistent failure reminder/);
});

test('successful checker with a reservation or stock fallback is classified degraded', () => {
  const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  for (const key of ['reservations', 'instock']) {
    const { source, stdout } = runTransition({ status: 'ok', consecutiveFailures: 2 }, 'ok',
      {}, 'swagkeys', {}, { [key]: since });
    assert.equal(source.mode, 'degraded');
    assert.deepEqual(source.fallbackSources, [key]);
    assert.equal(source.degradedSince, since);
    assert.equal(source.consecutiveFailures, 2);
    assert.match(stdout, /degraded fallback; health status preserved as ok/);
  }
});

test('all four fallback sources are recorded and oldest active clock wins', () => {
  const now = Date.now();
  const times = [120, 90, 60, 30].map(minutes => new Date(now - minutes * 60000).toISOString());
  const { source } = runTransition({ status: 'ok', mode: 'degraded', degradedSince: times[3] }, 'ok',
    { roadmap: times[2], status: times[1] }, 'swagkeys', {},
    { reservations: times[0], instock: times[3] });
  assert.deepEqual(source.fallbackSources, ['reservations', 'status', 'roadmap', 'instock']);
  assert.equal(source.degradedSince, times[0]);
});

test('partial recovery cannot clear an existing failure or degraded mode', () => {
  const since = new Date(Date.now() - 20 * 60000).toISOString();
  const { source, stdout } = runTransition({
    status: 'fail', consecutiveFailures: 3, mode: 'degraded',
    degradedSince: new Date(Date.now() - 90 * 60000).toISOString(),
    fallbackSources: ['roadmap', 'instock']
  }, 'ok', {}, 'swagkeys', {}, { instock: since });
  assert.equal(source.status, 'fail');
  assert.equal(source.consecutiveFailures, 3);
  assert.equal(source.mode, 'degraded');
  assert.deepEqual(source.fallbackSources, ['instock']);
  assert.equal(source.degradedSince, since);
  assert.doesNotMatch(stdout, /fail -> ok/);
});

test('recovery clears schedule-only fallback once both maps are empty', () => {
  const { source } = runTransition({
    status: 'ok', mode: 'degraded',
    degradedSince: new Date(Date.now() - 30 * 60000).toISOString(),
    fallbackSources: ['reservations']
  }, 'ok', {}, 'swagkeys', {}, {});
  assert.deepEqual(source, { status: 'ok' });
});

test('invalid fallback clock does not cause false recovery', () => {
  const { source } = runTransition({ status: 'ok' }, 'ok', {},
    'swagkeys', {}, { reservations: 'invalid' });
  assert.equal(source.mode, 'degraded');
  assert.deepEqual(source.fallbackSources, ['reservations']);
  assert.ok(Number.isFinite(Date.parse(source.degradedSince)));
});

test('hard failure is not downgraded to degraded even when schedule uses fallback', () => {
  const { source } = runTransition({ status: 'ok' }, 'fail', {},
    'swagkeys', {}, { reservations: new Date().toISOString() });
  assert.equal(source.consecutiveFailures, 1);
  assert.equal(source.mode, undefined);
});

test('schedule-only degraded alerts preserve Pickle-only routing', () => {
  const since = new Date(Date.now() - 2 * 60 * 60000).toISOString();
  const { source, stdout } = runTransition({ status: 'ok' }, 'ok', {},
    'swagkeys', { SYSTEM_DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/pickle-owned-test' },
    { instock: since });
  assert.equal(source.mode, 'degraded');
  assert.equal(source.degradedAlertedAt, undefined);
  assert.match(stdout, /degraded warning not sent to Discord \(Pickle reports this source\)/);
});
