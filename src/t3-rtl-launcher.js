"use strict";

// The launcher host. It opens T3 Code with a debugging pipe and keeps that
// pipe for T3 Code's whole life, so it must not change while T3 Code runs.
// What the fix does in T3 Code's windows is the core (launcher-core.js). The
// installers put each version of the core in its own folder, versions/<id>,
// and name the newest in current.txt last, so the host never loads a
// half-copied version. The host starts that version and, while T3 Code runs,
// switches to a newer one when current.txt changes: it starts the new core,
// then reloads T3 Code's windows. Only the windows reload; T3 Code's server
// and the sessions it runs keep running.
//
// The installers replace this file last. A changed host takes effect when
// T3 Code is next opened through the launcher.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

// What the host offers a core. A core states the one it needs.
const HOST_API = 1;
const VERSION_ID = /^[A-Za-z0-9._-]{1,80}$/;
const STEP_TIMEOUT_MS = 30000;
const POLL_MS = 2000;

function isT3Page(targetInfo) {
  return targetInfo?.type === "page" && /^t3code(?:-dev)?:\/\//i.test(targetInfo.url || "");
}

// Rejects when the promise takes longer than ms. The work itself goes on; a
// core that is stopped meanwhile gives up what it gets late.
function within(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)} s`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Starts a version of the core and keeps every message the browser sends
// routed to exactly one owner: the running core, the core being started, or
// the host itself, which lets a paused script through unchanged when no core
// takes it. One start or switch runs at a time.
function createHost({ send, log, loadCore, readVersion, writeLastGood, stepTimeout = STEP_TIMEOUT_MS }) {
  let core = null;
  let runningId = null;
  let busy = false;
  // During a start or switch: the messages held for the new core, and the
  // core being started. A core takes only its own sessions' events, so the
  // ones of a core that was replaced are dropped when they are handed over.
  let held = null;
  let candidate = null;
  // The versions prepared before T3 Code started, for the launch.
  let launchVersions = null;
  // Versions that failed in this run. A new install has a new id.
  const rejected = new Set();
  const timed = (promise, what) => within(promise, stepTimeout, what);

  function letThrough(message) {
    const requestId = message.params?.requestId;
    if (!requestId) return;
    send("Fetch.continueRequest", { requestId }).catch((error) => {
      log(`Could not pass T3 Code's script on: ${error.message}`);
    });
  }

  function route(message) {
    const pausedScript = message.method === "Fetch.requestPaused" && !message.sessionId;
    if (held) {
      if (candidate && (pausedScript || (message.sessionId && candidate.ownsSession(message.sessionId)))) {
        if (candidate.handle(message)) return;
      }
      if (pausedScript) return letThrough(message);
      held.push(message);
      return;
    }
    if (core && core.handle(message)) return;
    if (pausedScript) letThrough(message);
  }

  // From here on the new core gets every message, beginning with the ones
  // held for it. Nothing can arrive in between.
  function handOver(next) {
    core = next;
    const messages = held || [];
    held = null;
    candidate = null;
    for (const message of messages) route(message);
  }

  function prepare(id) {
    const loaded = loadCore(id);
    if (loaded.requiresHostApi !== HOST_API) {
      throw new Error(`it needs launcher host ${loaded.requiresHostApi}, and this launcher is ${HOST_API}. Quit T3 Code fully and open it again`);
    }
    return loaded.prepare();
  }

  // Starts a prepared core while messages are held, then hands them over.
  async function startCore(next) {
    held = held || [];
    candidate = next;
    try {
      await timed(next.start(), "starting the fix");
      handOver(next);
      await timed(next.settled(), "adding the fix to every window");
    } catch (error) {
      candidate = null;
      await timed(next.stop(), "stopping the fix").catch(() => {});
      throw error;
    }
  }

  // Reloads every T3 Code window, each through a session of its own, so it
  // works whatever core runs, or none. A window that closes meanwhile does
  // not count; one that stays and does not reload does.
  async function reloadWindows() {
    const { targetInfos = [] } = await timed(send("Target.getTargets"), "listing T3 Code's windows");
    let reloaded = 0;
    let failed = 0;
    for (const targetInfo of targetInfos.filter(isT3Page)) {
      let late = false;
      const attach = send("Target.attachToTarget", { targetId: targetInfo.targetId, flatten: true });
      attach.then(({ sessionId }) => late && send("Target.detachFromTarget", { sessionId }).catch(() => {}), () => {});
      let sessionId;
      try {
        ({ sessionId } = await timed(attach, "opening a window"));
      } catch (error) {
        late = true;
        log(`A window was not reloaded, it may have closed: ${error.message}`);
        continue;
      }
      try {
        await timed(send("Page.reload", { ignoreCache: true }, sessionId), "reloading a window");
        reloaded += 1;
      } catch (error) {
        failed += 1;
        log(`A window could not be reloaded: ${error.message}`);
      } finally {
        send("Target.detachFromTarget", { sessionId }).catch(() => {});
      }
    }
    return { reloaded, failed };
  }

  // Reloads and says how it went, for a step that has nothing left to try.
  async function reloadForLog() {
    try {
      const { reloaded, failed } = await reloadWindows();
      return failed ? `${reloaded} windows reloaded and ${failed} not` : `${reloaded} windows reloaded`;
    } catch (error) {
      return `the windows could not be reloaded (${error.message})`;
    }
  }

  // Loads the versions to try at launch, before T3 Code starts, so the first
  // window finds the fix as ready as before the host and core were split.
  function prepareLaunch() {
    launchVersions = [];
    for (const name of ["current", "last-good"]) {
      const id = readVersion(name);
      if (!id || rejected.has(id) || launchVersions.some((version) => version.id === id)) continue;
      try {
        launchVersions.push({ id, core: prepare(id) });
      } catch (error) {
        rejected.add(id);
        log(`Version ${id} of the fix could not be loaded: ${error.message}`);
      }
    }
  }

  // At launch: the installed version, else the last one that started, else
  // T3 Code without the fix. A version that failed after it touched a window
  // leaves that window to reload once another choice is made.
  async function launch() {
    if (!launchVersions) prepareLaunch();
    busy = true;
    held = [];
    let touched = false;
    try {
      for (const { id, core: next } of launchVersions) {
        const touchedBefore = touched;
        touched = true;
        try {
          await startCore(next);
        } catch (error) {
          rejected.add(id);
          log(`Version ${id} of the fix could not start: ${error.message}`);
          continue;
        }
        runningId = id;
        writeLastGood(id);
        if (touchedBefore) log(`Started version ${id} of the fix, ${await reloadForLog()}`);
        return true;
      }
      handOver(null);
      log("The RTL fix is off: no installed version could start. Run the installer again.");
      if (touched) log(`Without the fix, ${await reloadForLog()}`);
      return false;
    } finally {
      launchVersions = [];
      if (held) handOver(core);
      busy = false;
    }
  }

  // Replaces the running core with version id, or keeps it when the new one
  // fails to load. A new core that fails to start, or whose windows do not
  // reload, gives way to the old one, and the windows reload again.
  async function switchTo(id) {
    let next;
    try {
      next = prepare(id);
    } catch (error) {
      rejected.add(id);
      log(`The update to version ${id} was not applied: ${error.message}`);
      return;
    }
    const previous = core;
    const previousId = runningId;
    held = [];
    core = null;
    if (previous) {
      await timed(previous.stop(), "stopping the running fix").catch((error) => log(`The running fix did not stop cleanly: ${error.message}`));
    }
    let reloaded;
    try {
      await startCore(next);
      const result = await reloadWindows();
      if (result.failed) throw new Error(`${result.failed} windows could not be reloaded`);
      reloaded = result.reloaded;
    } catch (error) {
      rejected.add(id);
      log(`The update to version ${id} failed: ${error.message}`);
      // A core that started took over the messages; one that did not is
      // already stopped.
      const tookOver = core === next;
      held = [];
      core = null;
      if (tookOver) await timed(next.stop(), "stopping the fix").catch(() => {});
      if (previous) {
        try {
          await startCore(previous);
          runningId = previousId;
          log(`The previous version is back, ${await reloadForLog()}. Quit T3 Code fully and open it again to finish the update.`);
          return;
        } catch (restoreError) {
          log(`The previous version could not start again: ${restoreError.message}`);
        }
      }
      handOver(null);
      runningId = null;
      log(`The RTL fix is off until T3 Code is opened again, ${await reloadForLog()}.`);
      return;
    }
    runningId = id;
    writeLastGood(id);
    log(`Fix updated to version ${id} without a restart, ${reloaded} windows reloaded`);
  }

  // Switches when current.txt names a version that is not running and did
  // not fail in this run, and reads it again after each switch.
  async function checkForUpdate() {
    if (busy) return;
    const id = readVersion("current");
    if (!id || id === runningId || rejected.has(id)) return;
    busy = true;
    try {
      await switchTo(id);
    } catch (error) {
      log(`The update could not be applied: ${error.message}`);
    } finally {
      if (held) handOver(core);
      busy = false;
    }
    await checkForUpdate();
  }

  return {
    route,
    prepareLaunch,
    launch,
    checkForUpdate,
    get runningId() {
      return runningId;
    },
  };
}

