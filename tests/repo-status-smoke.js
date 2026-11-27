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
  <script>
    const card = document.querySelector("[data-thread-details-card]");
    window.__cardClosed = [];
    window.__cardEscapes = 0;
    window.__cardMenus = 0;
    card.addEventListener("keydown", (event) => {
      if (event.key === "Escape") window.__cardEscapes += 1;
    });
    card.addEventListener("contextmenu", () => {
      window.__cardMenus += 1;
    });
    card.addEventListener("focusout", (event) => {
      if (window.__watchCard && !(event.relatedTarget && card.contains(event.relatedTarget))) window.__cardClosed.push("focus-out");
    });
    document.addEventListener("pointerdown", (event) => {
      if (window.__watchCard && !card.contains(event.target)) window.__cardClosed.push("outside-press");
    }, true);
  </script>
  <script type="module" crossorigin src="/assets/index-test.js"></script>
</body></html>`;

// Like T3 Code, the entry script loads the store of the thread's panel at
// start. The store records the pull requests it opens and shows the panel,
// unless a test tells it to ignore the call or to keep the panel hidden.
// Without a saved settings file, T3 Code's desktop bridge answers null, which
// means the defaults.
const entryScript = `import { d } from "./rightPanelStore-test.js";
window.__panelStore = d;
window.desktopBridge = { getClientSettings: async () => null };
`;
const panelStoreScript = `let state;
const set = (patch) => {
  state = { ...state, ...patch };
};
state = {
  byThreadKey: {},
  openPullRequest(threadRef, surface) {
    window.__panelCalls.push({ threadRef, surface });
    if (window.__panelIgnores) return;
    const id = ["pull-request", surface.projectId, surface.host, surface.repository, surface.number].join(":");
    const key = threadRef.environmentId + ":" + threadRef.threadId;
    const panel = state.byThreadKey[key] || { surfaces: [] };
    set({ byThreadKey: {
      ...state.byThreadKey,
      [key]: { isOpen: true, surfaces: [...panel.surfaces.filter((item) => item.id !== id), { id, kind: "pull-request", ...surface }], activeSurfaceId: id },
    } });
    if (window.__panelHidden || document.querySelector("[data-right-panel-surface-content]")) return;
    const content = document.createElement("div");
    content.setAttribute("data-right-panel-surface-content", "");
    document.body.appendChild(content);
  },
};
window.__panelCalls = [];
// T3 Code's issue action, which a test adds to the store. Without it, the
// store is that of a T3 Code that cannot open an issue in its panel.
window.__openIssue = (threadRef, surface) => {
  window.__panelCalls.push({ threadRef, surface });
  if (window.__panelIgnores) return;
  const id = ["issue", surface.projectId, surface.tracker, surface.host, surface.scope, surface.key].join(":");
  const key = threadRef.environmentId + ":" + threadRef.threadId;
  const panel = state.byThreadKey[key] || { surfaces: [] };
  set({ byThreadKey: {
    ...state.byThreadKey,
    [key]: { isOpen: true, surfaces: [...panel.surfaces.filter((item) => item.id !== id), { id, kind: "issue", ...surface }], activeSurfaceId: id },
  } });
  if (window.__panelHidden || document.querySelector("[data-right-panel-surface-content]")) return;
  const content = document.createElement("div");
  content.setAttribute("data-right-panel-surface-content", "");
  document.body.appendChild(content);
};
// Another store of the same chunk, without the pull request action.
export const a = { getState: () => ({ remember() {} }) };
export const d = {
  getState: () => state,
  setState: (update) => set(typeof update === "function" ? update(state) : update),
};
`;

const server = http.createServer((request, response) => {
  const scripts = { "/assets/index-test.js": entryScript, "/assets/rightPanelStore-test.js": panelStoreScript };
  if (Object.hasOwn(scripts, request.url)) {
    response.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
    response.end(scripts[request.url]);
    return;
  }
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
const drags = [];

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
    if (message.method === "Input.dragIntercepted") {
      drags.push(message.params.data);
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
                author: { login: "dana", avatarUrl: "https://avatars.githubusercontent.com/u/9?v=4" },
                labels: { nodes: [{ name: "bug", color: "d73a4a" }] },
              }],
            },
            pullRequests: {
              totalCount: 1,
              nodes: [{ number: 12, title: "Fix the table direction", updatedAt: recent, isDraft: false, headRefName: "fix/table", baseRefName: "main", author: { login: "dana" } }],
            },
            vulnerabilityAlerts: { totalCount: 2 },
            defaultBranchRef: { name: "main" },
            refs: { totalCount: 2, nodes: [branch("main"), branch("feature/x")] },
          },
        },
      }),
      stderr: "",
    };
  }
  // Seven code scanning alerts and five secrets, so the security tooltip is
  // tall. Only the code scanning alerts have numbers, so only their list
  // opens on GitHub.
  const codeScanning = args[3].includes("code-scanning");
  const alerts = Array.from({ length: codeScanning ? 7 : 5 }, (_, i) => (codeScanning
    ? { number: i + 1, rule: { security_severity_level: ["high", "low"][i % 2], description: `Rule ${i}` }, most_recent_instance: { location: { path: `src/${i}.js` } } }
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
    findThreadFolder: (threadId) => (threadId === threadWithRepo ? { folders: ["C:\\repo"], projectId: "p-1" } : null),
    findProjectFolder: (projectId) => (projectId === "p1" ? { folders: ["C:\\repo"], projectId: "p1" } : null),
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
      ["BUTTON", "security", "Security alerts14", 0, false],
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
  await checkPullRequestInApp(sessionId);
  await checkIssueInApp(sessionId);
  await checkDrag(sessionId);
  await checkPlainItemClick(sessionId);
  await checkCardStaysOpen(sessionId);
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

  await checkDraft(sessionId);
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
  const item = tip.querySelector(".t3-rtl-tip-item[data-row]");
  const text = item.querySelector(".t3-rtl-row-title");
  const label = item.querySelector(".t3-rtl-tip-badge[data-label]");
  const state = item.querySelector(".t3-rtl-row-state");
  const stateBox = state.getBoundingClientRect();
  return {
    shown: tip.hasAttribute("data-shown"),
    topLayer: tip.matches(":popover-open"),
    role: tip.getAttribute("role"),
    describedBy: row.getAttribute("aria-describedby") === tip.id,
    head: [tip.querySelector(".t3-rtl-tip-title").textContent, tip.querySelector(".t3-rtl-tip-summary").textContent],
    text: text.textContent,
    textDirection: getComputedStyle(text).direction,
    lead: item.querySelector(".t3-rtl-row-number").textContent,
    state: [state.getAttribute("class"), state.children.length, Math.round(stateBox.width), Math.round(stateBox.height)],
    author: item.querySelector(".t3-rtl-row-author").textContent,
    avatar: item.querySelector(".t3-rtl-row-avatar")?.getAttribute("src") ?? null,
    provider: Math.round(item.querySelector(".t3-rtl-row-provider[aria-label='GitHub']").getBoundingClientRect().width),
    repo: item.querySelector(".t3-rtl-row-repo").textContent,
    time: item.querySelector(".t3-rtl-row-time").textContent,
    rowLayout: [getComputedStyle(item).display, getComputedStyle(item).alignItems],
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
    lead: "#7",
    state: ["t3-rtl-row-state lucide text-emerald-600 dark:text-emerald-300/90", 2, 16, 16],
    author: "dana",
    avatar: "https://avatars.githubusercontent.com/u/9?v=4",
    provider: 12,
    repo: "o/r",
    time: "just now",
    rowLayout: ["flex", "center"],
    label: ["bug", "#d73a4a"],
    more: "and 2 more",
    inWindow: true,
    leftOfRow: true,
  };
  if (JSON.stringify(state) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected tooltip: ${JSON.stringify(state)}`);
  }

  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
  await waitFor(sessionId, TIP_HIDDEN, "the tooltip to close when the pointer leaves");

  await hoverRow(sessionId, "branches-local");
  await waitFor(
    sessionId,
    `document.querySelector(".t3-rtl-repo-status-tip[data-shown] .t3-rtl-tip-title")?.textContent === "Local branches"`,
    "the Local tooltip",
  );
  await send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 }, sessionId);
  await waitFor(sessionId, TIP_HIDDEN, "the tooltip to close on Escape");

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
  // The panel's store has no issue action yet, so the issue opens on GitHub.
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

