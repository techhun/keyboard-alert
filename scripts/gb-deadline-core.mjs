import { createHash } from "node:crypto";

export const GB_REMINDER_OFFSETS = Object.freeze([3, 1, 0]);
export const GB_SOURCES = Object.freeze(["GEONWORKS", "SWAGKEYS"]);
const DAY_MS = 86_400_000;
const KST_MS = 9 * 60 * 60 * 1000;
const VALID_DAY = /^\d{4}-\d{2}-\d{2}$/;

export function kstDay(now = new Date()) {
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invalid reminder clock");
  return new Date(now.getTime() + KST_MS).toISOString().slice(0, 10);
}

function dayTimestamp(day) {
  if (typeof day !== "string" || !VALID_DAY.test(day)) return NaN;
  const stamp = Date.parse(`${day}T00:00:00Z`);
  return Number.isFinite(stamp) && new Date(stamp).toISOString().slice(0, 10) === day ? stamp : NaN;
}

export function daysUntil(fromDay, endDay) {
  const start = dayTimestamp(fromDay), end = dayTimestamp(endDay);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return (end - start) / DAY_MS;
}

function dateDay(value) {
  if (typeof value !== "string") return null;
  const datePart = value.slice(0, 10);
  return Number.isFinite(dayTimestamp(datePart)) ? datePart : null;
}

const SOURCE_URLS = Object.freeze({
  GEONWORKS: "https://geonworks.kr/customhtml/release/release.html",
  SWAGKEYS: "https://swagkeys.notion.site/swg-keycap-roadmap",
});
const MAX_STATE_AGE_MS = 72 * 60 * 60 * 1000;

function nameKey(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().toLocaleLowerCase("en").replace(/\s+/g, " ")
    : "";
}

// Both inputs are already verified by the independent Keyboard Alert watchers.
// Refuse stale or degraded snapshots instead of using a guessed GB end date.
export function validateGbSnapshot(source, snapshot, now = new Date()) {
  if (!snapshot || snapshot.version !== 1 || snapshot.initialized !== true ||
      !Array.isArray(snapshot.rows) && source === "GEONWORKS" ||
      source === "SWAGKEYS" && (!snapshot.roadmapDates || typeof snapshot.roadmapDates !== "object" ||
        !snapshot.quarters || typeof snapshot.quarters !== "object" || snapshot.roadmapLayoutVersion !== 2)) {
    throw new Error(`Invalid ${source} verified GB snapshot`);
  }
  if (!["GEONWORKS", "SWAGKEYS"].includes(source)) throw new Error("Unsupported GB source");
  const asOf = Date.parse(snapshot.updatedAt);
  const age = now.getTime() - asOf;
  if (!Number.isFinite(asOf) || age < -2 * 60 * 60 * 1000 || age > MAX_STATE_AGE_MS) {
    throw new Error(`Stale ${source} GB schedule snapshot; fail closed`);
  }
  if (source === "SWAGKEYS" && Object.keys(snapshot.fallbackSince || {}).length > 0) {
    throw new Error("SWAGKEYS GB roadmap is using fallback data; skip deadline notifications");
  }
  if (source === "GEONWORKS" && snapshot.rows.length > 5000) throw new Error("Unexpected GEONWORKS schedule size");
  if (source === "SWAGKEYS" && Object.keys(snapshot.roadmapDates).length > 5000) throw new Error("Unexpected SWAGKEYS roadmap size");
  return snapshot;
}

export function reminderKey(source, name, startDay, endDay, offset) {
  if (!["GEONWORKS", "SWAGKEYS"].includes(source) || !nameKey(name) ||
      !Number.isFinite(dayTimestamp(startDay)) || !Number.isFinite(dayTimestamp(endDay)) ||
      !GB_REMINDER_OFFSETS.includes(offset)) throw new Error("Invalid GB reminder key");
  // State branch contains no product names, but keeps a durable, deterministic alert fingerprint.
  return createHash("sha256")
    .update(`gb:watcher:v2:${source}:${nameKey(name)}:${startDay}:${endDay}:${offset}`)
    .digest("hex");
}

function maybeDue(source, name, startDay, endDay, category, today) {
  if (!nameKey(name) || !Number.isFinite(dayTimestamp(startDay)) ||
      !Number.isFinite(dayTimestamp(endDay)) || daysUntil(startDay, endDay) < 0 ||
      daysUntil(startDay, today) < 0) return null;
  const offset = daysUntil(today, endDay);
  if (!GB_REMINDER_OFFSETS.includes(offset)) return null;
  return {
    key: reminderKey(source, name, startDay, endDay, offset),
    source, name: name.trim(), category, startDay, endDay, offset,
    url: SOURCE_URLS[source],
  };
}

function activeGeonRelease(row) {
  return nameKey(row?.saleType) === "group buy" &&
    nameKey(row?.fixed) === "확정 / fixed" &&
    nameKey(row?.status) === "for sale";
}

// Match only products that are still on the current SWAGKEYS roadmap.
// Removed products or undated/placeholder milestones must not generate reminders.
function activeSwagProducts(state) {
  const products = new Set();
  for (const quarter of Object.values(state.quarters)) {
    if (!Array.isArray(quarter)) throw new Error("Invalid SWAGKEYS roadmap quarter");
    for (const product of quarter) {
      if (typeof product === "string" && nameKey(product)) products.add(nameKey(product));
    }
  }
  return products;
}

