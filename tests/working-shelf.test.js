"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { URL_PATTERN, patchSidebarChunk, createWorkingShelfService } = require("../src/working-shelf");

// A small stand-in for T3 Code's sidebar code, with every site the patch
// changes written the way T3 Code 0.0.3 minifies it, and runnable, so a
// patch that breaks a name fails here and not only in the app.
const FIXTURE = [
  "let SETTINGS={sidebarWorkingShelfEnabled:true};",
  "function setWorking(v){SETTINGS={sidebarWorkingShelfEnabled:v}}",
  "function DK(e){return e.sidebarWorkingShelfEnabled}",
  "function dp(e){return e(SETTINGS)}",
  "function wK(e){return e.threads}",
  "function gK(e){let t=0,{threads:s,routeRowThreadKey:l,folderGroups:u,keepEmptyFolders:d}=e,f=dp(DK)&&u===null,p=1;",
  "let k=e.pinned,A=e.active,H=e.working,ee=e.snoozed,V=e.settled,U=u===null?null:u.map(g=>({group:g,threads:g.threads})),",
  "W=[...k,...U===null?A:U.flatMap(wK),...H,...ee,...V],te=0;return{workingShelfEnabled:f,orderedThreadKeys:W}}",
  "function rowsOf(Un,r){let Ki;{let p={kind:`marker`,marker:`settled-placeholder`};Ki=[...r,p]}let qi=Ki,Ji;Ji=qi.map(e=>e.kind===`thread`?e.key:e.marker);return{qi,Ji}}",
  "function render(Un,ea){const n=[];for(let i of ea)if(i.kind===`thread`){if(Un!==null&&i.section===`active`)continue;n.push(i.key)}return n}",
  "function headers(Un,Dn,On,Y){return[{marker:`working-header`,className:`mt-auto`},{marker:`snoozed-header`,className:Y(Dn.length===0&&`mt-auto`)},{marker:`settled-header`,className:Y(Dn.length+On.length===0&&`mt-auto`)}]}",
].join("\n");

function load(source) {
  return new Function(`${source}\nreturn { setWorking, gK, rowsOf, render, headers };`)();
}

const Y = (value) => value || undefined;
const rows = [
  { kind: "marker", marker: "pinned-header" },
  { kind: "thread", key: "p1", section: "pinned" },
  { kind: "marker", marker: "pinned-divider" },
  { kind: "marker", marker: "active-placeholder" },
  { kind: "thread", key: "a1", section: "active" },
  { kind: "marker", marker: "working-header" },
  { kind: "thread", key: "w1", section: "working" },
  { kind: "thread", key: "w2", section: "working" },
  { kind: "marker", marker: "settled-header" },
];
const hookInput = (folderGroups) => ({
  threads: [],
  folderGroups,
  pinned: ["p1"],
  active: ["a1"],
  working: ["w1", "w2"],
  snoozed: ["s1"],
  settled: ["d1"],
});

test("the patch shows the Working section with project folders and keeps T3 Code's own setting", () => {
  const result = patchSidebarChunk(FIXTURE);
  assert.equal(result.applied, true, result.problem);
  const original = load(FIXTURE);
  const patched = load(result.source);
  const folders = [{ threads: ["a1"] }];

  assert.equal(original.gK(hookInput(folders)).workingShelfEnabled, false);
  assert.equal(patched.gK(hookInput(folders)).workingShelfEnabled, true);
  assert.equal(patched.gK(hookInput(null)).workingShelfEnabled, true);
  patched.setWorking(false);
  assert.equal(patched.gK(hookInput(folders)).workingShelfEnabled, false, "T3 Code's own setting still turns it off");
  assert.equal(patched.gK(hookInput(null)).workingShelfEnabled, false);
});

test("with project folders, Working comes first in the keyboard order; without, the order is T3 Code's", () => {
  const { source } = patchSidebarChunk(FIXTURE);
  const original = load(FIXTURE);
  const patched = load(source);
  const folders = [{ threads: ["a1"] }];
  assert.deepEqual(patched.gK(hookInput(folders)).orderedThreadKeys, ["w1", "w2", "p1", "a1", "s1", "d1"]);
  assert.deepEqual(patched.gK(hookInput(null)).orderedThreadKeys, original.gK(hookInput(null)).orderedThreadKeys);
  assert.deepEqual(patched.gK(hookInput(null)).orderedThreadKeys, ["p1", "a1", "w1", "w2", "s1", "d1"]);
});

