"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildInjectionSource } = require("./injection");
const { createDispatch } = require("./cdp-dispatch");
const {
  ANNOTATION_BINDING,
  applyAnnotationDirection,
  watchAnnotations,
} = require("./annotation-direction");

const cssPath = path.join(__dirname, "rtl.css");
const appPathFile = path.join(__dirname, "app-path.txt");
const logPath = path.join(__dirname, "launcher.log");
const windowsLauncherPath = path.join(__dirname, "launch-t3-rtl.vbs");


function log(message) {
  const stamp = new Date().toISOString();
  try {
    fs.appendFileSync(logPath, `${stamp} ${message}\n`, "utf8");
  } catch {
    // Logging must never prevent the app from opening.
  }
}

function readSavedPath(filePath) {
  const contents = fs.readFileSync(filePath);
  if (contents[0] === 0xff && contents[1] === 0xfe) {
    return contents.subarray(2).toString("utf16le").trim();
  }
  return contents.toString("utf8").replace(/^\uFEFF/, "").trim();
}

let appPath;
try {
  appPath = readSavedPath(appPathFile);
} catch (error) {
  log(`Could not read ${appPathFile}: ${error.message}`);
  process.exit(1);
}

const t3Environment = { ...process.env };
delete t3Environment.ELECTRON_RUN_AS_NODE;

function startWithoutInjection(reason) {
  log(`Starting without the RTL fix: ${reason}`);
  if (!fs.existsSync(appPath)) return;
  const fallback = spawn(appPath, [], {
    detached: true,
    env: t3Environment,
    stdio: "ignore",
    windowsHide: false,
  });
  fallback.unref();
}

if (!fs.existsSync(appPath)) {
  log(`T3 Code executable was not found at ${appPath}`);
  process.exit(1);
}

let css;
try {
  css = fs.readFileSync(cssPath, "utf8");
} catch (error) {
  startWithoutInjection(`could not read ${cssPath}: ${error.message}`);
  process.exit(1);
}

const injectionSource = buildInjectionSource(css);

// Optional settings.json beside the launcher, such as { "repoStatus": false },
// which the Extras section on T3 Code's Labs page also changes. The installer
// never writes it, so a reinstall keeps the user's choices. Each extra loads
// on its own, so a failure in one leaves the RTL fix and the others running.
let settingsStore = null;
let t3Home = null;
try {
  const { createSettingsStore, resolveT3Home } = require("./extras-settings");
  t3Home = resolveT3Home();
  settingsStore = createSettingsStore({ directory: __dirname, t3Home, log });
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

// Opens a thread at the start of the agent's last reply. It loads on its own
// too, so a failure leaves the rest of the fix running.
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
// Quick changes reload once, for the last one.
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

// node:sqlite exists without a flag only in newer Node.js releases. Nothing
// is opened here.
function sqliteLoads() {
  try {
    return typeof require("node:sqlite").DatabaseSync === "function";
  } catch {
    return false;
  }
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

const child = spawn(appPath, ["--remote-debugging-pipe"], {
  env: t3Environment,
  stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  windowsHide: false,
});

child.once("error", (error) => {
  startWithoutInjection(`could not launch with the debugging pipe: ${error.message}`);
});

const cdpInput = child.stdio[3];
const cdpOutput = child.stdio[4];
let nextMessageId = 1;
let incoming = Buffer.alloc(0);
const pending = new Map();
const sessionsByTarget = new Map();
const attachingTargets = new Set();
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

// Once the pipe closes, nothing more is sent, and every request still waiting
// fails, so no caller waits for an answer that cannot come.
let cdpClosed = false;
function closeConnection(reason) {
  if (cdpClosed) return;
  cdpClosed = true;
  for (const request of pending.values()) request.reject(new Error(reason));
  pending.clear();
}

function send(method, params = {}, sessionId) {
  if (cdpClosed) return Promise.reject(new Error("The debugging pipe is closed"));
  const id = nextMessageId++;
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;

  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, method });
    try {
      cdpInput.write(`${JSON.stringify(message)}\0`, "utf8");
    } catch (error) {
      pending.delete(id);
      reject(error);
    }
  });
}

// Extras read the regular build's data folder, so the development build's
// page, whose provider list lives elsewhere, does not get them.
function isRegularT3Page(targetInfo) {
  return /^t3code:\/\//i.test(targetInfo?.url || "");
}

function isT3Page(targetInfo) {
  return (
    targetInfo?.type === "page" &&
    /^t3code(?:-dev)?:\/\//i.test(targetInfo.url || "")
  );
}

// T3 Code's browser preview runs in a <webview>, where T3 draws its element
// annotation window.
function isT3Preview(targetInfo) {
  return targetInfo?.type === "webview";
}

