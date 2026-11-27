"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { CARDS_URL, CARDS_URL_PATTERN, patchCardAlignment, patchSidebarPopups } = require("../src/sidebar-popups");

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

const CARD =
  "function sn(e){let t=[],{side:o}=e,c=o===void 0?`top`:o,l;t[0]===c?l=t[1]:(l=c===`right`?{align:`start`}:{},t[0]=c,t[1]=l);return l}";
const alignmentIn = (source, side) => new Function(`${source}\nreturn sn;`)()({ side });

test("an issue or pull request card that opens to the left keeps the alignment T3 Code gives it on the right", () => {
  const result = patchCardAlignment(CARD);
  assert.equal(result.applied, true, result.problem);
  assert.deepEqual(alignmentIn(CARD, "left"), {});
  for (const side of ["right", "left"]) assert.deepEqual(alignmentIn(result.source, side), { align: "start" }, side);
  for (const side of ["top", undefined]) assert.deepEqual(alignmentIn(result.source, side), {}, String(side));
});

test("the card alignment is changed only where it is found exactly once", () => {
  for (const code of ["let l={};", `${CARD}${CARD.replace("function sn", "function sm")}`]) {
    const result = patchCardAlignment(code);
    assert.equal(result.applied, false);
    assert.equal(result.source, code);
  }
  assert.equal(patchCardAlignment(patchCardAlignment(CARD).source).applied, false);
});

test("the card script's address matches the pattern the browser watches", () => {
  assert.equal(CARDS_URL_PATTERN, "t3code://app/assets/issuePresentation-*.js");
  assert.ok(CARDS_URL.test("t3code://app/assets/issuePresentation-MEUMiYYk.js"));
  assert.ok(!CARDS_URL.test("t3code://app/assets/main-GgskcymW.js"));
});