// Clicks the first pull request in the Pull requests tooltip.
async function clickPullRequest(sessionId, modifiers = 0) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
  // After a reload, no tooltip was made yet.
  await waitFor(sessionId, `!document.querySelector(".t3-rtl-repo-status-tip[data-open]")`, "the tooltip to close before a pull request click");
  await hoverRow(sessionId, "pulls");
  await waitFor(
    sessionId,
    `document.querySelector(".t3-rtl-repo-status-tip[data-shown] a.t3-rtl-tip-item")?.dataset.link === "pull/12"`,
    "the Pull requests tooltip",
  );
  const item = await center(sessionId, ".t3-rtl-repo-status-tip a.t3-rtl-tip-item");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: item.x, y: item.y }, sessionId);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: item.x, y: item.y, button: "left", clickCount: 1, modifiers }, sessionId);
  }
  await waitFor(sessionId, TIP_HIDDEN, "the tooltip to close after a pull request click");
}

const PANEL_CALLS = "JSON.stringify(window.__panelCalls)";

// A pull request opens in T3 Code's panel, as a pull request link in a
// message does. Ctrl, the setting turned off or unreadable, a store that does
// not take it, or a panel that does not show leaves it to GitHub.
async function checkPullRequestInApp(sessionId) {
  // Without the list of loaded files, the page finds the store through the
  // entry script.
  await evaluate(sessionId, `(performance.clearResourceTimings(), window.__panelCalls = [], 1)`);
  const before = opened.length;
  await clickPullRequest(sessionId);
  await waitFor(sessionId, `window.__panelCalls.length === 1 && !!document.querySelector("[data-right-panel-surface-content]")`, "the pull request to open in the panel");
  // The same fields as T3 Code's own pull request link.
  const expectedCall = JSON.stringify([{
    threadRef: { environmentId, threadId: threadWithRepo },
    surface: { projectId: "p-1", host: "github.com", repository: "o/r", number: 12, url: "https://github.com/o/r/pull/12" },
  }]);
  const calls = await evaluate(sessionId, PANEL_CALLS);
  if (calls !== expectedCall) throw new Error(`Unexpected panel calls: ${calls}`);
  await wait(300);
  await Promise.all(handled);
  if (opened.length !== before) throw new Error(`A pull request opened in the panel also opened ${JSON.stringify(opened.slice(before))}`);

  // Ctrl opens GitHub.
  await clickPullRequest(sessionId, 2);
  const withCtrl = await openedAfter(sessionId, before + 1, "the pull request to open on GitHub with Ctrl");
  if (withCtrl !== "https://github.com/o/r/pull/12") throw new Error(`Unexpected pull request page: ${withCtrl}`);

  // T3 Code's setting turned off opens GitHub, and so does a missing bridge.
  await evaluate(sessionId, `(window.desktopBridge = { getClientSettings: async () => ({ pullRequestLinksOpenInApp: false }) }, 1)`);
  await clickPullRequest(sessionId);
  await openedAfter(sessionId, before + 2, "the pull request to open on GitHub with the setting off");
  await evaluate(sessionId, `(delete window.desktopBridge, 1)`);
  await clickPullRequest(sessionId);
  await openedAfter(sessionId, before + 3, "the pull request to open on GitHub without the desktop bridge");
  await evaluate(sessionId, `(window.desktopBridge = { getClientSettings: async () => ({}) }, 1)`);

  // A store that does not take the pull request opens GitHub, even while
  // another repository's pull request with the same number is active.
  const key = `${environmentId}:${threadWithRepo}`;
  await evaluate(sessionId, `(window.__panelStore.setState({ byThreadKey: { ${JSON.stringify(key)}: {
    isOpen: true,
    activeSurfaceId: "other",
    surfaces: [{ id: "other", kind: "pull-request", projectId: "p-1", host: "github.com", repository: "x/y", number: 12 }],
  } } }), window.__panelIgnores = true, 1)`);
  await clickPullRequest(sessionId);
  await openedAfter(sessionId, before + 4, "the pull request to open on GitHub when the store ignores it");
  await evaluate(sessionId, `(window.__panelIgnores = false, window.__panelStore.setState({ byThreadKey: {} }), 1)`);

  // A panel that does not show opens GitHub, and the panel forgets the pull
  // request, so it does not show later as well. A second click while the
  // first one waits does the same.
  await evaluate(sessionId, `(document.querySelector("[data-right-panel-surface-content]").remove(), window.__panelHidden = true, 1)`);
  await clickPullRequest(sessionId);
  await clickPullRequest(sessionId);
  await openedAfter(sessionId, before + 6, "both pull request clicks to open on GitHub when the panel does not show");
  if (!(await evaluate(sessionId, `!Object.hasOwn(window.__panelStore.getState().byThreadKey, ${JSON.stringify(key)})`))) {
    throw new Error("A pull request that did not show stayed in the panel");
  }
  await evaluate(sessionId, `(window.__panelHidden = false, 1)`);

  // A move to another thread while the settings are read opens nothing,
  // neither in the thread left behind nor on GitHub.
  await evaluate(sessionId, `(window.desktopBridge = { getClientSettings: () => new Promise((resolve) => {
    history.pushState({}, "", "/${environmentId}/${threadWithoutRepo}");
    setTimeout(() => resolve({}), 200);
  }) }, 1)`);
  await clickPullRequest(sessionId);
  await wait(600);
  if (await evaluate(sessionId, "window.__panelCalls.length") !== 4) throw new Error("A pull request opened in the thread left behind");
  await evaluate(sessionId, `(window.desktopBridge = { getClientSettings: async () => ({}) }, history.pushState({}, "", "/${environmentId}/${threadWithRepo}"), 1)`);
  await waitFor(sessionId, `!!document.querySelector("[data-t3-rtl-repo-status]")`, "the section after returning to the thread");
  await wait(300);
  await Promise.all(handled);

  const count = await evaluate(sessionId, "window.__panelCalls.length");
  if (count !== 4) throw new Error(`Unexpected number of panel calls: ${count}`);
  if (JSON.stringify(opened.slice(before)) !== JSON.stringify(Array(6).fill("https://github.com/o/r/pull/12"))) {
    throw new Error(`Unexpected pull request pages: ${JSON.stringify(opened.slice(before))}`);
  }

  // Turning the section off after the panel took the pull request, while it
  // waits to show, takes the pull request back and opens nothing, not even
  // on GitHub, and removes the section. Turning it on shows it again.
  const callsBefore = await evaluate(sessionId, "window.__panelCalls.length");
  await evaluate(sessionId, `(window.__panelHidden = true, 1)`);
  await clickPullRequest(sessionId);
  await waitFor(sessionId, `window.__panelCalls.length > ${callsBefore}`, "the panel to take the pull request");
  await evaluate(sessionId, `(window.__t3RtlFixRepoStatusEnabled(false), 1)`);
  // While it is off, the page reads nothing, not even T3 Code's drafts.
  await evaluate(sessionId, `(() => {
    window.__draftReads = 0;
    window.__getItem = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      window.__draftReads += 1;
      return window.__getItem.call(this, key);
    };
    return 1;
  })()`);
  await wait(1500);
  const draftReads = await evaluate(sessionId, "(Storage.prototype.getItem = window.__getItem, window.__draftReads)");
  if (draftReads !== 0) throw new Error(`The page read the drafts ${draftReads} times while the section was off`);
  await waitFor(sessionId, `!document.querySelector("[data-t3-rtl-repo-status]")`, "the section to leave when it is turned off");
  await waitFor(
    sessionId,
    `!Object.hasOwn(window.__panelStore.getState().byThreadKey, ${JSON.stringify(key)})`,
    "the panel to forget the pull request when the section is turned off",
  );
  await wait(2600);
  await Promise.all(handled);
  if (opened.length !== before + 6) throw new Error(`A pull request opened after the section was turned off: ${JSON.stringify(opened.slice(before + 6))}`);
  await evaluate(sessionId, `(window.__panelHidden = false, window.__t3RtlFixRepoStatusEnabled(true), 1)`);
  await waitFor(sessionId, `!!document.querySelector("[data-t3-rtl-repo-status]")`, "the section when it is turned on again");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
}

