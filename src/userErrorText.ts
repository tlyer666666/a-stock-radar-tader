const GENERIC = "操作失败，请稍后再试";

function cleanErrorMessage(raw: string): string {
  return raw
    .replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, "")
    .replace(/^\[[A-Z][A-Z0-9_]*\]\s*/, "")
    .trim();
}

export function userErrorText(reason: unknown, fallback?: string): string {
  if (typeof reason === "string") {
    const text = cleanErrorMessage(reason);
    return text || fallback || GENERIC;
  }
  if (reason instanceof Error) {
    const text = cleanErrorMessage(reason.message);
    return text || fallback || GENERIC;
  }
  if (typeof reason === "object" && reason !== null && "message" in reason && typeof (reason as { message?: unknown }).message === "string") {
    const text = cleanErrorMessage((reason as { message: string }).message);
    return text || fallback || GENERIC;
  }
  return fallback || GENERIC;
}
