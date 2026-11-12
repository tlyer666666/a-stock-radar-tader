import marketCalendar from "../../../config/a-share-market-calendar.json";

/**
 * 随心记：随手记下的想法，可选一个提醒时间（和重复规则）、可关联一只股票。
 * 时间一律按北京时间理解；存储用 ISO 时间戳。只保存在本机。
 */
export type NoteRepeat = "none" | "tradingDays" | "daily" | "weekly";
export type NoteStock = { code: string; name: string; secid: string };
export type Note = {
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  /** 下一次提醒时间（ISO）；没有提醒为 null。 */
  remindAt: string | null;
  repeat: NoteRepeat;
  stock: NoteStock | null;
  done: boolean;
  /** 最近一次已经提醒过的那个时间点（ISO）；等于 remindAt 说明这次已提醒、等你处理。 */
  firedFor: string | null;
};
export type NotesStore = { notes: Note[]; voice: boolean; systemNotify: boolean };

export const NOTES_KEY = "a-stock-radar:notes:v1";
export const MAX_NOTES = 1000;
export const MAX_NOTE_LENGTH = 2000;
export const EMPTY_NOTES: NotesStore = { notes: [], voice: true, systemNotify: true };
export const REPEAT_LABELS: Record<NoteRepeat, string> = { none: "不重复", tradingDays: "每个交易日", daily: "每天", weekly: "每周" };

const CN_OFFSET = 8 * 3600_000;
const DAY = 86400_000;
const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** 北京时间的「日期 + 分钟」拆分与拼回。 */
export function cnParts(ms: number) {
  const d = new Date(ms + CN_OFFSET);
  return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() };
}
export function cnTime(date: string, minutes: number): number {
  return Date.parse(`${date}T00:00:00Z`) - CN_OFFSET + minutes * 60_000;
}
const addDays = (date: string, days: number) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);
const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay();

const closed: Array<[string, string]> = (marketCalendar as unknown as { closedRanges: Array<[string, string]> }).closedRanges;
export function isTradingDay(date: string): boolean {
  const weekday = weekdayOf(date);
  if (weekday === 0 || weekday === 6) return false;
  return !closed.some(([from, to]) => date >= from && date <= to);
}
/** date 当天（含）之后的第一个交易日。 */
export function tradingDayOnOrAfter(date: string): string {
  let day = date;
  for (let guard = 0; guard < 40 && !isTradingDay(day); guard += 1) day = addDays(day, 1);
  return day;
}
export const nextTradingDay = (date: string) => tradingDayOnOrAfter(addDays(date, 1));

/** 重复提醒的下一次：严格晚于 after。 */
export function nextOccurrence(remindAt: number, repeat: NoteRepeat, after: number): number | null {
  if (repeat === "none") return null;
  const { date, minutes } = cnParts(remindAt);
  let day = date;
  for (let guard = 0; guard < 800; guard += 1) {
    day = repeat === "weekly" ? addDays(day, 7) : repeat === "tradingDays" ? nextTradingDay(day) : addDays(day, 1);
    const at = cnTime(day, minutes);
    if (at > after) return at;
  }
  return null;
}

export function formatRemind(iso: string | null, now = Date.now()): string {
  if (!iso) return "";
  const at = Date.parse(iso);
  const target = cnParts(at), today = cnParts(now);
  const hm = `${String(Math.floor(target.minutes / 60)).padStart(2, "0")}:${String(target.minutes % 60).padStart(2, "0")}`;
  const diff = Math.round((Date.parse(`${target.date}T00:00:00Z`) - Date.parse(`${today.date}T00:00:00Z`)) / DAY);
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][target.weekday];
  const day = diff === 0 ? "今天" : diff === 1 ? "明天" : diff === 2 ? "后天" : diff === -1 ? "昨天"
    : `${Number(target.date.slice(5, 7))}月${Number(target.date.slice(8, 10))}日${target.date.slice(0, 4) !== today.date.slice(0, 4) ? `（${target.date.slice(0, 4)}）` : ""}`;
  return `${day}${diff >= 0 && diff <= 6 && diff > 1 ? `（${week}）` : ""} ${hm}`;
}

// ---------- 从输入的文字里识别提醒时间和股票 ----------

