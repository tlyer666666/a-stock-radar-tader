type VisibilitySource = Pick<Document, "hidden"> &
  Partial<Pick<Document, "addEventListener" | "removeEventListener">>;

const defaultPage = (): VisibilitySource =>
  typeof document === "undefined" ? { hidden: false } : document;

const isOffline = (): boolean =>
  typeof navigator !== "undefined" && navigator.onLine === false;

export function whenVisible<T>(
  task: () => T,
  page: VisibilitySource = defaultPage()
): () => T | undefined {
  return () => (page.hidden || isOffline() ? undefined : task());
}

/**
 * Visibility- and connectivity-gated polling interval: skips ticks while hidden
 * or offline, optionally runs immediately on start, and resumes when visible/online.
 */
export function startVisibleInterval(
  task: () => void,
  intervalMs: number,
  options: {
    immediate?: boolean;
    resumeOnVisible?: boolean;
    page?: VisibilitySource;
  } = {}
): () => void {
  const page = options.page ?? defaultPage();
  const gated = whenVisible(task, page);
  if (options.immediate) gated();
  const timer = window.setInterval(gated, intervalMs);
  const onVisible = () => {
    if (!page.hidden && !isOffline()) task();
  };
  const onOnline = () => {
    if (!page.hidden && !isOffline()) task();
  };
  const canListen = options.resumeOnVisible === true && typeof page.addEventListener === "function";
  if (canListen) page.addEventListener!("visibilitychange", onVisible);
  const canListenOnline =
    typeof window !== "undefined" &&
    typeof window.addEventListener === "function" &&
    typeof window.removeEventListener === "function";
  if (canListenOnline) window.addEventListener("online", onOnline);
  return () => {
    window.clearInterval(timer);
    if (canListen && typeof page.removeEventListener === "function") {
      page.removeEventListener("visibilitychange", onVisible);
    }
    if (canListenOnline) {
      window.removeEventListener("online", onOnline);
    }
  };
}
