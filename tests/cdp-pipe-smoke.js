"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const edgePath = path.join(
  process.env["ProgramFiles(x86)"] || "",
  "Microsoft",
  "Edge",
  "Application",
  "msedge.exe",
);

if (process.platform !== "win32" || !fs.existsSync(edgePath)) {
  process.stdout.write("CDP pipe smoke test skipped: Microsoft Edge is unavailable\n");
  process.exit(0);
}

const testProfile = fs.mkdtempSync(path.join(os.tmpdir(), "t3-rtl-pipe-test-"));
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
    if (!message.id || !pending.has(message.id)) continue;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result || {});
  }
});

async function run() {
  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((target) => target.type === "page");
  if (!page) throw new Error("No page target was created");
  const { sessionId } = await send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  await send("Runtime.evaluate", {
    expression: 'document.head.insertAdjacentHTML("beforeend", "<style id=\\"t3-rtl-fix\\">body{direction:rtl}</style>")',
  }, sessionId);
  const result = await send("Runtime.evaluate", {
    expression: 'document.getElementById("t3-rtl-fix")?.textContent === "body{direction:rtl}"',
    returnByValue: true,
  }, sessionId);
  if (result.result?.value !== true) throw new Error("The style was not injected");
  process.stdout.write("CDP pipe injection passed\n");
}

const timeout = setTimeout(() => {
  process.stderr.write("CDP pipe injection timed out\n");
  child.kill();
  process.exitCode = 1;
}, 15000);

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
  if (resolved.startsWith(tempRoot) && path.basename(resolved).startsWith("t3-rtl-pipe-test-")) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});
