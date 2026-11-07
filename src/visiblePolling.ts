type VisibilitySource = Pick<Document, "hidden">;

export function whenVisible<T>(task: () => T, page: VisibilitySource = document): () => T | undefined {
  return () => (page.hidden ? undefined : task());
}