// The record of the running host, which the installers read to tell whether
// a running T3 Code will take an update on its own: this host, identified by
// its code as loaded and its process, with a token so that only it removes
// the record.
function createRunningRecord({ filePath, source, log }) {
  const token = crypto.randomBytes(16).toString("hex");
  let written = false;
  return {
    write() {
      // Another launcher from this folder that still runs keeps its record:
      // a second one, opened while T3 Code was open, ends with its own T3
      // Code and would take the record with it.
      try {
        const existing = JSON.parse(fs.readFileSync(filePath, "utf8"));
        if (existing.pid !== process.pid && processRuns(existing.pid)) return;
      } catch {
        // No record, or one that cannot be read, is replaced.
      }
      const record = {
        hostApi: HOST_API,
        hash: crypto.createHash("sha256").update(source).digest("hex"),
        pid: process.pid,
        startedAt: Math.round(Date.now() - process.uptime() * 1000),
        token,
      };
      try {
        writeAtomic(filePath, JSON.stringify(record));
        written = true;
      } catch (error) {
        log(`Could not write ${filePath}: ${error.message}`);
      }
    },
    remove() {
      if (!written) return;
      written = false;
      try {
        if (JSON.parse(fs.readFileSync(filePath, "utf8")).token === token) fs.rmSync(filePath, { force: true });
      } catch {
        // A record that is gone or unreadable is not this host's to remove.
      }
    },
  };
}