function geonDueItems(snapshot, today) {
  const items = [];
  for (const row of snapshot.rows) {
    if (!activeGeonRelease(row)) continue;
    const category = /keycap/i.test(row.type || "") ? "키캡" :
      /keyboard/i.test(row.type || "") ? "키보드" : "GB";
    const item = maybeDue("GEONWORKS", row.product, row.start, row.end, category, today);
    if (item) items.push(item);
  }
  return items;
}

function swagkeysDueItems(snapshot, today) {
  const items = [];
  const listedSwagProducts = activeSwagProducts(snapshot);
  for (const row of Object.values(snapshot.roadmapDates)) {
    if (!row || !listedSwagProducts.has(nameKey(row.product))) continue;
    const category = /^sws\s/i.test(row.product) ? "스위치" : "키캡";
    const item = maybeDue("SWAGKEYS", row.product, row.saleStart, row.saleEnd, category, today);
    if (item) items.push(item);
  }
  return items;
}

const SOURCE_DUE_ITEMS = Object.freeze({
  GEONWORKS: geonDueItems,
  SWAGKEYS: swagkeysDueItems,
});

// Evaluate one vendor in isolation. A vendor whose snapshot is not independently
// verified throws here and nowhere else, so the other vendor keeps notifying.
export function dueGbRemindersForSource(source, snapshot, now = new Date()) {
  if (!Object.hasOwn(SOURCE_DUE_ITEMS, source)) throw new Error("Unsupported GB source");
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error("Invalid reminder clock");
  validateGbSnapshot(source, snapshot, now);
  return SOURCE_DUE_ITEMS[source](snapshot, kstDay(now));
}

function reportSourceStatus(status, options) {
  if (typeof options?.onSourceStatus === "function") {
    options.onSourceStatus(status);
    return;
  }
  if (status.ok) return;
  console.warn(`Keyboard Alert GB ${status.source} deadline check skipped: ${status.error.message}`);
}

// Vendors are fault-isolated: a blocked or stale schedule only loses that vendor's
// reminders, never the other vendor's. Only when every vendor fails is this fatal.
export function dueGbReminders(geonRelease, swagkeys, now = new Date(), options = {}) {
  const snapshots = { GEONWORKS: geonRelease, SWAGKEYS: swagkeys };
  const eligible = [];
  const used = new Set();
  const statuses = [];
  const failures = [];

  for (const source of GB_SOURCES) {
    let items;
    try {
      items = dueGbRemindersForSource(source, snapshots[source], now);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      failures.push({ source, error: failure });
      statuses.push({ source, ok: false, due: 0, error: failure });
      continue;
    }
    statuses.push({ source, ok: true, due: items.length });
    for (const item of items) {
      if (used.has(item.key)) continue;
      used.add(item.key);
      eligible.push(item);
    }
  }

  for (const status of statuses) reportSourceStatus(status, options);

  if (failures.length === GB_SOURCES.length) {
    throw new Error(
      `All GB deadline sources failed; skip deadline notifications (${failures.map(f => `${f.source}: ${f.error.message}`).join("; ")})`,
      { cause: failures[0].error },
    );
  }

  return eligible.sort((a, b) => a.offset - b.offset || a.source.localeCompare(b.source) || a.name.localeCompare(b.name, "ko"));
}

export function emptyReminderState() {
  return { version: 1, entries: {} };
}

export function validateReminderState(value) {
  if (!value || value.version !== 1 || !value.entries || typeof value.entries !== "object" || Array.isArray(value.entries)) {
    throw new Error("GB reminder state has an invalid schema");
  }
  for (const [key, record] of Object.entries(value.entries)) {
    if (!/^[0-9a-f]{64}$/.test(key) || !record || !["reserved", "sent"].includes(record.status) ||
      !Number.isFinite(dayTimestamp(record.day))) {
      throw new Error("GB reminder state contains an invalid entry");
    }
  }
  return value;
}

export function reservedState(state, item, now = new Date()) {
  validateReminderState(state);
  if (Object.hasOwn(state.entries, item.key)) return null;
  return {
    version: 1,
    entries: {
      ...state.entries,
      [item.key]: { status: "reserved", day: kstDay(now), at: now.toISOString() },
    },
  };
}

export function sentState(state, key, now = new Date()) {
  validateReminderState(state);
  if (!state.entries[key] || state.entries[key].status !== "reserved") throw new Error("Missing reserved GB reminder");
  return {
    version: 1,
    entries: {
      ...state.entries,
      [key]: { ...state.entries[key], status: "sent", sentAt: now.toISOString() },
    },
  };
}

export function discordGbReminder(item) {
  const label = item.offset === 0 ? "오늘 마감" : `D-${item.offset}`;
  const embed = {
    title: `⏳ GB ${label} · ${item.name}`.slice(0, 256),
    description: `Keyboard Alert에서 확인한 GB 마감 일정입니다.\n${item.category} · ${item.endDay} (한국시간 기준 날짜)`,
    color: item.offset === 0 ? 0xc2410c : 0x2563eb,
    footer: { text: `Keyboard Alert · ${item.source} GB 마감 알림` },
  };
  if (item.url) embed.url = item.url;
  return { embeds: [embed], allowed_mentions: { parse: [] } };
}