test("with project folders, the Working header and rows move above Pinned; without, nothing moves", () => {
  const { source } = patchSidebarChunk(FIXTURE);
  const original = load(FIXTURE);
  const patched = load(source);
  assert.deepEqual(patched.rowsOf([], rows).Ji, [
    "working-header", "w1", "w2", "pinned-header", "p1", "pinned-divider", "active-placeholder", "a1", "settled-header", "settled-placeholder",
  ]);
  assert.deepEqual(patched.rowsOf(null, rows).Ji, original.rowsOf(null, rows).Ji);
  const noWorking = rows.filter((row) => row.section !== "working" && row.marker !== "working-header");
  assert.deepEqual(patched.rowsOf([], noWorking).Ji, original.rowsOf([], noWorking).Ji);
  // The rows rendered in folders skip active threads as before.
  assert.deepEqual(patched.render([], patched.rowsOf([], rows).qi), ["w1", "w2", "p1"]);
});

test("with project folders, the first shelf at the bottom is Snoozed or Settled", () => {
  const { source } = patchSidebarChunk(FIXTURE);
  const original = load(FIXTURE);
  const patched = load(source);
  const classes = (fn, folders, working, snoozed) => fn(folders, working, snoozed, Y).map((header) => header.className);
  // Folders: Working sits at the top, so it no longer pushes the shelves down.
  assert.deepEqual(classes(patched.headers, [], [1], [1]), [undefined, "mt-auto", undefined]);
  assert.deepEqual(classes(patched.headers, [], [1], []), [undefined, "mt-auto", "mt-auto"]);
  // No folders: exactly as T3 Code has it.
  for (const [working, snoozed] of [[[1], [1]], [[], [1]], [[], []], [[1], []]]) {
    assert.deepEqual(classes(patched.headers, null, working, snoozed), classes(original.headers, null, working, snoozed));
  }
});

test("the patch changes nothing unless every site matches exactly once", () => {
  // Each site: the text in the fixture, a change that breaks it, and a second
  // copy that matches it again.
  const sites = [
    ["return e.sidebarWorkingShelfEnabled}", "return e.sidebarWorkingShelfOn}", "function DK2(e){return e.sidebarWorkingShelfEnabled}"],
    ["f=dp(DK)&&u===null,", "f=dp(DK)&&u==null,", "function g2(e){let{folderGroups:u}=e,f=dp(DK)&&u===null,p=1}"],
    ["U=u===null?null:", "U=u==null?null:", "U=u===null?null:0;"],
    ["W=[...k,...U===null?A:U.flatMap(wK),...H,", "W=[...k,...U==null?A:U.flatMap(wK),...H,", "W=[...k,...U===null?A:U.flatMap(wK),...H,0];"],
    ["if(Un!==null&&i.section===`active`)continue", "if(Un!=null&&i.section===`active`)continue", "if(Un!==null&&i.section===`active`)continue;"],
    ["}let qi=Ki,Ji;", "}var qi=Ki,Ji;", "{let x={kind:`marker`,marker:`settled-placeholder`}}let a=b,c;"],
    ["marker:`working-header`,className:`mt-auto`", "marker:`working-header`,className:`mt-4`", "[{marker:`working-header`,className:`mt-auto`}];"],
    ["Y(Dn.length===0&&`mt-auto`)", "Y(Dn.length<1&&`mt-auto`)", "[{marker:`snoozed-header`,className:Y(Dn.length===0&&`mt-auto`)}];"],
    ["Y(Dn.length+On.length===0&&`mt-auto`)", "Y(Dn.length+On.length<1&&`mt-auto`)", "[{marker:`settled-header`,className:Y(Dn.length+On.length===0&&`mt-auto`)}];"],
  ];
  for (const [site, broken, copy] of sites) {
    assert.equal(FIXTURE.split(site).length, 2, `the fixture has ${site} once`);
    const missing = FIXTURE.replace(site, broken);
    const result = patchSidebarChunk(missing);
    assert.equal(result.applied, false, `missing ${site}`);
    assert.equal(result.source, missing, `missing ${site} leaves the code byte for byte`);
    const doubled = `${FIXTURE}\n${copy}`;
    const twice = patchSidebarChunk(doubled);
    assert.equal(twice.applied, false, `doubled ${site}`);
    assert.equal(twice.source, doubled, `doubled ${site} leaves the code byte for byte`);
  }
  // The gate must test the folder groups, not another value.
  const otherGate = FIXTURE.replace("f=dp(DK)&&u===null,", "f=dp(DK)&&d===null,");
  assert.equal(patchSidebarChunk(otherGate).applied, false);
  assert.equal(patchSidebarChunk(otherGate).source, otherGate);
});