function processRuns(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function writeAtomic(filePath, text) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, "utf8");
  fs.renameSync(temporary, filePath);
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
  const ownSource = fs.readFileSync(__filename);

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
    loadCore,
    readVersion,
    writeLastGood: (id) => {
      try {
        writeAtomic(path.join(rootDirectory, "last-good.txt"), id);
      } catch (error) {
        log(`Could not record version ${id} as the last one that started: ${error.message}`);
      }
    },
  });

  // Before T3 Code starts, as the launcher prepared the fix before it was split.
  host.prepareLaunch();

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
  const record = createRunningRecord({ filePath: path.join(rootDirectory, "running-host.json"), source: ownSource, log });

  // Once the pipe closes, nothing more is sent, and every request still
  // waiting fails, so no caller waits for an answer that cannot come. A host
  // without its pipe takes no update, so its record goes too.
  let cdpClosed = false;
  function closeConnection(reason) {
    record.remove();
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

  function readVersion(name) {
    const filePath = path.join(rootDirectory, `${name}.txt`);
    let id;
    try {
      id = readSavedPath(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") log(`Could not read ${filePath}: ${error.message}`);
      return null;
    }
    return VERSION_ID.test(id) ? id : null;
  }

  function loadCore(id) {
    const versionDirectory = path.join(rootDirectory, "versions", id);
    const loaded = require(path.join(versionDirectory, "launcher-core.js"));
    return {
      requiresHostApi: loaded.REQUIRES_HOST_API,
      prepare: () => loaded.prepareCore({ send, log, rootDirectory, versionDirectory }),
    };
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
    await host.launch();
    if (cdpClosed) return;
    poller = setInterval(() => void host.checkForUpdate(), POLL_MS);
    record.write();
  })();
}

if (require.main === module) main();

module.exports = { HOST_API, createHost, createRunningRecord };
