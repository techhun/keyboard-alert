import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GB_REMINDER_OFFSETS,
  kstDay,
  daysUntil,
  dueGbReminders,
  gbReminderSource,
  reminderKey,
  reservedState,
  sentState,
  emptyReminderState,
  validateReminderState,
  discordGbReminder,
} from "../scripts/gb-deadline-core.mjs";

const dirname = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(dirname, "..", rel), "utf8");

function page({
  id = "7fc3a3cb-7fdc-42a0-814b-f3dbd3f98c8f",
  name = "GB Example 60",
  start = "2026-11-01",
  end = "2026-11-11",
  type = "GB",
  maker = "Geonworks",
  url = null,
  archived = false,
  inTrash = false,
} = {}) {
  return {
    object: "page",
    id,
    url: `https://www.notion.so/${id}`,
    archived,
    in_trash: inTrash,
    properties: {
      이름: { type: "title", title: [{ plain_text: name }] },
      "판매 방식": { type: "select", select: { name: type } },
      제조사: { type: "select", select: maker ? { name: maker } : null },
      "판매 일정": { type: "date", date: { start, end } },
      URL: { type: "url", url },
    },
  };
}

function sourcedEvent({ name = "GB Example 60", start = "2026-11-01", end = null, source = "GEONWORKS" } = {}) {
  return { source, name, saleStart: start, ...(end ? { saleEnd: end } : {}) };
}

test("GB reminders use Seoul's calendar day, even near the UTC day boundary", () => {
  assert.equal(kstDay(new Date("2026-11-08T14:59:00Z")), "2026-11-08");
  assert.equal(kstDay(new Date("2026-11-08T15:01:00Z")), "2026-11-09");
  assert.equal(daysUntil("2026-11-08", "2026-11-11"), 3);
  assert.equal(daysUntil("2026-11-08", "2026-11-09"), 1);
  assert.equal(daysUntil("2026-11-08", "2026-11-08"), 0);
  assert.equal(daysUntil("2026-11-08", "2026-11-10"), 2);
  assert.equal(daysUntil("2026-02-30", "2026-11-08"), null);
  assert.deepEqual(GB_REMINDER_OFFSETS, [3, 1, 0]);
});

test("only running GBs with verified end dates get 3-day, 1-day, or today reminders", () => {
  const now = new Date("2026-11-08T01:00:00Z"); // KST 10:00
  const rows = [
    page({ id: "due3", end: "2026-11-11" }),
    page({ id: "due1", end: "2026-11-09" }),
    page({ id: "today", end: "2026-11-08" }),
    page({ id: "due2", end: "2026-11-10" }),
    page({ id: "in-stock", end: "2026-11-09", type: "인스탁" }),
    page({ id: "missing-end", end: null }),
    page({ id: "future-start", start: "2026-11-09", end: "2026-11-11" }),
    page({ id: "expired", start: "2026-10-10", end: "2026-11-07" }),
    page({ id: "deleted", end: "2026-11-11", archived: true }),
    page({ id: "in-trash", end: "2026-11-11", inTrash: true }),
    page({ id: "no-name", name: "", end: "2026-11-11" }),
    page({ id: "invalid-order", start: "2026-11-12", end: "2026-11-11" }),
  ];
  const due = dueGbReminders({ 키보드: rows }, now, [sourcedEvent()]);
  assert.deepEqual(due.map(item => [item.offset, item.key]), [
    [0, reminderKey("today", "2026-11-08", 0)],
    [1, reminderKey("due1", "2026-11-09", 1)],
    [3, reminderKey("due3", "2026-11-11", 3)],
  ]);
});

test("same item repeated in another source is notified only once per stage", () => {
  const item = page({ id: "same", end: "2026-11-11" });
  const found = dueGbReminders({ 키보드: [item], 키캡: [item] }, new Date("2026-11-08T01:00:00Z"), [sourcedEvent()]);
  assert.equal(found.length, 1);
});