export type ParsedRemind = { at: number; label: string; repeat: NoteRepeat };
const CN_NUM: Record<string, number> = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
function cnNumber(text: string): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  if (!text || [...text].some(ch => !(ch in CN_NUM))) return null;
  if (text === "十") return 10;
  if (text.startsWith("十")) return 10 + (CN_NUM[text[1]!] ?? 0);
  if (text.includes("十")) { const [a, b] = text.split("十"); return (CN_NUM[a!] ?? 1) * 10 + (b ? CN_NUM[b] ?? 0 : 0); }
  return text.length === 1 ? CN_NUM[text]! : null;
}
const NUM = "[0-9零〇一二两三四五六七八九十]{1,3}";
const WEEK: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 日: 0, 天: 0 };
/** 交易时段的常用说法 → 分钟。 */
const SESSION_WORDS: Array<[RegExp, number, string]> = [
  [/集合竞价|竞价/, 9 * 60 + 15, "集合竞价 09:15"],
  [/开盘前|盘前/, 9 * 60 + 15, "开盘前 09:15"],
  [/开盘后|一开盘|开盘/, 9 * 60 + 30, "开盘 09:30"],
  [/午盘前|上午收盘|中午收盘|午休/, 11 * 60 + 25, "上午收盘前 11:25"],
  [/午后开盘|下午开盘|午盘|下午一开/, 13 * 60, "下午开盘 13:00"],
  [/尾盘|收盘前/, 14 * 60 + 45, "尾盘 14:45"],
  [/收盘后|盘后|收盘/, 15 * 60 + 5, "收盘后 15:05"]
];

/**
 * 识别「明天开盘前看一下」「周五 14:30 卖出」「下个交易日竞价」「30 分钟后」「每个交易日尾盘」之类的说法。
 * 识别不到返回 null（不提醒）；识别到的只是建议，界面上可以改。
 */
