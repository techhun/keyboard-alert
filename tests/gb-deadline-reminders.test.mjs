import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GB_REMINDER_OFFSETS,
  kstDay, daysUntil, validateGbSnapshot, dueGbReminders, reminderKey,
  emptyReminderState, validateReminderState, reservedState, sentState,
  discordGbReminder,
} from "../scripts/gb-deadline-core.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = relative => fs.readFileSync(path.join(root, relative), "utf8");
const NOW = new Date("2026-11-10T00:20:00Z"); // 09:20 KST
const UPDATED_AT = "2026-11-10T00:00:00Z";

function geon(rows = []) {
  return { version: 1, initialized: true, updatedAt: UPDATED_AT, rows };
}

function release(product, end, changes = {}) {
  return {
    product, saleType: "Group Buy", fixed: "확정 / Fixed", status: "For Sale",
    start: "2026-10-20", end, type: "Keycaps", ...changes,
  };
}

function swag(roadmapDates = {}, quarters = { Q4: [] }) {
  return {
    version: 1, initialized: true, updatedAt: UPDATED_AT, roadmapLayoutVersion: 2,
    roadmapDates, quarters, fallbackSince: {},
  };
}
function dated(product, end, start = "2026-10-20") {
  return { product, saleStart: start, saleEnd: end };
}

test("KST dates, leap validation, and D-3/D-1/D-0 offsets", () => {
  assert.deepEqual(GB_REMINDER_OFFSETS, [3, 1, 0]);
  assert.equal(kstDay(new Date("2026-11-09T14:59:00Z")), "2026-11-09");
  assert.equal(kstDay(new Date("2026-11-09T15:01:00Z")), "2026-11-10");
  assert.equal(daysUntil("2026-11-10", "2026-11-13"), 3);
  assert.equal(daysUntil("2026-11-10", "2026-11-11"), 1);
  assert.equal(daysUntil("2026-11-10", "2026-11-10"), 0);
  assert.equal(daysUntil("2026-11-10", "2026-11-12"), 2);
  assert.equal(daysUntil("2026-02-30", "2026-11-10"), null);
  assert.equal(daysUntil("2026-11-10", "2026-02-29"), null);
});

test("GEONWORKS exact fixed Group Buy rows with confirmed closing dates generate the right reminder stages", () => {
  const rows = [
    release("GMK A", "2026-11-13"),
    release("GMK B", "2026-11-11"),
    release("GMK C", "2026-11-10"),
    release("GB D+2", "2026-11-12"),
    release("Missing end", ""),
    release("Already ended", "2026-11-09"),
    release("Future start", "2026-11-13", { start: "2026-11-11" }),
    release("Invalid dates", "2026-11-13", { start: "2026-11-20" }),
  ];
  const due = dueGbReminders(geon(rows), swag(), NOW);
  assert.deepEqual(due.map(x => [x.name, x.offset]), [
    ["GMK C", 0], ["GMK B", 1], ["GMK A", 3],
  ]);
  assert.ok(due.every(x => x.source === "GEONWORKS"));
});

test("GEONWORKS ignores IC, tentative, non-GB, and no-longer-for-sale rows", () => {
  const due = dueGbReminders(geon([
    release("IC", "2026-11-13", { status: "Interest Check" }),
    release("Unconfirmed", "2026-11-13", { fixed: "미확정 / TBD" }),
    release("In-stock", "2026-11-13", { saleType: "In-Stock" }),
    release("Production", "2026-11-13", { status: "In Progress" }),
    release("Valid keyboard GB", "2026-11-13", { type: "Keyboard" }),
  ]), swag(), NOW);
  assert.equal(due.length, 1);
  assert.equal(due[0].name, "Valid keyboard GB");
  assert.equal(due[0].category, "키보드");
  assert.equal(due[0].url, "https://geonworks.kr/customhtml/release/release.html");
});

test("SWAGKEYS reads current roadmap dates and only currently listed quarter products", () => {
  const state = swag({
    space: dated("SWG Space Cadet", "2026-11-13"),
    night: dated("SWG Nightshift", "2026-11-11"),
    old: dated("SWG Removed", "2026-11-13"),
    undated: dated("SWG Unscheduled", ""),
    future: dated("SWG Future", "2026-11-13", "2026-11-12"),
    wrong: dated("SWG Invalid", "2026-11-13", "2026-11-14"),
  }, { Q4: ["SWG Space Cadet", "SWG Nightshift", "SWG Unscheduled", "SWG Future", "SWG Invalid"] });
  const result = dueGbReminders(geon(), state, NOW);
  assert.deepEqual(result.map(x=>[x.name,x.offset]), [
    ["SWG Nightshift",1],["SWG Space Cadet",3],
  ]);
  assert.ok(result.every(x => x.source === "SWAGKEYS"));
});

test("SWAGKEYS split SWG/SWS products do not cross-match, and duplicate quarter entries only notify once", () => {
  const result = dueGbReminders(geon(), swag({
    swg: dated("SWG Beige", "2026-11-13"),
    sws: dated("SWS Beige", "2026-11-13"),
  }, { Q4: ["SWG Beige", "SWS Beige", "SWS Beige"], Q3: ["SWG Beige"] }), NOW);
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(x=>x.category).sort(), ["스위치", "키캡"]);
  assert.notEqual(result[0].key, result[1].key);
});

