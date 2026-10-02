const VALID_SIGNALS = new Set(['start', 'success', 'fail']);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function buildPingUrl(baseUrl, signal = 'success') {
  const raw = String(baseUrl || '').trim();
  if (!raw) return '';

  if (!VALID_SIGNALS.has(signal)) {
    throw new Error(`Unknown heartbeat signal: ${signal}`);
  }

  const url = new URL(raw);
  if (!['https:', 'http:'].includes(url.protocol)) {
    throw new Error('Heartbeat URL must use HTTP or HTTPS.');
  }

  if (signal !== 'success') {
    url.pathname = `${url.pathname.replace(/\/+$/, '')}/${signal}`;
  }

  return url.toString();
}

export async function sendHeartbeat(baseUrl, signal = 'success', options = {}) {
  const url = buildPingUrl(baseUrl, signal);
  if (!url) {
    console.log(`[heartbeat] ${signal}: not configured; skipped`);
    return { ok: true, skipped: true, attempts: 0 };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const attempts = Math.max(1, Number(options.attempts || 3));
  const timeoutMs = Math.max(100, Number(options.timeoutMs || 5000));
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 500));

  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'GET',
        signal: AbortSignal.timeout(timeoutMs)
      });

      if (response.ok) {
        console.log(`[heartbeat] ${signal}: sent`);
        return { ok: true, skipped: false, attempts: attempt };
      }

      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }

    if (attempt < attempts) {
      await sleep(retryDelayMs * attempt);
    }
  }

  console.warn(`[heartbeat] ${signal}: ping failed after ${attempts} attempt(s): ${lastError?.message || 'unknown error'}`);
  return { ok: false, skipped: false, attempts };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const signal = process.argv[2] || 'success';

  try {
    await sendHeartbeat(process.env.HEALTHCHECKS_URL, signal);
  } catch (error) {
    console.warn(`[heartbeat] ${signal}: invalid configuration: ${error?.message || error}`);
  }
}