test("a GB with a same-day closing time already passed does not generate a late alert", () => {
  const now = new Date("2026-11-08T01:00:00Z");
  const alreadyClosed = page({ id: "earlier", start: "2026-11-07", end: "2026-11-08T08:00:00+09:00" });
  const stillOpen = page({ id: "later", start: "2026-11-07", end: "2026-11-08T23:00:00+09:00" });
  assert.deepEqual(dueGbReminders({ 키보드: [alreadyClosed, stillOpen] }, now, [sourcedEvent({ start: "2026-11-07" })]).map(item=>item.name), ["GB Example 60"]);
});


test("vendor routing requires matching sourced GB name and saleStart, never maker or URL guesses", () => {
  const now = new Date("2026-11-08T01:00:00Z");
  const pages = [
    page({ id: "geon", name: "Chamber TKL", maker: "KBDfans", start: "2026-10-27" }),
    page({ id: "swag", name: "SWG Nightshift", maker: "Swagkeys", start: "2026-10-30" }),
    page({ id: "gmk", name: "GMK CYL Blanks", maker: "GMK", start: "2026-10-20", url: "https://geonworks.kr/product/gmk" }),
    page({ id: "unknown", name: "Swagkeys", maker: "Swagkeys" }),
    page({ id: "startwrong", name: "SWG Midnight", start: "2026-10-11" }),
    page({ id: "endwrong", name: "SWG End Changed" }),
    page({ id: "fuzzy", name: "SWG Space Cadet R2", start: "2026-10-15" }),
    page({ id: "ambiguous", name: "Shared GB" }),
  ];
  const events = [
    sourcedEvent({ name: "Chamber TKL", start: "2026-10-27", source: "GEONWORKS" }),
    sourcedEvent({ name: "SWG Nightshift", start: "2026-10-30", source: "SWAGKEYS" }),
    sourcedEvent({ name: "GMK CYL Blanks", start: "2026-10-20", source: "GEONWORKS" }),
    sourcedEvent({ name: "SWG Midnight", start: "2026-10-15", source: "SWAGKEYS" }),
    sourcedEvent({ name: "SWG End Changed", end: "2026-11-12", source: "SWAGKEYS" }),
    sourcedEvent({ name: "SWG Space Cadet", start: "2026-10-15", source: "SWAGKEYS" }),
    sourcedEvent({ name: "Shared GB", source: "GEONWORKS" }),
    sourcedEvent({ name: "Shared GB", source: "SWAGKEYS" }),
  ];
  const result = dueGbReminders({ 키보드: pages }, now, events);
  assert.deepEqual(result.map(x=>[x.source,x.name]).sort(), [
    ["GEONWORKS", "Chamber TKL"], ["GEONWORKS", "GMK CYL Blanks"], ["SWAGKEYS", "SWG Nightshift"],
  ].sort());
  assert.equal(gbReminderSource(pages[1], events), "SWAGKEYS");
  assert.equal(gbReminderSource(pages[3], events), undefined);
  assert.equal(gbReminderSource(pages[7], events), undefined);
});

test("unknown or conflicting source evidence fails closed", () => {
  const now = new Date("2026-11-08T01:00:00Z");
  const p = page({ name: "GMK CYL Blanks", maker: "GMK", start: "2026-10-20", url: "https://geonworks.kr/product/gmk" });
  assert.deepEqual(dueGbReminders({ 키캡: [p] }, now, []), []);
  assert.deepEqual(dueGbReminders({ 키캡: [p] }, now, [
    sourcedEvent({ name: "GMK CYL Blanks", start: "2026-10-20", end: "2026-11-12" }),
  ]), []);
  assert.throws(() => dueGbReminders({ 키캡: [p] }, now, null), /event data must be an array/);
});

test("state reservations are idempotent and do not store identifying Notion product details", () => {
  const now = new Date("2026-11-08T01:00:00Z");
  const [item] = dueGbReminders({ 키보드: [page()] }, now, [sourcedEvent()]);
  const initial = emptyReminderState();
  const reserved = reservedState(initial, item, now);
  assert.equal(reservedState(reserved, item, now), null);
  assert.equal(Object.keys(initial.entries).length, 0);
  assert.equal(reserved.entries[item.key].status, "reserved");
  const sent = sentState(reserved, item.key, now);
  assert.equal(sent.entries[item.key].status, "sent");
  assert.equal(reserved.entries[item.key].status, "reserved");
  assert.doesNotMatch(JSON.stringify(sent), /GB Example 60|7fc3a3cb/);
  assert.deepEqual(validateReminderState(sent), sent);
  assert.throws(() => validateReminderState({ version: 1, entries: { bad: { status: "sent", day: "2026-11-08" } } }));
});

