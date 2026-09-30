import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const STATE_PATH = 'workflow-watchdog-state.json';
const DISCORD_WEBHOOK_URL = (process.env.SYSTEM_DISCORD_WEBHOOK_URL || '').trim();
const GITHUB_TOKEN = (process.env.WATCHDOG_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '').trim();
const REPOSITORY = (process.env.GITHUB_REPOSITORY || '').trim();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const TARGETS = {
  fast: {
    label: 'Fast',
    workflow: 'keyboard-alert-fast.yml',
    maxDispatchAgeMinutes: 5,
    maxSuccessAgeMinutes: 10
  },
  slow: {
    label: 'Slow',
    workflow: 'keyboard-alert-slow.yml',
    maxDispatchAgeMinutes: 25,
    maxSuccessAgeMinutes: 35
  }
};

function validTime(value) {
  const time = Date.parse(value || '');
  return Number.isFinite(time) ? time : null;
}

function newest(runs, selector) {
  return [...runs]
    .filter(selector)
    .sort((a, b) => {
      const aTime = validTime(a.updated_at) ?? validTime(a.created_at) ?? 0;
      const bTime = validTime(b.updated_at) ?? validTime(b.created_at) ?? 0;
      return bTime - aTime;
    })[0] || null;
}

export function summarizeRuns(runs) {
  const dispatchRuns = (Array.isArray(runs) ? runs : [])
    .filter((run) => run?.event === 'workflow_dispatch');

  const latestDispatch = newest(dispatchRuns, () => true);
  const latestSuccess = newest(
    dispatchRuns,
    (run) => run?.status === 'completed' && run?.conclusion === 'success'
  );

  return {
    latestDispatchAt: latestDispatch?.created_at || null,
    latestSuccessAt: latestSuccess?.updated_at || latestSuccess?.created_at || null,
    latestDispatchUrl: latestDispatch?.html_url || null,
    latestSuccessUrl: latestSuccess?.html_url || null
  };
}

function ageMinutes(value, nowMs) {
  const time = validTime(value);
  if (time === null) return Infinity;
  return Math.max(0, (nowMs - time) / 60000);
}

export function evaluateTarget(summary, target, nowMs = Date.now()) {
  const dispatchAgeMinutes = ageMinutes(summary?.latestDispatchAt, nowMs);
  const successAgeMinutes = ageMinutes(summary?.latestSuccessAt, nowMs);
  const reasons = [];

  if (dispatchAgeMinutes > target.maxDispatchAgeMinutes) {
    reasons.push(summary?.latestDispatchAt
      ? `최근 workflow_dispatch가 ${Math.floor(dispatchAgeMinutes)}분 전입니다.`
      : 'workflow_dispatch 실행 기록을 찾지 못했습니다.');
  }

  if (successAgeMinutes > target.maxSuccessAgeMinutes) {
    reasons.push(summary?.latestSuccessAt
      ? `최근 성공 실행이 ${Math.floor(successAgeMinutes)}분 전입니다.`
      : '성공한 workflow_dispatch 실행 기록을 찾지 못했습니다.');
  }

  return {
    status: reasons.length ? 'fail' : 'ok',
    reasons,
    dispatchAgeMinutes,
    successAgeMinutes
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      return {
        version: 1,
        initialized: true,
        updatedAt: parsed.updatedAt || null,
        targets: parsed.targets && typeof parsed.targets === 'object' ? parsed.targets : {}
      };
    }
  } catch {}

  return { version: 1, initialized: true, updatedAt: null, targets: {} };
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    version: 1,
    initialized: true,
    updatedAt: new Date().toISOString(),
    targets: state.targets || {}
  }, null, 2) + '\n');
}

function currentRunUrl() {
  const runId = String(process.env.GITHUB_RUN_ID || '').trim();
  return REPOSITORY && runId ? `https://github.com/${REPOSITORY}/actions/runs/${runId}` : '';
}

async function postDiscord(embed) {
  if (!DISCORD_WEBHOOK_URL) return false;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Keyboard Alert · System',
        allowed_mentions: { parse: [] },
        embeds: [embed]
      })
    });

    if (response.ok) return true;

    if (response.status === 429 && attempt < 3) {
      let retryAfter = 1;
      try {
        retryAfter = Number((await response.json())?.retry_after) || 1;
      } catch {}
      await sleep(Math.ceil(retryAfter * 1000));
      continue;
    }

    throw new Error(`System Discord webhook failed: ${response.status} ${await response.text()}`);
  }

  return false;
}

