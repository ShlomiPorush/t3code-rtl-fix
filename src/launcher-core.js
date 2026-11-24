"use strict";

// The launcher prepares the core before T3 Code starts, so prepareCore must
// not send anything over the debugging pipe.

const fs = require("node:fs");
const path = require("node:path");
const { buildInjectionSource } = require("./injection");
const { createDispatch } = require("./cdp-dispatch");
const {
  ANNOTATION_BINDING,
  applyAnnotationDirection,
  watchAnnotations,
} = require("./annotation-direction");

// Extras read the regular build's data folder, so the development build gets none.
function isRegularT3Page(targetInfo) {
  return /^t3code:\/\//i.test(targetInfo?.url || "");
}

function isT3Page(targetInfo) {
  return targetInfo?.type === "page" && /^t3code(?:-dev)?:\/\//i.test(targetInfo.url || "");
}

function isT3Preview(targetInfo) {
  return targetInfo?.type === "webview";
}

function readRtlAndCustomCss(rootDirectory, log) {
  const css = fs.readFileSync(path.join(__dirname, "rtl.css"), "utf8");
  const customPath = path.join(rootDirectory, "custom.css");
  try {
    return `${css}\n${fs.readFileSync(customPath, "utf8")}`;
  } catch (error) {
    if (error.code !== "ENOENT") log(`Could not read ${customPath}: ${error.message}`);
    return css;
  }
}

function prepareCore({ send, log, rootDirectory }) {
  const injectionSource = buildInjectionSource(readRtlAndCustomCss(rootDirectory, log));

  // Each extra loads in its own try, so one that fails leaves the rest running.
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

  let buildLayoutSource = null;
  try {
    ({ buildLayoutSource } = require("./app-layout"));
  } catch (error) {
    log(`The right-to-left layout is off: ${error.message}`);
  }
  let rtlLayout = initialSettings.rtlLayout !== false;

  let buildChatWidthSource = null;
  try {
    ({ buildChatWidthSource } = require("./chat-width"));
  } catch (error) {
    log(`The chat width is off: ${error.message}`);
  }
  let chatWidth = initialSettings.chatWidth ?? null;

  let replyStartSource = null;
  try {
    replyStartSource = require("./reply-start").buildReplyStartSource();
  } catch (error) {
    log(`Opening threads at the start of the last reply is off: ${error.message}`);
  }

  const sectionsOf = (settings) => ({
    working: settings.boringWorkingShelf === true,
    done: settings.boringDoneShelf === true,
    pinned: settings.boringPlainPinned === true,
  });
  let sidebarSections = sectionsOf(initialSettings);
  let workingShelf = null;
  let workingShelfWatch = null;
  try {
    const { createWorkingShelfService } = require("./working-shelf");
    workingShelf = createWorkingShelfService({
      send: (...args) => send(...args),
      sections: () => sidebarSections,
      log,
    });
  } catch (error) {
    log(`The changes to the boring sidebar are off: ${error.message}`);
  }

  // Never turned off, so a request paused while a switch turns off is still answered.
  function watchWorkingShelf() {
    if (!workingShelf || !Object.values(sidebarSections).includes(true)) return Promise.resolve(false);
    if (!workingShelfWatch) {
      workingShelfWatch = workingShelf.enable().then((watching) => {
        if (!watching) workingShelfWatch = null;
        return watching;
      });
    }
    return workingShelfWatch;
  }

  async function switchSidebarSections(next) {
    if (Object.keys(next).every((name) => next[name] === sidebarSections[name])) return;
    sidebarSections = next;
    const watching = Object.values(next).includes(true) ? await watchWorkingShelf() : workingShelfWatch !== null && (await workingShelfWatch);
    if (!watching) return;
    const reloaded = await workingShelf.reloadWindows([...appPages.values()]);
    const state = (on) => (on ? "on" : "off");
    log(`Boring sidebar: Working ${state(next.working)}, Done ${state(next.done)}, plain pinned ${state(next.pinned)}, ${reloaded} windows reloaded`);
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

  let updates = null;
  try {
    updates = require("./updates").createUpdateService({ directory: rootDirectory, log });
  } catch (error) {
    log(`Updates of the fix from Extras are off: ${error.message}`);
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
        updates,
      });
    } catch (error) {
      log(`Extras are off: ${error.message}`);
    }
    settingsStore.onChange((settings) => {
      repoStatus?.setEnabled(settings.repoStatus && repoStatusRuns);
      const nextLayout = settings.rtlLayout !== false;
      if (nextLayout !== rtlLayout) {
        rtlLayout = nextLayout;
        for (const sessionId of layoutSessions) void switchLayout(sessionId);
      }
      void switchSidebarSections(sectionsOf(settings));
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
  // By target, so start() also waits for an attach that an event began.
  const attaching = new Map();
  const annotationSessionsLogged = new Set();
  const layoutSessions = new Set();
  const layoutScripts = new Map();
  const appPages = new Map();

  // One step at a time per session, so quick changes never lose track of a script.
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
    if ((!isT3Page(targetInfo) && !isT3Preview(targetInfo)) || sessionsByTarget.has(targetId)) {
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
    try {
      const attached = await send("Target.attachToTarget", {
        targetId,
        flatten: true,
      });
      const sessionId = attached.sessionId;
      sessionsByTarget.set(targetId, sessionId);
      // Before the later awaits, so a change of the sidebar sections from here on reloads this window too.
      if (isPage && isRegularT3Page(targetInfo)) appPages.set(targetId, sessionId);

      if (!isPage) {
        await watchAnnotations(send, sessionId);
        log("Annotation direction watcher added to a browser preview");
        return;
      }

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
      const sessionId = forgetTarget(targetId);
      // Detaching sends an event for the window. Awaited, so that event does not start another attach.
      if (sessionId) await send("Target.detachFromTarget", { sessionId }).catch(() => {});
      log(`Injection failed for target ${targetId}: ${error.message}`);
    }
  }

  function forgetTarget(targetId) {
    const sessionId = sessionsByTarget.get(targetId);
    if (sessionId) forgetSession(sessionId);
    appPages.delete(targetId);
    sessionsByTarget.delete(targetId);
    return sessionId;
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

  function handle(message) {
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
          // Success is logged once per preview, so the log does not grow with each comment.
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
      forgetTarget(message.params?.targetId);
      return true;
    }
    return false;
  }

  // Interception first, before a window loads T3 Code's script.
  async function start() {
    await watchWorkingShelf();
    await send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos = [] } = await send("Target.getTargets");
    await Promise.all(targetInfos.map(attachAndInject));
  }

  // Interception stays on for the next core; the launcher passes on what no core takes.
  async function stop() {
    const sessions = [...sessionsByTarget.values()];
    for (const sessionId of sessions) forgetSession(sessionId);
    sessionsByTarget.clear();
    appPages.clear();
    workingShelfWatch = null;
    await Promise.all(sessions.map((sessionId) => send("Target.detachFromTarget", { sessionId }).catch(() => {})));
  }

  return { start, stop, handle };
}

// node:sqlite exists without a flag only in newer Node.js releases.
function sqliteLoads() {
  try {
    return typeof require("node:sqlite").DatabaseSync === "function";
  } catch {
    return false;
  }
}

module.exports = { prepareCore };
