import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildPingUrl, sendHeartbeat } from '../scripts/healthchecks-ping.mjs';

const fastWorkflowPath = fileURLToPath(new URL('../.github/workflows/keyboard-alert-fast.yml', import.meta.url));
const slowWorkflowPath = fileURLToPath(new URL('../.github/workflows/keyboard-alert-slow.yml', import.meta.url));

test('healthchecks heartbeat builds start, success, and fail URLs', () => {
  const base = 'https://hc-ping.com/11111111-2222-3333-4444-555555555555/';

  assert.equal(
    buildPingUrl(base, 'start'),
    'https://hc-ping.com/11111111-2222-3333-4444-555555555555/start'
  );
  assert.equal(
    buildPingUrl(base, 'success'),
    'https://hc-ping.com/11111111-2222-3333-4444-555555555555/'
  );
  assert.equal(
    buildPingUrl(base, 'fail'),
    'https://hc-ping.com/11111111-2222-3333-4444-555555555555/fail'
  );
});

test('healthchecks heartbeat skips cleanly when URL is not configured', async () => {
  let calls = 0;
  const result = await sendHeartbeat('', 'success', {
    fetchImpl: async () => {
      calls += 1;
      return { ok: true };
    }
  });

  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  assert.equal(calls, 0);
});

test('healthchecks heartbeat retries without throwing into the monitored workflow', async () => {
  let calls = 0;
  const result = await sendHeartbeat('https://hc-ping.com/example', 'success', {
    attempts: 3,
    retryDelayMs: 0,
    timeoutMs: 100,
    fetchImpl: async () => {
      calls += 1;
      return { ok: false, status: 503 };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(result.skipped, false);
  assert.equal(result.attempts, 3);
  assert.equal(calls, 3);
});

test('healthchecks heartbeat rejects unsupported signal names', () => {
  assert.throws(() => buildPingUrl('https://hc-ping.com/example', 'unknown'), /Unknown heartbeat signal/);
});

test('Fast workflow emits start, success, and failure heartbeat signals', () => {
  const workflow = fs.readFileSync(fastWorkflowPath, 'utf8');

  assert.match(workflow, /HEALTHCHECKS_FAST_URL/);
  assert.match(workflow, /healthchecks-ping\.mjs start/);
  assert.match(workflow, /healthchecks-ping\.mjs success/);
  assert.match(workflow, /healthchecks-ping\.mjs fail/);
  assert.match(workflow, /Signal fast heartbeat success\n        if: success\(\)/);
  assert.match(workflow, /Signal fast heartbeat failure\n        if: failure\(\)/);
});

test('Slow workflow emits start, success, and failure heartbeat signals', () => {
  const workflow = fs.readFileSync(slowWorkflowPath, 'utf8');

  assert.match(workflow, /HEALTHCHECKS_SLOW_URL/);
  assert.match(workflow, /healthchecks-ping\.mjs start/);
  assert.match(workflow, /healthchecks-ping\.mjs success/);
  assert.match(workflow, /healthchecks-ping\.mjs fail/);
  assert.match(workflow, /Signal slow heartbeat success\n        if: success\(\)/);
  assert.match(workflow, /Signal slow heartbeat failure\n        if: failure\(\)/);
});
