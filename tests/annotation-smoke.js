"use strict";

// Verifies the browser-preview path of the launcher against a page that builds
// an annotation window the way T3 Code does: a host element with a closed
// shadow root holding the comment textarea.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  ANNOTATION_BINDING,
  applyAnnotationDirection,
  watchAnnotations,
} = require("../src/annotation-direction");

const edgePath = path.join(
  process.env["ProgramFiles(x86)"] || "",
  "Microsoft",
  "Edge",
  "Application",
  "msedge.exe",
);
if (process.platform !== "win32" || !fs.existsSync(edgePath)) {
  process.stdout.write("Annotation smoke test skipped: Microsoft Edge is unavailable\n");
  process.exit(0);
}

const rtlText = "הודעה בעברית";
const testProfile = fs.mkdtempSync(path.join(os.tmpdir(), "t3-rtl-annotation-test-"));
const child = spawn(edgePath, [
  "--headless=new",
  "--no-first-run",
  `--user-data-dir=${testProfile}`,
  "--remote-debugging-pipe",
  "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

const input = child.stdio[3];
const output = child.stdio[4];
const pending = new Map();
const bindingCalls = [];
let nextId = 1;
let incoming = Buffer.alloc(0);

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  input.write(`${JSON.stringify(message)}\0`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

output.on("data", (chunk) => {
  incoming = Buffer.concat([incoming, chunk]);
  while (true) {
    const separator = incoming.indexOf(0);
    if (separator === -1) break;
    const raw = incoming.subarray(0, separator).toString("utf8");
    incoming = incoming.subarray(separator + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    if (message.method === "Runtime.bindingCalled" && message.params?.name === ANNOTATION_BINDING) {
      bindingCalls.push(applyAnnotationDirection(send, message.sessionId));
      continue;
    }
    if (!message.id || !pending.has(message.id)) continue;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result || {});
  }
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((target) => target.type === "page");
  if (!page) throw new Error("No page target was created");
  const { sessionId } = await send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  // Headless pages have no window focus, so focus events would not fire.
  await send("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
  await send("Runtime.evaluate", {
    expression: `document.body.innerHTML = '<textarea id="site-field"></textarea>'; 1`,
  }, sessionId);

  const updatedWithoutWindow = await applyAnnotationDirection(send, sessionId);
  await watchAnnotations(send, sessionId);
  // A second watch, as after a reload, must not double the listener.
  await send("Runtime.evaluate", {
    expression: require("../src/annotation-direction").buildAnnotationWatcherSource(),
  }, sessionId);

  // T3 Code creates the window on demand, after the page has loaded.
  await send("Runtime.evaluate", {
    expression: `(() => {
      const host = document.createElement("div");
      host.setAttribute("data-t3code-annotation-ui", "");
      document.documentElement.appendChild(host);
      const root = host.attachShadow({ mode: "closed" });
      const comment = document.createElement("textarea");
      comment.placeholder = "Describe the change...";
      root.appendChild(comment);
      window.__testComment = comment;
      comment.focus();
      return 1;
    })()`,
  }, sessionId);
  await wait(300);
  const callsAfterFirstFocus = bindingCalls.length;
  const updatedCounts = await Promise.all(bindingCalls);

  const result = await send("Runtime.evaluate", {
    expression: `(() => {
      const comment = window.__testComment;
      const english = { dir: comment.dir, direction: (comment.value = "Make it smaller", getComputedStyle(comment).direction) };
      comment.value = ${JSON.stringify(rtlText)};
      return JSON.stringify({
        commentDir: comment.dir,
        hebrewDirection: getComputedStyle(comment).direction,
        englishDirection: english.direction,
        siteFieldDir: document.getElementById("site-field").getAttribute("dir"),
        pageCannotReachRoot: document.querySelector("[data-t3code-annotation-ui]").shadowRoot === null,
      });
    })()`,
    returnByValue: true,
  }, sessionId);
  const actual = {
    updatedWithoutWindow,
    callsAfterFirstFocus,
    updatedCounts,
    ...JSON.parse(result.result.value),
  };
  const expected = {
    updatedWithoutWindow: 0,
    callsAfterFirstFocus: 1,
    updatedCounts: [1],
    commentDir: "auto",
    hebrewDirection: "rtl",
    englishDirection: "ltr",
    siteFieldDir: null,
    pageCannotReachRoot: true,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected annotation result: ${JSON.stringify(actual)}`);
  }
  process.stdout.write("Annotation comment direction passed\n");
}

const timeout = setTimeout(() => {
  process.stderr.write("Annotation smoke test timed out\n");
  child.kill();
  process.exitCode = 1;
}, 20000);

run().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(timeout);
  child.kill();
});

child.on("exit", () => {
  const resolved = path.resolve(testProfile);
  const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (resolved.startsWith(tempRoot) && path.basename(resolved).startsWith("t3-rtl-annotation-test-")) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      // A browser that is still releasing its profile must not fail the test.
    }
  }
});
