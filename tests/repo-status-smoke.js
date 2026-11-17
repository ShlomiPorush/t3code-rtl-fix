"use strict";

// Verifies the repository status section end to end in a headless browser:
// the page script, the DevTools binding, and the launcher's service, against
// a thread details card shaped like T3 Code's. git and gh are replaced, so the
// test makes no network request outside the loopback page server.
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  REPO_STATUS_BINDING,
  createRepoStatusService,
} = require("../src/repo-status");

const edgePath = path.join(
  process.env["ProgramFiles(x86)"] || "",
  "Microsoft",
  "Edge",
  "Application",
  "msedge.exe",
);
if (process.platform !== "win32" || !fs.existsSync(edgePath)) {
  process.stdout.write("Repository status smoke test skipped: Microsoft Edge is unavailable\n");
  process.exit(0);
}

const environmentId = "env-1";
const threadWithRepo = "thread-1";
const threadWithoutRepo = "thread-2";
// The card sits in a panel on the right, like T3 Code's thread details.
const fixture = `<!doctype html><html><head><title>fixture</title>
  <style>aside { position: fixed; top: 0; right: 0; width: 280px; }</style>
</head><body>
  <aside>
    <div data-thread-details-card>
      <div data-slot="scroll-area-root">
        <div data-slot="scroll-area-viewport">
          <div id="content">
            <section id="first">Open in VS Code</section>
            <section id="second">Context</section>
          </div>
        </div>
        <div data-slot="scroll-area-scrollbar"></div>
      </div>
    </div>
  </aside>
</body></html>`;

const server = http.createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(fixture);
});

const testProfile = fs.mkdtempSync(path.join(os.tmpdir(), "t3-rtl-repo-status-test-"));
let child;
const pending = new Map();
const handled = [];
let nextId = 1;
let incoming = Buffer.alloc(0);
let service;
const opened = [];

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
    if (message.method === "Runtime.bindingCalled" && message.params?.name === REPO_STATUS_BINDING) {
      handled.push(service.handle(message.sessionId, message.params.payload));
      continue;
    }
    if (message.method === "Page.domContentEventFired") {
      handled.push(service.reattach(message.sessionId));
      continue;
    }
    if (!message.id || !pending.has(message.id)) continue;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result || {});
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

const recent = new Date().toISOString();
const recentSeconds = Math.floor(Date.now() / 1000);
const fakeRun = async (file, args) => {
  if (file === "git" && args[2] === "for-each-ref") {
    return {
      error: null,
      stdout: [
        `main\0origin\0refs/heads/main\0${recentSeconds}`,
        ...["spike", "spike-1", "spike-2", "spike-3", "spike-4", "spike-5", "spike-6", "spike-7"].map(
          (name, i) => `${name}\0\0\0${recentSeconds - i}`,
        ),
      ].join("\n") + "\n",
      stderr: "",
    };
  }
  if (file === "git") return { error: null, stdout: "git@github.com:o/r.git\n", stderr: "" };
  if (args[3] === "graphql") {
    const branch = (name) => ({
      name,
      target: { oid: name, committedDate: recent },
      associatedPullRequests: { totalCount: 0, nodes: [] },
    });
    return {
      error: null,
      stdout: JSON.stringify({
        data: {
          repository: {
            issues: {
              totalCount: 3,
              nodes: [{
                number: 7,
                title: "תיקון כיוון בטבלאות",
                updatedAt: recent,
                author: { login: "dana" },
                labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
              }],
            },
            pullRequests: { totalCount: 1 },
            vulnerabilityAlerts: { totalCount: 2 },
            defaultBranchRef: { name: "main" },
            refs: { totalCount: 2, nodes: [branch("main"), branch("feature/x")] },
          },
        },
      }),
      stderr: "",
    };
  }
  // Five alerts of each scanning kind, so the security tooltip is tall.
  const alerts = Array.from({ length: 5 }, (_, i) => (args[3].includes("code-scanning")
    ? { rule: { security_severity_level: ["high", "low"][i % 2], description: `Rule ${i}` }, most_recent_instance: { location: { path: `src/${i}.js` } } }
    : { secret_type_display_name: `Token ${i}` }));
  return { error: null, stdout: JSON.stringify(alerts), stderr: "" };
};

