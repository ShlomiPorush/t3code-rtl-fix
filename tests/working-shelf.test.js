"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { URL_PATTERN, patchSidebarChunk, createWorkingShelfService } = require("../src/working-shelf");

// A small stand-in for T3 Code's sidebar code, with every site the patch
// changes written the way T3 Code 0.0.3 minifies it, and runnable, so a
// patch that breaks a name fails here and not only in the app.
//
// T3 Code's row component for rows that are not cards, cut down to the
// project icon and the row's class, with its cache t kept across renders.
const ROW_FLAGS = "if(C!==`card`){let r=C===`folder-multiline`,a=C===`folder`||r,";
const ROW_ICON =
  "t[195]!==a||t[196]!==e.isActive||t[197]!==e.project||t[198]!==w?(d=a?null:(0,Z.jsx)(`span`,{className:Y(`flex shrink-0 items-center transition-opacity`," +
  "(!e.isActive||w===`unsettle`)&&`opacity-40 grayscale`),children:e.project?(0,Z.jsx)(Lw,{project:e.project,className:`size-4`}):null})," +
  "t[195]=a,t[196]=e.isActive,t[197]=e.project,t[198]=w,t[199]=d):d=t[199];";
const ROW_INDENT =
  '"data-sidebar-parent":e.navigationParent,"data-testid":a?`sidebar-row-folder`:`sidebar-row-slim`,' +
  "className:Y(Ft,r?`flex flex-col justify-center px-2.5 py-1.5`:`flex h-9 items-center gap-2.5 px-2.5`,a&&`ps-9`)";
const ROW_COMPONENT =
  "function rowLook(t,C,e,w){const Z={jsx:(c,p)=>p},Lw=0,Ft=`row`,Y=(...v)=>v.filter(Boolean).join(` `);" +
  `${ROW_FLAGS}d;${ROW_ICON}return{icon:d,row:{${ROW_INDENT}}}}return null}`;

const FIXTURE = [
  ROW_COMPONENT,
  "let SETTINGS={sidebarWorkingShelfEnabled:true};",
  "function setWorking(v){SETTINGS={sidebarWorkingShelfEnabled:v}}",
  "function DK(e){return e.sidebarWorkingShelfEnabled}",
  "function dp(e){return e(SETTINGS)}",
  "function wK(e){return e.threads}",
  "function hK(e,t){return t===null?[]:e.filter(n=>n===t)}",
  "function gK(e){let t=0,{threads:s,routeRowThreadKey:l,folderGroups:u,keepEmptyFolders:d}=e,f=dp(DK)&&u===null,p=1;",
  "let{pinnedThreads:k,activeThreads:A,workingThreads:j,snoozedThreads:M,settledThreads:N}=e.lists,b=e.expanded,",
  "ee=M,V=N,H=b?j:hK(j,l),U=u===null?null:u.map(g=>({group:g,collapsed:!1,threads:g.threads,hiddenThreads:[]}))," +
    "W=[...k,...U===null?A:U.flatMap(wK),...H,...ee,...V],te=0;" +
    "return{...e,threads:s,workingShelfEnabled:f,projectFolders:U,orderedThreadKeys:W.map(x=>x)}}",
  "function GK(Un,r,Dn,On,Y){let t=[],Gi=Un!==null&&Un.length>0,Ki;{let p={kind:`marker`,marker:`settled-placeholder`},z=[...r,p];Ki=z}let qi=Ki,Ji;" +
    "t[0]===qi?Ji=t[1]:(Ji=qi.map(e=>e.kind===`thread`?e.key:e.marker),t[0]=qi,t[1]=Ji);",
  "const rendered=[];for(let i of qi)if(i.kind===`thread`){if(Un!==null&&i.section===`active`)continue;rendered.push(i.key)}",
  "const headers=[{marker:`working-header`,className:`mt-auto`},{marker:`snoozed-header`,className:Y(Dn.length===0&&`mt-auto`)},{marker:`settled-header`,className:Y(Dn.length+On.length===0&&`mt-auto`)}];",
  "const ce=!1,Z={jsx:(c,p)=>p.variant},xG=0,look=(e,t,n)=>{let r=1,a=n?ce?`folder-multiline`:`folder`:t===`active`||t===`pinned`||t===`working`?`card`:`slim`;return(0,Z.jsx)(xG,{thread:e,variant:a,navigationParent:n??(t===`working`||t===`snoozed`||t===`settled`?`shelf:${t}`:void 0)})};",
  "return{Ji,rendered,headers,Gi,look}}",
].join("\n");

const WORKING = { working: true, done: false };

function load(source) {
  const loaded = new Function(`${source}\nreturn { setWorking, gK, GK, rowLook };`)();
  const Y = (value) => value || undefined;
  return {
    setWorking: loaded.setWorking,
    gK: loaded.gK,
    rowsOf: (folders, list) => loaded.GK(folders, list, [], [], Y),
    render: (folders, list) => loaded.GK(folders, list, [], [], Y).rendered,
    headers: (folders, working, snoozed) => loaded.GK(folders, [], working, snoozed, Y).headers,
    look: (folders, section, inFolder) => loaded.GK(folders, [], [], [], Y).look({}, section, inFolder),
    rowLook: loaded.rowLook,
  };
}

const rows = [
  { kind: "marker", marker: "pinned-header" },
  { kind: "thread", key: "p1", section: "pinned" },
  { kind: "marker", marker: "pinned-divider" },
  { kind: "marker", marker: "active-placeholder" },
  { kind: "thread", key: "a1", section: "active" },
  { kind: "marker", marker: "working-header" },
  { kind: "thread", key: "w1", section: "working" },
  { kind: "thread", key: "w2", section: "working" },
  { kind: "marker", marker: "settled-header" },
];
const hookInput = (folderGroups) => ({
  threads: [],
  routeRowThreadKey: null,
  folderGroups,
  expanded: true,
  lists: { pinnedThreads: ["p1"], activeThreads: ["a1"], workingThreads: ["w1", "w2"], snoozedThreads: ["s1"], settledThreads: ["d1"] },
});

