"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const FIX_ID = "t3-rtl-fix";
const cssPath = path.join(__dirname, "rtl.css");
const appPathFile = path.join(__dirname, "app-path.txt");
const logPath = path.join(__dirname, "launcher.log");

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

const injectionSource = `(() => {
  const id = ${JSON.stringify(FIX_ID)};
  const css = ${JSON.stringify(css)};
  const apply = () => {
    if (!document.head) return false;
    let style = document.getElementById(id);
    if (!style) {
      style = document.createElement("style");
      style.id = id;
      document.head.appendChild(style);
    }
    if (style.textContent !== css) style.textContent = css;
    return true;
  };
  if (!apply()) {
    document.addEventListener("DOMContentLoaded", apply, { once: true });
  }
})();`;

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

async function attachAndInject(targetInfo) {
  const targetId = targetInfo.targetId;
  if (
    !isT3Page(targetInfo) ||
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
});

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
