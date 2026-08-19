"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { buildInjectionSource } = require("../src/injection");

const edgePath = path.join(
  process.env["ProgramFiles(x86)"] || "",
  "Microsoft",
  "Edge",
  "Application",
  "msedge.exe",
);
const css = fs.readFileSync(path.join(__dirname, "..", "src", "rtl.css"), "utf8");
const injectionSource = buildInjectionSource(css);
const rtlText = "\u05d4\u05d5\u05d3\u05e2\u05d4 \u05d1\u05e2\u05d1\u05e8\u05d9\u05ea";

if (process.platform !== "win32" || !fs.existsSync(edgePath)) {
  process.stdout.write("CDP pipe smoke test skipped: Microsoft Edge is unavailable\n");
  process.exit(0);
}

const testProfile = fs.mkdtempSync(path.join(os.tmpdir(), "t3-rtl-pipe-test-"));
const child = spawn(edgePath, [
  "--headless=new",
  "--no-first-run",
  `--user-data-dir=${testProfile}`,
  "--remote-debugging-pipe",
  "about:blank",
], { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });

const input = child.stdio[3];
const output = child.stdio[4];
const pending = new Map();
let nextId = 1;
let incoming = Buffer.alloc(0);

function send(method, params = {}, sessionId) {
  const id = nextId++;
  const message = { id, method, params };
  if (sessionId) message.sessionId = sessionId;
  input.write(`${JSON.stringify(message)}\0`);
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

output.on("data", (chunk) => {
  incoming = Buffer.concat([incoming, chunk]);
  while (true) {
    const separator = incoming.indexOf(0);
    if (separator === -1) break;
    const raw = incoming.subarray(0, separator).toString("utf8");
    incoming = incoming.subarray(separator + 1);
    if (!raw) continue;
    const message = JSON.parse(raw);
    if (!message.id || !pending.has(message.id)) continue;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result || {});
  }
});