test("the patch shows the Working section with project folders and keeps T3 Code's own setting", () => {
  const result = patchSidebarChunk(FIXTURE, WORKING);
  assert.equal(result.applied, true, result.problem);
  const original = load(FIXTURE);
  const patched = load(result.source);
  const folders = [{ threads: ["a1"] }];

  assert.equal(original.gK(hookInput(folders)).workingShelfEnabled, false);
  assert.equal(patched.gK(hookInput(folders)).workingShelfEnabled, true);
  assert.equal(patched.gK(hookInput(null)).workingShelfEnabled, true);
  patched.setWorking(false);
  assert.equal(patched.gK(hookInput(folders)).workingShelfEnabled, false, "T3 Code's own setting still turns it off");
  assert.equal(patched.gK(hookInput(null)).workingShelfEnabled, false);
});

test("with project folders, Working comes first in the keyboard order; without, the order is T3 Code's", () => {
  const { source } = patchSidebarChunk(FIXTURE, WORKING);
  const original = load(FIXTURE);
  const patched = load(source);
  const folders = [{ threads: ["a1"] }];
  assert.deepEqual(patched.gK(hookInput(folders)).orderedThreadKeys, ["w1", "w2", "p1", "a1", "s1", "d1"]);
  assert.deepEqual(patched.gK(hookInput(null)).orderedThreadKeys, original.gK(hookInput(null)).orderedThreadKeys);
  assert.deepEqual(patched.gK(hookInput(null)).orderedThreadKeys, ["p1", "a1", "w1", "w2", "s1", "d1"]);
});

test("with project folders, the Working header and rows move above Pinned; without, nothing moves", () => {
  const { source } = patchSidebarChunk(FIXTURE, WORKING);
  const original = load(FIXTURE);
  const patched = load(source);
  assert.deepEqual(patched.rowsOf([], rows).Ji, [
    "working-header", "w1", "w2", "pinned-header", "p1", "pinned-divider", "active-placeholder", "a1", "settled-header", "settled-placeholder",
  ]);
  assert.deepEqual(patched.rowsOf(null, rows).Ji, original.rowsOf(null, rows).Ji);
  const noWorking = rows.filter((row) => row.section !== "working" && row.marker !== "working-header");
  assert.deepEqual(patched.rowsOf([], noWorking).Ji, original.rowsOf([], noWorking).Ji);
  // The rows rendered in folders skip active threads as before.
  assert.deepEqual(patched.render([], rows), ["w1", "w2", "p1"]);
  assert.deepEqual(patched.render(null, rows), original.render(null, rows));
});

test("with project folders, the first shelf at the bottom is Snoozed or Settled", () => {
  const { source } = patchSidebarChunk(FIXTURE, WORKING);
  const original = load(FIXTURE);
  const patched = load(source);
  const classes = (fn, folders, working, snoozed) => fn(folders, working, snoozed).map((header) => header.className);
  // Folders: Working sits at the top, so it no longer pushes the shelves down.
  assert.deepEqual(classes(patched.headers, [], [1], [1]), [undefined, "mt-auto", undefined]);
  assert.deepEqual(classes(patched.headers, [], [1], []), [undefined, "mt-auto", "mt-auto"]);
  // No folders: exactly as T3 Code has it.
  for (const [working, snoozed] of [[[1], [1]], [[], [1]], [[], []], [[1], []]]) {
    assert.deepEqual(classes(patched.headers, null, working, snoozed), classes(original.headers, null, working, snoozed));
  }
});

test("with project folders, Working rows look like folder rows; without, rows look as T3 Code has them", () => {
  const { source } = patchSidebarChunk(FIXTURE, WORKING);
  const original = load(FIXTURE);
  const patched = load(source);
  assert.equal(original.look([], "working", false), "card");
  assert.equal(patched.look([], "working", false), "folder");
  for (const folders of [[], null]) {
    for (const section of ["active", "pinned", "working", "snoozed", "settled"]) {
      for (const inFolder of [true, false]) {
        if (folders !== null && section === "working" && !inFolder) continue;
        assert.equal(patched.look(folders, section, inFolder), original.look(folders, section, inFolder), `${section} ${inFolder}`);
      }
    }
  }
});

test("a Working folder row shows its project icon in the place of the indent; other rows look as T3 Code has them", () => {
  const { source } = patchSidebarChunk(FIXTURE, WORKING);
  const original = load(FIXTURE);
  const patched = load(source);
  const props = (navigationParent, isActive) => ({ navigationParent, isActive, project: "P" });
  for (const variant of ["folder", "folder-multiline"]) {
    for (const isActive of [true, false]) {
      const row = patched.rowLook([], variant, props("shelf:working", isActive), "settle");
      assert.deepEqual(row.icon, { className: "flex shrink-0 items-center transition-opacity", children: { project: "P", className: "size-4" } });
      assert.doesNotMatch(row.row.className, /ps-9/);
      assert.equal(original.rowLook([], variant, props("shelf:working", isActive), "settle").icon, null);
    }
  }
  for (const variant of ["folder", "folder-multiline", "slim"]) {
    for (const parent of ["project:x", "shelf:snoozed", "shelf:settled", undefined]) {
      for (const isActive of [true, false]) {
        for (const action of ["settle", "unsettle", "unsnooze"]) {
          const args = [variant, props(parent, isActive), action];
          assert.deepEqual(patched.rowLook([], ...args), original.rowLook([], ...args), `${args.join(" ")}`);
        }
      }
    }
  }
  // T3 Code keeps a row when its thread moves between Working and its folder.
  const cache = [];
  assert.notEqual(patched.rowLook(cache, "folder", props("shelf:working", false), "settle").icon, null);
  assert.equal(patched.rowLook(cache, "folder", props("project:x", false), "settle").icon, null);
  assert.notEqual(patched.rowLook(cache, "folder", props("shelf:working", false), "settle").icon, null);
});

