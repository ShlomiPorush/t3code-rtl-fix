"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mirrorCss } = require("../src/css-mirror");

const mirror = (css, options) => mirrorCss(css, options).css;

test("renames physical sides in place and keeps the order", () => {
  assert.equal(
    mirror(".a{margin-left:4px;margin-inline-start:8px}.b{padding-right:1rem!important;color:red}"),
    ".a{margin-inline-start:4px;margin-inline-start:8px}.b{padding-inline-end:1rem!important;color:red}",
  );
  assert.equal(
    mirror(".c{margin-inline-start:8px;margin-left:4px}"),
    ".c{margin-inline-start:8px;margin-inline-start:4px}",
  );
});

test("keeps a var() shorthand and renames only the side after it", () => {
  assert.equal(
    mirror(".a{margin:var(--m);margin-left:2px}"),
    ".a{margin:var(--m);margin-inline-start:2px}",
  );
  assert.equal(mirror(".a{border-color:var(--border)}"), ".a{border-color:var(--border)}");
});

test("renames insets, borders, and corner radii", () => {
  assert.equal(
    mirror(".a{left:0;right:auto;border-left-width:1px;border-right-color:red;border-top-left-radius:4px;border-bottom-right-radius:2px}"),
    ".a{inset-inline-start:0;inset-inline-end:auto;border-inline-start-width:1px;border-inline-end-color:red;border-start-start-radius:4px;border-end-end-radius:2px}",
  );
});

test("mirrors text-align left and right only", () => {
  assert.equal(
    mirror(".a{text-align:left}.b{text-align:right !important}.c{text-align:center}"),
    ".a{text-align:start}.b{text-align:end !important}.c{text-align:center}",
  );
});

test("splits literal four-value shorthands with different sides", () => {
  assert.equal(mirror(".a{margin:0 4px 0 0}"), ".a{margin-block:0 0;margin-inline:0 4px}");
  assert.equal(mirror(".a{padding:1px 2px 3px 2px}"), ".a{padding:1px 2px 3px 2px}");
  assert.equal(mirror(".a{margin:0 calc(1px + 2px) 0 0}"), ".a{margin:0 calc(1px + 2px) 0 0}");
  assert.equal(
    mirror(".a{border-radius:4px 0 0 4px}"),
    ".a{border-start-start-radius:4px;border-start-end-radius:0;border-end-end-radius:0;border-end-start-radius:4px}",
  );
  assert.equal(mirror(".a{border-radius:4px 4px 0 0}"), ".a{border-radius:4px 4px 0 0}");
});

test("works inside at-rules, layers, and nested rules", () => {
  assert.equal(
    mirror("@layer utilities{@media (width>=40rem){.sm\\:pl-2{padding-left:.5rem}}}"),
    "@layer utilities{@media (width>=40rem){.sm\\:pl-2{padding-inline-start:.5rem}}}",
  );
  assert.equal(
    mirror(".a{color:red;&:hover{margin-right:1px}left:0}"),
    ".a{color:red;&:hover{margin-inline-end:1px}inset-inline-start:0}",
  );
  assert.equal(
    mirror("@container x (width>1px){.a:is(:hover){right:0}}"),
    "@container x (width>1px){.a:is(:hover){inset-inline-end:0}}",
  );
});

test("reads escaped characters in class names as text", () => {
  assert.equal(
    mirror(".\\[\\&\\:has\\(\\[role\\=checkbox\\]\\)\\]\\:pr-0:has([role=checkbox]){padding-right:0}.sm\\:pr-4{padding-right:1rem}"),
    ".\\[\\&\\:has\\(\\[role\\=checkbox\\]\\)\\]\\:pr-0:has([role=checkbox]){padding-inline-end:0}.sm\\:pr-4{padding-inline-end:1rem}",
  );
});

test("does not touch selectors, strings, comments, or custom properties", () => {
  const css = '.left\\:x:hover{--left:1px;content:"margin-left:1px;}"}/* right:0; */.b{background:url("a;b.png")}';
  assert.equal(mirror(css), css);
});

test("keeps room for the window's buttons only where a header ends on the right", () => {
  assert.equal(
    mirror(".wco\:pr-x:is(.wco,.wco *){padding-right:var(--workspace-native-controls-inset)}"),
    ".wco\:pr-x:is(.wco,.wco *){padding-inline-end:calc(var(--workspace-native-controls-inset) * (1 + var(--t3-rtl-x, 1)) / 2)}",
  );
  const kept = "@media (display-mode:window-controls-overlay){.t{padding-right:env(titlebar-area-x)}}";
  assert.equal(mirror(kept), kept);
  assert.equal(mirror(".wco .z{margin-left:1px}"), ".wco .z{margin-inline-start:1px}");
});

test("widens the room beside the sidebar's buttons by the window's buttons on the right", () => {
  assert.equal(
    mirror(".logo{margin-left:var(--workspace-titlebar-content-left)}"),
    ".logo{margin-inline-start:calc(var(--workspace-titlebar-content-left) + (var(--workspace-controls-right) - var(--workspace-controls-left)) * (1 - var(--t3-rtl-x, 1)) / 2)}",
  );
});

