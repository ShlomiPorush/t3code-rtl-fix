"use strict";

// The launcher. It opens T3 Code with a debugging pipe and keeps that pipe
// for T3 Code's whole life. What the fix does in T3 Code's windows is the
// core (launcher-core.js and the files beside it), which the launcher loads
// from this folder. The installers write version.txt after every other file,
// and while T3 Code runs the launcher checks it every two seconds. When it
// changes, the launcher loads the new core, stops the running one, starts
// the new one, and reloads T3 Code's windows. Only the windows reload; T3
// Code's server and the sessions it runs keep running.
//
// A change to this file itself takes effect when T3 Code is next opened
// through the launcher.

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const POLL_MS = 2000;

function isT3Page(targetInfo) {
  return targetInfo?.type === "page" && /^t3code(?:-dev)?:\/\//i.test(targetInfo.url || "");
}

// Runs one core at a time and hands it every message the browser sends.
function createHost({ send, log, loadCore, readVersion }) {
  let core = null;
  let version = null;
  let busy = false;

  function route(message) {
    if (core && core.handle(message)) return;
    // T3 Code's script, paused for a core that did not take it or is gone,
    // goes on unchanged, so no window waits for it.
    const requestId = message.params?.requestId;
    if (message.method === "Fetch.requestPaused" && !message.sessionId && requestId) {
      send("Fetch.continueRequest", { requestId }).catch((error) => {
        log(`Could not pass T3 Code's script on: ${error.message}`);
      });
    }
  }

  // Loads the installed core, or returns null when it cannot be loaded. The
  // version it read is not tried again until the next install.
  function load() {
    version = readVersion();
    try {
      return loadCore();
    } catch (error) {
      log(`The RTL fix could not be loaded: ${error.message}. Run the installer again.`);
      return null;
    }
  }

  async function start(next) {
    core = next;
    try {
      await next.start();
      return true;
    } catch (error) {
      core = null;
      log(`The RTL fix could not start: ${error.message}`);
      await next.stop().catch(() => {});
      return false;
    }
  }

  // Reloads every T3 Code window through a session of its own, so it works
  // whatever core runs, or none.
  async function reloadWindows() {
    let reloaded = 0;
    try {
      const { targetInfos = [] } = await send("Target.getTargets");
      for (const targetInfo of targetInfos.filter(isT3Page)) {
        try {
          const { sessionId } = await send("Target.attachToTarget", { targetId: targetInfo.targetId, flatten: true });
          try {
            await send("Page.reload", { ignoreCache: true }, sessionId);
            reloaded += 1;
          } finally {
            send("Target.detachFromTarget", { sessionId }).catch(() => {});
          }
        } catch (error) {
          log(`A window was not reloaded: ${error.message}`);
        }
      }
    } catch (error) {
      log(`The windows could not be reloaded: ${error.message}`);
    }
    return reloaded;
  }

  // At launch, with the core loaded before T3 Code started, if any.
  async function launch(prepared) {
    if (prepared) await start(prepared);
  }

  // Replaces the running core when version.txt changed. When the new core
  // cannot be loaded, the running one stays. When it cannot start, T3 Code
  // runs without the fix until the next install or launch.
  async function checkForUpdate() {
    if (busy || readVersion() === version) return;
    busy = true;
    try {
      const next = load();
      if (!next) return;
      const previous = core;
      core = null;
      if (previous) await previous.stop().catch((error) => log(`The running fix did not stop cleanly: ${error.message}`));
      const started = await start(next);
      const reloaded = await reloadWindows();
      log(started
        ? `Fix updated without a restart, ${reloaded} windows reloaded`
        : `The RTL fix is off until it is installed again or T3 Code is opened again, ${reloaded} windows reloaded`);
    } finally {
      busy = false;
    }
  }

  return { route, load, launch, checkForUpdate };
}

// Prepares the core installed in directory. This folder's modules leave
// Node's cache first, so the files that an install replaced are read again;
// a running core keeps the modules it has.
function loadCore(directory, options) {
  for (const file of Object.keys(require.cache)) {
    if (path.dirname(file) === directory && file !== __filename) delete require.cache[file];
  }
  return require(path.join(directory, "launcher-core.js")).prepareCore(options);
}

function readSavedPath(filePath) {
  const contents = fs.readFileSync(filePath);
  if (contents[0] === 0xff && contents[1] === 0xfe) {
    return contents.subarray(2).toString("utf16le").trim();
  }
  return contents.toString("utf8").replace(/^\uFEFF/, "").trim();
}

function main() {
  const rootDirectory = __dirname;
  const appPathFile = path.join(rootDirectory, "app-path.txt");
  const logPath = path.join(rootDirectory, "launcher.log");
  const windowsLauncherPath = path.join(rootDirectory, "launch-t3-rtl.vbs");

  function log(message) {
    const stamp = new Date().toISOString();
    try {
      fs.appendFileSync(logPath, `${stamp} ${message}\n`, "utf8");
    } catch {
      // Logging must never prevent the app from opening.
    }
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

  const host = createHost({
    send,
    log,
    readVersion,
    loadCore: () => loadCore(rootDirectory, { send, log, rootDirectory }),
  });

  // Before T3 Code starts, so the first window finds the fix ready.
  const prepared = host.load();

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

  // Once the pipe closes, nothing more is sent, and every request still
  // waiting fails, so no caller waits for an answer that cannot come.
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

  function readVersion() {
    try {
      return fs.readFileSync(path.join(rootDirectory, "version.txt"), "utf8").trim();
    } catch {
      return null;
    }
  }

  function handleMessage(message) {
    if (message.id) {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) {
        request.reject(new Error(`${request.method}: ${message.error.message || "CDP error"}`));
      } else {
        request.resolve(message.result || {});
      }
      return;
    }
    host.route(message);
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
        log(`Could not handle a CDP message: ${error.message}`);
      }
    }
  });

  cdpInput.on("error", (error) => {
    log(`CDP input error: ${error.message}`);
    closeConnection("The debugging pipe failed");
  });
  cdpOutput.on("error", (error) => log(`CDP output error: ${error.message}`));
  cdpOutput.on("close", () => closeConnection("The debugging pipe closed before the CDP request completed"));

  let poller = null;
  child.on("exit", (code, signal) => {
    if (poller) clearInterval(poller);
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

  void (async () => {
    await host.launch(prepared);
    if (cdpClosed) return;
    poller = setInterval(() => void host.checkForUpdate(), POLL_MS);
  })();
}

if (require.main === module) main();

module.exports = { createHost, loadCore };
