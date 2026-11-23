"use strict";

// Verifies Extras end to end in headless Edge over a debugging pipe, as the
// launcher runs it: the isolated world, the binding, the dispatch, the
// settings store on disk, the usage chips in a sidebar footer shaped like
// T3 Code's, and the Extras section on a Labs page shaped like T3 Code's.
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createDispatch } = require("../src/cdp-dispatch");
const { createSettingsStore } = require("../src/extras-settings");
const { EXTRAS_BINDING, createExtrasService } = require("../src/extras");

const edgePath = path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe");
if (process.platform !== "win32" || !fs.existsSync(edgePath)) {
  process.stdout.write("Extras smoke test skipped: Microsoft Edge is unavailable\n");
  process.exit(0);
}

// The page draws T3 Code's sidebar on a thread and its settings page on
// /settings/labs, and switches between them without a reload, like T3 Code.
const fixture = `<!doctype html><html><head><title>fixture</title><style>
  :root { --background:#111; --foreground:#eee; --card:#181818; --card-foreground:#eee; --popover:#1c1c1c;
    --popover-foreground:#eee; --border:#333; --muted-foreground:#999; --primary:#3b82f6; --primary-foreground:#fff;
    --secondary:#222; --accent:#2a2a2a; --accent-foreground:#fff; --input:#444; --ring:#3b82f6;
    --warning:#f59e0b; --destructive:#ef4444; --success:#10b981; }
  body { margin:0; background:var(--background); color:var(--foreground); font:13px sans-serif; }
  aside { position:fixed; left:0; bottom:0; width:300px; }
  [data-slot=sidebar-footer] { padding:8px; }
  .row { display:flex; align-items:center; gap:4px; margin:0; padding:0; list-style:none; }
  .row li { flex:none; }
  .row button { width:28px; height:28px; flex:none; }
</style></head><body>
  <div id="app"></div>
  <iframe id="frame" sandbox="allow-scripts" srcdoc="<script>const tell = () => parent.postMessage({ saw: typeof window.__t3Extras }, '*'); addEventListener('message', (event) => { if (event.data === 'probe') tell(); }); tell();</script>"></iframe>
  <script>
    window.addEventListener("message", (event) => { window.__frameSaw = event.data; });
    const app = document.getElementById("app");
    const draw = () => {
      if (location.pathname.startsWith("/settings/labs")) {
        app.innerHTML = '<div data-settings-page-scroll><div id="content"><section id="t3-own">Linked environments</section></div></div>';
      } else {
        app.innerHTML = '<aside><div data-slot="sidebar-footer" style="display:flex;flex-direction:column"><div id="notice">Codex update <button id="notice-button">Update</button></div><ul class="row" data-slot="sidebar-menu"><li><button id="b1">s</button></li><li><button id="b2">p</button></li><li><button id="b3">c</button></li><li id="refresh-item" style="margin-left:auto"><button id="refresh">r</button></li></ul></div></aside>';
      }
    };
    window.go = (to) => { history.pushState(null, "", to); draw(); };
    draw();
  </script>
</body></html>`;

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(fixture);
});

const NOW = Date.now();
const accounts = [
  { id: "claudeAgent", provider: "Claude", name: "Claude 1", accent: "#e06d14", checkedAt: NOW - 60000, windows: [
    { label: "Weekly", usedPercent: 100, resetsAt: NOW + 21 * 3600000, windowDurationMins: 10080 },
    { label: "Weekly · Fable", usedPercent: 41, resetsAt: NOW + 21 * 3600000, windowDurationMins: 10080 },
  ] },
  { id: "claude_ai2", provider: "Claude", name: "Claude 2", accent: "#cc1717", checkedAt: NOW - 60000, windows: [{ label: "Weekly", usedPercent: 83, resetsAt: NOW + 38 * 3600000 }] },
  { id: "codex", provider: "Codex", name: "Codex Ai", accent: "#2dc666", checkedAt: NOW - 60000, windows: [{ label: "Monthly", usedPercent: 7, resetsAt: null }] },
  { id: "ai2", provider: "Codex", name: "Codex Ai2", accent: "#1d4db5", checkedAt: NOW - 60000, windows: [{ label: "Weekly", usedPercent: 29, resetsAt: NOW + 24 * 3600000 }] },
  // A provider named like an object property, which reports usage but has
  // no open window: it is in the account list, not in the chips.
  { id: "odd", provider: "constructor", name: "Odd", accent: null, reportsUsage: true, checkedAt: null, windows: [] },
];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-extras-smoke-"));
const testProfile = path.join(root, "profile");
const fixDirectory = path.join(root, "fix");
const t3Home = path.join(root, "t3home");
fs.mkdirSync(fixDirectory);
fs.mkdirSync(path.join(t3Home, "userdata"), { recursive: true });
const settingsFile = path.join(fixDirectory, "settings.json");

