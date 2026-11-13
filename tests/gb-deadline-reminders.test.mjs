import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  GB_REMINDER_OFFSETS, GB_SOURCES,
  kstDay, daysUntil, validateGbSnapshot, dueGbReminders, dueGbRemindersForSource, reminderKey,
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
  assert.throws(() => validateGbSnapshot("GEONWORKS", { ...geon(), updatedAt: "2026-11-01T00:00:00Z" }, NOW), /Stale GEONWORKS/);
  assert.throws(() => validateGbSnapshot("SWAGKEYS", { ...swag(), fallbackSince: { Q4: "2026-11-08T00:00:00Z" } }, NOW), /fallback/);
  assert.throws(() => validateGbSnapshot("SWAGKEYS", { ...swag(), roadmapLayoutVersion: 1 }, NOW), /Invalid SWAGKEYS/);
  assert.throws(() => validateGbSnapshot("SWAGKEYS", { ...swag(), updatedAt: "invalid" }, NOW), /Stale SWAGKEYS/);
  assert.throws(() => dueGbRemindersForSource("SWAGKEYS", { ...swag(), quarters: { Q4: null } }, NOW), /quarter/);
  assert.throws(() => dueGbRemindersForSource("GEONWORKS", null, NOW), /Invalid GEONWORKS/);
  assert.throws(() => dueGbRemindersForSource("KEEBIO", geon(), NOW), /Unsupported GB source/);
  // One unusable vendor is contained instead of aborting the whole check.
  assert.deepEqual(dueGbReminders({ ...geon(), updatedAt: "2026-11-01T00:00:00Z" }, swag(), NOW, { onSourceStatus() {} }), []);
  // Every vendor unusable is still a hard failure.
  assert.throws(
    () => dueGbReminders({ ...geon(), updatedAt: "2026-11-01T00:00:00Z" },
      { ...swag(), fallbackSince: { Q4: "2026-11-08T00:00:00Z" } }, NOW, { onSourceStatus() {} }),
    error => {
      assert.match(error.message, /All GB deadline sources failed/);
      assert.match(error.message, /GEONWORKS: Stale GEONWORKS/);
      assert.match(error.message, /SWAGKEYS: .*fallback/);
      return true;
    },
  );
});

test("a SWAGKEYS fallback snapshot no longer blocks due GEONWORKS closing reminders", () => {
  const statuses = [];
  const due = dueGbReminders(
    geon([release("GMK CYL Blanks", "2026-11-13")]),
    {
      ...swag({ space: dated("SWG Space Cadet", "2026-11-13") }, { Q4: ["SWG Space Cadet"] }),
      fallbackSince: { roadmap: "2026-11-12T17:24:19.913Z" },
    },
    NOW,
    { onSourceStatus: status => statuses.push(status) },
  );
  assert.deepEqual(due.map(x => [x.source, x.name, x.offset]), [["GEONWORKS", "GMK CYL Blanks", 3]]);
  assert.deepEqual(statuses.map(s => [s.source, s.ok, s.due]), [["GEONWORKS", true, 1], ["SWAGKEYS", false, 0]]);
  assert.match(statuses[1].error.message, /fallback/);
  assert.deepEqual(GB_SOURCES, ["GEONWORKS", "SWAGKEYS"]);
});

test("a stale GEONWORKS snapshot no longer blocks due SWAGKEYS closing reminders", () => {
  const statuses = [];
  const due = dueGbReminders(
    { ...geon(), updatedAt: "2026-11-02T00:00:00Z" },
    swag({ space: dated("SWG Space Cadet", "2026-11-13") }, { Q4: ["SWG Space Cadet"] }),
    NOW,
    { onSourceStatus: status => statuses.push(status) },
  );
  assert.deepEqual(due.map(x => [x.source, x.name, x.offset]), [["SWAGKEYS", "SWG Space Cadet", 3]]);
  assert.deepEqual(statuses.map(s => [s.source, s.ok, s.due]), [["GEONWORKS", false, 0], ["SWAGKEYS", true, 1]]);
  assert.match(statuses[0].error.message, /Stale GEONWORKS/);
});