test("changed confirmed end date creates a new key without deleting prior dedupe state", () => {
  assert.notEqual(reminderKey("same", "2026-11-11", 3), reminderKey("same", "2026-11-12", 3));
  assert.notEqual(reminderKey("same", "2026-11-11", 3), reminderKey("same", "2026-11-11", 1));
  assert.equal(reminderKey("same", "2026-11-11", 3), reminderKey("same", "2026-11-11", 3));
});

test("Discord payload has no mention parsing, and sends direct verified links", () => {
  const [item] = dueGbReminders({ 키캡: [page({ name: "@everyone GB", end: "2026-11-09", url: "https://geonworks.kr/product/example" })] }, new Date("2026-11-08T01:00:00Z"), [sourcedEvent({ name: "@everyone GB" })]);
  const message = discordGbReminder(item);
  assert.deepEqual(message.allowed_mentions.parse, []);
  assert.equal(message.embeds[0].url, "https://geonworks.kr/product/example");
  assert.match(message.embeds[0].footer.text, /GEONWORKS/);
  assert.match(message.embeds[0].title, /D-1/);
  assert.match(discordGbReminder({ ...item, offset: 0 }).embeds[0].title, /오늘 마감/);
});

test("scheduled workflow is gated, dry-run on manual invocation, and does not mutate Notion", () => {
  const workflow = read(".github/workflows/keyboard-alert-gb-deadlines.yml");
  const runner = read("scripts/check-gb-deadlines.mjs");
  assert.match(workflow, /cron:\s*["']15 0 \* \* \*["']/);
  assert.match(workflow, /vars\.KEEPODD_GB_REMINDERS_ENABLED == 'true'/);
  assert.match(workflow, /dry_run:[\s\S]*?default:\s*true/);
  assert.match(workflow, /KEEPODD_GB_NOTION_TOKEN:\s*\$\{\{ secrets\.KEEPODD_GB_NOTION_TOKEN \}\}/);
  assert.match(workflow, /GEONWORKS_DISCORD_WEBHOOK_URL:\s*\$\{\{ secrets\.GEONWORKS_DISCORD_WEBHOOK_URL \}\}/);
  assert.match(workflow, /SWAGKEYS_DISCORD_WEBHOOK_URL:\s*\$\{\{ secrets\.SWAGKEYS_DISCORD_WEBHOOK_URL \}\}/);
  assert.match(workflow, /SWG_DISCORD_WEBHOOK_URL:\s*\$\{\{ secrets\.SWG_DISCORD_WEBHOOK_URL \}\}/);
  assert.match(workflow, /git show origin\/watcher-state:keepodd-events\.json/);
  assert.match(runner, /STATE_BRANCH = "gb-reminder-state"/);
  assert.match(runner, /SWG_DISCORD_WEBHOOK_URL/);
  assert.doesNotMatch(workflow, /KEEPODD_GB_DISCORD_WEBHOOK_URL/);
  assert.match(runner, /const dryRun = .*!== "false"/);
  assert.match(runner, /if \(dryRun\)\s*\{/);
  assert.ok(runner.indexOf("writeReminderState(repo, ghToken, next") < runner.indexOf("sendDiscordReminder(webhooks[reminder.source], reminder)"));
  assert.match(runner, /SOURCE_WEBHOOK_SECRETS\[source\]/);
  assert.doesNotMatch(runner, /KEEPODD_GB_DISCORD_WEBHOOK_URL/);
  assert.match(runner, /SOURCED_GB_EVENTS_PATH/);
  assert.match(runner, /await loadSourcedGbEvents\(\)/);
  assert.match(runner, /dueGbReminders\(pages, now, sourcedEvents\)/);
  assert.match(runner, /data_sources\/\$\{sourceId\}\/query/);
  assert.doesNotMatch(runner, /api\.notion\.com\/v1\/pages\/.*PATCH|api\.notion\.com\/v1\/pages\/.*POST/);
});
