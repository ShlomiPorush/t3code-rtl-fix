"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildInjectionSource } = require("../src/injection");

const root = path.resolve(__dirname, "..");

test("the launcher uses a debugging pipe and does not open a TCP port", () => {
  const launcher = fs.readFileSync(
    path.join(root, "src", "t3-rtl-launcher.js"),
    "utf8",
  );
  assert.match(launcher, /--remote-debugging-pipe/);
  assert.doesNotMatch(launcher, /--remote-debugging-port/);
});

test("the launcher uses T3 Code's bundled Node runtime", () => {
  const launcher = fs.readFileSync(
    path.join(root, "src", "t3-rtl-launcher.js"),
    "utf8",
  );
  const vbscript = fs.readFileSync(
    path.join(root, "src", "launch-t3-rtl.vbs"),
    "utf8",
  );
  const installer = fs.readFileSync(path.join(root, "install.ps1"), "utf8");
  assert.match(vbscript, /ELECTRON_RUN_AS_NODE/);
  assert.match(launcher, /delete t3Environment\.ELECTRON_RUN_AS_NODE/);
  assert.doesNotMatch(installer, /Get-Command node/);
});

test("the installer can run as a one-line command without a local clone", () => {
  const installer = fs.readFileSync(path.join(root, "install.ps1"), "utf8");
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8");
  assert.match(installer, /archive\/refs\/heads\/main\.zip/);
  assert.match(installer, /-UseBasicParsing/);
  assert.match(installer, /SecurityProtocolType\]::Tls12/);
  assert.match(readme, /irm 'https:\/\/raw\.githubusercontent\.com\/ShlomiPorush\/t3code-rtl-fix\/main\/install\.ps1' \| iex/);
});