test("a skipped vendor is a warning log, never an exception, when both sources are not lost", () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const due = dueGbReminders(
      geon([release("GMK CYL Blanks", "2026-11-13")]),
      { ...swag(), fallbackSince: { roadmap: "2026-11-12T17:24:19.913Z" } },
      NOW,
    );
    assert.equal(due.length, 1);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SWAGKEYS deadline check skipped: SWAGKEYS GB roadmap is using fallback data/);
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
  assert.match(runner, /dueGbReminders\(geonRelease, swagkeys, now, \{/);
  assert.match(runner, /onSourceStatus/);
  assert.match(core, /All GB deadline sources failed/);
  assert.match(runner, /const dryRun = .*!== "false"/);
  assert.ok(runner.indexOf("writeReminderState(repo, ghToken, next") < runner.indexOf("sendDiscordReminder(webhooks[reminder.source], reminder)"));
  for (const text of [workflow, runner, core]) {
    assert.doesNotMatch(text, /api\.notion\.com|KEEPODD_GB_NOTION_TOKEN|NOTION_TOKEN|loadNotionPages|keepodd-events\.json/i);
  }
});

let runnerImports = 0;

// Runs the real runner in dry-run mode against throw-away watcher snapshots.
async function invokeRunner({ geonSnapshot, swagSnapshot, now = NOW }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gb-deadline-runner-"));
  const geonPath = path.join(dir, "geonworks-release-state.json");
  const swagPath = path.join(dir, "swagkeys-state.json");
  if (geonSnapshot !== undefined) fs.writeFileSync(geonPath, JSON.stringify(geonSnapshot));
  if (swagSnapshot !== undefined) fs.writeFileSync(swagPath, JSON.stringify(swagSnapshot));
  const savedEnv = {
    GEON_RELEASE_STATE_PATH: process.env.GEON_RELEASE_STATE_PATH,
    SWAGKEYS_STATE_PATH: process.env.SWAGKEYS_STATE_PATH,
    DRY_RUN: process.env.DRY_RUN,
  };
  const logs = [], warnings = [];
  const originalLog = console.log, originalWarn = console.warn;
  console.log = (...args) => logs.push(args.join(" "));
  console.warn = (...args) => warnings.push(args.join(" "));
  let result, error;
  try {
    process.env.GEON_RELEASE_STATE_PATH = geonPath;
    process.env.SWAGKEYS_STATE_PATH = swagPath;
    process.env.DRY_RUN = "true";
    runnerImports++;
    const { runGbDeadlineCheck } = await import(`../scripts/check-gb-deadlines.mjs?fixture=${runnerImports}`);
    result = await runGbDeadlineCheck(now);
  } catch (caught) {
    error = caught;
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return { result, error, logs, warnings };
}

test("runner dry-run keeps GEONWORKS closing reminders while SWAGKEYS is in fallback", async () => {
  const { result, error, logs, warnings } = await invokeRunner({
    geonSnapshot: geon([release("GMK CYL Blanks", "2026-11-13")]),
    swagSnapshot: {
      ...swag({ space: dated("SWG Space Cadet", "2026-11-13") }, { Q4: ["SWG Space Cadet"] }),
      fallbackSince: { roadmap: "2026-11-12T17:24:19.913Z", status: "2026-11-12T17:42:40.276Z" },
    },
  });
  assert.equal(error, undefined);
  assert.equal(result.dryRun, true);
  assert.equal(result.due, 1);
  assert.equal(result.sent, 0);
  assert.ok(logs.some(line => /DRY RUN GEONWORKS D-3: GMK CYL Blanks/.test(line)), logs.join("\n"));
  assert.ok(logs.some(line => /GEONWORKS: 1 verified due reminder/.test(line)));
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SWAGKEYS deadline check skipped: SWAGKEYS GB roadmap is using fallback data/);
});

test("runner dry-run keeps going when one watcher snapshot file cannot be read", async () => {
  const { result, error, warnings } = await invokeRunner({
    geonSnapshot: geon([release("GMK CYL Blanks", "2026-11-13")]),
  });
  assert.equal(error, undefined);
  assert.equal(result.due, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /SWAGKEYS deadline check skipped: .*ENOENT/);
});

test("runner fails only when every vendor snapshot is unusable", async () => {
  const { result, error } = await invokeRunner({
    geonSnapshot: { ...geon(), updatedAt: "2026-11-01T00:00:00Z" },
    swagSnapshot: {
      ...swag(),
      fallbackSince: { roadmap: "2026-11-12T17:24:19.913Z" },
    },
  });
  assert.equal(result, undefined);
  assert.match(error.message, /All GB deadline sources failed/);
  assert.match(error.message, /GEONWORKS: Stale GEONWORKS/);
  assert.match(error.message, /SWAGKEYS: .*fallback/);
});