async function attachAndInject(targetInfo) {
  const targetId = targetInfo?.targetId;
  const isPage = isT3Page(targetInfo);
  if (
    (!isPage && !isT3Preview(targetInfo)) ||
    sessionsByTarget.has(targetId) ||
    attachingTargets.has(targetId)
  ) {
    return;
  }

  attachingTargets.add(targetId);
  const changesBeforeAttach = workingShelfChanges;
  try {
    const attached = await send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;
    sessionsByTarget.set(targetId, sessionId);
    // At once, so a change of the switch from now on reloads this window too.
    if (isPage && isRegularT3Page(targetInfo)) appPages.set(targetId, sessionId);
    const changedWhileAttaching = workingShelfChanges !== changesBeforeAttach;

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
    // A change of the switch while this window was attaching may have been
    // sent before the window was on the list. Reload it once it has every fix.
    if (appPages.has(targetId) && changedWhileAttaching && workingShelfWatch && (await workingShelfWatch)) {
      await workingShelf.reloadWindows([sessionId]);
    }
  } catch (error) {
    sessionsByTarget.delete(targetId);
    log(`Injection failed for target ${targetId}: ${error.message}`);
  } finally {
    attachingTargets.delete(targetId);
  }
}

function handleMessage(message) {
  if (dispatch.handle(message)) return;

  // Fetch is enabled for the browser, so its pauses come without a session.
  if (message.method === "Fetch.requestPaused" && !message.sessionId) {
    if (workingShelf) void workingShelf.handlePaused(message.params);
    return;
  }

  if (
    message.method === "Runtime.bindingCalled" &&
    message.params?.name === ANNOTATION_BINDING
  ) {
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
    return;
  }

  if (message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) {
      request.reject(
        new Error(`${request.method}: ${message.error.message || "CDP error"}`),
      );
    } else {
      request.resolve(message.result || {});
    }
    return;
  }

  if (
    message.method === "Target.targetCreated" ||
    message.method === "Target.targetInfoChanged"
  ) {
    void attachAndInject(message.params?.targetInfo);
    return;
  }

  if (message.method === "Target.targetDestroyed") {
    const destroyedSession = sessionsByTarget.get(message.params?.targetId);
    annotationSessionsLogged.delete(destroyedSession);
    layoutSessions.delete(destroyedSession);
    layoutScripts.delete(destroyedSession);
    appPages.delete(message.params?.targetId);
    chatWidthSessions.delete(destroyedSession);
    chatWidthScripts.delete(destroyedSession);
    layoutQueues.delete(destroyedSession);
    dispatch.targetDestroyed(destroyedSession);
    sessionsByTarget.delete(message.params?.targetId);
  }
}

cdpOutput.on("data", (chunk) => {
  incoming = Buffer.concat([incoming, chunk]);
  while (true) {
    const separator = incoming.indexOf(0);
    if (separator === -1) break;
    const raw = incoming.subarray(0, separator).toString("utf8");
    incoming = incoming.subarray(separator + 1);
    if (!raw) continue;
    try {
      handleMessage(JSON.parse(raw));
    } catch (error) {
      log(`Could not parse a CDP message: ${error.message}`);
    }
  }
});

cdpInput.on("error", (error) => log(`CDP input error: ${error.message}`));
cdpOutput.on("error", (error) => log(`CDP output error: ${error.message}`));
cdpOutput.on("close", () => closeConnection("The debugging pipe closed before the CDP request completed"));

child.on("exit", (code, signal) => {
  closeConnection("T3 Code closed before the CDP request completed");
  log(`T3 Code exited (code=${code ?? "none"}, signal=${signal ?? "none"})`);
  // T3 Code exits before an update is installed, and the update's installer
  // reopens it directly, without the fix. The Windows helper waits a few
  // minutes for that, then repairs the shortcuts and tells the user. It runs
  // in its own process, outside the T3 Code executable that the installer
  // replaces.
  if (process.platform === "win32") startUpdateHelper();
  // T3 Code's own processes, including one reopened by an update, can keep
  // the debugging pipe open, so the launcher has to end on its own.
  process.exit(0);
});

function startUpdateHelper() {
  try {
    const helper = spawn(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe"),
      [windowsLauncherPath, "/updated"],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    helper.on("error", () => {});
    helper.unref();
  } catch (error) {
    log(`Could not start the update helper: ${error.message}`);
  }
}

async function initialize() {
  // Before the first window loads its script. A failure here only leaves the
  // Working section as T3 Code has it.
  await watchWorkingShelf();
  try {
    await send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos = [] } = await send("Target.getTargets");
    await Promise.all(targetInfos.map(attachAndInject));
  } catch (error) {
    log(`Could not initialize the debugging pipe: ${error.message}`);
  }
}

void initialize();
