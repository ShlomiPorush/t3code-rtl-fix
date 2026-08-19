"use strict";

const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

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

test("the RTL stylesheet preserves left-to-right code blocks", () => {
  const css = fs.readFileSync(path.join(root, "src", "rtl.css"), "utf8");
  assert.match(css, /direction:\s*rtl\s*!important/);
  assert.match(css, /pre,[\s\S]*code[\s\S]*direction:\s*ltr\s*!important/);
});

test("every shipped source file contains only English UI text", () => {
  const files = [
    "README.md",
    "install.ps1",
    "uninstall.ps1",
    path.join("tests", "windows-powershell-compatibility.ps1"),
    path.join("src", "launch-t3-rtl.vbs"),
    path.join("src", "t3-rtl-launcher.js"),
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), "utf8");
    assert.doesNotMatch(text, /[\u0590-\u05FF]/, `${file} contains Hebrew text`);
  }
});
