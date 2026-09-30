import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateTarget, summarizeRuns } from '../scripts/check-workflow-watchdog.mjs';

const target = {
  maxDispatchAgeMinutes: 5,
  maxSuccessAgeMinutes: 10
};
const now = Date.parse('2026-10-01T00:00:00.000Z');

test('watchdog is healthy when dispatch and success are recent', () => {
  const summary = summarizeRuns([
    {
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-09-30T23:57:00.000Z',
      updated_at: '2026-09-30T23:58:00.000Z',
      html_url: 'https://example.test/success'
    }
  ]);

  const result = evaluateTarget(summary, target, now);
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.reasons, []);
});

test('cancelled queued runs do not hide a recent successful run', () => {
  const summary = summarizeRuns([
    {
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'cancelled',
      created_at: '2026-09-30T23:59:00.000Z',
      updated_at: '2026-09-30T23:59:30.000Z',
      html_url: 'https://example.test/cancelled'
    },
    {
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-09-30T23:55:00.000Z',
      updated_at: '2026-09-30T23:56:00.000Z',
      html_url: 'https://example.test/success'
    }
  ]);

  const result = evaluateTarget(summary, target, now);
  assert.equal(summary.latestDispatchAt, '2026-09-30T23:59:00.000Z');
  assert.equal(summary.latestSuccessAt, '2026-09-30T23:56:00.000Z');
  assert.equal(result.status, 'ok');
});

test('watchdog fails when successful execution is stale even if dispatches continue', () => {
  const summary = summarizeRuns([
    {
      event: 'workflow_dispatch',
      status: 'in_progress',
      conclusion: null,
      created_at: '2026-09-30T23:59:00.000Z',
      updated_at: '2026-09-30T23:59:30.000Z'
    },
    {
      event: 'workflow_dispatch',
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-09-30T23:45:00.000Z',
      updated_at: '2026-09-30T23:46:00.000Z'
    }
  ]);

  const result = evaluateTarget(summary, target, now);
  assert.equal(result.status, 'fail');
  assert.match(result.reasons.join(' '), /최근 성공 실행이 14분 전/);
});

test('watchdog fails cleanly when no workflow_dispatch history exists', () => {
  const summary = summarizeRuns([
    {
      event: 'push',
      status: 'completed',
      conclusion: 'success',
      created_at: '2026-09-30T23:59:00.000Z',
      updated_at: '2026-09-30T23:59:20.000Z'
    }
  ]);

  const result = evaluateTarget(summary, target, now);
  assert.equal(result.status, 'fail');
  assert.match(result.reasons[0], /workflow_dispatch 실행 기록/);
  assert.match(result.reasons[1], /성공한 workflow_dispatch 실행 기록/);
});
