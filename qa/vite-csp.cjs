"use strict";

const PRODUCTION_CONNECT_SOURCES = "'self'";
const DEVELOPMENT_CONNECT_SOURCES = "'self' http://127.0.0.1:5173 ws://127.0.0.1:5173";

function cspConnectSources(command) {
  return command === "serve" ? DEVELOPMENT_CONNECT_SOURCES : PRODUCTION_CONNECT_SOURCES;
}

function injectCspConnectSources(html, command) {
  return String(html)
    .replace("__CSP_CONNECT_SRC__", cspConnectSources(command))
    .replace("__CSP_STYLE_SRC__", command === "build" ? "'self'" : "'self' 'unsafe-inline'");
}

module.exports = {
  cspConnectSources,
  injectCspConnectSources
};
