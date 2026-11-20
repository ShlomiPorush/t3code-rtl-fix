"use strict";

// Verifies the right-to-left layout in a real browser: T3 Code-like layered
// CSS served from a link and an inline style is mirrored through copies, a
// style whose text changes is mirrored again, a sheet whose rules were added
// by script is left alone, turning the layout off gives back the exact
// original computed values, and a resize drag moves the pointer the mirrored
// way.
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildLayoutSource } = require("../src/app-layout");

const edgePath = path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe");
if (process.platform !== "win32" || !fs.existsSync(edgePath)) {
  process.stdout.write("Layout smoke test skipped: Microsoft Edge is unavailable\n");
  process.exit(0);
}

const LINK_CSS = `@layer theme, base, components, utilities;
@layer utilities {
  .ml-4 { margin-left: 16px; }
  .order { margin-left: 4px; margin-inline-start: 8px; }
  .var-short { margin: var(--m); margin-left: 2px; }
  .pl-3 { padding-left: 12px; }
  .left-0 { left: 0; }
  .border-l { border-left-style: solid; border-left-width: 3px; }
  .text-left { text-align: left; }
  @media (width >= 1px) { .sm\\:pr-2 { padding-right: 8px; } }
  .rail { --tw-translate-x: -50%; translate: var(--tw-translate-x) 0; }
}
.box { position: relative; width: 100px; height: 20px; }
.font { background: url(img/dot.png); }
`;

const PAGE = `<!doctype html><html><head>
<link rel="stylesheet" href="/main.css">
<style id="inline-style">.inline-pr { padding-right: 5px; }</style>
<style id="scripted"></style>
</head><body>
<div id="wrap" style="width: 400px; --m: 1px 9px 3px 7px;">
  <div id="ml" class="ml-4 box"></div>
  <div id="order" class="order box"></div>
  <div id="var-short" class="var-short box"></div>
  <div id="pl" class="pl-3 box"></div>
  <div id="pos" style="position: relative; width: 300px; height: 20px;"><div id="left" class="left-0" style="position: absolute; width: 10px; height: 10px;"></div></div>
  <div id="border" class="border-l box"></div>
  <div id="align" class="text-left box">English text.</div>
  <div id="sm" class="sm:pr-2 box"></div>
  <div id="inline" class="inline-pr box"></div>
  <div id="scripted-target" class="scripted-pl box"></div>
  <div id="rail" class="rail box"></div>
  <div id="placed" class="rail box" style="left: 10px;"><div id="placed-child" class="rail box"></div><div id="placed-handle" style="left: 0; position: relative; cursor: ew-resize; width: 20px; height: 20px;"><span id="placed-grip">|</span></div><div id="inner-handle" style="cursor: ew-resize; width: 20px; height: 20px;"></div></div>
  <div id="handle" style="cursor: col-resize; width: 20px; height: 20px;"></div>
  <div id="mini-handle" data-preview-mini-player-resize class="ml-4" style="cursor: ew-resize; width: 20px; height: 20px;"></div>
</div>
</body></html>`;

