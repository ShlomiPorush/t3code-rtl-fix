"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { HOST_API, createHost, createRunningRecord } = require("../src/t3-rtl-launcher");
const { REQUIRES_HOST_API, prepareCore } = require("../src/launcher-core");

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

// A core that records what the host asks of it.
function fakeCore(id, events, spec) {
  const sessions = new Set(spec.sessions || []);
  return {
    async start() {
      events.push(`${id}.start`);
      if (spec.startGate) await spec.startGate.opened;
      if (spec.startFails) throw new Error("start failed");
      if (spec.startHangs) await new Promise(() => {});
    },
    async stop() {
      events.push(`${id}.stop`);
      if (spec.stopGate) await spec.stopGate.opened;
      sessions.clear();
    },
    async settled() {},
    handle(message) {
      events.push(`${id} got ${message.method}${message.sessionId ? ` ${message.sessionId}` : ""}`);
      return spec.handles ? spec.handles(message) : true;
    },
    ownsSession: (sessionId) => sessions.has(sessionId),
    sessionIds: () => [...sessions],
  };
}

function setup({ versions = {}, current = "b", lastGood = "a" } = {}) {
  const calls = [];
  const logs = [];
  const events = [];
  const pointer = { current, "last-good": lastGood };
  const send = async (method, params, sessionId) => {
    calls.push({ method, params, sessionId });
    if (method === "Target.getTargets") return { targetInfos: TARGETS };
    if (method === "Target.attachToTarget") return { sessionId: `tmp-${params.targetId}` };
    return {};
  };
  const loadCore = (id) => {
    const spec = versions[id] || {};
    if (spec.loadFails) throw new Error("cannot find module");
    return {
      requiresHostApi: spec.api ?? HOST_API,
      prepare: () => {
        if (spec.prepareFails) throw new Error("prepare failed");
        events.push(`${id}.prepare`);
        return fakeCore(id, events, spec);
      },
    };
  };
  const host = createHost({
    send,
    log: (message) => logs.push(message),
    loadCore,
    readVersion: (name) => pointer[name] ?? null,
    writeLastGood: (id) => (pointer["last-good"] = id),
    stepTimeout: 100,
  });
  const reloads = () => calls.filter((call) => call.method === "Page.reload");
  return { host, calls, logs, events, pointer, reloads };
}

test("the host offers the API the core needs", () => {
  assert.equal(REQUIRES_HOST_API, HOST_API);
});

test("at launch the installed version starts, is recorded, and nothing reloads", async () => {
  const { host, events, pointer, reloads } = setup();
  assert.equal(await host.launch(), true);
  assert.deepEqual(events, ["b.prepare", "b.start"]);
  assert.equal(host.runningId, "b");
  assert.equal(pointer["last-good"], "b");
  assert.equal(reloads().length, 0);
});

test("at launch a version that cannot load or needs another host gives way to the last one that started", async () => {
  for (const spec of [{ loadFails: true }, { prepareFails: true }, { api: HOST_API + 1 }]) {
    const { host, events, logs, reloads } = setup({ versions: { b: spec } });
    assert.equal(await host.launch(), true);
    assert.equal(host.runningId, "a");
    assert.ok(!events.includes("b.start"));
    assert.equal(reloads().length, 0, "a version that never started touched no window");
    assert.match(logs.join("\n"), /Version b of the fix could not be loaded/);
  }
});

test("at launch a version that fails to start is stopped, and the windows reload under the one that starts", async () => {
  const { host, events, reloads, calls } = setup({ versions: { b: { startFails: true } } });
  assert.equal(await host.launch(), true);
  assert.deepEqual(events, ["b.prepare", "b.start", "b.stop", "a.prepare", "a.start"]);
  assert.equal(host.runningId, "a");
  // Every T3 Code window, regular and development, and nothing else.
  assert.deepEqual(reloads().map((call) => call.sessionId), ["tmp-w1", "tmp-w2"]);
  assert.deepEqual(reloads()[0].params, { ignoreCache: true });
  const detached = calls.filter((call) => call.method === "Target.detachFromTarget").map((call) => call.params.sessionId);
  assert.deepEqual(detached, ["tmp-w1", "tmp-w2"]);
});

