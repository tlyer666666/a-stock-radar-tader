const SHANGHAI_TIME_ZONE = "Asia/Shanghai";

const shanghaiDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHANGHAI_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit"
});

export function shanghaiDateTag(date = new Date()): string {
  return shanghaiDateFormatter.format(date);
}

export function shiftShanghaiDate(years: number, date = new Date()): string {
  const currentTag = shanghaiDateTag(date);
  const [year = 1970, month = 1, day = 1] = currentTag.split("-").map(Number);
  const targetYear = year + years;
  const lastDay = new Date(Date.UTC(targetYear, month, 0)).getUTCDate();
  const shifted = new Date(Date.UTC(targetYear, month - 1, Math.min(day, lastDay)));
  return shifted.toISOString().slice(0, 10);
}
