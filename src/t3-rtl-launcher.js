"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildInjectionSource } = require("./injection");
const {
  ANNOTATION_BINDING,
  applyAnnotationDirection,
  watchAnnotations,
} = require("./annotation-direction");
const { readExecutableSignature, watchForReplacement } = require("./update-watch");

const cssPath = path.join(__dirname, "rtl.css");
const appPathFile = path.join(__dirname, "app-path.txt");
const logPath = path.join(__dirname, "launcher.log");
const windowsLauncherPath = path.join(__dirname, "launch-t3-rtl.vbs");

// After T3 Code exits, an update may be installing. Its installer reopens
// T3 Code directly, without the fix, and points the Start Menu shortcut at
// it again. The launcher watches the executable for a few minutes and, when
// it changes, hands over to the Windows helper, which waits for the reopened
// app, repairs the shortcuts and tells the user to reopen T3 Code.
const UPDATE_POLL_MS = 2000;
const UPDATE_WINDOW_MS = 3 * 60 * 1000;
// A second launch while T3 Code is already open exits at once and hands its
// window to the running app. Such a short run is never an update.
const MIN_RUN_BEFORE_UPDATE_MS = 15 * 1000;

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
const launchSignature = readExecutableSignature(appPath);
const launchedAt = Date.now();

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

function send(method, params = {}, sessionId) {
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
  try {
    const attached = await send("Target.attachToTarget", {
      targetId,
      flatten: true,
    });
    const sessionId = attached.sessionId;
    sessionsByTarget.set(targetId, sessionId);

    if (!isPage) {
      await watchAnnotations(send, sessionId);
      log("Annotation direction watcher added to a browser preview");
      return;
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
  } catch (error) {
    sessionsByTarget.delete(targetId);
    log(`Injection failed for target ${targetId}: ${error.message}`);
  } finally {
    attachingTargets.delete(targetId);
  }
}

function handleMessage(message) {
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
    annotationSessionsLogged.delete(sessionsByTarget.get(message.params?.targetId));
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

child.on("exit", (code, signal) => {
  for (const request of pending.values()) {
    request.reject(new Error("T3 Code closed before the CDP request completed"));
  }
  pending.clear();
  log(`T3 Code exited (code=${code ?? "none"}, signal=${signal ?? "none"})`);
  // T3 Code's own processes, including one reopened by an update, can keep
  // the debugging pipe open, so the launcher has to end on its own.
  void watchAfterExit().finally(() => process.exit(0));
});

async function watchAfterExit() {
  if (process.platform !== "win32" || launchSignature === null) return;
  if (Date.now() - launchedAt < MIN_RUN_BEFORE_UPDATE_MS) return;
  const replaced = await watchForReplacement({
    readSignature: () => readExecutableSignature(appPath),
    initialSignature: launchSignature,
    intervalMs: UPDATE_POLL_MS,
    timeoutMs: UPDATE_WINDOW_MS,
  });
  if (!replaced) return;
  log("T3 Code is being updated, waiting for it to reopen");
  try {
    const helper = spawn(
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "wscript.exe"),
      [windowsLauncherPath, "/updated"],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    helper.on("error", (error) => log(`Could not start the update helper: ${error.message}`));
    helper.unref();
  } catch (error) {
    log(`Could not start the update helper: ${error.message}`);
  }
}

async function initialize() {
  try {
    await send("Target.setDiscoverTargets", { discover: true });
    const { targetInfos = [] } = await send("Target.getTargets");
    await Promise.all(targetInfos.map(attachAndInject));
  } catch (error) {
    log(`Could not initialize the debugging pipe: ${error.message}`);
  }
}

void initialize();