async function fetchWorkflowRuns(target) {
  if (!GITHUB_TOKEN) throw new Error('WATCHDOG_GITHUB_TOKEN/GITHUB_TOKEN is not configured.');
  if (!REPOSITORY) throw new Error('GITHUB_REPOSITORY is not configured.');

  const url = `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${encodeURIComponent(target.workflow)}/runs?per_page=30`;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'keyboard-alert-workflow-watchdog'
      }
    });

    if (response.ok) {
      const body = await response.json();
      return Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
    }

    const retryable = response.status === 429 || response.status >= 500;
    if (retryable && attempt < 3) {
      await sleep(attempt * 1500);
      continue;
    }

    throw new Error(`GitHub workflow runs API failed: ${response.status} ${await response.text()}`);
  }

  return [];
}

function displayTime(value) {
  return value ? new Date(value).toISOString() : '없음';
}

async function transition(state, key, target, summary, evaluation) {
  const previous = state.targets[key] || {};
  const now = new Date().toISOString();
  const runUrl = currentRunUrl();

  if (evaluation.status === 'fail') {
    if (previous.status === 'fail') {
      console.log(`[watchdog] ${target.label}: unchanged (fail)`);
      return;
    }

    if (!DISCORD_WEBHOOK_URL) {
      console.log(`[watchdog] SYSTEM_DISCORD_WEBHOOK_URL is not configured. ${target.label} alert remains pending.`);
      return;
    }

    await postDiscord({
      title: `🚨 실행 감시 오류 · ${target.label}`,
      ...(runUrl ? { url: runUrl } : {}),
      description: evaluation.reasons.join('\n'),
      fields: [
        { name: '최근 호출', value: displayTime(summary.latestDispatchAt), inline: false },
        { name: '최근 성공', value: displayTime(summary.latestSuccessAt), inline: false },
        {
          name: '판정 기준',
          value: `호출 ${target.maxDispatchAgeMinutes}분 / 성공 ${target.maxSuccessAgeMinutes}분`,
          inline: false
        }
      ],
      footer: { text: 'keyboard-alert · workflow watchdog' },
      timestamp: now
    });

    state.targets[key] = {
      status: 'fail',
      changedAt: now,
      reasons: evaluation.reasons,
      lastDispatchAt: summary.latestDispatchAt,
      lastSuccessAt: summary.latestSuccessAt
    };
    saveState(state);
    console.log(`[watchdog] ${target.label}: ${previous.status || 'unknown'} -> fail`);
    return;
  }

  if (previous.status === 'fail') {
    if (!DISCORD_WEBHOOK_URL) {
      console.log(`[watchdog] SYSTEM_DISCORD_WEBHOOK_URL is not configured. ${target.label} recovery remains pending.`);
      return;
    }

    await postDiscord({
      title: `✅ 실행 감시 복구 · ${target.label}`,
      ...(runUrl ? { url: runUrl } : {}),
      description: '최근 workflow_dispatch와 성공 실행이 다시 정상 범위 안에서 확인되었습니다.',
      fields: [
        { name: '최근 호출', value: displayTime(summary.latestDispatchAt), inline: false },
        { name: '최근 성공', value: displayTime(summary.latestSuccessAt), inline: false }
      ],
      footer: { text: 'keyboard-alert · workflow watchdog' },
      timestamp: now
    });

    state.targets[key] = { status: 'ok', changedAt: now };
    saveState(state);
    console.log(`[watchdog] ${target.label}: fail -> ok`);
    return;
  }

  if (!previous.status) {
    state.targets[key] = { status: 'ok', changedAt: now };
    saveState(state);
    console.log(`[watchdog] ${target.label}: unknown -> ok`);
    return;
  }

  console.log(`[watchdog] ${target.label}: unchanged (ok)`);
}

async function main() {
  const state = loadState();

  for (const [key, target] of Object.entries(TARGETS)) {
    const runs = await fetchWorkflowRuns(target);
    const summary = summarizeRuns(runs);
    const evaluation = evaluateTarget(summary, target);

    console.log(`[watchdog] ${target.label}: dispatch=${summary.latestDispatchAt || 'none'}, success=${summary.latestSuccessAt || 'none'}, status=${evaluation.status}`);
    await transition(state, key, target, summary, evaluation);
  }
}

const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  await main();
}