test("patched code is not patched again, and other scripts are left alone", () => {
  const once = patchSidebarChunk(FIXTURE);
  const twice = patchSidebarChunk(once.source);
  assert.equal(twice.applied, false);
  assert.equal(twice.source, once.source);
  assert.equal(patchSidebarChunk("console.log(1)").source, "console.log(1)");
  assert.equal(patchSidebarChunk(undefined).applied, false);
});

// The real code of the T3 Code installed on this machine, when there is one.
function installedServerAsar() {
  const candidates = process.platform === "win32"
    ? [path.join(process.env.LOCALAPPDATA || "", "Programs", "t3code", "resources", "server.asar")]
    : process.platform === "darwin"
      ? ["/Applications/T3 Code (Beta).app/Contents/Resources/server.asar", "/Applications/T3 Code.app/Contents/Resources/server.asar"]
      : [];
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function readInstalledMainChunks(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const sizes = Buffer.alloc(16);
    fs.readSync(fd, sizes, 0, 16, 0);
    const headerSize = sizes.readUInt32LE(12);
    const header = Buffer.alloc(headerSize);
    fs.readSync(fd, header, 0, headerSize, 16);
    const base = 8 + sizes.readUInt32LE(4);
    let node = JSON.parse(header.toString("utf8"));
    for (const part of ["apps", "server", "dist", "client", "assets"]) node = node?.files?.[part];
    const chunks = [];
    for (const [name, entry] of Object.entries(node?.files || {})) {
      if (!/^main-.*\.js$/.test(name) || entry.unpacked || entry.files) continue;
      const buffer = Buffer.alloc(entry.size);
      fs.readSync(fd, buffer, 0, entry.size, base + Number(entry.offset));
      chunks.push({ name, source: buffer.toString("utf8") });
    }
    return chunks;
  } finally {
    fs.closeSync(fd);
  }
}

