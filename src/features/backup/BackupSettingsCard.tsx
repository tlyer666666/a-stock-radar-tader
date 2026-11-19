import { useCallback, useEffect, useRef, useState } from "react";
import { Archive, CircleAlert, Cloud, FolderOpen, KeyRound, LoaderCircle, RotateCcw, Save, Trash2 } from "lucide-react";
import { PanelTitle } from "../../components/terminal/TerminalPrimitives";
import { ConfirmDialog, type ConfirmDialogRequest } from "../../components/terminal/ConfirmDialog";
import { backupApi, collectLocalData, restoreBackup, type BackupFile, type BackupStatus } from "./backupClient";

const CLOUD_SYNC_SEGMENT_RE =
  /\/mobile documents\/|\/icloud|\/onedrive|\/dropbox|\/google drive|\/坚果云|\/nutstore|\/baidunetdisk/i;

export function isCloudSyncFolder(folder: string, suggestions: Array<{ path: string }> = []): boolean {
  const trimmed = String(folder || "").trim();
  if (!trimmed) return false;
  const normalized = trimmed.replace(/\\/g, "/").replace(/\/+$/, "");
  if (!normalized) return false;
  const lower = normalized.toLowerCase();
  for (const item of suggestions) {
    const sp = String(item?.path || "").trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    if (!sp) continue;
    if (lower === sp || lower.startsWith(`${sp}/`)) return true;
  }
  return CLOUD_SYNC_SEGMENT_RE.test(`${normalized}/`);
}

