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
      :root { --border: rgb(10, 20, 30); --contrast-border: rgb(10, 20, 30); }
      .chat-markdown ul { --list-gutter: 20px; padding-left: 20px; }
      .chat-markdown li.task-list-item input { margin: 0 5px 2px -20px; }
      .chat-markdown blockquote { border-left: 2px solid var(--border); padding-left: 12px; }
      .chat-markdown div[role="note"] { border-left: 2px solid blue; padding-left: 12px; }
      #table { width: 280px; }
      #table-scroll { width: 100%; overflow-x: auto; }
      .chat-markdown table { width: 100%; min-width: max-content; border-collapse: collapse; }
      .chat-markdown th, .chat-markdown td { padding: 8px 12px; text-align: start; }
      .chat-markdown-table-container[data-expanded="false"] th,
      .chat-markdown-table-container[data-expanded="false"] td { white-space: nowrap; }
      .chat-markdown-table-container[data-expanded="true"] td { overflow-wrap: anywhere; }
      .text-left { text-align: left; }
      .justify-end { justify-content: flex-end; }
      .chip-button { margin-left: 3px; }
      #citation-comment-editor, #english-citation-comment-editor { width: 280px; }
      [data-citation-comment-editor] textarea { width: 100%; }
      [data-queued-message-id] > div { width: 300px; }
      [data-composer-banner-row] {
        display: grid;
        grid-template-columns: 28px minmax(0, 1fr) auto;
        align-items: center;
        width: 300px;
        padding: 0;
        border: 0;
      }
      .composer-tiptap { width: 320px; white-space: pre-wrap; }
      .composer-tiptap p { margin: 0; }
      .composer-tiptap ul, .composer-tiptap ol { margin: 0; }
      .composer-tiptap ul { --list-gutter: 1.25rem; padding-left: 1.25rem; }
      .composer-tiptap ol { --list-gutter: 1.25rem; padding-left: var(--list-gutter, 1.25rem); }
      .composer-tiptap blockquote { margin: 0; border-left: 2px solid var(--contrast-border); padding-left: 0.8rem; }
      .composer-tiptap ul[data-type=taskList] { margin: 0; padding: 0; list-style: none; }
      .composer-tiptap li[data-checked] { display: flex; gap: 0.5rem; margin: 0; padding: 0; }
      .composer-tiptap li[data-checked] > div { flex: auto; min-width: 0; }
      [data-node-view-wrapper] { display: inline-flex; }
      .flex { display: flex; }
      .flex-1 { flex: 1 1 0%; }
      .flex-col { flex-direction: column; }
      .shrink-0 { flex-shrink: 0; }
      .radio { width: 16px; height: 16px; }
      .rotate-90 { rotate: 90deg; }
      .items-start { align-items: flex-start; }
      .border-l-2 { border-left: 2px solid gray; }
      .pl-3 { padding-left: 12px; }
      .gap-3 { gap: 12px; }
      .ml-auto { margin-left: auto; }
      .w-full { width: 300px; }
      .icon { width: 16px; height: 16px; }
    </style>
    <div data-message-role="assistant">
      <div id="rtl-message" class="chat-markdown">
        <p id="rtl-paragraph">${rtlText}</p>
        <p id="rtl-image-paragraph"><span class="inline-block"><img id="rtl-image" alt="" width="40" height="20"></span></p>
        <code id="inline-code">npm test</code>
        <p id="english-paragraph">An English paragraph.</p>
        <p id="english-leading-paragraph">pstack ${rtlText}</p>
        <p>${rtlText} <strong id="english-strong">Claude Code</strong> ${rtlText}</p>
        <ol><li id="english-leading-item"><strong>pstack</strong> ${rtlText} Cursor, ${rtlText} Claude Code.</li></ol>
        <a id="file-link" class="chat-markdown-file-link">src/index.ts</a>
        <ul id="rtl-list"><li class="task-list-item"><input id="task-checkbox" type="checkbox">${rtlText}</li></ul>
        <blockquote id="rtl-quote">${rtlText}</blockquote>
        <div id="rtl-alert" role="note">${rtlText}</div>
        <div id="table" class="chat-markdown-table-container" data-expanded="false">
          <div id="table-scroll">
            <table id="table-element">
              <thead><tr><th>Number</th><th>${rtlText}</th><th>Details</th></tr></thead>
              <tbody><tr><td id="english-cell">Name</td><td id="rtl-cell">${rtlText}</td><td>long-unbroken-table-content-that-needs-wrapping</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
    <div data-message-role="assistant">
      <div id="code-first-message" class="chat-markdown"><code>npm</code><p id="code-first-paragraph">${rtlText}</p></div>
    </div>
    <div data-message-role="user">
      <div id="english-message" class="chat-markdown"><p id="english-user-paragraph">English user message.</p><p id="english-image-paragraph"><span class="inline-block"><img id="english-image" alt="" width="40" height="20"></span></p></div>
    </div>
    <div data-message-role="user">
      <div id="rtl-user-message" class="chat-markdown"><p id="rtl-user-paragraph">${rtlText}</p></div>
    </div>
    <div data-message-role="assistant">
      <div class="chat-markdown"><p id="streamed-paragraph">pstack</p></div>
    </div>
    <div data-pull-request-summary-scroll>
      <section data-pull-request-summary-section>
        <div id="pull-request-markdown" class="chat-markdown">
          <h2 id="pull-request-heading">${rtlText}</h2>
          <p id="pull-request-paragraph">session-transfer ${rtlText}</p>
          <p id="pull-request-english-paragraph">English pull request text.</p>
          <ul><li id="pull-request-list-item"><code>npm test</code> ${rtlText}</li></ul>
        </div>
      </section>
    </div>
    <div data-preview-panel-mode="panel">
      <button aria-label="Show markdown source"></button>
      <div id="file-markdown" class="chat-markdown">
        <h2 id="file-markdown-heading">${rtlText}</h2>
        <p id="file-markdown-paragraph">Docker ${rtlText}</p>
        <p id="file-markdown-english-paragraph">English file documentation.</p>
        <div id="file-markdown-table" class="chat-markdown-table-container">
          <table><tbody><tr><td id="file-markdown-rtl-cell">${rtlText}</td></tr></tbody></table>
        </div>
        <pre><code id="file-markdown-code">npm test</code></pre>
      </div>
    </div>
    <div id="pending-card" data-slot="collapsible">
      <button
        id="pending-toggle"
        class="text-start"
        data-slot="collapsible-trigger"
        data-composer-banner-row="true"
        data-pending-user-input-toggle="expanded"
      ><span id="pending-icon" data-slot="composer-banner-icon"><svg class="icon"></svg></span><span data-slot="composer-banner-content"><span>${rtlText}</span></span><span id="pending-actions" class="flex" data-slot="composer-banner-actions"><span>3/3</span><svg class="icon"></svg></span></button>
      <div data-slot="collapsible-panel">
        <p id="pending-question">${rtlText} GitHub?</p>
        <button id="pending-option" class="flex w-full gap-3 text-left">
          <span id="pending-radio" class="flex shrink-0"><span class="radio"></span></span>
          <div id="pending-option-content" class="flex flex-1 flex-col">
            <span>${rtlText} Docker</span>
            <span>PR 1 ${rtlText}</span>
          </div>
          <span class="flex shrink-0"><kbd id="pending-shortcut">1</kbd></span>
        </button>
        <button id="pending-english-option" class="flex w-full gap-3 text-left">
          <span id="pending-english-radio" class="flex shrink-0"><span class="radio"></span></span>
          <div id="pending-english-option-content" class="flex flex-1 flex-col">
            <span>Use the local fix</span>
          </div>
          <span class="flex shrink-0"><kbd id="pending-english-shortcut">2</kbd></span>
        </button>
      </div>
    </div>
    <div id="plan-card">
      <div class="flex">
        <div class="flex flex-1"><span>Plan</span><h3 id="plan-title">${rtlText} RTL FIX</h3></div>
        <button aria-label="Plan actions">...</button>
      </div>
      <div>
        <div id="plan-markdown" class="chat-markdown" dir="auto">
          <h2 id="plan-heading">${rtlText}</h2>
          <p id="plan-paragraph">${rtlText} <code>RTL FIX</code> ${rtlText}</p>
          <ul><li id="plan-list-item"><code>dir=rtl</code> ${rtlText}</li></ul>
        </div>
      </div>
    </div>
    <div id="english-plan-card">
      <div class="flex">
        <div class="flex flex-1"><span>Plan</span><h3 id="english-plan-title">English plan</h3></div>
        <button aria-label="Plan actions">...</button>
      </div>
      <div>
        <div id="english-plan-markdown" class="chat-markdown" dir="auto">
          <h2 id="english-plan-heading">Summary</h2>
          <p id="english-plan-paragraph">Keep the English layout unchanged.</p>
        </div>
      </div>
    </div>
    <div id="rtl-turn-plan" class="min-w-0 px-1 py-0.5">
      <button id="rtl-turn-plan-toggle" class="flex w-full text-left" aria-expanded="false">
        <svg id="rtl-turn-plan-chevron" class="icon"></svg>
        <span aria-hidden class="flex"><span></span><span></span></span>
        <span id="rtl-turn-plan-label" class="min-w-0 truncate">${rtlText}</span>
        <span id="rtl-turn-plan-count" class="shrink-0 tabular-nums">0/3</span>
      </button>
      <div class="mt-0.5 space-y-px pl-6">
        <div id="rtl-turn-plan-step" class="flex items-baseline"><span>○</span><span>${rtlText}</span></div>
      </div>
    </div>
    <div id="rtl-expanded-turn-plan" class="min-w-0 px-1 py-0.5">
      <button class="flex w-full text-left" aria-expanded="true">
        <svg id="rtl-expanded-turn-plan-chevron" class="icon"></svg>
        <span id="rtl-expanded-turn-plan-label" class="min-w-0 truncate">${rtlText}</span>
        <span class="shrink-0 tabular-nums">1/3</span>
      </button>
    </div>
    <div id="english-turn-plan" class="min-w-0 px-1 py-0.5">
      <button id="english-turn-plan-toggle" class="flex w-full text-left" aria-expanded="false">
        <svg id="english-turn-plan-chevron" class="icon"></svg>
        <span aria-hidden class="flex"><span></span><span></span></span>
        <span id="english-turn-plan-label" class="min-w-0 truncate">Implement the plan</span>
        <span class="shrink-0 tabular-nums">1/3</span>
      </button>
    </div>
    <div id="rtl-composer-tasks" class="chat-composer-tasks-tab flex" data-composer-tasks-badge="true">
      <button id="rtl-composer-tasks-toggle" class="flex min-w-0 flex-1 text-left" aria-expanded="false" aria-label="Tasks: 0 of 3 complete">
        <svg class="icon"></svg><span>Tasks</span>
        <span id="rtl-composer-task-current" class="min-w-0 flex-1 truncate text-left" data-composer-task-current="true">${rtlText}</span>
        <span class="tabular-nums">0/3</span><span aria-hidden class="flex"></span>
      </button>
      <button aria-label="Dismiss tasks for this turn"><svg class="icon"></svg></button>
    </div>
    <div id="english-composer-tasks" class="chat-composer-tasks-tab flex" data-composer-tasks-badge="true">
      <button id="english-composer-tasks-toggle" class="flex min-w-0 flex-1 text-left" aria-expanded="false" aria-label="Tasks: 1 of 3 complete">
        <svg class="icon"></svg><span>Tasks</span>
        <span id="english-composer-task-current" class="min-w-0 flex-1 truncate text-left" data-composer-task-current="true">Implement the plan</span>
        <span class="tabular-nums">1/3</span><span aria-hidden class="flex"></span>
      </button>
      <button aria-label="Dismiss tasks for this turn"><svg class="icon"></svg></button>
    </div>
    <div id="citation-comment-editor" data-citation-comment-editor="true">
      <textarea id="citation-comment-input" aria-label="Comment on selected text" placeholder="Add an optional comment..."></textarea>
      <p id="citation-comment-status" role="status">Comments can contain up to 4,000 characters.</p>
      <div id="citation-comment-actions" class="flex items-center justify-end gap-3">
        <button id="citation-comment-cancel">Cancel</button>
        <button id="citation-comment-save">Save</button>
      </div>
    </div>
    <div id="english-citation-comment-editor" data-citation-comment-editor="true">
      <textarea id="english-citation-comment-input" aria-label="Comment on selected text"></textarea>
      <div id="english-citation-comment-actions" class="flex items-center justify-end gap-3">
        <button id="english-citation-comment-cancel">Cancel</button>
        <button id="english-citation-comment-save">Save</button>
      </div>
    </div>
    <span id="rtl-citation-chip" class="flex" data-assistant-citation-chip="true">
      <a id="rtl-citation-chip-link"><svg class="icon"></svg><span id="rtl-citation-chip-label">${rtlText}</span></a>
      <button id="rtl-citation-chip-edit" class="chip-button" aria-label="Edit citation comment"><svg class="icon"></svg></button>
    </span>
    <span id="english-citation-chip" class="flex" data-assistant-citation-chip="true">
      <a id="english-citation-chip-link"><svg class="icon"></svg><span id="english-citation-chip-label">Cite this line</span></a>
      <button id="english-citation-chip-edit" class="chip-button" aria-label="Edit citation comment"><svg class="icon"></svg></button>
    </span>
    <div data-timeline-row-kind="queued-message">
      <div class="flex" data-queued-message-id="rtl-queued">
        <div id="rtl-queued-card">
          <div id="rtl-queued-prompt" class="chat-markdown"><p id="rtl-queued-paragraph">${rtlText}?</p><p id="rtl-queued-english-paragraph">Run this first.</p><pre><code id="rtl-queued-code">npm test</code></pre></div>
          <div id="rtl-queued-details"><span id="rtl-queued-details-text">2 attachments, 1 context item</span></div>
          <div id="rtl-queued-footer" class="flex" data-scroll-anchor-ignore="true">
            <span id="rtl-queued-status" class="flex"><svg class="icon"></svg>Queued</span>
            <div id="rtl-queued-actions" class="ml-auto flex"><button aria-label="Send now"></button><button aria-label="Cancel and return to the composer"></button></div>
          </div>
        </div>
      </div>
    </div>
    <div data-timeline-row-kind="queued-message">
      <div class="flex" data-queued-message-id="english-queued">
        <div id="english-queued-card">
          <div id="english-queued-prompt" class="chat-markdown"><p>Open your browser and I will connect to it.</p></div>
          <div id="english-queued-footer" class="flex" data-scroll-anchor-ignore="true">
            <span id="english-queued-status" class="flex"><svg class="icon"></svg>Queued</span>
            <div id="english-queued-actions" class="ml-auto flex"><button aria-label="Send now"></button><button aria-label="Cancel and return to the composer"></button></div>
          </div>
        </div>
      </div>
    </div>
    <div role="region" aria-label="2 queued messages" data-chat-composer-collapsed-controls="true">
      <button id="queue-header" data-composer-banner-row="true" aria-label="Collapse queued messages" aria-expanded="true"><span data-slot="composer-banner-content">Queued</span></button>
      <ol>
        <li id="rtl-queue-row" data-composer-banner-row="true"><span data-slot="composer-banner-icon"><button aria-label="Reorder queued message (drag, or press the arrow keys)"></button></span><span data-slot="composer-banner-content"><span id="rtl-queue-prompt" class="min-w-0 flex-1 truncate">${rtlText} RTL</span></span><span id="rtl-queue-actions" data-slot="composer-banner-actions"><button aria-label="Edit queued message"></button></span></li>
        <li data-composer-banner-row="true"><span data-slot="composer-banner-content"><span id="english-queue-prompt" class="min-w-0 flex-1 truncate">Run the tests first</span></span></li>
      </ol>
    </div>
    <section data-thread-queue="true" aria-label="Up next: 2 queued messages" style="display: flex; flex-direction: column; width: 400px">
      <ol style="display: flex; flex-direction: column; align-items: flex-end">
        <li style="display: flex; flex-direction: column; align-items: flex-end; width: 100%">
          <div style="width: 160px"><p id="thread-queue-rtl-prompt" class="whitespace-pre-wrap wrap-anywhere">${rtlText} - ${rtlText} ${rtlText} ${rtlText}</p></div>
          <div id="thread-queue-rtl-actions" class="flex"><button aria-label="Edit queued message"></button><button>Steer</button><button aria-label="Remove queued message"></button></div>
        </li>
        <li style="display: flex; flex-direction: column; align-items: flex-end; width: 100%">
          <div style="width: 160px"><p id="thread-queue-english-prompt" class="whitespace-pre-wrap wrap-anywhere">Run the tests first and then open the pull request</p></div>
        </li>
      </ol>
    </section>
    <div id="composer-editor" class="composer-tiptap" contenteditable="true">
      <p id="composer-chip-rtl-paragraph"><span class="react-renderer"><span id="composer-chip" data-node-view-wrapper="">image.png 48 KB</span></span> ${rtlText}.</p>
      <p id="composer-chip-english-paragraph"><span class="react-renderer"><span id="composer-english-chip" data-node-view-wrapper="">image.png</span></span> Please check this.</p>
      <p id="composer-quote-chip-paragraph"><span class="react-renderer"><span id="composer-quote-chip" data-node-view-wrapper="">${rtlText}</span></span></p>
      <p id="composer-file-chip-paragraph"><span class="react-renderer"><span data-node-view-wrapper="">notes.md</span></span></p>
      <p id="composer-multiline-paragraph">${rtlText}<br><span id="composer-english-line">English line here.</span></p>
      <p id="composer-english-leading-paragraph">Authentik ${rtlText}</p>
      <p id="composer-mostly-english-paragraph">Please review ${rtlText}</p>
      <p id="composer-typed-paragraph"></p>
    </div>
    <div id="rich-composer-editor" class="composer-tiptap" contenteditable="true" data-composer-rich-text="true">
      <h2 id="composer-heading">${rtlText}</h2>
      <ol id="composer-rtl-list"><li id="composer-rtl-item"><p>${rtlText}</p></li><li id="composer-empty-item"><p></p></li><li id="composer-english-item-in-rtl-list"><p>Run npm test</p></li></ol>
      <ol id="composer-english-list"><li id="composer-english-item"><p>Open the queue</p></li><li id="composer-rtl-item-in-english-list"><p>${rtlText}</p></li></ol>
      <ul id="composer-task-list" data-type="taskList"><li id="composer-task-item" data-checked="false"><label id="composer-task-checkbox"><input type="checkbox"></label><div><p>${rtlText}</p></div></li></ul>
      <blockquote id="composer-quote"><p>${rtlText}</p><p id="composer-quote-english-paragraph">English line.</p></blockquote>
      <div id="composer-code-block" class="react-renderer node-codeBlock" data-node-view-wrapper=""><pre><code>${rtlText} npm test</code></pre></div>
    </div>
    <div id="second-composer-editor" class="composer-tiptap" contenteditable="true">
      <p id="second-composer-paragraph">${rtlText}</p>
    </div>
    <ul>
      <li data-thread-item="true">
        <div role="button"><span>agent-config</span></div>
        <div class="mt-1 flex min-w-0"><span id="rtl-thread-title" aria-hidden="true" class="min-w-0 flex-1 text-sm truncate">${rtlText} PR ${rtlText}</span></div>
      </li>
      <li data-thread-item="true">
        <div class="mt-1 flex min-w-0"><span id="english-thread-title" aria-hidden="true" class="min-w-0 flex-1 text-sm truncate">Fix DNS Lookup Failure Reporting</span></div>
      </li>
      <li data-thread-item="true">
        <div class="mt-1 flex min-w-0"><input id="thread-title-input" aria-label="Thread title" value=""></div>
      </li>
    </ul>
    <div data-thread-item="true" data-slot="sidebar-menu-sub-button"><span id="sub-thread-title" data-testid="thread-title-1" class="min-w-0 flex-1 truncate text-sm">${rtlText} PR</span></div>
    <ul aria-label="Related threads" style="width: 240px">
      <li class="group relative flex h-8 items-center"><div class="flex w-full items-center"><button type="button" class="relative inline-flex items-center" style="display: flex; width: 100%"><span class="min-w-0 flex-1" style="flex: 1"><span id="related-thread-title" class="block truncate text-left text-sm font-medium" style="display: block; text-align: left">${rtlText}</span></span></button></div></li>
      <li class="group relative flex h-8 items-center"><div class="flex w-full items-center"><button type="button" class="relative inline-flex items-center"><span class="min-w-0 flex-1"><span id="english-related-thread-title" class="block truncate text-left text-sm font-medium">Fix the installer</span></span></button></div></li>
    </ul>
    <div role="listbox" data-slot="command-list">
      <div data-slot="tooltip-positioner"><div id="rtl-tooltip" data-slot="tooltip-popup" style="width: 200px"><div data-slot="tooltip-viewport"><span id="rtl-tooltip-text">${rtlText} v3</span></div></div></div>
      <div data-slot="tooltip-positioner"><div id="english-tooltip" data-slot="tooltip-popup" style="width: 200px"><div data-slot="tooltip-viewport">Read ${rtlText}.md</div></div></div>
      <nav aria-label="Thread breadcrumb"><ol class="flex">
        <li><button type="button" aria-label="Open parent thread: ${rtlText} v3"><span id="parent-breadcrumb-title" data-slot="workspace-breadcrumb-text" aria-hidden="true">${rtlText} v3</span></button></li>
        <li aria-hidden="true"><span id="breadcrumb-separator" data-slot="workspace-breadcrumb-text">/</span></li>
        <li aria-current="page"><h2 aria-label="Inventory behaviors"><span id="current-breadcrumb-title" data-slot="workspace-breadcrumb-text">Inventory behaviors</span></h2></li>
      </ol></nav>
      <div role="option" data-slot="command-item" data-composer-item-id="thread:env:1"><span class="flex min-w-0 flex-1 items-center"><span id="mention-thread-title" class="min-w-0 max-w-[45%] shrink-0 truncate">${rtlText} RTL</span></span></div>
    </div>
    <div data-slot="toast-popup" data-type="success">
      <div class="flex min-w-0 gap-2"><div id="toast-title" class="min-w-0 wrap-break-word font-medium" data-slot="toast-title">Thread completed</div></div>
      <div id="toast-description" class="min-w-0 select-text wrap-break-word" data-slot="toast-description">${rtlText} T3</div>
    </div>
    <div id="thread-header" class="group/thread-title flex"><h2 id="thread-header-title" class="min-w-0"><span>${rtlText} V2</span></h2><svg data-thread-title-chevron="true" class="icon"></svg></div>
    <div id="work-log-row" class="group/timeline-row relative w-full min-w-0 text-left" role="button" aria-expanded="true" style="width: 400px">
      <div class="flex min-w-0 gap-1.5 items-center">
        <div class="flex min-w-0 flex-1 items-baseline gap-1.5"><span id="work-log-icon" class="relative shrink-0"><svg class="icon"></svg></span><div class="min-w-0 flex-1 truncate"><div class="min-w-0 flex-1 overflow-hidden"><p id="work-log-summary" class="flex min-w-0 w-full items-baseline gap-3"><span id="work-log-question-summary" class="min-w-0 truncate">${rtlText} PR?</span><span id="work-log-answer-summary" class="min-w-0 truncate">${rtlText} 3 PRs</span></p></div></div></div>
        <span>12:00</span>
        <span id="work-log-chevron" class="flex shrink-0"><svg id="work-log-chevron-icon" class="icon rotate-90"></svg></span>
      </div>
      <div class="ms-7 mt-2 space-y-2"><div class="space-y-1">
        <p id="work-log-question" class="whitespace-pre-wrap text-sm">${rtlText} PR?</p>
        <p id="work-log-answer" class="ms-3 whitespace-pre-wrap text-sm">3 PRs ${rtlText} (Recommended)</p>
      </div></div>
    </div>
    <div id="closed-work-log-row" class="group/timeline-row relative w-full min-w-0 text-left" role="button" aria-expanded="false" style="width: 400px">
      <div class="flex min-w-0 gap-1.5 items-center">
        <div class="flex min-w-0 flex-1 items-baseline gap-1.5"><span id="closed-work-log-icon" class="relative shrink-0"><svg class="icon"></svg></span><div class="min-w-0 flex-1 truncate"><div class="min-w-0 flex-1 overflow-hidden"><p id="closed-work-log-summary" class="flex min-w-0 w-full items-baseline gap-3"><span id="closed-work-log-question-summary" class="min-w-0 truncate">${rtlText}?</span><span id="closed-work-log-answer-summary" class="min-w-0 truncate">${rtlText}</span></p></div></div></div>
        <span>12:00</span>
        <span id="closed-work-log-chevron" class="flex shrink-0"><svg id="closed-work-log-chevron-icon" class="icon"></svg></span>
      </div>
    </div>
    <div id="english-work-log-row" class="group/timeline-row relative w-full min-w-0 text-left" role="button" aria-expanded="false" style="width: 400px">
      <div class="flex min-w-0 gap-1.5 items-center">
        <div class="flex min-w-0 flex-1 items-baseline gap-1.5"><span id="english-work-log-icon" class="relative shrink-0"><svg class="icon"></svg></span><div class="min-w-0 flex-1 truncate"><div class="min-w-0 flex-1 overflow-hidden"><p id="english-work-log-summary" class="flex min-w-0 w-full items-baseline gap-3"><span id="english-work-log-question-summary" class="min-w-0 truncate">Which plan?</span><span id="english-work-log-answer-summary" class="min-w-0 truncate">${rtlText}</span></p></div></div></div>
        <span>12:00</span>
        <span id="english-work-log-chevron" class="flex shrink-0"><svg id="english-work-log-chevron-icon" class="icon"></svg></span>
      </div>
    </div>
    <div class="group/timeline-row relative flex flex-col">
      <div class="flex items-center">
        <div class="min-w-0 flex-1 overflow-hidden"><p class="flex min-w-0 w-full items-baseline"><span id="work-log-command" class="min-w-0 truncate">git commit -m "${rtlText}"</span></p></div>
      </div>
    </div>
    <button type="button" class="group/live-work flex w-full text-left">
      <div class="group/timeline-row relative w-full min-w-0 text-left"><div class="flex min-w-0 flex-1 items-baseline">
        <div class="min-w-0 flex-1"><span id="live-thought" class="line-clamp-4">${rtlText}: Codex ${rtlText}</span></div>
      </div></div>
    </button>
    <button type="button" class="group/live-work flex w-full text-left">
      <div class="group/timeline-row relative w-full min-w-0 text-left"><div class="flex min-w-0 flex-1 items-baseline">
        <div class="min-w-0 flex-1"><span id="english-live-thought" class="line-clamp-4">Checking "${rtlText}" in the queue</span></div>
      </div></div>
    </button>
    <div data-v2-item-type="reasoning" role="button" aria-expanded="true" class="group/timeline-row relative w-full text-left">
      <div class="chat-markdown">
        <p id="reasoning-paragraph">Codex ${rtlText} <code id="reasoning-code">data-slot</code></p>
        <p id="english-reasoning-paragraph">Checking the queue markup.</p>
      </div>
    </div>
    <button type="button" data-v2-item-type="subagent" class="group/subagent flex w-full min-w-0 items-center text-left">
      <span class="min-w-0 flex-1">
        <span class="flex items-baseline gap-2"><span id="subagent-title" class="min-w-0 truncate text-xs font-medium">Find the queue hook</span><span class="shrink-0 text-3xs">Finished</span></span>
        <span class="block text-2xs leading-relaxed"><span id="subagent-summary" class="block truncate">1. **Codex** ${rtlText}</span></span>
      </span>
    </button>
    <div class="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
      <div id="hover-card-title" class="min-w-0 truncate text-xs leading-tight font-medium">${rtlText} hook</div>
      <div class="grid gap-1.5 pl-0.5 text-xs">
        <div class="flex min-w-0 items-center gap-2"><svg class="lucide lucide-terminal size-3 shrink-0"></svg><span id="hover-card-result" class="inline-flex min-w-0 max-w-full overflow-hidden whitespace-nowrap flex" style="display: inline-flex; max-width: 200px; overflow: hidden; white-space: nowrap"><span id="hover-card-result-head" class="min-w-0 truncate" style="min-width: 0; overflow: hidden; text-overflow: ellipsis">1. **Codex** ${rtlText} ${rtlText} ${rtlText} ${rtlText} ${rtlText}</span><span id="hover-card-result-tail" class="shrink-0" style="flex-shrink: 0">${rtlText}</span></span></div>
        <div class="flex min-w-0 items-center gap-2"><svg class="lucide lucide-folder size-3 shrink-0"></svg><span id="hover-card-path" class="inline-flex min-w-0 whitespace-nowrap flex"><span class="min-w-0 truncate">C:/repo/${rtlText}</span></span></div>
      </div>
    </div>
    <div class="flex min-w-0 max-w-80 flex-col gap-2 px-1 py-2">
      <div class="grid gap-1.5 pl-0.5 text-xs">
        <div class="flex min-w-0 items-center gap-2"><svg class="lucide lucide-terminal size-3 shrink-0"></svg><span id="english-hover-card-result" class="inline-flex min-w-0 max-w-full overflow-hidden whitespace-nowrap flex" style="display: inline-flex; max-width: 200px; overflow: hidden; white-space: nowrap"><span id="english-hover-card-result-head" class="min-w-0 truncate" style="min-width: 0; overflow: hidden; text-overflow: ellipsis">Found the queue hook in the bundle and checked the markup</span><span id="english-hover-card-result-tail" class="shrink-0" style="flex-shrink: 0">the markup</span></span></div>
      </div>
    </div>
    <div class="max-w-full overflow-hidden rounded-lg border">
      <div class="border-b px-3 py-2 text-xs">Screenshot unavailable</div>
      <div class="min-w-0 px-3 py-2.5">
        <div id="annotation-card-title" class="text-message-foreground text-xs font-medium">mailcow Logs Viewer DEV</div>
        <div id="annotation-card-comment" class="mt-1 whitespace-pre-wrap wrap-break-word text-sm">${rtlText} PR ${rtlText}</div>
        <div class="mt-1 flex items-center gap-2 text-xs"><span id="annotation-card-summary" class="truncate">1 selected element</span></div>
      </div>
    </div>
    <div class="min-w-0 px-3 py-2.5"><div id="annotation-card-hebrew-title" class="text-message-foreground text-xs font-medium">${rtlText}</div></div>
    <div id="composer-annotation-card" class="whitespace-pre-wrap wrap-break-word px-3 py-2.5 text-sm text-foreground" style="width: 300px; padding: 0; white-space: pre-wrap">Google

