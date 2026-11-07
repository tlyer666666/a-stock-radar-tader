/** Entry points share this explicit preview opt-in. Keep Vite environment
 * access at the entry boundary so journal/source helpers remain runtime agnostic.
 */
export function allowPreviewRuntime(): boolean {
  return import.meta.env.DEV === true ||
    new URLSearchParams(window.location.search).get("preview") === "1";
}
