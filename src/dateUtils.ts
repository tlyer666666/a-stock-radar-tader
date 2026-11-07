/**
 * 交易日与行情时间统一使用北京时间（Asia/Shanghai）。
 *
 * ── B-04：为什么所有展示时间也必须显式指定 timeZone ─────────────────────────
 * 行情快照、资讯、复盘等位置原先用裸 toLocale* 格式化，跟随操作系统时区；
 * 而本文件的交易日标签、以及各页「是否收盘」判定固定按 Asia/Shanghai。
 * 在非 UTC+8 的机器（差旅、云桌面、海外）上同一屏会出现「时间显示 10:32（本地）」
 * 与「状态已写收盘未回封（北京时间）」相互矛盾。下面三个函数把展示口径固定为
 * 北京时间：无论本机在哪个时区，用户看到的始终是北京时间的钟点与日期。
 *
 * ── B-11：非法/缺失时间戳统一兜底 ───────────────────────────────────────────
 * 非法输入不再渲染 "Invalid Date"，统一返回 fallback（默认 "--"）。
 */
const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

export type DateTimeInput = string | number | Date | null | undefined;

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHANGHAI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

const shanghaiTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: SHANGHAI_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

const shanghaiDateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  timeZone: SHANGHAI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23"
});

function toShanghaiDate(value: DateTimeInput): Date | null {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

/** 北京时间的日期标签（YYYY-MM-DD），非法输入返回 fallback。 */
export function shanghaiDateTag(value?: DateTimeInput | Date, fallback = new Date()): string {
  const date = toShanghaiDate(value ?? fallback) ?? toShanghaiDate(fallback);
  return date ? shanghaiDateFormatter.format(date) : "--";
}

/** 仅时间（HH:mm:ss，北京时间）；非法/缺失返回 fallback。 */
export function formatShanghaiTime(value: DateTimeInput, fallback = "--"): string {
  const date = toShanghaiDate(value);
  return date ? shanghaiTimeFormatter.format(date) : fallback;
}

/** 日期 + 时间（YYYY/MM/DD HH:mm:ss，北京时间）；非法/缺失返回 fallback。 */
export function formatShanghaiDateTime(value: DateTimeInput, fallback = "--"): string {
  const date = toShanghaiDate(value);
  return date ? shanghaiDateTimeFormatter.format(date) : fallback;
}

/** 日期（YYYY-MM-DD，北京时间）；非法/缺失返回 fallback。 */
export function formatShanghaiDate(value: DateTimeInput, fallback = "--"): string {
  const date = toShanghaiDate(value);
  return date ? shanghaiDateFormatter.format(date) : fallback;
}

/** Use the snapshot timestamp's trading day, or the current Shanghai day when absent/invalid. */
export function shanghaiDateTagFrom(value: string | undefined, fallback = new Date()): string {
  const parsed = value ? new Date(value) : fallback;
  return shanghaiDateTag(Number.isFinite(parsed.getTime()) ? parsed : fallback);
}

export function shiftShanghaiDate(years: number, date = new Date()): string {
  const currentTag = shanghaiDateTag(date);
  const [year = 1970, month = 1, day = 1] = currentTag.split("-").map(Number);
  const targetYear = year + years;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  const shifted = new Date(Date.UTC(targetYear, month - 1, Math.min(day, lastDay)));
  return shifted.toISOString().slice(0, 10);
}

/** 快讯时间统一显示北京时间「MM-DD HH:mm」：带时区（如财联社的 UTC 时间）先换算，不带时区的本来就是北京时间。 */
export function newsTimeText(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text) return "--";
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(text)) return text.replace("T", " ").slice(5, 16);
  const formatted = formatShanghaiDateTime(text, "");
  return formatted ? formatted.slice(5, 16).replace("/", "-") : text.slice(5, 16);
}
