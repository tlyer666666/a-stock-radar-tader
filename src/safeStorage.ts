const LAST_GOOD_SUFFIX = ":last-good";
const MAX_VERIFIED_CACHE_ENTRIES = 64;
type StoredValueValidator = (value: unknown) => boolean;

type NativeKvApi = {
  kvGet?: ((k: string) => Promise<string | null>) | undefined;
  kvSet?: ((k: string, v: string) => Promise<boolean>) | undefined;
};

const verifiedPrimaryStrings = new Map<string, string>();

const rememberVerifiedPrimary = (key: string, serialized: string): void => {
  if (verifiedPrimaryStrings.has(key)) {
    verifiedPrimaryStrings.delete(key);
  } else if (verifiedPrimaryStrings.size >= MAX_VERIFIED_CACHE_ENTRIES) {
    const oldestKey = verifiedPrimaryStrings.keys().next().value;
    if (oldestKey !== undefined) verifiedPrimaryStrings.delete(oldestKey);
  }
  verifiedPrimaryStrings.set(key, serialized);
};

export function resetSafeStorageCache(): void {
  verifiedPrimaryStrings.clear();
}

const getNativeKvApi = (): NativeKvApi | undefined => {
  if (typeof window === "undefined") return undefined;
  const stockApi = (window as { stockApi?: NativeKvApi | undefined }).stockApi;
  return stockApi && typeof stockApi === "object" ? stockApi : undefined;
};

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
    const primaryRaw = window.localStorage.getItem(key);
    const primary = parseStoredValue<T>(primaryRaw, validate);
    if (primary.ok) {
      if (primaryRaw !== null) rememberVerifiedPrimary(key, primaryRaw);
      return primary.value;
    }
    verifiedPrimaryStrings.delete(key);
    const backup = parseStoredValue<T>(window.localStorage.getItem(`${key}${LAST_GOOD_SUFFIX}`), validate);
    return backup.ok ? backup.value : fallback;
  } catch {
    return fallback;
  }
};

let writesPaused = false;

/** Keep old in-memory state from writing over local data during backup restore. */
export function pauseSafeLocalWrites(): () => void {
  writesPaused = true;
  verifiedPrimaryStrings.clear();
  return () => {
    writesPaused = false;
    verifiedPrimaryStrings.clear();
  };
}

export const saveSafeLocalJson = (key: string, value: unknown, validate = sameStoredShape(value)): boolean => {
  if (writesPaused) return false;
  try {
    if (!validate(value)) return false;
    const serialized = JSON.stringify(value);
    if (typeof serialized !== "string") return false;
    const backupKey = `${key}${LAST_GOOD_SUFFIX}`;
    const existing = window.localStorage.getItem(key);
    const cacheHit = existing !== null && verifiedPrimaryStrings.get(key) === existing;
    const primaryIsValid = cacheHit ? true : parseStoredValue(existing, validate).ok;
    const backupIsValid = cacheHit ? true : parseStoredValue(window.localStorage.getItem(backupKey), validate).ok;
    if (!primaryIsValid) verifiedPrimaryStrings.delete(key);
    try { window.localStorage.setItem(key, serialized); }
    catch (error) {
      // Reclaim only a redundant backup. A sole recoverable backup is retained
      // until a new primary has committed successfully.
      if (!(error instanceof DOMException && error.name === "QuotaExceededError") || !primaryIsValid) throw error;
      window.localStorage.removeItem(backupKey);
      window.localStorage.setItem(key, serialized);
    }
    rememberVerifiedPrimary(key, serialized);
    try {
      if (primaryIsValid && existing !== null) window.localStorage.setItem(backupKey, existing);
      else if (!backupIsValid) window.localStorage.setItem(backupKey, serialized);
    } catch { /* Backup allocation cannot invalidate a successful primary commit. */ }
    return true;
  } catch {
    return false;
  }
};

export function mirrorToNativeKv(key: string, serialized: string): void {
  if (writesPaused) return;
  try {
    const kvSet = getNativeKvApi()?.kvSet;
    if (typeof kvSet !== "function") return;
    void Promise.resolve(kvSet(key, serialized)).catch(() => undefined);
  } catch {
    // Ignore bridge errors during fire-and-forget mirroring.
  }
}

export async function hydrateFromNativeKv<T>(
  key: string,
  validate: (v: unknown) => v is T,
  storage?: Storage | null,
  options?: { isEmpty?: (v: T) => boolean }
): Promise<T | null> {
  try {
    const kvGet = getNativeKvApi()?.kvGet;
    if (typeof kvGet !== "function") return null;
    const raw = await kvGet(key);
    if (typeof raw !== "string" || !raw) return null;
    const parsed = parseStoredValue<T>(raw, validate);
    if (!parsed.ok) return null;
    const kvEmpty = Boolean(options?.isEmpty?.(parsed.value));
    const targetStorage = storage === undefined ? (typeof window !== "undefined" ? window.localStorage : null) : storage;
    if (targetStorage) {
      let localValid = false;
      let localEmpty = false;
      let localReadOk = false;
      try {
        const localRaw = targetStorage.getItem(key);
        localReadOk = true;
        const localParsed = parseStoredValue<T>(localRaw, validate);
        localValid = localRaw !== null && localParsed.ok;
        localEmpty = localValid && localParsed.ok && Boolean(options?.isEmpty?.(localParsed.value));
      } catch {
        // Storage unavailability should not fail hydration return.
      }
      if (localReadOk) {
        if (localValid && !localEmpty) return null;
        if (localValid && localEmpty && kvEmpty) return null;
        if (!localValid || (localEmpty && !kvEmpty)) {
          try {
            targetStorage.setItem(key, raw);
            rememberVerifiedPrimary(key, raw);
          } catch {
            // Storage write unavailability should not fail hydration return.
          }
        }
      }
    }
    return parsed.value;
  } catch {
    return null;
  }
}
