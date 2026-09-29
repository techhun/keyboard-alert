import fs from 'node:fs';

const DISCORD_WEBHOOK_URL = (process.env.SYSTEM_DISCORD_WEBHOOK_URL || '').trim();
const FAILURE_THRESHOLD = 3;
const DEGRADED_ALERT_AFTER_MS = 60 * 60 * 1000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function clean(value) {
  return String(value ?? '').replace(/\r/g, '').replace(/\s+/g, ' ').trim();
}

function truncate(value, maxLength = 1000) {
  const text = clean(value) || '—';
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function currentRunId() {
  return clean(process.env.GITHUB_RUN_ID);
}

function runUrl() {
  const repository = clean(process.env.GITHUB_REPOSITORY);
  const runId = currentRunId();
  return repository && runId ? `https://github.com/${repository}/actions/runs/${runId}` : '';
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

function statePath(group) {
  if (group === 'fast') return 'system-health-fast.json';
  if (group === 'slow') return 'system-health-slow.json';
  throw new Error(`Unknown system health group: ${group}`);
}

function loadState(group) {
  const path = statePath(group);
  try {
    const parsed = JSON.parse(fs.readFileSync(path, 'utf8'));
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {}
  return { version: 1, initialized: true, updatedAt: null, sources: {} };
}

function saveState(group, state) {
  fs.writeFileSync(
    statePath(group),
    JSON.stringify({
      version: 1,
      initialized: true,
      updatedAt: new Date().toISOString(),
      sources: state.sources || {}
    }, null, 2) + '\n'
  );
}

function baseEmbed(title) {
  const url = runUrl();
  return {
    title,
    ...(url ? { url } : {}),
    footer: { text: 'keyboard-alert · system monitor' },
    timestamp: new Date().toISOString()
  };
}

function failureCount(source) {
  const value = Number(source?.consecutiveFailures || 0);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function clearPendingFailure(source) {
  const next = { ...source };
  delete next.consecutiveFailures;
  delete next.lastFailureRunId;
  delete next.lastFailureAt;
  return next;
}

function clearDegraded(source) {
  const next = { ...source };
  delete next.mode;
  delete next.degradedSince;
  delete next.fallbackSources;
  delete next.degradedAlertedAt;
  return next;
}

function loadDegradedInfo(sourceKey) {
  if (sourceKey !== 'swagkeys') return { sources: [], since: '' };
  try {
    const parsed = JSON.parse(fs.readFileSync('swagkeys-state.json', 'utf8'));
    const fallbackSince = parsed?.fallbackSince && typeof parsed.fallbackSince === 'object'
      ? parsed.fallbackSince
      : {};
    const entries = Object.entries(fallbackSince)
      .filter(([, value]) => Number.isFinite(Date.parse(value)));
    entries.sort((a, b) => Date.parse(a[1]) - Date.parse(b[1]));
    return {
      sources: entries.map(([key]) => key),
      since: entries[0]?.[1] || ''
    };
  } catch {
    return { sources: [], since: '' };
  }
}

async function transition(group, sourceKey, status, label, detail = '') {
  if (!['ok', 'fail', 'degraded'].includes(status)) throw new Error(`Unknown health status: ${status}`);

  const state = loadState(group);
  state.sources ||= {};

  const previous = state.sources[sourceKey] || {};
  const previousStatus = previous.status || null;
  const runId = currentRunId();
  const now = new Date().toISOString();

  if (status === 'degraded') {
    const degraded = loadDegradedInfo(sourceKey);
    const degradedSince = previous.degradedSince || degraded.since || now;
    const fallbackSources = degraded.sources.length
      ? degraded.sources
      : Array.isArray(previous.fallbackSources) ? previous.fallbackSources : [];
    const degradedAgeMs = Math.max(0, Date.parse(now) - Date.parse(degradedSince));

    const next = {
      ...previous,
      mode: 'degraded',
      degradedSince,
      fallbackSources
    };

    if (degradedAgeMs >= DEGRADED_ALERT_AFTER_MS && !previous.degradedAlertedAt) {
      if (DISCORD_WEBHOOK_URL) {
        const durationMinutes = Math.floor(degradedAgeMs / 60000);
        await postDiscord({
          ...baseEmbed(`⚠️ 수집 지연 · ${label}`),
          description: 'fresh 수집이 1시간 이상 확인되지 않아 저장된 검증 데이터를 사용하고 있습니다.',
          fields: [
            { name: '그룹', value: group.toUpperCase(), inline: true },
            { name: '상태', value: 'DEGRADED', inline: true },
            { name: '지연', value: `${durationMinutes}분`, inline: true },
            {
              name: 'Fallback',
              value: fallbackSources.length ? fallbackSources.join(', ') : 'unknown',
              inline: false
            }
          ]
        });
        next.degradedAlertedAt = now;
        console.log(`[system] ${label}: degraded warning sent after ${durationMinutes}m`);
      } else {
        console.log(`[system] SYSTEM_DISCORD_WEBHOOK_URL is not configured. ${label} degraded warning remains pending.`);
      }
    }

    const changed = JSON.stringify(previous) !== JSON.stringify(next);
    if (changed) saveState(group, { ...state, sources: { ...state.sources, [sourceKey]: next } });
    console.log(`[system] ${label}: degraded fallback; health status preserved as ${previousStatus || 'unknown'}`);
    return;
  }

  if (status === 'fail') {
    const previousFailures = failureCount(previous);
    const sameRun = Boolean(runId && previous.lastFailureRunId === runId);
    const consecutiveFailures = sameRun ? previousFailures : previousFailures + 1;

    if (previousStatus === 'fail') {
      console.log(`[system] ${label}: unchanged (fail)`);
      return;
    }

    if (consecutiveFailures < FAILURE_THRESHOLD) {
      state.sources[sourceKey] = {
        ...previous,
        consecutiveFailures,
        lastFailureRunId: runId || previous.lastFailureRunId || null,
        lastFailureAt: now
      };
      saveState(group, state);
      console.log(`[system] ${label}: transient failure ${consecutiveFailures}/${FAILURE_THRESHOLD}; alert suppressed`);
      return;
    }

    if (!DISCORD_WEBHOOK_URL) {
      state.sources[sourceKey] = {
        ...previous,
        consecutiveFailures,
        lastFailureRunId: runId || previous.lastFailureRunId || null,
        lastFailureAt: now
      };
      saveState(group, state);
      console.log(`[system] SYSTEM_DISCORD_WEBHOOK_URL is not configured. ${label} failure threshold reached; alert remains pending.`);
      return;
    }

    await postDiscord({
      ...baseEmbed(`🚨 수집 오류 · ${label}`),
      description: truncate(detail || '여러 실행에서 연속으로 수집에 실패했습니다. 기존 검증된 state를 유지합니다.'),
      fields: [
        { name: '그룹', value: group.toUpperCase(), inline: true },
        { name: '상태', value: '오류', inline: true },
        { name: '연속 실패', value: `${consecutiveFailures}회`, inline: true }
      ]
    });

    state.sources[sourceKey] = {
      ...clearDegraded(previous),
      status: 'fail',
      changedAt: now,
      consecutiveFailures,
      lastFailureRunId: runId || previous.lastFailureRunId || null,
      lastFailureAt: now
    };
    saveState(group, state);
    console.log(`[system] ${label}: ${previousStatus || 'unknown'} -> fail after ${consecutiveFailures} consecutive runs`);
    return;
  }

  const hadPendingFailures = failureCount(previous) > 0;

  if (previousStatus === 'fail') {
    if (!DISCORD_WEBHOOK_URL) {
      console.log(`[system] SYSTEM_DISCORD_WEBHOOK_URL is not configured. ${label} recovery remains pending.`);
      return;
    }

    await postDiscord({
      ...baseEmbed(`✅ 복구 · ${label}`),
      description: '정상 수집이 다시 확인되었습니다.',
      fields: [
        { name: '그룹', value: group.toUpperCase(), inline: true },
        { name: '상태', value: '정상', inline: true }
      ]
    });

    state.sources[sourceKey] = {
      ...clearDegraded(clearPendingFailure(previous)),
      status: 'ok',
      changedAt: now
    };
    saveState(group, state);
    console.log(`[system] ${label}: fail -> ok`);
    return;
  }

  const hadDegradedWarning = Boolean(previous.degradedAlertedAt);
  const wasDegraded = previous.mode === 'degraded' || Boolean(previous.degradedSince);
  if (wasDegraded) {
    if (hadDegradedWarning && DISCORD_WEBHOOK_URL) {
      await postDiscord({
        ...baseEmbed(`✅ 수집 지연 해소 · ${label}`),
        description: 'fresh 수집이 다시 확인되었습니다.',
        fields: [
          { name: '그룹', value: group.toUpperCase(), inline: true },
          { name: '상태', value: '정상', inline: true }
        ]
      });
    }
    state.sources[sourceKey] = clearDegraded(previous);
    saveState(group, state);
    console.log(`[system] ${label}: degraded -> ok`);
    return;
  }

  if (!previousStatus) {
    state.sources[sourceKey] = {
      status: 'ok',
      changedAt: now
    };
    saveState(group, state);
    console.log(`[system] ${label}: unknown -> ok`);
    return;
  }

  if (hadPendingFailures) {
    state.sources[sourceKey] = clearPendingFailure(previous);
    saveState(group, state);
    console.log(`[system] ${label}: recovered before alert threshold; pending failures reset`);
    return;
  }

  console.log(`[system] ${label}: unchanged (ok)`);
}

async function incident(label, detail = '') {
  if (!DISCORD_WEBHOOK_URL) {
    console.log(`[system] SYSTEM_DISCORD_WEBHOOK_URL is not configured. Incident not sent: ${label}`);
    return;
  }

  await postDiscord({
    ...baseEmbed(`🚨 워크플로 오류 · ${label}`),
    description: truncate(detail || 'GitHub Actions 워크플로 단계가 실패했습니다.'),
    fields: [{ name: '확인', value: '제목을 눌러 GitHub Actions 실행 로그를 확인하세요.', inline: false }]
  });
  console.log(`[system] Incident sent: ${label}`);
}

const [command, ...args] = process.argv.slice(2);

if (command === 'transition') {
  const [group, sourceKey, status, label, detail = ''] = args;
  await transition(group, sourceKey, status, label, detail);
} else if (command === 'incident') {
  const [label, detail = ''] = args;
  await incident(label, detail);
} else {
  throw new Error('Usage: system-health.mjs transition <fast|slow> <source-key> <ok|fail|degraded> <label> [detail] | incident <label> [detail]');
}