${rtlText}

1 element</div>
    <div id="english-citation-card" class="flex flex-col items-start gap-3 p-1 text-sm" style="width: 300px">
      <div class="max-h-64 min-h-0 space-y-3 self-stretch overflow-y-auto whitespace-pre-wrap wrap-break-word">
        <blockquote id="english-citation-quote" class="border-l-2 border-border pl-3 text-muted-foreground">Run the tests first.</blockquote>
        <p id="english-citation-card-comment">Why first?</p>
      </div>
      <a id="english-citation-source" href="#">Go to source</a>
    </div>
    <div id="composer-chrome">
      <textarea id="pending-answer" placeholder="Type your own answer"></textarea>
      <button>Submit answers</button>
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
      const dynamicPlanCard = document.createElement("div");
      dynamicPlanCard.id = "dynamic-plan-card";
      dynamicPlanCard.innerHTML = '<div><div><h3 id="dynamic-plan-title">${rtlText}</h3></div><button aria-label="Plan actions">...</button></div><div><div id="dynamic-plan-markdown" class="chat-markdown" dir="auto"><p id="dynamic-plan-paragraph">${rtlText}</p></div></div>';
      document.body.appendChild(dynamicPlanCard);
      document.getElementById("streamed-paragraph").append(" ", ${JSON.stringify(rtlText)});
      const dynamicTooltip = document.createElement("div");
      dynamicTooltip.setAttribute("data-slot", "tooltip-positioner");
      dynamicTooltip.innerHTML = '<div id="dynamic-tooltip" data-slot="tooltip-popup"><div data-slot="tooltip-viewport">' + ${JSON.stringify(rtlText)} + "</div></div>";
      document.body.appendChild(dynamicTooltip);
      // The card of a quoted text chip opens in a popup after the page loads.
      const citationPopup = document.createElement("div");
      citationPopup.innerHTML = '<div id="citation-card" class="flex flex-col items-start gap-3 p-1 text-sm" style="width: 300px"><div class="max-h-64 min-h-0 space-y-3 self-stretch overflow-y-auto whitespace-pre-wrap wrap-break-word"><blockquote id="citation-quote" class="border-l-2 border-border pl-3 text-muted-foreground">' + ${JSON.stringify(rtlText)} + ' common.md</blockquote><p id="citation-card-comment">' + ${JSON.stringify(rtlText)} + '</p></div><a id="citation-source" href="#">Go to source</a></div>';
      document.body.appendChild(citationPopup);
      // Typing into an empty composer paragraph after injection.
      document.getElementById("composer-typed-paragraph").append(${JSON.stringify(rtlText)});
      const secondComposerParagraph = document.getElementById("second-composer-paragraph");
      const composerParagraphBeforeTyping = document.getElementById("composer-chip-rtl-paragraph");
      const dynamicCommentEditor = document.createElement("div");
      dynamicCommentEditor.id = "dynamic-citation-comment-editor";
      dynamicCommentEditor.setAttribute("data-citation-comment-editor", "true");
      dynamicCommentEditor.innerHTML = '<textarea id="dynamic-citation-comment-input" aria-label="Comment on selected text"></textarea>';
      document.body.appendChild(dynamicCommentEditor);
      // The popup opens empty and the user types into it, so the comment
      // direction has to follow the value rather than the initial markup.
      const commentInput = document.getElementById("citation-comment-input");
      commentInput.value = ${JSON.stringify(rtlText)};
      commentInput.dispatchEvent(new Event("input", { bubbles: true }));
      const englishCommentInput = document.getElementById("english-citation-comment-input");
      englishCommentInput.value = "Rename this option.";
      englishCommentInput.dispatchEvent(new Event("input", { bubbles: true }));
      const tableContainer = document.getElementById("table");
      const tableScroll = document.getElementById("table-scroll");
      const tableElement = document.getElementById("table-element");
      const collapsedTableOverflows = tableScroll.scrollWidth > tableScroll.clientWidth;
      tableContainer.dataset.expanded = "true";
      setTimeout(() => {
        const style = (id) => getComputedStyle(document.getElementById(id));
        resolve({
          styleInjected: Boolean(document.getElementById("t3-rtl-fix")),
          rtlMessageDir: document.getElementById("rtl-message").dir,
          rtlMessageDirection: style("rtl-message").direction,
          rtlParagraphDir: document.getElementById("rtl-paragraph").dir,
          rtlParagraphDirection: style("rtl-paragraph").direction,
          rtlImageParagraphDir: document.getElementById("rtl-image-paragraph").getAttribute("dir"),
          rtlImageAtStart:
            Math.abs(
              document.getElementById("rtl-image").getBoundingClientRect().right -
                document.getElementById("rtl-message").getBoundingClientRect().right,
            ) <= 1,
          englishImageParagraphDir: document.getElementById("english-image-paragraph").getAttribute("dir"),
          englishImageAtStart:
            Math.abs(
              document.getElementById("english-image").getBoundingClientRect().left -
                document.getElementById("english-message").getBoundingClientRect().left,
            ) <= 1,
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
          collapsedTableOverflows,
          expandedTableFits: tableElement.getBoundingClientRect().width <= tableScroll.clientWidth + 1,
          englishCellDir: document.getElementById("english-cell").dir,
          rtlCellDir: document.getElementById("rtl-cell").dir,
          dynamicMessageDir: document.getElementById("dynamic-message").dir,
          dynamicMessageDirection: style("dynamic-message").direction,
          dynamicParagraphDirection: style("dynamic-paragraph").direction,
          dynamicCodeDir: document.getElementById("dynamic-code").dir,
          streamedParagraphDir: document.getElementById("streamed-paragraph").dir,
          streamedParagraphDirection: style("streamed-paragraph").direction,
          pullRequestMarkdownDir: document.getElementById("pull-request-markdown").dir,
          pullRequestMarkdownDirection: style("pull-request-markdown").direction,
          pullRequestHeadingDir: document.getElementById("pull-request-heading").dir,
          pullRequestParagraphDir: document.getElementById("pull-request-paragraph").dir,
          pullRequestEnglishParagraphDir: document.getElementById(
            "pull-request-english-paragraph",
          ).dir,
          pullRequestListItemDir: document.getElementById("pull-request-list-item").dir,
          pullRequestCodeDir: document.querySelector("#pull-request-list-item code").dir,
          fileMarkdownDir: document.getElementById("file-markdown").dir,
          fileMarkdownDirection: style("file-markdown").direction,
          fileMarkdownHeadingDir: document.getElementById("file-markdown-heading").dir,
          fileMarkdownParagraphDir: document.getElementById("file-markdown-paragraph").dir,
          fileMarkdownEnglishParagraphDir: document.getElementById(
            "file-markdown-english-paragraph",
          ).dir,
          fileMarkdownTableDir: document.getElementById("file-markdown-table").dir,
          fileMarkdownRtlCellDir: document.getElementById("file-markdown-rtl-cell").dir,
          fileMarkdownCodeDir: document.getElementById("file-markdown-code").dir,
          pendingCardDir: document.getElementById("pending-card").dir,
          pendingCardDirection: style("pending-card").direction,
          pendingToggleDir: document.getElementById("pending-toggle").dir,
          pendingToggleTextAlign: style("pending-toggle").textAlign,
          pendingIconAtStart:
            Math.abs(
              document.getElementById("pending-icon").getBoundingClientRect().right -
                document.getElementById("pending-toggle").getBoundingClientRect().right,
            ) <= 1,
          pendingActionsAtFarEdge:
            Math.abs(
              document.getElementById("pending-actions").getBoundingClientRect().left -
                document.getElementById("pending-toggle").getBoundingClientRect().left,
            ) <= 1,
          pendingQuestionDir: document.getElementById("pending-question").dir,
          pendingOptionDir: document.getElementById("pending-option").dir,
          pendingOptionTextAlign: style("pending-option").textAlign,
          pendingShortcutDir: document.getElementById("pending-shortcut").dir,
          pendingRadioBeforeShortcut:
            document.getElementById("pending-radio").getBoundingClientRect().left >=
            document.getElementById("pending-shortcut").getBoundingClientRect().right,
          pendingShortcutBeforeContent:
            document.getElementById("pending-shortcut").getBoundingClientRect().left >=
            document.getElementById("pending-option-content").getBoundingClientRect().right,
          pendingEnglishOptionDir: document.getElementById("pending-english-option").dir,
          pendingEnglishShortcutDir: document.getElementById("pending-english-shortcut").dir,
          pendingEnglishRadioBeforeContent:
            document.getElementById("pending-english-radio").getBoundingClientRect().right <=
            document.getElementById("pending-english-option-content").getBoundingClientRect().left,
          pendingEnglishShortcutAfterContent:
            document.getElementById("pending-english-shortcut").getBoundingClientRect().left >=
            document.getElementById("pending-english-option-content").getBoundingClientRect().right,
          planCardMarked: document.getElementById("plan-card").hasAttribute("data-t3-rtl-plan-card"),
          planCardDir: document.getElementById("plan-card").dir,
          planTitleDir: document.getElementById("plan-title").dir,
          planTitleTextAlign: style("plan-title").textAlign,
          planMarkdownDir: document.getElementById("plan-markdown").dir,
          planHeadingDir: document.getElementById("plan-heading").dir,
          planParagraphDir: document.getElementById("plan-paragraph").dir,
          planListItemDir: document.getElementById("plan-list-item").dir,
          englishPlanCardMarked: document
            .getElementById("english-plan-card")
            .hasAttribute("data-t3-rtl-plan-card"),
          englishPlanCardDir: document.getElementById("english-plan-card").dir,
          englishPlanTitleDir: document.getElementById("english-plan-title").dir,
          englishPlanMarkdownDir: document.getElementById("english-plan-markdown").dir,
          englishPlanHeadingDir: document.getElementById("english-plan-heading").dir,
          englishPlanParagraphDir: document.getElementById("english-plan-paragraph").dir,
          dynamicPlanCardMarked: document
            .getElementById("dynamic-plan-card")
            .hasAttribute("data-t3-rtl-plan-card"),
          dynamicPlanCardDir: document.getElementById("dynamic-plan-card").dir,
          dynamicPlanTitleDir: document.getElementById("dynamic-plan-title").dir,
          dynamicPlanMarkdownDir: document.getElementById("dynamic-plan-markdown").dir,
          dynamicPlanParagraphDir: document.getElementById("dynamic-plan-paragraph").dir,
          rtlTurnPlanMarked: document
            .getElementById("rtl-turn-plan")
            .hasAttribute("data-t3-rtl-turn-plan"),
          rtlTurnPlanDir: document.getElementById("rtl-turn-plan").dir,
          rtlTurnPlanToggleDir: document.getElementById("rtl-turn-plan-toggle").dir,
          rtlTurnPlanToggleTextAlign: style("rtl-turn-plan-toggle").textAlign,
          rtlTurnPlanChevronOppositeLabel:
            document.getElementById("rtl-turn-plan-chevron").getBoundingClientRect().right <=
            document.getElementById("rtl-turn-plan-count").getBoundingClientRect().left,
          rtlCollapsedTurnPlanChevronTransform: style("rtl-turn-plan-chevron").transform,
          rtlExpandedTurnPlanChevronTransform: style(
            "rtl-expanded-turn-plan-chevron",
          ).transform,
          rtlTurnPlanStepDir: document.getElementById("rtl-turn-plan-step").dir,
          rtlTurnPlanExpandedPaddingLeft: getComputedStyle(
            document.getElementById("rtl-turn-plan-step").parentElement,
          ).paddingLeft,
          englishTurnPlanMarked: document
            .getElementById("english-turn-plan")
            .hasAttribute("data-t3-rtl-turn-plan"),
          englishTurnPlanDir: document.getElementById("english-turn-plan").dir,
          englishTurnPlanToggleDir: document.getElementById("english-turn-plan-toggle").dir,
          englishTurnPlanChevronBeforeLabel:
            document.getElementById("english-turn-plan-chevron").getBoundingClientRect().right <=
            document.getElementById("english-turn-plan-label").getBoundingClientRect().left,
          englishCollapsedTurnPlanChevronTransform: style(
            "english-turn-plan-chevron",
          ).transform,
          rtlComposerTasksDir: document.getElementById("rtl-composer-tasks").dir,
          rtlComposerTasksToggleDir: document.getElementById("rtl-composer-tasks-toggle").dir,
          rtlComposerTaskCurrentDir: document.getElementById("rtl-composer-task-current").dir,
          rtlComposerTaskCurrentTextAlign: style("rtl-composer-task-current").textAlign,
          englishComposerTasksDir: document.getElementById("english-composer-tasks").dir,
          englishComposerTasksToggleDir: document.getElementById("english-composer-tasks-toggle").dir,
          englishComposerTaskCurrentDir: document.getElementById("english-composer-task-current").dir,
          pendingAnswerDir: document.getElementById("pending-answer").dir,
          pendingAnswerDirection: style("pending-answer").direction,
          citationCommentInputDir: document.getElementById("citation-comment-input").dir,
          citationCommentInputDirection: style("citation-comment-input").direction,
          citationCommentInputTextAlign: style("citation-comment-input").textAlign,
          citationCommentInputUnicodeBidi: style("citation-comment-input").unicodeBidi,
          citationCommentEditorDirection: style("citation-comment-editor").direction,
          citationCommentStatusDir: document.getElementById("citation-comment-status").dir,
          citationCommentStatusTextAlign: style("citation-comment-status").textAlign,
          citationCommentSaveBeforeCancel:
            document.getElementById("citation-comment-save").getBoundingClientRect().right <=
            document.getElementById("citation-comment-cancel").getBoundingClientRect().left,
          citationCommentActionsAtStart:
            Math.abs(
              document.getElementById("citation-comment-save").getBoundingClientRect().left -
                document.getElementById("citation-comment-actions").getBoundingClientRect().left,
            ) <= 1,
          englishCitationCommentInputDir: document.getElementById(
            "english-citation-comment-input",
          ).dir,
          englishCitationCommentInputDirection: style("english-citation-comment-input").direction,
          englishCitationCommentEditorDirection: style("english-citation-comment-editor").direction,
          englishCitationCommentCancelBeforeSave:
            document.getElementById("english-citation-comment-cancel").getBoundingClientRect()
              .right <=
            document.getElementById("english-citation-comment-save").getBoundingClientRect().left,
          dynamicCitationCommentInputDir: document.getElementById(
            "dynamic-citation-comment-input",
          ).dir,
          rtlCitationChipDir: document.getElementById("rtl-citation-chip").dir,
          rtlCitationChipDirection: style("rtl-citation-chip").direction,
          rtlCitationChipLabelDir: document.getElementById("rtl-citation-chip-label").dir,
          rtlCitationChipEditMarginLeft: style("rtl-citation-chip-edit").marginLeft,
          rtlCitationChipEditMarginRightApplied:
            parseFloat(style("rtl-citation-chip-edit").marginRight) > 0,
          rtlCitationChipEditAfterLabel:
            document.getElementById("rtl-citation-chip-edit").getBoundingClientRect().right <=
            document.getElementById("rtl-citation-chip-link").getBoundingClientRect().left,
          englishCitationChipDir: document.getElementById("english-citation-chip").dir,
          englishCitationChipDirection: style("english-citation-chip").direction,
          englishCitationChipLabelDir: document.getElementById("english-citation-chip-label").dir,
          englishCitationChipEditMarginLeftApplied:
            parseFloat(style("english-citation-chip-edit").marginLeft) > 0,
          englishCitationChipEditMarginRight: style("english-citation-chip-edit").marginRight,
          englishCitationChipEditAfterLabel:
            document.getElementById("english-citation-chip-edit").getBoundingClientRect().left >=
            document.getElementById("english-citation-chip-link").getBoundingClientRect().right,
          composerParagraphDirAttribute: document.getElementById("composer-chip-rtl-paragraph").getAttribute("dir"),
          composerEnglishLeadingParagraphDirection: style("composer-english-leading-paragraph").direction,
          composerMostlyEnglishParagraphDirection: style("composer-mostly-english-paragraph").direction,
          composerParagraphDirection: style("composer-chip-rtl-paragraph").direction,
          composerEnglishParagraphDirection: style("composer-chip-english-paragraph").direction,
          composerQuoteChipParagraphDirection: style("composer-quote-chip-paragraph").direction,
          composerQuoteChipAtStart:
            Math.abs(
              document.getElementById("composer-quote-chip").getBoundingClientRect().right -
                document.getElementById("composer-editor").getBoundingClientRect().right,
            ) <= 1,
          composerFileChipParagraphDirection: style("composer-file-chip-paragraph").direction,
          composerTypedParagraphDirection: style("composer-typed-paragraph").direction,
          secondComposerParagraphDirection: style("second-composer-paragraph").direction,
          composerEditorsMarkedSeparately:
            document.getElementById("composer-editor").getAttribute("data-t3-rtl-composer") !==
            document.getElementById("second-composer-editor").getAttribute("data-t3-rtl-composer"),
          composerStyleInjected: Boolean(document.getElementById("t3-rtl-fix-composer")),
          composerParagraphsKept:
            composerParagraphBeforeTyping === document.getElementById("composer-chip-rtl-paragraph") &&
            secondComposerParagraph === document.getElementById("second-composer-paragraph"),
          composerRtlChipAtStart:
            Math.abs(
              document.getElementById("composer-chip").getBoundingClientRect().right -
                document.getElementById("composer-editor").getBoundingClientRect().right,
            ) <= 1,
          composerEnglishChipAtStart:
            Math.abs(
              document.getElementById("composer-english-chip").getBoundingClientRect().left -
                document.getElementById("composer-editor").getBoundingClientRect().left,
            ) <= 1,
          composerEnglishLineFollowsParagraph:
            Math.abs(
              document.getElementById("composer-english-line").getBoundingClientRect().right -
                document.getElementById("composer-editor").getBoundingClientRect().right,
            ) <= 1,
          rtlThreadTitleDir: document.getElementById("rtl-thread-title").dir,
          englishThreadTitleDir: document.getElementById("english-thread-title").dir,
          threadTitleInputDir: document.getElementById("thread-title-input").dir,
          subThreadTitleDir: document.getElementById("sub-thread-title").dir,
          threadHeaderTitleDir: document.getElementById("thread-header-title").dir,
          threadHeaderDir: document.getElementById("thread-header").dir,
          relatedThreadTitleDir: document.getElementById("related-thread-title").dir,
          relatedThreadTitleTextAlign: style("related-thread-title").textAlign,
          englishRelatedThreadTitleDir: document.getElementById("english-related-thread-title").dir,
          mentionThreadTitleDir: document.getElementById("mention-thread-title").dir,
          parentBreadcrumbTitleDir: document.getElementById("parent-breadcrumb-title").dir,
          rtlTooltipDir: document.getElementById("rtl-tooltip").dir,
          rtlTooltipTextAtRight:
            Math.abs(
              document.getElementById("rtl-tooltip-text").getBoundingClientRect().right -
                document.getElementById("rtl-tooltip").getBoundingClientRect().right,
            ) <= 1,
          englishTooltipDirection: style("english-tooltip").direction,
          dynamicTooltipDir: document.getElementById("dynamic-tooltip").dir,
          breadcrumbSeparatorDir: document.getElementById("breadcrumb-separator").dir,
          currentBreadcrumbTitleDir: document.getElementById("current-breadcrumb-title").dir,
          toastTitleDir: document.getElementById("toast-title").dir,
          toastDescriptionDir: document.getElementById("toast-description").dir,
          workLogAnswerSummaryDir: document.getElementById("work-log-answer-summary").dir,
          workLogAnswerSummaryDirection: style("work-log-answer-summary").direction,
          workLogQuestionDirection: style("work-log-question").direction,
          workLogAnswerDirection: style("work-log-answer").direction,
          workLogAnswerDir: document.getElementById("work-log-answer").dir,
          workLogCommandDirection: style("work-log-command").direction,
          workLogRowDirection: style("work-log-row").direction,
          workLogIconAtRight: Math.abs(document.getElementById("work-log-icon").getBoundingClientRect().right - document.getElementById("work-log-row").getBoundingClientRect().right) <= 1,
          workLogChevronAtLeft: Math.abs(document.getElementById("work-log-chevron").getBoundingClientRect().left - document.getElementById("work-log-row").getBoundingClientRect().left) <= 1,
          workLogQuestionSummaryRightOfAnswer:
            document.getElementById("work-log-question-summary").getBoundingClientRect().left >= document.getElementById("work-log-answer-summary").getBoundingClientRect().right,
          workLogSummaryNextToIcon:
            Math.abs(document.getElementById("work-log-question-summary").getBoundingClientRect().right - document.getElementById("work-log-summary").getBoundingClientRect().right) <= 1,
          workLogOpenChevronTransform: style("work-log-chevron-icon").transform,
          closedWorkLogChevronTransform: style("closed-work-log-chevron-icon").transform,
          englishWorkLogRowDirection: style("english-work-log-row").direction,
          englishWorkLogIconAtLeft:
            Math.abs(document.getElementById("english-work-log-icon").getBoundingClientRect().left - document.getElementById("english-work-log-row").getBoundingClientRect().left) <= 1,
          englishWorkLogQuestionSummaryLeftOfAnswer:
            document.getElementById("english-work-log-question-summary").getBoundingClientRect().right <=
            document.getElementById("english-work-log-answer-summary").getBoundingClientRect().left,
          englishWorkLogChevronTransform: style("english-work-log-chevron-icon").transform,
          workLogQuestionTextAlign: style("work-log-question").textAlign,
          workLogQuestionAtRight: (() => {
            const range = document.createRange();
            range.selectNodeContents(document.getElementById("work-log-question"));
            return Math.abs(range.getBoundingClientRect().right - document.getElementById("work-log-question").getBoundingClientRect().right) <= 1;
          })(),
          liveThoughtDir: document.getElementById("live-thought").dir,
          liveThoughtDirection: style("live-thought").direction,
          englishLiveThoughtDirection: style("english-live-thought").direction,
          reasoningParagraphDir: document.getElementById("reasoning-paragraph").dir,
          reasoningCodeDirection: style("reasoning-code").direction,
          englishReasoningParagraphDir: document.getElementById("english-reasoning-paragraph").dir,
          subagentTitleDir: document.getElementById("subagent-title").dir,
          subagentSummaryDir: document.getElementById("subagent-summary").dir,
          hoverCardTitleDir: document.getElementById("hover-card-title").dir,
          hoverCardResultDir: document.getElementById("hover-card-result").dir,
          hoverCardPathDir: document.getElementById("hover-card-path").dir,
          hoverCardResultHeadAtRight:
            document.getElementById("hover-card-result-head").getBoundingClientRect().left >
            document.getElementById("hover-card-result-tail").getBoundingClientRect().left,
          englishHoverCardResultDir: document.getElementById("english-hover-card-result").dir,
          englishHoverCardResultHeadAtLeft:
            document.getElementById("english-hover-card-result-head").getBoundingClientRect().left <
            document.getElementById("english-hover-card-result-tail").getBoundingClientRect().left,
          citationCardDir: document.getElementById("citation-card").dir,
          citationQuoteDir: document.getElementById("citation-quote").dir,
          citationQuoteBorderLeft: style("citation-quote").borderLeftWidth,
          citationQuoteBorderRight: style("citation-quote").borderRightWidth,
          citationCommentDir: document.getElementById("citation-card-comment").dir,
          citationSourceDir: document.getElementById("citation-source").dir,
          citationSourceAtRight:
            Math.abs(
              document.getElementById("citation-source").getBoundingClientRect().right -
                document.getElementById("citation-card").getBoundingClientRect().right,
            ) <= 5,
          englishCitationCardDir: document.getElementById("english-citation-card").dir,
          englishCitationQuoteDir: document.getElementById("english-citation-quote").dir,
          englishCitationQuoteBorderLeft: style("english-citation-quote").borderLeftWidth,
          englishCitationSourceAtLeft:
            Math.abs(
              document.getElementById("english-citation-source").getBoundingClientRect().left -
                document.getElementById("english-citation-card").getBoundingClientRect().left,
            ) <= 5,
          annotationCardCommentDir: document.getElementById("annotation-card-comment").dir,
          annotationCardCommentDirection: style("annotation-card-comment").direction,
          annotationCardTitleDir: document.getElementById("annotation-card-title").dir,
          annotationCardHebrewTitleDir: document.getElementById("annotation-card-hebrew-title").dir,
          annotationCardSummaryDir: document.getElementById("annotation-card-summary").dir,
          ...(() => {
            const card = document.getElementById("composer-annotation-card");
            const text = card.firstChild;
            const cardBox = card.getBoundingClientRect();
            const lineBox = (part) => {
              const start = text.data.indexOf(part);
              const range = document.createRange();
              range.setStart(text, start);
              range.setEnd(text, start + part.length);
              return range.getBoundingClientRect();
            };
            return {
              composerAnnotationCardUnicodeBidi: style("composer-annotation-card").unicodeBidi,
              composerAnnotationCardTitleAtLeft: Math.abs(lineBox("Google").left - cardBox.left) <= 1,
              composerAnnotationCardCommentAtRight:
                Math.abs(lineBox(${JSON.stringify(rtlText)}).right - cardBox.right) <= 1,
              composerAnnotationCardCountAtLeft: Math.abs(lineBox("1 element").left - cardBox.left) <= 1,
            };
          })(),
          rtlQueuePromptDir: document.getElementById("rtl-queue-prompt").dir,
          rtlQueuePromptTextAlign: style("rtl-queue-prompt").textAlign,
          englishQueuePromptDir: document.getElementById("english-queue-prompt").dir,
          rtlQueueRowDirection: style("rtl-queue-row").direction,
          ...(() => {
            const lastLine = (id) => {
              const element = document.getElementById(id);
              const range = document.createRange();
              range.selectNodeContents(element);
              const rects = range.getClientRects();
              return { box: element.getBoundingClientRect(), line: rects[rects.length - 1], lines: rects.length };
            };
            const rtl = lastLine("thread-queue-rtl-prompt");
            const english = lastLine("thread-queue-english-prompt");
            return {
              threadQueueRtlPromptDir: document.getElementById("thread-queue-rtl-prompt").dir,
              threadQueueRtlPromptWraps: rtl.lines > 1,
              threadQueueRtlLastLineAtRight: Math.abs(rtl.line.right - rtl.box.right) <= 1,
              threadQueueRtlActionsDirection: style("thread-queue-rtl-actions").direction,
              threadQueueEnglishPromptDir: document.getElementById("thread-queue-english-prompt").dir,
              threadQueueEnglishLastLineAtLeft: Math.abs(english.line.left - english.box.left) <= 1,
            };
          })(),
          rtlQueueActionsDirection: style("rtl-queue-actions").direction,
          queueHeaderDirection: style("queue-header").direction,
          composerHeadingDirection: style("composer-heading").direction,
          composerRtlListDirection: style("composer-rtl-list").direction,
          composerRtlListGutterAtRight:
            style("composer-rtl-list").paddingLeft === "0px" &&
            style("composer-rtl-list").paddingRight === "20px",
          composerRtlItemDirection: style("composer-rtl-item").direction,
          composerEmptyItemDirection: style("composer-empty-item").direction,
          composerEnglishItemInRtlListDirection: style("composer-english-item-in-rtl-list").direction,
          composerEnglishListDirection: style("composer-english-list").direction,
          composerEnglishListGutterAtLeft:
            style("composer-english-list").paddingLeft === "20px" &&
            style("composer-english-list").paddingRight === "0px",
          composerRtlItemInEnglishListDirection: style("composer-rtl-item-in-english-list").direction,
          composerTaskListPadding: [
            style("composer-task-list").paddingLeft,
            style("composer-task-list").paddingRight,
          ].join(" "),
          composerTaskItemDirection: style("composer-task-item").direction,
          composerTaskCheckboxAtRight:
            Math.abs(
              document.getElementById("composer-task-checkbox").getBoundingClientRect().right -
                document.getElementById("composer-task-item").getBoundingClientRect().right,
            ) <= 1,
          composerQuoteDirection: style("composer-quote").direction,
          composerQuoteBorder: [style("composer-quote").borderLeftWidth, style("composer-quote").borderRightWidth].join(" "),
          composerQuoteEnglishParagraphDirection: style("composer-quote-english-paragraph").direction,
          composerCodeBlockDirection: style("composer-code-block").direction,
          rtlQueuedCardDir: document.getElementById("rtl-queued-card").dir,
          rtlQueuedPromptDirection: style("rtl-queued-prompt").direction,
          rtlQueuedParagraphDir: document.getElementById("rtl-queued-paragraph").dir,
          rtlQueuedEnglishParagraphDir: document.getElementById("rtl-queued-english-paragraph").dir,
          rtlQueuedCodeDir: document.getElementById("rtl-queued-code").dir,
          rtlQueuedPromptTextAlign: style("rtl-queued-prompt").textAlign,
          rtlQueuedDetailsDir: document.getElementById("rtl-queued-details").dir,
          rtlQueuedDetailsDirection: style("rtl-queued-details").direction,
          rtlQueuedDetailsOnCardSide:
            Math.abs(
              document.getElementById("rtl-queued-details-text").getBoundingClientRect().right -
                document.getElementById("rtl-queued-details").getBoundingClientRect().right,
            ) <= 1,
          rtlQueuedStatusAtStart:
            Math.abs(
              document.getElementById("rtl-queued-status").getBoundingClientRect().right -
                document.getElementById("rtl-queued-footer").getBoundingClientRect().right,
            ) <= 1,
          rtlQueuedActionsAtEnd:
            Math.abs(
              document.getElementById("rtl-queued-actions").getBoundingClientRect().left -
                document.getElementById("rtl-queued-footer").getBoundingClientRect().left,
            ) <= 1,
          englishQueuedCardDir: document.getElementById("english-queued-card").dir,
          englishQueuedPromptDirection: style("english-queued-prompt").direction,
          englishQueuedStatusAtStart:
            Math.abs(
              document.getElementById("english-queued-status").getBoundingClientRect().left -
                document.getElementById("english-queued-footer").getBoundingClientRect().left,
            ) <= 1,
          englishQueuedActionsAtEnd:
            Math.abs(
              document.getElementById("english-queued-actions").getBoundingClientRect().right -
                document.getElementById("english-queued-footer").getBoundingClientRect().right,
            ) <= 1,
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
    rtlImageParagraphDir: null,
    rtlImageAtStart: true,
    englishImageParagraphDir: null,
    englishImageAtStart: true,
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
    tableDir: "rtl",
    collapsedTableOverflows: true,
    expandedTableFits: true,
    englishCellDir: "auto",
    rtlCellDir: "rtl",
    dynamicMessageDir: "rtl",
    dynamicMessageDirection: "rtl",
    dynamicParagraphDirection: "rtl",
    dynamicCodeDir: "ltr",
    streamedParagraphDir: "rtl",
    streamedParagraphDirection: "rtl",
    pullRequestMarkdownDir: "rtl",
    pullRequestMarkdownDirection: "rtl",
    pullRequestHeadingDir: "rtl",
    pullRequestParagraphDir: "rtl",
    pullRequestEnglishParagraphDir: "auto",
    pullRequestListItemDir: "rtl",
    pullRequestCodeDir: "ltr",
    fileMarkdownDir: "rtl",
    fileMarkdownDirection: "rtl",
    fileMarkdownHeadingDir: "rtl",
    fileMarkdownParagraphDir: "rtl",
    fileMarkdownEnglishParagraphDir: "auto",
    fileMarkdownTableDir: "rtl",
    fileMarkdownRtlCellDir: "rtl",
    fileMarkdownCodeDir: "ltr",
    pendingCardDir: "rtl",
    pendingCardDirection: "rtl",
    pendingToggleDir: "rtl",
    pendingToggleTextAlign: "start",
    pendingIconAtStart: true,
    pendingActionsAtFarEdge: true,
    pendingQuestionDir: "rtl",
    pendingOptionDir: "rtl",
    pendingOptionTextAlign: "start",
    pendingShortcutDir: "ltr",
    pendingRadioBeforeShortcut: true,
    pendingShortcutBeforeContent: true,
    pendingEnglishOptionDir: "auto",
    pendingEnglishShortcutDir: "ltr",
    pendingEnglishRadioBeforeContent: true,
    pendingEnglishShortcutAfterContent: true,
    planCardMarked: true,
    planCardDir: "rtl",
    planTitleDir: "rtl",
    planTitleTextAlign: "start",
    planMarkdownDir: "rtl",
    planHeadingDir: "rtl",
    planParagraphDir: "rtl",
    planListItemDir: "rtl",
    englishPlanCardMarked: true,
    englishPlanCardDir: "auto",
    englishPlanTitleDir: "auto",
    englishPlanMarkdownDir: "auto",
    englishPlanHeadingDir: "auto",
    englishPlanParagraphDir: "auto",
    dynamicPlanCardMarked: true,
    dynamicPlanCardDir: "rtl",
    dynamicPlanTitleDir: "rtl",
    dynamicPlanMarkdownDir: "rtl",
    dynamicPlanParagraphDir: "rtl",
    rtlTurnPlanMarked: true,
    rtlTurnPlanDir: "rtl",
    rtlTurnPlanToggleDir: "rtl",
    rtlTurnPlanToggleTextAlign: "start",
    rtlTurnPlanChevronOppositeLabel: true,
    rtlCollapsedTurnPlanChevronTransform: "matrix(-1, 0, 0, 1, 0, 0)",
    rtlExpandedTurnPlanChevronTransform: "none",
    rtlTurnPlanStepDir: "rtl",
    rtlTurnPlanExpandedPaddingLeft: "0px",
    englishTurnPlanMarked: true,
    englishTurnPlanDir: "auto",
    englishTurnPlanToggleDir: "auto",
    englishTurnPlanChevronBeforeLabel: true,
    englishCollapsedTurnPlanChevronTransform: "none",
    rtlComposerTasksDir: "rtl",
    rtlComposerTasksToggleDir: "rtl",
    rtlComposerTaskCurrentDir: "rtl",
    rtlComposerTaskCurrentTextAlign: "start",
    englishComposerTasksDir: "auto",
    englishComposerTasksToggleDir: "auto",
    englishComposerTaskCurrentDir: "auto",
    pendingAnswerDir: "",
    pendingAnswerDirection: "ltr",
    citationCommentInputDir: "auto",
    citationCommentInputDirection: "rtl",
    citationCommentInputTextAlign: "start",
    citationCommentInputUnicodeBidi: "plaintext",
    citationCommentEditorDirection: "ltr",
    citationCommentStatusDir: "",
    citationCommentStatusTextAlign: "start",
    citationCommentSaveBeforeCancel: true,
    citationCommentActionsAtStart: true,
    englishCitationCommentInputDir: "auto",
    englishCitationCommentInputDirection: "ltr",
    englishCitationCommentEditorDirection: "ltr",
    englishCitationCommentCancelBeforeSave: true,
    dynamicCitationCommentInputDir: "auto",
    rtlCitationChipDir: "rtl",
    rtlCitationChipDirection: "rtl",
    rtlCitationChipLabelDir: "rtl",
    rtlCitationChipEditMarginLeft: "0px",
    rtlCitationChipEditMarginRightApplied: true,
    rtlCitationChipEditAfterLabel: true,
    englishCitationChipDir: "auto",
    englishCitationChipDirection: "ltr",
    englishCitationChipLabelDir: "auto",
    englishCitationChipEditMarginLeftApplied: true,
    englishCitationChipEditMarginRight: "0px",
    englishCitationChipEditAfterLabel: true,
    composerParagraphDirAttribute: null,
    composerEnglishLeadingParagraphDirection: "rtl",
    composerMostlyEnglishParagraphDirection: "rtl",
    composerParagraphDirection: "rtl",
    composerEnglishParagraphDirection: "ltr",
    composerQuoteChipParagraphDirection: "rtl",
    composerQuoteChipAtStart: true,
    composerFileChipParagraphDirection: "rtl",
    composerTypedParagraphDirection: "rtl",
    secondComposerParagraphDirection: "rtl",
    composerEditorsMarkedSeparately: true,
    composerStyleInjected: true,
    composerParagraphsKept: true,
    composerRtlChipAtStart: true,
    composerEnglishChipAtStart: true,
    composerEnglishLineFollowsParagraph: true,
    rtlThreadTitleDir: "rtl",
    englishThreadTitleDir: "auto",
    threadTitleInputDir: "auto",
    subThreadTitleDir: "rtl",
    threadHeaderTitleDir: "rtl",
    threadHeaderDir: "",
    relatedThreadTitleDir: "rtl",
    relatedThreadTitleTextAlign: "start",
    englishRelatedThreadTitleDir: "auto",
    mentionThreadTitleDir: "rtl",
    parentBreadcrumbTitleDir: "rtl",
    rtlTooltipDir: "auto",
    rtlTooltipTextAtRight: true,
    englishTooltipDirection: "ltr",
    dynamicTooltipDir: "auto",
    breadcrumbSeparatorDir: "",
    currentBreadcrumbTitleDir: "auto",
    toastTitleDir: "auto",
    toastDescriptionDir: "rtl",
    workLogAnswerSummaryDir: "auto",
    workLogAnswerSummaryDirection: "rtl",
    workLogQuestionDirection: "rtl",
    workLogAnswerDirection: "rtl",
    workLogAnswerDir: "rtl",
    workLogCommandDirection: "ltr",
    workLogRowDirection: "rtl",
    workLogIconAtRight: true,
    workLogChevronAtLeft: true,
    workLogQuestionSummaryRightOfAnswer: true,
    workLogSummaryNextToIcon: true,
    workLogOpenChevronTransform: "none",
    closedWorkLogChevronTransform: "matrix(-1, 0, 0, 1, 0, 0)",
    englishWorkLogRowDirection: "ltr",
    englishWorkLogIconAtLeft: true,
    englishWorkLogQuestionSummaryLeftOfAnswer: true,
    englishWorkLogChevronTransform: "none",
    workLogQuestionTextAlign: "start",
    workLogQuestionAtRight: true,
    liveThoughtDir: "auto",
    liveThoughtDirection: "rtl",
    englishLiveThoughtDirection: "ltr",
    reasoningParagraphDir: "rtl",
    reasoningCodeDirection: "ltr",
    englishReasoningParagraphDir: "auto",
    subagentTitleDir: "auto",
    subagentSummaryDir: "rtl",
    hoverCardTitleDir: "rtl",
    hoverCardResultDir: "rtl",
    hoverCardPathDir: "",
    hoverCardResultHeadAtRight: true,
    englishHoverCardResultDir: "auto",
    englishHoverCardResultHeadAtLeft: true,
    citationCardDir: "rtl",
    citationQuoteDir: "rtl",
    citationQuoteBorderLeft: "0px",
    citationQuoteBorderRight: "2px",
    citationCommentDir: "rtl",
    citationSourceDir: "auto",
    citationSourceAtRight: true,
    englishCitationCardDir: "auto",
    englishCitationQuoteDir: "auto",
    englishCitationQuoteBorderLeft: "2px",
    englishCitationSourceAtLeft: true,
    annotationCardCommentDir: "rtl",
    annotationCardCommentDirection: "rtl",
    annotationCardTitleDir: "auto",
    annotationCardHebrewTitleDir: "rtl",
    annotationCardSummaryDir: "",
    composerAnnotationCardUnicodeBidi: "plaintext",
    composerAnnotationCardTitleAtLeft: true,
    composerAnnotationCardCommentAtRight: true,
    composerAnnotationCardCountAtLeft: true,
    rtlQueuePromptDir: "rtl",
    rtlQueuePromptTextAlign: "start",
    englishQueuePromptDir: "auto",
    rtlQueueRowDirection: "ltr",
    threadQueueRtlPromptDir: "rtl",
    threadQueueRtlPromptWraps: true,
    threadQueueRtlLastLineAtRight: true,
    threadQueueRtlActionsDirection: "ltr",
    threadQueueEnglishPromptDir: "auto",
    threadQueueEnglishLastLineAtLeft: true,
    rtlQueueActionsDirection: "ltr",
    queueHeaderDirection: "ltr",
    composerHeadingDirection: "rtl",
    composerRtlListDirection: "rtl",
    composerRtlListGutterAtRight: true,
    composerRtlItemDirection: "rtl",
    composerEmptyItemDirection: "rtl",
    composerEnglishItemInRtlListDirection: "ltr",
    composerEnglishListDirection: "ltr",
    composerEnglishListGutterAtLeft: true,
    composerRtlItemInEnglishListDirection: "rtl",
    composerTaskListPadding: "0px 0px",
    composerTaskItemDirection: "rtl",
    composerTaskCheckboxAtRight: true,
    composerQuoteDirection: "rtl",
    composerQuoteBorder: "0px 2px",
    composerQuoteEnglishParagraphDirection: "ltr",
    composerCodeBlockDirection: "ltr",
    rtlQueuedCardDir: "rtl",
    rtlQueuedPromptDirection: "rtl",
    rtlQueuedParagraphDir: "rtl",
    rtlQueuedEnglishParagraphDir: "auto",
    rtlQueuedCodeDir: "ltr",
    rtlQueuedPromptTextAlign: "start",
    rtlQueuedDetailsDir: "auto",
    rtlQueuedDetailsDirection: "ltr",
    rtlQueuedDetailsOnCardSide: true,
    rtlQueuedStatusAtStart: true,
    rtlQueuedActionsAtEnd: true,
    englishQueuedCardDir: "auto",
    englishQueuedPromptDirection: "ltr",
    englishQueuedStatusAtStart: true,
    englishQueuedActionsAtEnd: true,
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected injected layout: ${JSON.stringify(actual)}`);
  }
  process.stdout.write("CDP pipe direction injection passed\n");
  await runNativeDirectionChecks(sessionId);
}

// T3 Code 0.1.2 sets its own dir attribute on every top-level Markdown block
// and composer block from a majority vote of their words, so an English
// sentence with one Hebrew word reads left to right there. The fix's rule
// makes it right to left and must win on every block it sets.
async function runNativeDirectionChecks(sessionId) {
  const mixedText = `Please run the tests and check ${rtlText}`;
  const nativeFixtureHtml = `
    <style>
      .chat-markdown ul, .chat-markdown ol { padding-left: 20px; }
      .chat-markdown div[role="note"] { border-left: 2px solid blue; padding-left: 12px; }
      .chat-markdown table { width: 100%; border-collapse: collapse; }
      .composer-tiptap { width: 320px; }
      .composer-tiptap p { margin: 0; }
      .composer-tiptap ul { margin: 0; padding-left: 1.25rem; }
    </style>
    <div data-message-role="assistant" style="width: 400px">
      <div id="native-message" class="chat-markdown">
        <p id="native-paragraph" dir="ltr">${mixedText}</p>
        <ul id="native-list" dir="ltr"><li id="native-list-item">${mixedText}</li></ul>
        <ol id="native-ordered-list" dir="ltr"><li>${mixedText}</li></ol>
        <div id="native-alert" role="note" dir="ltr"><p>${mixedText}</p></div>
        <div class="chat-markdown-table-container">
          <div>
            <table id="native-table" dir="ltr">
              <thead><tr><th id="native-first-header">Name</th><th>Status</th><th>Owner</th></tr></thead>
              <tbody><tr><td>Build</td><td>Done</td><td>${rtlText}</td></tr></tbody>
            </table>
          </div>
        </div>
        <details id="native-details" dir="ltr"><summary>${mixedText}</summary></details>
        <section id="native-footnotes" data-footnotes="" dir="ltr"><ol><li><p>${mixedText}</p></li></ol></section>
        <p id="native-attribute-paragraph" dir="ltr">${mixedText}</p>
        <p id="native-removal-paragraph">English words <span id="native-removed-span">${rtlText}</span></p>
      </div>
    </div>
    <div id="native-composer" class="composer-tiptap" contenteditable="true">
      <ul id="native-composer-list" dir="rtl"><li id="native-composer-first-item"><p>Run the tests</p></li><li><p>${rtlText} ${rtlText}</p></li></ul>
    </div>`;
  await send("Runtime.evaluate", {
    expression: `document.body.innerHTML = ${JSON.stringify(nativeFixtureHtml)}`,
  }, sessionId);
  await send("Runtime.evaluate", { expression: injectionSource }, sessionId);
  const result = await send("Runtime.evaluate", {
    expression: `new Promise((resolve) => {
      // A React render that changes only the attribute, and one that removes
      // the last Hebrew text from a block.
      document.getElementById("native-attribute-paragraph").setAttribute("dir", "ltr");
      document.getElementById("native-removed-span").remove();
      setTimeout(() => {
        // The fix's own dir writes must not wake it again and again.
        let laterDirectionChanges = 0;
        const quietObserver = new MutationObserver((records) => {
          laterDirectionChanges += records.length;
        });
        quietObserver.observe(document.body, { attributes: true, attributeFilter: ["dir"], subtree: true });
        setTimeout(() => {
          quietObserver.disconnect();
          const element = (id) => document.getElementById(id);
          const style = (id) => getComputedStyle(element(id));
          const tableBox = element("native-table").getBoundingClientRect();
          resolve({
            laterDirectionChanges,
            paragraphDir: element("native-paragraph").dir,
            listDir: element("native-list").dir,
            listGutter: [style("native-list").paddingLeft, style("native-list").paddingRight].join(" "),
            listItemDir: element("native-list-item").dir,
            orderedListDir: element("native-ordered-list").dir,
            alertDir: element("native-alert").dir,
            alertBorder: [style("native-alert").borderLeftWidth, style("native-alert").borderRightWidth].join(" "),
            tableDir: element("native-table").dir,
            tableFirstColumnAtRight:
              Math.abs(element("native-first-header").getBoundingClientRect().right - tableBox.right) <= 1,
            detailsDir: element("native-details").dir,
            footnotesDir: element("native-footnotes").dir,
            attributeParagraphDir: element("native-attribute-paragraph").dir,
            removalParagraphDir: element("native-removal-paragraph").dir,
            composerListDirection: style("native-composer-list").direction,
            composerListGutter: [style("native-composer-list").paddingLeft, style("native-composer-list").paddingRight].join(" "),
            composerFirstItemDirection: style("native-composer-first-item").direction,
          });
        }, 200);
      }, 100);
    })`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  const actual = result.result.value;
  const expected = {
    laterDirectionChanges: 0,
    paragraphDir: "rtl",
    listDir: "rtl",
    listGutter: "0px 20px",
    listItemDir: "rtl",
    orderedListDir: "rtl",
    alertDir: "rtl",
    alertBorder: "0px 2px",
    tableDir: "rtl",
    tableFirstColumnAtRight: true,
    detailsDir: "rtl",
    footnotesDir: "rtl",
    attributeParagraphDir: "rtl",
    removalParagraphDir: "auto",
    composerListDirection: "ltr",
    composerListGutter: "20px 0px",
    composerFirstItemDirection: "ltr",
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected layout with T3 Code direction attributes: ${JSON.stringify(actual)}`);
  }
  process.stdout.write("CDP pipe direction over T3 Code direction attributes passed\n");
  await runTableScrollChecks(sessionId);
}

// T3 Code scrolls a wide table in a Base UI scroll area. Without a direction
// provider, Base UI measures the scroll as left to right: the start overflow
// is scrollLeft clamped to the scrollable width, the end overflow is the
// rest, and it fades the left and right edges by those amounts. Under a
// right-to-left table that fades the edge where the table starts.
async function runTableScrollChecks(sessionId) {
  const tableRows = (count) =>
    Array.from({ length: count }, () =>
      `<tr><td>${rtlText} ${rtlText}</td><td>${rtlText} ${rtlText} ${rtlText}</td><td>${rtlText} ${rtlText} ${rtlText}</td></tr>`,
    ).join("");
  const scrollTable = (id, header, rows) => `
    <div class="chat-markdown-table-container" data-expanded="false">
      <div class="relative overflow-hidden">
        <div id="${id}-viewport" data-slot="scroll-area-viewport" style="overflow: scroll">
          <table id="${id}">
            <thead><tr><th id="${id}-first-header">${header[0]}</th><th id="${id}-english-header">${header[1]}</th><th>${header[2]}</th></tr></thead>
            <tbody id="${id}-body">${rows}</tbody>
          </table>
        </div>
      </div>
    </div>`;
  const tableFixtureHtml = `
    <style>
      [data-message-role] { width: 360px; }
      .chat-markdown table { width: 100%; min-width: max-content; border-collapse: collapse; }
      .chat-markdown th, .chat-markdown td { padding: 8px 12px; text-align: start; white-space: nowrap; }
    </style>
    <div data-message-role="assistant">
      <div class="chat-markdown">
        <p>${rtlText}</p>
        ${scrollTable("rtl-scroll-table", [rtlText, "API key", "Owner"], tableRows(2))}
        ${scrollTable("english-scroll-table", ["Name", "Status", "Owner"], "<tr><td>Build pipeline for the release</td><td>Done after the second attempt</td><td>The release engineering team</td></tr>")}
      </div>
    </div>`;
  await send("Runtime.evaluate", {
    expression: `document.body.innerHTML = ${JSON.stringify(tableFixtureHtml)}`,
  }, sessionId);
  await send("Runtime.evaluate", { expression: injectionSource }, sessionId);
  const result = await send("Runtime.evaluate", {
    expression: `new Promise((resolve) => {
      const element = (id) => document.getElementById(id);
      const settle = () => new Promise((done) => setTimeout(done, 100));
      const viewport = element("rtl-scroll-table-viewport");
      const englishViewport = element("english-scroll-table-viewport");
      const baseUiFades = (scroller) => {
        const scrollable = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
        const start = Math.min(Math.max(scroller.scrollLeft, 0), scrollable);
        return { left: start > 0, right: scrollable - start > 0 };
      };
      const firstColumnVisible = () => {
        const header = element("rtl-scroll-table-first-header").getBoundingClientRect();
        const box = viewport.getBoundingClientRect();
        return header.left >= box.left - 1 && header.right <= box.right + 1;
      };
      const atEnd = () => viewport.scrollWidth - viewport.clientWidth - viewport.scrollLeft <= 1;
      // Each streamed row is wider than the last, so the table grows every
      // time, and the result tells whether it did.
      let wideRowWords = 3;
      const growTable = () => {
        const widthBefore = viewport.scrollWidth;
        wideRowWords += 1;
        element("rtl-scroll-table-body").insertAdjacentHTML(
          "beforeend",
          "<tr><td></td><td></td><td>" + Array(wideRowWords).fill(${JSON.stringify(rtlText)}).join(" ") + "</td></tr>",
        );
        return viewport.scrollWidth > widthBefore;
      };
      (async () => {
        await settle();
        const opened = {
          overflows: viewport.scrollWidth > viewport.clientWidth,
          viewportDirection: getComputedStyle(viewport).direction,
          tableDirection: getComputedStyle(element("rtl-scroll-table")).direction,
          firstColumnVisible: firstColumnVisible(),
          fades: baseUiFades(viewport),
          englishHeaderTextAlign: getComputedStyle(element("rtl-scroll-table-english-header")).textAlign,
        };
        let grew = growTable();
        await settle();
        const afterGrowth = { grew, atEnd: atEnd(), firstColumnVisible: firstColumnVisible() };
        // The user scrolls away and back to the same right end the fix wrote.
        const pinnedEnd = viewport.scrollLeft;
        viewport.scrollLeft = 0;
        await settle();
        viewport.scrollLeft = pinnedEnd;
        await settle();
        grew = growTable();
        await settle();
        const afterScrollBack = { grew, atEnd: atEnd() };
        // The user scrolls back to the right end as a row streams in.
        const streamingEnd = viewport.scrollLeft;
        viewport.scrollLeft = 0;
        await settle();
        viewport.scrollLeft = streamingEnd;
        grew = growTable();
        await settle();
        const afterScrollBackWhileStreaming = { grew, atEnd: atEnd() };
        // The user scrolls away and a row streams in before the scroll event
        // arrives.
        viewport.scrollLeft = 0;
        grew = growTable();
        await settle();
        const afterUserScroll = { grew, scrollLeft: viewport.scrollLeft };
        resolve({
          opened,
          afterGrowth,
          afterScrollBack,
          afterScrollBackWhileStreaming,
          afterUserScroll,
          english: {
            overflows: englishViewport.scrollWidth > englishViewport.clientWidth,
            scrollLeft: englishViewport.scrollLeft,
            headerTextAlign: getComputedStyle(element("english-scroll-table-english-header")).textAlign,
          },
        });
      })();
    })`,
    awaitPromise: true,
    returnByValue: true,
  }, sessionId);
  const actual = result.result.value;
  const expected = {
    opened: {
      overflows: true,
      viewportDirection: "ltr",
      tableDirection: "rtl",
      firstColumnVisible: true,
      fades: { left: true, right: false },
      englishHeaderTextAlign: "right",
    },
    afterGrowth: { grew: true, atEnd: true, firstColumnVisible: true },
    afterScrollBack: { grew: true, atEnd: true },
    afterScrollBackWhileStreaming: { grew: true, atEnd: true },
    afterUserScroll: { grew: true, scrollLeft: 0 },
    english: { overflows: true, scrollLeft: 0, headerTextAlign: "start" },
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected right-to-left table scroll: ${JSON.stringify(actual)}`);
  }
  process.stdout.write("CDP pipe right-to-left table scroll passed\n");
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
