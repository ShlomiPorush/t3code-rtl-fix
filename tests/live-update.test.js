"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createCoreRunner, loadCore } = require("../src/t3-rtl-launcher");
const { prepareCore } = require("../src/launcher-core");

const TARGETS = [
  { targetId: "w1", type: "page", url: "t3code://app/" },
  { targetId: "w2", type: "page", url: "t3code-dev://app/" },
  { targetId: "p1", type: "webview", url: "https://example.com/" },
  { targetId: "x1", type: "page", url: "https://example.com/" },
];

function setup(versions = {}) {
  const calls = [];
  const logs = [];
  const events = [];
  const installed = { version: "a" };
  const send = async (method, params, sessionId) => {
    calls.push({ method, params, sessionId });
    if (method === "Target.getTargets") return { targetInfos: TARGETS };
    if (method === "Target.attachToTarget") return { sessionId: `tmp-${params.targetId}` };
    return {};
  };
  const loadCore = () => {
    const id = installed.version;
    const spec = versions[id] || {};
    events.push(`${id}.load`);
    if (spec.loadFails) throw new Error("cannot find module");
    return {
      async start() {
        events.push(`${id}.start`);
        if (spec.startFails) throw new Error("start failed");
      },
      async stop() {
        events.push(`${id}.stop`);
      },
      handle(message) {
        events.push(`${id} got ${message.method}`);
        return !spec.declines;
      },
    };
  };
  const runner = createCoreRunner({ send, log: (message) => logs.push(message), loadCore, readVersion: () => installed.version });
  const reloads = () => calls.filter((call) => call.method === "Page.reload").map((call) => call.sessionId);
  return { runner, calls, logs, events, installed, reloads };
}

test("at launch the installed core starts and no window reloads", async () => {
  const { runner, events, reloads } = setup();
  await runner.launch(runner.load());
  assert.deepEqual(events, ["a.load", "a.start"]);
  assert.deepEqual(reloads(), []);
  await runner.checkForUpdate();
  assert.deepEqual(events, ["a.load", "a.start"], "nothing to do while version.txt stays");
});

test("a paused script that no core takes passes unchanged", async () => {
  for (const versions of [{ a: { loadFails: true } }, { a: { declines: true } }]) {
    const { runner, calls } = setup(versions);
    await runner.launch(runner.load());
    runner.route({ method: "Fetch.requestPaused", params: { requestId: "r1" } });
    assert.deepEqual(calls.at(-1), { method: "Fetch.continueRequest", params: { requestId: "r1" }, sessionId: undefined });
  }
});

test("a new install replaces the running core and reloads only T3 Code's windows", async () => {
  const { runner, events, installed, reloads, logs } = setup();
  await runner.launch(runner.load());
  installed.version = "b";
  await runner.checkForUpdate();
  assert.deepEqual(events, ["a.load", "a.start", "b.load", "a.stop", "b.start"]);
  assert.deepEqual(reloads(), ["tmp-w1", "tmp-w2"]);
  assert.match(logs.at(-1), /updated without a restart, 2 windows reloaded/);
  runner.route({ method: "Page.frameNavigated", sessionId: "s1" });
  assert.equal(events.at(-1), "b got Page.frameNavigated");
});

test("a new install that cannot load leaves the running core alone and is not tried again", async () => {
  const { runner, events, installed, reloads } = setup({ b: { loadFails: true } });
  await runner.launch(runner.load());
  installed.version = "b";
  await runner.checkForUpdate();
  await runner.checkForUpdate();
  assert.deepEqual(events, ["a.load", "a.start", "b.load"]);
  assert.deepEqual(reloads(), []);
  runner.route({ method: "Page.frameNavigated", sessionId: "s1" });
  assert.equal(events.at(-1), "a got Page.frameNavigated");
  installed.version = "c";
  await runner.checkForUpdate();
  assert.deepEqual(events.slice(-3), ["c.load", "a.stop", "c.start"], "the next install is tried");
});