test("the patch changes nothing unless every site matches exactly once", () => {
  // Each site: the text in the fixture, a change that breaks it, and a second
  // copy that matches it again.
  const sites = [
    ["return e.sidebarWorkingShelfEnabled}", "return e.sidebarWorkingShelfOn}", "function DK2(e){return e.sidebarWorkingShelfEnabled}"],
    ["f=dp(DK)&&u===null,", "f=dp(DK)&&u==null,", "function g2(e){let{folderGroups:u}=e,f=dp(DK)&&u===null,p=1}"],
    ["pinnedThreads:k,", "pinnedThreadz:k,", ";let{pinnedThreads:z}=0;"],
    ["activeThreads:A,", "activeThreadz:A,", ";let{activeThreads:z}=0;"],
    ["workingThreads:j,", "workingThreadz:j,", ";let{workingThreads:z}=0;"],
    ["H=b?j:hK(j,l)", "H=b?j:hK(M,l)", ";H2=b?j:hK(j,l);"],
    ["U=u===null?null:", "U=u==null?null:", ";U=u===null?null:0;"],
    ["W=[...k,...U===null?A:U.flatMap(wK),...H,", "W=[...k,...U==null?A:U.flatMap(wK),...H,", ";W=[...k,...U===null?A:U.flatMap(wK),...H,0];"],
    ["Gi=Un!==null&&Un.length>0,Ki;", "Gi=Un!=null&&Un.length>0,Ki;", ";let Gx=Un!==null&&Un.length>0,Kx;"],
    ["}let qi=Ki,Ji;", "}var qi=Ki,Ji;", "Ki=z}let qi=Ki,Ji;t[0]===qi?Ji=t[1]:(Ji=qi.map(0));"],
    ["if(Un!==null&&i.section===`active`)continue", "if(Un!=null&&i.section===`active`)continue", "if(Un!==null&&i.section===`active`)continue;"],
    ["marker:`working-header`,className:`mt-auto`", "marker:`working-header`,className:`mt-4`", "[{marker:`working-header`,className:`mt-auto`}];"],
    ["Y(Dn.length===0&&`mt-auto`)", "Y(Dn.length<1&&`mt-auto`)", "[{marker:`snoozed-header`,className:Y(Dn.length===0&&`mt-auto`)}];"],
    ["Y(Dn.length+On.length===0&&`mt-auto`)", "Y(Dn.length+On.length<1&&`mt-auto`)", "[{marker:`settled-header`,className:Y(Dn.length+On.length===0&&`mt-auto`)}];"],
    [
      "t===`active`||t===`pinned`||t===`working`?`card`:`slim`",
      "t===`active`||t===`pinned`?`card`:`slim`",
      ";const l2=(e,t,n)=>{let r=0,a=n?ce?`folder-multiline`:`folder`:t===`active`||t===`pinned`||t===`working`?`card`:`slim`;return(0,Z.jsx)(xG,{variant:a})};",
    ],
    [
      "navigationParent:n??(t===`working`",
      "navigationParent:n??(t===`busy`",
      ";const p2={navigationParent:n??(t===`working`?`shelf:${t}`:void 0)};",
    ],
    [ROW_FLAGS, ROW_FLAGS.replace("||r,", ","), `;function rl2(C){${ROW_FLAGS}d}}`],
    ["(d=a?null:", "(d=a?void 0:", `;function rl3(t,C,e,w){${ROW_FLAGS}d;${ROW_ICON}}}`],
    ["a&&`ps-9`)", "a&&`ps-8`)", `;function rl4(e,r,a){return{${ROW_INDENT}}}`],
  ];
  for (const [site, broken, copy] of sites) {
    assert.equal(FIXTURE.split(site).length, 2, `the fixture has ${site} once`);
    const missing = FIXTURE.replace(site, broken);
    const result = patchSidebarChunk(missing, WORKING);
    assert.equal(result.applied, false, `missing ${site}`);
    assert.equal(result.source, missing, `missing ${site} leaves the code byte for byte`);
    const doubled = `${FIXTURE}\n${copy}`;
    const twice = patchSidebarChunk(doubled, WORKING);
    assert.equal(twice.applied, false, `doubled ${site}`);
    assert.equal(twice.source, doubled, `doubled ${site} leaves the code byte for byte`);
  }
  // Names read at one place must be the ones used at the other: the gate
  // tests the folder groups, the keyboard order moves the Working rows, and
  // the sidebar's sites share one function.
  const variants = [
    FIXTURE.replace("f=dp(DK)&&u===null,", "f=dp(DK)&&d===null,"),
    FIXTURE.replace("W=[...k,...U===null?A:U.flatMap(wK),...H,", "W=[...k,...U===null?A:U.flatMap(wK),...ee,"),
    FIXTURE.replace("ee=M,V=N,H=b?j:hK(j,l),", "ee=M,V=N,H=b?j:hK(j,l),Z=[],").replace("U.flatMap(wK),...H,", "U.flatMap(wK),...Z,...H,"),
    FIXTURE.replace("const rendered=[];", "function inner(Un){}const rendered=[];"),
    FIXTURE.replace("let qi=Ki,Ji;", "let x=0,y;let qi=Ki,Ji;"),
    FIXTURE.replace("W=[...k,", "W=function(){},X=[...k,"),
    // The keyboard order is built elsewhere, so the moved list is not it.
    FIXTURE.replace("orderedThreadKeys:W.map(x=>x)", "orderedThreadKeys:k.concat(A,H)"),
    FIXTURE.replace(
      "return{...e,threads:s,workingShelfEnabled:f,projectFolders:U,orderedThreadKeys:W.map(x=>x)}",
      "let helper={orderedThreadKeys:W.map(x=>x)};return{...e,threads:s,workingShelfEnabled:f,projectFolders:U,orderedThreadKeys:k.concat(A,H)}",
    ),
    FIXTURE.replace(
      "return{...e,threads:s,workingShelfEnabled:f,projectFolders:U,orderedThreadKeys:W.map(x=>x)}",
      "let base={...e,threads:s,workingShelfEnabled:f,projectFolders:U,orderedThreadKeys:W.map(x=>x)};return{...base,orderedThreadKeys:k.concat(A,H)}",
    ),
    // The rows and folders are not declared together by let.
    FIXTURE.replace("let t=[],Gi=Un!==null&&Un.length>0,Ki;", "let t=[],Ki;t=0,Gi=Un!==null&&Un.length>0,Ki;"),
    // The look is not the one the row is rendered with.
    FIXTURE.replace("{thread:e,variant:a,", "{thread:e,variant:r,"),
    FIXTURE.replace("{thread:e,variant:a,", "{savedvariant:a,variant:r,"),
    FIXTURE.replace("`slim`;return(0,Z.jsx)", "`slim`;a=`card`;return(0,Z.jsx)"),
    // The Working parent is not the rendered row's.
    FIXTURE.replace("navigationParent:n??(t===`working`", "navigationParent:r??(t===`working`"),
    FIXTURE.replace("variant:a,navigationParent:", "variant:a},{navigationParent:"),
    FIXTURE.replace("variant:a,navigationParent:", "variant:a,savednavigationParent:"),
    // The Working parent belongs to another condition.
    FIXTURE.replace("t===`working`||t===`snoozed`||t===`settled`?`shelf:${t}`", "t===`working`||t===`snoozed`?void 0:t===`settled`?`shelf:${t}`"),
    FIXTURE.replace("`shelf:${t}`:void 0)})", "`shelf:${t}`:void 0)?.replace(`shelf`,`section`)})"),
    // The row's icon, flag, and indent are not one component's.
    FIXTURE.replace("(d=a?null:", "(d=r?null:"),
    FIXTURE.replace('"data-sidebar-parent":e.navigationParent', '"data-sidebar-parent":q.navigationParent'),
    FIXTURE.replace("return{icon:d,row:{", "return{icon:d,row:function(){},x:{"),
  ];
  for (const variant of variants) {
    assert.notEqual(variant, FIXTURE);
    const result = patchSidebarChunk(variant, WORKING);
    assert.equal(result.applied, false, result.problem);
    assert.equal(result.source, variant);
  }
});