let child;
const pending = new Map();
const handled = [];
let nextId = 1;
let incoming = Buffer.alloc(0);
let dispatch;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  child.stdio[3].write(`${JSON.stringify(message)}\0`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function onData(chunk) {
  incoming = Buffer.concat([incoming, chunk]);
  while (true) {
    const separator = incoming.indexOf(0);
    if (separator === -1) break;
    const raw = incoming.subarray(0, separator).toString("utf8");
    incoming = incoming.subarray(separator + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    if (dispatch.handle(message)) continue;
    if (!message.id || !pending.has(message.id)) continue;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result || {});
  }
}

async function evaluate(sessionId, expression) {
  const result = await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  return result.result?.value;
}

async function waitFor(sessionId, expression, description) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (await evaluate(sessionId, expression)) return;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function clickOn(sessionId, selector) {
  const point = JSON.parse(await evaluate(sessionId, `JSON.stringify((() => {
    const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  })())`));
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
  }
}

async function press(sessionId, key, code, keyCode) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode }, sessionId);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode }, sessionId);
}

const disk = () => (fs.existsSync(settingsFile) ? JSON.parse(fs.readFileSync(settingsFile, "utf8")) : {});
const STRIP = `document.querySelector("[data-t3-extras-usage]")`;
const STRIP_TEXT = `(${STRIP} ? ${STRIP}.innerText.replace(/\\s+/g, " ").trim() : null)`;

// Asks the frame again, after the step under test, what it can reach.
async function probeFrame(sessionId) {
  await evaluate(sessionId, `(window.__frameSaw = null, document.getElementById("frame").contentWindow.postMessage("probe", "*"), 1)`);
  await waitFor(sessionId, "!!window.__frameSaw", "the frame's answer");
  return evaluate(sessionId, "window.__frameSaw.saw");
}

