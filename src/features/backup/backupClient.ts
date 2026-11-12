/** 数据备份的渲染进程部分：收集 / 写回本软件在浏览器本地存储里的数据，并定时自动备份。 */
import { useEffect } from "react";

export type BackupFile = { name: string; size: number };
export type BackupStatus = {
  folder: string; auto: boolean; keep: number; lastBackupAt: string; lastError: string; hasPassword: boolean;
  files: BackupFile[]; suggestions: Array<{ label: string; path: string }>;
};
export type BackupApi = {
  status(): Promise<BackupStatus>;
  chooseFolder(): Promise<BackupStatus>;
  configure(patch: { suggestedFolder?: string; auto?: boolean; keep?: number; password?: string }): Promise<BackupStatus>;
  run(local: Record<string, string>, options?: { reason?: "auto" | "manual" }): Promise<{ name: string; size: number; status: BackupStatus }>;
  inspect(name: string, password?: string): Promise<{ createdAt: string; appVersion: string; stores: string[]; localKeys: number }>;
  restore(name: string, password?: string): Promise<{ createdAt: string; stores: string[]; local: Record<string, string> }>;
  relaunch(): Promise<{ ok: boolean }>;
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

/** 恢复：先清掉本软件的旧键，再写回备份里的键（其他网站/程序的键不动）。 */
export function restoreLocalData(local: Record<string, string>, storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage): number {
  if (!storage) return 0;
  const old: string[] = [];
  for (let index = 0; index < storage.length; index += 1) { const key = storage.key(index); if (key && isAppLocalKey(key)) old.push(key); }
  for (const key of old) storage.removeItem(key);
  let written = 0;
  for (const [key, value] of Object.entries(local)) {
    if (!isAppLocalKey(key) || typeof value !== "string") continue;
    storage.setItem(key, value);
    written += 1;
  }
  return written;
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
        if (!warned && !stopped) onError(`自动备份失败：${error instanceof Error ? error.message.replace(/^\[[A-Z_]+\]\s*/, "") : String(error)}`);
        warned = true;
      }
    };
    const first = window.setTimeout(() => void tick(), 60_000);
    const timer = window.setInterval(() => void tick(), 3600_000);
    return () => { stopped = true; window.clearTimeout(first); window.clearInterval(timer); };
  }, []);
}
