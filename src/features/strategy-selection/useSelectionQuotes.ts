import { useEffect, useMemo, useRef, useState } from 'react';
import { whenVisible } from '../../visiblePolling';
import { selectionQuoteFeed, type SelectionQuote } from './selectionQuoteData';
export type SelectionQuoteEntry = { quote: SelectionQuote | null; error: string };

/** Each table owns its current page; pausing polling does not detach an unfinished read. */
export function useSelectionQuotes(securities: Security[], live = true, refreshSeconds = 15) {
  const key = JSON.stringify(securities.map(({ code, secid, name, assetType }) => ({ code, secid, name, assetType })));
  const page = useMemo<Security[]>(() => JSON.parse(key), [key]);
  const liveRef = useRef(live);
  liveRef.current = live;
  const poll = useRef<() => void>(() => {});
  const [round, setRound] = useState(0);
  const [state, setState] = useState<{ key: string; entries: Record<string, SelectionQuoteEntry>; loading: boolean }>({ key, entries: {}, loading: false });
  const seconds = Math.max(15, Number.isFinite(refreshSeconds) ? refreshSeconds : 15);
  useEffect(() => {
    if (!page.length || typeof window.stockApi?.getQuoteSnapshot !== 'function') return;
    let active = true, initialized = false, pending = false;
    let runId = 0;
    let releases: Array<() => void> = [];
    const refresh = (force = false) => {
      // A poll tick must not discard the back of an unfinished page. The next
      // round starts only once every subscribed row has an outcome.
      if (!active || document.hidden || pending) return;
      const currentRun = ++runId;
      initialized = true;
      pending = true;
      releases.forEach(release => release()); releases = [];
      setState(previous => ({ key, entries: previous.key === key ? previous.entries : {}, loading: true }));
      let remaining = page.length;
      for (const security of page) {
        releases.push(selectionQuoteFeed.subscribe(security, (quote, error) => {
          if (!active || currentRun !== runId) return;
          remaining--;
          pending = remaining > 0;
          setState(previous => ({ key, loading: remaining > 0, entries: {
            ...(previous.key === key ? previous.entries : {}),
            [security.code]: { quote: quote || (previous.key === key ? previous.entries[security.code]?.quote : null) || null, error }
          } }));
        }, force));
      }
    };
    poll.current = () => refresh();
    refresh(round > 0);
    const onVisible = whenVisible(() => {
      selectionQuoteFeed.resume();
      if (liveRef.current || !initialized) refresh(round > 0 && !initialized);
    });
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false; poll.current = () => {};
      document.removeEventListener('visibilitychange', onVisible);
      releases.forEach(release => release());
    };
  }, [key, page, round]);
  useEffect(() => {
    if (!live || !page.length) return;
    const timer = window.setInterval(whenVisible(() => poll.current()), seconds * 1000);
    return () => window.clearInterval(timer);
  }, [live, seconds, page]);
  return { entries: state.key === key ? state.entries : {}, loading: state.key === key && state.loading,
    refresh: () => setRound(value => value + 1), refreshSeconds: seconds };
}
