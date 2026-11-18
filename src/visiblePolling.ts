type VisibilitySource = Pick<Document, "hidden"> &
  Partial<Pick<Document, "addEventListener" | "removeEventListener">>;

const defaultPage = (): VisibilitySource =>
  typeof document === "undefined" ? { hidden: false } : document;

export function whenVisible<T>(
  task: () => T,
  page: VisibilitySource = defaultPage()
): () => T | undefined {
  return () => (page.hidden ? undefined : task());
}

/**
 * Visibility-gated polling interval: skips ticks while the page is hidden,
 * optionally runs immediately on start and resumes once on visibility return.
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
    if (!page.hidden) task();
  };
  const canListen = options.resumeOnVisible === true && typeof page.addEventListener === "function";
  if (canListen) page.addEventListener!("visibilitychange", onVisible);
  return () => {
    window.clearInterval(timer);
    if (canListen && typeof page.removeEventListener === "function") {
      page.removeEventListener("visibilitychange", onVisible);
    }
  };
}