const STATE = `JSON.stringify((() => {
  const section = document.querySelector("[data-t3-rtl-repo-status]");
  if (!section) return null;
  return {
    inContent: section.parentElement.id === "content",
    last: section === section.parentElement.lastElementChild,
    sections: document.querySelectorAll("[data-t3-rtl-repo-status]").length,
    repo: section.querySelector(".t3-rtl-repo-status-head").textContent,
    items: [...section.children].slice(1).map((item) =>
      item.classList.contains("t3-rtl-repo-status-group")
        ? ["group", item.textContent, item.hasAttribute("data-separated"), getComputedStyle(item).borderTopStyle]
        : [item.tagName, item.dataset.kind, item.textContent, item.tabIndex, item.hasAttribute("title")],
    ),
  };
})())`;

async function run() {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  child = spawn(edgePath, [
    "--headless=new",
    "--no-first-run",
    `--user-data-dir=${testProfile}`,
    "--remote-debugging-pipe",
    "about:blank",
  ], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  child.stdio[4].on("data", onData);
  child.on("exit", cleanProfile);

  service = createRepoStatusService({
    send,
    run: fakeRun,
    findThreadFolder: (threadId) => (threadId === threadWithRepo ? "C:\\repo" : null),
    open: async (url) => opened.push(url),
  });

  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((target) => target.type === "page");
  if (!page) throw new Error("No page target was created");
  const { sessionId } = await send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  // The launcher attaches to a T3 Code page that has already loaded.
  await send("Page.navigate", { url: `${base}/${environmentId}/${threadWithRepo}` }, sessionId);
  await waitFor(sessionId, `document.readyState === "complete" && !!document.getElementById("content")`, "the fixture");
  await service.attach(sessionId);
  await waitFor(sessionId, `!!document.querySelector("[data-t3-rtl-repo-status]")`, "the section");

  const shown = JSON.parse(await evaluate(sessionId, STATE));
  const expectedShown = {
    inContent: true,
    last: true,
    sections: 1,
    repo: "o/r",
    items: [
      ["BUTTON", "issues", "Issues3", 0, false],
      ["BUTTON", "pulls", "Pull requests1", 0, false],
      ["BUTTON", "security", "Security alerts12", 0, false],
      ["group", "Branches", true, "solid"],
      ["BUTTON", "branches-remote", "Remote1", 0, false],
      // Local branches have no GitHub page, so their row is not a button,
      // but the keyboard still reaches it for its tooltip.
      ["DIV", "branches-local", "Local8", 0, false],
    ],
  };
  if (JSON.stringify(shown) !== JSON.stringify(expectedShown)) {
    throw new Error(`Unexpected section: ${JSON.stringify(shown)}`);
  }

  // T3 Code adds a section of its own after the page script ran.
  await evaluate(sessionId, `(() => {
    const added = document.createElement("section");
    added.id = "third";
    document.getElementById("content").appendChild(added);
    return 1;
  })()`);
  await waitFor(
    sessionId,
    `document.querySelector("[data-t3-rtl-repo-status]") === document.getElementById("content").lastElementChild`,
    "the section to move after a new card section",
  );

  await evaluate(sessionId, `document.querySelector('[data-t3-rtl-repo-status] button[data-kind="issues"]').click(), 1`);
  await waitFor(sessionId, "true", "the click");
  await wait(200);
  await Promise.all(handled);
  if (JSON.stringify(opened) !== JSON.stringify(["https://github.com/o/r/issues"])) {
    throw new Error(`Unexpected opened pages: ${JSON.stringify(opened)}`);
  }

  await checkTooltip(sessionId);
  await checkTooltipLinks(sessionId);
  await checkShortWindow(sessionId);

  // Another thread without a GitHub repository hides the section at once.
  await evaluate(sessionId, `history.pushState({}, "", "/${environmentId}/${threadWithoutRepo}"), 1`);
  await waitFor(sessionId, `!document.querySelector("[data-t3-rtl-repo-status]")`, "the section to hide");
  await wait(300);
  await Promise.all(handled);
  if (await evaluate(sessionId, `!!document.querySelector("[data-t3-rtl-repo-status]")`)) {
    throw new Error("The section came back for a thread without a repository");
  }

  // Back on the first thread, the fresh counts show again from the cache.
  await evaluate(sessionId, `history.pushState({}, "", "/${environmentId}/${threadWithRepo}"), 1`);
  await waitFor(sessionId, `!!document.querySelector("[data-t3-rtl-repo-status]")`, "the cached section");

  // A reload of the page brings the script and the binding back.
  await send("Page.reload", {}, sessionId);
  await waitFor(sessionId, `!!window.__t3RtlFixRepoStatusWatcher && !!document.getElementById("content")`, "the reloaded script");
  await waitFor(sessionId, `!!document.querySelector("[data-t3-rtl-repo-status]")`, "the section after a reload");

  await checkNewerCounts(sessionId);

  // With branch rows only, the Branches title has no line above it.
  await evaluate(sessionId, `window.__t3RtlFixRepoStatusUpdate({
    path: location.href,
    repo: "o/r",
    rows: [{ group: "branches", kind: "branches-stale", label: "Stale", count: "1", title: "old (40 days)" }],
  }), 1`);
  await waitFor(
    sessionId,
    `(() => {
      const group = document.querySelector("[data-t3-rtl-repo-status] .t3-rtl-repo-status-group");
      return !!group && !group.hasAttribute("data-separated") &&
        getComputedStyle(group).borderTopStyle === "none" &&
        document.querySelectorAll("[data-t3-rtl-repo-status] .t3-rtl-repo-status-row").length === 1;
    })()`,
    "a Branches group without a line above it",
  );
  process.stdout.write("Repository status section passed\n");
}

const TIP_STATE = `JSON.stringify((() => {
  const tip = document.querySelector(".t3-rtl-repo-status-tip");
  const row = document.querySelector('[data-t3-rtl-repo-status] [data-kind="issues"]');
  if (!tip) return null;
  const box = tip.getBoundingClientRect();
  const anchor = row.getBoundingClientRect();
  const text = tip.querySelector(".t3-rtl-tip-text");
  const label = tip.querySelector(".t3-rtl-tip-badge[data-label]");
  return {
    shown: tip.hasAttribute("data-shown"),
    topLayer: tip.matches(":popover-open"),
    role: tip.getAttribute("role"),
    describedBy: row.getAttribute("aria-describedby") === tip.id,
    head: [tip.querySelector(".t3-rtl-tip-title").textContent, tip.querySelector(".t3-rtl-tip-summary").textContent],
    text: text.textContent,
    textDirection: getComputedStyle(text).direction,
    meta: tip.querySelector(".t3-rtl-tip-meta").textContent,
    lead: tip.querySelector(".t3-rtl-tip-lead").textContent,
    label: label ? [label.textContent, label.style.getPropertyValue("--t3-rtl-tip-label")] : null,
    more: tip.querySelector(".t3-rtl-tip-more").textContent,
    inWindow: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
    leftOfRow: box.right <= anchor.left,
  };
})())`;

const TIP_HIDDEN = `(() => {
  const tip = document.querySelector(".t3-rtl-repo-status-tip");
  return !!tip && !tip.hasAttribute("data-open") && getComputedStyle(tip).display === "none" &&
    !document.querySelector("[aria-describedby]");
})()`;

async function hoverRow(sessionId, kind) {
  const box = JSON.parse(await evaluate(
    sessionId,
    `JSON.stringify(document.querySelector('[data-t3-rtl-repo-status] [data-kind="${kind}"]').getBoundingClientRect())`,
  ));
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point }, sessionId);
  return point;
}

