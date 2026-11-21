import { useEffect, useRef, useState, type FormEvent } from "react";
import { Lock } from "lucide-react";
import { useReportHsgtOverlay } from "../features/hsgt/overlayContext";
import { userErrorText } from "../userErrorText";

type MasterPasswordUnlockModalProps = {
  open: boolean;
  onUnlocked: () => void;
};

export function MasterPasswordUnlockModal({ open, onUnlocked }: MasterPasswordUnlockModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  useReportHsgtOverlay(open);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return undefined;
    setPassword("");
    setError("");
    try {
      if (!dialog.open && typeof dialog.showModal === "function") dialog.showModal();
    } catch {
      /* ignore test/non-dialog env */
    }
    inputRef.current?.focus();
    return () => {
      try {
        if (dialog.open && typeof dialog.close === "function") dialog.close();
      } catch {
        /* ignore close errors */
      }
    };
  }, [open]);

  if (!open) return null;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (submitting) return;
    if (!password) {
      setError("请输入启动主密码");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const res = await window.stockApi.unlockMasterPassword?.({ password });
      if (res && res.locked) {
        setError("密码库仍处于锁定状态，请重试");
        return;
      }
      onUnlocked();
    } catch (err) {
      setError(userErrorText(err, "主密码错误，请重试"));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="quick-palette-native-dialog"
      data-overlay="open"
      aria-label="输入启动主密码解锁密钥库"
      onCancel={(event) => event.preventDefault()}
    >
      <form className="palette-dialog security-master-unlock" style={{ maxWidth: 420, padding: 20 }} onSubmit={(event) => { void submit(event); }}>
        <div className="security-master-head">
          <Lock size={18} />
          <strong>密钥库已锁定</strong>
        </div>
        <p className="field-hint">已启用启动主密码保护，请输入主密码以解锁本机 API Key 与行情令牌。</p>
        <label className="field-label" style={{ display: "block", marginTop: 10 }}>
          主密码
          <input
            ref={inputRef}
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="请输入主密码（至少 8 位）"
            autoComplete="current-password"
          />
        </label>
        {error && <p className="test-result fail" role="alert">{error}</p>}
        <div className="action-row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
          <button type="submit" className="primary-btn" disabled={submitting}>
            {submitting ? "解锁中…" : "解锁密码库"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
