import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { dueGbReminders, discordGbReminder, reservedState, sentState, validateReminderState } from "./gb-deadline-core.mjs";

const NOTION_VERSION = "2026-03-11";
const STATE_BRANCH = "gb-reminder-state";
const STATE_FILE = "gb-deadline-state.json";
const SOURCED_GB_EVENTS_PATH = process.env.KEEPODD_GB_EVENTS_PATH || "keepodd-events.json";
const SOURCE_WEBHOOK_SECRETS = Object.freeze({
  GEONWORKS: ["GEONWORKS_DISCORD_WEBHOOK_URL"],
  SWAGKEYS: ["SWAGKEYS_DISCORD_WEBHOOK_URL", "SWG_DISCORD_WEBHOOK_URL"],
});
const DATA_SOURCES = Object.freeze({
  키보드: "256c53d5-2ef8-802b-8c4c-000bfafad157",
  키캡: "256c53d5-2ef8-80a7-8d09-000bcb3647ae",
  액세서리: "8cf24bc4-b826-41b7-b663-ced2fcd5d46c",
});

function expectEnvironment(name) {
  const value = (process.env[name] || "").trim();
  if (!value) throw new Error(`GitHub secret/environment ${name} is missing`);
  return value;
}

async function fetchJson(url, options = {}, label = "Request") {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`${label} HTTP ${res.status}${data?.code ? ` (${data.code})` : ""}`);
  return data;
}

async function loadNotionPages(token, sourceId) {
  let cursor;
  const pages = [];
  do {
    const data = await fetchJson(`https://api.notion.com/v1/data_sources/${sourceId}/query`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) }),
    }, "Notion GB data-source query");
    if (!Array.isArray(data?.results) || typeof data.has_more !== "boolean") throw new Error("Unexpected Notion query response");
    pages.push(...data.results);
    if (pages.length > 5000) throw new Error("Unexpected Notion row count; fail closed");
    if (data.has_more && (!data.next_cursor || data.next_cursor === cursor)) throw new Error("Notion pagination cursor invalid");
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return pages;
}

async function loadSourcedGbEvents() {
  // The workflow snapshots the live watcher-state file before starting the read-only check.
  // Never fall back to guessed URLs or manufacturer names if this snapshot is missing.
  const data = JSON.parse(await readFile(SOURCED_GB_EVENTS_PATH, "utf8"));
  if (data?.version !== 1 || !Array.isArray(data.events) || data.events.length > 5000) {
    throw new Error("Verified GB event snapshot is missing or invalid");
  }
  return data.events;
}

function githubApiUrl(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("Invalid GITHUB_REPOSITORY");
  return `https://api.github.com/repos/${repo}/contents/${STATE_FILE}`;
}

async function readReminderState(repo, token) {
  const url = new URL(githubApiUrl(repo));
  url.searchParams.set("ref", STATE_BRANCH);
  const result = await fetchJson(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  }, "GitHub reminder state (initialize gb-reminder-state branch and file first)");
  if (typeof result?.sha !== "string" || typeof result.content !== "string") throw new Error("GitHub reminder state file is missing or invalid");
  const state = validateReminderState(JSON.parse(Buffer.from(result.content.replace(/\s/g, ""), "base64").toString("utf8")));
  return { state, sha: result.sha };
}

async function writeReminderState(repo, token, state, sha, label) {
  validateReminderState(state);
  const data = await fetchJson(githubApiUrl(repo), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      message: `state(keepodd): GB deadline ${label}`,
      content: Buffer.from(JSON.stringify(state, null, 2) + "\n").toString("base64"),
      branch: STATE_BRANCH,
      sha,
    }),
  }, "GitHub reminder state commit");
  const nextSha = data?.content?.sha;
  if (!nextSha) throw new Error("GitHub reminder state commit response missing file sha");
  return { state, sha: nextSha };
}

function discordWebhookUrl(value, source) {
  const url = new URL(value);
  if (url.protocol !== "https:" || !["discord.com", "discordapp.com"].includes(url.hostname) ||
      !/^\/api\/webhooks\/\d+\/[^/]+\/?$/.test(url.pathname)) {
    throw new Error(`${source} webhook must be an official Discord webhook`);
  }
  url.searchParams.set("wait", "true");
  return url.toString();
}

