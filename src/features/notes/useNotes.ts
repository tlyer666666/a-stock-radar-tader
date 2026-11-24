import { useCallback, useEffect, useRef, useState } from "react";
import { hydrateFromNativeKv, loadSafeLocalJson, mirrorToNativeKv, saveSafeLocalJson } from "../../safeStorage";
import { startVisibleInterval } from "../../visiblePolling";
import { aiErrorMessage } from "../strategy-selection/aiSelectionModel";
import {
  EMPTY_NOTES, MAX_NOTES, MAX_NOTE_LENGTH, NOTES_KEY, aiQuestion, awaiting, dueToFire, markFired, normalizeIntervalMinutes, normalizeNotes, snooze, watchingConditions,
  type Note, type NoteCondition, type NoteRepeat, type NoteStock, type NotesStore
} from "./notesModel";

export type NotesApi = ReturnType<typeof useNotes>;
type ReminderKind = "time" | "condition";
type ReminderPopup = { id: string; kind: ReminderKind };
const CHECK_MS = 15_000;
const AI_POLL_MS = 1500;
const isStore = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const brief = (text: string, max = 60) => text.replace(/\s+/g, " ").slice(0, max);
const errorText = (reason: unknown) => aiErrorMessage(reason).replace(/^\[[A-Z_]+\]\s*/, "").replace(/（可重试）$/, "");
/** AI 回答的第一句结论（给系统通知用）。 */
const headline = (answer: string) => brief(answer.replace(/[#>*`_]/g, "").split(/\n+/).map(line => line.trim()).find(Boolean) || "", 90);

/**
 * 随心记的数据层（挂在 App 上，在哪个页面都会提醒）：
 * - 每 15 秒看一次有没有到点的提醒；到点就弹出提醒卡片、系统通知，可选语音播报。
 * - 价格条件交给主进程在交易时段盯报价（窗口最小化也能发通知），这里同步时取走触发记录。
 * - 「让 AI 看看」走 AI 问股（带实时行情工具），结论存回这条记录；可选到点自动让 AI 先看。
 * 软件关着的时候到点的提醒，下次打开时补提醒。
 */
export function useNotes() {
  const [store, setStore] = useState<NotesStore>(() => {
    const loaded = normalizeNotes(loadSafeLocalJson<unknown>(NOTES_KEY, EMPTY_NOTES, isStore));
    // 上次关软件时还没拿到 runId 的分析不会有结果了：标成中断，别一直转圈。
    return { ...loaded, notes: loaded.notes.map(note => note.ai?.status === "running" && !note.ai.runId
      ? { ...note, ai: { ...note.ai, status: "error", answer: "上次的分析被中断了，点「再问一次 AI」重新分析" } } : note) };
  });
  const [saveError, setSaveError] = useState(false);
  /** 本次弹出、还没关掉的提醒卡片。 */
  const [popup, setPopup] = useState<ReminderPopup[]>([]);
  const showPopups = useCallback((notes: readonly { id: string }[], kind: ReminderKind) => {
    const ids = new Set(notes.map(note => note.id));
    setPopup(current => [...current.filter(entry => !ids.has(entry.id)), ...notes.map(note => ({ id: note.id, kind }))].slice(-6));
  }, []);
  const [watch, setWatch] = useState<{ watching: number; session: boolean; error: string }>({ watching: 0, session: false, error: "" });
  const storeRef = useRef(store);
  const mountedRef = useRef(true);
  const hasMutatedRef = useRef(false);
  const lastWatchingRef = useRef(0);
  const soonTimersRef = useRef(new Set<number>());

  useEffect(() => {
    mountedRef.current = true;
    const timers = soonTimersRef.current;
    return () => {
      mountedRef.current = false;
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let localHasNotes = false;
    try {
      const raw = typeof window !== "undefined" ? window.localStorage?.getItem(NOTES_KEY) : null;
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        localHasNotes = isStore(parsed) && Array.isArray(parsed.notes) && parsed.notes.length > 0;
      }
    } catch {
      localHasNotes = false;
    }
    void hydrateFromNativeKv(NOTES_KEY, isStore, undefined, {
      isEmpty: value => !Array.isArray(value.notes) || value.notes.length === 0
    }).then(hydrated => {
      if (!active || !mountedRef.current || hasMutatedRef.current || localHasNotes || !hydrated) return;
      const normalized = normalizeNotes(hydrated);
      if (!normalized.notes.length) return;
      storeRef.current = normalized;
      setStore(normalized);
    });
    return () => { active = false; };
  }, []);

  const commit = useCallback((update: (current: NotesStore) => NotesStore) => {
    if (!mountedRef.current) return;
    hasMutatedRef.current = true;
    const next = normalizeNotes(update(storeRef.current));
    storeRef.current = next;
    setStore(next);
    const ok = saveSafeLocalJson(NOTES_KEY, next, isStore);
    setSaveError(!ok);
    if (ok || next.notes.length === 0) mirrorToNativeKv(NOTES_KEY, JSON.stringify(next));
  }, []);
  const patchNote = useCallback((id: string, patch: (note: Note) => Note) => commit(current => ({ ...current, notes: current.notes.map(note => note.id === id ? patch(note) : note) })), [commit]);

  const speak = useCallback((text: string) => {
    const synthesis = typeof window !== "undefined" ? window.speechSynthesis : undefined;
    if (!storeRef.current.voice || !synthesis || typeof SpeechSynthesisUtterance === "undefined") return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "zh-CN";
    synthesis.speak(utterance);
  }, []);

  // ---------- 让 AI 看看 ----------
  const askAi = useCallback(async (id: string, trigger: "manual" | "auto" = "manual") => {
    const agent = window.stockApi?.ai?.agent;
    const note = storeRef.current.notes.find(item => item.id === id);
    if (!note) return;
    if (!agent) { patchNote(id, item => ({ ...item, ai: { conversationId: "none", runId: null, status: "error", answer: "当前版本不支持 AI 问股", stance: "", at: new Date().toISOString(), trigger } })); return; }
    if (note.ai?.status === "running") return;
    const at = new Date().toISOString();
    patchNote(id, item => ({ ...item, ai: { conversationId: item.ai?.conversationId || "pending", runId: null, status: "running", answer: "", stance: "", at, trigger } }));
    try {
      const focus = note.stock ? { code: note.stock.code, name: note.stock.name } : null;
      // 同一条记录再问时接着上次的对话，AI 能看到它上次怎么说的。
      const previous = note.ai && note.ai.conversationId && !["pending", "none"].includes(note.ai.conversationId) ? note.ai.conversationId : "";
      const started = await agent.start({ message: aiQuestion(note), focus, title: `随心记 · ${brief(note.text, 10)}`, ...(previous ? { conversationId: previous } : {}) })
        .catch(async (reason: unknown) => {
          // 对话被删了：重开一段。
          if (previous && /已被删除/.test(errorText(reason))) return agent.start({ message: aiQuestion(note), focus, title: `随心记 · ${brief(note.text, 10)}` });
          throw reason;
        });
      if (!mountedRef.current) return;
      patchNote(id, item => item.ai ? { ...item, ai: { ...item.ai, conversationId: started.conversationId, runId: started.runId } } : item);
    } catch (reason) {
      if (!mountedRef.current) return;
      patchNote(id, item => item.ai ? { ...item, ai: { ...item.ai, status: "error", answer: errorText(reason) || "AI 分析没能开始", runId: null } } : item);
    }
  }, [patchNote]);

  // 进行中的 AI 分析：轮询主进程（本机 IPC，不联网）直到出结果。
  const aiRunning = store.notes.some(note => note.ai?.status === "running" && note.ai.runId);
  useEffect(() => {
    const agent = window.stockApi?.ai?.agent;
    if (!agent || !aiRunning) return;
    let busy = false, mounted = true;
    const tick = async () => {
      if (busy || !mounted) return;
      busy = true;
      try {
        for (const note of storeRef.current.notes.filter(item => item.ai?.status === "running" && item.ai.runId)) {
          if (!mounted) return;
          const runId = note.ai!.runId!;
          let run: AgentRun;
          try { run = await agent.poll(runId); }
          catch (reason) {
            if (!mounted) return;
            const gone = /已结束或已过期|AGENT_RUN_GONE/.test(String(reason));
            patchNote(note.id, item => item.ai?.runId === runId ? { ...item, ai: { ...item.ai, status: "error", runId: null,
              answer: gone ? "上次的分析被中断了（软件重启或已过期），点「再问一次 AI」重新分析" : errorText(reason) } } : item);
            continue;
          }
          if (!mounted) return;
          if (run.status === "running") continue;
          const ok = run.status === "done" && run.message && !run.message.error;
          const answer = ok ? run.message!.content : run.error || run.message?.content || "分析没有完成";
          patchNote(note.id, item => item.ai?.runId === runId ? { ...item, ai: { ...item.ai, status: ok ? "done" : "error", runId: null, answer,
            stance: ok ? String(run.message!.stance || "") : "", at: run.message?.at || new Date().toISOString() } } : item);
          if (ok && note.ai!.trigger === "auto" && storeRef.current.systemNotify) {
            void window.stockApi?.notify?.({ title: `AI 看过了：${note.stock?.name || "随心记"}`, body: headline(answer) }).catch(() => undefined);
          }
        }
      } finally { busy = false; }
    };
    const stop = startVisibleInterval(() => { void tick(); }, AI_POLL_MS, { immediate: true, resumeOnVisible: true });
    return () => { mounted = false; stop(); };
  }, [aiRunning, patchNote]);

  /** 提醒发出后：开了「到点自动让 AI 先看」时，关联了股票的记录自动问一次。 */
  const autoAsk = useCallback((notes: Note[]) => {
    if (!storeRef.current.aiAuto) return;
    for (const note of notes.filter(item => item.stock).slice(0, 2)) void askAi(note.id, "auto");
  }, [askAi]);

  // ---------- 到点提醒 ----------
  const check = useCallback(() => {
    const now = Date.now();
    const background = Boolean(window.stockApi?.syncNoteIntervals);
    const due = dueToFire(storeRef.current.notes, now).filter(note => !background || note.repeat !== "interval");
    if (!due.length) return;
    const ids = new Set(due.map(note => note.id));
    commit(current => ({ ...current, notes: current.notes.map(note => ids.has(note.id) ? markFired(note, now) : note) }));
    showPopups(due, "time");
    const title = due.length > 1 ? `随心记：${due.length} 条提醒到了` : "随心记提醒";
    const body = due.map(note => brief(note.text)).join("\n").slice(0, 240);
    if (storeRef.current.systemNotify) void window.stockApi?.notify?.({ title, body }).catch(() => undefined);
    speak(due.length > 1 ? `随心记，${due.length} 条提醒到了。第一条：${brief(due[0]!.text)}` : `随心记提醒：${brief(due[0]!.text)}`);
    autoAsk(due);
  }, [commit, speak, autoAsk, showPopups]);

  const syncingIntervals = useRef(false);
  const intervalsDirty = useRef(false);
  const lastSyncedIntervalsKey = useRef<string | null>(null);
  const syncIntervals = useCallback(async () => {
    const api = window.stockApi?.syncNoteIntervals;
    if (!api || !mountedRef.current) return;
    intervalsDirty.current = true;
    if (syncingIntervals.current) return;
    syncingIntervals.current = true;
    try {
      while (intervalsDirty.current && mountedRef.current) {
        intervalsDirty.current = false;
        const { notes, systemNotify } = storeRef.current;
        const items = notes.flatMap(note => {
          if (note.done || note.repeat !== "interval" || !note.remindAt || !note.intervalMinutes) return [];
          return [{ id: note.id, text: brief(note.text, 80), at: Date.parse(note.remindAt), intervalMinutes: note.intervalMinutes }];
        });
        const payloadKey = JSON.stringify({ items, systemNotify });
        if (items.length === 0 && lastSyncedIntervalsKey.current === payloadKey) continue;
        const hits = await api({ items, systemNotify });
        lastSyncedIntervalsKey.current = payloadKey;
        if (!mountedRef.current || !hits.length) continue;
        const expected = new Map(items.map(item => [item.id, item.intervalMinutes]));
        const matches = new Map(hits.map(hit => [hit.id, hit]));
        const due = storeRef.current.notes.filter(note => {
          const hit = matches.get(note.id);
          return hit && !note.done && note.repeat === "interval" && note.intervalMinutes === expected.get(note.id)
            && note.remindAt !== null && Date.parse(note.remindAt) === hit.at;
        });
        if (!due.length) continue;
        const ids = new Set(due.map(note => note.id));
        commit(current => ({
          ...current,
          notes: current.notes.map(note => {
            if (!ids.has(note.id)) return note;
            const hit = matches.get(note.id)!;
            return { ...note, remindAt: new Date(hit.nextAt).toISOString(), lastFiredAt: new Date(hit.lastFiredAt).toISOString(), firedFor: null };
          })
        }));
        showPopups(due, "time");
        speak(`随心记提醒：${brief(due[0]!.text)}`);
        autoAsk(due);
      }
    } catch { /* 应用通信中断时下次同步重试。 */ }
    finally { syncingIntervals.current = false; }
  }, [autoAsk, commit, speak, showPopups]);

  // ---------- 价格条件 ----------
  const syncing = useRef(false);
  const syncWatch = useCallback(async () => {
    const api = window.stockApi?.notesWatch;
    if (!api || syncing.current || !mountedRef.current) return;
    const items = watchingConditions(storeRef.current.notes).map(note => ({ id: note.id, code: note.stock!.code, name: note.stock!.name, secid: note.stock!.secid,
      text: brief(note.text, 80), condition: note.condition! }));
    if (!items.length && lastWatchingRef.current === 0) return;
    syncing.current = true;
    try {
      const result = await api({ items, systemNotify: storeRef.current.systemNotify });
      if (!mountedRef.current) return;
      lastWatchingRef.current = result.watching;
      setWatch(current => current.watching === result.watching && current.session === result.session && current.error === (result.error || "")
        ? current : { watching: result.watching, session: result.session, error: result.error || "" });
      const sent = new Map(items.map(item => [item.id, item]));
      const current = new Map(storeRef.current.notes.map(note => [note.id, note]));
      const hits = result.hits.filter(hit => {
        const requested = sent.get(hit.id);
        const note = current.get(hit.id);
        return requested && note && !note.done && !note.conditionHit &&
          note.stock?.code === requested.code && note.stock.secid === requested.secid &&
          note.condition?.field === requested.condition.field && note.condition.op === requested.condition.op &&
          note.condition.value === requested.condition.value;
      });
      if (!hits.length) return;
      const byId = new Map(hits.map(hit => [hit.id, hit]));
      commit(current => ({ ...current, notes: current.notes.map(note => byId.has(note.id) ? { ...note, conditionHit: { at: byId.get(note.id)!.at, detail: byId.get(note.id)!.detail } } : note) }));
      showPopups(hits, "condition");
      speak(`随心记，价格条件到了：${hits[0]!.detail}`);
      autoAsk(storeRef.current.notes.filter(note => byId.has(note.id)));
    } catch { /* 主进程暂时不可用：下次再同步 */ }
    finally { syncing.current = false; }
  }, [commit, speak, autoAsk, showPopups]);

  useEffect(() => {
    const run = () => { if (!mountedRef.current) return; check(); void syncWatch(); void syncIntervals(); };
    run();
    // Deliberately not visibility-gated so due-date reminders & system notifications still fire while minimized.
    const timer = window.setInterval(run, CHECK_MS);
    // 电脑睡眠唤醒、窗口切回来时马上看一次，不等下一个 15 秒。
    const onVisible = () => { if (!document.hidden) run(); };
    const canListen = typeof document?.addEventListener === "function" && typeof window.addEventListener === "function";
    if (canListen) { document.addEventListener("visibilitychange", onVisible); window.addEventListener("focus", run); }
    return () => {
      window.clearInterval(timer);
      if (canListen) { document.removeEventListener("visibilitychange", onVisible); window.removeEventListener("focus", run); }
    };
  }, [check, syncWatch, syncIntervals]);
  const soon = useCallback(() => {
    const timer = window.setTimeout(() => {
      soonTimersRef.current.delete(timer);
      if (!mountedRef.current) return;
      check();
      void syncWatch();
      void syncIntervals();
    }, 0);
    soonTimersRef.current.add(timer);
    return timer;
  }, [check, syncWatch, syncIntervals]);

  // ---------- 增删改 ----------
  const add = useCallback((input: { text: string; remindAt: number | null; repeat: NoteRepeat; intervalMinutes?: number | null | undefined; stock: NoteStock | null; condition?: NoteCondition | null }) => {
    const text = input.text.trim().slice(0, MAX_NOTE_LENGTH);
    if (!text) return "先写点内容";
    if (input.repeat === "interval" && !normalizeIntervalMinutes(input.intervalMinutes)) return "请填写有效的重复间隔";
    if (storeRef.current.notes.length >= MAX_NOTES) return `最多保存 ${MAX_NOTES} 条，请先删掉一些已完成的`;
    const now = new Date().toISOString();
    const note: Note = {
      id: newId(), text, createdAt: now, updatedAt: now,
      remindAt: input.remindAt ? new Date(input.remindAt).toISOString() : null,
      repeat: input.remindAt ? input.repeat : "none", intervalMinutes: input.intervalMinutes ?? null, stock: input.stock, done: false, firedFor: null, lastFiredAt: null,
      condition: input.stock ? input.condition || null : null, conditionHit: null, ai: null
    };
    commit(current => ({ ...current, notes: [note, ...current.notes] }));
    soon();
    return "";
  }, [commit, soon]);

  const update = useCallback((id: string, patch: Partial<Pick<Note, "text" | "remindAt" | "repeat" | "intervalMinutes" | "stock" | "done" | "condition">>) => {
    commit(current => ({
      ...current,
      notes: current.notes.map(note => {
        if (note.id !== id) return note;
        const next = { ...note, ...patch, updatedAt: new Date().toISOString() };
        // 改了提醒时间就重新计时；改了条件就重新盯；完成了就不再提醒。
        if ("remindAt" in patch || ("repeat" in patch && patch.repeat !== note.repeat)) { next.firedFor = null; next.lastFiredAt = null; }
        if ("condition" in patch) next.conditionHit = null;
        if (!next.remindAt) next.repeat = "none";
        if (!next.stock) next.condition = null;
        return next;
      })
    }));
    if ("done" in patch || "remindAt" in patch || "condition" in patch) setPopup(current => current.filter(item => item.id !== id));
    soon();
  }, [commit, soon]);

  const later = useCallback((id: string, at: number) => {
    commit(current => ({ ...current, notes: current.notes.map(note => note.id === id ? { ...snooze(note, at), conditionHit: null, condition: note.conditionHit ? null : note.condition } : note) }));
    setPopup(current => current.filter(item => item.id !== id));
    soon();
  }, [commit, soon]);

  /** 条件触发后重新盯（例如价格又回来了，想再等一次）。 */
  const rearm = useCallback((id: string) => { patchNote(id, note => ({ ...note, conditionHit: null, updatedAt: new Date().toISOString() })); setPopup(current => current.filter(item => item.id !== id)); soon(); }, [patchNote, soon]);

  const remove = useCallback((id: string) => {
    commit(current => ({ ...current, notes: current.notes.filter(note => note.id !== id) }));
    setPopup(current => current.filter(item => item.id !== id));
    soon();
  }, [commit, soon]);

  const clearDone = useCallback(() => commit(current => ({ ...current, notes: current.notes.filter(note => !note.done) })), [commit]);
  const dismiss = useCallback((id?: string) => setPopup(current => id ? current.filter(item => item.id !== id) : []), []);
  const setVoice = useCallback((voice: boolean) => { if (!voice) window.speechSynthesis?.cancel(); commit(current => ({ ...current, voice })); }, [commit]);
  const setSystemNotify = useCallback((systemNotify: boolean) => {
    commit(current => ({ ...current, systemNotify }));
    soon();
  }, [commit, soon]);
  const setAiAuto = useCallback((aiAuto: boolean) => commit(current => ({ ...current, aiAuto })), [commit]);
  const clearAi = useCallback((id: string) => patchNote(id, note => ({ ...note, ai: null })), [patchNote]);

  const popupNotes = popup.flatMap(entry => {
    const note = store.notes.find(item => item.id === entry.id);
    return note && !note.done ? [{ note, kind: entry.kind }] : [];
  });
  return {
    store, saveError, popupNotes, awaitingCount: awaiting(store.notes).length, watch,
    add, update, later, rearm, remove, clearDone, dismiss, setVoice, setSystemNotify, setAiAuto, askAi, clearAi
  };
}
