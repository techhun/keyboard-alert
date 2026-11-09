import { createHash } from "node:crypto";

export const GB_REMINDER_OFFSETS = Object.freeze([3, 1, 0]);
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

function titleFrom(page) {
  const title = page?.properties?.["이름"];
  if (title?.type !== "title" || !Array.isArray(title.title)) return "";
  return title.title.map(part => part?.plain_text ?? part?.text?.content ?? "").join("").trim();
}

function safeLink(candidate) {
  try {
    const url = new URL(candidate);
    return (url.protocol === "https:" || url.protocol === "http:") ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

// Match the source already recorded in Keyboard Alert's Keepodd GB event feed.
// Do not infer a seller from the manufacturer, a vague product URL, or name similarity.
function gbNameKey(value) {
  return typeof value === "string"
    ? value.normalize("NFKC").trim().toLocaleLowerCase("en").replace(/\s+/g, " ")
    : "";
}

export function gbReminderSource(page, sourcedEvents = []) {
  if (!Array.isArray(sourcedEvents)) throw new Error("GB source event data must be an array");
  const name = gbNameKey(titleFrom(page));
  const period = page?.properties?.["판매 일정"];
  const saleStart = period?.type === "date" ? dateDay(period.date?.start) : null;
  const saleEnd = period?.type === "date" ? dateDay(period.date?.end) : null;
  if (!name || !saleStart || !saleEnd) return undefined;

  const sources = new Set();
  for (const event of sourcedEvents) {
    if (!event || !["GEONWORKS", "SWAGKEYS"].includes(event.source)) continue;
    if (gbNameKey(event.name) !== name || event.saleStart !== saleStart) continue;
    // The event may omit its end date, but may not contradict the confirmed Keepodd end date.
    if (event.saleEnd && event.saleEnd !== saleEnd) continue;
    sources.add(event.source);
  }
  return sources.size === 1 ? [...sources][0] : undefined;
}

export function reminderKey(pageId, endDay, offset) {
  if (typeof pageId !== "string" || !pageId || !Number.isFinite(dayTimestamp(endDay)) || !GB_REMINDER_OFFSETS.includes(offset)) {
    throw new Error("Invalid GB reminder key");
  }
  // The public, separately maintained state branch never stores product names or Notion page IDs.
  return createHash("sha256").update(`gb:v1:${pageId}:${endDay}:${offset}`).digest("hex");
}

export function dueGbReminders(pagesByCategory, now = new Date(), sourcedEvents = []) {
  const today = kstDay(now);
  const results = [];
  const seen = new Set();

  for (const [category, pages] of Object.entries(pagesByCategory)) {
    if (!Array.isArray(pages)) throw new Error(`Invalid Notion page data for ${category}`);
    for (const page of pages) {
      if (page?.object !== "page" || page?.archived || page?.in_trash) continue;
      if (page?.properties?.["판매 방식"]?.type !== "select" || page.properties["판매 방식"].select?.name !== "GB") continue;
      const schedule = page.properties?.["판매 일정"];
      if (schedule?.type !== "date" || !schedule.date) continue;
      const startDay = dateDay(schedule.date.start);
      const endDay = dateDay(schedule.date.end);
      // No guessed end dates. Do not send alerts for an unstarted GB.
      if (!startDay || !endDay || daysUntil(startDay, endDay) < 0 || daysUntil(startDay, today) < 0) continue;
      const offset = daysUntil(today, endDay);
      if (!GB_REMINDER_OFFSETS.includes(offset)) continue;
      if (offset === 0 && typeof schedule.date.end === "string" && schedule.date.end.includes("T")) {
        const endAt = new Date(schedule.date.end);
        if (Number.isFinite(endAt.getTime()) && endAt.getTime() <= now.getTime()) continue;
      }
      const name = titleFrom(page);
      const source = gbReminderSource(page, sourcedEvents);
      if (!name || !page.id || !source) continue;
      const key = reminderKey(page.id, endDay, offset);
      if (seen.has(key)) continue;
      seen.add(key);

      const linkedUrl = page.properties?.URL?.type === "url" ? safeLink(page.properties.URL.url) : undefined;
      results.push({
        key,
        name,
        source,
        category,
        endDay,
        offset,
        url: linkedUrl || safeLink(page.url),
      });
    }
  }

  return results.sort((a, b) => a.offset - b.offset || a.name.localeCompare(b.name, "ko"));
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
    description: `Keepodd에 등록된 GB의 판매 종료일이 다가왔어요.\n${item.category} · ${item.endDay} (KST 기준 날짜)`,
    color: item.offset === 0 ? 0xc2410c : 0x2563eb,
    footer: { text: `Keepodd · ${item.source} GB 마감 알림` },
  };
  if (item.url) embed.url = item.url;
  return { embeds: [embed], allowed_mentions: { parse: [] } };
}