test("a site that cannot see the project folders gets T3 Code's layout, not an error", () => {
  // The headers are built by an arrow function outside the sidebar component,
  // where the folders' name is missing, not yet set, or another value.
  const headers = "[{marker:`working-header`,className:`mt-auto`},{marker:`snoozed-header`,className:Y(Dn.length===0&&`mt-auto`)},{marker:`settled-header`,className:Y(Dn.length+On.length===0&&`mt-auto`)}]";
  const bodies = {
    missing: `(Dn,On,Y)=>${headers}`,
    "not yet set": `(Dn,On,Y)=>{const h=${headers};let Un=[];return h}`,
    "another value": `(Dn,On,Y)=>{let Un=[1,{a:1}];return ${headers}}`,
    "another null": `(Dn,On,Y)=>{let Un=[];Un=null;return ${headers}}`,
    "another empty list": `(Dn,On,Y)=>{let Un=[];return ${headers}}`,
  };
  for (const [name, body] of Object.entries(bodies)) {
    const variant = FIXTURE.replace(`const headers=${headers};`, "const headers=mk(Dn,On,Y);") + `\nconst mk=${body};`;
    assert.notEqual(variant, FIXTURE);
    const result = patchSidebarChunk(variant, WORKING);
    assert.equal(result.applied, true, `${name}: ${result.problem}`);
    const original = load(variant);
    const patched = load(result.source);
    for (const folders of [[], null]) {
      for (const [working, snoozed] of [[[1], [1]], [[], [1]], [[], []], [[1], []]]) {
        let expected;
        try {
          expected = original.headers(folders, working, snoozed);
        } catch (error) {
          expected = error.constructor.name;
        }
        let actual;
        try {
          actual = patched.headers(folders, working, snoozed);
        } catch (error) {
          actual = error.constructor.name;
        }
        assert.deepEqual(actual, expected, `${name}: the headers are T3 Code's own`);
      }
    }
    assert.deepEqual(patched.render([], rows), ["w1", "w2", "p1"], name);
  }
});

test("patched code is not patched again, and other scripts are left alone", () => {
  const once = patchSidebarChunk(FIXTURE, WORKING);
  const twice = patchSidebarChunk(once.source, WORKING);
  assert.equal(twice.applied, false);
  assert.equal(twice.source, once.source);
  assert.equal(patchSidebarChunk("console.log(1)", WORKING).source, "console.log(1)");
  assert.equal(patchSidebarChunk(undefined, WORKING).applied, false);
});

// The same sidebar code with the places the Done section changes, and stand-ins
// for what it takes from T3 Code: the visit times, the status, the saved state
// of a shelf, and React's refs and effects, which run when a render commits.
// The component is far after the hook, as in T3 Code.
function replaced(text, pairs) {
  for (const [from, to] of pairs) {
    assert.equal(text.split(from).length, 2, `the fixture has ${from} once`);
    text = text.replace(from, () => to);
  }
  return text;
}