async function checkTooltip(sessionId) {
  await hoverRow(sessionId, "issues");
  await waitFor(sessionId, `!!document.querySelector(".t3-rtl-repo-status-tip[data-shown]")`, "the tooltip");
  const state = JSON.parse(await evaluate(sessionId, TIP_STATE));
  const expected = {
    shown: true,
    topLayer: true,
    role: "dialog",
    describedBy: true,
    head: ["Issues", "3 open"],
    text: "תיקון כיוון בטבלאות",
    textDirection: "rtl",
    meta: "dana · just now",
    lead: "#7",
    label: ["bug", "#d73a4a"],
    more: "and 2 more",
    inWindow: true,
    leftOfRow: true,
  };
  if (JSON.stringify(state) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected tooltip: ${JSON.stringify(state)}`);
  }

  // Leaving the row closes it.
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
  await waitFor(sessionId, TIP_HIDDEN, "the tooltip to close when the pointer leaves");

  // The next row opens its own tooltip, and Escape closes it.
  await hoverRow(sessionId, "branches-local");
  await waitFor(
    sessionId,
    `document.querySelector(".t3-rtl-repo-status-tip[data-shown] .t3-rtl-tip-title")?.textContent === "Local branches"`,
    "the Local tooltip",
  );
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  await waitFor(sessionId, TIP_HIDDEN, "the tooltip to close on Escape");

  // A click closes it on a row that is not a button too.
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
  await waitFor(sessionId, TIP_HIDDEN, "the pointer to leave");
  const local = await hoverRow(sessionId, "branches-local");
  await waitFor(sessionId, `!!document.querySelector(".t3-rtl-repo-status-tip[data-shown]")`, "the Local tooltip again");
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: local.x, y: local.y, button: "left", clickCount: 1 }, sessionId);
  }
  await waitFor(sessionId, TIP_HIDDEN, "the tooltip to close on a click on Local");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
}

async function center(sessionId, selector) {
  const box = JSON.parse(await evaluate(
    sessionId,
    `JSON.stringify(document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect())`,
  ));
  return { box, x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function clickAt(sessionId, point) {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: point.x, y: point.y, button: "left", clickCount: 1 }, sessionId);
  }
}

async function pressKey(sessionId, key, code, keyCode, text) {
  await send("Input.dispatchKeyEvent", { type: "keyDown", key, code, windowsVirtualKeyCode: keyCode, ...(text ? { text } : {}) }, sessionId);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: keyCode }, sessionId);
}

async function openedAfter(sessionId, count, description) {
  for (let attempt = 0; attempt < 50 && opened.length < count; attempt += 1) await wait(100);
  await Promise.all(handled);
  if (opened.length < count) throw new Error(`Timed out waiting for ${description}`);
  return opened[count - 1];
}

const TIP_SHOWN = `!!document.querySelector(".t3-rtl-repo-status-tip[data-shown]")`;

// The pointer can move from a row into its tooltip and click an item or the
// line that counts the rest. The keyboard reaches the links with the Down
// arrow.
async function checkTooltipLinks(sessionId) {
  await hoverRow(sessionId, "issues");
  await waitFor(sessionId, TIP_SHOWN, "the Issues tooltip");
  const links = await evaluate(sessionId, `JSON.stringify([...document.querySelectorAll(".t3-rtl-repo-status-tip a[data-link]")]
    .map((link) => [link.className, link.dataset.link, link.getAttribute("href"), link.tabIndex]))`);
  const expectedLinks = JSON.stringify([
    ["t3-rtl-tip-item", "issues/7", "https://github.com/o/r/issues/7", -1],
    ["t3-rtl-tip-more", "issues", "https://github.com/o/r/issues", -1],
  ]);
  if (links !== expectedLinks) throw new Error(`Unexpected tooltip links: ${links}`);

  // On its way, the pointer crosses the gap between the row and the tooltip.
  const item = await center(sessionId, ".t3-rtl-repo-status-tip a.t3-rtl-tip-item");
  const tipBox = (await center(sessionId, ".t3-rtl-repo-status-tip")).box;
  const rowBox = (await center(sessionId, '[data-t3-rtl-repo-status] [data-kind="issues"]')).box;
  if (rowBox.left - tipBox.right < 4) throw new Error("The tooltip has no gap before its row");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: (tipBox.right + rowBox.left) / 2, y: item.y }, sessionId);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: item.x, y: item.y }, sessionId);
  await wait(500);
  if (!(await evaluate(sessionId, TIP_SHOWN))) throw new Error("The tooltip closed when the pointer moved into it");
  const before = opened.length;
  // A click keeps the focus where it was, such as in the composer.
  await evaluate(sessionId, `(() => {
    const field = document.createElement("textarea");
    field.id = "composer";
    document.body.appendChild(field);
    field.focus();
    return 1;
  })()`);
  await clickAt(sessionId, item);
  const url = await openedAfter(sessionId, before + 1, "the issue to open");
  if (url !== "https://github.com/o/r/issues/7") throw new Error(`Unexpected issue page: ${url}`);
  await waitFor(sessionId, TIP_HIDDEN, "the tooltip to close after a click on an item");
  if (!(await evaluate(sessionId, `document.activeElement?.id === "composer"`))) {
    throw new Error("A click on an item moved the focus");
  }
  await evaluate(sessionId, `document.getElementById("composer").remove(), 1`);

  // The line that counts the rest opens the whole list.
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
  await hoverRow(sessionId, "issues");
  await waitFor(sessionId, TIP_SHOWN, "the Issues tooltip again");
  const more = await center(sessionId, ".t3-rtl-repo-status-tip a.t3-rtl-tip-more");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: more.x, y: more.y }, sessionId);
  await clickAt(sessionId, more);
  const list = await openedAfter(sessionId, before + 2, "the issue list to open");
  if (list !== "https://github.com/o/r/issues") throw new Error(`Unexpected list page: ${list}`);
  await waitFor(sessionId, TIP_HIDDEN, "the tooltip to close after a click on the list line");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);

  // The Down arrow moves from the row to its first link, Enter opens it, and
  // the focus returns to the row.
  const row = `document.querySelector('[data-t3-rtl-repo-status] [data-kind="branches-remote"]')`;
  await evaluate(sessionId, `${row}.focus(), 1`);
  await pressKey(sessionId, "ArrowDown", "ArrowDown", 40);
  await waitFor(sessionId, `document.activeElement?.dataset?.link === "tree/feature/x"`, "the focus on the first branch link");
  await hoverRow(sessionId, "issues");
  await wait(500);
  if (!(await evaluate(sessionId, `document.activeElement?.dataset?.link === "tree/feature/x" && document.querySelector(".t3-rtl-repo-status-tip .t3-rtl-tip-title").textContent === "Remote branches"`))) {
    throw new Error("The pointer on another row took the tooltip from the keyboard");
  }
  await pressKey(sessionId, "Enter", "Enter", 13, "\r");
  const branch = await openedAfter(sessionId, before + 3, "the branch to open");
  if (branch !== "https://github.com/o/r/tree/feature/x") throw new Error(`Unexpected branch page: ${branch}`);
  await waitFor(sessionId, `${row} === document.activeElement && !document.querySelector(".t3-rtl-repo-status-tip[data-open]")`, "the focus to return to the row after Enter");

  // Escape leaves the links and closes the tooltip.
  await pressKey(sessionId, "ArrowDown", "ArrowDown", 40);
  await waitFor(sessionId, `!!document.activeElement?.dataset?.link`, "the focus on a link again");
  await pressKey(sessionId, "Escape", "Escape", 27);
  await waitFor(sessionId, `${row} === document.activeElement && !document.querySelector(".t3-rtl-repo-status-tip[data-open]")`, "the focus to return to the row on Escape");
  await evaluate(sessionId, `${row}.blur(), 1`);
  if (opened.length !== before + 3) throw new Error(`Unexpected extra pages: ${JSON.stringify(opened)}`);
}

// Newer counts can arrive while a tooltip is in use. A row still shown from
// the earlier counts opens links of its own repository, and a rebuilt
// section takes the focus from the tooltip's links back to the same row.
async function checkNewerCounts(sessionId) {
  const update = (repo, count) => `window.__t3RtlFixRepoStatusUpdate({
    path: location.href,
    repo: ${JSON.stringify(repo)},
    rows: [{ group: "branches", kind: "branches-remote", label: "Remote", count: ${JSON.stringify(count)}, detail: {
      title: "Remote branches",
      summary: ${JSON.stringify(count)} + " on GitHub",
      sections: [{ items: [{ text: "feature/x", link: "tree/feature/x" }], more: 0 }],
    } }],
  })`;
  await waitFor(sessionId, `!!document.querySelector('[data-t3-rtl-repo-status] [data-kind="branches-remote"]')`, "the Remote row");
  const repo = await evaluate(sessionId, `(() => {
    const row = document.querySelector('[data-t3-rtl-repo-status] [data-kind="branches-remote"]');
    if (document.querySelector(".t3-rtl-repo-status-tip[data-open]")) return "a tooltip was already open";
    // The new counts are received, and the row is replaced a frame later.
    ${update("x/y", "1")};
    row.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    return document.activeElement?.dataset?.repo;
  })()`);
  if (repo !== "o/r") throw new Error(`A row from the earlier counts linked to ${repo}`);
  // The rebuilt section returns the focus to its Remote row.
  await waitFor(
    sessionId,
    `document.activeElement?.dataset?.kind === "branches-remote" && document.activeElement.dataset.repo === "x/y" &&
      !document.querySelector(".t3-rtl-repo-status-tip[data-open]")`,
    "the focus to move to the rebuilt row",
  );
  // A refresh without that row moves the focus to the first row left.
  const pushed = await evaluate(sessionId, `(() => {
    document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const link = document.activeElement?.dataset?.link;
    window.__t3RtlFixRepoStatusUpdate({ path: location.href, repo: "x/y", rows: [
      { kind: "issues", label: "Issues", count: "1", detail: { title: "Issues", summary: "1 open", sections: [] } },
    ] });
    return link;
  })()`);
  if (pushed !== "tree/feature/x") throw new Error(`The focus did not reach the link: ${pushed}`);
  await waitFor(sessionId, `document.activeElement?.dataset?.kind === "issues"`, "the focus to move to the first row");
  await evaluate(sessionId, `document.activeElement.blur(), 1`);
}

// The tooltip state in a short window: every item is in it, and it scrolls
// inside the window. Scrolling to its end shows its last item.
const SCROLLED_TIP = `JSON.stringify((() => {
  const tip = document.querySelector(".t3-rtl-repo-status-tip");
  const box = tip.getBoundingClientRect();
  const scrolls = tip.scrollHeight > tip.clientHeight && getComputedStyle(tip).overflowY === "auto";
  tip.scrollTop = tip.scrollHeight;
  const items = tip.querySelectorAll(".t3-rtl-tip-item");
  const last = items[items.length - 1]?.getBoundingClientRect();
  return {
    title: tip.querySelector(".t3-rtl-tip-title").textContent,
    scrolls,
    inWindow: box.top >= 0 && box.bottom <= innerHeight,
    lastInView: !!last && last.bottom <= tip.getBoundingClientRect().bottom + 1,
    sections: [...tip.querySelectorAll(".t3-rtl-tip-section")].map((section) => [
      section.querySelector(".t3-rtl-tip-section-title")?.textContent || "",
      section.querySelectorAll(".t3-rtl-tip-item").length,
      section.querySelector(".t3-rtl-tip-more")?.textContent,
      section.querySelector(".t3-rtl-tip-more")?.tagName,
    ]),
  };
})())`;

// In a short window the tooltip keeps every item and scrolls, so each one
// stays in reach. The fixture folder has eight local branches.
async function checkShortWindow(sessionId) {
  await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 320, deviceScaleFactor: 1, mobile: false }, sessionId);
  // The resize closes any tooltip, so the hover waits for it.
  await wait(300);
  await hoverRow(sessionId, "branches-local");
  await waitFor(sessionId, `!!document.querySelector(".t3-rtl-repo-status-tip[data-shown]")`, "the Local tooltip in a short window");
  const state = JSON.parse(await evaluate(sessionId, SCROLLED_TIP));
  // Scrolling the tooltip keeps it open.
  await wait(200);
  state.openAfterScroll = await evaluate(sessionId, TIP_SHOWN);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
  await send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
  if (
    state.title !== "Local branches" || !state.scrolls || !state.inWindow || !state.lastInView ||
    !state.openAfterScroll || JSON.stringify(state.sections) !== JSON.stringify([["", 8, null, null]])
  ) {
    throw new Error(`Unexpected tooltip in a short window: ${JSON.stringify(state)}`);
  }

  // Three sources of alerts keep every alert, and every source its title.
  await send("Emulation.setDeviceMetricsOverride", { width: 900, height: 260, deviceScaleFactor: 1, mobile: false }, sessionId);
  await wait(300);
  await hoverRow(sessionId, "security");
  await waitFor(sessionId, `!!document.querySelector(".t3-rtl-repo-status-tip[data-shown]")`, "the security tooltip in a short window");
  const security = JSON.parse(await evaluate(sessionId, SCROLLED_TIP));
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
  await send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
  // Without room beside the row, the tooltip sits above or below it and
  // leaves the row clickable.
  await send("Emulation.setDeviceMetricsOverride", { width: 500, height: 260, deviceScaleFactor: 1, mobile: false }, sessionId);
  await wait(300);
  await hoverRow(sessionId, "security");
  await waitFor(sessionId, TIP_SHOWN, "the security tooltip in a narrow window");
  const narrow = JSON.parse(await evaluate(sessionId, `JSON.stringify((() => {
    const tip = document.querySelector(".t3-rtl-repo-status-tip").getBoundingClientRect();
    const row = document.querySelector('[data-t3-rtl-repo-status] [data-kind="security"]');
    const box = row.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const node = document.querySelector(".t3-rtl-repo-status-tip");
    return {
      reachable: node.scrollHeight <= node.clientHeight || getComputedStyle(node).overflowY === "auto",
      apart: tip.bottom <= box.top || tip.top >= box.bottom,
      rowClickable: row.contains(hit),
      inWindow: tip.top >= 0 && tip.bottom <= innerHeight,
    };
  })())`));
  // Scrolling the tooltip keeps it open.
  await evaluate(sessionId, `document.querySelector(".t3-rtl-repo-status-tip").scrollTop = 20, 1`);
  await wait(200);
  narrow.openAfterScroll = await evaluate(sessionId, TIP_SHOWN);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
  await send("Emulation.clearDeviceMetricsOverride", {}, sessionId);
  if (!narrow.apart || !narrow.rowClickable || !narrow.inWindow || !narrow.reachable || !narrow.openAfterScroll) {
    throw new Error(`The tooltip covers its row in a narrow window: ${JSON.stringify(narrow)}`);
  }
  // The Dependabot alerts are counts only, so their line links to the list.
  const expectedSections = [
    ["Dependabot · 2", 0, "and 2 more", "A"],
    ["Code scanning · 5", 5, null, null],
    ["Secret scanning · 5", 5, null, null],
  ];
  if (
    !security.scrolls || !security.inWindow || !security.lastInView ||
    JSON.stringify(security.sections) !== JSON.stringify(expectedSections)
  ) {
    throw new Error(`Unexpected security tooltip in a short window: ${JSON.stringify(security)}`);
  }
}

function cleanProfile() {
  const resolved = path.resolve(testProfile);
  const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (resolved.startsWith(tempRoot) && path.basename(resolved).startsWith("t3-rtl-repo-status-test-")) {
    try {
      fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
    } catch {
      // A browser that is still releasing its profile must not fail the test.
    }
  }
}

const timeout = setTimeout(() => {
  process.stderr.write("Repository status smoke test timed out\n");
  child?.kill();
  process.exitCode = 1;
}, 30000);

run().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(timeout);
  server.close();
  if (child) child.kill();
  else cleanProfile();
});