test("the installed T3 Code's sidebar code is recognized and stays valid", (t) => {
  const asarPath = installedServerAsar();
  if (!asarPath) return t.skip("T3 Code is not installed here");
  const chunk = readInstalledMainChunks(asarPath).find((item) => item.source.includes("sidebarWorkingShelfEnabled}"));
  assert.ok(chunk, "the installed T3 Code has a main script with the sidebar");
  const result = patchSidebarChunk(chunk.source);
  assert.equal(result.applied, true, `${chunk.name}: ${result.problem}`);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-working-shelf-"));
  try {
    const file = path.join(directory, "main.mjs");
    fs.writeFileSync(file, result.source);
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// A stand-in for the browser's DevTools connection.
function fakeConnection({ body = FIXTURE, failBody = false, failEnable = false } = {}) {
  const calls = [];
  let release = null;
  const gate = { hold: false };
  const send = async (method, params) => {
    calls.push({ method, params });
    if (method === "Fetch.enable" && failEnable) throw new Error("Fetch.enable: not allowed");
    if (method === "Fetch.getResponseBody") {
      if (gate.hold) await new Promise((resolve) => (release = resolve));
      if (failBody) throw new Error("Fetch.getResponseBody: gone");
      return { body: Buffer.from(body, "utf8").toString("base64"), base64Encoded: true };
    }
    return {};
  };
  return { send, calls, gate, release: () => release?.() };
}

const paused = (overrides = {}) => ({
  requestId: "r1",
  responseStatusCode: 200,
  responseHeaders: [
    { name: "content-type", value: "text/javascript" },
    { name: "Content-Length", value: "10" },
    { name: "content-encoding", value: "gzip" },
  ],
  ...overrides,
});

test("the browser watches only T3 Code's main script, and a refusal is only logged", async () => {
  const ok = fakeConnection();
  assert.equal(await createWorkingShelfService({ send: ok.send, isEnabled: () => true }).enable(), true);
  assert.deepEqual(ok.calls[0], {
    method: "Fetch.enable",
    params: { patterns: [{ urlPattern: URL_PATTERN, resourceType: "Script", requestStage: "Response" }] },
  });
  const refused = fakeConnection({ failEnable: true });
  const logs = [];
  const service = createWorkingShelfService({ send: refused.send, isEnabled: () => true, log: (m) => logs.push(m) });
  assert.equal(await service.enable(), false);
  assert.match(logs.join("\n"), /could not watch/);
});

test("a recognized script is answered with the patched code and without its length", async () => {
  const connection = fakeConnection();
  await createWorkingShelfService({ send: connection.send, isEnabled: () => true }).handlePaused(paused());
  const methods = connection.calls.map((call) => call.method);
  assert.deepEqual(methods, ["Fetch.getResponseBody", "Fetch.fulfillRequest"]);
  const fulfill = connection.calls[1].params;
  assert.equal(fulfill.requestId, "r1");
  assert.equal(fulfill.responseCode, 200);
  assert.deepEqual(fulfill.responseHeaders, [{ name: "content-type", value: "text/javascript" }]);
  assert.equal(Buffer.from(fulfill.body, "base64").toString("utf8"), patchSidebarChunk(FIXTURE).source);
});

test("the script passes unchanged when the switch is off, the answer is not 200, or the code is unknown", async () => {
  const cases = [
    { name: "off", enabled: false, params: paused(), reads: false },
    { name: "304", enabled: true, params: paused({ responseStatusCode: 304 }), reads: false },
    { name: "error", enabled: true, params: paused({ responseStatusCode: undefined, responseErrorReason: "Failed" }), reads: false },
    { name: "unknown", enabled: true, params: paused(), reads: true, body: "export const sidebarWorkingShelfEnabled = 1;" },
    { name: "unreadable", enabled: true, params: paused(), reads: true, failBody: true },
  ];
  for (const item of cases) {
    const connection = fakeConnection({ body: item.body, failBody: item.failBody });
    const logs = [];
    await createWorkingShelfService({ send: connection.send, isEnabled: () => item.enabled, log: (m) => logs.push(m) }).handlePaused(item.params);
    const methods = connection.calls.map((call) => call.method);
    assert.deepEqual(methods, item.reads ? ["Fetch.getResponseBody", "Fetch.continueRequest"] : ["Fetch.continueRequest"], item.name);
    assert.deepEqual(connection.calls.at(-1).params, { requestId: "r1" }, item.name);
    if (item.name === "unknown") assert.match(logs.join("\n"), /not recognized/);
  }
});

test("turning the switch off while the script is read passes it unchanged", async () => {
  const connection = fakeConnection();
  connection.gate.hold = true;
  let enabled = true;
  const handled = createWorkingShelfService({ send: connection.send, isEnabled: () => enabled }).handlePaused(paused());
  await new Promise((resolve) => setImmediate(resolve));
  enabled = false;
  connection.release();
  await handled;
  assert.deepEqual(connection.calls.map((call) => call.method), ["Fetch.getResponseBody", "Fetch.continueRequest"]);
});

test("two windows loading at once each get one answer", async () => {
  const connection = fakeConnection();
  const service = createWorkingShelfService({ send: connection.send, isEnabled: () => true });
  await Promise.all([service.handlePaused(paused({ requestId: "a" })), service.handlePaused(paused({ requestId: "b" }))]);
  const answers = connection.calls.filter((call) => call.method !== "Fetch.getResponseBody").map((call) => call.params.requestId).sort();
  assert.deepEqual(answers, ["a", "b"]);
});

test("the launcher watches before the first window and keeps the RTL fix when watching fails", () => {
  const launcher = fs.readFileSync(path.join(__dirname, "..", "src", "t3-rtl-launcher.js"), "utf8");
  const start = launcher.indexOf("async function initialize()");
  assert.ok(start > 0);
  const body = launcher.slice(start, launcher.indexOf("void initialize();", start));
  assert.ok(body.indexOf("await watchWorkingShelf()") < body.indexOf("Target.setDiscoverTargets"), "watching starts before targets are found");
  assert.ok(body.indexOf("await watchWorkingShelf()") < body.indexOf("try {"), "a failure there cannot skip injection");
  assert.match(launcher, /message\.method === "Fetch\.requestPaused" && !message\.sessionId/);
  assert.doesNotMatch(launcher, /Fetch\.disable/);
  assert.match(launcher, /if \(cdpClosed\) return Promise\.reject/);
});
