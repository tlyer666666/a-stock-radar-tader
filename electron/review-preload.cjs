const { contextBridge, ipcRenderer } = require('electron');

async function invoke(channel, ...args) {
  const result = await ipcRenderer.invoke(channel, ...args);
  if (result?.ok === true) return result.value;
  const { code = "IPC_FAILED", message = "应用通信失败，请重试", retryable = false } = result?.error || {};
  // The code also travels in the message because contextBridge may discard
  // custom Error properties when crossing into the page's JavaScript world.
  throw Object.assign(new Error(`[${code}] ${message}${retryable ? "（可重试）" : ""}`), { code, retryable });
}
// The independent review window receives only its required read APIs.
contextBridge.exposeInMainWorld('stockApi', {
  search: query => invoke('review-window:search', query),
  analyze: security => invoke('review-window:analyze', security),
  getProfessionalReview: (options = {}) => invoke('review-window:market', options),
  getReviewTheme: () => invoke('review-window:theme'),
  onThemeChange: handler => {
    if (typeof handler !== 'function') return () => {};
    const listener = (_event, theme) => handler(theme);
    ipcRenderer.on('review-window:theme-changed', listener);
    return () => ipcRenderer.removeListener('review-window:theme-changed', listener);
  }
});
