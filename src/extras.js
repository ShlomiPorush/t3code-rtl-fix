"use strict";

// Extras in T3 Code's page: the usage chips in the sidebar footer, with the
// version of the fix in their list, and the Extras section on the Labs
// settings page.
//
// The page script runs in an isolated world that the launcher creates in the
// main frame. The binding is exposed by that world's name, so T3 Code's main
// world and the frames in the page do not get it, and a call is taken only
// from the world recorded for the current document. Data reaches the page
// through a receiver whose name is random for each start.

const crypto = require("node:crypto");
const { buildExtrasPageSource } = require("./extras-page");
const { readRequest: readHomeRequest } = require("./home-github");

const EXTRAS_BINDING = "__t3Extras";
const WORLD_NAME = "t3-extras";
const MAX_MESSAGE_BYTES = 1024;
// The Home page names every repository in one message.
const MAX_HOME_MESSAGE_BYTES = 32 * 1024;

function createExtrasService({
  send,
  log = () => {},
  store,
  reader,
  repoStatusAvailable = () => false,
  updates = null,
  homeGithub = null,
  protocol = "t3code:",
} = {}) {
  const sessions = new Map();
  const logged = new Set();
  const logOnce = (message) => {
    if (logged.has(message)) return;
    logged.add(message);
    log(`Extras: ${message}`);
  };

  function sessionOf(sessionId) {
    let session = sessions.get(sessionId);
    if (!session) {
      session = { start: 0, contextId: null, receiver: null };
      sessions.set(sessionId, session);
    }
    return session;
  }

  // The accounts the page may list: those whose provider reports usage, even
  // with no open window now, and hidden ones so that they can be shown again.
  // Providers that never report usage stay out of the list.
  function accountsFor(accounts, settings) {
    const hidden = new Set(settings.usageHiddenAccounts);
    // A hidden account that the reader no longer lists, such as a default
    // account whose data is old, keeps a row so that it can be shown again.
    const known = new Set(accounts.map((account) => account.id));
    const kept = [...hidden].filter((id) => !known.has(id)).map((id) => ({
      id, provider: "Other", name: id, accent: null, reportsUsage: false, checkedAt: null, windows: [],
    }));
    return [...accounts, ...kept]
      // A hidden account of a provider that never reports usage, such as
      // OpenCode, leaves the list; a hidden account the reader lost keeps its row.
      .filter((account) => account.windows.length > 0 || account.reportsUsage || (hidden.has(account.id) && !known.has(account.id)))
      .map((account) => ({
        id: account.id,
        provider: account.provider,
        name: account.name,
        accent: account.accent,
        checkedAt: account.checkedAt,
        windows: account.windows.map((window) => ({
          label: window.label,
          usedPercent: window.usedPercent,
          resetsAt: window.resetsAt,
          windowDurationMins: window.windowDurationMins,
        })),
      }));
  }

  function pageSettings() {
    const settings = store.get();
    return {
      rtlLayout: settings.rtlLayout,
      repoStatus: settings.repoStatus,
      usageLimits: settings.usageLimits,
      usageHiddenAccounts: settings.usageHiddenAccounts,
      chatWidth: settings.chatWidth,
      boringWorkingShelf: settings.boringWorkingShelf,
      boringDoneShelf: settings.boringDoneShelf,
      boringPlainPinned: settings.boringPlainPinned,
      homePage: settings.homePage,
      writable: settings.writable,
      problem: settings.problem,
    };
  }

  // Sends data to the page of the current start. Work of an earlier start
  // is dropped before anything is sent. The send is not awaited by callers
  // that must not wait on a page that does not answer.
  function push(sessionId, start, build) {
    const session = sessions.get(sessionId);
    if (!session || session.start !== start || session.contextId === null) return Promise.resolve(false);
    const data = build();
    const expression = `(() => { const receive = window[${JSON.stringify(session.receiver)}]; return typeof receive === "function" && receive(${JSON.stringify(data)}) === true; })()`;
    return send("Runtime.evaluate", { expression, contextId: session.contextId, returnByValue: true }, sessionId).then(
      (response) => response?.result?.value === true,
      () => false,
    );
  }

  async function sendState(sessionId, start) {
    const session = sessions.get(sessionId);
    if (!session || session.start !== start) return;
    let usage = { accounts: [], problem: null };
    // A settings file fixed or changed by hand applies at the next check.
    store.reload();
    try {
      usage = await reader.read();
    } catch {
      logOnce("usage could not be read");
    }
    // The settings are read when the data is sent, so a change made by
    // another window meanwhile is not undone here.
    await push(sessionId, start, () => {
      const settings = pageSettings();
      return {
        kind: "state",
        settings,
        accounts: accountsFor(usage.accounts, settings),
        problem: usage.problem,
        repoStatusAvailable: repoStatusAvailable(),
        update: updates?.get() ?? null,
      };
    });
  }

  // Creates the isolated world in the main frame of the current document,
  // runs the page script there, and sends the first state.
  async function start(sessionId, frameId) {
    const session = sessionOf(sessionId);
    const current = ++session.start;
    session.contextId = null;
    let mainFrame = frameId;
    if (!mainFrame) {
      const tree = await send("Page.getFrameTree", {}, sessionId);
      mainFrame = tree?.frameTree?.frame?.id;
    }
    if (!mainFrame || session.start !== current) return;
    const world = await send("Page.createIsolatedWorld", { frameId: mainFrame, worldName: WORLD_NAME }, sessionId);
    if (session.start !== current) return;
    const contextId = world?.executionContextId;
    if (typeof contextId !== "number") throw new Error("no isolated world was created");
    await send("Runtime.addBinding", { name: EXTRAS_BINDING, executionContextName: WORLD_NAME }, sessionId);
    if (session.start !== current) return;
    session.contextId = contextId;
    session.receiver = `__t3Extras_${crypto.randomBytes(12).toString("hex")}`;
    const source = buildExtrasPageSource({ binding: EXTRAS_BINDING, receiver: session.receiver, protocol });
    await send("Runtime.evaluate", { expression: source, contextId }, sessionId);
  }

  async function attach(sessionId) {
    await start(sessionId, null);
  }

  // A new document in the main frame needs a new world.
  function navigated(sessionId, frame) {
    if (!sessions.has(sessionId) || !frame || frame.parentId) return Promise.resolve();
    return start(sessionId, frame.id);
  }

  function broadcast() {
    for (const [sessionId, session] of sessions) {
      void push(sessionId, session.start, () => ({ kind: "settings", settings: pageSettings() }));
    }
  }

  updates?.onChange((update) => {
    for (const [sessionId, session] of sessions) {
      void push(sessionId, session.start, () => ({ kind: "update", update }));
    }
  });

  async function handle(sessionId, executionContextId, payload) {
    const session = sessions.get(sessionId);
    if (!session || session.contextId === null || executionContextId !== session.contextId) return;
    if (typeof payload !== "string") return;
    const size = Buffer.byteLength(payload, "utf8");
    if (size > MAX_HOME_MESSAGE_BYTES) return;
    let message;
    try {
      message = JSON.parse(payload);
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;
    const current = session.start;
    if (message.type === "home") {
      const repositories = readHomeRequest(message.repositories);
      if (!homeGithub || !repositories || !store.get().homePage) return;
      homeGithub.read(sessionId, repositories, (github) => void push(sessionId, current, () => ({ kind: "home", github })));
      return;
    }
    if (size > MAX_MESSAGE_BYTES) return;
    if (message.type === "check") {
      await sendState(sessionId, current);
      return;
    }
    if (message.type === "updateShown") await updates?.shown();
    else if (message.type === "checkUpdate") await updates?.check();
    else if (message.type === "installUpdate") await updates?.install();
    else if (message.type === "set" || message.type === "hideAccount") {
      const result = await store.change(message);
      // The answer depends only on the disk. Other windows get the new
      // settings without this one waiting on them.
      void push(sessionId, current, () => ({
        kind: "result",
        ok: result.ok,
        error: result.error,
        settings: pageSettings(),
      }));
      if (result.ok) broadcast();
    }
  }

  function forget(sessionId) {
    sessions.delete(sessionId);
    homeGithub?.forget(sessionId);
  }

  return { attach, navigated, handle, forget };
}

module.exports = { EXTRAS_BINDING, WORLD_NAME, createExtrasService };