test("source snapshots must be verified and recent, never a stale or fallback snapshot", () => {
  assert.equal(validateGbSnapshot("GEONWORKS", geon(), NOW).version, 1);
  assert.throws(() => dueGbReminders({ ...geon(), updatedAt: "2026-11-01T00:00:00Z" }, swag(), NOW), /Stale GEONWORKS/);
  assert.throws(() => dueGbReminders(geon(), { ...swag(), fallbackSince: { Q4: "2026-11-08T00:00:00Z" } }, NOW), /fallback/);
  assert.throws(() => dueGbReminders(geon(), { ...swag(), roadmapLayoutVersion: 1 }, NOW), /Invalid SWAGKEYS/);
  assert.throws(() => dueGbReminders(geon(), { ...swag(), updatedAt: "invalid" }, NOW), /Stale SWAGKEYS/);
  assert.throws(() => dueGbReminders(geon(), { ...swag(), quarters: { Q4: null } }, NOW), /quarter/);
});

test("event fingerprint is source + product + exact dates + D-stage, not Notion page IDs", () => {
  const key = reminderKey("GEONWORKS", "Chamber TKL", "2026-10-27", "2026-11-27", 3);
  assert.match(key, /^[a-f0-9]{64}$/);
  assert.equal(key, reminderKey("GEONWORKS", "Chamber TKL", "2026-10-27", "2026-11-27", 3));
  assert.notEqual(key, reminderKey("SWAGKEYS", "Chamber TKL", "2026-10-27", "2026-11-27", 3));
  assert.notEqual(key, reminderKey("GEONWORKS", "Chamber TKL", "2026-10-27", "2026-11-28", 3));
  assert.notEqual(key, reminderKey("GEONWORKS", "Chamber TKL", "2026-10-27", "2026-11-27", 1));
});

test("durable reservation and sent state never contain product names or resend the same event", () => {
  const [item] = dueGbReminders(geon([release("Chamber TKL", "2026-11-13")]), swag(), NOW);
  const empty = emptyReminderState();
  const reserved = reservedState(empty, item, NOW);
  assert.ok(reserved);
  assert.equal(reservedState(reserved, item, NOW), null);
  const sent = sentState(reserved, item.key, NOW);
  assert.equal(sent.entries[item.key].status, "sent");
  assert.equal(reserved.entries[item.key].status, "reserved");
  assert.equal(Object.keys(empty.entries).length, 0);
  assert.doesNotMatch(JSON.stringify(sent), /Chamber TKL|GEONWORKS/);
  assert.deepEqual(validateReminderState(sent), sent);
  assert.throws(() => validateReminderState({ version: 1, entries: { bad: { status: "sent", day: "2026-11-10" } } }));
});

test("Discord message uses verified vendor source, no auto-mentions, and date-only closing notice", () => {
  const [item] = dueGbReminders(geon([release("@everyone GMK Blanks", "2026-11-13")]), swag(), NOW);
  const data = discordGbReminder(item);
  assert.deepEqual(data.allowed_mentions, { parse: [] });
  assert.match(data.embeds[0].title, /D-3/);
  assert.match(data.embeds[0].footer.text, /Keyboard Alert · GEONWORKS/);
  assert.match(data.embeds[0].url, /geonworks.kr/);
  assert.doesNotMatch(data.embeds[0].description, /Keepodd|Notion/);
  assert.match(discordGbReminder({ ...item, offset: 0 }).embeds[0].title, /오늘 마감/);
});

test("daily workflow consumes only verified watcher states and reuses existing webhooks, no Notion secrets or calls", () => {
  const workflow = read(".github/workflows/keyboard-alert-gb-deadlines.yml");
  const runner = read("scripts/check-gb-deadlines.mjs");
  const core = read("scripts/gb-deadline-core.mjs");
  assert.match(workflow, /cron:\s*['"]15 0 \* \* \*['"]/);
  assert.match(workflow, /dry_run:[\s\S]*?default:\s*true/);
  assert.match(workflow, /git show origin\/watcher-state:geonworks-release-state\.json/);
  assert.match(workflow, /git show origin\/watcher-state:swagkeys-state\.json/);
  assert.match(workflow, /GEONWORKS_DISCORD_WEBHOOK_URL:\s*\$\{\{ secrets\.GEONWORKS_DISCORD_WEBHOOK_URL \}\}/);
  assert.match(workflow, /SWAGKEYS_DISCORD_WEBHOOK_URL:\s*\$\{\{ secrets\.SWAGKEYS_DISCORD_WEBHOOK_URL \}\}/);
  assert.match(workflow, /SWG_DISCORD_WEBHOOK_URL:\s*\$\{\{ secrets\.SWG_DISCORD_WEBHOOK_URL \}\}/);
  assert.match(runner, /dueGbReminders\(geonRelease, swagkeys, now\)/);
  assert.match(runner, /const dryRun = .*!== "false"/);
  assert.ok(runner.indexOf("writeReminderState(repo, ghToken, next") < runner.indexOf("sendDiscordReminder(webhooks[reminder.source], reminder)"));
  for (const text of [workflow, runner, core]) {
    assert.doesNotMatch(text, /api\.notion\.com|KEEPODD_GB_NOTION_TOKEN|NOTION_TOKEN|loadNotionPages|keepodd-events\.json/i);
  }
});