async function run() {
  const { targetInfos } = await send("Target.getTargets");
  const page = targetInfos.find((target) => target.type === "page");
  if (!page) throw new Error("No page target was created");
  const { sessionId } = await send("Target.attachToTarget", {
    targetId: page.targetId,
    flatten: true,
  });
  const fixtureHtml = `
    <style>
      :root { --border: rgb(10, 20, 30); }
      .chat-markdown ul { --list-gutter: 20px; padding-left: 20px; }
      .chat-markdown li.task-list-item input { margin: 0 5px 2px -20px; }
      .chat-markdown blockquote { border-left: 2px solid var(--border); padding-left: 12px; }
      .chat-markdown div[role="note"] { border-left: 2px solid blue; padding-left: 12px; }
    </style>
    <div data-message-role="assistant">
      <div id="rtl-message" class="chat-markdown">
        <p id="rtl-paragraph">${rtlText}</p>
        <code id="inline-code">npm test</code>
        <p id="english-paragraph">An English paragraph.</p>
        <p id="english-leading-paragraph">pstack ${rtlText}</p>
        <p>${rtlText} <strong id="english-strong">Claude Code</strong> ${rtlText}</p>
        <ol><li id="english-leading-item"><strong>pstack</strong> ${rtlText} Cursor, ${rtlText} Claude Code.</li></ol>
        <a id="file-link" class="chat-markdown-file-link">src/index.ts</a>
        <ul id="rtl-list"><li class="task-list-item"><input id="task-checkbox" type="checkbox">${rtlText}</li></ul>
        <blockquote id="rtl-quote">${rtlText}</blockquote>
        <div id="rtl-alert" role="note">${rtlText}</div>
        <div id="table" class="chat-markdown-table-container">
          <table><tbody><tr><td id="english-cell">Name</td><td id="rtl-cell">${rtlText}</td></tr></tbody></table>
        </div>
      </div>
    </div>
    <div data-message-role="assistant">
      <div id="code-first-message" class="chat-markdown"><code>npm</code><p id="code-first-paragraph">${rtlText}</p></div>
    </div>
    <div data-message-role="user">
      <div id="english-message" class="chat-markdown"><p id="english-user-paragraph">English user message.</p></div>
    </div>
    <div data-message-role="user">
      <div id="rtl-user-message" class="chat-markdown"><p id="rtl-user-paragraph">${rtlText}</p></div>
    </div>
    <div data-message-role="assistant">
      <div class="chat-markdown"><p id="streamed-paragraph">pstack</p></div>
    </div>`;
  await send("Runtime.evaluate", {
    expression: `document.body.innerHTML = ${JSON.stringify(fixtureHtml)}`,
  }, sessionId);
  await send("Runtime.evaluate", { expression: injectionSource }, sessionId);
  const result = await send("Runtime.evaluate", {
    expression: `new Promise((resolve) => {
      const dynamicRow = document.createElement("div");
      dynamicRow.setAttribute("data-message-role", "assistant");
      dynamicRow.innerHTML = '<div id="dynamic-message" class="chat-markdown"><p id="dynamic-paragraph">${rtlText}</p><pre><code id="dynamic-code">const value = 1;</code></pre></div>';
      document.body.appendChild(dynamicRow);
      document.getElementById("streamed-paragraph").append(" ", ${JSON.stringify(rtlText)});
      setTimeout(() => {
        const style = (id) => getComputedStyle(document.getElementById(id));
        resolve({
          styleInjected: Boolean(document.getElementById("t3-rtl-fix")),
          rtlMessageDir: document.getElementById("rtl-message").dir,
          rtlMessageDirection: style("rtl-message").direction,
          rtlParagraphDir: document.getElementById("rtl-paragraph").dir,
          rtlParagraphDirection: style("rtl-paragraph").direction,
          englishParagraphDir: document.getElementById("english-paragraph").dir,
          englishParagraphDirection: style("english-paragraph").direction,
          englishLeadingParagraphDir: document.getElementById("english-leading-paragraph").dir,
          englishLeadingParagraphDirection: style("english-leading-paragraph").direction,
          englishStrongDir: document.getElementById("english-strong").dir,
          englishStrongDirection: style("english-strong").direction,
          englishLeadingItemDir: document.getElementById("english-leading-item").dir,
          englishLeadingItemDirection: style("english-leading-item").direction,
          englishMessageDir: document.getElementById("english-message").dir,
          englishMessageDirection: style("english-message").direction,
          rtlUserMessageDir: document.getElementById("rtl-user-message").dir,
          rtlUserMessageDirection: style("rtl-user-message").direction,
          rtlUserParagraphDir: document.getElementById("rtl-user-paragraph").dir,
          rtlUserParagraphDirection: style("rtl-user-paragraph").direction,
          codeFirstDirection: style("code-first-message").direction,
          codeFirstParagraphDirection: style("code-first-paragraph").direction,
          inlineCodeDir: document.getElementById("inline-code").dir,
          fileLinkDir: document.getElementById("file-link").dir,
          listPaddingLeft: style("rtl-list").paddingLeft,
          listPaddingRight: style("rtl-list").paddingRight,
          taskMarginInlineStart: style("task-checkbox").marginInlineStart,
          quoteBorderLeft: style("rtl-quote").borderLeftWidth,
          quoteBorderRight: style("rtl-quote").borderRightWidth,
          alertBorderLeft: style("rtl-alert").borderLeftWidth,
          alertBorderRight: style("rtl-alert").borderRightWidth,
          tableDir: document.getElementById("table").dir,
          englishCellDir: document.getElementById("english-cell").dir,
          rtlCellDir: document.getElementById("rtl-cell").dir,
          dynamicMessageDir: document.getElementById("dynamic-message").dir,
          dynamicMessageDirection: style("dynamic-message").direction,
          dynamicParagraphDirection: style("dynamic-paragraph").direction,
          dynamicCodeDir: document.getElementById("dynamic-code").dir,
          streamedParagraphDir: document.getElementById("streamed-paragraph").dir,
          streamedParagraphDirection: style("streamed-paragraph").direction,
        });
      }, 0);
    })`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  const actual = result.result?.value;
  const expected = {
    styleInjected: true,
    rtlMessageDir: "rtl",
    rtlMessageDirection: "rtl",
    rtlParagraphDir: "rtl",
    rtlParagraphDirection: "rtl",
    englishParagraphDir: "auto",
    englishParagraphDirection: "ltr",
    englishLeadingParagraphDir: "rtl",
    englishLeadingParagraphDirection: "rtl",
    englishStrongDir: "auto",
    englishStrongDirection: "ltr",
    englishLeadingItemDir: "rtl",
    englishLeadingItemDirection: "rtl",
    englishMessageDir: "auto",
    englishMessageDirection: "ltr",
    rtlUserMessageDir: "rtl",
    rtlUserMessageDirection: "rtl",
    rtlUserParagraphDir: "rtl",
    rtlUserParagraphDirection: "rtl",
    codeFirstDirection: "rtl",
    codeFirstParagraphDirection: "rtl",
    inlineCodeDir: "ltr",
    fileLinkDir: "ltr",
    listPaddingLeft: "0px",
    listPaddingRight: "20px",
    taskMarginInlineStart: "-20px",
    quoteBorderLeft: "0px",
    quoteBorderRight: "2px",
    alertBorderLeft: "0px",
    alertBorderRight: "2px",
    tableDir: "ltr",
    englishCellDir: "auto",
    rtlCellDir: "rtl",
    dynamicMessageDir: "rtl",
    dynamicMessageDirection: "rtl",
    dynamicParagraphDirection: "rtl",
    dynamicCodeDir: "ltr",
    streamedParagraphDir: "rtl",
    streamedParagraphDirection: "rtl",
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected injected layout: ${JSON.stringify(actual)}`);
  }
  process.stdout.write("CDP pipe direction injection passed\n");
}

const timeout = setTimeout(() => {
  process.stderr.write("CDP pipe injection timed out\n");
  child.kill();
  process.exitCode = 1;
}, 15000);

run().catch((error) => {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 1;
}).finally(() => {
  clearTimeout(timeout);
  child.kill();
});

child.on("exit", () => {
  const resolved = path.resolve(testProfile);
  const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  if (resolved.startsWith(tempRoot) && path.basename(resolved).startsWith("t3-rtl-pipe-test-")) {
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  }
});
