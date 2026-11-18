/** 数据备份的渲染进程部分：收集 / 写回本软件在浏览器本地存储里的数据，并定时自动备份。 */
import { useEffect } from "react";
import { pauseSafeLocalWrites } from "../../safeStorage";

export type BackupFile = { name: string; size: number };
export type BackupStatus = {
  folder: string; auto: boolean; keep: number; lastBackupAt: string; lastError: string; hasPassword: boolean;
  files: BackupFile[]; suggestions: Array<{ label: string; path: string }>;
  storageSummary?: {
    userDataBytes: number;
    dailyBarsBytes: number;
    dailyBarsCount: number;
    webCacheBytes: number;
  } | undefined;
};
export type BackupApi = {
  status(): Promise<BackupStatus>;
  chooseFolder(): Promise<BackupStatus>;
  configure(patch: { suggestedFolder?: string; auto?: boolean; keep?: number; password?: string }): Promise<BackupStatus>;
  run(local: Record<string, string>, options?: { reason?: "auto" | "manual" }): Promise<{ name: string; size: number; status: BackupStatus }>;
  inspect(name: string, password?: string): Promise<{ createdAt: string; appVersion: string; stores: string[]; localKeys: number }>;
  prepareRestore(name: string, password?: string): Promise<{ token: string; local: Record<string, string> }>;
  cancelRestore(token: string): Promise<void>;
  restore(token: string): Promise<{ ok: boolean }>;
};

export const isAppLocalKey = (key: string) => key.startsWith("a-stock-radar") || key === "ai-picks-excluded";
export const backupApi = (): BackupApi | undefined => (typeof window === "undefined" ? undefined : (window.stockApi as { backup?: BackupApi } | undefined)?.backup);

export function collectLocalData(storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage): Record<string, string> {
  const result: Record<string, string> = {};
  if (!storage) return result;
  try {
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key || !isAppLocalKey(key)) continue;
      const value = storage.getItem(key);
      if (typeof value === "string") result[key] = value;
    }
  } catch { /* 存储不可用时备份只含主进程数据 */ }
  return result;
}

const LAST_GOOD_SUFFIX = ":last-good";

const readAppLocalEntries = (storage: Storage): Array<[string, string]> => {
  const entries: Array<[string, string]> = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !isAppLocalKey(key)) continue;
    const value = storage.getItem(key);
    if (typeof value === "string") entries.push([key, value]);
  }
  return entries;
};

const clearAppLocalKeys = (storage: Storage) => {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key && isAppLocalKey(key)) keys.push(key);
  }
  for (const key of keys) storage.removeItem(key);
};

const writeAppLocalEntries = (storage: Storage, entries: ReadonlyArray<readonly [string, string]>): number => {
  let written = 0;
  for (const [key, value] of entries) {
    storage.setItem(key, value);
    written += 1;
  }
  return written;
};

const rollbackAppLocalKeys = (storage: Storage, previous: Array<[string, string]>) => {
  try {
    clearAppLocalKeys(storage);
    writeAppLocalEntries(storage, previous);
    return true;
  } catch {
    return false;
  }
};

function localRestoreFailure(storage: Storage, previous: Array<[string, string]>, cause: unknown) {
  const restored = rollbackAppLocalKeys(storage, previous);
  const reason = cause instanceof Error ? cause.message : String(cause);
  return new Error(`恢复本地数据失败，${restored ? "已回滚原数据" : "还原原数据失败，请保留备份文件"}：${reason}`, { cause });
}

/** 恢复：先快照现有数据再清旧键写回，若写回溢出优先剔除 :last-good 重试，仍失败则回滚旧数据并抛错。 */
export function restoreLocalData(local: Record<string, string>, storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage): number {
  if (!storage) return 0;
  const previous = readAppLocalEntries(storage);
  const incoming = Object.entries(local).filter(([key, value]) => isAppLocalKey(key) && typeof value === "string");
  try {
    clearAppLocalKeys(storage);
    return writeAppLocalEntries(storage, incoming);
  } catch (firstError) {
    const withoutLastGood = incoming.filter(([key]) => !key.endsWith(LAST_GOOD_SUFFIX));
    if (withoutLastGood.length < incoming.length) {
      try {
        clearAppLocalKeys(storage);
        return writeAppLocalEntries(storage, withoutLastGood);
      } catch (retryError) {
        throw localRestoreFailure(storage, previous, retryError);
      }
    }
    throw localRestoreFailure(storage, previous, firstError);
  }
}

export async function restoreBackup(api: BackupApi, name: string, password: string, storage = window.localStorage) {
  const { token, local } = await api.prepareRestore(name, password);
  const resumeWrites = pauseSafeLocalWrites();
  let committed = false;
  try {
    const previous = readAppLocalEntries(storage);
    restoreLocalData(local, storage);
    try {
      await api.restore(token);
      committed = true;
    } catch (error) {
      try {
        clearAppLocalKeys(storage);
        writeAppLocalEntries(storage, previous);
      } catch (rollbackError) {
        throw new Error("恢复失败且未能还原本地存储，请保留备份文件", { cause: rollbackError });
      }
      throw error;
    }
  } finally {
    if (!committed) {
      resumeWrites();
      await api.cancelRestore?.(token).catch(() => undefined);
    }
  }
}

const AUTO_INTERVAL_MS = 20 * 3600_000;
export const autoBackupDue = (status: Pick<BackupStatus, "auto" | "folder" | "lastBackupAt">, now = Date.now()) =>
  Boolean(status.auto && status.folder) && (!status.lastBackupAt || now - Date.parse(status.lastBackupAt) >= AUTO_INTERVAL_MS);

/** 每天自动备份一次：打开软件 1 分钟后看一次，之后每小时看一次。只写本机文件夹，不发网络请求。 */
export function useAutoBackup(onError: (message: string) => void) {
  useEffect(() => {
    const api = backupApi();
    if (!api?.status) return;
    let stopped = false, warned = false;
    const tick = async () => {
      try {
        const status = await api.status();
        if (stopped || !autoBackupDue(status)) return;
        await api.run(collectLocalData(), { reason: "auto" });
        warned = false;
      } catch (error) {
        if (error instanceof Error && error.message.startsWith("[BACKUP_BUSY]")) return;
        if (!warned && !stopped) onError(`自动备份失败：${error instanceof Error ? error.message.replace(/^\[[A-Z_]+\]\s*/, "") : String(error)}`);
        warned = true;
      }
    };
    const first = window.setTimeout(() => void tick(), 60_000);
    // Deliberately not visibility-gated: scheduled daily local backup should still run if minimized.
    const timer = window.setInterval(() => void tick(), 3600_000);
    return () => { stopped = true; window.clearTimeout(first); window.clearInterval(timer); };
  }, []);
}