async function sendDiscordReminder(url, reminder) {
  const body = JSON.stringify(discordGbReminder(reminder));
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (response.ok) return;
    if (response.status === 429 && attempt < 2) {
      const data = await response.json().catch(() => ({}));
      const retryMs = Math.max(1000, Math.min(10_000, Math.ceil(Number(data.retry_after || 1) * 1000)));
      await new Promise(resolve => setTimeout(resolve, retryMs));
      continue;
    }
    throw new Error(`Discord webhook HTTP ${response.status}; reserved entry retained to prevent duplicate sending`);
  }
}

export async function runGbDeadlineCheck(now = new Date()) {
  const dryRun = (process.env.DRY_RUN ?? "").trim().toLowerCase() !== "false";
  const token = expectEnvironment("KEEPODD_GB_NOTION_TOKEN");
  const pages = {};
  for (const [category, sourceId] of Object.entries(DATA_SOURCES)) {
    pages[category] = await loadNotionPages(token, sourceId);
  }
  const sourcedEvents = await loadSourcedGbEvents();
  const due = dueGbReminders(pages, now, sourcedEvents);
  const count = Object.values(pages).reduce((sum, p) => sum + p.length, 0);
  const sourceCounts = {
    GEONWORKS: due.filter(item => item.source === "GEONWORKS").length,
    SWAGKEYS: due.filter(item => item.source === "SWAGKEYS").length,
  };
  console.log(`Keepodd GB deadline check: scanned ${count} records; verified due: GEONWORKS=${sourceCounts.GEONWORKS}, SWAGKEYS=${sourceCounts.SWAGKEYS}.`);
  if (due.length > 50) throw new Error("More than 50 GB reminders due; investigate before sending to prevent floods");

  if (dryRun) {
    for (const item of due) {
      const label = item.offset === 0 ? "today" : `D-${item.offset}`;
      console.log(`DRY RUN ${item.source} ${label}: ${item.name} (ends ${item.endDay})`);
    }
    console.log(`DRY RUN: ${due.length} eligible GB reminders; no Discord messages or state changes.`);
    return { dryRun: true, due: due.length, sent: 0 };
  }

  // A scheduled run must explicitly be enabled. Manual workflow_dispatch sends require dry_run=false.
  if (process.env.GITHUB_EVENT_NAME !== "workflow_dispatch" &&
      process.env.KEEPODD_GB_REMINDERS_ENABLED !== "true") {
    throw new Error("Scheduled GB reminders are disabled");
  }

  // Resolve and validate every required webhook before reserving any message.
  const webhooks = {};
  for (const source of new Set(due.map(item => item.source))) {
    const names = SOURCE_WEBHOOK_SECRETS[source];
    if (!names) throw new Error(`Unsupported GB reminder source ${source}`);
    const webhook = names.map(name => (process.env[name] || "").trim()).find(Boolean);
    if (!webhook) throw new Error(`Missing existing Discord webhook secret for ${source}: ${names.join(" / ")}`);
    webhooks[source] = discordWebhookUrl(webhook, source);
  }
  const ghToken = expectEnvironment("GITHUB_TOKEN");
  const repo = expectEnvironment("GITHUB_REPOSITORY");
  let saved = await readReminderState(repo, ghToken);
  let sent = 0, skipped = 0;

  for (const reminder of due) {
    if (Object.hasOwn(saved.state.entries, reminder.key)) {
      skipped++;
      continue;
    }
    // Reserve durably BEFORE posting. A crash or uncertain HTTP result cannot auto-resend an already attempted alert.
    const next = reservedState(saved.state, reminder, now);
    if (!next) { skipped++; continue; }
    saved = await writeReminderState(repo, ghToken, next, saved.sha, "reserve");
    await sendDiscordReminder(webhooks[reminder.source], reminder);
    saved = await writeReminderState(repo, ghToken, sentState(saved.state, reminder.key), saved.sha, "sent");
    sent++;
    // Avoid hitting Discord per-webhook rate limits on busy GB days.
    await new Promise(resolve => setTimeout(resolve, 1200));
  }

  console.log(`Keepodd GB deadline results: sent=${sent}, already-handled=${skipped}.`);
  return { dryRun: false, due: due.length, sent, skipped };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runGbDeadlineCheck().catch(error => {
    console.error(`Keepodd GB reminder failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