// Clicks the first issue in the Issues tooltip.
async function clickIssue(sessionId, modifiers = 0) {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
  await waitFor(sessionId, `!document.querySelector(".t3-rtl-repo-status-tip[data-open]")`, "the tooltip to close before an issue click");
  await hoverRow(sessionId, "issues");
  await waitFor(
    sessionId,
    `document.querySelector(".t3-rtl-repo-status-tip[data-shown] a.t3-rtl-tip-item")?.dataset.link === "issues/7"`,
    "the Issues tooltip",
  );
  const item = await center(sessionId, ".t3-rtl-repo-status-tip a.t3-rtl-tip-item");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: item.x, y: item.y }, sessionId);
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send("Input.dispatchMouseEvent", { type, x: item.x, y: item.y, button: "left", clickCount: 1, modifiers }, sessionId);
  }
  await waitFor(sessionId, TIP_HIDDEN, "the tooltip to close after an issue click");
}

// An issue opens in T3 Code's panel, as an issue link in a message does.
// T3 Code's pull request setting does not apply to it. Ctrl, a store that
// does not take it, or a panel that does not show leaves it to GitHub.
async function checkIssueInApp(sessionId) {
  const key = `${environmentId}:${threadWithRepo}`;
  await evaluate(sessionId, `(() => {
    document.querySelector("[data-right-panel-surface-content]")?.remove();
    window.__panelCalls = [];
    window.__panelStore.setState({ byThreadKey: {}, openIssue: window.__openIssue });
    window.desktopBridge = { getClientSettings: async () => ({ pullRequestLinksOpenInApp: false }) };
    return 1;
  })()`);
  const before = opened.length;
  await clickIssue(sessionId);
  await waitFor(sessionId, `window.__panelCalls.length === 1 && !!document.querySelector("[data-right-panel-surface-content]")`, "the issue to open in the panel");
  // The same fields as T3 Code's own GitHub issue link.
  const expectedCall = JSON.stringify([{
    threadRef: { environmentId, threadId: threadWithRepo },
    surface: { projectId: "p-1", tracker: "github", host: "github.com", scope: "o/r", key: "7", url: "https://github.com/o/r/issues/7" },
  }]);
  const calls = await evaluate(sessionId, PANEL_CALLS);
  if (calls !== expectedCall) throw new Error(`Unexpected panel calls: ${calls}`);
  await wait(300);
  await Promise.all(handled);
  if (opened.length !== before) throw new Error(`An issue opened in the panel also opened ${JSON.stringify(opened.slice(before))}`);

  // Ctrl opens GitHub.
  await clickIssue(sessionId, 2);
  const withCtrl = await openedAfter(sessionId, before + 1, "the issue to open on GitHub with Ctrl");
  if (withCtrl !== "https://github.com/o/r/issues/7") throw new Error(`Unexpected issue page: ${withCtrl}`);

  // A store that does not take the issue opens GitHub, even while another
  // repository's issue with the same number is active.
  await evaluate(sessionId, `(window.__panelStore.setState({ byThreadKey: { ${JSON.stringify(key)}: {
    isOpen: true,
    activeSurfaceId: "other",
    surfaces: [{ id: "other", kind: "issue", projectId: "p-1", tracker: "github", host: "github.com", scope: "x/y", key: "7" }],
  } } }), window.__panelIgnores = true, 1)`);
  await clickIssue(sessionId);
  await openedAfter(sessionId, before + 2, "the issue to open on GitHub when the store ignores it");
  await evaluate(sessionId, `(window.__panelIgnores = false, window.__panelStore.setState({ byThreadKey: {} }), 1)`);

  // A panel that does not show opens GitHub, and the panel forgets the issue.
  await evaluate(sessionId, `(document.querySelector("[data-right-panel-surface-content]").remove(), window.__panelHidden = true, 1)`);
  await clickIssue(sessionId);
  await openedAfter(sessionId, before + 3, "the issue to open on GitHub when the panel does not show");
  if (!(await evaluate(sessionId, `!Object.hasOwn(window.__panelStore.getState().byThreadKey, ${JSON.stringify(key)})`))) {
    throw new Error("An issue that did not show stayed in the panel");
  }

  await wait(300);
  await Promise.all(handled);
  const count = await evaluate(sessionId, "window.__panelCalls.length");
  if (count !== 3) throw new Error(`Unexpected number of panel calls: ${count}`);
  if (JSON.stringify(opened.slice(before)) !== JSON.stringify(Array(3).fill("https://github.com/o/r/issues/7"))) {
    throw new Error(`Unexpected issue pages: ${JSON.stringify(opened.slice(before))}`);
  }
  await evaluate(sessionId, `(() => {
    window.__panelHidden = false;
    window.__panelStore.setState({ byThreadKey: {}, openIssue: undefined });
    window.desktopBridge = { getClientSettings: async () => ({}) };
    return 1;
  })()`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
}

// An item dragged from the tooltip into the composer quotes it as plain
// text, and the focus and the tooltip end as after a click.
async function checkDrag(sessionId) {
  await evaluate(sessionId, `(() => {
    const field = document.createElement("textarea");
    field.id = "composer";
    field.style.cssText = "position: fixed; left: 10px; bottom: 10px; width: 300px; height: 80px;";
    document.body.appendChild(field);
    field.focus();
    return 1;
  })()`);
  const target = await center(sessionId, "#composer");
  await send("Input.setInterceptDrags", { enabled: true }, sessionId);
  try {
    // A pull request also carries T3 Code's pull request reference, in the
    // format T3 Code's composer reads.
    const pullReference = JSON.stringify({
      number: 12,
      title: "Fix the table direction",
      url: "https://github.com/o/r/pull/12",
      headBranch: "fix/table",
      baseBranch: "main",
      state: "open",
      isDraft: false,
    });
    for (const [kind, selector, quote, reference] of [
      ["issues", ".t3-rtl-repo-status-tip a.t3-rtl-tip-item", "#7 תיקון כיוון בטבלאות https://github.com/o/r/issues/7"],
      ["pulls", ".t3-rtl-repo-status-tip a.t3-rtl-tip-item", "#12 Fix the table direction https://github.com/o/r/pull/12", pullReference],
      // A branch without a page on GitHub is quoted by its name.
      ["branches-local", ".t3-rtl-repo-status-tip .t3-rtl-tip-item:not(a)", "spike"],
    ]) {
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
      await waitFor(sessionId, TIP_HIDDEN, "the tooltip to close before a drag");
      await hoverRow(sessionId, kind);
      await waitFor(sessionId, TIP_SHOWN, `the ${kind} tooltip`);
      const item = await center(sessionId, selector);
      await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: item.x, y: item.y }, sessionId);
      await wait(300);
      const before = drags.length;
      await send("Input.dispatchMouseEvent", { type: "mousePressed", x: item.x, y: item.y, button: "left", clickCount: 1 }, sessionId);
      // The pointer leaves the tooltip on its way to the composer.
      for (const step of [0.1, 0.4, 0.7, 1]) {
        await send("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: item.x + (target.x - item.x) * step,
          y: item.y + (target.y - item.y) * step,
          button: "left",
          buttons: 1,
        }, sessionId);
      }
      for (let attempt = 0; attempt < 30 && drags.length === before; attempt += 1) await wait(100);
      const data = drags[before];
      if (!data) throw new Error(`No drag started from the ${kind} tooltip`);
      const types = data.items.map((entry) => entry.mimeType);
      const expectedTypes = reference ? ["text/plain", "application/x-t3code-pull-request"] : ["text/plain"];
      // T3 Code's composer takes a pull request reference as a move, so that
      // drag allows a copy and a move (1 | 16); a quote allows a copy.
      const expectedMask = reference ? 17 : 1;
      if (data.dragOperationsMask !== expectedMask) throw new Error(`Unexpected drag operations for ${kind}: ${data.dragOperationsMask}`);
      if (JSON.stringify(types) !== JSON.stringify(expectedTypes) || data.items[0].data !== quote || (reference && data.items[1].data !== reference)) {
        throw new Error(`Unexpected drag data: ${JSON.stringify(data)}`);
      }
      // The tooltip stays open while the pointer is outside it.
      await wait(400);
      if (!(await evaluate(sessionId, TIP_SHOWN))) throw new Error("The tooltip closed during a drag");
      await evaluate(sessionId, `(() => { const field = document.getElementById("composer"); field.value = ""; field.setSelectionRange(0, 0); return 1; })()`);
      for (const type of ["dragEnter", "dragOver", "drop"]) {
        await send("Input.dispatchDragEvent", { type, x: target.x, y: target.y, data }, sessionId);
      }
      await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 }, sessionId);
      await waitFor(sessionId, `document.getElementById("composer").value === ${JSON.stringify(quote)}`, `the ${kind} quote in the composer`);
      await waitFor(sessionId, TIP_HIDDEN, "the tooltip to close after the drop");
      await waitFor(sessionId, `document.activeElement?.id === "composer"`, "the focus in the composer after the drop");
    }
    // Newer counts rebuild the section during a drag, and the drag is then
    // cancelled. The focus returns to the composer, and the tooltip closes
    // and still opens and closes later.
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
    await hoverRow(sessionId, "issues");
    await waitFor(sessionId, TIP_SHOWN, "the Issues tooltip before a cancelled drag");
    const item = await center(sessionId, ".t3-rtl-repo-status-tip a.t3-rtl-tip-item");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: item.x, y: item.y }, sessionId);
    await wait(300);
    const before = drags.length;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: item.x, y: item.y, button: "left", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y, button: "left", buttons: 1 }, sessionId);
    for (let attempt = 0; attempt < 30 && drags.length === before; attempt += 1) await wait(100);
    if (!drags[before]) throw new Error("No drag started before the refresh");
    await evaluate(sessionId, `window.__t3RtlFixRepoStatusUpdate({ path: location.href, project: null, repo: "o/r", rows: [
      { kind: "issues", label: "Issues", count: "4", detail: { title: "Issues", summary: "4 open", sections: [] } },
    ] }), 1`);
    await wait(300);
    await send("Input.dispatchDragEvent", { type: "dragCancel", x: target.x, y: target.y, data: drags[before] }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: target.x, y: target.y, button: "left", clickCount: 1 }, sessionId);
    await waitFor(sessionId, `document.activeElement?.id === "composer"`, "the focus in the composer after a cancelled drag");
    await waitFor(sessionId, TIP_HIDDEN, "the tooltip to close after a cancelled drag");
    await hoverRow(sessionId, "issues");
    await waitFor(sessionId, TIP_SHOWN, "the tooltip of the rebuilt row");
    await pressKey(sessionId, "Escape", "Escape", 27);
    await waitFor(sessionId, TIP_HIDDEN, "Escape to close the tooltip after a cancelled drag");
  } finally {
    await send("Input.setInterceptDrags", { enabled: false }, sessionId);
  }
  // The real counts come back.
  await evaluate(sessionId, `window.__t3RtlFixRepoStatusCheck("navigate"), 1`);
  await waitFor(sessionId, `!!document.querySelector('[data-t3-rtl-repo-status] [data-kind="branches-local"]')`, "the real rows after the drag");
  await evaluate(sessionId, `document.getElementById("composer").remove(), 1`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
}