test("with no version that starts, T3 Code runs without the fix and its script passes unchanged", async () => {
  const { host, logs, calls } = setup({ versions: { a: { startFails: true }, b: { startFails: true } } });
  assert.equal(await host.launch(), false);
  assert.equal(host.runningId, null);
  assert.match(logs.join("\n"), /The RTL fix is off/);
  host.route({ method: "Fetch.requestPaused", params: { requestId: "r1" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1), { method: "Fetch.continueRequest", params: { requestId: "r1" }, sessionId: undefined });
});

test("a paused script that the running core does not take passes unchanged", async () => {
  const { host, calls } = setup({ versions: { b: { handles: () => false } } });
  await host.launch();
  host.route({ method: "Fetch.requestPaused", params: { requestId: "r2" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls.at(-1).method, "Fetch.continueRequest");
});

test("a new version replaces the running one, the windows reload, and it is recorded", async () => {
  const { host, events, pointer, reloads, logs } = setup({ versions: { b: { sessions: ["s-old"] } } });
  await host.launch();
  pointer.current = "c";
  await host.checkForUpdate();
  assert.deepEqual(events.slice(2), ["c.prepare", "b.stop", "c.start"]);
  assert.equal(host.runningId, "c");
  assert.equal(pointer["last-good"], "c");
  assert.equal(reloads().length, 2);
  assert.match(logs.at(-1), /Fix updated to version c without a restart, 2 windows reloaded/);
  // Nothing more to do while current.txt stays.
  await host.checkForUpdate();
  assert.equal(events.filter((event) => event === "c.prepare").length, 1);
});

test("a new version that cannot load leaves the running one alone and is not tried again", async () => {
  for (const spec of [{ loadFails: true }, { prepareFails: true }, { api: HOST_API + 1 }]) {
    const { host, events, pointer, reloads, logs } = setup({ versions: { c: spec } });
    await host.launch();
    pointer.current = "c";
    await host.checkForUpdate();
    await host.checkForUpdate();
    assert.equal(host.runningId, "b");
    assert.ok(!events.includes("b.stop"));
    assert.equal(reloads().length, 0);
    assert.equal(logs.filter((line) => /was not applied/.test(line)).length, 1);
    if (spec.api) assert.match(logs.join("\n"), /Quit T3 Code fully and open it again/);
  }
});

test("a new version that fails to start gives way to the running one, and the windows reload", async () => {
  for (const spec of [{ startFails: true }, { startHangs: true }]) {
    const { host, events, pointer, reloads, logs } = setup({ versions: { c: spec } });
    await host.launch();
    pointer.current = "c";
    await host.checkForUpdate();
    assert.deepEqual(events.slice(2), ["c.prepare", "b.stop", "c.start", "c.stop", "b.start"]);
    assert.equal(host.runningId, "b");
    assert.equal(pointer["last-good"], "b");
    assert.equal(reloads().length, 2);
    assert.match(logs.join("\n"), /The previous version is back/);
    await host.checkForUpdate();
    assert.equal(events.filter((event) => event === "c.prepare").length, 1, "a failed version is not tried again");
  }
});

test("during a switch, messages reach exactly one owner", async () => {
  const startGate = gate();
  const { host, events, pointer, calls } = setup({ versions: { b: { sessions: ["s-old"] }, c: { startGate, sessions: ["s-new"] } } });
  await host.launch();
  pointer.current = "c";
  const switching = host.checkForUpdate();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.slice(2), ["c.prepare", "b.stop", "c.start"]);

  // While the new core starts: a paused script goes to it, its own session's
  // events go to it, a window event waits for it, and the old core's events
  // are dropped.
  host.route({ method: "Fetch.requestPaused", params: { requestId: "r3" } });
  host.route({ method: "Page.frameNavigated", sessionId: "s-new" });
  host.route({ method: "Target.targetCreated", params: { targetInfo: TARGETS[0] } });
  host.route({ method: "Page.frameNavigated", sessionId: "s-old" });
  assert.deepEqual(events.slice(5), ["c got Fetch.requestPaused", "c got Page.frameNavigated s-new"]);

  startGate.open();
  await switching;
  assert.deepEqual(events.slice(7), ["c got Target.targetCreated"]);
  assert.ok(!events.some((event) => event.startsWith("b got")));
  assert.ok(!calls.some((call) => call.method === "Fetch.continueRequest"));
});

test("a paused script that arrives before the new core starts passes unchanged", async () => {
  const stopGate = gate();
  const { host, pointer, calls, events } = setup({ versions: { b: { stopGate } } });
  await host.launch();
  pointer.current = "c";
  const switching = host.checkForUpdate();
  await new Promise((resolve) => setImmediate(resolve));
  // The old core is still stopping, so no core takes the request.
  host.route({ method: "Fetch.requestPaused", params: { requestId: "early" } });
  await new Promise((resolve) => setImmediate(resolve));
  const continued = calls.filter((call) => call.method === "Fetch.continueRequest").map((call) => call.params.requestId);
  assert.deepEqual(continued, ["early"]);
  stopGate.open();
  await switching;
  assert.ok(!events.some((event) => event.includes("got Fetch.requestPaused")));
});

test("a version installed during a switch is applied after it", async () => {
  const startGate = gate();
  const { host, events, pointer } = setup({ versions: { c: { startGate } } });
  await host.launch();
  pointer.current = "c";
  const switching = host.checkForUpdate();
  await new Promise((resolve) => setImmediate(resolve));
  pointer.current = "d";
  // A check while a switch runs does nothing.
  await host.checkForUpdate();
  startGate.open();
  await switching;
  assert.equal(host.runningId, "d");
  assert.deepEqual(events.filter((event) => event.endsWith(".prepare")), ["b.prepare", "c.prepare", "d.prepare"]);
});

test("the running record names this host and is removed only by it", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-rtl-host-"));
  try {
    const filePath = path.join(directory, "running-host.json");
    const logs = [];
    const record = createRunningRecord({ filePath, source: Buffer.from("host source"), log: (m) => logs.push(m) });
    record.write();
    const written = JSON.parse(fs.readFileSync(filePath, "utf8"));
    assert.equal(written.hostApi, HOST_API);
    assert.equal(written.pid, process.pid);
    assert.equal(written.hash, require("node:crypto").createHash("sha256").update("host source").digest("hex"));
    assert.ok(Math.abs(written.startedAt - (Date.now() - process.uptime() * 1000)) < 2000);
    record.remove();
    assert.equal(fs.existsSync(filePath), false);

    // A record another host wrote since stays.
    record.write();
    fs.writeFileSync(filePath, JSON.stringify({ ...written, token: "another host" }));
    record.remove();
    assert.equal(fs.existsSync(filePath), true);
    assert.deepEqual(logs, []);
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
  const core = prepareCore({ send, log: () => {}, rootDirectory: root, versionDirectory: path.join(__dirname, "..", "src") });
  return { core, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("the core adds the fix to every window, takes only its own sessions, and detaches them when it stops", async () => {
  const { send, calls } = coreConnection();
  const { core, cleanup } = realCore(send);
  try {
    assert.equal(core.handle({ method: "Target.targetCreated", params: { targetInfo: TARGETS[0] } }), false, "nothing before start");
    await core.start();
    await core.settled();
    assert.deepEqual(core.sessionIds(), ["s1"]);
    assert.ok(calls.some((call) => call.method === "Page.addScriptToEvaluateOnNewDocument" && call.sessionId === "s1"));
    assert.ok(calls.some((call) => call.method === "Target.setDiscoverTargets"));
    assert.equal(core.handle({ method: "Page.frameNavigated", sessionId: "someone-else", params: {} }), false);
    assert.equal(core.handle({ method: "Page.frameNavigated", sessionId: "s1", params: { frame: {} } }), true);

    await core.stop();
    assert.deepEqual(calls.at(-1), { method: "Target.detachFromTarget", params: { sessionId: "s1" }, sessionId: undefined });
    assert.deepEqual(core.sessionIds(), []);
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
    assert.deepEqual(core.sessionIds(), []);
    assert.ok(!calls.some((call) => call.method === "Page.enable"));
  } finally {
    cleanup();
  }
});

test("the core reads the shipped stylesheet of its version and the user's custom.css", async () => {
  const { send, calls } = coreConnection();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-rtl-core-"));
  try {
    fs.writeFileSync(path.join(root, "custom.css"), ".my-own-rule { color: teal; }");
    const core = prepareCore({ send, log: () => {}, rootDirectory: root, versionDirectory: path.join(__dirname, "..", "src") });
    await core.start();
    await core.settled();
    const injected = calls.filter((call) => call.method === "Page.addScriptToEvaluateOnNewDocument").map((call) => call.params.source).join("\n");
    assert.match(injected, /my-own-rule/);
    assert.match(injected, /data-t3-rtl-plan-card/);
    await core.stop();
    assert.throws(() => prepareCore({ send, log: () => {}, rootDirectory: root, versionDirectory: root }), /rtl\.css/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
