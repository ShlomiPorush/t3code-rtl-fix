"use strict";

// Everything the fix does in T3 Code's windows, as one unit that the launcher
// host (t3-rtl-launcher.js) prepares, starts, and stops. The installers put
// each version of it in its own folder, so the host can replace a running
// version with a new one without quitting T3 Code.
//
// prepareCore sends nothing over the debugging pipe. It throws when the fix
// itself cannot be built; an extra that fails to load is only logged and left
// off, as before, so a broken extra never takes the RTL fix down with it.

const fs = require("node:fs");
const path = require("node:path");
const { buildInjectionSource } = require("./injection");
const { createDispatch } = require("./cdp-dispatch");
const {
  ANNOTATION_BINDING,
  applyAnnotationDirection,
  watchAnnotations,
} = require("./annotation-direction");

// The launcher host this core works with. The host refuses a core that needs
// another one.
const REQUIRES_HOST_API = 1;

// Extras read the regular build's data folder, so the development build's
// page, whose provider list lives elsewhere, does not get them.
function isRegularT3Page(targetInfo) {
  return /^t3code:\/\//i.test(targetInfo?.url || "");
}

function isT3Page(targetInfo) {
  return targetInfo?.type === "page" && /^t3code(?:-dev)?:\/\//i.test(targetInfo.url || "");
}

// T3 Code's browser preview runs in a <webview>, where T3 draws its element
// annotation window.
function isT3Preview(targetInfo) {
  return targetInfo?.type === "webview";
}

// The shipped stylesheet of this version, then the user's own custom.css
// from the install folder, which no installer writes.
function readStylesheet(versionDirectory, rootDirectory, log) {
  const css = fs.readFileSync(path.join(versionDirectory, "rtl.css"), "utf8");
  const customPath = path.join(rootDirectory, "custom.css");
  try {
    return `${css}\n${fs.readFileSync(customPath, "utf8")}`;
  } catch (error) {
    if (error.code !== "ENOENT") log(`Could not read ${customPath}: ${error.message}`);
    return css;
  }
}