// A click on an item without a link keeps the focus on the row that had it,
// and its tooltip open.
async function checkPlainItemClick(sessionId) {
  const row = `document.querySelector('[data-t3-rtl-repo-status] [data-kind="branches-local"]')`;
  await evaluate(sessionId, `${row}.focus(), 1`);
  await pressKey(sessionId, "ArrowDown", "ArrowDown", 40);
  await waitFor(sessionId, TIP_SHOWN, "the Local tooltip from the keyboard");
  const item = await center(sessionId, ".t3-rtl-repo-status-tip .t3-rtl-tip-item:not(a)");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: item.x, y: item.y }, sessionId);
  await clickAt(sessionId, item);
  await wait(300);
  const state = await evaluate(sessionId, `JSON.stringify([${row} === document.activeElement, ${TIP_SHOWN}])`);
  if (state !== "[true,true]") throw new Error(`A click on a plain item moved the focus or closed the tooltip: ${state}`);
  // The arrow keys reach every item, links or not, and End the last one.
  await evaluate(sessionId, `${row}.focus(), 1`);
  await pressKey(sessionId, "ArrowDown", "ArrowDown", 40);
  await waitFor(sessionId, `document.activeElement?.dataset?.quote === "spike"`, "the focus on the first plain item");
  await pressKey(sessionId, "End", "End", 35);
  await waitFor(sessionId, `document.activeElement?.dataset?.quote === "spike-7"`, "the focus on the last plain item");
  await pressKey(sessionId, "Escape", "Escape", 27);
  await waitFor(sessionId, `${row} === document.activeElement`, "the focus back on the row from a plain item");
  await evaluate(sessionId, `${row}.blur(), 1`);
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
  await waitFor(sessionId, TIP_HIDDEN, "the tooltip to close after the plain item");
  // With no focus before it, a click on a plain item keeps the tooltip open.
  await evaluate(sessionId, "document.activeElement?.blur(), 1");
  await hoverRow(sessionId, "branches-local");
  await waitFor(sessionId, TIP_SHOWN, "the Local tooltip by pointer");
  const plain = await center(sessionId, ".t3-rtl-repo-status-tip .t3-rtl-tip-item:not(a)");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: plain.x, y: plain.y }, sessionId);
  await clickAt(sessionId, plain);
  await wait(400);
  if (!(await evaluate(sessionId, TIP_SHOWN))) throw new Error("A click on a plain item with no focus closed the tooltip");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
  await waitFor(sessionId, TIP_HIDDEN, "the tooltip to close when the pointer leaves the plain item");
  await evaluate(sessionId, "document.activeElement?.blur(), 1");
}

