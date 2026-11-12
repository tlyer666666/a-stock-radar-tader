import { useCallback, useEffect, useRef, useState } from "react";
import { loadSafeLocalJson, saveSafeLocalJson } from "../../safeStorage";
import {
  EMPTY_NOTES, MAX_NOTES, MAX_NOTE_LENGTH, NOTES_KEY, awaiting, dueToFire, markFired, normalizeNotes, snooze,
  type Note, type NoteRepeat, type NoteStock, type NotesStore
} from "./notesModel";

export type NotesApi = ReturnType<typeof useNotes>;
const CHECK_MS = 15_000;
const isStore = (value: unknown) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

/**
 * 随心记的数据层（挂在 App 上，在哪个页面都会提醒）：
 * 每 15 秒看一次有没有到点的提醒；到点就弹出提醒卡片、系统通知，可选语音播报。
 * 只读本机时钟和本机存储，不发网络请求。软件关着的时候到点的提醒，下次打开时补提醒。
 */
export function useNotes() {
  const [store, setStore] = useState<NotesStore>(() => normalizeNotes(loadSafeLocalJson<unknown>(NOTES_KEY, EMPTY_NOTES, isStore)));
  const [saveError, setSaveError] = useState(false);
  /** 本次弹出、还没关掉的提醒卡片。 */
  const [popup, setPopup] = useState<string[]>([]);
  const storeRef = useRef(store);

  const commit = useCallback((update: (current: NotesStore) => NotesStore) => {
    const next = normalizeNotes(update(storeRef.current));
    storeRef.current = next;
    setStore(next);
    setSaveError(!saveSafeLocalJson(NOTES_KEY, next, isStore));
  }, []);

  const check = useCallback(() => {
    const now = Date.now();
    const due = dueToFire(storeRef.current.notes, now);
    if (!due.length) return;
    const ids = new Set(due.map(note => note.id));
    commit(current => ({ ...current, notes: current.notes.map(note => ids.has(note.id) ? markFired(note, now) : note) }));
    setPopup(current => [...current.filter(id => !ids.has(id)), ...due.map(note => note.id)].slice(-6));
    const first = due[0]!;
    const brief = (note: Note) => note.text.replace(/\s+/g, " ").slice(0, 60);
    const title = due.length > 1 ? `随心记：${due.length} 条提醒到了` : "随心记提醒";
    const body = due.map(brief).join("\n").slice(0, 240);
    if (storeRef.current.systemNotify) void window.stockApi?.notify?.({ title, body }).catch(() => undefined);
    const synthesis = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (storeRef.current.voice && synthesis && typeof SpeechSynthesisUtterance !== "undefined") {
      const utterance = new SpeechSynthesisUtterance(due.length > 1 ? `随心记，${due.length} 条提醒到了。第一条：${brief(first)}` : `随心记提醒：${brief(first)}`);
      utterance.lang = "zh-CN";
      synthesis.speak(utterance);
    }
  }, [commit]);

  useEffect(() => {
    check();
    const timer = window.setInterval(check, CHECK_MS);
    // 电脑睡眠唤醒、窗口切回来时马上看一次，不等下一个 15 秒。
    const onVisible = () => { if (!document.hidden) check(); };
    const canListen = typeof document?.addEventListener === "function" && typeof window.addEventListener === "function";
    if (canListen) { document.addEventListener("visibilitychange", onVisible); window.addEventListener("focus", check); }
    return () => {
      window.clearInterval(timer);
      if (canListen) { document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", check); }
    };
  }, [check]);

  const add = useCallback((input: { text: string; remindAt: number | null; repeat: NoteRepeat; stock: NoteStock | null }) => {
    const text = input.text.trim().slice(0, MAX_NOTE_LENGTH);
    if (!text) return "先写点内容";
    if (storeRef.current.notes.length >= MAX_NOTES) return `最多保存 ${MAX_NOTES} 条，请先删掉一些已完成的`;
    const now = new Date().toISOString();
    const note: Note = {
      id: newId(), text, createdAt: now, updatedAt: now,
      remindAt: input.remindAt ? new Date(input.remindAt).toISOString() : null,
      repeat: input.remindAt ? input.repeat : "none", stock: input.stock, done: false, firedFor: null
    };
    commit(current => ({ ...current, notes: [note, ...current.notes] }));
    window.setTimeout(check, 0);
    return "";
  }, [commit, check]);

  const update = useCallback((id: string, patch: Partial<Pick<Note, "text" | "remindAt" | "repeat" | "stock" | "done">>) => {
    commit(current => ({
      ...current,
      notes: current.notes.map(note => {
        if (note.id !== id) return note;
        const next = { ...note, ...patch, updatedAt: new Date().toISOString() };
        // 改了提醒时间就重新计时；完成了就不再提醒。
        if ("remindAt" in patch) next.firedFor = null;
        if (!next.remindAt) next.repeat = "none";
        return next;
      })
    }));
    if ("done" in patch || "remindAt" in patch) setPopup(current => current.filter(item => item !== id));
    window.setTimeout(check, 0);
  }, [commit, check]);

  const later = useCallback((id: string, at: number) => {
    commit(current => ({ ...current, notes: current.notes.map(note => note.id === id ? snooze(note, at) : note) }));
    setPopup(current => current.filter(item => item !== id));
  }, [commit]);

  const remove = useCallback((id: string) => {
    commit(current => ({ ...current, notes: current.notes.filter(note => note.id !== id) }));
    setPopup(current => current.filter(item => item !== id));
  }, [commit]);

  const clearDone = useCallback(() => commit(current => ({ ...current, notes: current.notes.filter(note => !note.done) })), [commit]);
  const dismiss = useCallback((id?: string) => setPopup(current => id ? current.filter(item => item !== id) : []), []);
  const setVoice = useCallback((voice: boolean) => { if (!voice) window.speechSynthesis?.cancel(); commit(current => ({ ...current, voice })); }, [commit]);
  const setSystemNotify = useCallback((systemNotify: boolean) => commit(current => ({ ...current, systemNotify })), [commit]);

  const popupNotes = popup.map(id => store.notes.find(note => note.id === id)).filter((note): note is Note => Boolean(note) && !note!.done);
  return {
    store, saveError, popupNotes, awaitingCount: awaiting(store.notes).length,
    add, update, later, remove, clearDone, dismiss, setVoice, setSystemNotify
  };
}