export function parseRemind(text: string, now = Date.now()): ParsedRemind | null {
  const s = text.replace(/\s+/g, "");
  const today = cnParts(now);
  const relative = s.match(new RegExp(`(${NUM}|半)(个)?(分钟|小时|钟头)(以?后|之后)`));
  if (relative) {
    const n = relative[1] === "半" ? 0.5 : cnNumber(relative[1]!);
    if (n && n > 0) {
      const minutes = relative[3] === "分钟" ? n : n * 60;
      return { at: now + Math.round(minutes) * 60_000, label: `${relative[1]}${relative[3]}后`, repeat: "none" };
    }
  }
  const repeat: NoteRepeat = /每个?交易日/.test(s) ? "tradingDays" : /每天|每日/.test(s) ? "daily" : /每周|每星期|每礼拜/.test(s) ? "weekly" : "none";

  let date: string | null = null;
  let dateLabel = "";
  let tradingDate = false;
  const md = s.match(new RegExp(`(?:(${NUM})月)?(${NUM})[日号]`));
  const week = s.match(/(下个?|这个?|本)?(?:周|星期|礼拜)([一二三四五六日天])/);
  if (/下一?个交易日|下个交易日/.test(s)) { date = nextTradingDay(today.date); dateLabel = "下个交易日"; tradingDate = true; }
  else if (/大后天/.test(s)) { date = addDays(today.date, 3); dateLabel = "大后天"; }
  else if (/后天/.test(s)) { date = addDays(today.date, 2); dateLabel = "后天"; }
  else if (/明天|明日|明早|明晚/.test(s)) { date = addDays(today.date, 1); dateLabel = "明天"; }
  else if (/今天|今日|今晚|今早|待会|等会/.test(s)) { date = today.date; dateLabel = "今天"; }
  else if (week) {
    const target = WEEK[week[2]!]!;
    if (week[1]?.startsWith("下")) {
      // 下周X：下一个周一起算的那一周（周一为一周第一天）。
      const toMonday = (8 - today.weekday) % 7 || 7;
      date = addDays(today.date, toMonday + (target === 0 ? 6 : target - 1));
    } else {
      date = addDays(today.date, (target - today.weekday + 7) % 7);
    }
    dateLabel = `${week[1]?.startsWith("下") ? "下" : ""}周${week[2]}`;
  } else if (md) {
    const month = md[1] ? cnNumber(md[1]) : Number(today.date.slice(5, 7));
    const day = cnNumber(md[2]!);
    if (month && day && month <= 12 && day <= 31) {
      let year = Number(today.date.slice(0, 4));
      let candidate = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      if (candidate < today.date) { year += md[1] ? 1 : 0; candidate = md[1] ? `${year}${candidate.slice(4)}` : addMonth(candidate); }
      date = candidate; dateLabel = `${month}月${day}日`;
    }
  }

  let minutes: number | null = null;
  let timeLabel = "";
  const clock = s.match(/([01]?\d|2[0-3])[:：]([0-5]\d)/);
  const dian = s.match(new RegExp(`(早上|上午|中午|下午|晚上|今晚|明晚|傍晚)?(${NUM})点(半|(${NUM})分?|一刻|三刻)?`));
  if (clock) { minutes = Number(clock[1]) * 60 + Number(clock[2]); }
  else if (dian) {
    let hour = cnNumber(dian[2]!);
    if (hour !== null && hour <= 24) {
      const part = dian[1] || (/今晚|明晚/.test(s) ? "晚上" : "");
      if ((part === "下午" || part === "晚上" || part === "今晚" || part === "明晚" || part === "傍晚") && hour < 12) hour += 12;
      if (part === "中午" && hour < 6) hour += 12;
      if (!part && hour >= 1 && hour <= 6) hour += 12; // 「3点」默认下午三点（A 股交易时段）
      const extra = dian[3] === "半" ? 30 : dian[3] === "一刻" ? 15 : dian[3] === "三刻" ? 45 : dian[4] ? cnNumber(dian[4]) ?? 0 : 0;
      minutes = (hour % 24) * 60 + Math.min(59, extra);
    }
  }
  if (minutes !== null) timeLabel = `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
  else {
    const hit = SESSION_WORDS.find(([pattern]) => pattern.test(s));
    if (hit) { minutes = hit[1]; timeLabel = hit[2]; tradingDate = true; }
    else if (/早上|上午|明早|今早/.test(s)) { minutes = 9 * 60; timeLabel = "09:00"; }
    else if (/晚上|今晚|明晚/.test(s)) { minutes = 20 * 60; timeLabel = "20:00"; }
  }

  if (date === null && minutes === null) return repeat === "none" ? null : { at: firstAt(repeat, today.date, 9 * 60 + 15, now), label: `${REPEAT_LABELS[repeat]} 09:15`, repeat };
  if (minutes === null) { minutes = 9 * 60 + 15; timeLabel = "09:15"; }
  if (date === null) {
    // 只说了时间：今天这个时间还没过就今天，否则下一天；交易时段说法跳到交易日。
    date = cnTime(today.date, minutes) > now ? today.date : addDays(today.date, 1);
    if (tradingDate || repeat === "tradingDays") date = tradingDayOnOrAfter(date);
    dateLabel = "";
  } else if (tradingDate && !isTradingDay(date)) {
    date = tradingDayOnOrAfter(date);
  }
  if (repeat !== "none") {
    const at = firstAt(repeat, date, minutes, now);
    return { at, label: `${REPEAT_LABELS[repeat]} ${timeLabel}`, repeat };
  }
  let at = cnTime(date, minutes);
  // 「周五 14:30」在周五 15 点说：指下周五。
  if (at <= now && week && !week[1]) at += 7 * DAY;
  return { at, label: `${dateLabel ? `${dateLabel} ` : ""}${timeLabel}`.trim(), repeat };
}
function addMonth(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return `${next}-${String(d).padStart(2, "0")}`;
}
function firstAt(repeat: NoteRepeat, date: string, minutes: number, now: number): number {
  let day = repeat === "tradingDays" ? tradingDayOnOrAfter(date) : date;
  let at = cnTime(day, minutes);
  if (at <= now) { const next = nextOccurrence(at, repeat, now); if (next) at = next; else { day = addDays(day, 1); at = cnTime(day, minutes); } }
  return at;
}

/** 文字里的 6 位 A 股代码（第一个）。 */
export function detectStockCode(text: string): string | null {
  const match = text.match(/(?<!\d)([03689]\d{5})(?!\d)/);
  return match ? match[1]! : null;
}

/** 常用快捷提醒时间。 */
export function presetTimes(now = Date.now()): Array<{ id: string; label: string; at: number }> {
  const today = cnParts(now);
  const tradeToday = isTradingDay(today.date);
  const next = nextTradingDay(today.date);
  const list: Array<{ id: string; label: string; at: number }> = [{ id: "1h", label: "1 小时后", at: now + 3600_000 }];
  if (tradeToday && today.minutes < 14 * 60 + 45) list.push({ id: "tail", label: "今天尾盘 14:45", at: cnTime(today.date, 14 * 60 + 45) });
  if (tradeToday && today.minutes < 15 * 60 + 5) list.push({ id: "close", label: "今天收盘后 15:05", at: cnTime(today.date, 15 * 60 + 5) });
  list.push({ id: "tonight", label: "今晚 20:00", at: cnTime(today.minutes < 20 * 60 ? today.date : addDays(today.date, 1), 20 * 60) });
  list.push({ id: "next-auction", label: `${next === addDays(today.date, 1) ? "明天" : "下个交易日"}竞价 09:15`, at: cnTime(next, 9 * 60 + 15) });
  list.push({ id: "next-close", label: `${next === addDays(today.date, 1) ? "明天" : "下个交易日"}尾盘 14:45`, at: cnTime(next, 14 * 60 + 45) });
  return list.filter(item => item.at > now);
}

// ---------- 存储与到期 ----------

export function normalizeNote(value: unknown): Note | null {
  if (!isRecord(value)) return null;
  const text = String(value.text ?? "").slice(0, MAX_NOTE_LENGTH);
  if (!text.trim()) return null;
  const iso = (input: unknown) => typeof input === "string" && Number.isFinite(Date.parse(input)) ? new Date(Date.parse(input)).toISOString() : null;
  const repeat: NoteRepeat = value.repeat === "tradingDays" || value.repeat === "daily" || value.repeat === "weekly" ? value.repeat : "none";
  const stockRaw = isRecord(value.stock) ? value.stock : null;
  const code = stockRaw ? String(stockRaw.code || "") : "";
  const stock = /^\d{6}$/.test(code)
    ? { code, name: String(stockRaw!.name || code).slice(0, 16), secid: /^[01]\.\d{6}$/.test(String(stockRaw!.secid)) ? String(stockRaw!.secid) : `${code.startsWith("6") || code.startsWith("9") ? "1" : "0"}.${code}` }
    : null;
  const createdAt = iso(value.createdAt) || new Date(0).toISOString();
  const remindAt = iso(value.remindAt);
  return {
    id: String(value.id || createdAt).slice(0, 40), text, createdAt, updatedAt: iso(value.updatedAt) || createdAt,
    remindAt, repeat: remindAt ? repeat : "none", stock, done: value.done === true, firedFor: iso(value.firedFor)
  };
}

export function normalizeNotes(value: unknown): NotesStore {
  if (!isRecord(value)) return { ...EMPTY_NOTES, notes: [] };
  const seen = new Set<string>();
  const notes = (Array.isArray(value.notes) ? value.notes : []).map(normalizeNote)
    .filter((note): note is Note => Boolean(note) && !seen.has(note!.id) && Boolean(seen.add(note!.id)))
    .slice(0, MAX_NOTES);
  return { notes, voice: value.voice !== false, systemNotify: value.systemNotify !== false };
}

/** 到期且还没提醒过的。 */
export function dueToFire(notes: Note[], now: number): Note[] {
  return notes.filter(note => !note.done && note.remindAt && Date.parse(note.remindAt) <= now && note.firedFor !== note.remindAt);
}
/** 提醒过、还等你处理的（不重复的提醒）。 */
export function awaiting(notes: Note[]): Note[] {
  return notes.filter(note => !note.done && note.remindAt && note.firedFor === note.remindAt);
}

/** 提醒发出后：不重复的停在「已提醒、待处理」；重复的直接排到下一次。 */
export function markFired(note: Note, now: number): Note {
  if (!note.remindAt) return note;
  if (note.repeat !== "none") {
    const next = nextOccurrence(Date.parse(note.remindAt), note.repeat, now);
    return { ...note, remindAt: next ? new Date(next).toISOString() : null, firedFor: null };
  }
  return { ...note, firedFor: note.remindAt };
}

export function snooze(note: Note, at: number): Note {
  return { ...note, remindAt: new Date(at).toISOString(), firedFor: null, done: false, updatedAt: new Date().toISOString() };
}

/** 列表顺序：等你处理的 → 有提醒的按时间先后 → 没提醒的按新到旧 → 已完成。 */
export function sortNotes(notes: Note[]): Note[] {
  const rank = (note: Note) => note.done ? 3 : note.remindAt && note.firedFor === note.remindAt ? 0 : note.remindAt ? 1 : 2;
  return [...notes].sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 1 ? Date.parse(a.remindAt!) - Date.parse(b.remindAt!) : Date.parse(b.updatedAt) - Date.parse(a.updatedAt)));
}
