'use strict';
// Only producer scopes belong here. Subscriber abort signals are consumed by
// lifecycle.subscribe and must never become a shared producer's controller.
const { AsyncLocalStorage } = require('node:async_hooks');
const producerContext = new AsyncLocalStorage();
module.exports = { producerContext };