// T3 Code's card closes on focus that leaves it or a press outside it, when
// it is a popover. A click on an item and the start of a drag happen inside
// it, so it stays open.
async function checkCardStaysOpen(sessionId) {
  const row = `document.querySelector('[data-t3-rtl-repo-status] [data-kind="issues"]')`;
  await evaluate(sessionId, `(window.__cardClosed = [], window.__watchCard = true, ${row}.focus(), 1)`);
  try {
    await hoverRow(sessionId, "branches-remote");
    await waitFor(sessionId, `document.querySelector(".t3-rtl-repo-status-tip[data-shown] .t3-rtl-tip-title")?.textContent === "Remote branches"`, "the Remote tooltip");
    const before = opened.length;
    const item = await center(sessionId, ".t3-rtl-repo-status-tip a.t3-rtl-tip-item");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: item.x, y: item.y }, sessionId);
    await clickAt(sessionId, item);
    await openedAfter(sessionId, before + 1, "the branch to open from the card");
    await waitFor(sessionId, `${row} === document.activeElement`, "the focus back on the row");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
    await hoverRow(sessionId, "branches-remote");
    await waitFor(sessionId, TIP_SHOWN, "the Remote tooltip again");
    const again = await center(sessionId, ".t3-rtl-repo-status-tip a.t3-rtl-tip-item");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: again.x, y: again.y }, sessionId);
    await send("Input.setInterceptDrags", { enabled: true }, sessionId);
    const start = drags.length;
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: again.x, y: again.y, button: "left", clickCount: 1 }, sessionId);
    await wait(300);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 20, y: 300, button: "left", buttons: 1 }, sessionId);
    for (let attempt = 0; attempt < 30 && drags.length === start; attempt += 1) await wait(100);
    if (!drags[start]) throw new Error("No drag started from the card");
    const closed = await evaluate(sessionId, "JSON.stringify(window.__cardClosed)");
    await send("Input.dispatchDragEvent", { type: "dragCancel", x: 20, y: 300, data: drags[start] }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 20, y: 300, button: "left", clickCount: 1 }, sessionId);
    await send("Input.setInterceptDrags", { enabled: false }, sessionId);
    if (closed !== "[]") throw new Error(`The card would close: ${closed}`);
    await waitFor(sessionId, TIP_HIDDEN, "the tooltip to close after the cancelled drag");
    // With the focus on the row, the first Escape closes only the tooltip,
    // and the next one reaches the card.
    await evaluate(sessionId, `(window.__cardEscapes = 0, window.__cardMenus = 0, ${row}.focus(), 1)`);
    await hoverRow(sessionId, "branches-local");
    await waitFor(sessionId, TIP_SHOWN, "the Local tooltip with the focus on a row");
    const plain = await center(sessionId, ".t3-rtl-repo-status-tip .t3-rtl-tip-item:not(a)");
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: plain.x, y: plain.y }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mousePressed", x: plain.x, y: plain.y, button: "right", clickCount: 1 }, sessionId);
    await send("Input.dispatchMouseEvent", { type: "mouseReleased", x: plain.x, y: plain.y, button: "right", clickCount: 1 }, sessionId);
    await wait(200);
    await evaluate(sessionId, `${row}.focus(), 1`);
    await pressKey(sessionId, "Escape", "Escape", 27);
    await waitFor(sessionId, TIP_HIDDEN, "Escape to close the tooltip");
    await pressKey(sessionId, "Escape", "Escape", 27);
    const reached = await evaluate(sessionId, "JSON.stringify([window.__cardEscapes, window.__cardMenus])");
    if (reached !== "[1,0]") throw new Error(`Escape or the menu reached the card: ${reached}`);
  } finally {
    await evaluate(sessionId, `(window.__watchCard = false, document.activeElement?.blur(), 1)`);
    await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
  }
}

