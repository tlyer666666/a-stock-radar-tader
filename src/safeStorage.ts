const LAST_GOOD_SUFFIX = ":last-good";

const parseStoredValue = <T>(value: string | null): { ok: true; value: T } | { ok: false } => {
  if (value === null) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(value) as T };
  } catch {
    return { ok: false };
  }
};

export const loadSafeLocalJson = <T>(key: string, fallback: T): T => {
  try {
    const primary = parseStoredValue<T>(window.localStorage.getItem(key));
    if (primary.ok) return primary.value;
    const backup = parseStoredValue<T>(window.localStorage.getItem(`${key}${LAST_GOOD_SUFFIX}`));
    return backup.ok ? backup.value : fallback;
  } catch {
    return fallback;
  }
};

export const saveSafeLocalJson = (key: string, value: unknown): boolean => {
  try {
    const serialized = JSON.stringify(value);
    const backupKey = `${key}${LAST_GOOD_SUFFIX}`;
    const primary = window.localStorage.getItem(key);
    const primaryIsValid = parseStoredValue(primary).ok;
    const backupIsValid = parseStoredValue(window.localStorage.getItem(backupKey)).ok;

    if (primaryIsValid && primary !== null) {
      window.localStorage.setItem(backupKey, primary);
    } else if (!backupIsValid) {
      // On the first write, stage the recoverable copy before publishing the
      // primary value. If the second write fails, valid data still survives.
      window.localStorage.setItem(backupKey, serialized);
    }
    window.localStorage.setItem(key, serialized);
    return true;
  } catch {
    return false;
  }
};