test("a new install that cannot start leaves T3 Code without the fix, and the windows reload", async () => {
  const { runner, events, installed, reloads, logs, calls } = setup({ b: { startFails: true } });
  await runner.launch(runner.load());
  installed.version = "b";
  await runner.checkForUpdate();
  assert.deepEqual(events, ["a.load", "a.start", "b.load", "a.stop", "b.start", "b.stop"]);
  assert.deepEqual(reloads(), ["tmp-w1", "tmp-w2"]);
  assert.match(logs.at(-1), /The RTL fix is off/);
  runner.route({ method: "Fetch.requestPaused", params: { requestId: "r2" } });
  assert.equal(calls.at(-1).method, "Fetch.continueRequest");
});

test("an install during an update is applied after it", async () => {
  const { runner, events, installed } = setup();
  await runner.launch(runner.load());
  installed.version = "b";
  const first = runner.checkForUpdate();
  installed.version = "c";
  await runner.checkForUpdate();
  await first;
  await runner.checkForUpdate();
  assert.deepEqual(events.slice(2), ["b.load", "a.stop", "b.start", "c.load", "b.stop", "c.start"]);
});

test("loading the core again reads the files an install replaced", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-rtl-load-"));
  try {
    fs.writeFileSync(path.join(directory, "launcher-core.js"), 'exports.prepareCore = (options) => ({ value: require("./part").value, options });');
    fs.writeFileSync(path.join(directory, "part.js"), "exports.value = 1;");
    const first = loadCore(directory, { rootDirectory: directory });
    assert.equal(first.value, 1);
    assert.equal(first.options.rootDirectory, directory);
    fs.writeFileSync(path.join(directory, "part.js"), "exports.value = 2;");
    assert.equal(loadCore(directory, {}).value, 2);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function coreConnection() {
  const calls = [];
  let next = 0;
  const send = async (method, params, sessionId) => {
    calls.push({ method, params, sessionId });
    if (method === "Target.getTargets") return { targetInfos: [TARGETS[0]] };
    if (method === "Target.attachToTarget") {
      next += 1;
      return { sessionId: `s${next}` };
    }
    return {};
  };
  return { send, calls };
}

function realCore(send) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-rtl-core-"));
  const core = prepareCore({ send, log: () => {}, rootDirectory: root });
  return { core, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("the core adds the fix to every window and detaches its sessions when it stops", async () => {
  const { send, calls } = coreConnection();
  const { core, cleanup } = realCore(send);
  try {
    await core.start();
    assert.ok(calls.some((call) => call.method === "Target.setDiscoverTargets"));
    assert.ok(calls.some((call) => call.method === "Page.addScriptToEvaluateOnNewDocument" && call.sessionId === "s1"));
    await core.stop();
    assert.deepEqual(calls.at(-1), { method: "Target.detachFromTarget", params: { sessionId: "s1" }, sessionId: undefined });
  } finally {
    cleanup();
  }
});

test("a window whose injection fails is detached and attached again", async () => {
  const { send, calls } = coreConnection();
  const { core, cleanup } = realCore(async (method, params, sessionId) => {
    const result = await send(method, params, sessionId);
    if (method === "Runtime.evaluate" && sessionId === "s1" && params.expression.includes("data-t3-rtl-plan-card")) {
      throw new Error("Inspected target navigated or closed");
    }
    return result;
  });
  const detached = () => calls.filter((call) => call.method === "Target.detachFromTarget").map((call) => call.params.sessionId);
  try {
    await core.start();
    assert.deepEqual(detached(), ["s1"]);
    core.handle({ method: "Target.targetInfoChanged", params: { targetInfo: TARGETS[0] } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(calls.some((call) => call.method === "Page.addScriptToEvaluateOnNewDocument" && call.sessionId === "s2"));
    await core.stop();
    assert.deepEqual(detached(), ["s1", "s2"]);
  } finally {
    cleanup();
  }
});

test("the core reads the shipped stylesheet and the user's custom.css", async () => {
  const { send, calls } = coreConnection();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-rtl-core-"));
  try {
    fs.writeFileSync(path.join(root, "custom.css"), ".my-own-rule { color: teal; }");
    const core = prepareCore({ send, log: () => {}, rootDirectory: root });
    await core.start();
    const injected = calls.filter((call) => call.method === "Page.addScriptToEvaluateOnNewDocument").map((call) => call.params.source).join("\n");
    assert.match(injected, /my-own-rule/);
    assert.match(injected, /data-t3-rtl-plan-card/);
    await core.stop();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
