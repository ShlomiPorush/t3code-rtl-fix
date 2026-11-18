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
const fixture = `<!doctype html><html><head><title>fixture</title></head><body>
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

const fakeRun = async (file, args) => {
  if (file === "git") return { error: null, stdout: "git@github.com:o/r.git\n", stderr: "" };
  if (args[3] === "graphql") {
    return {
      error: null,
      stdout: JSON.stringify({
        data: {
          repository: {
            issues: { totalCount: 3 },
            pullRequests: { totalCount: 1 },
            vulnerabilityAlerts: { totalCount: 2 },
          },
        },
      }),
      stderr: "",
    };
  }
  return { error: null, stdout: "[]", stderr: "" };
};

const STATE = `JSON.stringify((() => {
  const section = document.querySelector("[data-t3-rtl-repo-status]");
  if (!section) return null;
  return {
    inContent: section.parentElement.id === "content",
    last: section === section.parentElement.lastElementChild,
    sections: document.querySelectorAll("[data-t3-rtl-repo-status]").length,
    repo: section.querySelector(".t3-rtl-repo-status-head").textContent,
    rows: [...section.querySelectorAll("button")].map((button) => [
      button.dataset.kind,
      button.textContent,
      button.title,
    ]),
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
    rows: [
      ["issues", "Issues3", "Open issues on GitHub"],
      ["pulls", "Pull requests1", "Open pull requests on GitHub"],
      ["security", "Security alerts2", "Dependabot: 2"],
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
  process.stdout.write("Repository status section passed\n");
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