const DONE_FIXTURE = [
  replaced(FIXTURE, [
    ["f=dp(DK)&&u===null,p=1;", "f=dp(DK)&&u===null,p=(0,Q.useSyncExternalStore)(),[b,x]=Ar(lK,!1,zo);"],
    ["=e.lists,b=e.expanded,", "=e.lists,"],
    ["function hK(e,t){return t===null?[]:e.filter(n=>n===t)}", "function hK(e,t){return t===null?[]:e.filter(n=>fK(n)===t)}"],
    ["U=u===null?null:u.map(g=>(", "U=u===null?null:Wee(u,A,d).map(g=>("],
    ["W=[...k,...U===null?A:U.flatMap(wK),...H,...ee,...V],te=0;", "W=[...k,...U===null?A:U.flatMap(wK),...H,...ee,...V],te=new Map;for(let[e,t]of[[k,`pinned`],[A,`active`],[j,`working`],[M,`snoozed`],[N,`settled`]])for(let n of e)te.set(fK(n),t);"],
    ["orderedThreadKeys:W.map(x=>x)}", "orderedThreadKeys:W.map(fK),sectionByThreadKey:te}"],
    ["function GK(Un,r,Dn,On,Y){let t=[],", `/*${" ".repeat(8000)}*/`+"function GK(input,r,Dn,On,Y,Vn,Hn){let{workingShelfEnabled:Sn,projectFolders:Un,toggleProjectFolder:Wn,orderedThreadKeys:Jn,sectionByThreadKey:$n}=gK({projectScopeKey:0,...input});let t=[],"],
    ["const headers=[{marker:`working-header`,className:`mt-auto`},", "const translate=(e,c)=>e+`|`+c.$context,n=[],el={jsx:(c,p)=>c(p)};for(let i of qi)if(i.kind===`thread`)n.push(i.section+`:`+i.key);else bb2248:switch(i.marker){case`working-header`:n.push((0,el.jsx)(eK,{marker:`working-header`,className:`mt-auto`,label:translate(`Working`,{$context:`sidebar section`}),count:Dn.length,toggle:{expanded:Vn,onToggle:Hn}},`working-shelf-header`));break bb2248;default:n.push(i.marker)}const headers=["],
    ["return{Ji,rendered,headers,Gi,look}}", "return{Ji,rendered,headers,Gi,look,n,Jn,$n}}"],
  ]),
  "let STORED={working:true},VISITS={},REF,EFFECTS=[];const lK=`working`;",
  "function Q(){}Q.useSyncExternalStore=()=>1;Q.useRef=v=>REF??={current:v};Q.useLayoutEffect=run=>{EFFECTS.push(run)};",
  "function zo(){}function Ar(key,fallback,schema){if(schema!==zo)throw Error(`schema`);return[STORED[key]??fallback,next=>{STORED[key]=next(STORED[key]??fallback)}]}",
  "function wv(select){return select({threadLastVisitedAtById:VISITS})}",
  "function zv(server,local){return local??server}",
  "function fK(e){return e.id??e}",
  "function Wee(groups,threads){return groups.map(g=>({...g,threads:threads.filter(e=>g.ids.includes(fK(e)))})).filter(g=>g.threads.length>0)}",
  "function Pee(e){return!!e.latestRun?.completedAt&&Date.parse(e.latestRun.completedAt)>Date.parse(e.lastVisitedAt)}",
  "function Kee(e){return e.status}",
  "function rowLabel(S,n,I){let L=wv(I),R=zv(S.lastVisitedAt,L),z;let _e=0,ve=Pee({...S,lastVisitedAt:R}),ye=Kee({...S,lastVisitedAt:R}),be=0,Te=ye===`preparing`||ye===`working`?{label:n(`Working`,{$context:`thread status`})}:ve?{label:n(`Done`,{$context:`thread status`})}:null;return Te}",
  "function eK(e){let t=(0,$.c)(17),n=e.marker===`working-header`?`working`:e.marker===`snoozed-header`?`snoozed`:`settled`;return{...e,shelf:n}}const $={c:()=>[]};",
].join("\n");
const DONE = { working: false, done: true };
const BOTH = { working: true, done: true };

// Renders the sidebar of threads in one project folder, as T3 Code does.
function doneSidebar(sections, source = DONE_FIXTURE) {
  const result = patchSidebarChunk(source, sections);
  assert.equal(result.applied, true, result.problem);
  const sidebar = new Function(
    `${result.source}\nreturn {GK,rowLook,visit(k,v){VISITS[k]=v},commit(){for(const run of EFFECTS.splice(0))run()},abandon(){EFFECTS=[]}};`,
  )();
  return {
    ...sidebar,
    draw(threads, { open = null, working = [], folders = true } = {}) {
      const ids = threads.map((item) => item.id);
      const lists = { pinnedThreads: ["p1"], activeThreads: threads, workingThreads: working, snoozedThreads: [], settledThreads: [] };
      const input = { threads: [], routeRowThreadKey: open, folderGroups: folders ? [{ ids }] : null, lists };
      const rowsOf = (list, section) => list.map((item) => ({ kind: "thread", key: item.id ?? item, section }));
      const list = [
        { kind: "marker", marker: "pinned-header" },
        ...rowsOf(["p1"], "pinned"),
        { kind: "marker", marker: "active-placeholder" },
        ...rowsOf(threads, "active"),
        ...(working.length ? [{ kind: "marker", marker: "working-header" }, ...rowsOf(working, "working")] : []),
      ];
      const drawn = sidebar.GK(input, list, working, [], (value) => value || undefined, true, () => {});
      return {
        keys: drawn.Jn,
        sections: Object.fromEntries(drawn.$n),
        rows: drawn.n.map((item) => (typeof item === "string" ? item : item.marker)),
        header: drawn.n.find((item) => item.marker === "done-header"),
        look: drawn.look,
      };
    },
    show(threads, options) {
      const drawn = this.draw(threads, options);
      sidebar.commit();
      return drawn;
    },
  };
}
const ended = (id, minute, more = {}) => ({
  id,
  status: "ready",
  latestRun: { status: "completed", completedAt: `2026-01-01T10:${minute}:00Z` },
  lastVisitedAt: "2026-01-01T09:00:00Z",
  ...more,
});
const READ = "2026-01-01T11:00:00Z";

test("Done threads leave their folder for the section, latest first, below Working and above Pinned", () => {
  const threads = [ended("a", "01"), ended("b", "05"), ended("c", "03", { lastVisitedAt: READ })];
  const done = doneSidebar(DONE).show(threads);
  assert.deepEqual(done.rows, ["done-header", "done:b", "done:a", "pinned-header", "pinned:p1", "active-placeholder", "active:c", "settled-placeholder"]);
  assert.deepEqual(done.keys, ["b", "a", "p1", "c"]);
  assert.deepEqual(done.sections, { p1: "pinned", a: "done", b: "done", c: "active" });
  assert.deepEqual([done.header.label, done.header.count, done.header.shelf], ["Done|thread status", 2, "done"]);

  const both = doneSidebar(BOTH).show(threads, { working: ["w"] });
  assert.deepEqual(both.rows.slice(0, 5), ["working-header", "working:w", "done-header", "done:b", "done:a"]);
  assert.deepEqual(both.keys, ["w", "b", "a", "p1", "c"]);
});

test("only a thread that T3 Code labels Done is in the section", () => {
  const sidebar = doneSidebar(BOTH);
  for (const status of ["working", "preparing", "waiting", "approval", "input", "request", "failed", "limited"]) {
    assert.equal(sidebar.show([ended("a", "01", { status })]).header, undefined, status);
  }
  const failed = ended("a", "01");
  failed.latestRun.status = "failed";
  assert.equal(sidebar.show([failed]).header, undefined, "a failed run that T3 Code reports as ready");
  assert.equal(sidebar.show([ended("a", "01", { lastVisitedAt: READ })]).header, undefined, "already read");
  assert.equal(sidebar.show([ended("a", "01", { latestRun: null })]).header, undefined, "never ran");
  sidebar.visit("a", READ);
  assert.equal(sidebar.show([ended("a", "01")]).header, undefined, "read in this window");
});

