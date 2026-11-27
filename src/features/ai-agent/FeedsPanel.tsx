import { useCallback, useEffect, useRef, useState } from "react";
import { FlaskConical, Plus, Rss, Trash2 } from "lucide-react";
import { userErrorText } from "../../userErrorText";

export type Feed = { id: string; name: string; url: string; enabled: boolean };
export type FeedsState = { feeds: Feed[]; maxFeeds: number; test?: { count: number; sample: string[] } };
export type FeedsRequest = { op?: "list" | "save" | "remove" | "test"; id?: string; name?: string; url?: string; enabled?: boolean };

const FEED_URL_RE = /^https:\/\/\S+$/i;

/** 校验自订 RSS/Atom 地址（只允许 https，且不能包含空白字符）。 */
export function validateFeedUrl(raw: string): { ok: boolean; hint: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, hint: "" };
  if (/^http:\/\//i.test(trimmed)) return { ok: false, hint: "仅支持 https:// 开头的资讯源地址" };
  if (/\s/.test(trimmed)) return { ok: false, hint: "地址不能包含空格，请检查后重试" };
  if (!FEED_URL_RE.test(trimmed)) return { ok: false, hint: "请输入以 https:// 开头的完整地址" };
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" || !parsed.hostname.includes(".")) {
      return { ok: false, hint: "请输入有效的 https:// 网址（如 https://example.com/rss.xml）" };
    }
    return { ok: true, hint: "" };
  } catch {
    return { ok: false, hint: "请输入有效的 https:// 网址（如 https://example.com/rss.xml）" };
  }
}

/** 展示用（纯渲染，便于测试）。 */
export function FeedsPanelView({
  state,
  busy,
  message,
  error = "",
  initialUrl = "",
  onCall
}: {
  state: FeedsState;
  busy: boolean;
  message: string;
  error?: string;
  initialUrl?: string;
  onCall: (input: FeedsRequest, done?: (next: FeedsState) => string) => void;
}) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState(initialUrl);
  const urlCheck = validateFeedUrl(url);
  const urlOk = urlCheck.ok;
  return <section className="panel agent-feeds" aria-label="自订资讯源">
    <header className="agent-signals-head"><div>
      <h3><Rss size={15} /> 自订资讯源</h3>
      <small>添加 RSS 或 Atom 地址（只支持 https）。AI 问股分析时可以读这些源最近的文章标题和摘要，用来补充软件自带的快讯。文章内容只当资料用；每个源 15 分钟内只抓一次。最多 {state.maxFeeds} 个。</small>
    </div></header>
    <div className="alert-rules-form" role="group" aria-label="添加资讯源">
      <label>名称<input value={name} maxLength={20} placeholder="可不填" onChange={event => setName(event.target.value)} /></label>
      <label className="agent-feeds-url">地址<input value={url} maxLength={500} placeholder="https://…/rss.xml" aria-invalid={Boolean(urlCheck.hint)} onChange={event => setUrl(event.target.value)} /></label>
      <button type="button" className="secondary-btn" disabled={busy || !urlOk} onClick={() => onCall({ op: "test", url: url.trim() }, next => next.test ? `能读到 ${next.test.count} 条，例如：${next.test.sample.join(" / ")}` : "测试完成")}><FlaskConical size={14} />测试</button>
      <button type="button" className="primary-btn" disabled={busy || !urlOk || state.feeds.length >= state.maxFeeds} onClick={() => onCall({ op: "save", name: name.trim(), url: url.trim() }, () => { setName(""); setUrl(""); return "已添加"; })}><Plus size={14} />添加</button>
      {urlCheck.hint && <small className="alert-rules-error" role="alert">{urlCheck.hint}</small>}
    </div>
    {error && <p className="alert-rules-message error" role="alert">{error}</p>}
    {message && <p className="alert-rules-message" role="status">{message}</p>}
    {state.feeds.length === 0 ? <p className="ai-agent-muted">还没有添加资讯源。</p>
      : <ul className="alert-rules-list">{state.feeds.map(feed => <li key={feed.id} className={feed.enabled ? "" : "paused"}>
        <label title={feed.enabled ? "暂停这个源" : "启用这个源"}><input type="checkbox" aria-label={`${feed.enabled ? "暂停" : "启用"}资讯源：${feed.name}`} checked={feed.enabled} disabled={busy} onChange={event => onCall({ op: "save", id: feed.id, name: feed.name, url: feed.url, enabled: event.target.checked })} /></label>
        <span><b>{feed.name}</b> <small>{feed.url}</small></span>
        <button type="button" className="link-btn danger" disabled={busy} aria-label={`删除资讯源 ${feed.name}`} onClick={() => onCall({ op: "remove", id: feed.id })}><Trash2 size={13} /></button>
      </li>)}</ul>}
  </section>;
}

/** 自订资讯源（RSS / Atom）：添加后 AI 问股可以用 rss_news 工具读这些源的最新文章。 */
export default function FeedsPanel() {
  const api = typeof window === "undefined" ? undefined : window.stockApi?.ai?.agent?.feeds;
  const [state, setState] = useState<FeedsState>({ feeds: [], maxFeeds: 12 });
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const mountedRef = useRef(true);
  const seqRef = useRef(0);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const call = useCallback((input: FeedsRequest, done?: (next: FeedsState) => string) => {
    if (typeof api !== "function") return;
    const seq = ++seqRef.current;
    setBusy(true); setMessage(""); setError("");
    void api(input).then(next => {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setState(next);
      if (done) setMessage(done(next));
    }).catch(reason => {
      if (!mountedRef.current || seq !== seqRef.current) return;
      setError(userErrorText(reason, "操作失败"));
    }).finally(() => {
      if (mountedRef.current && seq === seqRef.current) setBusy(false);
    });
  }, [api]);
  useEffect(() => { call({ op: "list" }); }, [call]);
  if (typeof api !== "function") return <p className="ai-agent-muted">当前连接没有资讯源接口，请使用桌面版。</p>;
  return <FeedsPanelView state={state} busy={busy} message={message} error={error} onCall={call} />;
}
