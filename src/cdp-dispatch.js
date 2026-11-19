"use strict";

// Routes the DevTools events that the launcher's services need. Each
// binding goes to its own handler, and page events reach every service, so
// one service that fails does not keep the others from their events.
//
// This module has no side effects when it is loaded, so tests can use it.

function createDispatch({ bindings = {}, navigated = [], documentReady = [], destroyed = [], log = () => {} } = {}) {
  const run = (label, fn, ...args) => {
    try {
      const result = fn(...args);
      if (result && typeof result.catch === "function") {
        result.catch((error) => log(`${label} failed: ${error?.message || error}`));
      }
    } catch (error) {
      log(`${label} failed: ${error?.message || error}`);
    }
  };

  // Returns true when the message was for a service.
  function handle(message) {
    const method = message?.method;
    if (method === "Runtime.bindingCalled") {
      const name = message.params?.name;
      const handler = Object.hasOwn(bindings, name) ? bindings[name] : null;
      if (!handler) return false;
      run(name, handler, message.sessionId, message.params);
      return true;
    }
    if (method === "Page.frameNavigated") {
      for (const fn of navigated) run("Navigation", fn, message.sessionId, message.params?.frame);
      return true;
    }
    if (method === "Page.domContentEventFired") {
      for (const fn of documentReady) run("Reload", fn, message.sessionId);
      return true;
    }
    return false;
  }

  function targetDestroyed(sessionId) {
    if (!sessionId) return;
    for (const fn of destroyed) run("Cleanup", fn, sessionId);
  }

  return { handle, targetDestroyed };
}

module.exports = { createDispatch };
