import { useCallback, useEffect, useState } from "react";
import { Archive, CircleAlert, Cloud, FolderOpen, KeyRound, LoaderCircle, RotateCcw, Save } from "lucide-react";
import { PanelTitle } from "../../components/terminal/TerminalPrimitives";
import { ConfirmDialog, type ConfirmDialogRequest } from "../../components/terminal/ConfirmDialog";
import { backupApi, collectLocalData, restoreLocalData, type BackupFile, type BackupStatus } from "./backupClient";

const cleanError = (error: unknown) => (error instanceof Error ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/, "").replace(/^\[[A-Z_]+\]\s*/, "");
const sizeText = (bytes: number) => bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const timeText = (iso: string) => iso ? new Date(Date.parse(iso) + 8 * 3600_000).toISOString().slice(0, 16).replace("T", " ") : "";
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
  const [restore, setRestore] = useState<{ file: BackupFile; password: string; needPassword: boolean } | null>(null);
  const [confirm, setConfirm] = useState<ConfirmDialogRequest | null>(null);

  const load = useCallback(async () => {
    if (!api) return;
    try { setStatus(await api.status()); } catch (error) { setMessage({ tone: "error", text: cleanError(error) }); }
  }, [api]);
  useEffect(() => { if (!hidden) void load(); }, [hidden, load]);

  const act = async (label: string, run: () => Promise<BackupStatus | void>, done?: string) => {
    if (busy) return;
    setBusy(label); setMessage(null);
    try { const next = await run(); if (next) setStatus(next); if (done) setMessage({ tone: "ok", text: done }); }
    catch (error) { setMessage({ tone: "error", text: cleanError(error) }); }
    finally { setBusy(""); }
  };

  if (!api) return <div className="panel settings-card" id="settings-backup" hidden={hidden}>
    <PanelTitle title="数据备份" subtitle="桌面版可用" icon={Archive} /><p className="source-health-note">浏览器预览不能写本机文件夹，请在桌面版设置。</p></div>;

  const startRestore = async (file: BackupFile) => {
    setMessage(null);
    try { await api.inspect(file.name); setRestore({ file, password: "", needPassword: false }); setConfirm(confirmRequest(file)); }
    catch (error) {
      const text = cleanError(error);
      if (/密码/.test(text)) setRestore({ file, password: "", needPassword: true });
      else setMessage({ tone: "error", text });
    }
  };
  const confirmRequest = (file: BackupFile): ConfirmDialogRequest => ({
    title: `用 ${fileTime(file.name)} 的备份覆盖现在的数据？`,
    message: "自选、持仓、随心记、做T记录、自定义策略、AI 对话、回测和复盘记录会换成备份里的内容；令牌和 API Key 保留本机现有的。恢复后软件自动重启。",
    details: ["建议先点「立即备份」留一份现在的数据。"], confirmLabel: "恢复并重启", tone: "danger"
  });
  const runRestore = async () => {
    if (!restore) return;
    await act("restore", async () => {
      const result = await api.restore(restore.file.name, restore.password);
      restoreLocalData(result.local);
      setMessage({ tone: "ok", text: "已恢复，软件马上重启…" });
      await api.relaunch();
    });
  };

  const folderLabel = status?.suggestions.find(item => item.path === status.folder)?.label;
  return <div className="panel settings-card backup-settings-card" id="settings-backup" hidden={hidden}>
    <PanelTitle title="数据备份" subtitle="备份到一个文件夹；选网盘（iCloud 云盘、Google 云端硬盘、坚果云、OneDrive 等）的同步文件夹，网盘会自动传到网上" icon={Archive}
      badge={status?.files.length ? `${status.files.length} 份备份` : undefined} />

    <section className="backup-section">
      <h4>备份文件夹</h4>
      <p className="backup-folder">{status?.folder ? <><Cloud size={14} />{folderLabel ? `${folderLabel} · ` : ""}<code>{status.folder}</code></> : "还没有选择文件夹"}</p>
      <div className="backup-actions">
        <button type="button" className="secondary-btn" disabled={Boolean(busy)} onClick={() => void act("folder", () => api.chooseFolder())}><FolderOpen size={14} />选择文件夹</button>
        {status?.suggestions.filter(item => item.path !== status.folder).map(item => <button key={item.path} type="button" className="secondary-btn" disabled={Boolean(busy)}
          onClick={() => void act("folder", () => api.configure({ suggestedFolder: item.path }), `已改为备份到${item.label}`)}><Cloud size={14} />用{item.label}</button>)}
      </div>
      {status && !status.suggestions.length && <p className="source-health-note">没找到网盘同步文件夹。想备份到 Google 云端硬盘，先安装「Google Drive 电脑版」并登录，它会在本机建一个同步文件夹，再回来选它（国内需要能访问 Google）。</p>}
    </section>

    <section className="backup-section">
      <h4>自动备份</h4>
      <label className="backup-toggle"><input type="checkbox" checked={status?.auto !== false} disabled={!status || Boolean(busy)}
        onChange={event => void act("auto", () => api.configure({ auto: event.target.checked }))} />每天自动备份一次（软件开着时）</label>
      <label className="backup-keep">保留最近
        <select value={status?.keep ?? 30} disabled={!status || Boolean(busy)} onChange={event => void act("keep", () => api.configure({ keep: Number(event.target.value) }))}>
          {[7, 14, 30, 60, 90].map(value => <option key={value} value={value}>{value}</option>)}
        </select>份，更早的自动删除
      </label>
      <p className="source-health-note">{status?.lastBackupAt ? `上次备份：${timeText(status.lastBackupAt)}` : "还没有备份过"}{status?.lastError ? ` · 上次失败：${status.lastError}` : ""}</p>
    </section>

    <section className="backup-section">
      <h4>备份密码（可选）</h4>
      <p className="source-health-note">设了密码，备份文件整份加密，放在网盘上别人也看不到持仓。<b>密码忘了备份就打不开</b>，请记好。本机记住密码，自动备份不用每次输。</p>
      {editingPassword ? <div className="backup-actions">
        <input type="password" className="backup-password" value={password} placeholder="至少 6 位；留空表示不加密" aria-label="备份密码" onChange={event => setPassword(event.target.value)} />
        <button type="button" className="primary-btn" disabled={Boolean(busy) || (password.length > 0 && password.length < 6)}
          onClick={() => void act("password", async () => { const next = await api.configure({ password }); setPassword(""); setEditingPassword(false); return next; }, password ? "已设置备份密码，之后的备份都会加密" : "已取消备份密码")}>保存</button>
        <button type="button" className="secondary-btn" onClick={() => { setPassword(""); setEditingPassword(false); }}>取消</button>
      </div> : <div className="backup-actions">
        <span className="backup-state"><KeyRound size={14} />{status?.hasPassword ? "已设置，备份会加密" : "未设置，备份不加密"}</span>
        <button type="button" className="secondary-btn" onClick={() => setEditingPassword(true)}>{status?.hasPassword ? "修改 / 取消密码" : "设置密码"}</button>
      </div>}
    </section>

    <section className="backup-section">
      <div className="backup-head">
        <h4>备份记录</h4>
        <button type="button" className="primary-btn" disabled={!status?.folder || Boolean(busy)}
          onClick={() => void act("run", async () => (await api.run(collectLocalData(), { reason: "manual" })).status, "已备份")}>
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
        <input type="password" className="backup-password" value={restore.password} placeholder="这份备份有密码" aria-label="备份密码（恢复）" onChange={event => setRestore({ ...restore, password: event.target.value })} />
        <button type="button" className="primary-btn" disabled={!restore.password || Boolean(busy)} onClick={() => void (async () => {
          try { await api.inspect(restore.file.name, restore.password); setConfirm(confirmRequest(restore.file)); }
          catch (error) { setMessage({ tone: "error", text: cleanError(error) }); }
        })()}>下一步</button>
        <button type="button" className="secondary-btn" onClick={() => setRestore(null)}>取消</button>
      </div>}
    </section>

    {message && <p className={`backup-message ${message.tone}`} role={message.tone === "error" ? "alert" : "status"}>{message.tone === "error" && <CircleAlert size={14} />}{message.text}</p>}
    <p className="source-health-note">备份里有：设置（不含令牌和 API Key）、自选、持仓、观察记录、随心记、做T助手、自定义策略、AI 打分与问股对话、回测与复盘记录、纸面账户。不含行情缓存和日线库（换电脑后会自动重新下载）。</p>
    <ConfirmDialog request={confirm} onResolve={confirmed => { setConfirm(null); if (confirmed) void runRestore(); else setRestore(null); }} />
  </div>;
}