test("the stylesheet uses content-aware alignment and logical RTL layout", () => {
  const css = fs.readFileSync(path.join(root, "src", "rtl.css"), "utf8");
  assert.match(css, /\.chat-markdown,[\s\S]*text-align:\s*start\s*!important/);
  assert.match(css, /pre,[\s\S]*code[\s\S]*direction:\s*ltr\s*!important/);
  assert.match(css, /padding-inline-start:/);
  assert.match(css, /border-inline-start:/);
  assert.match(css, /text-align:\s*start\s*!important/);
  assert.match(css, /data-t3-rtl-plan-card/);
  assert.match(
    css,
    /data-slot="collapsible-panel"[\s\S]*button[\s\S]*> :is\(kbd, svg:last-child\)[\s\S]*order:\s*-1/,
  );
  assert.doesNotMatch(css, /button\[dir=/);
  assert.doesNotMatch(css, /direction:\s*rtl\s*!important/);
});

test("quoted text comments follow the direction of the typed comment", () => {
  const css = fs.readFileSync(path.join(root, "src", "rtl.css"), "utf8");
  const source = buildInjectionSource("body { color: red; }");

  assert.match(css, /\[data-citation-comment-editor="true"\] textarea[\s\S]*unicode-bidi: plaintext/);
  assert.match(
    css,
    /\[data-citation-comment-editor="true"\]:has\(textarea:dir\(rtl\)\) > div[\s\S]*flex-direction: row-reverse/,
  );
  assert.match(css, /\[data-assistant-citation-chip="true"\] button[\s\S]*margin-inline-start:/);
  assert.match(source, /\[data-citation-comment-editor=\\"true\\"\] textarea/);
  assert.match(source, /\[data-assistant-citation-chip=\\"true\\"\] a > span/);
});

test("queued messages follow the direction of their prompt", () => {
  const css = fs.readFileSync(path.join(root, "src", "rtl.css"), "utf8");
  const source = buildInjectionSource("body { color: red; }");

  assert.match(source, /\[data-queued-message-id\] > div/);
  assert.match(css, /\[data-queued-message-id\][\s\S]*> div\[dir="rtl"\][\s\S]*text-align: right/);
  assert.match(css, /\[data-scroll-anchor-ignore\] > div:last-child[\s\S]*margin-inline-start: auto/);
  assert.doesNotMatch(css, /match-parent/);
});

test("composer paragraphs get a computed direction without editor attributes", () => {
  const css = fs.readFileSync(path.join(root, "src", "rtl.css"), "utf8");
  const source = buildInjectionSource("body { color: red; }");

  assert.doesNotMatch(css, /composer-tiptap/);
  assert.match(source, /composerParagraphDirection/);
  assert.match(source, /t3-rtl-fix-composer/);
  assert.match(source, /data-t3-rtl-composer/);
  assert.match(source, /> p:nth-child\(' \+ \(index \+ 1\)/);
  assert.doesNotMatch(source, /data-lexical/);
});

test("queued prompts and plan titles follow the current T3 Code markup", () => {
  const css = fs.readFileSync(path.join(root, "src", "rtl.css"), "utf8");
  const source = buildInjectionSource("body { color: red; }");

  assert.match(source, /\[data-queued-message-id\] \.chat-markdown p/);
  assert.match(source, /\[data-queued-message-id\] \.chat-markdown code/);
  assert.match(source, /> div:first-child :is\(p, h3\)/);
  assert.match(css, /\[data-queued-message-id\]\) \.chat-markdown/);
  assert.doesNotMatch(css, /whitespace-pre-wrap/);
  assert.doesNotMatch(css, /\[data-pending-user-input-toggle\]\s*> svg:last-child/);
});

test("the injected script auto-directs messages and observes new content", () => {
  const source = buildInjectionSource("body { color: red; }");
  assert.match(source, /\[data-message-role\] \.chat-markdown/);
  assert.match(source, /\[data-message-role\] \.chat-markdown p/);
  assert.match(source, /\[data-message-role\] \.chat-markdown h1/);
  assert.match(source, /\[data-message-role\] \.chat-markdown blockquote/);
  assert.match(source, /\[data-message-role\] \.chat-markdown li/);
  assert.match(source, /\[data-message-role\] \.chat-markdown strong/);
  assert.match(source, /\[data-message-role\] \.chat-markdown em/);
  assert.match(source, /\.chat-markdown a:not\(\.chat-markdown-file-link\)/);
  assert.match(source, /\.chat-markdown \.chat-markdown-table-container/);
  assert.match(source, /data-pending-user-input-toggle/);
  assert.match(source, /data-slot=\\"collapsible-panel\\"/);
  assert.match(source, /data-t3-rtl-plan-card/);
  assert.match(source, /data-t3-rtl-turn-plan/);
  assert.match(source, /data-composer-tasks-badge/);
  assert.match(source, /data-chat-composer-tasks-drawer/);
  assert.match(source, /Plan actions/);
  assert.match(source, /markPlanCards/);
  assert.match(source, /markTurnPlans/);
  assert.match(source, /proseDirection/);
  assert.match(source, /matches\("textarea, input"\) \? "auto" : proseDirection\(element\)/);
  assert.match(source, /removeAttribute\("dir"\)/);
  assert.match(source, /setDirection\(root, ltrDirectionSelector, "ltr"\)/);
  assert.match(source, /characterData: true/);
  assert.match(source, /new MutationObserver/);
  assert.match(source, /body \{ color: red; \}/);
});

test("pull request markdown receives content-aware direction", () => {
  const css = fs.readFileSync(path.join(root, "src", "rtl.css"), "utf8");
  const source = buildInjectionSource("body { color: red; }");

  assert.match(css, /data-pull-request-summary-scroll[\s\S]*\.chat-markdown/);
  assert.match(source, /\[data-pull-request-summary-scroll\] \.chat-markdown p/);
  assert.match(source, /\[data-pull-request-summary-scroll\] \.chat-markdown code/);
});

test("rendered markdown files receive content-aware direction", () => {
  const css = fs.readFileSync(path.join(root, "src", "rtl.css"), "utf8");
  const source = buildInjectionSource("body { color: red; }");

  assert.match(css, /data-preview-panel-mode[\s\S]*Show markdown source[\s\S]*\.chat-markdown/);
  assert.match(
    source,
    /\[data-preview-panel-mode\]:has\(\[aria-label=\\"Show markdown source\\"\]\) \.chat-markdown p/,
  );
  assert.match(
    source,
    /\[data-preview-panel-mode\]:has\(\[aria-label=\\"Show markdown source\\"\]\) \.chat-markdown code/,
  );
});

test("every shipped source file contains only English UI text", () => {
  const files = [
    "README.md",
    "install.ps1",
    "uninstall.ps1",
    path.join("tests", "windows-powershell-compatibility.ps1"),
    path.join("src", "launch-t3-rtl.vbs"),
    path.join("src", "injection.js"),
    path.join("src", "t3-rtl-launcher.js"),
    path.join("src", "rtl.css"),
    "install-mac.sh",
    "uninstall-mac.sh",
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(text, /[\u0590-\u05FF]/, `${file} contains Hebrew text`);
  }
});