const cleanError = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, "").replace(/^\[[A-Z_]+\]\s*/, "");
const sizeText = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const timeText = (iso: string) => {
  if (!iso) return "";
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? new Date(ms + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ") : "--";
};
/** A股雷达备份-20261112-160509.json → 2026-11-12 16:05:09 */
const fileTime = (name: string) => { const m = name.match(/(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/); return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}` : name; };

/**
 * 设置 → 数据备份：选一个文件夹（网盘的同步文件夹最好），每天自动备份、手动备份、从备份恢复。
 * 令牌和 API Key 不进备份；可设备份密码。
 */
export function BackupSettingsCard({ hidden }: { hidden: boolean }) {
  const api = backupApi();
  const [status, setStatus] = useState<BackupStatus | null>(null);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [password, setPassword] = useState("");
  const [editingPassword, setEditingPassword] = useState(false);
  const [allowPlaintextCloud, setAllowPlaintextCloud] = useState(false);
  const [restore, setRestore] = useState<{ file: BackupFile; password: string; needPassword: boolean } | null>(null);
  const [confirmState, setConfirmState] = useState<{
    request: ConfirmDialogRequest;
    kind: "restore" | "cleanup-daily-bars";
  } | null>(null);
  const mountedRef = useRef(true);
  const restoreSeqRef = useRef(0);
  const lastFolderRef = useRef("");

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      restoreSeqRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const currentFolder = status?.folder || "";
    if (currentFolder !== lastFolderRef.current || status?.hasPassword) {
      lastFolderRef.current = currentFolder;
      setAllowPlaintextCloud(false);
    }
  }, [status?.folder, status?.hasPassword]);

  const load = useCallback(async () => {
    if (!api) return;
    try {
      const next = await api.status();
      if (mountedRef.current) setStatus(next);
    } catch (error) {
      if (mountedRef.current) setMessage({ tone: "error", text: cleanError(error) });
    }
  }, [api]);
  useEffect(() => { if (!hidden) void load(); }, [hidden, load]);

  const act = async (label: string, run: () => Promise<BackupStatus | void>, done?: string) => {
    if (busy) return;
    setBusy(label); setMessage(null);
    try {
      const next = await run();
      if (!mountedRef.current) return;
      if (next) setStatus(next);
      if (done) setMessage({ tone: "ok", text: done });
    } catch (error) {
      if (mountedRef.current) setMessage({ tone: "error", text: cleanError(error) });
    } finally {
      if (mountedRef.current) setBusy("");
    }
  };

  if (!api) return <div className="panel settings-card" id="settings-backup" hidden={hidden}>
    <PanelTitle title="数据备份" subtitle="桌面版可用" icon={Archive} /><p className="source-health-note">浏览器预览不能写本机文件夹，请在桌面版设置。</p></div>;

  const confirmRequest = (file: BackupFile): ConfirmDialogRequest => ({
    title: `用 ${fileTime(file.name)} 的备份覆盖现在的数据？`,
    message: "自选、持仓、随心记、做T记录、自定义策略、AI 对话、回测和复盘记录会换成备份里的内容；同一服务地址的 API Key 继续使用本机现有配置。恢复后软件自动重启。",
    details: ["建议先点「立即备份」留一份现在的数据。"], confirmLabel: "恢复并重启", tone: "danger"
  });
  const startRestore = async (file: BackupFile) => {
    if (busy) return;
    const seq = ++restoreSeqRef.current;
    setRestore(null);
    setBusy("inspect"); setMessage(null);
    try {
      await api.inspect(file.name);
      if (!mountedRef.current || restoreSeqRef.current !== seq) return;
      setRestore({ file, password: "", needPassword: false });
      setConfirmState({ request: confirmRequest(file), kind: "restore" });
    } catch (error) {
      if (!mountedRef.current || restoreSeqRef.current !== seq) return;
      const text = cleanError(error);
      if (/密码/.test(text)) setRestore({ file, password: "", needPassword: true });
      else setMessage({ tone: "error", text });
    } finally {
      if (mountedRef.current && restoreSeqRef.current === seq) setBusy("");
    }
  };
  const verifyRestorePassword = async () => {
    if (!restore || !restore.password || busy) return;
    const target = restore;
    const seq = ++restoreSeqRef.current;
    setBusy("verify"); setMessage(null);
    try {
      await api.inspect(target.file.name, target.password);
      if (!mountedRef.current || restoreSeqRef.current !== seq) return;
      setConfirmState({ request: confirmRequest(target.file), kind: "restore" });
    } catch (error) {
      if (!mountedRef.current || restoreSeqRef.current !== seq) return;
      setMessage({ tone: "error", text: cleanError(error) });
    } finally {
      if (mountedRef.current && restoreSeqRef.current === seq) setBusy("");
    }
  };
  const runRestore = async () => {
    if (!restore || busy) return;
    const target = restore;
    await act("restore", async () => {
      await restoreBackup(api, target.file.name, target.password);
      if (mountedRef.current) setMessage({ tone: "ok", text: "已恢复，软件马上重启…" });
    });
  };

  const runCleanup = async (target: "web-cache" | "stale-bars" | "daily-bars" | "legacy-profile") => {
    const cleanup = typeof window !== "undefined" ? window.stockApi?.cleanupStorageCache : undefined;
    if (typeof cleanup !== "function" || busy) return;
    setBusy(`cleanup:${target}`);
    setMessage(null);
    try {
      const res = await cleanup({ target });
      if (!mountedRef.current) return;
      if (res.summary) {
        setStatus(prev => (prev ? { ...prev, storageSummary: res.summary } : prev));
      }
      const refreshed = await api.status().catch(() => null);
      if (mountedRef.current && refreshed) setStatus(refreshed);
      if (mountedRef.current) {
        setMessage({
          tone: res.ok ? "ok" : "error",
          text: res.message || (res.ok ? "缓存清理完成" : "缓存清理失败")
        });
      }
    } catch (error) {
      if (mountedRef.current) setMessage({ tone: "error", text: cleanError(error) });
    } finally {
      if (mountedRef.current) setBusy("");
    }
  };

  const folderLabel = status?.suggestions.find(item => item.path === status.folder)?.label;
  const cloudSyncSelected = Boolean(status?.folder && isCloudSyncFolder(status.folder, status.suggestions || []));
  const cloudUnencrypted = Boolean(cloudSyncSelected && !status?.hasPassword);
  const cloudPlaintextBlocked = Boolean(cloudUnencrypted && !allowPlaintextCloud);
  const passwordTooShort = password.length > 0 && password.length < 8;
  const cleanupApi = typeof window !== "undefined" ? window.stockApi?.cleanupStorageCache : undefined;

  return <div className="panel settings-card backup-settings-card" id="settings-backup" hidden={hidden}>
    <PanelTitle title="数据备份" subtitle="备份到一个文件夹；选网盘（iCloud 云盘、Google 云端硬盘、坚果云、OneDrive 等）的同步文件夹，网盘会自动传到网上" icon={Archive}
      badge={status?.files.length ? `${status.files.length} 份备份` : undefined} />

    <section className="backup-section">
      <h4>备份文件夹</h4>
      <p className="backup-folder">{status?.folder ? <><Cloud size={14} />{folderLabel ? `${folderLabel} · ` : ""}<code>{status.folder}</code></> : "还没有选择文件夹"}</p>
      <div className="backup-actions">
        <button type="button" className="secondary-btn" disabled={Boolean(busy)} onClick={() => { setRestore(null); void act("folder", () => api.chooseFolder()); }}><FolderOpen size={14} />选择文件夹</button>
        {status?.suggestions.filter(item => item.path !== status.folder).map(item => <button key={item.path} type="button" className="secondary-btn" disabled={Boolean(busy)}
          onClick={() => { setRestore(null); void act("folder", () => api.configure({ suggestedFolder: item.path }), `已改为备份到${item.label}`); }}><Cloud size={14} />用{item.label}</button>)}
      </div>
      {status && !status.suggestions.length && <p className="source-health-note">没找到网盘同步文件夹。想备份到 Google 云端硬盘，先安装「Google Drive 电脑版」并登录，它会在本机建一个同步文件夹，再回来选它（国内需要能访问 Google）。</p>}
    </section>

    <section className="backup-section">
      <h4>自动备份</h4>
      <label className="backup-toggle"><input type="checkbox" checked={status?.auto !== false} disabled={!status || Boolean(busy)}
        onChange={event => {
          const nextAuto = event.target.checked;
          if (nextAuto && cloudPlaintextBlocked) {
            setMessage({ tone: "error", text: "网盘同步目录未设置密码：请先设置加密密码，或勾选下方明文风险确认后再开启自动备份。" });
            return;
          }
          void act("auto", () => api.configure({ auto: nextAuto }));
        }} />每天自动备份一次（软件开着时）</label>
      <label className="backup-keep">保留最近
        <select value={status?.keep ?? 30} disabled={!status || Boolean(busy)} onChange={event => void act("keep", () => api.configure({ keep: Number(event.target.value) }))}>
          {[7, 14, 30, 60, 90].map(value => <option key={value} value={value}>{value}</option>)}
        </select>份，更早的自动删除
      </label>
      <p className="source-health-note">{status?.lastBackupAt ? `上次备份：${timeText(status.lastBackupAt)}` : "还没有备份过"}{status?.lastError ? ` · 上次失败：${status.lastError}` : ""}</p>
    </section>

    <section className="backup-section">
      <h4>备份密码（可选）</h4>
      {cloudUnencrypted && (
        <div className="warning-banner backup-privacy-banner" role="status">
          <CircleAlert size={15} />
          <div>
            <span>当前已选择网盘同步目录{folderLabel ? `（${folderLabel}）` : ""}，未设密码时备份文件会以明文保存持仓股数、成本价与随心记，强烈建议设置备份密码加密保护隐私。</span>
            <label className="backup-toggle">
              <input
                type="checkbox"
                checked={allowPlaintextCloud}
                disabled={Boolean(busy)}
                onChange={event => setAllowPlaintextCloud(event.target.checked)}
              />
              <span>我知晓未加密备份包含明文持仓、成本与笔记</span>
            </label>
          </div>
        </div>
      )}
      <p className="source-health-note">设了密码，备份文件整份加密，放在网盘上别人也看不到持仓。<b>密码忘了备份就打不开</b>，请记好。本机记住密码，自动备份不用每次输。</p>
      {editingPassword ? <div className="backup-actions">
        <input type="password" className="backup-password" value={password} placeholder="至少 8 位；留空表示不加密" aria-label="备份密码" onChange={event => setPassword(event.target.value)} />
        <button type="button" className="primary-btn" disabled={Boolean(busy) || passwordTooShort}
          onClick={() => {
            if (passwordTooShort) {
              setMessage({ tone: "error", text: "加密密码至少需要 8 位字符" });
              return;
            }
            void act("password", async () => { const next = await api.configure({ password }); setPassword(""); setEditingPassword(false); return next; }, password ? "已设置备份密码，之后的备份都会加密" : "已取消备份密码");
          }}>保存</button>
        <button type="button" className="secondary-btn" onClick={() => { setPassword(""); setEditingPassword(false); }}>取消</button>
        {passwordTooShort && <span className="backup-message error" role="alert"><CircleAlert size={14} />加密密码至少需要 8 位字符</span>}
      </div> : <div className="backup-actions">
        <span className="backup-state"><KeyRound size={14} />{status?.hasPassword ? "已设置，备份会加密" : "未设置，备份不加密"}</span>
        <button type="button" className="secondary-btn" onClick={() => setEditingPassword(true)}>{status?.hasPassword ? "修改 / 取消密码" : "设置密码"}</button>
      </div>}
    </section>

    <section className="backup-section">
      <div className="backup-head">
        <h4>备份记录</h4>
        <button type="button" className="primary-btn" disabled={!status?.folder || Boolean(busy) || cloudPlaintextBlocked}
          title={cloudPlaintextBlocked ? "请先设置备份密码或勾选明文风险确认" : undefined}
          onClick={() => {
            if (cloudPlaintextBlocked) {
              setMessage({ tone: "error", text: "网盘目录未设置密码：请先设置加密密码，或勾选明文风险确认后再执行备份。" });
              return;
            }
            void act("run", async () => (await api.run(collectLocalData(), { reason: "manual" })).status, "已备份");
          }}>
          {busy === "run" ? <LoaderCircle size={14} className="spin" /> : <Save size={14} />}立即备份</button>
      </div>
      {status?.files.length ? <table className="backup-table">
        <thead><tr><th>时间（北京时间）</th><th>大小</th><th aria-label="操作" /></tr></thead>
        <tbody>{status.files.map(file => <tr key={file.name}>
          <td>{fileTime(file.name)}</td><td>{sizeText(file.size)}</td>
          <td><button type="button" className="link-btn" disabled={Boolean(busy)} onClick={() => void startRestore(file)}><RotateCcw size={13} />从这份恢复</button></td>
        </tr>)}</tbody>
      </table> : <p className="source-health-note">{status?.folder ? "这个文件夹里还没有备份。" : "先选择备份文件夹。换了新电脑：装好软件后选同一个网盘文件夹，这里会列出以前的备份，点「从这份恢复」。"}</p>}
      {restore?.needPassword && <div className="backup-actions">
        <input type="password" className="backup-password" value={restore.password} placeholder="这份备份有密码" aria-label="备份密码（恢复）" disabled={Boolean(busy)} onChange={event => setRestore({ ...restore, password: event.target.value })} />
        <button type="button" className="primary-btn" disabled={!restore.password || Boolean(busy)} onClick={() => void verifyRestorePassword()}>下一步</button>
        <button type="button" className="secondary-btn" disabled={Boolean(busy)} onClick={() => { restoreSeqRef.current += 1; setRestore(null); }}>取消</button>
      </div>}
    </section>

    {message && <p className={`backup-message ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.tone === "error" && <CircleAlert size={14} />}{message.text}</p>}
    {(status?.storageSummary || typeof cleanupApi === "function") && (
      <section className="backup-section" aria-label="本机存储空间与缓存清理">
        <h4>本机存储空间</h4>
        {status?.storageSummary && (
          <p className="source-health-note" aria-label="本机存储空间占用">
            本机目录占用：业务数据 {sizeText(status.storageSummary.userDataBytes)} · 本地日线库 {sizeText(status.storageSummary.dailyBarsBytes)}（{status.storageSummary.dailyBarsCount} 只股票，退市超 180 天自动回收） · 内嵌网页缓存 {sizeText(status.storageSummary.webCacheBytes)}。
          </p>
        )}
        {typeof cleanupApi === "function" && (
          <div className="backup-actions">
            <button type="button" className="secondary-btn" disabled={Boolean(busy)} onClick={() => void runCleanup("web-cache")}>
              {busy === "cleanup:web-cache" ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}清理网页缓存
            </button>
            <button type="button" className="secondary-btn" disabled={Boolean(busy)} onClick={() => void runCleanup("stale-bars")}>
              {busy === "cleanup:stale-bars" ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}清理过期日线
            </button>
            <button
              type="button"
              className="secondary-btn"
              disabled={Boolean(busy)}
              onClick={() => setConfirmState({
                kind: "cleanup-daily-bars",
                request: {
                  title: "确认重建本地日线缓存？",
                  message: "将清空当前本机日线缓存文件，后续查看个股或运行策略扫描时会自动按需重新下载。",
                  confirmLabel: "确认重建",
                  tone: "danger"
                }
              })}
            >
              {busy === "cleanup:daily-bars" ? <LoaderCircle size={14} className="spin" /> : <RotateCcw size={14} />}重建日线缓存
            </button>
            <button type="button" className="secondary-btn" disabled={Boolean(busy)} onClick={() => void runCleanup("legacy-profile")}>
              {busy === "cleanup:legacy-profile" ? <LoaderCircle size={14} className="spin" /> : <Trash2 size={14} />}清理旧版配置残留
            </button>
          </div>
        )}
      </section>
    )}
    <p className="source-health-note">备份里有：设置（不含令牌和 API Key）、自选、持仓、观察记录、随心记、做T助手、自定义策略、AI 打分与问股对话、回测与复盘记录、纸面账户。不含行情缓存和日线库（换电脑后会自动重新下载）。</p>
    <ConfirmDialog
      request={confirmState?.request || null}
      onResolve={confirmed => {
        const currentKind = confirmState?.kind;
        setConfirmState(null);
        if (!confirmed) {
          if (currentKind === "restore") setRestore(null);
          return;
        }
        if (currentKind === "restore") void runRestore();
        else if (currentKind === "cleanup-daily-bars") void runCleanup("daily-bars");
      }}
    />
  </div>;
}