test("moves a mirrored control to the window inset of its new side", () => {
  assert.equal(
    mirror(".a{left:var(--workspace-controls-left)}.b{margin-left:calc(var(--workspace-controls-left) + 1px - env(safe-area-inset-left))}"),
    ".a{inset-inline-start:calc(var(--workspace-controls-left) * (1 + var(--t3-rtl-x, 1)) / 2 + var(--workspace-controls-right) * (1 - var(--t3-rtl-x, 1)) / 2)}" +
      ".b{margin-inline-start:calc(calc(var(--workspace-controls-left) * (1 + var(--t3-rtl-x, 1)) / 2 + var(--workspace-controls-right) * (1 - var(--t3-rtl-x, 1)) / 2) + 1px - calc(env(safe-area-inset-left) * (1 + var(--t3-rtl-x, 1)) / 2 + env(safe-area-inset-right) * (1 - var(--t3-rtl-x, 1)) / 2))}",
  );
});

test("leaves the room for the details card logical, so it follows the card", () => {
  const css = ".lane{padding-inline-start:var(--chat-lane-inset-start,0px);padding-inline-end:calc(.75rem + var(--chat-lane-inset-end,0px))}";
  assert.equal(mirror(css), css);
});

test("moves mirrored elements sideways the other way", () => {
  assert.equal(
    mirror(".a{--tw-translate-x:calc(1 / 2 * 100%);translate:var(--tw-translate-x) var(--tw-translate-y)}.b{--tw-translate-x:0}"),
    ".a{--tw-translate-x:calc(var(--t3-rtl-x, 1) * (calc(1 / 2 * 100%)));translate:var(--tw-translate-x) var(--tw-translate-y)}.b{--tw-translate-x:0}",
  );
});

test("finds an import after a comment and leaves generated content alone", () => {
  assert.equal(mirrorCss('/* note */@import "x.css";.a{left:0}').imports, true);
  assert.equal(
    mirror('.a{content:"url(example.png)"}', { baseUrl: "t3code://app/assets/main.css" }),
    '.a{content:"url(example.png)"}',
  );
  assert.equal(
    mirror('.a{content:url(icon.png) " url(x)"}', { baseUrl: "t3code://app/assets/main.css" }),
    '.a{content:url(t3code://app/assets/icon.png) " url(x)"}',
  );
  assert.equal(
    mirror('.a{content:url("icon.png")}', { baseUrl: "t3code://app/assets/main.css" }),
    '.a{content:url("t3code://app/assets/icon.png")}',
  );
  assert.equal(
    mirror('.a{background:URL("icon(2).png")}', { baseUrl: "t3code://app/assets/main.css" }),
    '.a{background:url("t3code://app/assets/icon(2).png")}',
  );
  assert.equal(
    mirror('.a{background:url("im\\61 ge.png")}', { baseUrl: "t3code://app/assets/main.css" }),
    '.a{background:url("im\\61 ge.png")}',
  );
});

test("lets a mirrored icon turn the other way", () => {
  assert.equal(
    mirror(".rotate-90{rotate:90deg}.a{rotate:var(--r)}.b{rotate:x 45deg}"),
    ".rotate-90{rotate:calc(90deg * var(--t3-rtl-turn, 1))}.a{rotate:var(--r)}.b{rotate:x 45deg}",
  );
});

test("leaves notifications physical", () => {
  const css = ".data-\\[position\\*\\=left\\]\\:left-0[data-position*=left]{left:0}.t{transform:translateX(var(--toast-swipe-movement-x));right:var(--toast-inset)}";
  assert.equal(mirror(css), css);
});

test("leaves font descriptors alone", () => {
  const css = "@font-face{font-family:x;src:url(/a.woff2)}";
  assert.equal(mirror(css), css);
});

test("adds a logical twin to transition lists", () => {
  assert.equal(
    mirror(".a{transition-property:padding-left;transition-duration:.2s}"),
    ".a{transition-property:padding-left,padding-inline-start;transition-duration:.2s}",
  );
  assert.equal(
    mirror(".a{transition:left .2s ease,opacity .1s}"),
    ".a{transition:left .2s ease,inset-inline-start .2s ease,opacity .1s}",
  );
  assert.equal(mirror(".a{transition-property:var(--x)}"), ".a{transition-property:var(--x)}");
});

test("resolves relative urls against the stylesheet address", () => {
  assert.equal(
    mirror(".a{background:url(img/x.png);src:url('/f.woff2')}", { baseUrl: "t3code://app/assets/main.css" }),
    ".a{background:url(t3code://app/assets/img/x.png);src:url('/f.woff2')}",
  );
});

test("reports changes and imports", () => {
  assert.equal(mirrorCss(".a{color:red}").changed, 0);
  assert.equal(mirrorCss(".a{left:0}").changed, 1);
  assert.equal(mirrorCss('@import "x.css";.a{left:0}').imports, true);
  assert.equal(mirrorCss(".a{left:0}").imports, false);
});

test("runs as source text with no outside references", () => {
  const rebuilt = new Function(`return (${mirrorCss.toString()})`)();
  assert.equal(rebuilt(".a{left:0}").css, ".a{inset-inline-start:0}");
});
