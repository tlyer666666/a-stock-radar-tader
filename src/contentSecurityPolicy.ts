export type ViteCommand = "serve" | "build";

const PRODUCTION_CONNECT_SOURCES = "'self'";
const DEVELOPMENT_CONNECT_SOURCES =
  "'self' http://127.0.0.1:5173 ws://127.0.0.1:5173";

export const cspConnectSources = (command: ViteCommand): string =>
  command === "serve" ? DEVELOPMENT_CONNECT_SOURCES : PRODUCTION_CONNECT_SOURCES;

export const injectCspConnectSources = (
  html: string,
  command: ViteCommand
): string => html.replace("__CSP_CONNECT_SRC__", cspConnectSources(command));