function prepareCore({ send: hostSend, log, rootDirectory, versionDirectory }) {
  const injectionSource = buildInjectionSource(readStylesheet(versionDirectory, rootDirectory, log));

  // A core that is being replaced starts no reload and no interception of
  // T3 Code's script, even from work that began before it stopped.
  let stopped = true;
  const send = (method, params, sessionId) =>
    stopped && (method === "Page.reload" || method === "Fetch.enable")
      ? Promise.reject(new Error("this version of the fix is stopped"))
      : hostSend(method, params, sessionId);

  // Optional settings.json in the install folder, such as { "repoStatus": false },
  // which the Extras section on T3 Code's Labs page also changes. The
  // installer never writes it, so a reinstall keeps the user's choices. Each
  // extra loads on its own, so a failure in one leaves the RTL fix and the
  // others running.
  let settingsStore = null;
  let t3Home = null;
  try {
    const { createSettingsStore, resolveT3Home } = require("./extras-settings");
    t3Home = resolveT3Home();
    settingsStore = createSettingsStore({ directory: rootDirectory, t3Home, log });
  } catch (error) {
    log(`Extras settings are off: ${error.message}`);
  }
  const initialSettings = settingsStore ? settingsStore.get() : { repoStatus: true, rtlLayout: true };

  // The right-to-left layout of the whole app, which the Extras section turns
  // on and off. It loads on its own, so a failure leaves the per-message fix.
  let buildLayoutSource = null;
  try {
    ({ buildLayoutSource } = require("./app-layout"));
  } catch (error) {
    log(`The right-to-left layout is off: ${error.message}`);
  }
  let rtlLayout = initialSettings.rtlLayout !== false;

  // The chat width chosen in the Extras section. It loads on its own too.
  let buildChatWidthSource = null;
  try {
    ({ buildChatWidthSource } = require("./chat-width"));
  } catch (error) {
    log(`The chat width is off: ${error.message}`);
  }
  let chatWidth = initialSettings.chatWidth ?? null;

  // Opens a thread at the start of the agent's last reply. It loads on its
  // own too, so a failure leaves the rest of the fix running.
  let replyStartSource = null;
  try {
    replyStartSource = require("./reply-start").buildReplyStartSource();
  } catch (error) {
    log(`Opening threads at the start of the last reply is off: ${error.message}`);
  }

  // The Working section in the boring sidebar. It rewrites T3 Code's sidebar
  // code as the page loads it, only while the Extras switch is on. It loads on
  // its own too.
  let boringWorkingShelf = initialSettings.boringWorkingShelf === true;
  let workingShelf = null;
  // Resolves to whether the browser watches T3 Code's script.
  let workingShelfWatch = null;
  try {
    const { createWorkingShelfService } = require("./working-shelf");
    workingShelf = createWorkingShelfService({
      send: (...args) => send(...args),
      isEnabled: () => boringWorkingShelf,
      log,
    });
  } catch (error) {
    log(`The Working section in the boring sidebar is off: ${error.message}`);
  }

  // Interception starts with the first switch on and then stays, so a request
  // that is paused while the switch turns off is still answered.
  function watchWorkingShelf() {
    if (!workingShelf || !boringWorkingShelf) return Promise.resolve(false);
    if (!workingShelfWatch) {
      workingShelfWatch = workingShelf.enable().then((watching) => {
        if (!watching) workingShelfWatch = null;
        return watching;
      });
    }
    return workingShelfWatch;
  }

  // A change of the switch reloads T3 Code's windows, so it applies without a
  // restart. Without interception no window has a changed script, so there is
  // nothing to reload.
  // A change that a later one overtakes before its reload starts does not
  // reload.
  let workingShelfChanges = 0;
  async function switchWorkingShelf(next) {
    if (next === boringWorkingShelf) return;
    boringWorkingShelf = next;
    const change = ++workingShelfChanges;
    const watching = next ? await watchWorkingShelf() : workingShelfWatch !== null && (await workingShelfWatch);
    if (!watching || change !== workingShelfChanges) return;
    const reloaded = await workingShelf.reloadWindows([...appPages.values()]);
    log(`Working section in the boring sidebar turned ${next ? "on" : "off"}, ${reloaded} windows reloaded`);
  }

  let repoStatus = null;
  let repoStatusBinding = null;
  let repoStatusRuns = false;
  try {
    const { REPO_STATUS_BINDING, createRepoStatusService, opensSqliteReadOnly } = require("./repo-status");
    repoStatusRuns = opensSqliteReadOnly(process.versions.node) && sqliteLoads();
    repoStatusBinding = REPO_STATUS_BINDING;
    repoStatus = createRepoStatusService({
      send: (...args) => send(...args),
      log,
      enabled: initialSettings.repoStatus !== false && repoStatusRuns,
    });
  } catch (error) {
    log(`Repository status is off: ${error.message}`);
  }

  let extras = null;
  let extrasBinding = null;
  if (settingsStore) {
    try {
      const { createUsageReader } = require("./usage-limits");
      const { EXTRAS_BINDING, createExtrasService } = require("./extras");
      extrasBinding = EXTRAS_BINDING;
      extras = createExtrasService({
        send: (...args) => send(...args),
        log,
        store: settingsStore,
        reader: createUsageReader({ t3Home, log }),
        repoStatusAvailable: () => !!repoStatus && repoStatusRuns,
      });
    } catch (error) {
      log(`Extras are off: ${error.message}`);
    }
    settingsStore.onChange((settings) => {
      if (stopped) return;
      repoStatus?.setEnabled(settings.repoStatus && repoStatusRuns);
      const nextLayout = settings.rtlLayout !== false;
      if (nextLayout !== rtlLayout) {
        rtlLayout = nextLayout;
        for (const sessionId of layoutSessions) void switchLayout(sessionId);
      }
      void switchWorkingShelf(settings.boringWorkingShelf === true);
      const nextWidth = settings.chatWidth ?? null;
      if (nextWidth !== chatWidth) {
        chatWidth = nextWidth;
        for (const sessionId of chatWidthSessions) void switchChatWidth(sessionId);
      }
    });
  }

  const dispatch = createDispatch({
    bindings: {
      ...(repoStatus && repoStatusBinding
        ? { [repoStatusBinding]: (sessionId, params) => repoStatus.handle(sessionId, params?.payload) }
        : {}),
      ...(extras && extrasBinding
        ? { [extrasBinding]: (sessionId, params) => extras.handle(sessionId, params?.executionContextId, params?.payload) }
        : {}),
    },
    navigated: extras ? [(sessionId, frame) => extras.navigated(sessionId, frame)] : [],
    documentReady: repoStatus ? [(sessionId) => repoStatus.reattach(sessionId)] : [],
    destroyed: [
      ...(repoStatus ? [(sessionId) => repoStatus.forget(sessionId)] : []),
      ...(extras ? [(sessionId) => extras.forget(sessionId)] : []),
    ],
    log,
  });

  const sessionsByTarget = new Map();
  // Attaches in progress, by target, so a second event for the same target
  // waits for the same attach.
  const attaching = new Map();
  const annotationSessionsLogged = new Set();
  // The T3 Code pages that get the layout, from the moment they are attached,
  // and the new-document script of the layout in each, by session.
  const layoutSessions = new Set();
  const layoutScripts = new Map();
  // The regular T3 Code windows, which load the script the Working section
  // in the boring sidebar changes, by target. A window stays here from its
  // attach until it closes, even when a fix fails to inject into it.
  const appPages = new Map();

  // Layout work for each session runs one step at a time, so quick changes,
  // such as one from a second window, never lose track of a script.
  const layoutQueues = new Map();
  function queueLayout(sessionId, step) {
    const next = (layoutQueues.get(sessionId) || Promise.resolve()).then(step, step);
    layoutQueues.set(sessionId, next.catch(() => {}));
    return next;
  }

  // A reload or a new document starts in the saved layout. The new script is
  // added before the old one is removed, so no document starts without one.
  async function registerLayout(sessionId) {
    if (!buildLayoutSource) return;
    const previous = layoutScripts.get(sessionId);
    const { identifier } = await send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: buildLayoutSource({ enabled: rtlLayout }) },
      sessionId,
    );
    layoutScripts.set(sessionId, identifier);
    if (previous) {
      await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: previous }, sessionId).catch(() => {});
    }
  }

  // The chat width follows the same steps as the layout: a new-document
  // script for each session, replaced when the setting changes, and applied
  // to the open page at once.
  const chatWidthSessions = new Set();
  const chatWidthScripts = new Map();

  async function registerChatWidth(sessionId) {
    if (!buildChatWidthSource) return;
    const previous = chatWidthScripts.get(sessionId);
    const { identifier } = await send(
      "Page.addScriptToEvaluateOnNewDocument",
      { source: buildChatWidthSource(chatWidth) },
      sessionId,
    );
    chatWidthScripts.set(sessionId, identifier);
    if (previous) {
      await send("Page.removeScriptToEvaluateOnNewDocument", { identifier: previous }, sessionId).catch(() => {});
    }
  }

  function switchChatWidth(sessionId) {
    return queueLayout(sessionId, async () => {
      if (!chatWidthSessions.has(sessionId)) return;
      try {
        await registerChatWidth(sessionId);
        await send("Runtime.evaluate", { expression: buildChatWidthSource(chatWidth), returnByValue: true }, sessionId);
        log(`Chat width set to ${chatWidth === null ? "T3 Code's own" : chatWidth + "rem"}`);
      } catch (error) {
        log(`Could not change the chat width: ${error.message}`);
      }
    });
  }

  // Applies a changed setting to an open page at once.
  function switchLayout(sessionId) {
    return queueLayout(sessionId, async () => {
      if (!layoutSessions.has(sessionId)) return;
      try {
        await registerLayout(sessionId);
        await send(
          "Runtime.evaluate",
          { expression: `globalThis.__t3RtlLayout && globalThis.__t3RtlLayout.set(${rtlLayout})`, returnByValue: true },
          sessionId,
        );
        log(`Right-to-left layout turned ${rtlLayout ? "on" : "off"}`);
      } catch (error) {
        log(`Could not switch the right-to-left layout: ${error.message}`);
      }
    });
  }

  function attachAndInject(targetInfo) {
    const targetId = targetInfo?.targetId;
    if (stopped || (!isT3Page(targetInfo) && !isT3Preview(targetInfo)) || sessionsByTarget.has(targetId)) {
      return Promise.resolve();
    }
    if (attaching.has(targetId)) return attaching.get(targetId);
    const work = attachTarget(targetInfo).finally(() => attaching.delete(targetId));
    attaching.set(targetId, work);
    return work;
  }

  async function attachTarget(targetInfo) {
    const targetId = targetInfo.targetId;
    const isPage = isT3Page(targetInfo);
    const changesBeforeAttach = workingShelfChanges;
    let changedWhileAttaching = false;
    try {
      const attached = await hostSend("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const sessionId = attached.sessionId;
      // A core that stopped while this attach was waiting does not keep it.
      if (stopped) {
        await hostSend("Target.detachFromTarget", { sessionId }).catch(() => {});
        return;
      }
      sessionsByTarget.set(targetId, sessionId);
      // At once, so a change of the switch from now on reloads this window too.
      if (isPage && isRegularT3Page(targetInfo)) appPages.set(targetId, sessionId);
      changedWhileAttaching = workingShelfChanges !== changesBeforeAttach;

      if (!isPage) {
        await watchAnnotations(send, sessionId);
        log("Annotation direction watcher added to a browser preview");
        return;
      }

      // Page events, such as a reload, reach every service.
      await send("Page.enable", {}, sessionId);
      if (buildLayoutSource) {
        layoutSessions.add(sessionId);
        await queueLayout(sessionId, async () => {
          try {
            await registerLayout(sessionId);
            await send(
              "Runtime.evaluate",
              { expression: buildLayoutSource({ enabled: rtlLayout }), returnByValue: true },
              sessionId,
            );
          } catch (error) {
            log(`The right-to-left layout could not be added: ${error.message}`);
          }
        });
      }
      if (buildChatWidthSource) {
        chatWidthSessions.add(sessionId);
        await queueLayout(sessionId, async () => {
          try {
            await registerChatWidth(sessionId);
            await send("Runtime.evaluate", { expression: buildChatWidthSource(chatWidth), returnByValue: true }, sessionId);
          } catch (error) {
            log(`The chat width could not be added: ${error.message}`);
          }
        });
      }
      await send(
        "Page.addScriptToEvaluateOnNewDocument",
        { source: injectionSource },
        sessionId,
      );
      await send(
        "Runtime.evaluate",
        { expression: injectionSource, returnByValue: true },
        sessionId,
      );
      log(`RTL fix injected into ${targetInfo.url}`);
      if (replyStartSource) {
        try {
          await send("Page.addScriptToEvaluateOnNewDocument", { source: replyStartSource }, sessionId);
          await send("Runtime.evaluate", { expression: replyStartSource, returnByValue: true }, sessionId);
        } catch (error) {
          log(`Opening threads at the start of the last reply could not be added: ${error.message}`);
        }
      }
      if (repoStatus) {
        try {
          await repoStatus.attach(sessionId);
        } catch (error) {
          log(`Repository status could not be added: ${error.message}`);
        }
      }
      if (extras && isRegularT3Page(targetInfo)) {
        try {
          await extras.attach(sessionId);
        } catch (error) {
          log(`Extras could not be added: ${error.message}`);
        }
      }
    } catch (error) {
      sessionsByTarget.delete(targetId);
      log(`Injection failed for target ${targetId}: ${error.message}`);
    }
    // A change of the switch while this window was attaching may have been sent
    // before the window was on the list. Reload it after the attempt to add
    // every fix, whether that attempt failed or not.
    const sessionId = appPages.get(targetId);
    if (sessionId && changedWhileAttaching && workingShelfWatch && (await workingShelfWatch)) {
      await workingShelf.reloadWindows([sessionId]);
    }
  }

  function forgetSession(sessionId) {
    annotationSessionsLogged.delete(sessionId);
    layoutSessions.delete(sessionId);
    layoutScripts.delete(sessionId);
    chatWidthSessions.delete(sessionId);
    chatWidthScripts.delete(sessionId);
    layoutQueues.delete(sessionId);
    dispatch.targetDestroyed(sessionId);
  }

  // Returns whether this core took the message. The host answers a paused
  // request that no core took.
  function handle(message) {
    // Not the sessions of another version, nor the host's own short ones.
    if (stopped || (message.sessionId && !ownsSession(message.sessionId))) return false;
    if (dispatch.handle(message)) return true;

    // Fetch is enabled for the browser, so its pauses come without a session.
    if (message.method === "Fetch.requestPaused" && !message.sessionId) {
      if (!workingShelf) return false;
      void workingShelf.handlePaused(message.params);
      return true;
    }

    if (message.method === "Runtime.bindingCalled" && message.params?.name === ANNOTATION_BINDING) {
      const sessionId = message.sessionId;
      const trigger = message.params?.payload ?? "focus";
      applyAnnotationDirection(send, sessionId).then(
        ({ hosts, fields }) => {
          // Record every miss, but a success only once per preview session, so
          // the log does not grow with every comment typed.
          if (fields === 0) {
            log(`Annotation ${trigger}: no comment field was found in ${hosts} annotation hosts`);
          } else if (!annotationSessionsLogged.has(sessionId)) {
            annotationSessionsLogged.add(sessionId);
            log(`Annotation ${trigger}: ${fields} comment fields set to dir="auto"`);
          }
        },
        (error) => {
          log(`Could not set the annotation comment direction: ${error.message}`);
        },
      );
      return true;
    }

    if (message.method === "Target.targetCreated" || message.method === "Target.targetInfoChanged") {
      void attachAndInject(message.params?.targetInfo);
      return true;
    }

    if (message.method === "Target.targetDestroyed") {
      const targetId = message.params?.targetId;
      const sessionId = sessionsByTarget.get(targetId);
      if (sessionId) forgetSession(sessionId);
      appPages.delete(targetId);
      sessionsByTarget.delete(targetId);
      return true;
    }
    return false;
  }

  // Interception first, before a window loads T3 Code's script; a failure
  // there only leaves the Working section as T3 Code has it. Then every T3
  // Code window and preview, now and later.
  async function start() {
    stopped = false;
    await watchWorkingShelf();
    await hostSend("Target.setDiscoverTargets", { discover: true });
    const { targetInfos = [] } = await hostSend("Target.getTargets");
    await Promise.all(targetInfos.map(attachAndInject));
  }

  // Resolves when no attach is in progress.
  async function settled() {
    while (attaching.size > 0) await Promise.all([...attaching.values()]);
  }

  // Detaches every session, which drops its new-document scripts and
  // bindings. What already runs in a document stays until it reloads. The
  // browser keeps intercepting T3 Code's script; the host answers what no
  // core takes.
  async function stop() {
    stopped = true;
    const sessions = [...sessionsByTarget.values()];
    for (const sessionId of sessions) forgetSession(sessionId);
    sessionsByTarget.clear();
    appPages.clear();
    workingShelfWatch = null;
    await Promise.all(sessions.map((sessionId) => hostSend("Target.detachFromTarget", { sessionId }).catch(() => {})));
  }

  function ownsSession(sessionId) {
    for (const owned of sessionsByTarget.values()) if (owned === sessionId) return true;
    return false;
  }

  return { start, stop, settled, handle, ownsSession, sessionIds: () => [...sessionsByTarget.values()] };
}

// node:sqlite exists without a flag only in newer Node.js releases. Nothing
// is opened here.
function sqliteLoads() {
  try {
    return typeof require("node:sqlite").DatabaseSync === "function";
  } catch {
    return false;
  }
}

module.exports = { REQUIRES_HOST_API, prepareCore };
