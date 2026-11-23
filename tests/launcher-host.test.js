"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createHost, loadCore } = require("../src/t3-rtl-launcher");
const { prepareCore } = require("../src/launcher-core");

const TARGETS = [
  { targetId: "w1", type: "page", url: "t3code://app/" },
  { targetId: "w2", type: "page", url: "t3code-dev://app/" },
  { targetId: "p1", type: "webview", url: "https://example.com/" },
  { targetId: "x1", type: "page", url: "https://example.com/" },
];

function gate() {
  let open;
  const opened = new Promise((resolve) => (open = resolve));
  return { opened, open };
}

// A launcher with a fake core for each version.txt value, and a fake
// connection.
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
  const host = createHost({ send, log: (message) => logs.push(message), loadCore, readVersion: () => installed.version });
  const reloads = () => calls.filter((call) => call.method === "Page.reload").map((call) => call.sessionId);
  return { host, calls, logs, events, installed, reloads };
}

test("at launch the installed core starts and no window reloads", async () => {
  const { host, events, reloads } = setup();
  await host.launch(host.load());
  assert.deepEqual(events, ["a.load", "a.start"]);
  assert.deepEqual(reloads(), []);
  await host.checkForUpdate();
  assert.deepEqual(events, ["a.load", "a.start"], "nothing to do while version.txt stays");
});

test("a paused script that no core takes passes unchanged", async () => {
  for (const versions of [{ a: { loadFails: true } }, { a: { declines: true } }]) {
    const { host, calls } = setup(versions);
    await host.launch(host.load());
    host.route({ method: "Fetch.requestPaused", params: { requestId: "r1" } });
    assert.deepEqual(calls.at(-1), { method: "Fetch.continueRequest", params: { requestId: "r1" }, sessionId: undefined });
  }
});

test("a new install replaces the running core and reloads only T3 Code's windows", async () => {
  const { host, events, installed, reloads, logs } = setup();
  await host.launch(host.load());
  installed.version = "b";
  await host.checkForUpdate();
  assert.deepEqual(events, ["a.load", "a.start", "b.load", "a.stop", "b.start"]);
  assert.deepEqual(reloads(), ["tmp-w1", "tmp-w2"]);
  assert.match(logs.at(-1), /updated without a restart, 2 windows reloaded/);
  host.route({ method: "Page.frameNavigated", sessionId: "s1" });
  assert.equal(events.at(-1), "b got Page.frameNavigated");
});

test("a new install that cannot load leaves the running core alone and is not tried again", async () => {
  const { host, events, installed, reloads } = setup({ b: { loadFails: true } });
  await host.launch(host.load());
  installed.version = "b";
  await host.checkForUpdate();
  await host.checkForUpdate();
  assert.deepEqual(events, ["a.load", "a.start", "b.load"]);
  assert.deepEqual(reloads(), []);
  host.route({ method: "Page.frameNavigated", sessionId: "s1" });
  assert.equal(events.at(-1), "a got Page.frameNavigated");
  installed.version = "c";
  await host.checkForUpdate();
  assert.deepEqual(events.slice(-3), ["c.load", "a.stop", "c.start"], "the next install is tried");
});

test("a new install that cannot start leaves T3 Code without the fix, and the windows reload", async () => {
  const { host, events, installed, reloads, logs, calls } = setup({ b: { startFails: true } });
  await host.launch(host.load());
  installed.version = "b";
  await host.checkForUpdate();
  assert.deepEqual(events, ["a.load", "a.start", "b.load", "a.stop", "b.start", "b.stop"]);
  assert.deepEqual(reloads(), ["tmp-w1", "tmp-w2"]);
  assert.match(logs.at(-1), /The RTL fix is off/);
  host.route({ method: "Fetch.requestPaused", params: { requestId: "r2" } });
  assert.equal(calls.at(-1).method, "Fetch.continueRequest");
});

test("an install during an update is applied after it", async () => {
  const { host, events, installed } = setup();
  await host.launch(host.load());
  installed.version = "b";
  const first = host.checkForUpdate();
  installed.version = "c";
  await host.checkForUpdate();
  await first;
  await host.checkForUpdate();
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

// The real core, with a fake connection.
function coreConnection({ attachGate } = {}) {
  const calls = [];
  let next = 0;
  const send = async (method, params, sessionId) => {
    calls.push({ method, params, sessionId });
    if (method === "Target.getTargets") return { targetInfos: [TARGETS[0]] };
    if (method === "Target.attachToTarget") {
      if (attachGate) await attachGate.opened;
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

test("the core adds the fix to every window, takes only its own sessions, and detaches them when it stops", async () => {
  const { send, calls } = coreConnection();
  const { core, cleanup } = realCore(send);
  try {
    assert.equal(core.handle({ method: "Target.targetCreated", params: { targetInfo: TARGETS[0] } }), false, "nothing before start");
    await core.start();
    assert.equal(core.ownsSession("s1"), true);
    assert.ok(calls.some((call) => call.method === "Page.addScriptToEvaluateOnNewDocument" && call.sessionId === "s1"));
    assert.ok(calls.some((call) => call.method === "Target.setDiscoverTargets"));
    assert.equal(core.handle({ method: "Page.frameNavigated", sessionId: "someone-else", params: {} }), false);
    assert.equal(core.handle({ method: "Page.frameNavigated", sessionId: "s1", params: { frame: {} } }), true);

    await core.stop();
    assert.deepEqual(calls.at(-1), { method: "Target.detachFromTarget", params: { sessionId: "s1" }, sessionId: undefined });
    assert.equal(core.ownsSession("s1"), false);
    assert.equal(core.handle({ method: "Target.targetCreated", params: { targetInfo: TARGETS[0] } }), false);
  } finally {
    cleanup();
  }
});

test("a stopped core gives up an attach that answers late and starts no reload", async () => {
  const attachGate = gate();
  const { send, calls } = coreConnection({ attachGate });
  const { core, cleanup } = realCore(send);
  try {
    const starting = core.start();
    await new Promise((resolve) => setImmediate(resolve));
    await core.stop();
    attachGate.open();
    await starting;
    assert.deepEqual(calls.at(-1), { method: "Target.detachFromTarget", params: { sessionId: "s1" }, sessionId: undefined });
    assert.equal(core.ownsSession("s1"), false);
    assert.ok(!calls.some((call) => call.method === "Page.enable"));
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

test("a window whose injection fails is detached, so nothing of the fix stays registered in it", async () => {
  const calls = [];
  const send = async (method, params, sessionId) => {
    calls.push({ method, params, sessionId });
    if (method === "Target.getTargets") return { targetInfos: [TARGETS[0]] };
    if (method === "Target.attachToTarget") return { sessionId: "s1" };
    if (method === "Runtime.evaluate" && /t3RtlFix|__t3Rtl|composer/.test(params.expression || "") && params.expression.length > 2000) {
      throw new Error("Runtime.evaluate: failed");
    }
    return {};
  };
  const { core, cleanup } = realCore(send);
  try {
    await core.start();
    assert.equal(core.ownsSession("s1"), false);
    assert.ok(calls.some((call) => call.method === "Target.detachFromTarget" && call.params.sessionId === "s1"));
  } finally {
    cleanup();
  }
});
