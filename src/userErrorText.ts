const GENERIC = "操作失败，请稍后再试";

export function userErrorText(reason: unknown, fallback?: string): string {
  if (!(reason instanceof Error)) return fallback ?? String(reason);
  const text = reason.message
    .replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, "")
    .replace(/^\[[A-Z][A-Z0-9_]*\]\s*/, "")
    .trim();
  return text || fallback || GENERIC;
}
