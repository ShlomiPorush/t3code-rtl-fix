"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { patchSidebarPopups } = require("../src/sidebar-popups");

const POPUPS = [
  "function sidebarPopupSides(n,$,xt,pv,iv,jV,Qn,Pt,Yt){return[",
  "(0,$.jsx)(xt,{side:`right`,render:(0,$.jsx)(`button`,{type:`button`,\"aria-label\":n(`Un-settle thread`),onClick:Yt})}).side,",
  "(0,$.jsx)(xt,{side:`right`,render:(0,$.jsx)(`button`,{type:`button`,\"aria-label\":n(`Settle thread`),onClick:Yt})}).side,",
  "(0,$.jsxs)(xt,{side:`right`,render:(0,$.jsx)(`button`,{type:`button`,\"aria-label\":n(`Settle thread`),onClick:Yt})}).side,",
  "(0,$.jsx)(pv,{render:(0,$.jsx)(Qn,{}),onOpenList:Yt,onOpenPullRequest:Pt,side:`right`}).side,",
  "(0,$.jsxs)(iv,{text:1,side:`right`,children:[(0,$.jsx)(jV,{links:[].slice(0,8),compact:!1,mountScope:`sidebar-tooltip`})]}).side,",
  "(0,$.jsx)(xt,{side:`right`,render:(0,$.jsx)(`button`,{type:`button`,\"aria-label\":n(`Rename thread`)})}).side,",
  "(0,$.jsx)(xt,{side:`left`,render:(0,$.jsx)(`button`,{type:`button`,\"aria-label\":n(`Settle thread`)})}).side",
  "]}",
].join("\n");

function sidesIn(source, layout) {
  const document = {
    documentElement: { getAttribute: (name) => (name === "data-t3-rtl-app" ? layout : null) },
  };
  const sides = new Function("document", `${source}\nreturn sidebarPopupSides;`)(document);
  const jsx = (type, props) => props;
  return sides((text) => text, { jsx, jsxs: jsx }, "xt", "pv", "iv", "jV", "Qn", () => {}, () => {});
}

const T3_SIDES = ["right", "right", "right", "right", "right", "right", "left"];

test("the popups of a sidebar row open toward the conversation in the mirrored layout", () => {
  const result = patchSidebarPopups(POPUPS);
  assert.equal(result.applied, true, result.problem);
  assert.deepEqual(sidesIn(POPUPS, "on"), T3_SIDES);
  assert.deepEqual(sidesIn(result.source, "on"), ["left", "left", "left", "left", "left", "right", "left"]);
});

test("outside the mirrored layout the popups keep T3 Code's side", () => {
  const { source } = patchSidebarPopups(POPUPS);
  for (const layout of ["off", null]) assert.deepEqual(sidesIn(source, layout), T3_SIDES, String(layout));
});

test("code without such popups, as in T3 Code 0.1.12, is left as it is", () => {
  const code = "let I=(0,$.jsx)(C,{side:`right`,align:`start`,sideOffset:4,children:F});";
  assert.deepEqual(patchSidebarPopups(code), { applied: false, source: code, problem: "no popup of a sidebar row opens to the right" });
  const patched = patchSidebarPopups(POPUPS).source;
  assert.equal(patchSidebarPopups(patched).applied, false);
});
