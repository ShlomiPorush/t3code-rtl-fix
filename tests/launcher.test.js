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

test("the stylesheet uses content-aware alignment and logical RTL layout", () => {
  const css = fs.readFileSync(path.join(root, "src", "rtl.css"), "utf8");
  assert.match(css, /\.chat-markdown,[\s\S]*text-align:\s*start\s*!important/);
  assert.match(css, /pre,[\s\S]*code[\s\S]*direction:\s*ltr\s*!important/);
  assert.match(css, /padding-inline-start:/);
  assert.match(css, /border-inline-start:/);
  assert.match(css, /text-align:\s*start\s*!important/);
  assert.doesNotMatch(css, /direction:\s*rtl\s*!important/);
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
  assert.match(source, /hasRtlProse/);
  assert.match(source, /hasRtlProse\(element\) \? "rtl" : "auto"/);
  assert.match(source, /setDirection\(root, ltrDirectionSelector, "ltr"\)/);
  assert.match(source, /characterData: true/);
  assert.match(source, /new MutationObserver/);
  assert.match(source, /body \{ color: red; \}/);
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
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(text, /[\u0590-\u05FF]/, `${file} contains Hebrew text`);
  }
});
