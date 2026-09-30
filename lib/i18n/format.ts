import type { Locale, TranslationParams } from "./types";

type MessagesByLocale = Record<string, Record<string, string>>;

/**
 * 替换翻译消息中的简单插值占位符。
 * @param message 原始翻译消息
 * @param params 插值参数
 * @returns 完成参数替换后的消息
 */
export function interpolateMessage(message: string, params: TranslationParams = {}): string {
  return message.replace(/\{([\w.-]+)\}/g, (token, name: string) => {
    const value = params[name];
    return value === undefined ? token : String(value);
  });
}

/**
 * 从当前语言和英语语言包中解析消息。
 * @param locale 当前语言
 * @param key 翻译 key
 * @param messages 各语言的消息字典
 * @param params 可选的插值参数
 * @returns 翻译结果，缺失时返回 key
 */
export function translateMessage(
  locale: Locale,
  key: string,
  messages: MessagesByLocale,
  params: TranslationParams = {},
): string {
  const message = messages[locale]?.[key] ?? messages.en?.[key];
  if (message === undefined) {
    if (process.env.NODE_ENV !== "production") console.warn(`[i18n] Missing translation: ${key}`);
    return key;
  }
  return interpolateMessage(message, params);
}

/**
 * 按当前语言格式化相对时间。
 * @param date 要格式化的时间
 * @param locale 当前语言
 * @param now 用于测试或特殊场景的当前时间
 * @returns locale-aware 的相对时间文本
 */
export function formatRelativeTime(date: Date | string, locale: Locale, now = new Date()): string {
  const target = date instanceof Date ? date : new Date(date);
  const diffMs = target.getTime() - now.getTime();
  const absMs = Math.abs(diffMs);
  const [unit, divisor] = absMs < 60_000
    ? ["second", 1_000]
    : absMs < 3_600_000
      ? ["minute", 60_000]
      : absMs < 86_400_000
        ? ["hour", 3_600_000]
        : ["day", 86_400_000];
  const value = Math.round(diffMs / divisor);
  return new Intl.RelativeTimeFormat(locale, { numeric: "always" }).format(value, unit as Intl.RelativeTimeFormatUnit);
}

/** 一天包含的毫秒数，用于按本地日历日计算“几天前”。 */
const MS_PER_DAY = 86_400_000;

/** 超过该天数后改为显示具体日期而非相对时间。 */
const RELATIVE_DAY_LIMIT = 3;

/**
 * 计算 target 与 now 之间相差的本地日历天数（target 早于 now 时为正）。
 * 以本地午夜为日界，而非 24 小时滚动窗口。
 */
export function calendarDaysAgo(date: Date | string, now = new Date()): number {
  const target = date instanceof Date ? new Date(date.getTime()) : new Date(date);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfTarget = new Date(target.getFullYear(), target.getMonth(), target.getDate());
  return Math.round((startOfToday.getTime() - startOfTarget.getTime()) / MS_PER_DAY);
}

/**
 * 会话时间戳显示规则：今天用相对时间，一天及更早用带秒的本地化日期时间。
 * @param date 会话修改时间
 * @param locale 当前语言
 * @param now 用于测试或特殊场景的当前时间
 */
export function formatSessionTimestamp(date: Date | string, locale: Locale, now = new Date()): string {
  const days = calendarDaysAgo(date, now);
  if (days >= 0 && days < TIMESTAMP_ABSOLUTE_DAY_LIMIT) {
    return formatRelativeTime(date, locale, now);
  }
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date instanceof Date ? date : new Date(date));
}

/** 今天之后开始使用绝对日期时间的阈值（按本地日历日计）。 */
const TIMESTAMP_ABSOLUTE_DAY_LIMIT = 1;

/**
 * 会话按天分组的标题文本：今天/昨天/N天前/具体日期。
 * 注意：分组标题仍沿用 ≤3 天的相对文案阈值，与会话项时间戳 {@link formatSessionTimestamp} 的阈值不同。
 * @param date 组内任一会话的时间（通常为最新修改时间）
 * @param locale 当前语言
 * @param now 用于测试或特殊场景的当前时间
 * @param labels 可选的本地化标签覆盖，用于“今天/N天前”文案
 */
export function formatDayLabel(
  date: Date | string,
  locale: Locale,
  now = new Date(),
  labels?: { today?: string; yesterday?: string; daysAgo?: (n: number) => string },
): string {
  const days = calendarDaysAgo(date, now);
  if (days <= 0) return labels?.today ?? defaultTodayLabel(locale);
  if (days <= RELATIVE_DAY_LIMIT) {
    return labels?.daysAgo?.(days) ?? defaultDaysAgoLabel(days, locale);
  }
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date instanceof Date ? date : new Date(date));
}

function defaultTodayLabel(locale: Locale): string {
  return locale === "en" ? "Today" : "今天";
}

function defaultDaysAgoLabel(n: number, locale: Locale): string {
  if (locale === "en") return n === 1 ? "1 day ago" : `${n} days ago`;
  // zh-CN / zh-TW 共用中文“N天前”写法
  return `${n}天前`;
}

/**
 * 今天只显示时刻；更早的时间和会话列表一样用相对时间。
 * @param timestamp 毫秒时间戳
 * @param locale 当前语言
 * @param now 用于测试或特殊场景的当前时间
 * @returns 今天的时刻，或更早时间的相对时间文本
 */
export function formatUpdatedTime(timestamp: number, locale: Locale, now = new Date()): string {
  const target = new Date(timestamp);
  if (Number.isNaN(target.getTime())) return "";
  const isToday = target.getFullYear() === now.getFullYear()
    && target.getMonth() === now.getMonth()
    && target.getDate() === now.getDate();
  if (isToday) return target.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  return formatRelativeTime(target, locale, now);
}