const server = http.createServer((request, response) => {
  if (request.url === "/main.css") {
    response.writeHead(200, { "content-type": "text/css" });
    response.end(LINK_CSS);
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE);
});

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "t3-rtl-layout-test-"));
let child = null;
const pending = new Map();
let nextId = 1;
let incoming = Buffer.alloc(0);

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  child.stdio[3].write(`${JSON.stringify(message)}\0`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

async function run(port) {
  child = spawn(edgePath, [
    "--headless=new",
    "--no-first-run",
    `--user-data-dir=${profile}`,
    "--remote-debugging-pipe",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  child.stdio[4].on("data", (chunk) => {
    incoming = Buffer.concat([incoming, chunk]);
    for (;;) {
      const separator = incoming.indexOf(0);
      if (separator === -1) break;
      const raw = incoming.subarray(0, separator).toString("utf8");
      incoming = incoming.subarray(separator + 1);
      if (!raw) continue;
      const message = JSON.parse(raw);
      const request = message.id ? pending.get(message.id) : null;
      if (!request) continue;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(message.error.message));
      else request.resolve(message.result || {});
    }
  });

  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((target) => target.type === "page");
  const { sessionId } = await send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  const evaluate = async (expression) => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Off first, to record T3 Code's own layout.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: buildLayoutSource({ enabled: false }) }, sessionId);
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/` }, sessionId);
  await wait(1200);
  // A sheet whose rules come from script, not from its text.
  await evaluate(`document.getElementById("scripted").sheet.insertRule(".scripted-pl { padding-left: 6px; }")`);
  const measure = `(() => {
    const s = (id) => getComputedStyle(document.getElementById(id));
    const pos = document.getElementById("pos").getBoundingClientRect();
    const left = document.getElementById("left").getBoundingClientRect();
    return {
      dir: document.documentElement.getAttribute("dir"),
      mlLeft: s("ml").marginLeft, mlRight: s("ml").marginRight,
      orderLeft: s("order").marginLeft, orderRight: s("order").marginRight,
      varLeft: s("var-short").marginLeft, varRight: s("var-short").marginRight,
      plLeft: s("pl").paddingLeft, plRight: s("pl").paddingRight,
      leftOffset: Math.round(left.left - pos.left), rightOffset: Math.round(pos.right - left.right),
      borderLeft: s("border").borderLeftWidth, borderRight: s("border").borderRightWidth,
      align: s("align").textAlign,
      smLeft: s("sm").paddingLeft, smRight: s("sm").paddingRight,
      inlineLeft: s("inline").paddingLeft, inlineRight: s("inline").paddingRight,
      scriptedLeft: s("scripted-target").paddingLeft,
      rail: s("rail").translate,
      placed: s("placed").translate,
      placedChild: s("placed-child").translate,
      font: s("var-short").fontFamily,
      copies: document.querySelectorAll("[data-t3-rtl-mirror]").length,
      disabled: Array.from(document.styleSheets).filter((sheet) => sheet.disabled).length,
    };
  })()`;
  const original = await evaluate(measure);
  check(original.mlLeft === "16px" && original.copies === 0 && original.disabled === 0, `Off state is not T3 Code's own: ${JSON.stringify(original)}`);

  // On, in place.
  await evaluate("globalThis.__t3RtlLayout.set(true)");
  await wait(600);
  const on = await evaluate(measure);
  check(on.dir === "rtl", `The root is not right to left: ${on.dir}`);
  check(on.mlRight === "16px" && on.mlLeft === "0px", `margin-left was not mirrored: ${JSON.stringify(on)}`);
  check(on.orderRight === "8px" && on.orderLeft === "0px", `The later logical declaration lost: ${JSON.stringify(on)}`);
  check(on.varRight === "2px" && on.varLeft === "7px", `A var() shorthand lost its sides: ${JSON.stringify(on)}`);
  check(on.plRight === "12px" && on.plLeft === "0px", `padding-left was not mirrored: ${JSON.stringify(on)}`);
  check(on.rightOffset === 0, `left: 0 was not mirrored: ${JSON.stringify(on)}`);
  check(on.borderRight === "3px" && on.borderLeft === "0px", `The border was not mirrored: ${JSON.stringify(on)}`);
  check(on.align === "start", `text-align: left was not mirrored: ${on.align}`);
  check(on.smLeft === "8px", `A rule inside @media was not mirrored: ${JSON.stringify(on)}`);
  check(on.inlineLeft === "5px", `The inline style was not mirrored: ${JSON.stringify(on)}`);
  check(on.scriptedLeft === "6px", `A scripted sheet was changed: ${JSON.stringify(on)}`);
  check(on.rail.startsWith("50%"), `The translate was not mirrored: ${on.rail}`);
  check(on.placed.startsWith("-50%"), `An element placed by script moved the other way: ${on.placed}`);
  check(on.placedChild.startsWith("50%"), `A box inside a placed element did not follow its direction: ${on.placedChild}`);
  check(on.copies === 2 && on.disabled === 2, `Expected two copies and two sheets off: ${JSON.stringify(on)}`);

  // A style whose text changes is mirrored again.
  await evaluate(`document.getElementById("inline-style").textContent = ".inline-pr { padding-right: 11px; }"`);
  await wait(300);
  const changed = await evaluate(measure);
  check(changed.inlineLeft === "11px" && changed.inlineRight === "0px", `A changed style was not mirrored again: ${JSON.stringify(changed)}`);
  check(changed.copies === 2 && changed.disabled === 2, `A changed style left a stale copy: ${JSON.stringify(changed)}`);

  // A resize drag moves the pointer the mirrored way.
  const dragged = await evaluate(`(() => {
    const handle = document.getElementById("handle");
    const seen = [];
    handle.addEventListener("pointermove", (event) => seen.push(event.clientX));
    const options = (x) => ({ bubbles: true, pointerId: 7, clientX: x, clientY: 5, button: 0 });
    handle.dispatchEvent(new PointerEvent("pointerdown", options(100)));
    handle.dispatchEvent(new PointerEvent("pointermove", options(80)));
    handle.dispatchEvent(new PointerEvent("pointerup", options(80)));
    handle.dispatchEvent(new PointerEvent("pointermove", options(80)));
    return seen;
  })()`);
  check(dragged[0] === 120 && dragged[1] === 80, `The drag was not mirrored once: ${JSON.stringify(dragged)}`);
  const placedDrag = await evaluate(`(() => {
    const handle = document.getElementById("placed-handle");
    const seen = [];
    handle.addEventListener("pointermove", (event) => seen.push(event.clientX));
    const options = (x) => ({ bubbles: true, pointerId: 8, clientX: x, clientY: 5, button: 0 });
    handle.dispatchEvent(new PointerEvent("pointerdown", options(100)));
    handle.dispatchEvent(new PointerEvent("pointermove", options(80)));
    handle.dispatchEvent(new PointerEvent("pointerup", options(80)));
    return seen;
  })()`);
  check(placedDrag[0] === 80, `A handle placed by script was mirrored: ${JSON.stringify(placedDrag)}`);
  // A handle that the mirrored stylesheets place inside a placed element is
  // mirrored, also when the drag starts on its content.
  const innerDrag = await evaluate(`(() => {
    const handle = document.getElementById("inner-handle");
    const grip = document.getElementById("placed-grip");
    const seen = [];
    handle.addEventListener("pointermove", (event) => seen.push(event.clientX));
    grip.addEventListener("pointermove", (event) => seen.push("grip:" + event.clientX));
    const options = (x, id) => ({ bubbles: true, pointerId: id, clientX: x, clientY: 5, button: 0 });
    handle.dispatchEvent(new PointerEvent("pointerdown", options(100, 9)));
    handle.dispatchEvent(new PointerEvent("pointermove", options(80, 9)));
    handle.dispatchEvent(new PointerEvent("pointerup", options(80, 9)));
    grip.dispatchEvent(new PointerEvent("pointerdown", options(100, 10)));
    grip.dispatchEvent(new PointerEvent("pointermove", options(80, 10)));
    grip.dispatchEvent(new PointerEvent("pointerup", options(80, 10)));
    return seen;
  })()`);
  const mini = await evaluate(`(() => {
    const handle = document.getElementById("mini-handle");
    const seen = [];
    handle.addEventListener("pointermove", (event) => seen.push(event.clientX));
    const options = (x) => ({ bubbles: true, pointerId: 11, clientX: x, clientY: 5, button: 0 });
    handle.dispatchEvent(new PointerEvent("pointerdown", options(100)));
    handle.dispatchEvent(new PointerEvent("pointermove", options(80)));
    handle.dispatchEvent(new PointerEvent("pointerup", options(80)));
    return { seen, dir: handle.getAttribute("dir"), left: getComputedStyle(handle).marginLeft };
  })()`);
  check(mini.dir === "ltr" && mini.left === "16px" && mini.seen[0] === 80,
    `A floating preview handle left its physical side: ${JSON.stringify(mini)}`);
  check(innerDrag[0] === 120 && innerDrag[1] === "grip:80", `Handles inside a placed element were not judged by their own place: ${JSON.stringify(innerDrag)}`);

  // A second injection into the same document takes over from the first,
  // so turning the layout off still gives everything back.
  await evaluate(buildLayoutSource({ enabled: true }));
  await wait(400);
  const again = await evaluate(measure);
  check(again.dir === "rtl" && again.copies === 2 && again.disabled === 2, `A second injection did not take over: ${JSON.stringify(again)}`);

  // Off again gives back the exact original values.
  await evaluate("globalThis.__t3RtlLayout.set(false)");
  await wait(300);
  const off = await evaluate(measure);
  for (const key of Object.keys(original)) {
    check(JSON.stringify(off[key]) === JSON.stringify(original[key]) || key === "inlineLeft" || key === "inlineRight",
      `Off did not restore ${key}: ${JSON.stringify(off[key])} instead of ${JSON.stringify(original[key])}`);
  }
  check(off.inlineRight === "11px", `Off did not restore the changed inline style: ${JSON.stringify(off)}`);

  // A new document starts in the saved layout.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: buildLayoutSource({ enabled: true }) }, sessionId);
  await send("Page.reload", {}, sessionId);
  await wait(1200);
  const reloaded = await evaluate(measure);
  check(reloaded.dir === "rtl" && reloaded.mlRight === "16px" && reloaded.copies === 2, `A new document did not start mirrored: ${JSON.stringify(reloaded)}`);
  const loading = await evaluate(`document.documentElement.hasAttribute("data-t3-rtl-loading")`);
  check(loading === false, "The new document stayed hidden");

  // Two runs before the document has a root leave one layout, which still
  // gives everything back when it is turned off.
  await send("Page.addScriptToEvaluateOnNewDocument", { source: buildLayoutSource({ enabled: true }) }, sessionId);
  await send("Page.reload", {}, sessionId);
  await wait(1200);
  await evaluate("globalThis.__t3RtlLayout.set(false)");
  await wait(300);
  const twice = await evaluate(measure);
  check(twice.dir === null && twice.copies === 0 && twice.disabled === 0 && twice.mlLeft === "16px",
    `Two early runs left the layout on: ${JSON.stringify(twice)}`);

  // A link that stops being a stylesheet loses its copy.
  await evaluate("globalThis.__t3RtlLayout.set(true)");
  await wait(600);
  await evaluate(`document.querySelector('link[href="/main.css"]').rel = "preload"`);
  await wait(300);
  const relinked = await evaluate(`document.querySelectorAll("[data-t3-rtl-mirror]").length`);
  check(relinked === 1, `A link that stopped being a stylesheet kept its copy: ${relinked} copies`);
}

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  run(port).then(
    () => {
      process.stdout.write("Right-to-left layout passed\n");
      finish(0);
    },
    (error) => {
      process.stderr.write(`Right-to-left layout failed: ${error.message}\n`);
      finish(1);
    },
  );
});

function finish(code) {
  server.close();
  if (child) {
    try {
      send("Browser.close").catch(() => {});
    } catch {}
  }
  setTimeout(() => {
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {}
    process.exit(code);
  }, 500);
}