async function run() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  child = spawn(edgePath, ["--headless=new", "--no-first-run", `--user-data-dir=${testProfile}`, "--remote-debugging-pipe", "about:blank"], {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
  });
  child.stdio[4].on("data", onData);

  const store = createSettingsStore({ directory: fixDirectory, t3Home });
  const service = createExtrasService({
    send,
    store,
    reader: { read: async () => ({ accounts, problem: null }) },
    repoStatusAvailable: () => true,
    protocol: "http:",
  });
  dispatch = createDispatch({
    bindings: { [EXTRAS_BINDING]: (sessionId, params) => handled.push(service.handle(sessionId, params?.executionContextId, params?.payload)) },
    navigated: [(sessionId, frame) => service.navigated(sessionId, frame)],
  });

  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((target) => target.type === "page");
  const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Page.navigate", { url: `${base}/env/thread` }, sessionId);
  await waitFor(sessionId, `document.readyState === "complete" && !!document.getElementById("refresh") && !!window.__frameSaw`, "the fixture");
  const before = JSON.parse(await evaluate(sessionId, `JSON.stringify(["b1","b2","b3","refresh"].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().left)))`));
  await service.attach(sessionId);

  // The two busiest accounts and the count of the rest, before the refresh
  // button, without moving T3 Code's buttons.
  await waitFor(sessionId, `(${STRIP_TEXT} || "").startsWith("100% 83%")`, "the usage chips");
  const placed = JSON.parse(await evaluate(sessionId, `JSON.stringify({
    before: ${STRIP}.nextElementSibling.id,
    top: Math.round(${STRIP}.getBoundingClientRect().top + ${STRIP}.getBoundingClientRect().height / 2),
    refreshTop: Math.round(document.getElementById("refresh").getBoundingClientRect().top + document.getElementById("refresh").getBoundingClientRect().height / 2),
    tag: ${STRIP}.tagName,
    buttons: ["b1","b2","b3","refresh"].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().left)),
    label: ${STRIP}.querySelector("button").getAttribute("aria-label"),
  })`));
  if (placed.before !== "refresh-item" || placed.top !== placed.refreshTop) throw new Error(`The chips are not before the refresh button: ${JSON.stringify(placed)}`);
  if (placed.buttons[0] !== before[0] || placed.buttons[1] !== before[1] || placed.buttons[2] !== before[2]) {
    throw new Error(`The chips moved T3 Code's left buttons: ${JSON.stringify([before, placed.buttons])}`);
  }
  if (!placed.label.includes("Claude 1 100%") || !placed.label.includes("Codex Ai 7%")) throw new Error(`Unexpected label: ${placed.label}`);

  // Neither T3 Code's main world nor a frame gets the binding or the receiver.
  const reach = JSON.parse(await evaluate(sessionId, `JSON.stringify({
    main: typeof window.${EXTRAS_BINDING},
    receivers: Object.getOwnPropertyNames(window).filter((name) => name.startsWith("__t3Extras")),
    frame: window.__frameSaw,
  })`));
  if (reach.main !== "undefined" || reach.receivers.length || reach.frame.saw !== "undefined") {
    throw new Error(`The binding leaked: ${JSON.stringify(reach)}`);
  }
  if ((await probeFrame(sessionId)) !== "undefined") throw new Error("The frame reached the binding after the start");

  // A second start in the same document, as after a return from the back and
  // forward cache: one copy owns the chips, and changes still work.
  const { frameTree } = await send("Page.getFrameTree", {}, sessionId);
  const ownerBefore = await evaluate(sessionId, `document.documentElement.getAttribute("data-t3-extras-owner")`);
  await service.navigated(sessionId, { id: frameTree.frame.id });
  await waitFor(sessionId, `document.documentElement.getAttribute("data-t3-extras-owner") !== ${JSON.stringify(ownerBefore)}`, "the new owner");
  await waitFor(sessionId, `(${STRIP_TEXT} || "").startsWith("100% 83%") && document.querySelectorAll("[data-t3-extras-usage]").length === 1`, "one copy of the chips after a second start");

  // The popover opens from the keyboard and closes with Escape.
  await evaluate(sessionId, `${STRIP}.querySelector("button").focus(), 1`);
  await press(sessionId, "Enter", "Enter", 13);
  await waitFor(sessionId, `!!document.querySelector("[data-t3-extras-usage-pop]")`, "the popover");
  const pop = await evaluate(sessionId, `document.querySelector("[data-t3-extras-usage-pop]").innerText`);
  if (!pop.includes("Claude 2") || !pop.includes("Weekly · Fable") || !pop.includes("41%") || !pop.includes("resets in") || pop.includes("Checked")) {
    throw new Error(`Unexpected popover: ${pop}`);
  }
  // Each limit has its own line, and the pace arrows follow T3 Code's rule:
  // 100% used with seven eighths of the week gone is ahead, 41% is under.
  const lines = JSON.parse(await evaluate(sessionId, `JSON.stringify([...document.querySelectorAll("[data-t3-extras-usage-pop] .t3x-window-line")].map((line) => [line.innerText.replace(/\\s+/g, " ").trim(), line.querySelector("[data-pace]")?.getAttribute("data-pace") ?? null]))`));
  const expectedLines = [["Weekly 100%", "blocked"], ["Weekly · Fable 41%", "under"], ["Weekly 83%", null], ["Monthly 7%", null], ["Weekly 29%", null]];
  if (JSON.stringify(lines) !== JSON.stringify(expectedLines)) throw new Error(`Unexpected limit lines: ${JSON.stringify(lines)}`);
  const chipPace = await evaluate(sessionId, `${STRIP}.querySelector(".t3x-chip [data-pace]")?.getAttribute("data-pace") ?? null`);
  if (chipPace !== "blocked") throw new Error(`Unexpected chip pace: ${chipPace}`);
  await press(sessionId, "Escape", "Escape", 27);
  await waitFor(sessionId, `!document.querySelector("[data-t3-extras-usage-pop]")`, "the popover to close");

  // A popover whose button React replaced closes with it.
  await evaluate(sessionId, `${STRIP}.querySelector("button").focus(), 1`);
  await press(sessionId, "Enter", "Enter", 13);
  await waitFor(sessionId, `!!document.querySelector("[data-t3-extras-usage-pop]")`, "the popover again");
  await evaluate(sessionId, `(go("/env/thread"), 1)`);
  await waitFor(sessionId, `!document.querySelector("[data-t3-extras-usage-pop]") && !!${STRIP}`, "the popover to close with its button");

  // The free width sets how many chips show: fewer in a narrow sidebar, more
  // in a wide one, and the buttons stay where they are.
  const CHIPS = `document.querySelectorAll("[data-t3-extras-usage] .t3x-chip").length`;
  const normal = await evaluate(sessionId, CHIPS);
  await evaluate(sessionId, `(document.querySelector("aside").style.width = "520px", 1)`);
  await waitFor(sessionId, `${CHIPS} === 4`, "every account in a wide sidebar");
  if (normal >= 4) throw new Error(`The normal sidebar already showed ${normal} chips`);
  await evaluate(sessionId, `(document.querySelector("aside").style.width = "175px", 1)`);
  await waitFor(sessionId, `${CHIPS} < ${normal}`, "fewer chips");
  const narrow = JSON.parse(await evaluate(sessionId, `JSON.stringify(["b1","b2","b3"].map((id) => Math.round(document.getElementById(id).getBoundingClientRect().left)))`));
  if (JSON.stringify(narrow) !== JSON.stringify(before.slice(0, 3))) throw new Error(`Narrow sidebar moved the buttons: ${narrow}`);
  await evaluate(sessionId, `(document.querySelector("aside").style.width = "300px", 1)`);
  await waitFor(sessionId, `(${STRIP_TEXT} || "").startsWith("100% 83%")`, "the chips to come back");

  // React redraws the footer: the chips come back.
  await evaluate(sessionId, `(go("/env/thread"), 1)`);
  await waitFor(sessionId, `(${STRIP_TEXT} || "").startsWith("100% 83%") && document.querySelectorAll("[data-t3-extras-usage]").length === 1`, "the chips after a redraw");

  // The Labs page, reached without a reload, shows one Extras section last.
  await evaluate(sessionId, `(go("/settings/labs"), 1)`);
  await waitFor(sessionId, `!!document.querySelector("[data-t3-extras-settings]") && !document.querySelector("[data-t3-extras-usage]")`, "the Extras section");
  const section = JSON.parse(await evaluate(sessionId, `JSON.stringify({
    last: document.getElementById("content").lastElementChild.hasAttribute("data-t3-extras-settings"),
    count: document.querySelectorAll("[data-t3-extras-settings]").length,
    text: document.querySelector("[data-t3-extras-settings]").innerText,
  })`));
  if (!section.last || section.count !== 1 || !section.text.includes("Added by t3code-rtl-fix") || !section.text.includes("All accounts")) {
    throw new Error(`Unexpected Extras section: ${JSON.stringify(section)}`);
  }

  // A click made by a script writes nothing.
  const usageSwitch = `[data-t3-extras-settings] [role=switch][aria-label="Usage limits in the sidebar"]`;
  await evaluate(sessionId, `(document.querySelector(${JSON.stringify(usageSwitch)}).click(), 1)`);
  await wait(400);
  await Promise.all(handled);
  if (fs.existsSync(settingsFile)) throw new Error("A synthetic click wrote the settings");

  // A real click turns the chips off, and the thread's sidebar follows.
  await clickOn(sessionId, usageSwitch);
  await waitFor(sessionId, `document.querySelector(${JSON.stringify(usageSwitch)}).getAttribute("aria-checked") === "false"`, "the switch to turn off");
  await Promise.all(handled);
  if (disk().usageLimits !== false) throw new Error(`The switch was not saved: ${JSON.stringify(disk())}`);
  await evaluate(sessionId, `(go("/env/thread"), 1)`);
  await wait(300);
  if (await evaluate(sessionId, `!!${STRIP}`)) throw new Error("The chips stayed after they were turned off");
  await evaluate(sessionId, `(go("/settings/labs"), 1)`);
  await waitFor(sessionId, `!!document.querySelector(${JSON.stringify(usageSwitch)})`, "the section again");
  await clickOn(sessionId, usageSwitch);
  await waitFor(sessionId, `document.querySelector(${JSON.stringify(usageSwitch)}).getAttribute("aria-checked") === "true"`, "the switch to turn on");

  // The Working section switch is off by default and is saved when clicked.
  const shelfSwitch = `[data-t3-extras-settings] [role=switch][aria-label="Working section in the boring sidebar"]`;
  if (await evaluate(sessionId, `document.querySelector(${JSON.stringify(shelfSwitch)}).getAttribute("aria-checked")`) !== "false") {
    throw new Error("The Working section switch is not off by default");
  }
  await clickOn(sessionId, shelfSwitch);
  await waitFor(sessionId, `document.querySelector(${JSON.stringify(shelfSwitch)}).getAttribute("aria-checked") === "true"`, "the Working section switch to turn on");
  await Promise.all(handled);
  if (disk().boringWorkingShelf !== true) throw new Error(`The Working section switch was not saved: ${JSON.stringify(disk())}`);
  await clickOn(sessionId, shelfSwitch);
  await waitFor(sessionId, `document.querySelector(${JSON.stringify(shelfSwitch)}).getAttribute("aria-checked") === "false"`, "the Working section switch to turn off");
  await Promise.all(handled);
  if (disk().boringWorkingShelf !== false) throw new Error(`The Working section switch was not saved off: ${JSON.stringify(disk())}`);

  // The account list: open it, move down, and hide the second account.
  await clickOn(sessionId, "[data-t3-extras-settings] .t3x-trigger");
  await waitFor(sessionId, `document.activeElement && document.activeElement.getAttribute("role") === "option"`, "the account list");
  await press(sessionId, "ArrowDown", "ArrowDown", 40);
  await press(sessionId, " ", "Space", 32);
  await waitFor(sessionId, `document.querySelector("[data-t3-extras-settings] .t3x-trigger").innerText.includes("4 of 5 accounts")`, "the hidden account");
  await Promise.all(handled);
  if (JSON.stringify(disk().usageHiddenAccounts) !== JSON.stringify(["claude_ai2"])) throw new Error(`Unexpected hidden accounts: ${JSON.stringify(disk())}`);
  const listOpen = await evaluate(sessionId, `!!document.querySelector("[data-t3-extras-settings] [role=listbox]") && document.activeElement.getAttribute("role") === "option"`);
  if (!listOpen) throw new Error("The account list closed after a change");
  await press(sessionId, "Escape", "Escape", 27);
  await waitFor(sessionId, `!document.querySelector("[role=listbox]") && document.activeElement.classList.contains("t3x-trigger")`, "the list to close");
  await evaluate(sessionId, `(go("/env/thread"), 1)`);
  await waitFor(sessionId, `(${STRIP_TEXT} || "").startsWith("100% 29%")`, "the chips without the hidden account");

  // A settings file that cannot be read is never overwritten, and says so.
  fs.writeFileSync(settingsFile, "{ broken", "utf8");
  await evaluate(sessionId, `(go("/settings/labs"), 1)`);
  await waitFor(sessionId, `!!document.querySelector(${JSON.stringify(usageSwitch)})`, "the section");
  await clickOn(sessionId, usageSwitch);
  await waitFor(sessionId, `document.querySelector("[data-t3-extras-settings]").innerText.includes("settings.json could not be read")`, "the error");
  if (fs.readFileSync(settingsFile, "utf8") !== "{ broken") throw new Error("A broken settings file was overwritten");
  fs.writeFileSync(settingsFile, "{}", "utf8");

  // A reload starts a new world, and the chips come back.
  await evaluate(sessionId, `(go("/env/thread"), 1)`);
  await evaluate(sessionId, "(window.__oldDocument = true, 1)");
  await send("Page.reload", {}, sessionId);
  // The checks below run on the new document and its frame.
  await waitFor(sessionId, `!window.__oldDocument && document.readyState === "complete" && !!window.__frameSaw`, "the new document");
  await waitFor(sessionId, `(${STRIP_TEXT} || "").startsWith("100% 83%")`, "the chips after a reload");
  const afterReload = await evaluate(sessionId, `typeof window.${EXTRAS_BINDING}`);
  if (afterReload !== "undefined") throw new Error("The binding reached the main world after a reload");
  if ((await probeFrame(sessionId)) !== "undefined") throw new Error("The frame reached the binding after a reload");
  await Promise.all(handled);
}

function clean() {
  const resolved = path.resolve(root);
  const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (resolved.startsWith(tempRoot) && path.basename(resolved).startsWith("t3-extras-smoke-")) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      // A browser that is still releasing its profile must not fail the test.
    }
  }
}

const timeout = setTimeout(() => {
  process.stderr.write("Extras smoke test timed out\n");
  child?.kill();
  process.exitCode = 1;
}, 60000);

run().then(() => {
  process.stdout.write("Extras smoke test passed\n");
}, (error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(timeout);
  server.close();
  if (child) {
    child.once("exit", clean);
    child.kill();
  } else clean();
});
