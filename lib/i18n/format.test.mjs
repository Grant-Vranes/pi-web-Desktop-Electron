import assert from "node:assert/strict";
import test from "node:test";

import { formatRelativeTime, formatUpdatedTime, interpolateMessage, translateMessage, calendarDaysAgo, formatSessionTimestamp, formatDayLabel } from "./format.ts";

test("interpolates string and numeric parameters", () => {
  assert.equal(interpolateMessage("Hello, {name} ({count})", { name: "Pi", count: 2 }), "Hello, Pi (2)");
});

test("falls back to English and returns the key when both are missing", () => {
  assert.equal(translateMessage("zh-CN", "common.ok", { en: { "common.ok": "OK" }, "zh-CN": {} }), "OK");
  assert.equal(translateMessage("zh-CN", "missing.key", { en: {}, "zh-CN": {} }), "missing.key");
});

test("formats relative time using the selected locale", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(formatRelativeTime(new Date("2026-01-01T00:05:00.000Z"), "en", now), "in 5 minutes");
  assert.equal(formatRelativeTime(new Date("2025-12-31T23:00:00.000Z"), "zh-CN", now), "1小时前");
  assert.equal(formatRelativeTime(new Date("2025-12-31T23:00:00.000Z"), "zh-TW", now), "1 小時前");
});

test("calendarDaysAgo counts local calendar days, not 24h windows", () => {
  const now = new Date(2026, 0, 3, 0, 30, 0); // 2026-01-03 00:30 local
  assert.equal(calendarDaysAgo(new Date(2026, 0, 3, 23, 59, 0), now), 0); // same day
  assert.equal(calendarDaysAgo(new Date(2026, 0, 2, 23, 59, 0), now), 1); // yesterday
  assert.equal(calendarDaysAgo(new Date(2025, 11, 31, 12, 0, 0), now), 3); // 3 days ago
  assert.equal(calendarDaysAgo(new Date(2025, 11, 1, 12, 0, 0), now), 33);
});

test("formatSessionTimestamp uses relative time today, datetime with seconds from 1 day ago", () => {
  const now = new Date(2026, 0, 3, 12, 0, 0); // 2026-01-03 noon local
  // Same day — relative
  assert.equal(formatSessionTimestamp(new Date(2026, 0, 3, 8, 0, 0), "en", now), "4 hours ago");
  // 1 day ago — absolute datetime with seconds
  const oneDay = formatSessionTimestamp(new Date(2026, 0, 2, 8, 9, 7), "en", now);
  assert.match(oneDay, /2026/);
  assert.doesNotMatch(oneDay, /day ago/);
  // 3 days ago — absolute datetime with seconds
  const threeDays = formatSessionTimestamp(new Date(2025, 11, 31, 8, 9, 7), "en", now);
  assert.match(threeDays, /2025/);
  assert.doesNotMatch(threeDays, /day ago/);
  // Chinese fallback for 1 day ago
  const zhOneDay = formatSessionTimestamp(new Date(2026, 0, 2, 5, 4, 3), "zh-CN", now);
  assert.match(zhOneDay, /2026/);
  assert.doesNotMatch(zhOneDay, /天前/);
});

test("formatDayLabel returns today/yesterday/N-days-ago/date", () => {
  const now = new Date(2026, 0, 3, 12, 0, 0); // 2026-01-03 noon local
  const labels = {
    today: "Today",
    yesterday: "Yesterday",
    daysAgo: (n) => n === 1 ? "1 day ago" : `${n} days ago`,
  };
  assert.equal(formatDayLabel(new Date(2026, 0, 3, 8, 0, 0), "en", now, labels), "Today");
  assert.equal(formatDayLabel(new Date(2026, 0, 2, 23, 59, 0), "en", now, labels), "1 day ago");
  assert.equal(formatDayLabel(new Date(2025, 11, 31, 8, 0, 0), "en", now, labels), "3 days ago");
  // Beyond 3 days -> absolute date
  assert.match(formatDayLabel(new Date(2025, 11, 30, 8, 0, 0), "en", now, labels), /2025/);
});

test("formatDayLabel falls back to built-in Chinese labels", () => {
  const now = new Date(2026, 0, 3, 12, 0, 0);
  assert.equal(formatDayLabel(new Date(2026, 0, 3, 8, 0, 0), "zh-CN", now), "今天");
  assert.equal(formatDayLabel(new Date(2026, 0, 2, 23, 59, 0), "zh-CN", now), "1天前");
  assert.equal(formatDayLabel(new Date(2025, 11, 31, 8, 0, 0), "zh-CN", now), "3天前");
});

test("shows a clock time today and a relative day for earlier updates", () => {
  const now = new Date(2026, 8, 22, 21, 18, 0);
  const today = new Date(2026, 8, 22, 9, 5, 0);
  const earlier = new Date(2026, 8, 19, 21, 18, 0);
  assert.equal(
    formatUpdatedTime(today.getTime(), "zh-CN", now),
    today.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
  );
  assert.equal(formatUpdatedTime(earlier.getTime(), "zh-CN", now), "3天前");
  assert.equal(formatUpdatedTime(earlier.getTime(), "en", now), "3 days ago");
  assert.equal(formatUpdatedTime(earlier.getTime(), "zh-TW", now), "3 天前");
});
