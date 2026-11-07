import { useCallback, useEffect, useRef, useState } from "react";
import { whenVisible } from "../../visiblePolling";
import { aiErrorMessage } from "../strategy-selection/aiSelectionModel";
import { QUICK_TASKS, takeAgentHandoff } from "./agentModel";

type AgentApi = NonNullable<NonNullable<Window["stockApi"]["ai"]>["agent"]>;
const POLL_MS = 800;
const errorText = (reason: unknown) => aiErrorMessage(reason).replace(/^\[[A-Z_]+\]\s*/, "").replace(/（可重试）$/, "");
const runningRun = (runId: string, conversationId: string): AgentRun => ({ runId, conversationId, status: "running", steps: [], startedAt: "", elapsedMs: 0, model: "" });
// Route changes keep service runs alive; only the selected conversation is kept
// here. Reopening it reads runningRunId and resumes progress polling.
let rememberedConversation: string | null = null;
let rememberedFocus: AgentFocus | null = null;

export function useAgentConversation(api: AgentApi | undefined) {
  const [state, setStateValue] = useState<AgentState | null>(null);
  const [loadError, setLoadError] = useState("");
  const [activeId, setActiveId] = useState<string | null>(rememberedConversation);
  const [thread, setThread] = useState<AgentConversation | null>(null);
  const [focus, setFocus] = useState<AgentFocus | null>(rememberedFocus);
  const [draft, setDraft] = useState("");
  const [run, setRunValue] = useState<AgentRun | null>(null);
  const [error, setError] = useState("");
  const [sending, setSending] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [skillIds, setSkillIds] = useState<string[] | null>(null);
  const generation = useRef(0);
  const transcriptRevision = useRef(0);
  const mounted = useRef(true);
  const active = useRef(activeId);
  const currentRun = useRef<AgentRun | null>(null);
  const sendOwner = useRef<symbol | null>(null);
  const stateRequest = useRef(0);
  const handoffDone = useRef(false);

  const isCurrent = useCallback((owner: number) => mounted.current && generation.current === owner, []);
  const setRun = useCallback((value: AgentRun | null) => { currentRun.current = value; setRunValue(value); }, []);
  const setState = useCallback((value: AgentState) => { if (mounted.current) { stateRequest.current += 1; setStateValue(value); } }, []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; generation.current += 1; sendOwner.current = null; };
  }, []);
  useEffect(() => { rememberedConversation = activeId; }, [activeId]);
  useEffect(() => { rememberedFocus = focus; }, [focus]);

  const refreshState = useCallback(async () => {
    if (!api || !mounted.current) return null;
    const request = ++stateRequest.current;
    try {
      const value = await api.state();
      if (!mounted.current || request !== stateRequest.current) return null;
      setStateValue(value); setSkillIds(current => current ?? value.skillIds ?? []); setLoadError("");
      return value;
    } catch (reason) { if (mounted.current && request === stateRequest.current) setLoadError(errorText(reason)); return null; }
  }, [api]);

  const openConversation = useCallback(async (id: string | null) => {
    const owner = ++generation.current;
    const loading = api && id ? Symbol("history") : null;
    sendOwner.current = loading;
    active.current = id;
    setActiveId(id); setThread(null); setRun(null); setSending(Boolean(loading)); setSaving(false); setConfirmDelete(null); setError("");
    if (!api || !id) return;
    try {
      const value = await api.conversation(id);
      if (!isCurrent(owner)) return;
      // 对话已被删（例如另一个窗口删了）：同时刷新左侧列表，别留下点不开的条目。
      if (!value || value.id !== id) { active.current = null; setActiveId(null); void refreshState(); return; }
      setThread(value); setFocus(value.focus);
      setRun(value.runningRunId ? runningRun(value.runningRunId, value.id) : null);
    } catch (reason) { if (isCurrent(owner)) { setError(errorText(reason)); void refreshState(); } }
    finally { if (isCurrent(owner) && sendOwner.current === loading) { sendOwner.current = null; setSending(false); } }
  }, [api, isCurrent, setRun, refreshState]);

  const send = useCallback(async (text: string, options: { focus?: AgentFocus | null; conversationId?: string | null; title?: string } = {}) => {
    const message = text.trim();
    if (!api || !mounted.current || !message || sendOwner.current || currentRun.current?.status === "running") return;
    const owner = ++generation.current;
    const token = Symbol("send");
    sendOwner.current = token;
    const ownsSend = () => isCurrent(owner) && sendOwner.current === token;
    const target = options.conversationId === undefined ? active.current : options.conversationId;
    const stock = options.focus === undefined ? focus : options.focus;
    setSending(true); setSaving(false); setError("");
    try {
      const started = await api.start({ message, ...(target ? { conversationId: target } : {}), focus: stock, ...(options.title ? { title: options.title } : {}), ...(skillIds ? { skillIds } : {}) });
      // The service may have accepted A after the user selected B. Keep A in the
      // sidebar, but never adopt its ID, draft, history or send lock in B.
      if (mounted.current) void refreshState();
      if (!ownsSend()) return;
      active.current = started.conversationId;
      setActiveId(started.conversationId); setDraft("");
      setRun(runningRun(started.runId, started.conversationId));
      const at = new Date().toISOString();
      const question: AgentMessage = { id: `pending-${started.runId}`, role: "user", content: message, at, ...(stock ? { focus: stock } : {}) };
      setThread(current => ({ ...(current?.id === started.conversationId ? current : { id: started.conversationId, title: options.title || message.slice(0, 18), focus: stock, createdAt: at, updatedAt: at, messages: [] }),
        messages: [...(current?.id === started.conversationId ? current.messages : []), question] }));
      const value = await api.conversation(started.conversationId);
      if (ownsSend() && value?.id === started.conversationId) setThread(value);
    } catch (reason) { if (ownsSend()) setError(errorText(reason)); }
    finally { if (ownsSend()) { sendOwner.current = null; setSending(false); } }
  }, [api, focus, isCurrent, refreshState, setRun, skillIds]);

  useEffect(() => {
    if (!api) return;
    const owner = generation.current;
    let cancelled = false;
    void (async () => {
      const value = await refreshState();
      if (cancelled || !isCurrent(owner)) return;
      const handoff = handoffDone.current ? null : takeAgentHandoff();
      handoffDone.current = true;
      if (handoff) {
        setFocus(handoff.focus);
        const task = QUICK_TASKS.find(item => item.id === handoff.task) || QUICK_TASKS[0]!;
        if (value?.configured) void send(task.prompt(handoff.focus), { focus: handoff.focus, conversationId: null, title: task.label });
        else void openConversation(null);
      } else if (rememberedConversation && value?.conversations.some(item => item.id === rememberedConversation)) void openConversation(rememberedConversation);
    })();
    return () => { cancelled = true; };
    // Entry initialization uses the handlers from this mount. Later selections
    // invalidate it through the same generation used by send and polling.
  }, [api]);

  useEffect(() => {
    if (!api || !run || run.status !== "running" || sending) return;
    const owner = generation.current;
    const { runId, conversationId } = run;
    const deliverTerminal = (conversation: AgentConversation | null, value: AgentRun) => {
      transcriptRevision.current += 1;
      setThread(current => {
        const at = value.message?.at || value.startedAt;
        const base = conversation?.id === conversationId ? conversation : current?.id === conversationId ? current
          : { id: conversationId, title: conversationId, focus: value.message?.focus || null, createdAt: at, updatedAt: at, messages: [] };
        const message = value.message;
        return { ...base, runningRunId: undefined, ...(value.persistenceError ? { persistenceError: value.persistenceError } : {}),
          messages: message && !base.messages.some(item => item.id === message.id) ? [...base.messages, message] : base.messages };
      });
    };
    let stopped = false, inFlight = false, finished = false;
    const ownsRun = () => !stopped && isCurrent(owner) && active.current === conversationId && currentRun.current?.runId === runId;
    const tick = whenVisible(async () => {
      if (!ownsRun() || inFlight || finished) return;
      inFlight = true;
      let terminal: AgentRun | null = null;
      try {
        const value = await api.poll(runId);
        if (!ownsRun()) return;
        if (value.status === "running") { setRun(value); return; }
        terminal = value; finished = true;
        // Keep the effect alive until its final IPC read is delivered. Updating
        // run.status first would clean up this very request on the next render.
        const conversation = await api.conversation(conversationId);
        if (!ownsRun()) return;
        deliverTerminal(conversation, value);
        setRun(null); void refreshState();
      } catch (reason) {
        if (!ownsRun()) return;
        setError(errorText(reason));
        if (terminal) {
          deliverTerminal(null, terminal);
          setRun(null); void refreshState();
        }
      } finally { inFlight = false; }
    });
    const timer = window.setInterval(() => { void tick(); }, POLL_MS);
    void tick();
    return () => { stopped = true; window.clearInterval(timer); };
    // run's progress fields may change without replacing the polling owner.
  }, [api, run?.runId, run?.status, sending, isCurrent, refreshState, setRun]);

  const stop = async () => {
    const value = currentRun.current, owner = generation.current;
    if (!api || !value) return;
    try { await api.cancel(value.runId); }
    catch (reason) { if (isCurrent(owner) && currentRun.current?.runId === value.runId) setError(errorText(reason)); }
  };
  const remove = async (id: string) => {
    if (!api) return;
    if (confirmDelete !== id) { setConfirmDelete(id); return; }
    const owner = generation.current;
    try {
      const value = await api.remove(id);
      if (!mounted.current) return;
      setState(value);
      if (active.current === id) void openConversation(null);
      else if (isCurrent(owner)) setConfirmDelete(null);
    } catch (reason) { if (isCurrent(owner)) setError(errorText(reason)); }
  };
  const retryPersistence = async () => {
    if (!api || saving) return;
    const owner = generation.current, id = active.current;
    setSaving(true); setError("");
    try {
      const value = await api.settings({});
      if (!mounted.current) return;
      if (!isCurrent(owner)) { void refreshState(); return; }
      setState(value);
      if (id) {
        const revision = transcriptRevision.current;
        const conversation = await api.conversation(id);
        if (isCurrent(owner) && revision === transcriptRevision.current && conversation?.id === id) setThread(conversation);
      }
    } catch (reason) { if (isCurrent(owner)) setError(errorText(reason)); }
    finally { if (isCurrent(owner)) setSaving(false); }
  };
  const persistenceError = thread?.persistenceError || thread?.messages.find(message => message.persistenceError)?.persistenceError || run?.persistenceError || state?.persistenceError;

  return { state, setState, loadError, refreshState, activeId, thread, focus, setFocus, draft, setDraft, run, error, setError, sending, saving, persistenceError, retryPersistence,
    confirmDelete, skillIds, setSkillIds, openConversation, send, stop, remove, running: run?.status === "running" };
}