test("a thread opened from Done stays until it is left, and one that finishes while open does not enter", () => {
  const sidebar = doneSidebar(BOTH);
  const unread = [ended("a", "01"), ended("b", "02")];
  const aRead = [ended("a", "01", { lastVisitedAt: READ }), ended("b", "02")];
  assert.deepEqual(sidebar.show(unread).keys, ["b", "a", "p1"]);
  assert.deepEqual(sidebar.show(unread, { open: "a" }).keys, ["b", "a", "p1"], "opened");
  assert.deepEqual(sidebar.show(aRead, { open: "a" }).keys, ["b", "a", "p1"], "read");
  sidebar.draw(aRead, { open: "b" });
  sidebar.abandon();
  assert.deepEqual(sidebar.show(aRead, { open: "a" }).keys, ["b", "a", "p1"], "a render that did not commit changes nothing");
  const aReverted = [ended("a", "01", { latestRun: null }), ended("b", "02")];
  assert.equal(sidebar.show(aReverted, { open: "a" }).keys.length, 3, "its run was reverted");
  assert.deepEqual(sidebar.show(aRead, { open: "b" }).keys, ["b", "p1", "a"], "left");
  assert.deepEqual(sidebar.show(aRead, { open: "a" }).keys, ["b", "p1", "a"], "opened again from its folder");
  const aWorks = [ended("a", "01", { status: "working" })];
  assert.equal(sidebar.show(aWorks, { open: "a" }).header, undefined);
  assert.equal(sidebar.show([ended("a", "09")], { open: "a" }).header, undefined, "finished while open");
  assert.notEqual(sidebar.show([ended("a", "09")], { open: null }).header, undefined, "left unread");
});

test("a collapsed Done section keeps its count and the open thread's row, and is remembered", () => {
  const sidebar = doneSidebar(DONE);
  const threads = [ended("a", "01"), ended("b", "02")];
  const open = sidebar.show(threads);
  assert.equal(open.header.toggle.expanded, true);
  open.header.toggle.onToggle();
  const collapsed = sidebar.show(threads);
  assert.equal(collapsed.header.toggle.expanded, false);
  assert.equal(collapsed.header.count, 2);
  assert.deepEqual(collapsed.keys, ["p1"]);
  assert.deepEqual(sidebar.show(threads, { open: "a" }).keys, ["a", "p1"]);
});

