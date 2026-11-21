"use strict";

// Verifies in a real browser that a thread opens at the start of the agent's
// last reply. The page stands in for T3 Code's conversation: a new route
// shows its rows a moment later at the end of the list, and the list keeps
// pulling itself back to the end until an upward wheel event releases it, as
// T3 Code's follow of the end does.
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { CONFIG, buildReplyStartSource } = require("../src/reply-start");

const edgePath = path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe");
if (process.platform !== "win32" || !fs.existsSync(edgePath)) {
  process.stdout.write("Reply start smoke test skipped: Microsoft Edge is unavailable\n");
  process.exit(0);
}

const PAGE = `<!doctype html><html><head><style>
body { margin: 0; }
.messages-timeline-scroll { position: absolute; top: 40px; left: 0; width: 600px; height: 400px; overflow-y: auto; }
[data-timeline-row-id] { box-sizing: border-box; border: 1px solid #888; }
</style></head><body>
<div class="messages-timeline-scroll"><div data-timeline-root="true"></div></div>
<script>
  const scroller = document.querySelector(".messages-timeline-scroll");
  const root = scroller.firstElementChild;
  let released = false;
  // T3 Code may settle a thread a little above its end and pull it back
  // only on its next change of size.
  let resting = false;
  let wheels = 0;
  // T3 Code releases its follow of the end on an upward wheel event.
  scroller.addEventListener("wheel", (event) => {
    wheels += 1;
    if (event.deltaY < 0) released = true;
  }, { passive: true });
  const toEnd = () => { scroller.scrollTop = scroller.scrollHeight - scroller.clientHeight; };
  setInterval(() => { if (!released && !resting) toEnd(); }, 50);
  let rowNumber = 0;
  window.fake = {
    // Shows the rows of a newly opened thread after a delay, at the end, or
    // at a remembered offset. settleAbove moves the view up a little after
    // reaching the end, as T3 Code does. endAfter keeps the rows at the top
    // for a while before scrolling to the end. firstRows shows other rows of
    // the thread first, as a list whose rows are still being measured.
    show(rows, { delay = 150, at = "end", settleAbove = 0, endAfter = 0, firstRows = null } = {}) {
      released = at !== "end";
      resting = !!endAfter;
      const build = (list) => root.replaceChildren(...list.map(([kind, role, height]) => {
        const row = document.createElement("div");
        row.dataset.timelineRowId = "row-" + (rowNumber += 1);
        row.dataset.timelineRowKind = kind;
        if (role) row.dataset.messageRole = role;
        row.style.height = height + "px";
        return row;
      }));
      const place = () => {
        if (at === "end") {
          resting = false;
          toEnd();
          if (settleAbove) {
            resting = true;
            requestAnimationFrame(() => { scroller.scrollTop -= settleAbove; });
          }
        } else {
          scroller.scrollTop = at;
        }
      };
      setTimeout(() => {
        if (firstRows) {
          build(firstRows);
          setTimeout(() => { build(rows); place(); }, 30);
          return;
        }
        build(rows);
        if (endAfter) {
          scroller.scrollTop = 0;
          setTimeout(place, endAfter);
        } else {
          place();
        }
      }, delay);
    },
    // A virtualized list changes which of its rows are rendered.
    renderOtherRow() {
      const row = root.lastElementChild;
      if (row) row.dataset.timelineRowId = "row-" + (rowNumber += 1);
    },
    // The composer's stop button, shown while the agent works.
    setBusy(busy) {
      document.getElementById("stop")?.remove();
      if (!busy) return;
      const button = document.createElement("button");
      button.id = "stop";
      button.className = "flex rounded-full bg-destructive/90";
      button.innerHTML = '<svg width="12" height="12"><rect x="2" y="2" width="8" height="8"></rect></svg>';
      document.body.appendChild(button);
    },
    state() {
      const rows = [...root.children];
      const last = rows[rows.length - 1];
      return {
        lastTop: last ? Math.round(last.getBoundingClientRect().top - scroller.getBoundingClientRect().top) : null,
        fromEnd: Math.round(scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight),
        scrollTop: Math.round(scroller.scrollTop),
        released,
        wheels,
      };
    },
  };
  // A page opened on a thread shows it as soon as it loads.
  const initial = new URLSearchParams(location.search).get("initial");
  if (initial === "long") fake.show([["message", "user", 60], ["message", "assistant", 1500]], { delay: 300 });
</script>
</body></html>`;

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(PAGE);
});

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "t3-rtl-reply-start-test-"));
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

  await send("Page.addScriptToEvaluateOnNewDocument", { source: buildReplyStartSource() }, sessionId);

  // A page opened on a thread with a long reply.
  await send("Page.navigate", { url: `http://127.0.0.1:${port}/environment/first?initial=long` }, sessionId);
  await wait(1200);
  const first = await evaluate("fake.state()");
  check(first.lastTop === CONFIG.offset && first.released, `A page opened on a long reply did not show its start: ${JSON.stringify(first)}`);

  let thread = 0;
  const open = async (rows, options, before) => {
    thread += 1;
    await evaluate(`history.pushState({}, "", "/environment/thread-${thread}"); fake.show(${JSON.stringify(rows)}, ${JSON.stringify(options || {})})`);
    if (before) await before();
    await wait(900);
    return evaluate("fake.state()");
  };
  const LONG = [["message", "user", 60], ["work", null, 40], ["message", "assistant", 1500]];

  const long = await open(LONG);
  check(long.lastTop === CONFIG.offset && long.released, `A long reply did not open at its start: ${JSON.stringify(long)}`);
  await wait(400);
  const held = await evaluate("fake.state()");
  check(held.lastTop === CONFIG.offset, `The start of a long reply did not stay in place: ${JSON.stringify(held)}`);

  const settled = await open(LONG, { settleAbove: 46 });
  check(settled.lastTop === CONFIG.offset && settled.released, `A long reply that settled above the end did not open at its start: ${JSON.stringify(settled)}`);

  const plan = await open([["message", "user", 60], ["proposed-plan", null, 1200]]);
  check(plan.lastTop === CONFIG.offset, `A long proposed plan did not open at its start: ${JSON.stringify(plan)}`);

  const short = await open([["message", "user", 60], ["message", "assistant", 120]]);
  check(short.fromEnd === 0 && !short.released && short.wheels === long.wheels + 2, `A short reply moved: ${JSON.stringify(short)}`);

  const working = await open([["message", "user", 60], ["message", "assistant", 1500], ["working", null, 40]]);
  check(working.fromEnd === 0 && !working.released, `A thread whose agent works did not stay at its end: ${JSON.stringify(working)}`);

  const userLast = await open([["message", "assistant", 1500], ["message", "user", 60]]);
  check(userLast.fromEnd === 0 && !userLast.released, `A thread ending in the person's message moved: ${JSON.stringify(userLast)}`);

  const restored = await open(LONG, { at: 300 });
  check(restored.scrollTop === 300, `A remembered place was not kept: ${JSON.stringify(restored)}`);

  // A restored thread that reaches its end soon after, such as from the
  // Scroll to end button, stays there.
  const restoredWheels = restored.wheels;
  await open(LONG, { at: 300 }, async () => {
    await wait(500);
    await evaluate("document.querySelector('.messages-timeline-scroll').scrollTop = 1e6");
  });
  const toEndAfterRestore = await evaluate("fake.state()");
  check(toEndAfterRestore.fromEnd === 0 && toEndAfterRestore.wheels === restoredWheels, `A restored thread moved after reaching its end: ${JSON.stringify(toEndAfterRestore)}`);

  // Rows shown first in a list too short to scroll are at its end before
  // T3 Code restores the remembered place.
  const grown = await open(LONG, { at: 300, firstRows: [["message", "user", 60]] });
  check(grown.scrollTop === 300 && grown.released, `A remembered place was lost after the list grew: ${JSON.stringify(grown)}`);

  // T3 Code scrolls to the end only after the rows stood still for a while.
  const late = await open(LONG, { endAfter: 300 });
  check(late.lastTop === CONFIG.offset && late.released, `A long reply placed late did not open at its start: ${JSON.stringify(late)}`);

  // A reply whose start is just inside the screen is not moved.
  const inside = await open([["message", "user", 100], ["message", "assistant", 392]]);
  check(inside.fromEnd === 0 && !inside.released && inside.lastTop === 8, `A reply that starts on the screen moved: ${JSON.stringify(inside)}`);

  // The agent works while its working row is outside the rendered rows.
  await evaluate("fake.setBusy(true)");
  const stopShown = await open(LONG);
  await evaluate("fake.setBusy(false)");
  check(stopShown.fromEnd === 0 && !stopShown.released, `A thread with the stop button shown moved: ${JSON.stringify(stopShown)}`);

  // The rows of the thread before change while the new one loads. They are
  // not taken for the new thread. That thread stays at its end, because the
  // person scrolled while it opened.
  await open(LONG, { delay: 300 }, async () => {
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 300, y: 240, deltaX: 0, deltaY: 1 }, sessionId);
  });
  const wheelsBefore = (await evaluate("fake.state()")).wheels;
  thread += 1;
  await evaluate(`history.pushState({}, "", "/environment/thread-${thread}"); fake.show(${JSON.stringify([["message", "user", 60], ["message", "assistant", 120]])}, { delay: 400 })`);
  await wait(100);
  await evaluate("fake.renderOtherRow()");
  await wait(900);
  const outgoing = await evaluate("fake.state()");
  check(outgoing.wheels === wheelsBefore, `The thread before the new one was moved: ${JSON.stringify(outgoing)}`);

  // A new thread before its first message is no thread yet.
  await evaluate(`history.pushState({}, "", "/draft/new"); fake.show(${JSON.stringify(LONG)})`);
  await wait(900);
  const draft = await evaluate("fake.state()");
  check(draft.fromEnd === 0 && !draft.released, `A draft route moved the list: ${JSON.stringify(draft)}`);

  // The person scrolls before the thread is placed.
  const scrolled = await open(LONG, { delay: 300 }, async () => {
    await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 300, y: 240, deltaX: 0, deltaY: 1 }, sessionId);
  });
  check(scrolled.fromEnd === 0 && !scrolled.released, `The thread moved after the person scrolled: ${JSON.stringify(scrolled)}`);

  // Another address of the same thread, such as an opened panel, is not a
  // new thread.
  await evaluate(`fake.show(${JSON.stringify(LONG)})`);
  await wait(400);
  await evaluate(`history.pushState({}, "", "/environment/thread-${thread}/panel?tab=1")`);
  await wait(900);
  const panel = await evaluate("fake.state()");
  check(panel.fromEnd === 0 && !panel.released, `Another address of the same thread moved it: ${JSON.stringify(panel)}`);
}

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  run(port).then(
    () => {
      process.stdout.write("Reply start passed\n");
      finish(0);
    },
    (error) => {
      process.stderr.write(`Reply start failed: ${error.message}\n`);
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
