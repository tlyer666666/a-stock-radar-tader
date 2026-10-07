const LAST_GOOD_SUFFIX = ":last-good";
type StoredValueValidator = (value: unknown) => boolean;

// A parseable JSON value can still be the wrong kind of document. The existing
// fallback is the caller's top-level schema (array, record, or primitive).
const sameStoredShape = (expected: unknown): StoredValueValidator => (value) => {
  if (expected === null) return value === null;
  if (Array.isArray(expected)) return Array.isArray(value);
  if (typeof expected === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  return typeof value === typeof expected;
};

const parseStoredValue = <T>(value: string | null, validate: StoredValueValidator): { ok: true; value: T } | { ok: false } => {
  if (value === null) return { ok: false };
  try {
    const parsed: unknown = JSON.parse(value);
    return validate(parsed) ? { ok: true, value: parsed as T } : { ok: false };
  } catch {
    return { ok: false };
  }
};

export const loadSafeLocalJson = <T>(key: string, fallback: T, validate = sameStoredShape(fallback)): T => {
  try {
    const primary = parseStoredValue<T>(window.localStorage.getItem(key), validate);
    if (primary.ok) return primary.value;
    const backup = parseStoredValue<T>(window.localStorage.getItem(`${key}${LAST_GOOD_SUFFIX}`), validate);
    return backup.ok ? backup.value : fallback;
  } catch {
    return fallback;
  }
};

export const saveSafeLocalJson = (key: string, value: unknown, validate = sameStoredShape(value)): boolean => {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string" || !parseStoredValue(serialized, validate).ok) return false;
    const backupKey = `${key}${LAST_GOOD_SUFFIX}`;
    const primary = window.localStorage.getItem(key);
    const primaryIsValid = parseStoredValue(primary, validate).ok;
    const backupIsValid = parseStoredValue(window.localStorage.getItem(backupKey), validate).ok;

    if (primaryIsValid && primary !== null) {
      window.localStorage.setItem(backupKey, primary);
    }
    // The primary write is the commit point. A failed save must never become
    // a different configuration on reload through an uncommitted backup.
    window.localStorage.setItem(key, serialized);
    if (!primaryIsValid && !backupIsValid) {
      try { window.localStorage.setItem(backupKey, serialized); }
      catch { /* The primary is already committed; a backup quota failure is optional. */ }
    }
    return true;
  } catch {
    return false;
  }
};