test("Done rows look like folder rows, with their project's icon and the Done header as parent", () => {
  for (const sections of [DONE, BOTH]) {
    const sidebar = doneSidebar(sections);
    assert.equal(sidebar.show([ended("a", "01")]).look({}, "done"), "folder");
    const { icon, row } = sidebar.rowLook([], "folder", { navigationParent: "shelf:done", isActive: false, project: "P" }, "settle");
    assert.deepEqual(icon.children, { project: "P", className: "size-4" });
    assert.doesNotMatch(row.className, /ps-9/);
  }
  assert.match(patchSidebarChunk(DONE_FIXTURE, DONE).source, /navigationParent:n\?\?\(t===`done`\|\|t===`working`/);
});

test("without project folders there is no Done section, and a section that is off changes nothing of its own", () => {
  const threads = [ended("a", "01"), ended("b", "02")];
  assert.deepEqual(doneSidebar(DONE).show(threads, { folders: false }).keys, ["p1", "a", "b"]);
  assert.deepEqual(doneSidebar({ working: true, done: false }).show(threads).rows, ["pinned-header", "pinned:p1", "active-placeholder", "active:a", "active:b", "settled-placeholder"]);
  assert.doesNotMatch(patchSidebarChunk(DONE_FIXTURE, { working: true, done: false }).source, /t3RtlFix\w*Done/);
  const gate = "f=dp(DK)&&u===null,";
  assert.ok(patchSidebarChunk(DONE_FIXTURE, DONE).source.includes(gate), "Done alone leaves Working as T3 Code has it");
  assert.ok(!patchSidebarChunk(DONE_FIXTURE, BOTH).source.includes(gate));
});

test("Done is refused unless each of its places is recognized, and Working is not", () => {
  const broken = [
    ["[b,x]=Ar(lK,!1,zo)", "[b,x]=Ar(lK,!0,zo)"],
    ["(0,Q.useSyncExternalStore)()", "Q.useSyncExternalStore()"],
    ["Wee(u,A,d).map(", "Wee(u,j,d).map("],
    ["Wee(u,A,d).map(", "memo(u,A,d,"],
    ["[N,`settled`]])for(", "[N,`settled`],[0,0]])for("],
    ["ye=Kee({...S,lastVisitedAt:R})", "ye=Kee(S)"],
    [":ve?{label:n(`Done`", ":be?{label:n(`Done`"],
    ["let L=wv(I),R=zv(S.lastVisitedAt,L)", "let L=wv(I),R=zv(S.visitedAt,L)"],
    ["L),z;let _e=0", "L),z;function inner(){}let _e=0"],
    ["function Pee(e)", "const Pee=e=>0;function unrelated(e)"],
    ["function Pee(e)", "const Pee=e=>0;// export{unrelated as Pee};\nfunction unrelated(e)"],
    ["projectFolders:Un,", "projectFolderz:Un,"],
    ["toggle:{expanded:Vn,onToggle:Hn}},`working-shelf-header`", "toggle:{expanded:Vn,onToggle:Hn}},`working-shelf`"],
    ["n=e.marker===`working-header`?`working`", "n=e.kind===`working-header`?`working`"],
  ];
  for (const [site, change] of broken) {
    const variant = replaced(DONE_FIXTURE, [[site, change]]);
    const result = patchSidebarChunk(variant, BOTH);
    assert.equal(result.applied, false, site);
    assert.equal(result.source, variant, `${site}: the code is left byte for byte`);
    const working = patchSidebarChunk(variant, { working: true, done: false });
    assert.equal(working.applied, true, `${site}: ${working.problem}`);
  }
});

// The real code of the T3 Code installed on this machine, when there is one.
function installedServerAsar() {
  const candidates = process.platform === "win32"
    ? [path.join(process.env.LOCALAPPDATA || "", "Programs", "t3code", "resources", "server.asar")]
    : process.platform === "darwin"
      ? ["/Applications/T3 Code (Beta).app/Contents/Resources/server.asar", "/Applications/T3 Code.app/Contents/Resources/server.asar"]
      : [];
  return candidates.find((candidate) => {
    try {
      return fs.statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
}

function readInstalledMainChunks(asarPath) {
  const fd = fs.openSync(asarPath, "r");
  try {
    const sizes = Buffer.alloc(16);
    fs.readSync(fd, sizes, 0, 16, 0);
    const headerSize = sizes.readUInt32LE(12);
    const header = Buffer.alloc(headerSize);
    fs.readSync(fd, header, 0, headerSize, 16);
    const base = 8 + sizes.readUInt32LE(4);
    let node = JSON.parse(header.toString("utf8"));
    for (const part of ["apps", "server", "dist", "client", "assets"]) node = node?.files?.[part];
    const chunks = [];
    for (const [name, entry] of Object.entries(node?.files || {})) {
      if (!/^main-.*\.js$/.test(name) || entry.unpacked || entry.files) continue;
      const buffer = Buffer.alloc(entry.size);
      fs.readSync(fd, buffer, 0, entry.size, base + Number(entry.offset));
      chunks.push({ name, source: buffer.toString("utf8") });
    }
    return chunks;
  } finally {
    fs.closeSync(fd);
  }
}

// Run on request only, with T3_CHECK_INSTALLED=1, because the result depends
// on the T3 Code version installed here, not on this repository.
test("the installed T3 Code's sidebar code is recognized and stays valid", (t) => {
  if (process.env.T3_CHECK_INSTALLED !== "1") return t.skip("set T3_CHECK_INSTALLED=1 to check the installed T3 Code");
  const asarPath = installedServerAsar();
  if (!asarPath) return t.skip("T3 Code is not installed here");
  const chunk = readInstalledMainChunks(asarPath).find((item) => item.source.includes("sidebarWorkingShelfEnabled}"));
  assert.ok(chunk, "the installed T3 Code has a main script with the sidebar");
  for (const sections of [WORKING, DONE]) {
    const alone = patchSidebarChunk(chunk.source, sections);
    assert.equal(alone.applied, true, `${chunk.name}: ${alone.problem}`);
  }
  const result = patchSidebarChunk(chunk.source, BOTH);
  assert.equal(result.applied, true, `${chunk.name}: ${result.problem}`);
  // The gate is the setting alone now, and nothing else of it is left.
  const setting = /function ([\w$]+)\(e\)\{return e\.sidebarWorkingShelfEnabled\}/.exec(result.source)[1].replace(/\$/g, "\\$");
  assert.match(result.source, new RegExp(`folderGroups:[\\w$]+(?:,[\\w$]+:[\\w$]+)*\\}=e,[\\w$]+=[\\w$]+\\(${setting}\\),`));
  assert.equal((result.source.match(/t3RtlFixHasFolders\$/g) || []).length, 6, "the flag is set once and read at the five added places");
  assert.equal(
    (result.source.match(/[\w$]+\.navigationParent===`shelf:working`/g) || []).length,
    4,
    "the row component reads the Working parent in the icon's cache key, the icon, its cache, and the indent",
  );
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "t3-working-shelf-"));
  try {
    const file = path.join(directory, "main.mjs");
    fs.writeFileSync(file, result.source);
    execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// A stand-in for the browser's DevTools connection.
function fakeConnection({ body = FIXTURE, failBody = false, failEnable = false } = {}) {
  const calls = [];
  let release = null;
  const gate = { hold: false };
  const send = async (method, params) => {
    calls.push({ method, params });
    if (method === "Fetch.enable" && failEnable) throw new Error("Fetch.enable: not allowed");
    if (method === "Fetch.getResponseBody") {
      if (gate.hold) await new Promise((resolve) => (release = resolve));
      if (failBody) throw new Error("Fetch.getResponseBody: gone");
      return { body: Buffer.from(body, "utf8").toString("base64"), base64Encoded: true };
    }
    return {};
  };
  return { send, calls, gate, release: () => release?.() };
}

const paused = (overrides = {}) => ({
  requestId: "r1",
  responseStatusCode: 200,
  responseHeaders: [
    { name: "content-type", value: "text/javascript" },
    { name: "Content-Length", value: "10" },
    { name: "content-encoding", value: "gzip" },
  ],
  ...overrides,
});

test("the browser watches only T3 Code's main script, and a refusal is only logged", async () => {
  const ok = fakeConnection();
  assert.equal(await createWorkingShelfService({ send: ok.send, sections: () => WORKING }).enable(), true);
  assert.deepEqual(ok.calls[0], {
    method: "Fetch.enable",
    params: { patterns: [{ urlPattern: URL_PATTERN, resourceType: "Script", requestStage: "Response" }] },
  });
  const refused = fakeConnection({ failEnable: true });
  const logs = [];
  const service = createWorkingShelfService({ send: refused.send, sections: () => WORKING, log: (m) => logs.push(m) });
  assert.equal(await service.enable(), false);
  assert.match(logs.join("\n"), /could not watch/);
});

test("a recognized script is answered with the patched code and without its length", async () => {
  const connection = fakeConnection();
  await createWorkingShelfService({ send: connection.send, sections: () => WORKING }).handlePaused(paused());
  const methods = connection.calls.map((call) => call.method);
  assert.deepEqual(methods, ["Fetch.getResponseBody", "Fetch.fulfillRequest"]);
  const fulfill = connection.calls[1].params;
  assert.equal(fulfill.requestId, "r1");
  assert.equal(fulfill.responseCode, 200);
  assert.deepEqual(fulfill.responseHeaders, [{ name: "content-type", value: "text/javascript" }]);
  assert.equal(Buffer.from(fulfill.body, "base64").toString("utf8"), patchSidebarChunk(FIXTURE, WORKING).source);
});

test("the script passes unchanged when the switch is off, the answer is not 200, or the code is unknown", async () => {
  const cases = [
    { name: "off", enabled: false, params: paused(), reads: false },
    { name: "304", enabled: true, params: paused({ responseStatusCode: 304 }), reads: false },
    { name: "error", enabled: true, params: paused({ responseStatusCode: undefined, responseErrorReason: "Failed" }), reads: false },
    { name: "unknown", enabled: true, params: paused(), reads: true, body: "export const sidebarWorkingShelfEnabled = 1;" },
    { name: "unreadable", enabled: true, params: paused(), reads: true, failBody: true },
  ];
  for (const item of cases) {
    const connection = fakeConnection({ body: item.body, failBody: item.failBody });
    const logs = [];
    await createWorkingShelfService({ send: connection.send, sections: () => ({ working: item.enabled, done: false }), log: (m) => logs.push(m) }).handlePaused(item.params);
    const methods = connection.calls.map((call) => call.method);
    assert.deepEqual(methods, item.reads ? ["Fetch.getResponseBody", "Fetch.continueRequest"] : ["Fetch.continueRequest"], item.name);
    assert.deepEqual(connection.calls.at(-1).params, { requestId: "r1" }, item.name);
    if (item.name === "unknown") assert.match(logs.join("\n"), /not recognized/);
  }
});

test("turning the switch off while the script is read passes it unchanged", async () => {
  const connection = fakeConnection();
  connection.gate.hold = true;
  let enabled = true;
  const handled = createWorkingShelfService({ send: connection.send, sections: () => ({ working: enabled, done: false }) }).handlePaused(paused());
  await new Promise((resolve) => setImmediate(resolve));
  enabled = false;
  connection.release();
  await handled;
  assert.deepEqual(connection.calls.map((call) => call.method), ["Fetch.getResponseBody", "Fetch.continueRequest"]);
});

test("when only Done is not recognized, Working is still shown, and the log says which", async () => {
  const connection = fakeConnection();
  const logs = [];
  await createWorkingShelfService({ send: connection.send, sections: () => BOTH, log: (m) => logs.push(m) }).handlePaused(paused());
  const answer = connection.calls.at(-1);
  assert.equal(answer.method, "Fetch.fulfillRequest");
  assert.equal(Buffer.from(answer.params.body, "base64").toString("utf8"), patchSidebarChunk(FIXTURE, WORKING).source);
  assert.match(logs.join("\n"), /not recognized for Done/);
});

test("a switch changed while the script is read decides what it gets", async () => {
  const connection = fakeConnection({ body: DONE_FIXTURE });
  connection.gate.hold = true;
  let sections = WORKING;
  const handled = createWorkingShelfService({ send: connection.send, sections: () => sections }).handlePaused(paused());
  await new Promise((resolve) => setImmediate(resolve));
  sections = DONE;
  connection.release();
  await handled;
  assert.equal(Buffer.from(connection.calls.at(-1).params.body, "base64").toString("utf8"), patchSidebarChunk(DONE_FIXTURE, DONE).source);
});

test("two windows loading at once each get one answer", async () => {
  const connection = fakeConnection();
  const service = createWorkingShelfService({ send: connection.send, sections: () => WORKING });
  await Promise.all([service.handlePaused(paused({ requestId: "a" })), service.handlePaused(paused({ requestId: "b" }))]);
  const answers = connection.calls.filter((call) => call.method !== "Fetch.getResponseBody").map((call) => call.params.requestId).sort();
  assert.deepEqual(answers, ["a", "b"]);
});

test("windows reload without the cache, and one that cannot reload is only logged", async () => {
  const calls = [];
  const logs = [];
  const send = async (method, params, sessionId) => {
    calls.push({ method, params, sessionId });
    if (sessionId === "gone") throw new Error("Page.reload: no session");
    return {};
  };
  const service = createWorkingShelfService({ send, sections: () => WORKING, log: (m) => logs.push(m) });
  assert.equal(await service.reloadWindows(["a", "gone", "b"]), 2);
  assert.deepEqual(calls, ["a", "gone", "b"].map((sessionId) => ({ method: "Page.reload", params: { ignoreCache: true }, sessionId })));
  assert.match(logs.join("\n"), /could not be reloaded/);
  assert.equal(await service.reloadWindows([]), 0);
});

test("a change of a switch reloads only after the browser watches the script", () => {
  const core = fs.readFileSync(path.join(__dirname, "..", "src", "launcher-core.js"), "utf8");
  const start = core.indexOf("async function switchSidebarSections(");
  assert.ok(start > 0);
  const body = core.slice(start, core.indexOf("\n  }\n", start));
  assert.match(body, /if \(next\.working === sidebarSections\.working && next\.done === sidebarSections\.done\) return;/);
  const watched = body.indexOf("await watchWorkingShelf()");
  assert.ok(watched > 0 && watched < body.indexOf("reloadWindows"), "watching starts before the reload");
  assert.match(body, /if \(!watching\) return;/);
  assert.match(core, /void switchSidebarSections\(sectionsOf\(settings\)\)/);
  assert.match(body, /reloadWindows\(\[\.\.\.appPages\.values\(\)\]\)/);
});

test("the fix watches before the first window and keeps the RTL fix when watching fails", () => {
  const core = fs.readFileSync(path.join(__dirname, "..", "src", "launcher-core.js"), "utf8");
  const launcher = fs.readFileSync(path.join(__dirname, "..", "src", "t3-rtl-launcher.js"), "utf8");
  const start = core.indexOf("async function start()");
  assert.ok(start > 0);
  const body = core.slice(start, core.indexOf("\n  }\n", start));
  assert.ok(body.indexOf("await watchWorkingShelf()") < body.indexOf("Target.setDiscoverTargets"), "watching starts before targets are found");
  assert.match(core, /message\.method === "Fetch\.requestPaused" && !message\.sessionId/);
  assert.match(launcher, /message\.method === "Fetch\.requestPaused" && !message\.sessionId/);
  assert.doesNotMatch(core + launcher, /Fetch\.disable/);
  assert.match(launcher, /if \(cdpClosed\) return Promise\.reject/);
});