// A new thread has a draft route until its first message. Its project comes
// from T3 Code's drafts in local storage, and changes there show at once.
async function checkDraft(sessionId) {
  const drafts = (projectId) => `localStorage.setItem("t3code:composer-drafts:v1", ${JSON.stringify(JSON.stringify({
    state: { draftsByThreadKey: {}, draftThreadsByThreadKey: { d1: { environmentId, threadId: "t-new", projectId } } },
    version: 1,
  }))})`;
  // From a thread without a section, so the section shown is the draft's.
  await evaluate(sessionId, `history.pushState({}, "", "/${environmentId}/${threadWithoutRepo}"), 1`);
  await waitFor(sessionId, `!document.querySelector("[data-t3-rtl-repo-status]")`, "the section to hide before the draft");
  await evaluate(sessionId, `(${drafts("p1")}, history.pushState({}, "", "/draft/d1"), 1)`);
  await waitFor(
    sessionId,
    `document.querySelector("[data-t3-rtl-repo-status] .t3-rtl-repo-status-head")?.textContent === "o/r" && location.pathname === "/draft/d1"`,
    "the section of a new thread",
  );
  // A pull request opens in the panel of the new thread, named by its draft.
  await evaluate(sessionId, `(window.__panelCalls = [], 1)`);
  const openedBefore = opened.length;
  await clickPullRequest(sessionId);
  await waitFor(sessionId, "window.__panelCalls.length === 1", "the pull request to open in the new thread's panel");
  const draftCall = await evaluate(sessionId, "JSON.stringify(window.__panelCalls[0])");
  const expectedDraftCall = JSON.stringify({
    threadRef: { environmentId, threadId: "t-new" },
    surface: { projectId: "p1", host: "github.com", repository: "o/r", number: 12, url: "https://github.com/o/r/pull/12" },
  });
  if (draftCall !== expectedDraftCall) throw new Error(`Unexpected panel call for a new thread: ${draftCall}`);
  await wait(300);
  await Promise.all(handled);
  if (opened.length !== openedBefore) throw new Error("A pull request of a new thread also opened on GitHub");
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 }, sessionId);
  // A check for another project can answer just before the project comes
  // back. The page then asks again for its own project.
  const otherRows = `window.__t3RtlFixRepoStatusUpdate({ path: location.href, project: "p2", repo: "x/y", rows: [
    { kind: "issues", label: "Issues", count: "1", detail: { title: "Issues", summary: "1 open", sections: [] } },
  ] })`;
  const watchOther = (onSeen) => `window.__sawOther = false;
    const seen = new MutationObserver(() => {
      if (document.querySelector("[data-t3-rtl-repo-status] .t3-rtl-repo-status-head")?.textContent === "x/y") {
        window.__sawOther = true;
        seen.disconnect();
        ${onSeen}
      }
    });
    seen.observe(document.body, { childList: true, subtree: true, characterData: true });
    setTimeout(() => seen.disconnect(), 1500);`;
  // Rows that arrive for the project just left are not drawn.
  await evaluate(sessionId, `(() => {
    ${watchOther("")}
    ${drafts("p2")};
    ${otherRows};
    ${drafts("p1")};
    return 1;
  })()`);
  await wait(1200);
  if (await evaluate(sessionId, "window.__sawOther")) throw new Error("Rows of the project just left were drawn");
  let shownOther = false;
  for (let attempt = 0; attempt < 5 && !shownOther; attempt += 1) {
    // The project goes back as soon as the other rows are drawn, before the
    // page samples it again.
    await evaluate(sessionId, `(() => {
      ${watchOther(drafts("p1") + ";")}
      ${drafts("p2")};
      ${otherRows};
      return 1;
    })()`);
    await wait(300);
    shownOther = await evaluate(sessionId, "window.__sawOther");
    if (!shownOther) {
      await waitFor(sessionId, `document.querySelector("[data-t3-rtl-repo-status] .t3-rtl-repo-status-head")?.textContent === "o/r"`, "the draft's rows before a retry");
    }
  }
  if (!shownOther) throw new Error("The rows of the other project never showed");
  await waitFor(
    sessionId,
    `document.querySelector("[data-t3-rtl-repo-status] .t3-rtl-repo-status-head")?.textContent === "o/r"`,
    "the rows of the draft's own project",
  );
  // Another project without a repository hides it.
  await evaluate(sessionId, `(${drafts("p2")}, 1)`);
  await waitFor(sessionId, `!document.querySelector("[data-t3-rtl-repo-status]")`, "the section to hide for another project");
  // Drafts in another shape show nothing, and break nothing.
  await evaluate(sessionId, `(localStorage.setItem("t3code:composer-drafts:v1", "{not json"), 1)`);
  await wait(1500);
  if (await evaluate(sessionId, `!!document.querySelector("[data-t3-rtl-repo-status]")`)) {
    throw new Error("Unreadable drafts showed a section");
  }
  await evaluate(sessionId, `(${drafts("p1")}, 1)`);
  await waitFor(sessionId, `!!document.querySelector("[data-t3-rtl-repo-status]")`, "the section to return for the project");
  await evaluate(sessionId, `(localStorage.removeItem("t3code:composer-drafts:v1"), history.pushState({}, "", "/${environmentId}/${threadWithRepo}"), 1)`);
  await waitFor(sessionId, `!!document.querySelector("[data-t3-rtl-repo-status]") && !location.pathname.startsWith("/draft")`, "the thread's section");
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
  // The code scanning alerts are all shown, and a line opens them on GitHub.
  const expectedSections = [
    ["Dependabot · 2", 0, "and 2 more", "A"],
    ["Code scanning · 7", 7, "View all 7 on GitHub", "A"],
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
}, 45000);

run().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(timeout);
  server.close();
  if (child) child.kill();
  else cleanProfile();
});
